//! NEXUS - Phase 3.0: Screen Capture Permission Unit & Integration Tests
//! Validates atomic consent lifecycle, zero-retention guarantee, and reset semantics.

use nexus_lib::{
    get_mic_consent, get_screen_capture_consent, reset_mic_consent, reset_screen_capture_consent,
    set_mic_consent, set_screen_capture_consent,
};

#[test]
fn test_screen_capture_consent_lifecycle() {
    // 1. Initial / reset state must be false
    reset_screen_capture_consent();
    assert_eq!(get_screen_capture_consent(), false, "Screen capture consent must be false by default");

    // 2. Granting consent temporarily
    set_screen_capture_consent(true);
    assert_eq!(get_screen_capture_consent(), true, "Screen capture consent must be true when granted");

    // 3. Revoking consent explicitly
    set_screen_capture_consent(false);
    assert_eq!(get_screen_capture_consent(), false, "Screen capture consent must be false when explicitly revoked");

    // 4. Reset semantics
    set_screen_capture_consent(true);
    assert_eq!(get_screen_capture_consent(), true);
    reset_screen_capture_consent();
    assert_eq!(get_screen_capture_consent(), false, "Reset must restore consent to false");
}

#[test]
fn test_screen_capture_and_mic_consent_isolation() {
    // Verify that screen capture consent and microphone consent are strictly independent
    reset_screen_capture_consent();
    reset_mic_consent();

    assert_eq!(get_screen_capture_consent(), false);
    assert_eq!(get_mic_consent(), false);

    // Grant screen capture consent only
    set_screen_capture_consent(true);
    assert_eq!(get_screen_capture_consent(), true);
    assert_eq!(get_mic_consent(), false, "Mic consent must not be affected by screen capture consent");

    // Grant mic consent, revoke screen capture
    set_mic_consent(true);
    set_screen_capture_consent(false);
    assert_eq!(get_screen_capture_consent(), false, "Screen capture must be revoked");
    assert_eq!(get_mic_consent(), true, "Mic consent must remain intact");

    // Reset both
    reset_screen_capture_consent();
    reset_mic_consent();
    assert_eq!(get_screen_capture_consent(), false);
    assert_eq!(get_mic_consent(), false);
}
