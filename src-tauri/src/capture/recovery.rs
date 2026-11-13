use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step { Ready, Wait, Retry, Exhausted }
#[derive(Default)]
pub struct Recovery {
    started: Option<Instant>,
    next: Option<Instant>,
    attempts: u32,
    episodes: VecDeque<Instant>,
    exhausted: bool,
}
impl Recovery {
    pub fn failed(&self) -> bool {self.exhausted}
    pub fn fail(&mut self) {self.exhausted=true;}
    pub fn active(&self) -> bool { self.started.is_some() && !self.exhausted }
    pub fn begin(&mut self, now: Instant) {
        if self.started.is_some() || self.exhausted { return; }
        while self.episodes.front().is_some_and(|t| now.duration_since(*t)>=Duration::from_secs(60)) { self.episodes.pop_front(); }
        if self.episodes.len()>=8 {self.exhausted=true;return;}
        self.episodes.push_back(now); self.started=Some(now);self.next=Some(now);self.attempts=0;
    }
    pub fn step(&mut self, now: Instant) -> Step {
        if self.exhausted {return Step::Exhausted;}
        let Some(started)=self.started else {return Step::Ready};
        if now.duration_since(started)>=Duration::from_secs(12) || self.attempts>=8 {self.exhausted=true;return Step::Exhausted;}
        if self.next.is_some_and(|t| now<t) {return Step::Wait;}
        self.attempts+=1;
        let delay=[100,200,400,800,1200,1600,2000,2000][(self.attempts-1) as usize];
        self.next=Some(now+Duration::from_millis(delay));Step::Retry
    }
    // DuplicateOutput success is not recovery: wait for a fresh acquired frame.
    pub fn frame_restored(&mut self) {self.started=None;self.next=None;self.attempts=0;}
    pub fn step_check_exhausted(&mut self, now: Instant) -> bool {
        if self.started.is_some_and(|t|now.duration_since(t)>=Duration::from_secs(12)) {self.exhausted=true;}
        self.exhausted
    }
    pub fn attempts(&self) -> u32 {self.attempts}
}
// Copy/release errors must not escape before ReleaseFrame. Error priority preserves
// a failed release (which can invalidate the entire duplication) for recovery.
pub fn acquired_frame<T,E>(copy: impl FnOnce()->Result<T,E>, release: impl FnOnce()->Result<(),E>) -> Result<T,E> {
    let output=copy();let released=release();released?;output
}
pub fn retryable_hresult(code: i32) -> bool {
    matches!(code as u32,0x887A0026|0x887A0025|0x887A0022|0x887A0028|0x887A002B|0x887A0001|0x80070005)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn normal_and_access_lost_recover_after_transient_failure() {
        let t=Instant::now();let mut r=Recovery::default();assert_eq!(r.step(t),Step::Ready);
        r.begin(t);assert_eq!(r.step(t),Step::Retry);assert_eq!(r.attempts(),1);
        assert_eq!(r.step(t+Duration::from_millis(99)),Step::Wait);
        assert_eq!(r.step(t+Duration::from_millis(100)),Step::Retry);
        assert!(r.active());r.frame_restored();assert_eq!(r.step(t+Duration::from_secs(1)),Step::Ready);
    }
    #[test] fn no_frame_after_duplicate_success_cannot_reset_budget() {
        let t=Instant::now();let mut r=Recovery::default();r.begin(t);
        for ms in [0,100,300,700,1500,2700,4300,6300] { assert_eq!(r.step(t+Duration::from_millis(ms)),Step::Retry); }
        assert_eq!(r.step(t+Duration::from_secs(12)),Step::Exhausted);
        r.begin(t+Duration::from_secs(20));assert_eq!(r.step(t+Duration::from_secs(20)),Step::Exhausted);
    }
    #[test] fn repeated_mode_changes_are_bounded_and_return_to_desktop_recovers() {
        let t=Instant::now();let mut r=Recovery::default();
        for i in 0..8 {let n=t+Duration::from_secs(i);r.begin(n);assert_eq!(r.step(n),Step::Retry);r.frame_restored();assert_eq!(r.step(n),Step::Ready);}
        r.begin(t+Duration::from_secs(9));assert_eq!(r.step(t+Duration::from_secs(9)),Step::Exhausted);
    }
    #[test] fn healthy_capture_can_recover_again_after_the_rolling_window() {
        let t=Instant::now();let mut r=Recovery::default();
        for i in 0..8 {let n=t+Duration::from_secs(i);r.begin(n);r.step(n);r.frame_restored();}
        r.begin(t+Duration::from_secs(68));assert_eq!(r.step(t+Duration::from_secs(68)),Step::Retry);
    }
    #[test] fn frame_is_released_exactly_once_even_when_processing_fails() {
        let calls=std::cell::Cell::new(0);
        assert_eq!(acquired_frame(||Err::<(),_>(1),||{calls.set(calls.get()+1);Ok(())}),Err(1));assert_eq!(calls.get(),1);
        assert_eq!(acquired_frame(||Ok::<_,i32>(7),||Err(2)),Err(2));
        assert_eq!(acquired_frame(||Err::<(),_>(1),||Err(2)),Err(2));
        assert_eq!(acquired_frame(||Ok::<_,i32>(7),||Ok(())),Ok(7));
    }
    #[test] fn duplicate_created_but_first_frame_missing_keeps_same_deadline_and_attempt_count() {
        let t=Instant::now();let mut r=Recovery::default();r.begin(t);
        assert_eq!(r.step(t),Step::Retry);
        // DuplicateOutput succeeded; no fresh frame for one second.
        r.begin(t+Duration::from_secs(1));assert_eq!(r.attempts(),1);
        assert_eq!(r.step(t+Duration::from_secs(1)),Step::Retry);
        assert!(!r.step_check_exhausted(t+Duration::from_secs(11)));
        assert!(r.step_check_exhausted(t+Duration::from_secs(12)));
        assert!(r.failed());
    }
    #[test] fn error_classes_do_not_retry_device_removal_forever() {
        assert!(retryable_hresult(0x887A0026u32 as i32));assert!(retryable_hresult(0x887A0025u32 as i32));
        assert!(!retryable_hresult(0x887A0005u32 as i32));assert!(!retryable_hresult(0x887A0007u32 as i32));
    }
}

// Centered aspect-preserving destination, including when monitor input mode changes.
pub fn fit_destination(sw:u32,sh:u32,dw:u32,dh:u32)->(i32,i32,i32,i32) {
    let scale=(dw as f64/sw.max(1) as f64).min(dh as f64/sh.max(1) as f64);
    let w=((sw as f64*scale).round() as u32).min(dw).max(1);let h=((sh as f64*scale).round() as u32).min(dh).max(1);
    let left=(dw-w)/2;let top=(dh-h)/2;(left as i32,top as i32,(left+w) as i32,(top+h) as i32)
}
#[cfg(test)] mod geometry_tests {
 use super::*;
 #[test] fn stable_1080p_output_fits_game_and_returning_desktop_without_distortion(){
    assert_eq!(fit_destination(1920,1080,1920,1080),(0,0,1920,1080));
    assert_eq!(fit_destination(1280,720,1920,1080),(0,0,1920,1080));
    assert_eq!(fit_destination(1280,1024,1920,1080),(285,0,1635,1080));
    assert_eq!(fit_destination(1920,1080,1920,1080),(0,0,1920,1080));
 }
}
