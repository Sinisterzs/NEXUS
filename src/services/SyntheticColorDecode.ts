export const SYNTHETIC_RGB = [
  [0,0,0],[16,16,16],[32,32,32],[64,64,64],[128,128,128],[192,192,192],[235,235,235],[255,255,255],
  [255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255],[192,128,96],[128,80,64],
  [32,64,96],[64,128,192],[96,160,96],[224,192,160],[192,64,64],[64,192,64],[64,64,192],[200,160,120]
];
// Only accepts output from diagnostics_synthetic, which generates the chart internally.
// Never call with screen video, remote streams, DOM screenshots or user-provided buffers.
export async function decodeSyntheticChart(result:{synthetic_access_unit?:string;synthetic_codec?:string;reference_rgb?:number[][]},cancelled:()=>boolean) {
  const started=performance.now();
  const Decoder=(globalThis as any).VideoDecoder,Chunk=(globalThis as any).EncodedVideoChunk;
  if(result.reference_rgb?.some((color,index)=>color.length!==3||color.some((v,c)=>v!==SYNTHETIC_RGB[index]?.[c])))return null;
  if(!Decoder || !Chunk || !result.synthetic_access_unit || !/^avc1\.[0-9A-F]{6}$/.test(result.synthetic_codec??'') || result.reference_rgb?.length!==24)return null;
  const bytes=Uint8Array.from(atob(result.synthetic_access_unit),c=>c.charCodeAt(0));
  if(bytes.length>2*1024*1024)return null;
  let frame:any=null,error=false;
  const decoder=new Decoder({output:(value:any)=>{if(frame)frame.close();frame=value;},error:()=>{error=true;}});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
    decoder.configure({codec:result.synthetic_codec,optimizeForLatency:true});
    decoder.decode(new Chunk({type:'key',timestamp:0,data:bytes}));
    await Promise.race([decoder.flush(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('synthetic_decode_timeout')),5000);})]);
    if(cancelled() || error || !frame || frame.displayWidth!==1280 || frame.displayHeight!==720)return null;
    const canvas=new OffscreenCanvas(1280,720),context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)return null;context.drawImage(frame,0,0);
    const pixels=context.getImageData(0,0,1280,720).data;
    const patches=[];let total=0,maximum=0;
    for(let index=0;index<24;index++){
      const expected=result.reference_rgb[index],sum=[0,0,0];let max=0,absolute=0;
      if(expected.length!==3 || expected.some(v=>!Number.isInteger(v)||v<0||v>255))return null;
      for(let y=Math.floor(index/8)*160+40;y<Math.floor(index/8)*160+120;y++)for(let x=index%8*160+40;x<index%8*160+120;x++)for(let c=0;c<3;c++){
        const value=pixels[(y*1280+x)*4+c];sum[c]+=value;const delta=Math.abs(value-expected[c]);absolute+=delta;max=Math.max(max,delta);
      }
      const mae=absolute/(80*80*3);total+=mae;maximum=Math.max(maximum,max);
      patches.push({index,expected,measured:sum.map(v=>v/(80*80)),mae,maximum:max});
    }
    return {metrics:{stage:'decoding',result:'measured',pixelFormat:'rgba8',decoderInput:'h264',decoderOutput:'unavailable',
      renderer:'synthetic_canvas',syntheticOnly:true,physicalDisplayMeasured:false,mae:total/24,maximum,
      durationMs:Math.max(0,performance.now()-started),framesDecoded:1,width:1280,height:720,fullRange:typeof frame.colorSpace?.fullRange==='boolean'?frame.colorSpace.fullRange:null},patches};
  }catch{return null;}finally{if(timeout)clearTimeout(timeout);frame?.close();try{decoder.close();}catch{}}
}
