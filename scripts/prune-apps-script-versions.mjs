import fs from 'node:fs';

const scriptId=String(process.env.TV2_SCRIPT_ID||'').trim();
if(!scriptId)throw new Error('TV2_SCRIPT_ID is required');
const config=JSON.parse(fs.readFileSync(process.env.HOME+'/.clasprc.json','utf8'));

function deepFind(obj,names){
  if(!obj||typeof obj!=='object')return '';
  for(const [k,v] of Object.entries(obj)){
    if(names.includes(k)&&typeof v==='string'&&v)return v;
  }
  for(const v of Object.values(obj)){
    const hit=deepFind(v,names);if(hit)return hit;
  }
  return '';
}
const refreshToken=deepFind(config,['refresh_token','refreshToken']);
const clientId=deepFind(config,['clientId','client_id']);
const clientSecret=deepFind(config,['clientSecret','client_secret']);
let accessToken=deepFind(config,['access_token','accessToken']);
if(refreshToken&&clientId&&clientSecret){
  const body=new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  if(!r.ok)throw new Error('OAuth refresh failed: HTTP '+r.status);
  accessToken=String((await r.json()).access_token||'');
}
if(!accessToken)throw new Error('No Apps Script API access token available');

const headers={authorization:'Bearer '+accessToken};
async function api(path,options={}){
  const r=await fetch('https://script.googleapis.com/v1/projects/'+encodeURIComponent(scriptId)+path,{...options,headers:{...headers,...(options.headers||{})}});
  if(!r.ok)throw new Error((options.method||'GET')+' '+path+' failed: HTTP '+r.status+' '+(await r.text()).slice(0,500));
  return r.status===204?null:r.json();
}
const versions=(await api('/versions?pageSize=200')).versions||[];
if(versions.length<195){
  console.log('Apps Script versions: '+versions.length+'; pruning not needed.');
  process.exit(0);
}
const deployments=(await api('/deployments?pageSize=200')).deployments||[];
const used=new Set(deployments.map(d=>Number(d.deploymentConfig&&d.deploymentConfig.versionNumber)).filter(Number.isFinite));
const deletable=versions.map(v=>Number(v.versionNumber)).filter(n=>Number.isFinite(n)&&!used.has(n)).sort((a,b)=>a-b);
const target=Math.max(0,versions.length-180);
if(deletable.length<target)throw new Error('Not enough unreferenced Apps Script versions to prune safely');
for(const n of deletable.slice(0,target))await api('/versions/'+n,{method:'DELETE'});
console.log('Pruned '+target+' unreferenced Apps Script versions; kept deployed versions.');
