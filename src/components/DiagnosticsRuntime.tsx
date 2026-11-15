import {syntheticPeerDiagnostics} from '../services/SyntheticPeerDiagnostics';
import {useEffect,useState} from 'react';
import {useAppStore} from '../stores/useAppStore';
import {diagnosticsService} from '../services/DiagnosticsService';
import {APP_VERSION} from '../version';
export function DiagnosticsRuntime(){
  const account=useAppStore(s=>s.authStatus==='authenticated'?s.onlineUser?.id??'':'');
  const room=useAppStore(s=>[s.activeVoiceCommunityId,s.activeVoiceChannelId,...s.voiceRoomParticipants.map(p=>p.user_id+':'+p.joined_at).sort()].join(':'));
  const [,refresh]=useState(0);
  useEffect(()=>diagnosticsService.subscribe(()=>refresh(v=>v+1)),[]);
  useEffect(()=>{diagnosticsService.setAccount(account,APP_VERSION);},[account]);
  useEffect(()=>{diagnosticsService.roomChanged();const state=useAppStore.getState();syntheticPeerDiagnostics.configure(account&&state.activeVoiceCommunityId&&state.activeVoiceChannelId?{community:state.activeVoiceCommunityId,channel:state.activeVoiceChannelId,self:account}:null);return()=>syntheticPeerDiagnostics.configure(null);},[room,account]);
  useEffect(()=>{
    let disposed=false;let unlisten:(()=>void)|undefined;
    void import('@tauri-apps/api/event').then(async({listen})=>{
      const stop=await listen<any>('diagnostics-snapshot',e=>{void diagnosticsService.observe(e.payload);});
      if(disposed)stop();else unlisten=stop;
    }).catch(()=>{});
    return()=>{disposed=true;unlisten?.();};
  },[]);
  if(!Object.values(diagnosticsService.permissions).some(Boolean))return null;
  return <div className="fixed bottom-3 right-3 z-50 rounded-lg border border-nexus-border bg-nexus-panel px-3 py-2 text-xs shadow-lg" role="status"><span>Diagnostics · {diagnosticsService.status}</span><button className="ml-3 underline" onClick={()=>void diagnosticsService.setPermissions({p2p:false,color:false,synthetic:false})}>Desativar</button></div>;
}
