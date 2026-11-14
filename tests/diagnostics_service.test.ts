import test from 'node:test';
import assert from 'node:assert/strict';
import {DiagnosticsService,disabledDiagnostics} from '../src/services/DiagnosticsService.ts';
const hash=async(value:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
const session='00000000-0000-4000-8000-000000000001',self='00000000-0000-4000-8000-000000000002';
const remote='00000000-0000-4000-8000-000000000003';
const context={session_id:session,participant:self,peers:[{user_id:'PRIVATE_SELF',alias:self},{user_id:'PRIVATE_REMOTE',alias:remote}]};
const input=async(kind='p2p',generation=1)=>({kind,role:'receiver',snapshot:{senderToken:await hash('nexus-screen:user:PRIVATE_REMOTE'),peerToken:await hash('nexus-screen:user:PRIVATE_SELF'),offerToken:'a'.repeat(64),receiverGeneration:generation,connectionState:'connecting',iceConnectionState:'checking',framesDecoded:null}} as any);
function fixture(){
  const calls:{command:string;args:any}[]=[];let now=1000;
  const control={offline:false,slowStop:null as null|Promise<void>,stored:[] as any[]};
  const service=new DiagnosticsService(async(command,args)=>{
    calls.push({command,args});
    if(command==='diagnostics_stop'&&control.slowStop)await control.slowStop;
    if(command==='diagnostics_consent')return {revision:crypto.randomUUID()} as any;
    if(command==='diagnostics_load_queue')return control.stored as any;
    if(command==='diagnostics_context')return context as any;
    if(command==='diagnostics_synthetic')return {metrics:{capture:'synthetic',result:'measured',stage:'conversion'},patches:[]} as any;
    if(command==='diagnostics_send'&&control.offline)throw new Error('offline');
    return {} as any;
  },()=>now);
  service.setAccount('PRIVATE_SELF','0.4.0-nightly.5');
  return {service,calls,control,advance:(n:number)=>{now+=n;}};
}
const enabled={p2p:true,color:false,synthetic:false};
test('default off, explicit receipt, aliases, attempt and generations; no raw identifiers uploaded',async()=>{
  const {service,calls}=fixture();try{
    assert.deepEqual(service.permissions,disabledDiagnostics());await service.observe(await input());await service.flush();
    assert.equal(calls.filter(c=>c.command==='diagnostics_send').length,0);
    await service.setPermissions(enabled);await service.observe(await input('p2p',7));await service.flush();
    const payload=calls.find(c=>c.command==='diagnostics_send')!.args.batch;
    assert.equal(payload.events.length,1);const event=payload.events[0];
    assert.equal(event.source,remote);assert.equal(event.destination,self);assert.equal(event.participant,self);assert.equal(event.generation,7);
    assert.match(event.attempt,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(payload).includes('PRIVATE'),false);
    assert.equal('offerToken' in event.metrics,false);
  }finally{service.stop();}
});
test('revocation during pending stop cannot invoke a late consent grant',async()=>{
  const {service,calls,control}=fixture();let finish!:()=>void;
  control.slowStop=new Promise<void>(r=>{finish=r;});const pending=service.setPermissions(enabled);
  service.stop();finish();await pending;
  assert.equal(calls.some(c=>c.command==='diagnostics_consent'),false);assert.deepEqual(service.permissions,disabledDiagnostics());
});
test('revoke clears pending batches and account changes cannot send another account events',async()=>{
  const {service,calls,control}=fixture();try{
    await service.setPermissions(enabled);await service.observe(await input());control.offline=true;await service.flush();
    service.setAccount('PRIVATE_OTHER','0.4.0-nightly.5');control.offline=false;await service.flush();
    const count=calls.filter(c=>c.command==='diagnostics_send').length;
    await service.observe(await input());await service.flush();assert.equal(calls.filter(c=>c.command==='diagnostics_send').length,count);
    assert.deepEqual(service.permissions,disabledDiagnostics());
  }finally{service.stop();}
});
test('bounded retry preserves event IDs for deduplication and does not interrupt calls',async()=>{
  const {service,calls,control,advance}=fixture();try{
    await service.setPermissions(enabled);control.offline=true;await service.observe(await input());await service.flush();
    await service.flush();assert.equal(calls.filter(c=>c.command==='diagnostics_send').length,1);
    advance(60001);control.offline=false;await service.flush();
    const sends=calls.filter(c=>c.command==='diagnostics_send');assert.equal(sends.length,2);assert.equal(sends[0].args.batch.events[0].id,sends[1].args.batch.events[0].id);
    await service.flush();assert.equal(calls.filter(c=>c.command==='diagnostics_send').length,2);
  }finally{service.stop();}
});
test('color sender delivery is independent of P2P permission',async()=>{
  const {service,calls}=fixture();try{
    await service.setPermissions({p2p:false,color:true,synthetic:false});
    await service.observe({kind:'color',role:'local',snapshot:{gpu:'amd',pixelFormat:'nv12'}});
    await service.observe({kind:'color',role:'sender',snapshot:{peerToken:await hash('nexus-screen:user:PRIVATE_REMOTE'),offerToken:'a'.repeat(64)}});
    await service.observe(await input('p2p'));await service.flush();
    const events=calls.find(c=>c.command==='diagnostics_send')!.args.batch.events;
    assert.equal(events.length,2);assert.ok(events.every((e:any)=>e.kind==='color'&&e.metrics.gpu==='amd'&&!('iceConnectionState' in e.metrics)));assert.ok(events.some((e:any)=>e.role==='sender'));
  }finally{service.stop();}
});
test('different source aliases isolate same offer; room reset and concurrent observations remain bounded',async()=>{
  const {service,calls,advance}=fixture();try{
    await service.setPermissions(enabled);await Promise.all([service.observe(await input()),service.observe(await input())]);
    await service.flush();const first=calls.find(c=>c.command==='diagnostics_send')!.args.batch.events;
    assert.equal(first.length,1,'concurrent duplicate samples are throttled');
    service.roomChanged();advance(11000);await service.observe(await input('p2p',2));await service.flush();
    assert.equal(calls.filter(c=>c.command==='diagnostics_context').length,2);
  }finally{service.stop();}
});
test('expired permission stops collection even when no events are queued',async()=>{
  const {service,advance}=fixture();await service.setPermissions(enabled);advance(14*60_000);await service.flush();assert.deepEqual(service.permissions,disabledDiagnostics());
});
test('normal close stages sanitized queue; only explicit new consent restores pending diagnostics',async()=>{
  const {service,calls,control}=fixture();try{
    await service.setPermissions(enabled);await service.observe(await input());control.offline=true;await service.close();
    const saved=calls.filter(c=>c.command==='diagnostics_save_queue');assert.ok(saved.some(c=>c.args.events.length===1));
    assert.equal(JSON.stringify(saved.map(c=>c.args)).includes('PRIVATE'),false);
  }finally{service.stop();}
});
test('restored offline outbox is staged again before a second normal restart',async()=>{
  const first=fixture();let saved:any[]=[];
  try{await first.service.setPermissions(enabled);await first.service.observe(await input());await first.service.close();
    saved=first.calls.filter(c=>c.command==='diagnostics_save_queue').find(c=>c.args.events.length===1)!.args.events;
  }finally{first.service.stop(false);}
  for(let restart=0;restart<2;restart++){
    const current=fixture();current.control.stored=saved;current.control.offline=true;
    try{await current.service.setPermissions(enabled);await current.service.close();
      const staged=current.calls.filter(c=>c.command==='diagnostics_save_queue').find(c=>c.args.events.length===1);
      assert.ok(staged,'restored batch must remain durable before successful delivery');saved=staged.args.events;
    }finally{current.service.stop(false);}
  }
});
test('synthetic result cannot cross revocation while its attempt digest is pending',async()=>{
  const {service,calls}=fixture();const original=crypto.subtle.digest.bind(crypto.subtle);
  let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(r=>{entered=r;});let hold=true;
  const gate=new Promise<void>(r=>{release=r;});
  (crypto.subtle as any).digest=async(algorithm:any,bytes:any)=>{
    if(hold && /^[a-f0-9-]{36}$/.test(new TextDecoder().decode(bytes))){entered();await gate;}
    return original(algorithm,bytes);
  };
  try{
    await service.setPermissions({p2p:false,color:false,synthetic:true});const pending=service.synthetic('amd');await blocked;
    service.stop();await service.setPermissions({p2p:false,color:false,synthetic:true});hold=false;release();await pending;await service.flush();
    assert.equal(calls.filter(c=>c.command==='diagnostics_send').length,0);
  }finally{hold=false;release?.();(crypto.subtle as any).digest=original;service.stop();}
});
test('four peers correlate both directions without IP identity, then isolate a new room generation',async()=>{
  const users=['PRIVATE_ME','PRIVATE_HOUSE_A','PRIVATE_HOUSE_B','PRIVATE_FOURTH'];
  const aliases=users.map(()=>crypto.randomUUID());let scope=crypto.randomUUID();const sent:any[]=[];
  const services=users.map((user,index)=>{
    const service=new DiagnosticsService(async(command,args)=>{
      if(command==='diagnostics_consent')return {revision:crypto.randomUUID()} as any;
      if(command==='diagnostics_load_queue')return [] as any;
      if(command==='diagnostics_context')return {session_id:scope,participant:aliases[index],peers:users.map((user_id,i)=>({user_id,alias:aliases[i]}))} as any;
      if(command==='diagnostics_send')sent.push(...(args as any).batch.events);
      return {} as any;
    });service.setAccount(user,'0.4.0-nightly.5');return service;
  });
  try{
    await Promise.all(services.map(s=>s.setPermissions(enabled)));
    for(const source of [1,2,3])for(const destination of [0,3]){
      if(source===destination)continue;
      const offerToken='a'.repeat(64); // Intentionally identical across the two houses.
      await services[source].observe({kind:'p2p',role:'sender',snapshot:{peerToken:await hash('nexus-screen:user:'+users[destination]),offerToken,connectionState:'connected'}});
      await services[destination].observe({kind:'p2p',role:'receiver',snapshot:{senderToken:await hash('nexus-screen:user:'+users[source]),offerToken,receiverGeneration:2,connectionState:destination===0&&source!==3?'failed':'connected'}});
    }
    await Promise.all(services.map(s=>s.flush()));
    for(const event of sent){const other=sent.find(e=>e.source===event.source&&e.destination===event.destination&&e.role!==event.role);assert.ok(other);assert.equal(event.attempt,other.attempt);}
    const a=sent.find(e=>e.source===aliases[1]&&e.destination===aliases[0]);
    const b=sent.find(e=>e.source===aliases[2]&&e.destination===aliases[0]);assert.notEqual(a.attempt,b.attempt);
    assert.equal(JSON.stringify(sent).includes('PRIVATE'),false);assert.equal(JSON.stringify(sent).includes('address'),false);
    scope=crypto.randomUUID();services.forEach(s=>s.roomChanged());
    await services[0].observe({kind:'p2p',role:'receiver',snapshot:{senderToken:await hash('nexus-screen:user:'+users[1]),offerToken:'a'.repeat(64),receiverGeneration:0}});await services[0].flush();
    assert.notEqual(sent.at(-1).attempt,a.attempt);assert.equal(sent.at(-1).session_id,scope);
  }finally{services.forEach(s=>s.stop());}
});
