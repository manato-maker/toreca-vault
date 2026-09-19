export async function loadV2(url,token){
 const r=await fetch(url+'?'+new URLSearchParams({action:'load',token,ts:String(Date.now())}));
 const j=await r.json();if(!j.ok)throw new Error(j.error||'load failed');return j;
}
export async function saveV2(url,token,next,expectedRevision){
 const body={token,expectedRevision,mutationId:next.lastMutationId,payload:next};
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body)});
 const j=await r.json();if(!j.ok)throw new Error(j.conflict?'revision conflict':(j.error||'save failed'));
 const confirmed=await loadV2(url,token);
 if(confirmed.lastMutationId!==next.lastMutationId||Number(confirmed.revision)!==Number(next.revision))throw new Error('保存後の再読込検証に失敗しました');
 return confirmed;
}
