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
const res=await fetch('https://script.googleapis.com/v1/projects/'+encodeURIComponent(scriptId)+'/deployments?pageSize=50',{headers:{authorization:'Bearer '+accessToken}});
const raw=await res.text();
if(!res.ok)throw new Error('Deployment list failed: HTTP '+res.status+' '+raw.slice(0,1000));
const json=JSON.parse(raw);
const rows=(json.deployments||[]).map(d=>({
 deploymentId:d.deploymentId||'',
 versionNumber:d.deploymentConfig?.versionNumber??null,
 description:d.deploymentConfig?.description||'',
 entryPoints:(d.entryPoints||[]).map(e=>({
   type:e.entryPointType||'',
   webAppAccess:e.webApp?.access||'',
   executeAs:e.webApp?.executeAs||''
 }))
}));
console.log(JSON.stringify(rows,null,2));
