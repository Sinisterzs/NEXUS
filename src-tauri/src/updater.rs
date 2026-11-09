use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{Manager, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub rid: Option<u32>,
    pub current_version: String,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub raw_json: Option<serde_json::Value>,
    pub latest_remote_version: Option<String>,
    pub is_current_higher: bool,
    pub channel: String,
    pub endpoint_used: String,
    pub error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct ManifestData {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
}

const GITHUB_REPO_OWNER: &str = "Sinisterzs";
const GITHUB_REPO_NAME: &str = "NEXUS";
const STABLE_ENDPOINT: &str =
    "https://github.com/Sinisterzs/NEXUS/releases/latest/download/latest.json";
const NIGHTLY_FALLBACK_ENDPOINT: &str =
    "https://github.com/Sinisterzs/NEXUS/releases/download/v0.1.9-nightly.1/latest-nightly.json";

/// Resolve dynamic manifest endpoint for the chosen channel
pub async fn resolve_channel_endpoint(channel: &str) -> (String, Option<String>) {
    if channel.eq_ignore_ascii_case("beta") || channel.eq_ignore_ascii_case("nightly") {
        // Query GitHub API for the latest pre-release containing latest-nightly.json
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("NEXUS-Desktop-Updater")
            .build();

        if let Ok(client) = client {
            let api_url = format!(
                "https://api.github.com/repos/{}/{}/releases?per_page=10",
                GITHUB_REPO_OWNER, GITHUB_REPO_NAME
            );
            if let Ok(resp) = client.get(&api_url).send().await {
                if resp.status().is_success() {
                    if let Ok(releases) = resp.json::<Vec<GitHubRelease>>().await {
                        for release in releases {
                            if release.prerelease || release.tag_name.contains("nightly") {
                                if let Some(asset) = release
                                    .assets
                                    .into_iter()
                                    .find(|a| a.name == "latest-nightly.json")
                                {
                                    return (asset.browser_download_url, Some(release.tag_name));
                                }
                            }
                        }
                    }
                }
            }
        }
        // Fallback if GitHub API is rate-limited or unavailable
        (
            NIGHTLY_FALLBACK_ENDPOINT.to_string(),
            Some("v0.1.9-nightly.1".to_string()),
        )
    } else {
        (STABLE_ENDPOINT.to_string(), None)
    }
}

#[tauri::command]
pub async fn updater_check_channel<R: Runtime>(
    webview: Webview<R>,
    channel: String,
) -> Result<UpdateCheckResult, String> {
    let app = webview.app_handle();
    let current_version = app.package_info().version.to_string();
    let norm_channel =
        if channel.eq_ignore_ascii_case("beta") || channel.eq_ignore_ascii_case("nightly") {
            "beta".to_string()
        } else {
            "stable".to_string()
        };

    let (endpoint_url, _resolved_tag) = resolve_channel_endpoint(&norm_channel).await;

    let target_url = Url::parse(&endpoint_url)
        .map_err(|e| format!("URL do manifesto inválida ({}): {}", endpoint_url, e))?;

    // Also fetch remote manifest independently to capture version information even if current >= remote
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("NEXUS-Desktop-Updater")
        .build()
        .map_err(|e| e.to_string())?;

    let remote_manifest: Option<ManifestData> =
        match client.get(target_url.as_str()).send().await {
            Ok(res) if res.status().is_success() => res.json::<ManifestData>().await.ok(),
            _ => None,
        };

    let latest_remote_version = remote_manifest.as_ref().map(|m| m.version.clone());

    // Native Tauri 2 updater builder with dynamic endpoint
    let builder = webview
        .updater_builder()
        .endpoints(vec![target_url.clone()])
        .map_err(|e| format!("Erro ao configurar endpoint do updater: {}", e))?;

    let updater = builder
        .build()
        .map_err(|e| format!("Erro ao inicializar updater Tauri 2: {}", e))?;

    let update = match updater.check().await {
        Ok(u) => u,
        Err(e) => {
            return Err(format!(
                "Falha ao verificar atualizações no canal {}: {}",
                norm_channel, e
            ));
        }
    };

    if let Some(update) = update {
        let update_version = update.version.clone();
        let update_body = update.body.clone();
        let raw_json = update.raw_json.clone();
        let date_str = raw_json
            .get("pub_date")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let rid = webview.resources_table().add(update);

        Ok(UpdateCheckResult {
            update_available: true,
            rid: Some(rid),
            current_version,
            version: Some(update_version.clone()),
            date: date_str,
            body: update_body,
            raw_json: Some(raw_json),
            latest_remote_version: Some(update_version),
            is_current_higher: false,
            channel: norm_channel,
            endpoint_used: endpoint_url,
            error_message: None,
        })
    } else {
        // No update returned by semver comparison (current >= remote or identical)
        let is_current_higher = if let Some(ref remote_ver) = latest_remote_version {
            match (
                semver::Version::parse(&current_version),
                semver::Version::parse(remote_ver),
            ) {
                (Ok(curr), Ok(rem)) => curr > rem,
                _ => remote_ver != &current_version,
            }
        } else {
            false
        };

        Ok(UpdateCheckResult {
            update_available: false,
            rid: None,
            current_version,
            version: latest_remote_version.clone(),
            date: remote_manifest.as_ref().and_then(|m| m.pub_date.clone()),
            body: remote_manifest.as_ref().and_then(|m| m.notes.clone()),
            raw_json: None,
            latest_remote_version,
            is_current_higher,
            channel: norm_channel,
            endpoint_used: endpoint_url,
            error_message: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_resolve_channel_endpoints() {
        let (stable_url, tag) = resolve_channel_endpoint("stable").await;
        assert_eq!(stable_url, STABLE_ENDPOINT);
        assert!(tag.is_none());

        let (nightly_url, nightly_tag) = resolve_channel_endpoint("beta").await;
        assert!(nightly_url.contains("latest-nightly.json"));
        assert!(nightly_tag.is_some());
    }

    #[tokio::test]
    async fn test_nightly_manifest_and_minisign_signature() {
        let (nightly_url, _) = resolve_channel_endpoint("beta").await;
        let client = reqwest::Client::builder()
            .user_agent("NEXUS-Test")
            .build()
            .unwrap();

        let resp = client.get(&nightly_url).send().await.unwrap();
        assert!(resp.status().is_success(), "Failed to download nightly manifest: status {}", resp.status());

        let body: serde_json::Value = resp.json().await.unwrap();
        let version = body["version"].as_str().unwrap();
        assert!(version.starts_with("0.1.9-nightly"));

        let platform = &body["platforms"]["windows-x86_64"];
        let installer_url = platform["url"].as_str().unwrap();
        assert!(installer_url.ends_with(".exe"));
        assert!(installer_url.contains("0.1.9-nightly"));

        let sig = platform["signature"].as_str().unwrap();
        // Tauri encodes the Minisign signature as Base64 in manifest platforms
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(sig.trim())
            .expect("Signature must be valid Base64");
        let decoded_str = String::from_utf8_lossy(&decoded);
        assert!(
            decoded_str.contains("untrusted comment: signature"),
            "Decoded signature must be in valid Minisign format"
        );
    }

    #[test]
    fn test_semver_downgrade_logic() {
        let current = semver::Version::parse("0.1.9-nightly.1").unwrap();
        let remote_stable = semver::Version::parse("0.1.7").unwrap();
        assert!(current > remote_stable, "Nightly should be recognized as higher than old Stable");
    }
}
