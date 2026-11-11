use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

static IS_CHECKING: AtomicBool = AtomicBool::new(false);
static IS_DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CACHED_UPDATE: StdMutex<Option<tauri_plugin_updater::Update>> = StdMutex::new(None);

pub struct CheckingGuard;
impl CheckingGuard {
    pub fn try_acquire() -> Result<Self, String> {
        if IS_CHECKING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Ok(Self)
        } else {
            Err("Operação de verificação de atualização já em andamento.".to_string())
        }
    }
}
impl Drop for CheckingGuard {
    fn drop(&mut self) {
        IS_CHECKING.store(false, Ordering::SeqCst);
    }
}

pub struct DownloadingGuard;
impl DownloadingGuard {
    pub fn try_acquire() -> Result<Self, String> {
        if IS_DOWNLOADING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Ok(Self)
        } else {
            Err("Operação de download ou instalação de atualização já em andamento.".to_string())
        }
    }
}
impl Drop for DownloadingGuard {
    fn drop(&mut self) {
        IS_DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterProgressPayload {
    pub status: String,
    pub chunk_length: usize,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: f64,
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
    concat!("https://github.com/Sinisterzs/NEXUS/releases/download/v", env!("CARGO_PKG_VERSION"), "/latest-nightly.json");

/// Infere o canal padrão baseado na versão compilada atual (ex: nightly -> beta, sem sufixo -> stable)
pub fn detect_default_channel() -> String {
    let current_version = env!("CARGO_PKG_VERSION");
    if let Ok(ver) = semver::Version::parse(current_version) {
        if !ver.pre.is_empty() {
            return "beta".to_string();
        }
    }
    if current_version.contains('-') || current_version.to_lowercase().contains("nightly") {
        return "beta".to_string();
    }
    "stable".to_string()
}

/// Normaliza o canal informado pelo frontend ou utiliza o canal padrão do executável
pub fn normalize_channel(channel: Option<String>) -> String {
    match channel {
        Some(ref ch) if ch.trim().is_empty() => detect_default_channel(),
        Some(ref ch) if ch.eq_ignore_ascii_case("beta") || ch.eq_ignore_ascii_case("nightly") => {
            "beta".to_string()
        }
        Some(_) => "stable".to_string(),
        None => detect_default_channel(),
    }
}

/// Verifica se a versão remota configura um downgrade em relação à versão instalada
pub fn is_downgrade(current: &str, remote: &str) -> Result<bool, String> {
    let curr = semver::Version::parse(current)
        .map_err(|e| format!("Versão atual inválida ({}): {}", current, e))?;
    let rem = semver::Version::parse(remote)
        .map_err(|e| format!("Versão remota inválida ({}): {}", remote, e))?;
    Ok(curr >= rem)
}

/// Resolve o endpoint do manifesto para o canal especificado
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
            Some(format!("v{}", env!("CARGO_PKG_VERSION"))),
        )
    } else {
        (STABLE_ENDPOINT.to_string(), None)
    }
}

/// Execução interna da checagem com controle de concorrência e retorno de Update nativo
async fn check_internal<R: Runtime>(
    webview: &Webview<R>,
    channel_opt: Option<String>,
) -> Result<(UpdateCheckResult, Option<tauri_plugin_updater::Update>), String> {
    let _guard = CheckingGuard::try_acquire()?;

    if crate::lab::enabled() {
        return Err("Updater desabilitado no laboratório".into());
    }

    let app = webview.app_handle();
    let current_version = app.package_info().version.to_string();
    let norm_channel = normalize_channel(channel_opt);

    let (endpoint_url, _resolved_tag) = resolve_channel_endpoint(&norm_channel).await;

    let target_url = Url::parse(&endpoint_url)
        .map_err(|e| format!("URL do manifesto inválida ({}): {}", endpoint_url, e))?;

    // Consulta independente do manifesto remoto para capturar notas e versão caso current >= remote
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

    // Native Tauri 2 updater builder com endpoint dinâmico
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

        // Regra de segurança: Canal estável NUNCA baixa compilações pré-lançamento/nightly
        if norm_channel == "stable" {
            if let Ok(ver) = semver::Version::parse(&update_version) {
                if !ver.pre.is_empty() {
                    let mut cached = CACHED_UPDATE.lock().unwrap();
                    *cached = None;

                    return Ok((
                        UpdateCheckResult {
                            update_available: false,
                            rid: None,
                            current_version: current_version.clone(),
                            version: Some(update_version.clone()),
                            date: remote_manifest.as_ref().and_then(|m| m.pub_date.clone()),
                            body: remote_manifest.as_ref().and_then(|m| m.notes.clone()),
                            raw_json: None,
                            latest_remote_version: Some(update_version),
                            is_current_higher: false,
                            channel: norm_channel,
                            endpoint_used: endpoint_url,
                            error_message: Some("Canal Estável não instala versões experimentais/pré-lançamento.".into()),
                        },
                        None,
                    ));
                }
            }
        }

        // Validação de segurança adicional: bloqueio estrito de downgrade
        if is_downgrade(&current_version, &update_version).unwrap_or(false) {
            let mut cached = CACHED_UPDATE.lock().unwrap();
            *cached = None;

            return Ok((
                UpdateCheckResult {
                    update_available: false,
                    rid: None,
                    current_version: current_version.clone(),
                    version: Some(update_version.clone()),
                    date: remote_manifest.as_ref().and_then(|m| m.pub_date.clone()),
                    body: remote_manifest.as_ref().and_then(|m| m.notes.clone()),
                    raw_json: None,
                    latest_remote_version: Some(update_version),
                    is_current_higher: true,
                    channel: norm_channel,
                    endpoint_used: endpoint_url,
                    error_message: None,
                },
                None,
            ));
        }

        let update_body = update.body.clone();
        let raw_json = update.raw_json.clone();
        let date_str = raw_json
            .get("pub_date")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Cacheia na tabela de recursos da Webview e no cache estático interno
        let rid = webview.resources_table().add(update.clone());

        {
            let mut cached = CACHED_UPDATE.lock().unwrap();
            *cached = Some(update.clone());
        }

        Ok((
            UpdateCheckResult {
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
            },
            Some(update),
        ))
    } else {
        // Nenhuma atualização oferecida pelo Tauri (current >= remote)
        {
            let mut cached = CACHED_UPDATE.lock().unwrap();
            *cached = None;
        }

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

        Ok((
            UpdateCheckResult {
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
            },
            None,
        ))
    }
}

/// Comando IPC para verificação pré-login sem exigir autenticação, JWT ou backend
#[tauri::command]
pub async fn updater_check_prelogin<R: Runtime>(
    webview: Webview<R>,
    channel: Option<String>,
) -> Result<UpdateCheckResult, String> {
    let (res, _) = check_internal(&webview, channel).await?;
    Ok(res)
}

/// Compatibilidade retroativa com updater_check_channel
#[tauri::command]
pub async fn updater_check_channel<R: Runtime>(
    webview: Webview<R>,
    channel: String,
) -> Result<UpdateCheckResult, String> {
    updater_check_prelogin(webview, Some(channel)).await
}

/// Comando IPC para download e aplicação de atualização com emissão de progresso
#[tauri::command]
pub async fn updater_download_and_install_prelogin<R: Runtime>(
    webview: Webview<R>,
    channel: Option<String>,
) -> Result<(), String> {
    let _download_guard = DownloadingGuard::try_acquire()?;

    // Recupera atualização em cache ou executa checagem se ainda não houver
    let update_opt = {
        let mut cached = CACHED_UPDATE.lock().unwrap();
        cached.take()
    };

    let update = match update_opt {
        Some(u) => u,
        None => {
            let (_, u_opt) = check_internal(&webview, channel).await?;
            u_opt.ok_or_else(|| "Nenhuma atualização disponível para download.".to_string())?
        }
    };

    // Validação de segurança anti-downgrade
    if is_downgrade(&update.current_version, &update.version).unwrap_or(false) {
        return Err(format!(
            "Downgrade bloqueado por segurança: versão remota ({}) não é superior à versão atual ({}).",
            update.version, update.current_version
        ));
    }

    // Em ambiente de testes, simula progresso sem executar instalador ou encerrar processo
    if crate::is_test_environment() {
        let app = webview.app_handle().clone();
        let p_start = UpdaterProgressPayload {
            status: "started".into(),
            chunk_length: 0,
            downloaded: 0,
            total: Some(1024),
            downloaded_bytes: 0,
            total_bytes: Some(1024),
            percent: 0.0,
        };
        let _ = app.emit("updater-progress", &p_start);
        let _ = app.emit("updater://progress", &p_start);

        let p_done = UpdaterProgressPayload {
            status: "finished".into(),
            chunk_length: 1024,
            downloaded: 1024,
            total: Some(1024),
            downloaded_bytes: 1024,
            total_bytes: Some(1024),
            percent: 100.0,
        };
        let _ = app.emit("updater-progress", &p_done);
        let _ = app.emit("updater://progress", &p_done);
        return Ok(());
    }

    let app = webview.app_handle().clone();
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let total_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let has_total = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let first_chunk = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));

    let dl_chunk = std::sync::Arc::clone(&downloaded);
    let tot_chunk = std::sync::Arc::clone(&total_bytes);
    let has_tot_chunk = std::sync::Arc::clone(&has_total);
    let first_chunk_flag = std::sync::Arc::clone(&first_chunk);
    let app_chunk = app.clone();

    let dl_finish = std::sync::Arc::clone(&downloaded);
    let tot_finish = std::sync::Arc::clone(&total_bytes);
    let has_tot_finish = std::sync::Arc::clone(&has_total);
    let app_finish = app.clone();

    update
        .download_and_install(
            move |chunk_length, content_len| {
                if first_chunk_flag.swap(false, Ordering::SeqCst) {
                    if let Some(cl) = content_len {
                        tot_chunk.store(cl, Ordering::SeqCst);
                        has_tot_chunk.store(true, Ordering::SeqCst);
                    }
                    let payload = UpdaterProgressPayload {
                        status: "started".into(),
                        chunk_length,
                        downloaded: 0,
                        total: content_len,
                        downloaded_bytes: 0,
                        total_bytes: content_len,
                        percent: 0.0,
                    };
                    let _ = app_chunk.emit("updater-progress", &payload);
                    let _ = app_chunk.emit("updater://progress", &payload);
                }

                let current_dl = dl_chunk.fetch_add(chunk_length as u64, Ordering::SeqCst) + chunk_length as u64;
                let tot_opt = if has_tot_chunk.load(Ordering::SeqCst) {
                    Some(tot_chunk.load(Ordering::SeqCst))
                } else {
                    None
                };

                let percent = if let Some(tot) = tot_opt {
                    if tot > 0 {
                        ((current_dl as f64 / tot as f64) * 100.0).min(100.0)
                    } else {
                        0.0
                    }
                } else {
                    0.0
                };

                let payload = UpdaterProgressPayload {
                    status: "progress".into(),
                    chunk_length,
                    downloaded: current_dl,
                    total: tot_opt,
                    downloaded_bytes: current_dl,
                    total_bytes: tot_opt,
                    percent,
                };
                let _ = app_chunk.emit("updater-progress", &payload);
                let _ = app_chunk.emit("updater://progress", &payload);
            },
            move || {
                let final_dl = dl_finish.load(Ordering::SeqCst);
                let tot_opt = if has_tot_finish.load(Ordering::SeqCst) {
                    Some(tot_finish.load(Ordering::SeqCst))
                } else {
                    None
                };

                let payload = UpdaterProgressPayload {
                    status: "finished".into(),
                    chunk_length: 0,
                    downloaded: final_dl,
                    total: tot_opt,
                    downloaded_bytes: final_dl,
                    total_bytes: tot_opt,
                    percent: 100.0,
                };
                let _ = app_finish.emit("updater-progress", &payload);
                let _ = app_finish.emit("updater://progress", &payload);
            },
        )
        .await
        .map_err(|e| format!("Falha ao baixar e aplicar atualização: {}", e))?;

    Ok(())
}

/// Comando IPC para reinício seguro da aplicação após atualização
#[tauri::command]
pub async fn updater_restart<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    if crate::is_test_environment() {
        return Ok(());
    }
    webview.app_handle().restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nightly_fallback_uses_build_version() {
        assert!(super::NIGHTLY_FALLBACK_ENDPOINT.contains(&format!("/v{}/", env!("CARGO_PKG_VERSION"))));
        assert!(super::STABLE_ENDPOINT.ends_with("/releases/latest/download/latest.json"));
    }

    #[test]
    fn test_default_channel_detection() {
        let default_ch = detect_default_channel();
        let pkg_version = env!("CARGO_PKG_VERSION");
        if pkg_version.contains('-') {
            assert_eq!(default_ch, "beta");
        } else {
            assert_eq!(default_ch, "stable");
        }

        assert_eq!(normalize_channel(None), default_ch);
        assert_eq!(normalize_channel(Some("".into())), default_ch);
        assert_eq!(normalize_channel(Some("   ".into())), default_ch);
        assert_eq!(normalize_channel(Some("beta".into())), "beta");
        assert_eq!(normalize_channel(Some("nightly".into())), "beta");
        assert_eq!(normalize_channel(Some("BETA".into())), "beta");
        assert_eq!(normalize_channel(Some("NIGHTLY".into())), "beta");
        assert_eq!(normalize_channel(Some("stable".into())), "stable");
        assert_eq!(normalize_channel(Some("STABLE".into())), "stable");
        assert_eq!(normalize_channel(Some("custom".into())), "stable");
    }

    #[test]
    fn test_is_downgrade_logic() {
        // Upgrade scenarios (is_downgrade returns Ok(false))
        assert!(!is_downgrade("0.2.0", "0.2.1").unwrap());
        assert!(!is_downgrade("0.2.1", "0.3.0").unwrap());
        assert!(!is_downgrade("0.3.0-nightly.1", "0.3.0-nightly.2").unwrap());

        // Downgrade scenarios (is_downgrade returns Ok(true))
        assert!(is_downgrade("0.2.1", "0.2.0").unwrap());
        assert!(is_downgrade("0.3.0-nightly.2", "0.2.1").unwrap());
        assert!(is_downgrade("0.3.0-nightly.2", "0.3.0-nightly.1").unwrap());

        // Same version is treated as downgrade (no new version to install)
        assert!(is_downgrade("0.2.1", "0.2.1").unwrap());
        assert!(is_downgrade("0.3.0-nightly.2", "0.3.0-nightly.2").unwrap());

        // Invalid version strings return Err
        assert!(is_downgrade("invalid", "0.2.1").is_err());
        assert!(is_downgrade("0.2.1", "invalid").is_err());
    }

    #[test]
    fn test_stable_channel_rejects_prerelease() {
        let stable_target = semver::Version::parse("0.2.2").unwrap();
        assert!(stable_target.pre.is_empty(), "Stable version should have empty pre-release");

        let nightly_target = semver::Version::parse("0.3.0-nightly.3").unwrap();
        assert!(!nightly_target.pre.is_empty(), "Nightly version must have non-empty pre-release");

        let beta_target = semver::Version::parse("0.3.0-beta.1").unwrap();
        assert!(!beta_target.pre.is_empty(), "Beta version must have non-empty pre-release");
    }

    #[test]
    fn test_concurrency_guards() {
        // Test CheckingGuard
        {
            let guard1 = CheckingGuard::try_acquire();
            assert!(guard1.is_ok(), "First acquire should succeed");
            let guard2 = CheckingGuard::try_acquire();
            assert!(guard2.is_err(), "Second concurrent acquire should fail");
        }
        // After guard1 is dropped, acquire should succeed again
        let guard3 = CheckingGuard::try_acquire();
        assert!(guard3.is_ok(), "Acquire after drop should succeed");
        drop(guard3);

        // Test DownloadingGuard
        {
            let dguard1 = DownloadingGuard::try_acquire();
            assert!(dguard1.is_ok(), "First acquire of downloading should succeed");
            let dguard2 = DownloadingGuard::try_acquire();
            assert!(dguard2.is_err(), "Second concurrent downloading should fail");
        }
        let dguard3 = DownloadingGuard::try_acquire();
        assert!(dguard3.is_ok(), "Acquire after drop should succeed");
        drop(dguard3);
    }

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
        assert!(version.contains("-nightly"), "Nightly manifest version should contain -nightly, got: {}", version);

        let platform = &body["platforms"]["windows-x86_64"];
        let installer_url = platform["url"].as_str().unwrap();
        assert!(installer_url.ends_with(".exe"));
        assert!(installer_url.contains("-nightly"));

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
        // 1. Versão experimental / nightly com núcleo SemVer maior é superior à Stable antiga
        let v021_stable = semver::Version::parse("0.2.1").unwrap();
        let v030_homolog1 = semver::Version::parse("0.3.0-homolog.1").unwrap();
        let v030_nightly1 = semver::Version::parse("0.3.0-nightly.1").unwrap();
        let v030_nightly2 = semver::Version::parse("0.3.0-nightly.2").unwrap();
        let v030_stable = semver::Version::parse("0.3.0").unwrap();

        assert!(v030_homolog1 > v021_stable, "Experimental 0.3.0-homolog.1 deve ser superior à Stable 0.2.1 antiga");
        assert!(v030_nightly1 > v021_stable, "Nightly 0.3.0-nightly.1 deve ser superior à Stable 0.2.1 antiga");
        assert!(is_downgrade("0.3.0-homolog.1", "0.2.1").unwrap(), "Instalação homolog não deve aceitar downgrade para Stable 0.2.1");
        assert!(is_downgrade("0.3.0-nightly.2", "0.2.1").unwrap(), "Instalação nightly não deve aceitar downgrade para Stable 0.2.1");

        // 2. Nightly mais recente é superior à Nightly anterior
        assert!(v030_nightly2 > v030_nightly1, "0.3.0-nightly.2 deve ser superior a 0.3.0-nightly.1");
        assert!(!is_downgrade("0.3.0-nightly.1", "0.3.0-nightly.2").unwrap(), "0.3.0-nightly.2 é upgrade válido a partir de nightly.1");
        assert!(is_downgrade("0.3.0-nightly.2", "0.3.0-nightly.1").unwrap(), "0.3.0-nightly.1 é downgrade a partir de nightly.2");

        // 3. Ordenação SemVer de identificadores pré-lançamento (ordem ASCII: 'homolog' < 'nightly')
        assert!(v030_nightly1 > v030_homolog1, "Pela especificação SemVer, pre-release 'nightly' tem precedência lexicográfica sobre 'homolog'");
        let v030_homolog2 = semver::Version::parse("0.3.0-homolog.2").unwrap();
        assert!(v030_homolog2 > v030_homolog1, "0.3.0-homolog.2 deve ser superior a 0.3.0-homolog.1");

        // 4. Versões inferiores são classificadas como downgrade
        assert!(is_downgrade("0.3.0", "0.2.1").unwrap());
        assert!(is_downgrade("0.2.1", "0.2.0").unwrap());

        // 5. Versões equivalentes não são classificadas como upgrade (curr >= rem -> true)
        assert!(is_downgrade("0.3.0-homolog.1", "0.3.0-homolog.1").unwrap(), "Versões idênticas são tratadas como sem nova atualização");
        assert!(is_downgrade("0.3.0-nightly.2", "0.3.0-nightly.2").unwrap());
        assert!(is_downgrade("0.3.0", "0.3.0").unwrap());

        // 6. Stable final (sem pre-release) é superior às pré-releases da mesma versão
        assert!(v030_stable > v030_nightly2, "Stable 0.3.0 final deve ser superior a 0.3.0-nightly.2");
        assert!(v030_stable > v030_homolog1, "Stable 0.3.0 final deve ser superior a 0.3.0-homolog.1");
        assert!(!is_downgrade("0.3.0-nightly.2", "0.3.0").unwrap(), "Stable final 0.3.0 é upgrade válido sobre 0.3.0-nightly.2");
        assert!(!is_downgrade("0.3.0-homolog.1", "0.3.0").unwrap(), "Stable final 0.3.0 é upgrade válido sobre 0.3.0-homolog.1");
        assert!(is_downgrade("0.3.0", "0.3.0-nightly.2").unwrap(), "0.3.0-nightly.2 é downgrade em relação a 0.3.0 final");
    }
}
