// One generated H.264 IDR over a dedicated, opt-in, direct-only data channel.
// The ordinary screen/voice PeerConnections never enter this module.
import {diagnosticsService,type DiagnosticContext,DiagnosticsService} from './DiagnosticsService.ts';
import {decodeSyntheticChart,SYNTHETIC_RGB} from './SyntheticColorDecode.ts';
import {assertScreenSdp,assertScreenCandidate,screenIceServers,guardScreenP2P} from './ScreenP2PPolicy.ts';
import {gatewayClient} from './GatewayClient';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function syntheticSdpId(sdp:string):string|null {
  const match=/^a=x-nexus-synthetic:([^\r\n]+)\r?$/m.exec(sdp);return match&&UUID.test(match[1])?match[1]:null;
}
export function isSyntheticCandidate(candidate:any):boolean{return candidate&&Object.hasOwn(candidate,'nexusSyntheticDiagnostic');}
const mark=(sdp:string,id:string)=>sdp.trimEnd()+'\r\na=x-nexus-synthetic:'+id+'\r\n';
const MAX_BYTES=2*1024*1024,CHUNK=16*1024;
type Environment={community:string;channel:string;self:string};
type Session={id:string;peer:string;alias:string;context:DiagnosticContext;epoch:number;cycle:number;started:number;environment:Environment;pc:RTCPeerConnection;
  dc:RTCDataChannel|null;pending:RTCIceCandidateInit[];outgoing:RTCIceCandidateInit[];signaled:boolean;ready:boolean;remoteReady:boolean;
  stopGuard:()=>void;timer:ReturnType<typeof setTimeout>;result:any;header:any;chunks:Uint8Array[];received:number;working:boolean;closed:boolean};
export class SyntheticPeerDiagnostics {
  private cycle=0;
  private pendingOffers=new Map<string,number>();
  private environment:Environment|null=null;
  private sessions=new Map<string,Session>();
  private early=new Map<string,{at:number;candidates:RTCIceCandidateInit[]}>();
  constructor(private diagnostics:DiagnosticsService=diagnosticsService,private loadIce:()=>Promise<RTCIceServer[]>=async()=>{const {invoke}=await import('@tauri-apps/api/core');return invoke<RTCIceServer[]>('webrtc_get_ice_servers');}){this.diagnostics.subscribe(()=>{if(!this.diagnostics.syntheticReady)this.stopAll();});}
  configure(environment:Environment|null){this.stopAll();this.environment=environment;}
  stopAll(){this.cycle++;this.pendingOffers.clear();for(const session of [...this.sessions.values()])this.close(session);this.early.clear();}
  private key(peer:string,id:string){return peer+':'+id;}
  private alive(s:Session){return !s.closed&&s.cycle===this.cycle&&s.epoch===this.diagnostics.consentGeneration&&this.diagnostics.syntheticReady&&this.environment===s.environment;}
  private close(s:Session){if(s.closed)return;s.closed=true;clearTimeout(s.timer);s.stopGuard();if(s.dc){s.dc.onmessage=null;s.dc.onopen=null;s.dc.onclose=null;s.dc.close();}s.pc.onicecandidate=null;s.pc.ondatachannel=null;s.pc.onconnectionstatechange=null;s.pc.close();s.chunks=[];s.pending=[];s.outgoing=[];s.header=null;s.result=null;this.sessions.delete(this.key(s.peer,s.id));}
  private fail(s:Session){if(s.closed)return;const role=s.result?'sender':'receiver';if(this.alive(s))void this.diagnostics.recordPeerSynthetic(s.context,s.id,s.alias,role,{metrics:{stage:'transport',result:'failed',syntheticOnly:true,physicalDisplayMeasured:false},patches:[]},s.epoch,Date.now()-s.started);this.close(s);this.diagnostics.notify('Teste sintético encerrado · conexão, consentimento ou decoder indisponível');}
  async participants(){const context=await this.diagnostics.syntheticContext();return context.peers.filter(p=>p.alias!==context.participant&&p.synthetic_allowed);}
  private async create(peer:string,id:string,context:DiagnosticContext,cycle:number):Promise<Session>{
    const environment=this.environment,epoch=this.diagnostics.consentGeneration;
    if(cycle!==this.cycle||!environment||!this.diagnostics.syntheticReady||this.sessions.size>=2||this.sessions.has(this.key(peer,id)))throw new Error('synthetic_unavailable');
    const remote=context.peers.find(p=>p.user_id===peer&&p.synthetic_allowed);if(!remote)throw new Error('synthetic_remote_consent_required');
    const servers=await this.loadIce();
    if(cycle!==this.cycle||this.environment!==environment||epoch!==this.diagnostics.consentGeneration||!this.diagnostics.syntheticReady||this.sessions.size>=2||this.sessions.has(this.key(peer,id)))throw new Error('synthetic_cancelled');
    const pc=new RTCPeerConnection({iceServers:screenIceServers(servers),iceTransportPolicy:'all',bundlePolicy:'max-bundle'});
    const s:Session={id,peer,alias:remote.alias,context,epoch,cycle,started:Date.now(),environment,pc,dc:null,pending:this.early.get(this.key(peer,id))?.candidates??[],outgoing:[],signaled:false,
      ready:false,remoteReady:false,stopGuard:()=>{},timer:setTimeout(()=>this.fail(s),60000),result:null,header:null,chunks:[],received:0,working:false,closed:false};
    this.early.delete(this.key(peer,id));this.sessions.set(this.key(peer,id),s);
    pc.onicecandidate=event=>{if(!event.candidate||!this.alive(s))return;const candidate=event.candidate.toJSON();
      try{assertScreenCandidate(candidate);}catch{this.fail(s);return;}
      if(s.signaled)this.sendIce(s,candidate);else if(s.outgoing.length<64)s.outgoing.push(candidate);};
    pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed')this.fail(s);};
    s.stopGuard=guardScreenP2P(pc,ready=>{const wasReady=s.ready;s.ready=ready;if(wasReady&&!ready){this.fail(s);return;}if(ready)this.ready(s);},()=>this.fail(s));
    return s;
  }
  private sendIce(s:Session,candidate:RTCIceCandidateInit){gatewayClient.sendRoomWebrtcIceCandidate(s.environment.community,s.environment.channel,s.peer,{...candidate,nexusSyntheticDiagnostic:s.id},'screen');}
  private signaled(s:Session){s.signaled=true;for(const candidate of s.outgoing)this.sendIce(s,candidate);s.outgoing=[];}
  private ready(s:Session){if(!this.alive(s)||!s.ready||s.dc?.readyState!=='open')return;if(!s.result)s.dc.send('nexus-synthetic-ready');else if(s.remoteReady)void this.message(s,'nexus-synthetic-ready').catch(()=>this.fail(s));}
  private bind(s:Session,dc:RTCDataChannel){
    if(dc.label!=='nexus-synthetic-'+s.id || s.dc){dc.close();return;}
    s.dc=dc;dc.binaryType='arraybuffer';dc.onopen=()=>this.ready(s);
    dc.onmessage=event=>{if(!this.alive(s))return;if(event.data==='nexus-synthetic-ready'){s.remoteReady=true;if(!s.ready)return;}else if(!s.ready)return;void this.message(s,event.data).catch(()=>this.fail(s));};
    dc.onclose=()=>{if(!s.closed)this.close(s);};
  }
  async start(peer:string,vendor:string){
    const environment=this.environment,epoch=this.diagnostics.consentGeneration,cycle=this.cycle;
    const context=await this.diagnostics.syntheticContext();if(cycle!==this.cycle||this.environment!==environment||epoch!==this.diagnostics.consentGeneration)return;
    if(!context.peers.some(p=>p.user_id===peer&&p.synthetic_allowed))throw new Error('synthetic_remote_consent_required');
    this.diagnostics.notify('Teste sintético P2P · gerando padrão próprio; tela real preservada');
    const result=await this.diagnostics.preparePeerSynthetic(vendor);
    if(cycle!==this.cycle||this.environment!==environment||epoch!==this.diagnostics.consentGeneration||!result.synthetic_access_unit)return;
    const s=await this.create(peer,crypto.randomUUID(),context,cycle);s.result=result;this.bind(s,s.pc.createDataChannel('nexus-synthetic-'+s.id,{ordered:true}));
    try{await s.pc.setLocalDescription(await s.pc.createOffer());if(!this.alive(s))return;
      gatewayClient.sendRoomWebrtcOffer(s.environment.community,s.environment.channel,peer,mark(s.pc.localDescription!.sdp,s.id),'screen');this.signaled(s);
    }catch{this.fail(s);}
  }
  async offer(peer:string,sdp:string){
    const id=syntheticSdpId(sdp);if(!id||!this.diagnostics.syntheticReady)return;
    const previous=this.sessions.get(this.key(peer,id));if(previous){if(previous.pc.localDescription?.type==='answer')gatewayClient.sendRoomWebrtcAnswer(previous.environment.community,previous.environment.channel,peer,mark(previous.pc.localDescription.sdp,id),'screen');return;}
    const environment=this.environment,epoch=this.diagnostics.consentGeneration,cycle=this.cycle;
    const key=this.key(peer,id);if(this.pendingOffers.has(key)||this.pendingOffers.size+this.sessions.size>=2)return;this.pendingOffers.set(key,cycle);
    try{if(sdp.length>16384)return;assertScreenSdp(sdp);if(!/^m=application /m.test(sdp)||/^m=(video|audio) /m.test(sdp))return;
      const context=await this.diagnostics.syntheticContext();if(cycle!==this.cycle||this.environment!==environment||epoch!==this.diagnostics.consentGeneration)return;
      const s=await this.create(peer,id,context,cycle);s.pc.ondatachannel=e=>this.bind(s,e.channel);
      await s.pc.setRemoteDescription({type:'offer',sdp});if(!this.alive(s))return;
      for(const candidate of s.pending)await s.pc.addIceCandidate(candidate);s.pending=[];
      await s.pc.setLocalDescription(await s.pc.createAnswer());if(!this.alive(s))return;
      gatewayClient.sendRoomWebrtcAnswer(s.environment.community,s.environment.channel,peer,mark(s.pc.localDescription!.sdp,id),'screen');this.signaled(s);
      this.diagnostics.notify('Teste sintético P2P autorizado · aguardando quadro gerado');
    }catch{const s=this.sessions.get(this.key(peer,id));if(s&&s.cycle===cycle)this.fail(s);}
    finally{if(this.pendingOffers.get(key)===cycle)this.pendingOffers.delete(key);}
  }
  async answer(peer:string,sdp:string){const id=syntheticSdpId(sdp);if(!id)return;const s=this.sessions.get(this.key(peer,id));if(!s||!this.alive(s)||!s.result)return;
    try{assertScreenSdp(sdp);await s.pc.setRemoteDescription({type:'answer',sdp});for(const candidate of s.pending)await s.pc.addIceCandidate(candidate);s.pending=[];}catch{this.fail(s);}}
  async ice(peer:string,candidate:any){
    const id=candidate?.nexusSyntheticDiagnostic;if(typeof candidate?.candidate!=='string'||candidate.candidate.length>2048||!UUID.test(id??'')||!this.diagnostics.syntheticReady||!this.environment)return;
    try{assertScreenCandidate(candidate);}catch{return;}
    const clean:RTCIceCandidateInit={candidate:candidate.candidate,sdpMid:candidate.sdpMid,sdpMLineIndex:candidate.sdpMLineIndex,usernameFragment:candidate.usernameFragment};
    const key=this.key(peer,id),s=this.sessions.get(key);
    if(!s){for(const [key,value]of this.early)if(Date.now()-value.at>30000)this.early.delete(key);if(this.early.size>=8)return;const entry=this.early.get(key)??{at:Date.now(),candidates:[]};if(entry.candidates.length<64)entry.candidates.push(clean);this.early.set(key,entry);return;}
    if(!this.alive(s))return;
    try{if(!s.pc.remoteDescription){if(s.pending.length<64)s.pending.push(clean);}else await s.pc.addIceCandidate(clean);}catch{this.fail(s);}
  }
  private async message(s:Session,data:unknown){
    if(data==='nexus-synthetic-ready'&&s.result&&!s.working){s.working=true;await this.sendFrame(s);return;}
    if(data==='nexus-synthetic-done'&&s.result){this.diagnostics.notify('Teste sintético P2P concluído · resultados enviados para análise');this.close(s);return;}
    if(s.result)return;
    if(typeof data==='string'){
      if(s.header||data.length>4096)return this.fail(s);const header=JSON.parse(data);
      if(Object.keys(header).some(k=>!['id','bytes','codec','reference'].includes(k))||JSON.stringify(header.reference)!==JSON.stringify(SYNTHETIC_RGB)||header.id!==s.id||!Number.isInteger(header.bytes)||header.bytes<=0||header.bytes>MAX_BYTES||!/^avc1\.[A-F0-9]{6}$/.test(header.codec)||!Array.isArray(header.reference)||header.reference.length!==24)return this.fail(s);
      s.header=header;return;
    }
    if(s.working)return;if(!(data instanceof ArrayBuffer)||!s.header)return this.fail(s);
    if(data.byteLength!==Math.min(CHUNK,s.header.bytes-s.received)||s.received+data.byteLength>s.header.bytes)return this.fail(s);
    s.chunks.push(new Uint8Array(data));s.received+=data.byteLength;
    if(s.received!==s.header.bytes)return;
    s.working=true;const bytes=new Uint8Array(s.received);let offset=0;for(const chunk of s.chunks){bytes.set(chunk,offset);offset+=chunk.length;}s.chunks=[];
    let binary='';for(let index=0;index<bytes.length;index+=CHUNK)binary+=String.fromCharCode(...bytes.subarray(index,index+CHUNK));
    const decoded=await decodeSyntheticChart({synthetic_access_unit:btoa(binary),synthetic_codec:s.header.codec,reference_rgb:s.header.reference},()=>!this.alive(s));
    if(!this.alive(s))return;
    await this.diagnostics.recordPeerSynthetic(s.context,s.id,s.alias,'receiver',decoded??{metrics:{stage:'decoding',result:'unavailable',decoderInput:'h264',decoderOutput:'unavailable',physicalDisplayMeasured:false},patches:[]},s.epoch,Date.now()-s.started);
    if(!this.alive(s))return;s.dc?.send('nexus-synthetic-done');this.diagnostics.notify('Teste sintético P2P recebido · medição numérica concluída ou decoder indisponível');setTimeout(()=>this.close(s),200);
  }
  private async sendFrame(s:Session){
    const result=s.result,dc=s.dc!;const bytes=Uint8Array.from(atob(result.synthetic_access_unit),c=>c.charCodeAt(0));
    if(bytes.length>MAX_BYTES||!s.ready||!this.alive(s))return this.fail(s);
    dc.send(JSON.stringify({id:s.id,bytes:bytes.length,codec:result.synthetic_codec,reference:result.reference_rgb}));
    for(let index=0;index<bytes.length;index+=CHUNK){
      if(!this.alive(s)||!s.ready||dc.readyState!=='open')return;
      if(dc.bufferedAmount>256*1024){dc.bufferedAmountLowThreshold=64*1024;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('synthetic_buffer_timeout')),5000);dc.addEventListener('bufferedamountlow',()=>{clearTimeout(timer);resolve();},{once:true});});}
      if(!this.alive(s)||!s.ready)return;dc.send(bytes.subarray(index,index+CHUNK));
    }
    await this.diagnostics.recordPeerSynthetic(s.context,s.id,s.alias,'sender',{metrics:result.metrics,patches:result.patches},s.epoch,Date.now()-s.started);
  }
}
export const syntheticPeerDiagnostics=new SyntheticPeerDiagnostics();
