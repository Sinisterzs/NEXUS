use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::process::Command;

const TEST_SERVICE: &str = "nexus-auth-cross-process-test-isolated";
const TEST_USER: &str = "synthetic-session-user";
const OFFICIAL_ORIGIN: &str = "https://nexus-api.dynv6.net";
const OFFICIAL_SERVER_ID: &str =
    "nexus-id-6a2d70e5c08d48566d6e1d7749359de11eba6dc8fa3743c01d59411b4d7e7092";

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct SyntheticCredential {
    token: String,
    server_origin: String,
    server_id: Option<String>,
}

fn classify_restore(
    stored: Option<&SyntheticCredential>,
    current_origin: &str,
    current_server_id: &str,
    backend_outcome: &str,
) -> &'static str {
    let cred = match stored {
        Some(c) => c,
        None => return "keyring_entry_missing",
    };
    if cred.server_origin != current_origin {
        return "origin_mismatch";
    }
    if cred.server_id.as_deref() != Some(current_server_id) {
        return "identity_mismatch";
    }
    match backend_outcome {
        "200" => "backend_200",
        "401" => "backend_401",
        "network_error" => "network_error",
        "5xx" => "backend_5xx",
        _ => "unknown",
    }
}

#[test]
fn test_cross_process_keyring_persistence_and_restore_categories() {
    if let Ok(role) = std::env::var("NEXUS_AUTH_TEST_ROLE") {
        let entry = Entry::new(TEST_SERVICE, TEST_USER).expect("create isolated test keyring entry");
        if role == "writer" {
            let cred = SyntheticCredential {
                token: "synthetic-token-never-real".to_string(),
                server_origin: OFFICIAL_ORIGIN.to_string(),
                server_id: Some(OFFICIAL_SERVER_ID.to_string()),
            };
            let payload = serde_json::to_string(&cred).unwrap();
            entry.set_password(&payload).expect("Process A must persist synthetic credential");
            println!("[Process A] category=write_ok service={}", TEST_SERVICE);
            return;
        } else if role == "reader" {
            let raw = entry.get_password().expect("Process B must read synthetic credential");
            let cred: SyntheticCredential =
                serde_json::from_str(&raw).expect("Process B must parse synthetic credential");

            assert_eq!(
                classify_restore(Some(&cred), OFFICIAL_ORIGIN, OFFICIAL_SERVER_ID, "200"),
                "backend_200"
            );
            assert_eq!(
                classify_restore(Some(&cred), OFFICIAL_ORIGIN, OFFICIAL_SERVER_ID, "401"),
                "backend_401"
            );
            assert_eq!(
                classify_restore(Some(&cred), OFFICIAL_ORIGIN, OFFICIAL_SERVER_ID, "network_error"),
                "network_error"
            );
            assert_eq!(
                classify_restore(Some(&cred), OFFICIAL_ORIGIN, OFFICIAL_SERVER_ID, "5xx"),
                "backend_5xx"
            );
            assert_eq!(
                classify_restore(Some(&cred), "https://custom.invalid", OFFICIAL_SERVER_ID, "200"),
                "origin_mismatch"
            );
            assert_eq!(
                classify_restore(Some(&cred), OFFICIAL_ORIGIN, "nexus-id-unexpected", "200"),
                "identity_mismatch"
            );
            assert_eq!(
                classify_restore(None, OFFICIAL_ORIGIN, OFFICIAL_SERVER_ID, "200"),
                "keyring_entry_missing"
            );

            // Network error preserves credential: still readable
            assert!(entry.get_password().is_ok());

            // Explicit logout removes only the isolated test credential
            entry.delete_credential().expect("explicit test logout deletes isolated entry");
            assert!(entry.get_password().is_err());

            println!("[Process B] category=read_and_verify_ok service={}", TEST_SERVICE);
            return;
        }
    }

    let exe = std::env::current_exe().expect("current test binary");

    let out_a = Command::new(&exe)
        .env("NEXUS_AUTH_TEST_ROLE", "writer")
        .arg("--exact")
        .arg("test_cross_process_keyring_persistence_and_restore_categories")
        .arg("--nocapture")
        .output()
        .expect("spawn Process A");
    println!("Process A exit={:?} stdout={}", out_a.status.code(), String::from_utf8_lossy(&out_a.stdout).trim());
    assert!(out_a.status.success(), "Process A failed");

    let out_b = Command::new(&exe)
        .env("NEXUS_AUTH_TEST_ROLE", "reader")
        .arg("--exact")
        .arg("test_cross_process_keyring_persistence_and_restore_categories")
        .arg("--nocapture")
        .output()
        .expect("spawn Process B");
    println!("Process B exit={:?} stdout={}", out_b.status.code(), String::from_utf8_lossy(&out_b.stdout).trim());
    assert!(out_b.status.success(), "Process B failed");
}
