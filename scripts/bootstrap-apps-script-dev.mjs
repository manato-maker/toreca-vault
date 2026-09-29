import fs from 'node:fs';
const scriptId=String(process.env.TV2_SCRIPT_ID||'').trim();
if(!scriptId)throw new Error('TV2_SCRIPT_ID is required');
const cfg=JSON.parse(fs.readFileSync(process.env.HOME+'/.clasprc.json','utf8'));
function find(obj,names){
  if(!obj||typeof obj!=='object')return '';
  for(const [k,v] of Object.entries(obj))if(names.includes(k)&&typeof v==='string'&&v)return v;
  for(const v of Object.values(obj)){const hit=find(v,names);if(hit)return hit}
  return '';
}
const refreshToken=find(cfg,['refresh_token','refreshToken']);
const clientId=find(cfg,['clientId','client_id']);
const clientSecret=find(cfg,['clientSecret','client_secret']);
let accessToken=find(cfg,['access_token','accessToken']);
if(refreshToken&&clientId&&clientSecret){
  const body=new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'});
  const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  if(!res.ok)throw new Error('OAuth refresh failed: HTTP '+res.status);
  accessToken=String((await res.json()).access_token||'');
}
if(!accessToken)throw new Error('No access token');

const depRes=await fetch('https://script.googleapis.com/v1/projects/'+encodeURIComponent(scriptId)+'/deployments?pageSize=50',{headers:{authorization:'Bearer '+accessToken}});
if(!depRes.ok)throw new Error('Deployment list failed: HTTP '+depRes.status);
const deps=(await depRes.json()).deployments||[];
const head=deps.find(d=>d.deploymentConfig?.versionNumber==null&&(d.entryPoints||[]).some(e=>e.entryPointType==='WEB_APP'));
if(!head)throw new Error('HEAD web app deployment not found');
const webEntry=(head.entryPoints||[]).find(e=>e.entryPointType==='WEB_APP');
const base=String(webEntry&&webEntry.webApp&&webEntry.webApp.url||'');
if(!base)throw new Error('HEAD web app URL not available');

async function request(url,options={}){
  const res=await fetch(url,{...options,headers:{authorization:'Bearer '+accessToken,...(options.headers||{})},redirect:'follow'});
  const text=await res.text();
  let json=null;try{json=JSON.parse(text)}catch(_){}
  if(!res.ok)throw new Error('HEAD web app HTTP '+res.status);
  if(!json)throw new Error('HEAD web app did not return JSON');
  return json;
}
const status=await request(base+'?action=automation-status');
if(!status.ok)throw new Error('automation status failed');
const boot=await request(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'bootstrap-automation'})});
if(!boot.ok)throw new Error('automation bootstrap failed');
console.log(JSON.stringify({ok:true,before:status,after:boot.status,run:boot.run},null,2));
