use std::sync::{Arc, Mutex, Weak};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use async_trait::async_trait;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::interceptor::{self, *};
use webrtc::interceptor::stream_info::StreamInfo;

pub const ERROR: &str = "Compartilhamento P2P direto indisponível. Relay/TURN está bloqueado para proteger o consumo de tráfego.";
pub fn direct(kind: &str) -> bool { matches!(kind, "host" | "srflx" | "prflx") }
pub fn candidate(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() { return Ok(()); }
    if value.contains(['\r', '\n']) { return Err(ERROR.into()); }
    let v = value.strip_prefix("a=").unwrap_or(value).to_ascii_lowercase();
    let t: Vec<_> = v.split_whitespace().collect();
    if !t.first().is_some_and(|s| s.starts_with("candidate:")) || t.get(6) != Some(&"typ") || !t.get(7).is_some_and(|s| direct(s)) { return Err(ERROR.into()); }
    Ok(())
}
pub fn sdp(value: &str) -> Result<(), String> {
    for line in value.lines().map(str::trim) {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("a=candidate:") { candidate(&line[2..])?; }
        if lower.starts_with("a=remote-candidates:") { return Err(ERROR.into()); }
    }
    Ok(())
}
pub fn servers(input: Vec<RTCIceServer>) -> Vec<RTCIceServer> {
    input.into_iter().filter_map(|mut s| {
        s.urls.retain(|u| { let u = u.trim().to_ascii_lowercase(); u.starts_with("stun:") || u.starts_with("stuns:") });
        s.urls = s.urls.into_iter().map(|u| u.trim().to_string()).collect();
        if s.urls.is_empty() { None } else { s.username.clear(); s.credential.clear(); Some(s) }
    }).collect()
}

#[async_trait]
trait PairSource: Send + Sync {
    async fn selected(&self) -> Option<(String, String)>;
}
struct PeerSource(Mutex<Weak<RTCPeerConnection>>);
#[async_trait]
impl PairSource for PeerSource {
    async fn selected(&self) -> Option<(String, String)> {
        let pc = self.0.lock().unwrap().upgrade()?;
        if pc.connection_state() != webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Connected { return None; }
        let pair = pc.dtls_transport().ice_transport().get_selected_candidate_pair().await?;
        Some((pair.local.typ.to_string(), pair.remote.typ.to_string()))
    }
}

// This gate belongs to ONE dedicated screen PC and covers both audio and video.
// Check the actual pair on every outbound RTP/RTCP write, not a polling snapshot.
#[derive(Default)]
struct TrafficCounters {
    rtp_blocked: AtomicU64, rtp_forwarded: AtomicU64, rtp_bytes: AtomicU64, rtp_errors: AtomicU64,
    rtcp_blocked: AtomicU64, rtcp_forwarded: AtomicU64, rtcp_bytes: AtomicU64, rtcp_errors: AtomicU64,
}
pub struct Gate {
    traffic: TrafficCounters,
    peer: Arc<PeerSource>,
    source: Arc<dyn PairSource>,
    rejected: AtomicBool,
    on_reject: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
impl Gate {
    pub fn new() -> Arc<Self> {
        let peer = Arc::new(PeerSource(Mutex::new(Weak::new())));
        Arc::new(Self { source: peer.clone(), peer, rejected: AtomicBool::new(false), on_reject: Mutex::new(None), traffic: TrafficCounters::default() })
    }
    pub fn traffic_snapshot(&self) -> serde_json::Value {
        let t = &self.traffic;
        serde_json::json!({
            "rtp_blocked": t.rtp_blocked.load(Ordering::Relaxed),
            "rtp_forwarded_writes": t.rtp_forwarded.load(Ordering::Relaxed),
            "rtp_forwarded_bytes": t.rtp_bytes.load(Ordering::Relaxed),
            "rtp_write_errors": t.rtp_errors.load(Ordering::Relaxed),
            "rtcp_blocked": t.rtcp_blocked.load(Ordering::Relaxed),
            "rtcp_forwarded_writes": t.rtcp_forwarded.load(Ordering::Relaxed),
            "rtcp_forwarded_bytes": t.rtcp_bytes.load(Ordering::Relaxed),
            "rtcp_write_errors": t.rtcp_errors.load(Ordering::Relaxed)
        })
    }
    pub fn on_reject(&self, handler: Arc<dyn Fn() + Send + Sync>) { *self.on_reject.lock().unwrap() = Some(handler); }
    pub fn close(&self) { self.rejected.store(true, Ordering::SeqCst); }
    pub fn attach(&self, pc: &Arc<RTCPeerConnection>) { *self.peer.0.lock().unwrap() = Arc::downgrade(pc); }
    pub fn reject(&self) {
        if !self.rejected.swap(true, Ordering::SeqCst) {
            let notify = self.on_reject.lock().unwrap().clone();
            if let Some(notify) = notify { notify(); }
            let peer = self.peer.0.lock().unwrap().upgrade();
            if let Some(pc) = peer { tokio::spawn(async move { let _ = pc.close().await; }); }
        }
    }
    pub async fn allowed(&self) -> bool {
        if self.rejected.load(Ordering::SeqCst) { return false; }
        let Some((local, remote)) = self.source.selected().await else { return false };
        if local == "relay" || remote == "relay" { self.reject(); return false; }
        direct(&local) && direct(&remote) && !self.rejected.load(Ordering::SeqCst)
    }
}

pub struct Builder(pub Arc<Gate>);
impl InterceptorBuilder for Builder {
    fn build(&self, _: &str) -> std::result::Result<Arc<dyn Interceptor + Send + Sync>, interceptor::Error> { Ok(Arc::new(Guard(self.0.clone()))) }
}
struct Guard(Arc<Gate>);
struct Writer(Arc<Gate>, Arc<dyn RTPWriter + Send + Sync>);
struct ControlWriter(Arc<Gate>, Arc<dyn RTCPWriter + Send + Sync>);
#[async_trait]
impl RTPWriter for Writer {
    async fn write(&self, pkt: &webrtc::rtp::packet::Packet, a: &Attributes) -> std::result::Result<usize, interceptor::Error> {
        if !self.0.allowed().await { self.0.traffic.rtp_blocked.fetch_add(1, Ordering::Relaxed); return Ok(0); }
        let result = self.1.write(pkt, a).await;
        match &result {
            Ok(n) if *n > 0 => { self.0.traffic.rtp_forwarded.fetch_add(1, Ordering::Relaxed); self.0.traffic.rtp_bytes.fetch_add(*n as u64, Ordering::Relaxed); }
            Err(_) => { self.0.traffic.rtp_errors.fetch_add(1, Ordering::Relaxed); }
            _ => {}
        }
        result
    }
}
#[async_trait]
impl RTCPWriter for ControlWriter {
    async fn write(&self, packets: &[Box<dyn webrtc::rtcp::packet::Packet + Send + Sync>], a: &Attributes) -> std::result::Result<usize, interceptor::Error> {
        if !self.0.allowed().await { self.0.traffic.rtcp_blocked.fetch_add(1, Ordering::Relaxed); return Ok(0); }
        let result = self.1.write(packets, a).await;
        match &result {
            Ok(n) if *n > 0 => { self.0.traffic.rtcp_forwarded.fetch_add(1, Ordering::Relaxed); self.0.traffic.rtcp_bytes.fetch_add(*n as u64, Ordering::Relaxed); }
            Err(_) => { self.0.traffic.rtcp_errors.fetch_add(1, Ordering::Relaxed); }
            _ => {}
        }
        result
    }
}
#[async_trait]
impl Interceptor for Guard {
    async fn bind_rtcp_reader(&self, r: Arc<dyn RTCPReader + Send + Sync>) -> Arc<dyn RTCPReader + Send + Sync> { r }
    async fn bind_rtcp_writer(&self, w: Arc<dyn RTCPWriter + Send + Sync>) -> Arc<dyn RTCPWriter + Send + Sync> { Arc::new(ControlWriter(self.0.clone(), w)) }
    async fn bind_local_stream(&self, _: &StreamInfo, w: Arc<dyn RTPWriter + Send + Sync>) -> Arc<dyn RTPWriter + Send + Sync> { Arc::new(Writer(self.0.clone(), w)) }
    async fn unbind_local_stream(&self, _: &StreamInfo) {}
    async fn bind_remote_stream(&self, _: &StreamInfo, r: Arc<dyn RTPReader + Send + Sync>) -> Arc<dyn RTPReader + Send + Sync> { r }
    async fn unbind_remote_stream(&self, _: &StreamInfo) {}
    async fn close(&self) -> std::result::Result<(), interceptor::Error> { self.0.rejected.store(true, Ordering::SeqCst); Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_turn_in_mixed_backend_servers() {
        let input = vec![RTCIceServer { urls: vec!["TURN:invalid.example".into(), "stun:invalid.example".into(), "turns:invalid.example".into()], username:"private".into(), credential:"private".into(), ..Default::default() }];
        let filtered = servers(input);
        assert_eq!(filtered.len(), 1); assert_eq!(filtered[0].urls, ["stun:invalid.example"]);
        assert!(filtered[0].username.is_empty()); assert!(filtered[0].credential.is_empty());
    }
    #[test]
    fn rejects_remote_relay_sdp_trickle_and_unknown_but_keeps_direct() {
        for typ in ["host", "srflx", "prflx"] { assert!(candidate(&format!("candidate:1 1 udp 1 192.0.2.1 9 typ {typ}")).is_ok()); }
        for typ in ["relay", "RELAY", "unknown"] {
            let c = format!("candidate:1 1 udp 1 192.0.2.1 9 typ {typ}");
            assert!(candidate(&c).is_err()); assert!(sdp(&format!("v=0\r\na={c}\r\n")).is_err());
        }
        assert!(candidate("").is_ok()); assert!(candidate("malformed").is_err());
    }
    #[tokio::test]
    async fn rtp_is_dropped_without_validated_peer_and_rejection_is_permanent() {
        struct Sink(AtomicBool);
        #[async_trait] impl RTPWriter for Sink {
            async fn write(&self, _: &webrtc::rtp::packet::Packet, _: &Attributes) -> std::result::Result<usize, interceptor::Error> { self.0.store(true, Ordering::SeqCst); Ok(1) }
        }
        let gate = Gate::new(); let sink = Arc::new(Sink(AtomicBool::new(false)));
        let writer = Writer(gate.clone(), sink.clone());
        assert_eq!(writer.write(&Default::default(), &Attributes::new()).await.unwrap(), 0);
        assert!(!sink.0.load(Ordering::SeqCst));
        assert_eq!(gate.traffic_snapshot()["rtp_blocked"], 1);
        assert_eq!(gate.traffic_snapshot()["rtp_forwarded_bytes"], 0); gate.reject(); assert!(!gate.allowed().await);
    }
    struct SyntheticPair(Mutex<Option<(String, String)>>);
    #[async_trait] impl PairSource for SyntheticPair {
        async fn selected(&self) -> Option<(String, String)> { self.0.lock().unwrap().clone() }
    }
    #[tokio::test]
    async fn rtp_audio_video_and_rtcp_require_direct_pair_and_never_resume_after_relay() {
        struct Sink(std::sync::atomic::AtomicUsize);
        #[async_trait] impl RTPWriter for Sink {
            async fn write(&self, _: &webrtc::rtp::packet::Packet, _: &Attributes) -> std::result::Result<usize, interceptor::Error> { self.0.fetch_add(1, Ordering::SeqCst); Ok(1) }
        }
        #[async_trait] impl RTCPWriter for Sink {
            async fn write(&self, _: &[Box<dyn webrtc::rtcp::packet::Packet + Send + Sync>], _: &Attributes) -> std::result::Result<usize, interceptor::Error> { self.0.fetch_add(1, Ordering::SeqCst); Ok(1) }
        }
        for side in ["local", "remote"] {
            let source = Arc::new(SyntheticPair(Mutex::new(None)));
            let gate = Arc::new(Gate { peer: Arc::new(PeerSource(Mutex::new(Weak::new()))), source: source.clone(), rejected: AtomicBool::new(false), on_reject: Mutex::new(None), traffic: TrafficCounters::default() });
            let sink = Arc::new(Sink(std::sync::atomic::AtomicUsize::new(0)));
            let rtp = Writer(gate.clone(), sink.clone()); let rtcp = ControlWriter(gate.clone(), sink.clone());
            let packet = webrtc::rtp::packet::Packet::default(); let attr = Attributes::new();
            assert_eq!(rtp.write(&packet, &attr).await.unwrap(), 0);
            *source.0.lock().unwrap() = Some(("host".into(), "srflx".into()));
            // Audio and video bindings share the protected transport writer.
            assert_eq!(rtp.write(&packet, &attr).await.unwrap(), 1);
            assert!(gate.traffic_snapshot()["rtp_forwarded_bytes"].as_u64().unwrap() >= 1);
            assert_eq!(rtp.write(&packet, &attr).await.unwrap(), 1);
            assert!(gate.traffic_snapshot()["rtp_forwarded_bytes"].as_u64().unwrap() >= 1);
            assert_eq!(rtcp.write(&[], &attr).await.unwrap(), 1);
            *source.0.lock().unwrap() = None; // ICE restart has not selected a pair.
            assert_eq!(rtp.write(&packet, &attr).await.unwrap(), 0);
            *source.0.lock().unwrap() = Some(if side == "local" { ("relay".into(), "host".into()) } else { ("host".into(), "relay".into()) });
            assert_eq!(rtp.write(&packet, &attr).await.unwrap(), 0);
            assert_eq!(rtcp.write(&[], &attr).await.unwrap(), 0);
            *source.0.lock().unwrap() = Some(("prflx".into(), "host".into()));
            assert_eq!(rtp.write(&packet, &attr).await.unwrap(), 0);
            assert_eq!(sink.0.load(Ordering::SeqCst), 3);
        }
    }

}
