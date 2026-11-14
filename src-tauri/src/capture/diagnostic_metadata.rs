//! Read-only bounded SPS metadata. Never modifies encoded data or returns NAL contents.
use serde_json::{json, Value};
pub fn capture_backend(value:&str)->&'static str {
    match value {"DxgiMonitor"=>"dxgi","WgcMonitor"|"WgcWindow"=>"wgc",_=>"unavailable"}
}
struct Bits {
    data: Vec<u8>,
    bit: usize,
}
impl Bits {
    fn read(&mut self, n: usize) -> Option<u32> {
        if n > 32 || self.bit + n > self.data.len() * 8 {
            return None;
        }
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | u32::from((self.data[self.bit / 8] >> (7 - self.bit % 8)) & 1);
            self.bit += 1;
        }
        Some(v)
    }
    fn ue(&mut self) -> Option<u32> {
        let mut z = 0;
        while self.read(1)? == 0 {
            z += 1;
            if z > 24 {
                return None;
            }
        }
        Some((1 << z) - 1 + self.read(z)?)
    }
    fn se(&mut self) -> Option<i32> {
        let v = self.ue()?;
        Some(if v % 2 == 0 {
            -(v as i32 / 2)
        } else {
            (v as i32 + 1) / 2
        })
    }
}
pub fn sps(nal: &[u8]) -> Option<Value> {
    if nal.is_empty() || nal[0] & 31 != 7 || nal.len() > 4096 {
        return None;
    }
    let mut data = Vec::new();
    let mut zeros = 0;
    for &v in &nal[1..] {
        if zeros >= 2 && v == 3 {
            zeros = 0;
            continue;
        }
        data.push(v);
        zeros = if v == 0 { zeros + 1 } else { 0 };
    }
    let mut b = Bits { data, bit: 0 };
    let profile = b.read(8)?;
    b.read(16)?;
    b.ue()?;
    if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(&profile) {
        let chroma = b.ue()?;
        if chroma > 3 {
            return None;
        }
        if chroma == 3 {
            b.read(1)?;
        }
        b.ue()?;
        b.ue()?;
        b.read(1)?;
        if b.read(1)? != 0 {
            for i in 0..if chroma == 3 { 12 } else { 8 } {
                if b.read(1)? != 0 {
                    let mut last = 8;
                    let mut next = 8;
                    for _ in 0..if i < 6 { 16 } else { 64 } {
                        if next != 0 {
                            next = (last + b.se()?).rem_euclid(256);
                        }
                        if next != 0 {
                            last = next;
                        }
                    }
                }
            }
        }
    } else if ![66, 77, 88].contains(&profile) {
        return None;
    }
    b.ue()?;
    match b.ue()? {
        0 => {
            b.ue()?;
        }
        1 => {
            b.read(1)?;
            b.se()?;
            b.se()?;
            let n = b.ue()?;
            if n > 255 {
                return None;
            }
            for _ in 0..n {
                b.se()?;
            }
        }
        2 => {}
        _ => return None,
    }
    b.ue()?;
    b.read(1)?;
    b.ue()?;
    b.ue()?;
    if b.read(1)? == 0 {
        b.read(1)?;
    }
    b.read(1)?;
    if b.read(1)? != 0 {
        for _ in 0..4 {
            b.ue()?;
        }
    }
    let mut out =
        json!({"profile":profile,"fullRange":null,"primaries":null,"transfer":null,"matrix":null});
    if b.read(1)? == 0 {
        return Some(out);
    }
    if b.read(1)? != 0 && b.read(8)? == 255 {
        b.read(32)?;
    }
    if b.read(1)? != 0 {
        b.read(1)?;
    }
    if b.read(1)? != 0 {
        b.read(3)?;
        out["fullRange"] = json!(b.read(1)? != 0);
        if b.read(1)? != 0 {
            out["primaries"] = json!(b.read(8)?);
            out["transfer"] = json!(b.read(8)?);
            out["matrix"] = json!(b.read(8)?);
        }
    }
    Some(out)
}
pub fn annex_b(bytes: &[u8]) -> Option<Value> {
    // Inspect only parameter-set prefix, bounded independently of frame dimensions.
    let bytes = &bytes[..bytes.len().min(65536)];
    let mut start = None;
    for i in 0..bytes.len().saturating_sub(3) {
        if bytes[i..].starts_with(&[0, 0, 1]) {
            let n = i + 3;
            if start.is_some() {
                return sps(&bytes[start?..i]);
            }
            if bytes.get(n).is_some_and(|b| b & 31 == 7) {
                start = Some(n);
            }
        }
    }
    start.and_then(|n| sps(&bytes[n..]))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_backend_categories_match_real_runtime_labels(){
        assert_eq!(capture_backend("DxgiMonitor"),"dxgi");assert_eq!(capture_backend("WgcMonitor"),"wgc");assert_eq!(capture_backend("WgcWindow"),"wgc");assert_eq!(capture_backend("PRIVATE_WINDOW"),"unavailable");
    }
    #[test]
    fn malformed_metadata_is_unavailable() {
        for bytes in [vec![], vec![0x67], vec![0x67; 5000], vec![0, 0, 1, 0x65, 1]] {
            assert!(annex_b(&bytes).is_none());
        }
        assert!(sps(&[0x65, 1, 2]).is_none());
    }
    #[test]
    fn reads_existing_synthetic_nvidia_fixture_without_rewriting_it() {
        let bytes = include_bytes!("../../../tests/fixtures/color/nvidia-4060ti-legacy.h264");
        let value = annex_b(bytes).expect("fixture contains a valid SPS");
        assert_eq!(value["matrix"], 1);
        assert_eq!(value["primaries"], 1);
        assert_eq!(value["fullRange"], false);
        assert!(value.to_string().len() < 160);
    }
}
