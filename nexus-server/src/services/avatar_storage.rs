use std::io::Cursor;
use std::path::{Path, PathBuf};
use image::imageops::FilterType;
use image::{ImageFormat, ImageReader, Limits};
use uuid::Uuid;

use crate::errors::AppError;

pub const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024; // 2 MB
pub const MAX_SOURCE_DIMENSION: u32 = 4096;
pub const MAX_NORMALIZED_DIMENSION: u32 = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarFormat {
    Png,
    Jpeg,
    Webp,
}

impl AvatarFormat {
    pub fn ext(&self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }

    pub fn detect_from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
            return Some(Self::Png);
        }
        if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
            return Some(Self::Jpeg);
        }
        if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            return Some(Self::Webp);
        }
        None
    }
}

#[derive(Clone)]
pub struct LocalVolumeAvatarStorage {
    base_dir: PathBuf,
}

impl LocalVolumeAvatarStorage {
    pub fn from_env() -> Self {
        let dir = std::env::var("NEXUS_AVATAR_STORAGE_DIR")
            .unwrap_or_else(|_| "./data/avatars".to_string());
        Self::new(PathBuf::from(dir))
    }

    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub async fn store_avatar(&self, bytes: &[u8]) -> Result<(String, AvatarFormat), AppError> {
        if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES {
            return Err(AppError::ValidationError(
                "Avatar deve ter entre 1 byte e 2 MB.".to_string(),
            ));
        }

        let detected = AvatarFormat::detect_from_bytes(bytes).ok_or_else(|| {
            AppError::ValidationError("Formato inválido. Use PNG, JPEG ou WebP.".to_string())
        })?;

        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_SOURCE_DIMENSION);
        limits.max_image_height = Some(MAX_SOURCE_DIMENSION);
        limits.max_alloc = Some(64 * 1024 * 1024);

        let mut reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|_| AppError::ValidationError("Imagem malformada.".to_string()))?;
        reader.limits(limits);

        let img = reader
            .decode()
            .map_err(|_| AppError::ValidationError("Imagem inválida ou dimensões excessivas.".to_string()))?;

        let normalized = if img.width() > MAX_NORMALIZED_DIMENSION || img.height() > MAX_NORMALIZED_DIMENSION {
            img.resize(MAX_NORMALIZED_DIMENSION, MAX_NORMALIZED_DIMENSION, FilterType::Lanczos3)
        } else {
            img
        };

        // Re-encode to clean PNG/JPEG to strip all EXIF/metadata
        let (out_format, target_image_format) = match detected {
            AvatarFormat::Jpeg => (AvatarFormat::Jpeg, ImageFormat::Jpeg),
            AvatarFormat::Png | AvatarFormat::Webp => (AvatarFormat::Png, ImageFormat::Png),
        };

        let mut out_buf = Cursor::new(Vec::new());
        normalized
            .write_to(&mut out_buf, target_image_format)
            .map_err(|_| AppError::InternalError("Falha ao recodificar avatar.".to_string()))?;

        tokio::fs::create_dir_all(&self.base_dir)
            .await
            .map_err(|_| AppError::InternalError("Falha ao preparar armazenamento.".to_string()))?;

        let filename = format!("{}.{}", Uuid::new_v4(), out_format.ext());
        let path = self.base_dir.join(&filename);
        tokio::fs::write(&path, out_buf.into_inner())
            .await
            .map_err(|_| AppError::InternalError("Falha ao gravar avatar.".to_string()))?;

        Ok((filename, out_format))
    }

    pub async fn read_avatar(&self, filename: &str) -> Result<(Vec<u8>, &'static str), AppError> {
        if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
            return Err(AppError::BadRequest("Nome de arquivo inválido.".to_string()));
        }

        let path = self.base_dir.join(filename);
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|_| AppError::NotFound("Avatar não encontrado.".to_string()))?;

        let ct = match Path::new(filename).extension().and_then(|e| e.to_str()) {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            _ => "application/octet-stream",
        };

        Ok((bytes, ct))
    }

    pub async fn delete_by_url(&self, avatar_url: &str) {
        if let Some(filename) = avatar_url.strip_prefix("/v1/avatars/") {
            if !filename.contains('/') && !filename.contains('\\') && !filename.contains("..") {
                let _ = tokio::fs::remove_file(self.base_dir.join(filename)).await;
            }
        }
    }
}
