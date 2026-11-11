//! Opt-in lab binary. Production builds cannot contain this feature.
#[cfg(all(feature = "test-lab", not(debug_assertions)))]
compile_error!("test-lab is restricted to Debug builds");

pub const API: &str = "http://127.0.0.1:13001";
pub fn enabled() -> bool { cfg!(feature = "test-lab") }

pub fn profile() -> &'static str {
    match std::env::var("NEXUS_LAB_PROFILE").as_deref() {
        Ok("A") => "A",
        Ok("B") => "B",
        _ => panic!("Lab requires NEXUS_LAB_PROFILE=A or B"),
    }
}

pub fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().join(".nexus-lab")
}

pub fn prepare(context: &mut tauri::Context<tauri::Wry>) {
    if !enabled() { return; }
    let profile = profile();
    let dir = root().join(profile);
    std::fs::create_dir_all(&dir).expect("create lab profile");
    // Refuse directory junctions/symlinks escaping the dedicated workspace tree.
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize().unwrap();
    assert_eq!(root().canonicalize().unwrap(), workspace.join(".nexus-lab"));
    assert_eq!(dir.canonicalize().unwrap(), workspace.join(".nexus-lab").join(profile));
    for (key, subdir) in [("APPDATA", "roaming"), ("LOCALAPPDATA", "local"), ("NEXUS_APP_DATA_DIR", "data")] {
        let path = dir.join(subdir);
        std::fs::create_dir_all(&path).unwrap();
        assert_eq!(path.canonicalize().unwrap(), workspace.join(".nexus-lab").join(profile).join(subdir));
        std::env::set_var(key, path);
    }
    std::env::remove_var("NEXUS_TEST_ENV");
    std::env::remove_var("NEXUS_KEYRING_KEY");
    std::env::remove_var("WEBVIEW2_USER_DATA_FOLDER");
    std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
    context.config_mut().identifier = format!("com.nexus.testlab.{}", profile.to_lowercase());
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(
            dir.join("tauri")
        )
    );
}

pub fn record_runtime(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    if !enabled() { return Ok(()); }
    let dir = root().join(profile());
    std::fs::write(dir.join("runtime.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "pid": std::process::id(), "profile": profile(),
        "identifier": app.config().identifier,
        "appData": app.path().app_data_dir()?,
        "appLocalData": app.path().app_local_data_dir()?,
        "sqlite": dir.join("data/nexus.db"),
        "webview": dir.join("webview"), "api": API,
        "keyringService": format!("nexus_testlab_{}", profile()),
    }))?)?;
    Ok(())
}

#[cfg(all(test, feature = "test-lab"))]
mod tests {
    #[test]
    fn lab_cannot_select_another_server() {
        assert_eq!(crate::auth::get_api_base(), super::API);
        assert_eq!(crate::auth::get_default_api_base(), super::API);
        assert!(crate::network::validate_server_url(super::API).is_ok());
        for url in ["http://127.0.0.1:3001", "https://nexus-api.dynv6.net", "http://localhost:13001", "http://127.0.0.1:13001/evil"] {
            assert!(crate::network::validate_server_url(url).is_err());
        }
    }

    #[tokio::test]
    async fn lab_cannot_manage_host_tailscale_or_use_google_login() {
        assert!(crate::network::network_open_tailscale().await.is_err());
        assert!(crate::auth::auth_login_google().await.is_err());
        assert!(crate::auth::auth_link_google().await.is_err());
    }
}
