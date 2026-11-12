pub mod lab;
pub mod auth;
pub mod capture;
pub mod commands;
pub mod communities;
pub mod db;
pub mod deeplink;
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
static TEST_ENVIRONMENT_OVERRIDE: AtomicBool = AtomicBool::new(false);

pub fn set_test_environment_override(is_test: bool) {
    TEST_ENVIRONMENT_OVERRIDE.store(is_test, Ordering::SeqCst);
    if is_test {
        std::env::set_var("NEXUS_TEST_ENV", "1");
    }
}

pub fn is_test_environment() -> bool {
    // 1. Rust unit tests within the library
    if cfg!(test) {
        return true;
    }
    // 2. Cargo test binaries located in target/debug/deps or target/release/deps
    if let Ok(exe) = std::env::current_exe() {
        let exe_str = exe.to_string_lossy().to_lowercase();
        if exe_str.contains("target\\debug\\deps")
            || exe_str.contains("target/debug/deps")
            || exe_str.contains("target\\release\\deps")
            || exe_str.contains("target/release/deps")
        {
            return true;
        }
    }
    // 3. Cargo test temporary directory set by cargo test harness
    if std::env::var("CARGO_TARGET_TMPDIR").is_ok() {
        return true;
    }
    // 4. Overrides exclusively allowed in debug/development environments (never in production release)
    #[cfg(debug_assertions)]
    {
        if TEST_ENVIRONMENT_OVERRIDE.load(Ordering::SeqCst) {
            return true;
        }
        if let Ok(val) = std::env::var("NEXUS_TEST_ENV") {
            if val == "1" || val.eq_ignore_ascii_case("true") {
                return true;
            }
        }
    }
    false
}

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
    let mut context = tauri::generate_context!();
    lab::prepare(&mut context);
    if lab::enabled() && std::env::args().any(|arg| arg == "--lab-clear-credentials") {
        auth::delete_secure_token().expect("clear lab credentials");
        return;
    }
    if let Some(token) = deeplink::capture_startup_args(std::env::args().skip(1)) {
        if deeplink::try_forward_to_running_instance(&token) {
            return;
        }
        deeplink::set_pending_reset_token(Some(token));
    }
    let mut builder = tauri::Builder::default();
    if !lab::enabled() { builder = builder.plugin(tauri_plugin_updater::Builder::new().build()); }
    builder
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
            app.manage(capture::NativeCaptureState::new());

            #[cfg(desktop)]
            {
                let mut window = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::default(),
                )
                ;
                if lab::enabled() {
                    window = window.data_directory(lab::root().join(lab::profile()).join("webview"));
                }
                let _win = window
                .title(if lab::enabled() { format!("NEXUS LAB {}", lab::profile()) } else { "NEXUS".into() })
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .maximizable(true)
                .decorations(false)
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

            lab::record_runtime(app.handle())?;
            deeplink::ensure_windows_protocol_registered();
            deeplink::start_ipc_listener(app.handle().clone());
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
            auth::auth_request_password_reset,
            auth::auth_verify_reset_token,
            auth::auth_confirm_password_reset,
            auth::auth_take_pending_reset_token,
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
            commands::webrtc_get_ice_servers,
            updater::updater_check_channel,
            updater::updater_check_prelogin,
            updater::updater_download_and_install_prelogin,
            updater::updater_restart,
            communities::community_list,
            communities::community_create,
            communities::community_get_snapshot,
            communities::community_update,
            communities::community_delete,
            communities::community_transfer_ownership,
            communities::community_leave,
            communities::community_create_category,
            communities::community_update_category,
            communities::community_delete_category,
            communities::community_reorder_categories,
            communities::community_create_channel,
            communities::community_update_channel,
            communities::community_delete_channel,
            communities::community_reorder_channels,
            communities::community_list_channel_overwrites,
            communities::community_upsert_channel_overwrite,
            communities::community_delete_channel_overwrite,
            communities::community_list_channel_messages,
            communities::community_send_channel_message,
            communities::community_edit_channel_message,
            communities::community_delete_channel_message,
            communities::community_mark_channel_read,
            communities::community_list_roles,
            communities::community_create_role,
            communities::community_update_role,
            communities::community_delete_role,
            communities::community_reorder_roles,
            communities::community_list_members,
            communities::community_update_member,
            communities::community_set_member_roles,
            communities::community_add_member_role,
            communities::community_remove_member_role,
            communities::community_kick_member,
            communities::community_ban_member,
            communities::community_unban_member,
            communities::community_list_bans,
            communities::community_mute_member,
            communities::community_list_audit_logs,
            communities::community_create_invite,
            communities::community_list_invites,
            communities::community_revoke_invite,
            communities::community_get_invite_preview,
            communities::community_accept_invite,
            capture::native_list_capture_sources,
            capture::native_start_screen_share,
            capture::native_stop_screen_share,
            capture::native_set_screen_quality,
            capture::native_set_adaptive_bitrate,
            capture::native_add_screen_peer,
            capture::native_remove_screen_peer,
            capture::native_handle_screen_answer,
            capture::native_handle_screen_ice,
        ])
        .build(context)
        .expect("error while building NEXUS desktop application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                app_handle
                    .state::<capture::NativeCaptureState>()
                    .shutdown_sync();
            }
        });
}
