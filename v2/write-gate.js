const KEY='toreca-vault:v2:write-enabled';
const REVISION_KEY='toreca-vault:v2:write-revision';
export function isV2WriteEnabled(expectedRevision){
 const enabled=sessionStorage.getItem(KEY)==='yes';
 if(!enabled)return false;
 if(expectedRevision==null)return true;
 return sessionStorage.getItem(REVISION_KEY)===String(expectedRevision);
}
export function enableV2WriteForSession(phrase,revision){
 if(String(phrase||'').trim()!=='V2書込を有効化')throw new Error('確認文が一致しません');
 if(!Number.isInteger(Number(revision))||Number(revision)<0)throw new Error('V2 revisionが不正です');
 sessionStorage.setItem(KEY,'yes');sessionStorage.setItem(REVISION_KEY,String(revision));return true;
}
export function advanceV2WriteRevision(revision){
 if(sessionStorage.getItem(KEY)!=='yes')return false;
 if(!Number.isInteger(Number(revision))||Number(revision)<0)throw new Error('V2 revisionが不正です');
 sessionStorage.setItem(REVISION_KEY,String(revision));return true;
}
export function disableV2Write(){sessionStorage.removeItem(KEY);sessionStorage.removeItem(REVISION_KEY)}
export function assertV2WriteEnabled(expectedRevision){if(!isV2WriteEnabled(expectedRevision))throw new Error('V2書込はこのrevisionで有効化されていません');return true}
