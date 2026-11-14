//! Preserve SPS geometry/timing/HRD while making the SDR sample contract explicit.
//! Some MFTs accept MF color attributes but omit them from the emitted VUI.
#[derive(Debug)]
pub(super) struct InvalidSps;
type Result<T> = std::result::Result<T, InvalidSps>;
struct Bits { data: Vec<bool>, pos: usize }
impl Bits {
    fn read(&mut self, n: usize) -> Result<u32> {
        if n>32 || self.pos+n>self.data.len() {return Err(InvalidSps);}
        let mut value=0;for _ in 0..n {value=(value<<1)|u32::from(self.data[self.pos]);self.pos+=1;} Ok(value)
    }
    fn ue(&mut self) -> Result<u32> {
        let mut zeros=0;while self.read(1)?==0 {zeros+=1;if zeros>30{return Err(InvalidSps);}}
        Ok(((1u32<<zeros)-1)+self.read(zeros)?)
    }
    fn se(&mut self) -> Result<i32> {let v=self.ue()?;Ok(if v&1==1 {((v+1)/2) as i32} else {-((v/2) as i32)})}
}
fn unpack(nal: &[u8]) -> Result<Bits> {
    if nal.first().is_none_or(|v|v&31!=7) || nal.len()>65536 {return Err(InvalidSps);}
    let mut bytes=Vec::new();let mut zeros=0;
    for &v in &nal[1..] {
        if zeros>=2 && v==3 {zeros=0;continue;}
        bytes.push(v);zeros=if v==0 {zeros+1} else {0};
    }
    let mut data=Vec::new();for byte in bytes {for bit in (0..8).rev(){data.push(byte&(1<<bit)!=0);}}
    // Retain the RBSP stop bit; remove alignment padding before splicing.
    let stop=data.iter().rposition(|v|*v).ok_or(InvalidSps)?;data.truncate(stop+1);
    Ok(Bits{data,pos:0})
}
fn add(out:&mut Vec<bool>,value:u32,n:usize){for b in (0..n).rev(){out.push(value&(1<<b)!=0);}}
fn video_signal(out:&mut Vec<bool>){
    add(out,1,1);add(out,5,3);add(out,0,1);add(out,1,1);
    add(out,1,8);add(out,1,8);add(out,1,8); // 709 primaries, transfer, matrix; limited range.
}
pub(super) fn sdr_sps(nal: &[u8]) -> Result<Vec<u8>> {
    let mut bits=unpack(nal)?;
    let profile=bits.read(8)?;bits.read(16)?;bits.ue()?;
    if [100,110,122,244,44,83,86,118,128,138,139,134,135].contains(&profile){
        let chroma=bits.ue()?;if chroma>3{return Err(InvalidSps);}if chroma==3{bits.read(1)?;}
        bits.ue()?;bits.ue()?;bits.read(1)?;
        if bits.read(1)?!=0 {
            for i in 0..if chroma==3{12}else{8} {
                if bits.read(1)?!=0 {
                    let mut last=8i32;let mut next=8i32;
                    for _ in 0..if i<6{16}else{64}{
                        if next!=0 {next=(last+bits.se()?).rem_euclid(256);}
                        if next!=0 {last=next;}
                    }
                }
            }
        }
    } else if ![66,77,88].contains(&profile) {return Err(InvalidSps);}
    bits.ue()?;
    match bits.ue()? {
        0=>{bits.ue()?;},
        1=>{bits.read(1)?;bits.se()?;bits.se()?;let n=bits.ue()?;if n>255{return Err(InvalidSps);}for _ in 0..n{bits.se()?;}},
        2=>{},_=>return Err(InvalidSps)
    }
    bits.ue()?;bits.read(1)?;bits.ue()?;bits.ue()?;
    if bits.read(1)?==0 {bits.read(1)?;}
    bits.read(1)?;
    if bits.read(1)?!=0 {for _ in 0..4{bits.ue()?;}}
    let vui_flag=bits.pos;
    let vui_present=bits.read(1)?!=0;
    let mut out;
    if !vui_present {
        out=bits.data[..vui_flag].to_vec();add(&mut out,1,1);
        add(&mut out,0,1);add(&mut out,0,1);video_signal(&mut out);
        // chroma location, timing, NAL HRD, VCL HRD, pic_struct, restriction absent.
        for _ in 0..6{add(&mut out,0,1);}
        out.extend_from_slice(&bits.data[bits.pos..]);
    } else {
        if bits.read(1)?!=0 {if bits.read(8)?==255 {bits.read(32)?;}}
        if bits.read(1)?!=0 {bits.read(1)?;}
        let start=bits.pos;
        if bits.read(1)?!=0 {bits.read(4)?;if bits.read(1)?!=0 {bits.read(24)?;}}
        out=bits.data[..start].to_vec();video_signal(&mut out);
        out.extend_from_slice(&bits.data[bits.pos..]);
    }
    while out.len()%8!=0{out.push(false);}
    let mut encoded=vec![nal[0]];let mut zeros=0;
    for chunk in out.chunks(8){
        let mut byte=0u8;for bit in chunk {byte=(byte<<1)|u8::from(*bit);}
        if zeros>=2 && byte<=3{encoded.push(3);zeros=0;}
        encoded.push(byte);zeros=if byte==0{zeros+1}else{0};
    }
    Ok(encoded)
}
pub(super) fn sdr_annex_b(raw: Vec<u8>) -> Result<Vec<u8>> {
    let nalus=super::split_annex_b_nalus(&raw);
    if !nalus.iter().any(|n|n.first().is_some_and(|v|v&31==7)){return Ok(raw);}
    let mut out=Vec::with_capacity(raw.len()+16);
    for nalu in nalus {
        out.extend_from_slice(&[0,0,0,1]);
        if nalu[0]&31==7 {out.extend_from_slice(&sdr_sps(nalu)?);} else {out.extend_from_slice(nalu);}
    }
    Ok(out)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn malformed_sps_fails_without_panics(){
        for bytes in [&[][..],&[0x67][..],&[0x67,0xff,0xff][..]]{assert!(sdr_sps(bytes).is_err());}
        for n in 0..96 {let bytes=vec![0x67;n];let _=sdr_sps(&bytes);}
    }
    #[test] fn actual_amd_and_microsoft_sps_are_supported_and_idempotent(){
        // Public synthetic chart output, not captured user content.
        for fixture in ["67420420d9405005bbff000100014202020280000003008000003c47844232c0",
                        "6742c02095a014016ec044000003000400000301e03682211a80",
                        "6742c02095a014016e40"] {
            let original=hex::decode(fixture).unwrap();let corrected=sdr_sps(&original).unwrap();
            assert_eq!(sdr_sps(&corrected).unwrap(),corrected);
            assert_eq!(corrected[0],original[0]);
            // The profile/constraints/level bits precede VUI and stay intact.
            assert_eq!(&unpack(&original).unwrap().data[..24],&unpack(&corrected).unwrap().data[..24]);
            let mut packet=vec![0,0,0,1];packet.extend_from_slice(&original);
            packet.extend_from_slice(&[0,0,0,1,0x68,0xce,0x3c,0x80,0,0,0,1,0x65,0x88,0x84]);
            let rewritten=sdr_annex_b(packet).unwrap();
            let nalus=super::super::split_annex_b_nalus(&rewritten);
            assert_eq!(nalus[1],&[0x68,0xce,0x3c,0x80]);assert_eq!(nalus[2],&[0x65,0x88,0x84]);
        }
    }
    #[test] fn non_sps_nalus_remain_byte_identical(){
        let nal=vec![0,0,0,1,0x65,0x88,0x84];assert_eq!(sdr_annex_b(nal.clone()).unwrap(),nal);
    }
}
