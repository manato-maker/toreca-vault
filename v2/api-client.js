const sleep_=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function postJsonOnce_(url,body,label){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),35000);
 try{
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body),signal:controller.signal});
  return await r.json();
 }catch(err){
  if(err&&err.name==='AbortError'){const timeout=new Error(label+'がタイムアウトしました');timeout.code='TV2_TIMEOUT';throw timeout}
  throw err;
 }finally{clearTimeout(timer)}
}
async function postJson(url,body,label){
 try{return await postJsonOnce_(url,body,label)}
 catch(err){
  if(err&&err.code==='TV2_TIMEOUT'){await sleep_(800);return postJsonOnce_(url,body,label)}
  throw err;
 }
}
export async function loadV2(url,token){
 const j=await postJson(url,{action:'load',token},'V2読込');if(!j.ok)throw new Error(j.error||'load failed');return j;
}
export async function saveV2(url,token,next,expectedRevision){
 const body={token,expectedRevision,mutationId:next.lastMutationId,payload:next};
 const j=await postJson(url,body,'V2保存');if(!j.ok)throw new Error(j.conflict?'revision conflict':(j.error||'save failed'));
 const confirmed=await loadV2(url,token);
 const audits=(confirmed.payload&&Array.isArray(confirmed.payload.auditLog)?confirmed.payload.auditLog:[]).filter(x=>x.mutationId===next.lastMutationId);
 if(Number(confirmed.revision)<Number(next.revision)||audits.length!==1)throw new Error('保存後の再読込検証に失敗しました');
 return confirmed;
}
