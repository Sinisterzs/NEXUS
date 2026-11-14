let token='', mode='p2p', selected=null;
const $=id=>document.getElementById(id);
const status=t=>{$('status').textContent=t;};
async function api(path,options={}) {
  const response=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},cache:'no-store'});
  if(!response.ok) throw new Error(response.status===403?'Acesso administrativo não autorizado.':response.status===401?'Sessão inválida. Entre novamente.':'Não foi possível consultar os diagnósticos ('+response.status+').');
  return response.json();
}
function cell(row,text){const td=document.createElement('td');td.textContent=String(text??'indisponível');row.append(td);return td;}
function short(id){return id?.slice(0,8)??'?';}
function render(){
  const target=$('events');target.replaceChildren();if(!selected)return;
  const table=document.createElement('table'),head=document.createElement('tr');
  for(const h of ['Direção / papel','Tentativa / geração','Horário / duração','Classificação / evidência','ICE / DTLS','Mídia / cores','Detalhes']){const th=document.createElement('th');th.textContent=h;head.append(th);}table.append(head);
  let rows=selected.events.filter(({event:e})=>(mode==='p2p'?e.kind==='p2p':e.kind!=='p2p')&&['gpu','capture','encoder'].every(k=>!$(k).value||e.metrics[k]===$(k).value));
  if(!$('allSamples').checked){const latest=new Map();for(const item of rows){const e=item.event;latest.set([e.kind,e.participant,e.source,e.destination,e.attempt,e.role,e.metrics.stage??''].join(':'),item);}rows=[...latest.values()];}
  if(rows.length>500){const note=document.createElement('p');note.textContent='Exibindo as últimas 500 amostras filtradas. A exportação contém o conjunto carregado.';target.append(note);rows=rows.slice(-500);}
  for(const item of rows){const e=item.event,m=e.metrics,row=document.createElement('tr');
    cell(row,short(e.source)+' → '+short(e.destination)+' / '+e.role+' · '+short(e.participant));cell(row,e.attempt.slice(0,12)+' / '+e.generation);
    cell(row,new Date(item.received_at).toLocaleString()+' / '+e.elapsed_ms+' ms');cell(row,item.classification+' · '+item.confidence);
    cell(row,(m.iceConnectionState??m.iceState??'—')+' / '+(m.dtlsState??'—')+'; '+(m.localCandidateType??'?')+'/'+(m.remoteCandidateType??'?'));
    cell(row,mode==='p2p'?'bytes: '+(m.bytesReceived??'—')+'; decoded: '+(m.framesDecoded??'—'):'GPU: '+(m.gpu??'—')+'; '+(m.capture??'—')+'; range: '+(m.range??'—')+'; MAE: '+(m.mae??'—'));
    const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Métricas e cores';pre.textContent=JSON.stringify({metrics:m,patches:e.patches??[]},null,2);details.append(summary,pre);const td=document.createElement('td');td.append(details);row.append(td);table.append(row);
  }target.append(table);if(!rows.length)target.textContent='Sem eventos para estes filtros.';
}
async function list(){
  const values=new FormData($('filters')),query=new URLSearchParams();
  for(const key of ['from','to'])if(values.get(key))query.set(key,new Date(String(values.get(key))).toISOString());
  if(values.get('version'))query.set('version',String(values.get('version')));
  query.set('kind',mode==='p2p'?'p2p':'screen');
  const sessions=await api('/sessions?'+query);$('sessions').replaceChildren();
  for(const session of sessions){const b=document.createElement('button');b.textContent=short(session.session_id)+' · '+new Date(session.last).toLocaleString()+' · '+session.events+' eventos';
    b.onclick=async()=>{try{selected=await api('/sessions/'+session.session_id);$('export').disabled=false;render();status('Sessão carregada.');}catch(e){status(e.message);}};$('sessions').append(b);}
  if(!sessions.length)$('sessions').textContent='Nenhuma sessão neste período.';
}
$('login').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);const result=await api('/login',{method:'POST',body:JSON.stringify({login:f.get('login'),password:f.get('password')})});token=result.session_token;e.target.reset();await list();$('auth').hidden=true;$('workspace').hidden=false;status('Acesso autorizado.');}catch(e){token='';status(e.message);}};
$('filters').onsubmit=async e=>{e.preventDefault();try{await list();status('Consulta concluída.');}catch(e){status(e.message);}};
for(const id of ['gpu','capture','encoder','allSamples'])$(id).onchange=render;
for(const id of ['p2p','color'])$(id).onclick=()=>{mode=id;$('p2p').setAttribute('aria-pressed',String(mode==='p2p'));$('color').setAttribute('aria-pressed',String(mode==='color'));$('explanation').textContent=mode==='p2p'?'Estados de conectividade são evidências da etapa, não provas de NAT ou firewall.':'Medições sintéticas são separadas de hipóteses baseadas em metadados. APIs sem acesso ao decoder registram indisponível.';render();list().catch(e=>status(e.message));};
$('logout').onclick=async()=>{try{await api('/logout',{method:'POST',body:'{}'});}catch{}token='';selected=null;$('sessions').replaceChildren();$('events').replaceChildren();$('workspace').hidden=true;$('auth').hidden=false;status('Sessão removida deste navegador.');};
$('export').onclick=()=>{if(!selected)return;const url=URL.createObjectURL(new Blob([JSON.stringify(selected,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='nexus-diagnostics-'+selected.session_id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
