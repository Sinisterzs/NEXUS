import test from 'node:test';
import assert from 'node:assert/strict';
import { screenIceServers, assertScreenCandidate, assertScreenSdp, assertVoiceOnlySdp, guardScreenP2P, SCREEN_P2P_ERROR } from '../src/services/ScreenP2PPolicy.ts';
const candidate = (kind: string) => `candidate:1 1 udp 1 192.0.2.1 9 typ ${kind}`;
const report = (local?: string, remote?: string) => new Map([
  ['p', { id:'p',type:'candidate-pair',selected:true,localCandidateId:'l',remoteCandidateId:'r' }],
  ['l',{id:'l',type:'local-candidate',candidateType:local}],['r',{id:'r',type:'remote-candidate',candidateType:remote}],
]) as unknown as RTCStatsReport;

test('backend TURN URLs, mixed entries, credentials and cached values cannot leak into screen configuration', () => {
  const voice = [{urls:['turn:private.invalid',' STUN:example.invalid ','turns:private.invalid'], username:'private',credential:'secret'}, {urls:'turn:private.invalid'}];
  const original = structuredClone(voice);
  assert.deepEqual(screenIceServers(voice), [{urls:['STUN:example.invalid']}]);
  assert.deepEqual(voice, original, 'voice cache remains intact');
});
test('initial SDP, restart/reoffer and trickle reject relay, preserving all direct types', () => {
  for (const kind of ['host','srflx','prflx']) { assert.doesNotThrow(() => assertScreenCandidate(candidate(kind))); assert.doesNotThrow(() => assertScreenSdp(`v=0\r\na=${candidate(kind)}`)); }
  for (const kind of ['relay','RELAY','unknown']) {
    assert.throws(() => assertScreenCandidate({candidate:candidate(kind)}), {message:SCREEN_P2P_ERROR});
    assert.throws(() => assertScreenSdp(`v=0\r\na=${candidate('host')}\r\na=${candidate(kind)}`));
  }
  assert.doesNotThrow(() => assertScreenCandidate(''));
  assert.throws(() => assertScreenCandidate('malformed'));
  assert.throws(() => assertScreenCandidate(candidate('host')+'\n'+candidate('relay')));
  assert.throws(() => assertScreenSdp('a=remote-candidates:1 192.0.2.1 9'));
});
test('legacy screen negotiation is blocked on voice without forbidding voice TURN candidates', () => {
  assert.throws(() => assertVoiceOnlySdp('m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96'));
  assert.doesNotThrow(() => assertVoiceOnlySdp(`m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${candidate('relay')}\r\nm=video 0 UDP/TLS/RTP/SAVPF 96`));
});

async function guardFixture(run: (pc: any, tick:()=>Promise<void>, states:boolean[], errors:string[])=>Promise<void>) {
  const old={ interval:globalThis.setInterval, clear:globalThis.clearInterval, now:Date.now, info:console.info };
  let callback!:()=>void; let clock=1000; let cleared=false;
  globalThis.setInterval=((cb:()=>void)=>{callback=cb;return 1;}) as any;
  globalThis.clearInterval=(()=>{cleared=true;}) as any; Date.now=()=>clock; console.info=()=>{};
  const pc:any=new EventTarget(); Object.assign(pc,{connectionState:'connected',iceConnectionState:'connected',value:report(),getStats:async()=>pc.value,advance:(ms:number)=>{clock+=ms;}});
  const states:boolean[]=[],errors:string[]=[]; let stop:()=>void=()=>{};
  const tick=async()=>{callback();for(let i=0;i<12;i++)await Promise.resolve();};
  try {stop=guardScreenP2P(pc,v=>states.push(v),e=>errors.push(e));await tick();await run(pc,tick,states,errors);}
  finally {stop();assert.equal(cleared,true);globalThis.setInterval=old.interval;globalThis.clearInterval=old.clear;Date.now=old.now;console.info=old.info;}
}
test('unknown pair withholds media, direct pair permits it, relay migration permanently revokes it', async()=>{
  await guardFixture(async(pc,tick,states,errors)=>{
    assert.deepEqual(states,[]);pc.value=report('host','srflx');await tick();assert.deepEqual(states,[true]);
    pc.connectionState='disconnected';pc.iceConnectionState='checking';pc.dispatchEvent(new Event('connectionstatechange'));await tick();assert.deepEqual(states,[true,false]);
    pc.connectionState='connected';pc.iceConnectionState='connected';pc.value=report('prflx','host');pc.dispatchEvent(new Event('connectionstatechange'));await tick();assert.equal(states.at(-1),true);
    pc.value=report('host','relay');await tick();assert.equal(states.at(-1),false);assert.deepEqual(errors,[SCREEN_P2P_ERROR]);
    pc.value=report('host','host');await tick();assert.equal(states.at(-1),false);assert.equal(errors.length,1);
  });
});
test('pending stats cannot suspend the deadline or reopen media after cleanup',async()=>{
  await guardFixture(async(pc,tick,states,errors)=>{
    let finish!:(value:RTCStatsReport)=>void;pc.getStats=()=>new Promise(resolve=>{finish=resolve;});await tick();
    pc.advance(31000);await tick();assert.deepEqual(errors,[SCREEN_P2P_ERROR]);
    finish(report('host','srflx'));await tick();assert.deepEqual(states,[]);
  });
});

test('stats stalled after a direct pair revokes readiness and cannot reopen the player',async()=>{
  await guardFixture(async(pc,tick,states,errors)=>{
    pc.value=report('host','prflx');await tick();assert.deepEqual(states,[true]);
    let finish!:(value:RTCStatsReport)=>void;pc.getStats=()=>new Promise(resolve=>{finish=resolve;});await tick();
    pc.advance(3000);await tick();assert.deepEqual(states,[true,false]);assert.deepEqual(errors,[SCREEN_P2P_ERROR]);
    finish(report('host','srflx'));await tick();assert.deepEqual(states,[true,false]);
  });
});


test('guard reports the operation causing failure without changing its deadline', async () => {
  const old = { interval: globalThis.setInterval, clear: globalThis.clearInterval, now: Date.now };
  let now = 1000; const ticks = new Map<number, () => void>(); let id = 0;
  globalThis.setInterval = ((cb: () => void) => { ticks.set(++id, cb); return id; }) as any;
  globalThis.clearInterval = ((key: number) => ticks.delete(key)) as any;
  Date.now = () => now;
  const failures: string[] = []; const stops: (() => void)[] = [];
  const add = (connectionState: string, iceConnectionState: string, getStats = async () => report()) => {
    const pc = Object.assign(new EventTarget(), { connectionState, iceConnectionState, getStats });
    stops.push(guardScreenP2P(pc as any, () => {}, (_message, code) => failures.push(code)));
    return pc;
  };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    add('failed', 'checking'); add('connecting', 'failed');
    add('connected', 'connected', async () => report('host', 'relay')); await flush();
    assert.deepEqual(failures, ['pc_failed', 'ice_failed', 'relay_selected']);
    add('connecting', 'checking');
    now += 29999; for (const tick of [...ticks.values()]) tick(); await flush();
    assert.equal(failures.length, 3);
    now++; for (const tick of [...ticks.values()]) tick(); await flush();
    assert.equal(failures.at(-1), 'direct_deadline');
    add('connected', 'connected', () => new Promise(() => {}));
    now += 2000; for (const tick of [...ticks.values()]) tick(); await flush();
    assert.equal(failures.at(-1), 'stats_stalled'); assert.equal(ticks.size, 0);
  } finally {
    for (const stop of stops) stop(); globalThis.setInterval = old.interval;
    globalThis.clearInterval = old.clear; Date.now = old.now;
  }
});
