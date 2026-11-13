use std::time::{Duration, Instant};

// interceptor 0.17.3 calculate_rtt_ms feeds RemoteInboundRTP unchanged.
pub fn native_rtt_ms(raw: Option<f64>) -> Option<f64> {
    raw.filter(|v| v.is_finite() && *v >= 0.0)
}
#[derive(Default)]
pub struct NetworkEvidence {
    pub remb_bps: Option<f64>,
    pub remb_at: Option<Instant>,
    pub loss_fraction: Option<f64>,
    pub receiver_report_at: Option<Instant>,
    pub good_samples: u32,
    pub bad_samples: u32,
    headroom_samples: u32,
    last_good_remb: Option<Instant>,
    pub sampled_at: Option<Instant>,
}
impl NetworkEvidence {
    pub fn sample(&mut self, rtt_ms: Option<f64>, loss: Option<f64>, now: Instant) {
        self.loss_fraction = loss;
        self.sampled_at = Some(now);
        let healthy = rtt_ms.is_some_and(|r| r <= 150.0) && loss.is_some_and(|l| l <= 0.01)
            && self.remb_at.is_some_and(|t| now.duration_since(t) <= Duration::from_secs(10))
            && self.receiver_report_at.is_some_and(|t| now.duration_since(t) <= Duration::from_secs(10));
        if !healthy || !self.remb_bps.is_some_and(|v| v >= 12_500_000.0) { self.headroom_samples = 0; self.last_good_remb = None; }
        else if self.remb_at != self.last_good_remb { self.headroom_samples += 1; self.last_good_remb = self.remb_at; }
        self.good_samples = if healthy { self.good_samples + 1 } else { 0 };
        self.bad_samples = if rtt_ms.is_some_and(|r| r > 250.0) || loss.is_some_and(|l| l > 0.02) { self.bad_samples + 1 } else { 0 };
    }
    pub fn permits_10m(&self, now: Instant) -> bool {
        self.good_samples >= 3 && self.headroom_samples >= 3 && self.remb_bps.is_some_and(|v| v.is_finite() && v >= 12_500_000.0)
            && self.remb_at.is_some_and(|t| now.duration_since(t) <= Duration::from_secs(10))
            && self.sampled_at.is_some_and(|t| now.duration_since(t) <= Duration::from_secs(8))
            && self.receiver_report_at.is_some_and(|t| now.duration_since(t) <= Duration::from_secs(10))
    }
}
pub fn experiment_bitrate(profile: &str) -> Result<u32, String> {
    match profile { "official" => Ok(0), "a35" => Ok(3_500_000), "a4235" => Ok(4_235_000), "b6" => Ok(6_000_000), "c8" => Ok(8_000_000), "d10" => Ok(10_000_000), _ => Err("Perfil local de bitrate inválido".into()) }
}

// Proposed controller, pure and deliberately not enabled by default before WAN validation.
#[derive(Default)]
pub struct ProposedPolicy { healthy: u32, last_change: Option<Instant>, last_sample: Option<Instant> }
impl ProposedPolicy {
    pub fn target(&mut self, current: u32, cap: u32, remb: Option<f64>, rtt_ms: Option<f64>, loss: Option<f64>, now: Instant) -> u32 {
        if self.last_sample.is_some_and(|t| now.duration_since(t) < Duration::from_secs(4)) { return current; }
        self.last_sample = Some(now);
        if self.last_change.is_some_and(|t| now.duration_since(t) < Duration::from_secs(5)) { return current; }
        let congested = rtt_ms.is_some_and(|v| v > 250.0) || loss.is_some_and(|v| v > 0.02);
        let healthy = rtt_ms.is_some_and(|v| v <= 150.0) && loss.is_some_and(|v| v <= 0.01);
        self.healthy = if healthy { self.healthy + 1 } else { 0 };
        let budget = remb.filter(|v| v.is_finite() && *v > 0.0).map(|v| (v * 0.8).min(cap as f64) as u32);
        let next = if congested { ((current as f64 * 0.8) as u32).min(budget.unwrap_or(cap)).max(300_000) }
            else if self.healthy >= 3 { ((current as f64 * 1.1) as u32).min(budget.unwrap_or(current)).min(cap).max(300_000) } else { current };
        if next != current { self.last_change = Some(now); self.healthy = 0; }
        next
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn profiles_are_session_overrides_not_official_preset_mutations() {
        assert_eq!(experiment_bitrate("official").unwrap(),0);
        assert_eq!(experiment_bitrate("a35").unwrap(),3_500_000);
        assert_eq!(experiment_bitrate("a4235").unwrap(),4_235_000);
        assert_eq!(experiment_bitrate("b6").unwrap(),6_000_000);
        assert_eq!(experiment_bitrate("c8").unwrap(),8_000_000);
        assert_eq!(experiment_bitrate("d10").unwrap(),10_000_000);
        assert!(experiment_bitrate("unknown").is_err());
        assert_eq!(super::super::ScreenQualityPreset::P1080F60.spec().initial_bitrate_bps,3_500_000);
        assert_eq!(super::super::ScreenQualityPreset::P1080F60.spec().max_bitrate_bps,5_000_000);
    }
    #[test] fn native_rtt_is_milliseconds_and_not_w3c_seconds() { assert_eq!(native_rtt_ms(Some(34.0)), Some(34.0)); assert_eq!(native_rtt_ms(Some(34.0)).unwrap()/1000.0,0.034); assert_eq!(native_rtt_ms(Some(f64::NAN)),None); }
    #[test] fn ten_megabits_requires_margin_freshness_and_multiple_healthy_samples() {
        let now=Instant::now(); let mut e=NetworkEvidence {remb_bps:Some(10_000_000.0),remb_at:Some(now),receiver_report_at:Some(now),..Default::default()};
        for _ in 0..3 {e.sample(Some(35.0),Some(0.0),now);} assert!(!e.permits_10m(now));
        e.remb_bps=Some(13_000_000.0); assert!(!e.permits_10m(now));
        for i in 0..3 {let t=now+Duration::from_secs(5*i);e.remb_at=Some(t);e.receiver_report_at=Some(t);e.sample(Some(35.0),Some(0.0),t);}
        let last=now+Duration::from_secs(10); assert!(e.permits_10m(last)); assert!(!e.permits_10m(last+Duration::from_secs(11)));
        e.sample(Some(300.0),Some(0.1),last); assert!(!e.permits_10m(last));
    }
    #[test] fn policy_does_not_grow_on_one_remb_and_backs_off_with_hysteresis() {
        let mut p=ProposedPolicy::default();let t=Instant::now();
        assert_eq!(p.target(4_000_000,10_000_000,Some(10_000_000.0),Some(35.0),Some(0.0),t),4_000_000);
        assert_eq!(p.target(4_000_000,10_000_000,Some(10_000_000.0),Some(35.0),Some(0.0),t+Duration::from_secs(5)),4_000_000);
        assert_eq!(p.target(4_000_000,10_000_000,Some(10_000_000.0),Some(35.0),Some(0.0),t+Duration::from_secs(10)),4_400_000);
        assert_eq!(p.target(4_400_000,10_000_000,Some(10_000_000.0),Some(300.0),Some(0.1),t+Duration::from_secs(11)),4_400_000);
        assert_eq!(p.target(4_400_000,10_000_000,Some(10_000_000.0),Some(300.0),Some(0.1),t+Duration::from_secs(16)),3_520_000);
    }
}
