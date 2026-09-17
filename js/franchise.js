const normalize=value=>String(value||'').normalize('NFKC').toLowerCase();

export function franchiseOf(item={}){
  if(['ポケモン','ワンピース','その他'].includes(item.franchise))return item.franchise;
  const text=normalize([item.product,item.title,item.name,item.set,item.memo].filter(Boolean).join(' '));
  if(/one\s*piece|ワンピース|op-?\d{1,2}|世界最強の戦士|受け継がれる意志|蒼海の七傑|決戦の刻/.test(text))return'ワンピース';
  if(/ポケモン|pokemon|30th celebration|megaドリーム|mega dream|インフェルノx|ストームエメラルダ|メガブレイブ|メガシンフォニア|スタートデッキ100|エーフィ|ブラッキー|ピカチュウ/.test(text))return'ポケモン';
  return'その他';
}

export const FRANCHISES=['ポケモン','ワンピース','その他'];
