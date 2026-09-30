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

async function loadViaJsonp_(url,token){
 if(typeof document==='undefined'||typeof window==='undefined'){
  const unavailable=new Error('JSONP unavailable');unavailable.code='TV2_JSONP_UNAVAILABLE';throw unavailable;
 }
 return await new Promise((resolve,reject)=>{
  const callback='__tv2_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  const script=document.createElement('script');
  const cleanup=()=>{clearTimeout(timer);try{delete window[callback]}catch{};try{script.remove()}catch{}};
  const fail=(message,code='TV2_JSONP_FAILED')=>{cleanup();const err=new Error(message);err.code=code;reject(err)};
  const timer=setTimeout(()=>fail('V2読込がタイムアウトしました','TV2_TIMEOUT'),5000);
  window[callback]=data=>{cleanup();resolve(data)};
  script.async=true;
  script.src=url+'?'+new URLSearchParams({action:'load',token,callback,ts:String(Date.now())}).toString();
  script.onerror=()=>fail('V2読込でGoogleへの接続に失敗しました');
  document.head.appendChild(script);
 });
}

async function loadViaGet_(url,token){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
 try{
  const query=new URLSearchParams({action:'load',token,ts:String(Date.now())});
  const raw=await fetchText_(url+'?'+query.toString(),{method:'GET',cache:'no-store',redirect:'follow',signal:controller.signal});
  return parseJsonResponse_(raw,'V2読込');
 }catch(err){
  if(err&&err.name==='AbortError'){const timeout=new Error('V2読込がタイムアウトしました');timeout.code='TV2_TIMEOUT';throw timeout}
  throw err;
 }finally{clearTimeout(timer)}
}

export async function loadV2(url,token){
 let j,jsonpErr=null,getErr=null;
 if(typeof document!=='undefined'&&typeof window!=='undefined'){
  try{
   // Apps Script JSONP uses the existing lock-free doGet path and avoids CORS/
   // redirect instability seen with fetch in installed mobile browsers.
   j=await loadViaJsonp_(url,token);
  }catch(err){jsonpErr=err}
 }
 if(!j){
  try{j=await loadViaGet_(url,token)}
  catch(err){getErr=err}
 }
 if(!j){
  try{j=await postJsonOnce_(url,{action:'load',token},'V2読込',5000)}
  catch(postErr){
   const reason=[jsonpErr&&jsonpErr.message,getErr&&getErr.message,postErr&&postErr.message].filter(Boolean).join(' / ');
   const failed=new Error(reason||'V2読込に失敗しました');failed.code='TV2_READ_FAILED';throw failed;
  }
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
