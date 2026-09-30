const sleep_=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function parseJsonResponse_(raw,label){
 try{return JSON.parse(String(raw||''))}
 catch(_){
  const err=new Error(label+'でGoogle側がJSON以外を返しました');
  err.code='TV2_NON_JSON';
  throw err;
 }
}

async function fetchText_(url,options){
 const r=await fetch(url,options);
 if(typeof r.text==='function')return await r.text();
 if(typeof r.json==='function')return JSON.stringify(await r.json());
 throw new Error('V2 API response body is unavailable');
}

async function postJsonOnce_(url,body,label,timeoutMs=35000){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const raw=await fetchText_(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body),signal:controller.signal,redirect:'follow'});
  return parseJsonResponse_(raw,label);
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

async function loadViaGet_(url,token){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const query=new URLSearchParams({action:'load',token,ts:String(Date.now())});
  const raw=await fetchText_(url+'?'+query.toString(),{method:'GET',cache:'no-store',redirect:'follow',signal:controller.signal});
  return parseJsonResponse_(raw,'V2読込');
 }catch(err){
  if(err&&err.name==='AbortError')throw new Error('V2読込がタイムアウトしました');
  throw err;
 }finally{clearTimeout(timer)}
}

export async function loadV2(url,token){
 let j;
 try{
  // Reads should never sit behind a slow Apps Script POST for a minute.
  // Give POST a short chance, then use the read-only GET endpoint.
  j=await postJsonOnce_(url,{action:'load',token},'V2読込',8000);
 }catch(err){
  if(!err||!['TV2_TIMEOUT','TV2_NON_JSON'].includes(err.code))throw err;
  j=await loadViaGet_(url,token);
 }
 if(!j.ok)throw new Error(j.error||'load failed');
 return j;
}

export async function saveV2(url,token,next,expectedRevision){
 const body={token,expectedRevision,mutationId:next.lastMutationId,payload:next};
 const j=await postJson(url,body,'V2保存');if(!j.ok)throw new Error(j.conflict?'revision conflict':(j.error||'save failed'));
 const confirmed=await loadV2(url,token);
 const audits=(confirmed.payload&&Array.isArray(confirmed.payload.auditLog)?confirmed.payload.auditLog:[]).filter(x=>x.mutationId===next.lastMutationId);
 if(Number(confirmed.revision)<Number(next.revision)||audits.length!==1)throw new Error('保存後の再読込検証に失敗しました');
 return confirmed;
}
