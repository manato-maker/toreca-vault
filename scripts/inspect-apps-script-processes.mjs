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

const q=new URLSearchParams({scriptId,pageSize:'50'});
const res=await fetch('https://script.googleapis.com/v1/processes:listScriptProcesses?'+q,{headers:{authorization:'Bearer '+accessToken}});
if(!res.ok)throw new Error('Process list failed: HTTP '+res.status+' '+(await res.text()).slice(0,500));
const json=await res.json();
const rows=(json.processes||[]).map(p=>({
  functionName:p.functionName||'',
  processType:p.processType||'',
  processStatus:p.processStatus||'',
  startTime:p.startTime||'',
  duration:p.duration||''
}));
console.log(JSON.stringify(rows,null,2));
