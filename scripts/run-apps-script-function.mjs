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

const fn=String(process.argv[2]||'tv2AutomationStatus');
const body={function:fn,devMode:true};
const res=await fetch('https://script.googleapis.com/v1/scripts/'+encodeURIComponent(scriptId)+':run',{
  method:'POST',
  headers:{authorization:'Bearer '+accessToken,'content-type':'application/json'},
  body:JSON.stringify(body)
});
const raw=await res.text();
let json={};try{json=JSON.parse(raw)}catch(_){}
if(!res.ok)throw new Error('Execution API HTTP '+res.status+' '+raw.slice(0,1000));
if(json.error)throw new Error('Execution API script error: '+JSON.stringify(json.error).slice(0,1500));
console.log(JSON.stringify({ok:true,function:fn,response:json.response?.result??null},null,2));
