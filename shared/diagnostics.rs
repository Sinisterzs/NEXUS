//! Wire contract shared by desktop and server. No raw log or arbitrary strings.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Consent {
    pub p2p: bool,
    pub color: bool,
    pub synthetic: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub consent_revision: Uuid,
    pub events: Vec<Event>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub id: Uuid,
    pub session_id: Uuid,
    pub participant: Uuid,
    pub source: Uuid,
    pub destination: Uuid,
    pub attempt: String,
    pub generation: u32,
    pub kind: Kind,
    pub role: Role,
    pub version: String,
    pub elapsed_ms: u32,
    pub metrics: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub patches: Vec<Patch>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    P2p,
    Color,
    Synthetic,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Sender,
    Receiver,
    Local,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    pub index: u8,
    pub expected: [u8; 3],
    pub measured: [f64; 3],
    pub mae: f64,
    pub maximum: f64,
}

pub const NUMBERS: &[&str] = &[
    "packetsReceived",
    "bytesReceived",
    "framesCaptured",
    "framesEncoded",
    "framesSubmitted",
    "framesReceived",
    "framesDecoded",
    "keyFramesDecoded",
    "framesDropped",
    "offersApplied",
    "answersSent",
    "iceQueued",
    "iceApplied",
    "iceRejected",
    "iceStale",
    "iceDuplicate",
    "iceRestartCount",
    "negotiationErrors",
    "icePairs",
    "icePairsWaiting",
    "icePairsInProgress",
    "icePairsSucceeded",
    "icePairsFailed",
    "iceNominatedPairs",
    "iceRequestsSentTotal",
    "iceRequestsReceivedTotal",
    "iceResponsesSentTotal",
    "iceResponsesReceivedTotal",
    "iceConsentRequestsSentTotal",
    "pairRequestsSent",
    "pairRequestsReceived",
    "pairResponsesSent",
    "pairResponsesReceived",
    "pairConsentRequestsSent",
    "pairBytesSent",
    "pairBytesReceived",
    "iceConnectedObservedMs",
    "dtlsConnectingObservedMs",
    "attemptElapsedMs",
    "offerAppliedMs",
    "answerSentMs",
    "directReadyMs",
    "firstTrackMs",
    "roundTripTime",
    "lastStatsAgeMs",
    "packetsLost",
    "jitter",
    "nackCount",
    "pliCount",
    "firCount",
    "totalDecodeTime",
    "playerReadyState",
    "playerWidth",
    "playerHeight",
    "playerCurrentTime",
    "local_host",
    "local_srflx",
    "local_relay",
    "remote_host",
    "remote_srflx",
    "remote_relay",
    "local_udp",
    "local_tcp",
    "remote_udp",
    "remote_tcp",
    "local_ipv4",
    "local_ipv6",
    "local_mdns",
    "local_unknown",
    "remote_ipv4",
    "remote_ipv6",
    "remote_mdns",
    "remote_unknown",
    "rtp_blocked",
    "rtp_forwarded_writes",
    "rtp_forwarded_bytes",
    "rtp_write_errors",
    "rtcp_blocked",
    "rtcp_forwarded_writes",
    "rtcp_forwarded_bytes",
    "rtcp_write_errors",
    "width",
    "height",
    "vpInputColorSpace",
    "vpOutputColorSpace",
    "primaries",
    "transfer",
    "matrix",
    "profile",
    "keyframes",
    "encoderErrors",
    "durationMs",
    "errorCode",
    "mae",
    "maximum",
    "luminanceError",
    "clippedBlack",
    "clippedWhite",
    "outputs",
];
pub const BOOLEANS: &[&str] = &[
    "pairNominated",
    "setupCompatible",
    "localSdpPresent",
    "remoteSdpPresent",
    "localIceCredentialsPresent",
    "remoteIceCredentialsPresent",
    "localFingerprintPresent",
    "remoteFingerprintPresent",
    "localFingerprintMatchesCertificate",
    "remoteFingerprintMatchesCertificate",
    "playerBound",
    "playerPaused",
    "trackMuted",
    "iceCheckCountersAvailable",
    "hardware",
    "fullRange",
    "syntheticOnly",
    "physicalDisplayMeasured",
    "endOfCandidatesLocal",
    "endOfCandidatesRemote",
];
pub fn enums(key: &str) -> Option<&'static [&'static str]> {
    Some(match key {
        "connectionState" => &[
            "new",
            "connecting",
            "connected",
            "disconnected",
            "failed",
            "closed",
        ],
        "iceConnectionState" | "iceState" => &[
            "new",
            "checking",
            "connected",
            "completed",
            "disconnected",
            "failed",
            "closed",
        ],
        "signalingState" => &[
            "stable",
            "have-local-offer",
            "have-remote-offer",
            "have-local-pranswer",
            "have-remote-pranswer",
            "closed",
        ],
        "iceGatheringState" => &["new", "gathering", "complete"],
        "dtlsState" => &["new", "connecting", "connected", "failed", "closed"],
        "pairState" => &["frozen", "waiting", "in-progress", "failed", "succeeded"],
        "localCandidateType" | "remoteCandidateType" => &["host", "srflx", "prflx", "relay"],
        "localSetup" | "remoteSetup" => &["active", "passive", "actpass"],
        "failureCode" => &[
            "direct_deadline",
            "stats_stalled",
            "pc_failed",
            "ice_failed",
            "relay_selected",
            "retry_no_offer",
            "connected_no_frames",
        ],
        "closureCode" => &[
            "requested_stop",
            "track_ended",
            "pc_closed",
            "sdp_rejected",
            "candidate_rejected",
            "session_replaced",
            "negotiation_error",
            "failed_cleanup",
            "participant_left",
            "room_left",
            "remote_stopped",
        ],
        "terminationKind" => &["failed", "closed"],
        "timeoutPhase" => &["ice_pair", "secure_transport"],
        "capture" => &["wgc", "dxgi", "synthetic", "unavailable"],
        "pixelFormat" | "decoderInput" | "decoderOutput" => {
            &["bgra8", "rgba8", "nv12", "h264", "unavailable"]
        }
        "gpu" => &["amd", "nvidia", "intel", "other", "unavailable"],
        "encoder" => &["mf_h264", "browser_h264", "unavailable"],
        "range" => &["full", "limited", "unavailable"],
        "matrixName" => &["bt709", "bt601", "unavailable"],
        "hdr" => &["sdr", "hdr", "unavailable"],
        "renderer" => &["webview_video", "synthetic_canvas", "unavailable"],
        "result" => &[
            "observed",
            "passed",
            "failed",
            "cancelled",
            "unavailable",
            "measured",
        ],
        "stage" => &[
            "capture",
            "conversion",
            "encoding",
            "transport",
            "reception",
            "decoding",
            "rendering",
            "unavailable",
        ],
        _ => return None,
    })
}
pub fn valid_metric(key: &str, value: &serde_json::Value) -> bool {
    if NUMBERS.contains(&key) {
        return value.is_null()
            || value
                .as_f64()
                .is_some_and(|n| n.is_finite() && (0.0..=1e15).contains(&n));
    }
    if BOOLEANS.contains(&key) {
        return value.is_null() || value.is_boolean();
    }
    enums(key).is_some_and(|allowed| {
        value.is_null() || value.as_str().is_some_and(|v| allowed.contains(&v))
    })
}
pub fn safe_metrics(input: &serde_json::Value) -> BTreeMap<String, serde_json::Value> {
    input
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, v)| valid_metric(k, v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}
pub fn metric_for_kind(kind: Kind, key: &str) -> bool {
    let color = [
        "framesCaptured",
        "framesEncoded",
        "framesSubmitted",
        "width",
        "height",
        "vpInputColorSpace",
        "vpOutputColorSpace",
        "primaries",
        "transfer",
        "matrix",
        "profile",
        "keyframes",
        "encoderErrors",
        "durationMs",
        "errorCode",
        "mae",
        "maximum",
        "luminanceError",
        "clippedBlack",
        "clippedWhite",
        "outputs",
        "hardware",
        "fullRange",
        "syntheticOnly",
        "physicalDisplayMeasured",
        "capture",
        "pixelFormat",
        "decoderInput",
        "decoderOutput",
        "gpu",
        "encoder",
        "range",
        "matrixName",
        "hdr",
        "renderer",
        "result",
        "stage",
        "framesReceived",
        "framesDecoded",
        "framesDropped",
        "keyFramesDecoded",
        "playerBound",
        "playerPaused",
        "playerReadyState",
        "playerWidth",
        "playerHeight",
        "playerCurrentTime",
        "totalDecodeTime",
    ];
    if kind == Kind::P2p {
        !color.contains(&key)
            || [
                "framesCaptured",
                "framesEncoded",
                "framesSubmitted",
                "keyframes",
                "stage",
                "result",
                "errorCode",
            ]
            .contains(&key)
            || [
                "framesReceived",
                "framesDecoded",
                "framesDropped",
                "keyFramesDecoded",
                "playerBound",
                "playerPaused",
                "playerReadyState",
                "playerWidth",
                "playerHeight",
                "playerCurrentTime",
                "totalDecodeTime",
            ]
            .contains(&key)
    } else {
        color.contains(&key)
    }
}
pub fn safe_for_kind(kind: Kind, input: &serde_json::Value) -> BTreeMap<String, serde_json::Value> {
    safe_metrics(input)
        .into_iter()
        .filter(|(k, _)| metric_for_kind(kind, k))
        .collect()
}
pub fn valid_version(v: &str) -> bool {
    let (base, suffix) = v.split_once('-').unwrap_or((v, ""));
    base.split('.').count() == 3
        && base
            .split('.')
            .all(|n| !n.is_empty() && n.len() <= 4 && n.bytes().all(|b| b.is_ascii_digit()))
        && (suffix.is_empty()
            || suffix
                .strip_prefix("nightly.")
                .or_else(|| suffix.strip_prefix("beta."))
                .is_some_and(|n| {
                    !n.is_empty() && n.len() <= 6 && n.bytes().all(|b| b.is_ascii_digit())
                }))
}
impl Event {
    pub fn validate(&self) -> bool {
        !self.id.is_nil()
            && !self.session_id.is_nil()
            && !self.participant.is_nil()
            && !self.source.is_nil()
            && !self.destination.is_nil()
            && self.attempt.len() == 64
            && self.attempt.bytes().all(|b| b.is_ascii_hexdigit())
            && valid_version(&self.version)
            && self.elapsed_ms <= 86_400_000
            && self.metrics.len() <= 128
            && self
                .metrics
                .iter()
                .all(|(k, v)| valid_metric(k, v) && metric_for_kind(self.kind, k))
            && (self.kind == Kind::Synthetic || self.patches.is_empty())
            && self.patches.len() <= 24
            && self.patches.iter().all(|p| {
                p.index < 24
                    && p.measured
                        .iter()
                        .all(|v| v.is_finite() && (0.0..=255.0).contains(v))
                    && p.mae.is_finite()
                    && (0.0..=255.0).contains(&p.mae)
                    && p.maximum.is_finite()
                    && (0.0..=255.0).contains(&p.maximum)
            })
            && serde_json::to_vec(self).is_ok_and(|v| v.len() <= 8192)
    }
}
pub fn classify(e: &Event) -> (&'static str, &'static str) {
    let text = |key: &str| e.metrics.get(key).and_then(|v| v.as_str());
    let number = |key: &str| e.metrics.get(key).and_then(|v| v.as_f64());
    if text("result") == Some("failed")
        && [Some("capture"), Some("conversion"), Some("encoding")].contains(&text("stage"))
    {
        return (
            match text("stage") {
                Some("capture") => "capture_failure",
                Some("conversion") => "conversion_failure",
                _ => "encoder_failure",
            },
            "observed",
        );
    }
    if e.kind != Kind::P2p {
        if text("result") == Some("failed") {
            return (
                match text("stage") {
                    Some("capture") => "capture_failure",
                    Some("conversion") => "conversion_failure",
                    Some("encoding") => "encoder_failure",
                    Some("transport") => "synthetic_transport_failure",
                    _ => "insufficient_evidence",
                },
                "observed",
            );
        }

        if e.kind == Kind::Synthetic && number("maximum").is_some_and(|n| n > 3.0) {
            return (
                if text("stage") == Some("conversion") {
                    "synthetic_conversion_difference"
                } else {
                    "synthetic_rgb_difference"
                },
                "measured",
            );
        }
        if number("vpOutputColorSpace") == Some(8.0)
            && e.metrics.get("fullRange") == Some(&serde_json::json!(true))
        {
            return ("full_limited_metadata_mismatch", "suspected_metadata");
        }
        if text("matrixName") == Some("bt709") && number("matrix").is_some_and(|v| v != 1.0) {
            return ("matrix_metadata_mismatch", "suspected_metadata");
        }
        return ("insufficient_evidence", "inconclusive");
    }
    if text("closureCode") == Some("session_replaced") {
        return ("session_replaced", "observed");
    }
    if text("connectionState") == Some("connected") {
        if number("framesDecoded").is_some_and(|v| v > 0.0)
            && e.metrics.get("playerBound") == Some(&serde_json::json!(false))
        {
            return ("decoded_without_player", "observed");
        }
        if number("bytesReceived").is_some_and(|v| v > 0.0) && number("framesDecoded") == Some(0.0)
        {
            return ("media_without_decode", "observed");
        }
        if number("bytesReceived") == Some(0.0) {
            return ("transport_without_media", "observed");
        }
        if number("framesDecoded").is_some_and(|v| v > 0.0) {
            return ("video_decoded", "observed");
        }
    }
    if [Some("connected"), Some("completed")].contains(&text("iceConnectionState"))
        && text("dtlsState").is_some_and(|s| s != "connected")
    {
        return ("ice_ready_dtls_incomplete", "observed");
    }
    if text("localCandidateType").is_none()
        && [Some("checking"), Some("failed")].contains(&text("iceConnectionState"))
    {
        return ("ice_without_selected_pair", "observed");
    }
    if text("failureCode") == Some("retry_no_offer") {
        return ("signaling_timeout", "observed");
    }
    ("insufficient_evidence", "inconclusive")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privacy_allowlist() {
        let safe = safe_metrics(
            &serde_json::json!({"sdp":"PRIVATE","address":"PRIVATE","gpu":"PRIVATE","width":-1,"framesDecoded":null,"connectionState":"connecting"}),
        );
        assert_eq!(safe.len(), 2);
        assert!(!serde_json::to_string(&safe).unwrap().contains("PRIVATE"));
        assert!(valid_version("0.4.0-nightly.5"));
        assert!(!valid_version("PRIVATE"));
        assert!(serde_json::from_value::<Consent>(
            serde_json::json!({"p2p":true,"color":false,"synthetic":false,"secret":"PRIVATE"})
        )
        .is_err());
    }
    #[test]
    fn independent_permissions_reject_cross_category_metrics() {
        let color = safe_for_kind(
            Kind::Color,
            &serde_json::json!({"icePairs":2,"dtlsState":"connected","bytesReceived":4000,"gpu":"amd","matrix":1,"framesDecoded":5}),
        );
        assert_eq!(color.len(), 3);
        assert!(!color.contains_key("bytesReceived"));
        assert!(!color.contains_key("icePairs"));
        assert!(safe_for_kind(Kind::P2p, &serde_json::json!({"gpu":"amd","matrix":1})).is_empty());
    }
    #[test]
    fn p2p_end_of_candidates_and_ice_restart_allowlisted() {
        let p2p = safe_for_kind(
            Kind::P2p,
            &serde_json::json!({
                "endOfCandidatesLocal": true,
                "endOfCandidatesRemote": false,
                "iceRestartCount": 2,
                "iceDuplicate": 3,
                "negotiationErrors": 1,
                "sdp": "PRIVATE"
            }),
        );
        assert_eq!(p2p.len(), 5);
        assert_eq!(p2p["endOfCandidatesLocal"], true);
        assert_eq!(p2p["endOfCandidatesRemote"], false);
        assert_eq!(p2p["iceRestartCount"], 2);
        assert_eq!(p2p["iceDuplicate"], 3);
        assert_eq!(p2p["negotiationErrors"], 1);
        assert!(safe_for_kind(
            Kind::Color,
            &serde_json::json!({
                "iceRestartCount": 1,
                "iceDuplicate": 1,
                "negotiationErrors": 1,
                "endOfCandidatesLocal": true
            })
        )
        .is_empty());
    }
}
