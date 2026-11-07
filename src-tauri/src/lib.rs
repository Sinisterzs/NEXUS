pub mod auth;
pub mod commands;
pub mod db;
pub mod dm;
pub mod friends;
pub mod network;
pub mod oauth;

use db::DbState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

static CALL_MIC_CONSENT: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn call_set_mic_consent(granted: bool) {
    CALL_MIC_CONSENT.store(granted, Ordering::SeqCst);
}

#[tauri::command]
fn call_get_mic_consent() -> bool {
    CALL_MIC_CONSENT.load(Ordering::SeqCst)
}

#[tauri::command]
fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "NEXUS",
        "version": "0.2.2",
        "phase": "2.1.1",
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
            _ => tauri::webview::PermissionResponse::Default,
        })
        .setup(|app| {
            let db = DbState::init(app.handle()).expect("Failed to initialize SQLite database");
            app.manage(db);
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
            friends::gateway_get_auth_token,
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
            network::network_get_server_address,
            network::network_set_server_address,
            network::network_check_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NEXUS desktop application");
}
