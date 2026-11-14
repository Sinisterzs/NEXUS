import {decodeSyntheticChart} from './SyntheticColorDecode.ts';
// Optional telemetry has no dependency on call transport or user content.
export type DiagnosticKind = 'p2p' | 'color' | 'synthetic';
export type DiagnosticPermissions = Record<DiagnosticKind, boolean>;
export type DiagnosticContext = { session_id: string; participant: string; peers: { user_id: string; alias: string; synthetic_allowed?:boolean }[] };
type Snapshot = Record<string, any>;
export type DiagnosticEvent = { id: string; session_id: string; participant: string; source: string; destination: string;
  attempt: string; generation: number; kind: DiagnosticKind; role: 'sender'|'receiver'|'local'; version: string;
  elapsed_ms: number; metrics: Snapshot; patches?: any[] };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export const disabledDiagnostics = (): DiagnosticPermissions => ({ p2p: false, color: false, synthetic: false });
const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');

export class DiagnosticsService {
  permissions = disabledDiagnostics();
  status = 'Desativados';
  private account = '';
  private version = '';
  private revision = '';
  private epoch = 0;
  private context: DiagnosticContext | null = null;
  private contextPending: Promise<DiagnosticContext> | null = null;
  private contextRetryAt = 0;
  private aliases = new Map<string,string>();
  private queue: DiagnosticEvent[] = [];
  private busy = false;
  private retryAt = 0;
  private failures = 0;
  private attempts = new Map<string,{ started: number; sampled: number; generation: number }>();
  private listeners = new Set<() => void>();
  private color: Snapshot | null = null;
  private consentAt = 0;
  private roomRevision = 0;
  private saveChain:Promise<void>=Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private invoke: Invoke, private now = () => Date.now()) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; };
  private publish(text: string) {this.status=text;for(const listener of this.listeners)listener();}
  setAccount(account: string, version: string) {
    if (this.account===account && this.version===version) return;
    this.stop(Boolean(this.account));this.account=account;this.version=version;
  }
  private clear() {
    this.epoch++; this.contextRetryAt=0;this.revision='';this.context=null;this.contextPending=null;this.queue=[];this.aliases.clear();
    this.attempts.clear();this.color=null;this.retryAt=0;this.failures=0;
    if(this.timer)clearInterval(this.timer);this.timer=null;
  }
  stop(purge=true) {
    this.permissions=disabledDiagnostics();this.clear();const stopped=this.invoke('diagnostics_stop',{purge}).catch(()=>{});this.publish('Desativados');return stopped;
  }
  async setPermissions(permissions: DiagnosticPermissions) {
    this.permissions={...permissions};this.clear();const epoch=this.epoch;
    // Stop is local and immediate even if consent revocation cannot reach the server.
    await this.invoke('diagnostics_stop',{purge:!Object.values(permissions).some(Boolean)}).catch(()=>{});
    if(epoch!==this.epoch)return;
    this.publish(Object.values(permissions).some(Boolean)?'Registrando autorização…':'Desativados; registrando revogação…');
    if(!this.account || !/-nightly\.\d+$/.test(this.version)) {this.stop();return;}
    try {
      const receipt=await this.invoke<{revision:string}>('diagnostics_consent',{permissions});
      if(epoch!==this.epoch)return;
      if(!Object.values(permissions).some(Boolean)) {this.publish('Desativados; revogação registrada');return;}
      this.revision=receipt.revision;this.consentAt=this.now();
      const restored=await this.invoke<DiagnosticEvent[]>('diagnostics_load_queue').catch(()=>[]);
      if(epoch!==this.epoch)return;
      this.queue=restored.filter(e=>permissions[e.kind]).slice(0,96);this.save();
      this.publish('Ativos · aguardando eventos');
      this.timer=setInterval(()=>{void this.flush();},5000);
    } catch {
      if(epoch!==this.epoch)return;
      this.permissions=disabledDiagnostics();this.publish('Coleta desativada · autorização indisponível');
    }
  }
  private async getContext(): Promise<DiagnosticContext> {
    if(this.context)return this.context;
    if(this.contextPending)return this.contextPending;
    if(this.now()<this.contextRetryAt)throw new Error('context_backoff');
    const epoch=this.epoch,roomRevision=this.roomRevision;
    const pending=this.invoke<DiagnosticContext>('diagnostics_context').then(async context=>{
      const aliases=new Map<string,string>();
      for(const peer of context.peers)aliases.set(await digest('nexus-screen:user:'+peer.user_id),peer.alias);
      if(epoch!==this.epoch || roomRevision!==this.roomRevision)throw new Error('consent_changed');
      this.context=context;this.aliases=aliases;return context;
    });
    this.contextPending=pending;
    try{return await pending;}catch(error){this.contextRetryAt=this.now()+10_000;throw error;}finally{if(this.contextPending===pending)this.contextPending=null;}
  }
  roomChanged() {this.roomRevision++;this.contextRetryAt=0;this.context=null;this.contextPending=null;this.aliases.clear();this.attempts.clear();this.color=null;}
  async observe(input: {kind:DiagnosticKind; role:'sender'|'receiver'|'local'; snapshot:Snapshot}) {
    if(!this.permissions[input.kind] || !this.revision || !this.account)return;
    const epoch=this.epoch,roomRevision=this.roomRevision;
    if(this.now()-this.consentAt>13*60_000){this.stop();this.publish('Autorização expirada · ative novamente para continuar');return;}
    const snapshot={...(input.kind==='color' && input.role==='sender' ? this.color??{} : {}),...input.snapshot};
    if(input.kind==='color' && input.role==='local') this.color=snapshot;
    try {
      const context=await this.getContext();if(epoch!==this.epoch || roomRevision!==this.roomRevision)return;
      const source=input.role==='receiver'?this.aliases.get(snapshot.senderToken):context.participant;
      const destination=input.role==='sender'?this.aliases.get(snapshot.peerToken):context.participant;
      if(!source || !destination || (!snapshot.offerToken && input.role!=='local'))return;
      const attempt=await digest([context.session_id,source,destination,snapshot.offerToken??'local-metadata'].join(':'));
      if(epoch!==this.epoch || roomRevision!==this.roomRevision)return;
      const sampleKey=attempt+':'+input.kind;
      const previous=this.attempts.get(sampleKey)??{started:this.now(),sampled:0,generation:Number(snapshot.receiverGeneration??0)};
      const terminal=Boolean(snapshot.terminationKind||snapshot.failureCode||snapshot.closureCode||snapshot.timeoutPhase);
      if(!terminal && previous.sampled && this.now()-previous.sampled<10_000)return;
      if(this.attempts.size>=128 && !this.attempts.has(sampleKey))return;
      previous.sampled=this.now();this.attempts.set(sampleKey,previous);
      for(const key of ['senderToken','peerToken','offerToken','transportToken','diagnosticRun','receiverId','receiverGeneration','roomGeneration'])delete snapshot[key];
      const event:DiagnosticEvent={id:crypto.randomUUID(),session_id:context.session_id,participant:context.participant,
        source,destination,attempt,generation:previous.generation,kind:input.kind,role:input.role,version:this.version,
        elapsed_ms:Math.min(86_400_000,Math.max(0,this.now()-previous.started)),metrics:snapshot};
      this.enqueue(event,terminal);

    } catch {if(epoch===this.epoch)this.publish('Ativos · aguardando contexto da sala');}
  }
  private save() {
    const events=this.queue.map(e=>({...e})),epoch=this.epoch;
    this.saveChain=this.saveChain.catch(()=>{}).then(async()=>{if(epoch!==this.epoch)return;await this.invoke('diagnostics_save_queue',{events});}).catch(()=>{if(epoch===this.epoch)this.publish('Ativos · fila local indisponível');});
  }
  get participantAlias(){return this.context?.participant??'';}
  async showParticipantAlias(){if(!this.revision)throw new Error('diagnostics_disabled');await this.getContext();this.publish(this.status);}
  get consentGeneration(){return this.epoch;}
  get syntheticReady(){return this.permissions.synthetic && Boolean(this.revision);}
  notify(text:string){this.publish(text);}
  async syntheticContext():Promise<DiagnosticContext>{
    if(!this.syntheticReady)throw new Error('synthetic_consent_required');
    const epoch=this.epoch,room=this.roomRevision;const context=await this.invoke<DiagnosticContext>('diagnostics_context');
    if(epoch!==this.epoch || room!==this.roomRevision)throw new Error('synthetic_context_changed');return context;
  }
  async preparePeerSynthetic(vendor:string){if(!this.syntheticReady)throw new Error('synthetic_consent_required');return this.invoke<any>('diagnostics_synthetic',{vendor});}
  async recordPeerSynthetic(context:DiagnosticContext,id:string,peer:string,role:'sender'|'receiver',result:{metrics:Snapshot;patches:any[]},generation:number,elapsedMs=0){
    if(generation!==this.epoch || !this.syntheticReady)return;
    const room=this.roomRevision,source=role==='sender'?context.participant:peer,destination=role==='receiver'?context.participant:peer;
    const attempt=await digest([context.session_id,source,destination,id].join(':'));
    if(generation!==this.epoch || room!==this.roomRevision || !this.syntheticReady)return;
    this.enqueue({id:crypto.randomUUID(),session_id:context.session_id,participant:context.participant,source,destination,attempt,generation:0,
      kind:'synthetic',role,version:this.version,elapsed_ms:Math.min(86_400_000,Math.max(0,elapsedMs)),metrics:result.metrics,patches:result.patches},true);
  }
  private enqueue(event:DiagnosticEvent, terminal:boolean) {
    if(this.queue.length>=96){if(!terminal){this.publish('Ativos · limite da fila atingido');return;}this.queue.shift();}
    this.queue.push(event);this.save();if(terminal)void this.flush();
  }
  async synthetic(vendor:'amd'|'nvidia'|'intel') {
    if(!this.permissions.synthetic || !this.revision)throw new Error('Autorize o teste sintético primeiro.');
    const started=this.now(),epoch=this.epoch,roomRevision=this.roomRevision,context=await this.getContext();
    if(epoch!==this.epoch || roomRevision!==this.roomRevision)return;
    this.publish('Teste sintético em execução · nenhum conteúdo pessoal é capturado');
    const result=await this.invoke<{metrics:Snapshot;patches:any[];synthetic_access_unit?:string;synthetic_codec?:string;reference_rgb?:number[][]}>('diagnostics_synthetic',{vendor});
    if(epoch!==this.epoch)return;
    const attempt=await digest(crypto.randomUUID());
    if(epoch!==this.epoch || roomRevision!==this.roomRevision)return;
    this.enqueue({id:crypto.randomUUID(),session_id:context.session_id,participant:context.participant,source:context.participant,
      destination:context.participant,attempt,generation:0,kind:'synthetic',role:'local',
      version:this.version,elapsed_ms:Math.min(86_400_000,Math.max(0,this.now()-started)),metrics:result.metrics,patches:result.patches},true);
    const decoded=await decodeSyntheticChart(result,()=>epoch!==this.epoch || roomRevision!==this.roomRevision);
    if(epoch!==this.epoch || roomRevision!==this.roomRevision)return;
    if(decoded)this.enqueue({id:crypto.randomUUID(),session_id:context.session_id,participant:context.participant,source:context.participant,
      destination:context.participant,attempt,generation:0,kind:'synthetic',role:'local',
      version:this.version,elapsed_ms:Math.min(86_400_000,Math.max(0,this.now()-started)),metrics:{...decoded.metrics,gpu:'unavailable',encoder:'mf_h264'},patches:decoded.patches},true);
    this.publish('Teste sintético concluído · resultado numérico na fila');
  }
  async flush() {
    if(this.revision && this.now()-this.consentAt>13*60_000){this.stop();this.publish('Autorização expirada · ative novamente para continuar');return;}
    if(this.busy || !this.queue.length || !this.revision || this.now()<this.retryAt)return;
    const epoch=this.epoch,events=this.queue.slice(0,24);this.busy=true;
    try {
      await this.invoke('diagnostics_send',{batch:{consent_revision:this.revision,events}});
      if(epoch!==this.epoch)return;
      const ids=new Set(events.map(e=>e.id));this.queue=this.queue.filter(e=>!ids.has(e.id));
      this.save();this.failures=0;this.retryAt=0;this.publish('Ativos · últimos dados enviados');
    } catch {
      if(epoch!==this.epoch)return;
      this.failures++;this.retryAt=this.now()+Math.min(60_000,2000*2**Math.min(this.failures,5));
      if(this.failures>=5){this.queue=[];this.save();this.publish('Ativos · envio indisponível; lote descartado após cinco tentativas');}
      else this.publish('Ativos · envio pendente; nova tentativa automática');
    } finally {this.busy=false;}
  }
  async close() {
    await this.saveChain;
    this.retryAt=0;
    if(!this.busy)await this.flush();
    await this.saveChain;
  }
}

const invoke:Invoke=async(command,args)=>{const {invoke}=await import('@tauri-apps/api/core');return invoke(command,args);};
export const diagnosticsService=new DiagnosticsService(invoke);
