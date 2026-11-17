use image::{ImageBuffer, ImageFormat, Rgba};
use nexus_server::services::LocalVolumeAvatarStorage;
use std::io::Cursor;

#[tokio::test]
async fn test_avatar_storage_decode_normalize_and_reject_invalid() {
    let temp_dir = std::env::temp_dir().join(format!("nexus_avatar_test_{}", uuid::Uuid::new_v4()));
    let storage = LocalVolumeAvatarStorage::new(temp_dir.clone());

    // 1. Valid 600x600 PNG -> normalized to <= 512x512
    let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(600, 600, Rgba([255, 0, 0, 255]));
    let mut buf = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, ImageFormat::Png)
        .unwrap();

    let (filename, _) = storage.store_avatar(&buf.into_inner()).await.unwrap();
    let (stored_bytes, ct) = storage.read_avatar(&filename).await.unwrap();
    assert_eq!(ct, "image/png");

    let decoded = image::load_from_memory(&stored_bytes).unwrap();
    assert!(decoded.width() <= 512 && decoded.height() <= 512);

    // 2. Malformed / fake PNG header -> rejected
    let fake_png = b"\x89PNG\r\n\x1a\nnot_a_real_image";
    assert!(storage.store_avatar(fake_png).await.is_err());

    // 3. Path traversal -> rejected
    assert!(storage.read_avatar("../secret.png").await.is_err());

    // 4. Delete by URL
    storage.delete_by_url(&format!("/v1/avatars/{filename}")).await;
    assert!(storage.read_avatar(&filename).await.is_err());

    let _ = std::fs::remove_dir_all(&temp_dir);
}
