pub mod auth;
pub mod commands;
pub mod db;
pub mod dm;
pub mod friends;
pub mod network;
pub mod oauth;
pub mod updater;

use db::DbState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

static CALL_MIC_CONSENT: AtomicBool = AtomicBool::new(false);
static SCREEN_CAPTURE_CONSENT: AtomicBool = AtomicBool::new(false);

pub fn reset_mic_consent() {
    CALL_MIC_CONSENT.store(false, Ordering::SeqCst);
}

pub fn set_mic_consent(granted: bool) {
    CALL_MIC_CONSENT.store(granted, Ordering::SeqCst);
}

pub fn get_mic_consent() -> bool {
    CALL_MIC_CONSENT.load(Ordering::SeqCst)
}

pub fn reset_screen_capture_consent() {
    SCREEN_CAPTURE_CONSENT.store(false, Ordering::SeqCst);
}

pub fn set_screen_capture_consent(granted: bool) {
    SCREEN_CAPTURE_CONSENT.store(granted, Ordering::SeqCst);
}

pub fn get_screen_capture_consent() -> bool {
    SCREEN_CAPTURE_CONSENT.load(Ordering::SeqCst)
}

#[tauri::command]
fn call_set_mic_consent(granted: bool) {
    set_mic_consent(granted);
}

#[tauri::command]
fn call_get_mic_consent() -> bool {
    get_mic_consent()
}

#[tauri::command]
fn screen_set_capture_consent(granted: bool) {
    set_screen_capture_consent(granted);
}

#[tauri::command]
fn screen_get_capture_consent() -> bool {
    get_screen_capture_consent()
}

#[tauri::command]
fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "NEXUS",
        "version": env!("CARGO_PKG_VERSION"),
        "phase": "3.1",
        "status": "ready"
    })
}

#[tauri::command]
fn get_initial_tab() -> String {
    let args: Vec<String> = std::env::args().collect();
    for arg in args {
        let clean = arg.trim_start_matches("--tab=").trim_start_matches("--");
        if clean == "messages"
            || clean == "communities"
            || clean == "calls"
            || clean == "settings"
            || clean == "home"
        {
            return clean.to_string();
        }
    }
    "home".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .on_permission_request(|_webview, kind| match kind {
            tauri::webview::PermissionKind::Microphone => {
                if CALL_MIC_CONSENT.load(Ordering::SeqCst) {
                    tauri::webview::PermissionResponse::Allow
                } else {
                    tauri::webview::PermissionResponse::Deny
                }
            }
            tauri::webview::PermissionKind::DisplayCapture => {
                if SCREEN_CAPTURE_CONSENT.load(Ordering::SeqCst) {
                    tauri::webview::PermissionResponse::Allow
                } else {
                    tauri::webview::PermissionResponse::Deny
                }
            }
            tauri::webview::PermissionKind::Camera
            | tauri::webview::PermissionKind::Geolocation
            | tauri::webview::PermissionKind::Notifications => {
                tauri::webview::PermissionResponse::Deny
            }
            _ => tauri::webview::PermissionResponse::Deny,
        })
        .setup(|app| {
            let db = DbState::init(app.handle()).expect("Failed to initialize SQLite database");
            app.manage(db);

            #[cfg(desktop)]
            {
                let _win = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::default(),
                )
                .title("NEXUS")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .maximizable(true)
                .decorations(true)
                .theme(Some(tauri::Theme::Dark))
                .on_web_resource_request(|_request, response| {
                    if let Some(csp_val) = response.headers_mut().get_mut("content-security-policy") {
                        if let Ok(csp_str) = csp_val.to_str() {
                            let api_base = crate::auth::get_api_base();
                            let augmented = crate::network::augment_csp_for_server(csp_str, &api_base);
                            if let Ok(new_hdr) = tauri::http::HeaderValue::from_str(&augmented) {
                                *csp_val = new_hdr;
                                eprintln!("[CSP] Política dinâmica de connect-src aplicada ao documento principal para: {}", api_base);
                            }
                        }
                    }
                })
                .build()?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_initial_tab,
            commands::ensure_conversation,
            commands::get_conversations,
            commands::get_messages,
            commands::save_message,
            commands::get_conversation_state,
            commands::save_conversation_draft,
            commands::mark_conversation_read,
            commands::get_cache_metadata,
            commands::set_cache_metadata,
            commands::db_get_schema_version,
            commands::db_migrate_to_v3,
            auth::auth_register,
            auth::auth_login,
            auth::auth_logout,
            auth::auth_restore_session,
            auth::auth_get_me,
            auth::auth_update_profile,
            auth::auth_has_stored_session,
            auth::auth_check_backend,
            auth::auth_login_google,
            auth::auth_link_google,
            auth::auth_unlink_google,
            auth::auth_cancel_google_login,
            auth::get_oauth_config,
            friends::friends_get_list,
            friends::friends_get_requests,
            friends::friends_send_request,
            friends::friends_accept_request,
            friends::friends_reject_request,
            friends::friends_cancel_request,
            friends::friends_decline_request,
            friends::friends_remove,
            friends::friends_block_user,
            friends::friends_unblock_user,
            friends::friends_search_users,
            friends::friends_get_presence,
            friends::friends_update_presence,
            friends::friends_get_ws_url,
            friends::gateway_get_ws_url,
            dm::gateway_get_ticket,
            dm::dm_list_conversations,
            dm::dm_get_or_create_conversation,
            dm::dm_get_messages,
            dm::dm_send_message,
            dm::dm_edit_message,
            dm::dm_delete_message,
            dm::dm_mark_read,
            dm::dm_cache_incoming_message,
            network::network_get_status,
            network::network_open_tailscale,
            call_set_mic_consent,
            call_get_mic_consent,
            screen_set_capture_consent,
            screen_get_capture_consent,
            network::network_get_server_address,
            network::network_set_server_address,
            network::network_check_server,
            network::network_approve_server,
            network::network_verify_server,
            updater::updater_check_channel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NEXUS desktop application");
}
