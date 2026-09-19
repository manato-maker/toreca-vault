const KEY='toreca-vault:v2:write-enabled';
export function isV2WriteEnabled(){return sessionStorage.getItem(KEY)==='yes'}
export function enableV2WriteForSession(phrase){
 if(String(phrase||'').trim()!=='V2書込を有効化')throw new Error('確認文が一致しません');
 sessionStorage.setItem(KEY,'yes');return true;
}
export function disableV2Write(){sessionStorage.removeItem(KEY)}
export function assertV2WriteEnabled(){if(!isV2WriteEnabled())throw new Error('V2書込はこのセッションで有効化されていません');return true}
