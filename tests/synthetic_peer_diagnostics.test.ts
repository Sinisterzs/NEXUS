import test from 'node:test';
import assert from 'node:assert/strict';
import {DiagnosticsService} from '../src/services/DiagnosticsService.ts';
import {SyntheticPeerDiagnostics,syntheticSdpId,isSyntheticCandidate} from '../src/services/SyntheticPeerDiagnostics.ts';
import {gatewayClient} from '../src/services/GatewayClient';
import {SYNTHETIC_RGB,decodeSyntheticChart} from '../src/services/SyntheticColorDecode.ts';
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const uuid=()=>crypto.randomUUID();
class Channel extends EventTarget {
  readyState='open';binaryType='arraybuffer';bufferedAmount=0;bufferedAmountLowThreshold=0;
  onmessage:any=null;onopen:any=null;onclose:any=null;other:Channel|null=null;sent:any[]=[];
  constructor(public label:string){super();}
  send(value:any){this.sent.push(value);const data=typeof value==='string'?value:value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);void Promise.resolve().then(()=>this.other?.onmessage?.({data}));}
  close(){this.readyState='closed';this.onclose?.();}
}
const pcs:Pc[]=[];
class Pc extends EventTarget {
  connectionState='connecting';iceConnectionState='checking';localDescription:any=null;remoteDescription:any=null;
  onicecandidate:any=null;onconnectionstatechange:any=null;ondatachannel:any=null;channel:Channel|null=null;closed=0;remoteType='srflx';
  constructor(public config:any){super();pcs.push(this);}
  createDataChannel(label:string){return this.channel=new Channel(label);}
  async createOffer(){return {type:'offer',sdp:'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'};}
  async createAnswer(){return {type:'answer',sdp:'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'};}
  async setLocalDescription(value:any){this.localDescription=value;}
  async setRemoteDescription(value:any){this.remoteDescription=value;}
  async addIceCandidate(){}
  async getStats(){return new Map([['t',{id:'t',type:'transport',selectedCandidatePairId:'p'}],['p',{id:'p',type:'candidate-pair',localCandidateId:'l',remoteCandidateId:'r'}],['l',{id:'l',type:'local-candidate',candidateType:'host'}],['r',{id:'r',type:'remote-candidate',candidateType:this.remoteType}]]);}
  connected(){this.connectionState='connected';this.iceConnectionState='connected';this.dispatchEvent(new Event('connectionstatechange'));this.onconnectionstatechange?.();}
  close(){this.closed++;this.connectionState='closed';}
}
test('synthetic routing is explicit, malformed IDs are not accepted, and ordinary screen SDP is unclaimed',async()=>{
  const id=uuid();assert.equal(syntheticSdpId('v=0\r\na=x-nexus-synthetic:'+id+'\r\n'),id);
  assert.equal(syntheticSdpId('v=0\r\na=x-nexus-synthetic:PRIVATE\r\n'),null);assert.equal(syntheticSdpId('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96'),null);
  assert.equal(isSyntheticCandidate({candidate:'normal'}),false);assert.equal(isSyntheticCandidate({nexusSyntheticDiagnostic:id}),true);
  assert.equal(await decodeSyntheticChart({synthetic_access_unit:'AAAA',synthetic_codec:'avc1.42001F',reference_rgb:[[1,2,3]]},()=>false),null);
});
for(const order of ['together','receiver-first'])test('two opted-in peers correlate the synthetic frame: '+order,async()=>{
  const original={pc:globalThis.RTCPeerConnection,offer:gatewayClient.sendRoomWebrtcOffer,answer:gatewayClient.sendRoomWebrtcAnswer,ice:gatewayClient.sendRoomWebrtcIceCandidate};
  (globalThis as any).RTCPeerConnection=Pc;pcs.length=0;
  const users=[uuid(),uuid()],aliases=[uuid(),uuid()],scope=uuid(),uploads:any[]=[];
  const diagnostics=users.map((user,index)=>new DiagnosticsService(async(command,args)=>{
    if(command==='diagnostics_consent')return {revision:uuid()} as any;
    if(command==='diagnostics_load_queue')return [] as any;
    if(command==='diagnostics_context')return {session_id:scope,participant:aliases[index],peers:users.map((user_id,i)=>({user_id,alias:aliases[i],synthetic_allowed:true}))} as any;
    if(command==='diagnostics_synthetic')return {metrics:{capture:'synthetic',stage:'conversion',result:'measured'},patches:[],synthetic_access_unit:btoa('GENERATED_TEST_BYTES'),synthetic_codec:'avc1.42001F',reference_rgb:SYNTHETIC_RGB} as any;
    if(command==='diagnostics_send')uploads.push(...(args as any).batch.events);
    return {} as any;
  }));
  const peers=diagnostics.map(d=>new SyntheticPeerDiagnostics(d,async()=>[{urls:['turn:blocked.invalid','stun:example.invalid'],username:'PRIVATE',credential:'PRIVATE'}]));
  let offer='',answer='';gatewayClient.sendRoomWebrtcOffer=(_c,_r,_p,sdp)=>{offer=sdp;};gatewayClient.sendRoomWebrtcAnswer=(_c,_r,_p,sdp)=>{answer=sdp;};gatewayClient.sendRoomWebrtcIceCandidate=()=>{};
  try{
    for(let i=0;i<2;i++){diagnostics[i].setAccount(users[i],'0.4.0-nightly.5');await diagnostics[i].setPermissions({p2p:false,color:false,synthetic:true});peers[i].configure({community:'community',channel:'room',self:users[i]});}
    await peers[0].start(users[1],'amd');assert.ok(offer);await peers[1].offer(users[0],offer);assert.ok(answer);await peers[0].answer(users[1],answer);
    assert.equal(pcs.length,2);assert.deepEqual(pcs[0].config.iceServers,[{urls:['stun:example.invalid']}]);
    const source=pcs[0].channel!,destination=new Channel(source.label);source.other=destination;destination.other=source;pcs[1].ondatachannel({channel:destination});
    if(order==='receiver-first'){pcs[1].connected();await flush();pcs[0].connected();}else pcs.forEach(pc=>pc.connected());for(let i=0;i<20&&uploads.length<2;i++){await flush();await new Promise(resolve=>setImmediate(resolve));await Promise.all(diagnostics.map(d=>d.flush()));}
    assert.ok(source.sent.some(value=>value instanceof Uint8Array));assert.equal(uploads.length,2);
    const sent=uploads.find(e=>e.role==='sender'),received=uploads.find(e=>e.role==='receiver');assert.ok(sent&&received);assert.equal(sent.attempt,received.attempt);
    assert.equal(sent.source,aliases[0]);assert.equal(received.destination,aliases[1]);assert.equal(received.metrics.result,'unavailable','Node has no WebCodecs; never fabricate RGB measurement');
    assert.equal(JSON.stringify(uploads).includes('GENERATED_TEST_BYTES'),false);assert.equal(JSON.stringify(uploads).includes('PRIVATE'),false);
  }finally{
    peers.forEach(p=>p.stopAll());await Promise.all(diagnostics.map(d=>d.stop()));(globalThis as any).RTCPeerConnection=original.pc;
    gatewayClient.sendRoomWebrtcOffer=original.offer;gatewayClient.sendRoomWebrtcAnswer=original.answer;gatewayClient.sendRoomWebrtcIceCandidate=original.ice;
  }
});
test('disabled synthetic permission creates no PC or candidate queue',async()=>{
  const diagnostics=new DiagnosticsService(async()=>({}) as any),peer=new SyntheticPeerDiagnostics(diagnostics,async()=>[]);const before=pcs.length;
  peer.configure({community:'community',channel:'room',self:uuid()});await peer.offer(uuid(),'v=0\r\na=x-nexus-synthetic:'+uuid()+'\r\n');
  await peer.ice(uuid(),{candidate:'candidate:1 1 udp 1 203.0.113.1 9 typ host',nexusSyntheticDiagnostic:uuid()});
  assert.equal(pcs.length,before);assert.equal((peer as any).early.size,0);peer.stopAll();
});
for(const stage of ['probe','ice'])test('stop cancels a pending synthetic '+stage+' before it can create or signal a PC',async()=>{
  const original=globalThis.RTCPeerConnection;(globalThis as any).RTCPeerConnection=Pc;
  const before=pcs.length,user=uuid(),remote=uuid(),alias=uuid(),remoteAlias=uuid();
  let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const diagnostic=new DiagnosticsService(async(command)=>{
    if(command==='diagnostics_consent')return {revision:uuid()} as any;
    if(command==='diagnostics_load_queue')return [] as any;
    if(command==='diagnostics_context')return {session_id:uuid(),participant:alias,peers:[{user_id:user,alias,synthetic_allowed:true},{user_id:remote,alias:remoteAlias,synthetic_allowed:true}]} as any;
    if(command==='diagnostics_synthetic'){if(stage==='probe'){entered();await gate;}return {synthetic_access_unit:btoa('GENERATED'),synthetic_codec:'avc1.42001F',reference_rgb:SYNTHETIC_RGB,metrics:{stage:'conversion'},patches:[]} as any;}
    return {} as any;
  });
  const peer=new SyntheticPeerDiagnostics(diagnostic,async()=>{if(stage==='ice'){entered();await gate;}return [];});
  try{
    diagnostic.setAccount(user,'0.4.0-nightly.5');await diagnostic.setPermissions({p2p:false,color:false,synthetic:true});peer.configure({community:'community',channel:'room',self:user});
    const pending=peer.start(remote,'amd').catch(()=>{});await waiting;peer.stopAll();release();await pending;
    assert.equal(pcs.length,before);assert.equal((peer as any).sessions.size,0);
  }finally{release?.();peer.stopAll();await diagnostic.stop();(globalThis as any).RTCPeerConnection=original;}
});
