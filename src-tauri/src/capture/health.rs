use std::time::Duration;

// Cached frames count as progress: a static desktop is not a stalled capturer.
pub fn capture_stalled(without_texture: Duration) -> bool {
    without_texture >= Duration::from_secs(10)
}

// Reject rather than silently upscale a source the hardware may not accept.
pub fn validate_encoder_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width < 64 || height < 64 || width % 2 != 0 || height % 2 != 0 {
        return Err(format!("A fonte de {width}x{height} é pequena demais ou incompatível com NV12/H.264. Aumente a janela (mínimo 64x64). A fonte selecionada não foi alterada."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_tiny_or_odd_without_changing_dimensions() {
        assert!(validate_encoder_dimensions(160, 28).is_err());
        assert!(validate_encoder_dimensions(63, 1080).is_err());
        assert!(validate_encoder_dimensions(641, 480).is_err());
        assert!(validate_encoder_dimensions(64, 64).is_ok());
        assert!(validate_encoder_dimensions(1920, 1080).is_ok());
    }
    #[test]
    fn tolerates_transient_capture_gaps_but_bounds_stall() {
        assert!(!capture_stalled(Duration::from_millis(9999)));
        assert!(capture_stalled(Duration::from_secs(10)));
    }
}
