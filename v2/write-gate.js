const KEY='toreca-vault:v2:write-enabled';
const REVISION_KEY='toreca-vault:v2:write-revision';

function migrateLegacySessionGate(){
 if(localStorage.getItem(KEY)==='yes')return;
 if(sessionStorage.getItem(KEY)==='yes'){
  localStorage.setItem(KEY,'yes');
  const revision=sessionStorage.getItem(REVISION_KEY);
  if(revision!=null)localStorage.setItem(REVISION_KEY,revision);
 }
}

export function isV2WriteEnabled(expectedRevision){
 migrateLegacySessionGate();
 return localStorage.getItem(KEY)==='yes';
}
export function enableV2WriteForSession(phrase,revision){
 if(String(phrase||'').trim()!=='V2書込を有効化')throw new Error('確認文が一致しません');
 if(!Number.isInteger(Number(revision))||Number(revision)<0)throw new Error('V2 revisionが不正です');
 localStorage.setItem(KEY,'yes');localStorage.setItem(REVISION_KEY,String(revision));
 sessionStorage.removeItem(KEY);sessionStorage.removeItem(REVISION_KEY);
 return true;
}
export function advanceV2WriteRevision(revision){
 migrateLegacySessionGate();
 if(localStorage.getItem(KEY)!=='yes')return false;
 if(!Number.isInteger(Number(revision))||Number(revision)<0)throw new Error('V2 revisionが不正です');
 localStorage.setItem(REVISION_KEY,String(revision));return true;
}
export function disableV2Write(){
 localStorage.removeItem(KEY);localStorage.removeItem(REVISION_KEY);
 sessionStorage.removeItem(KEY);sessionStorage.removeItem(REVISION_KEY);
}
export function assertV2WriteEnabled(expectedRevision){
 if(!isV2WriteEnabled(expectedRevision))throw new Error('V2書込はこの端末で有効化されていません');
 return true;
}
