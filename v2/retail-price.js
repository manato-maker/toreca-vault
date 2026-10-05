export const RETAIL_PRICE_POLICY_VERSION='msrp-non-single-v2';
const norm=x=>String(x||'').normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/g,' ').trim();
const CATALOG=[
 {test:/30th celebration.*カードセット.*9種|カードセット.*9種/,fixed:10800,source:'ポケモンカード公式 30周年商品（9種セット）',url:'https://www.pokemon-card.com/info/005510.html'},
 {test:/30th celebration.*futuristic box|futuristic box/,fixed:27500,source:'ポケモンカード公式 30周年商品',url:'https://www.30th.pokemon-card.com/product/furbox'},
 {test:/30th celebration.*プレミアムデッキセット|プレミアムデッキセット.*エーフィ.*ブラッキー/,fixed:6200,source:'ポケモンカード公式 商品情報',url:'https://www.pokemon-card.com/products/index.html?productType=construction'},
 {test:/30th celebration.*カードセット/,fixed:1200,source:'ポケモンカード公式 30周年商品',url:'https://www.30th.pokemon-card.com/product/cardset'},
 {test:/スペシャルbox ポケモンセンター(?:トウホク|フクオカ|ヒロシマ)/,fixed:2090,source:'ポケモンカード公式 商品情報',url:'https://www.pokemon-card.com/info/005053.html'},
 {test:/スタートデッキ100.*バトルコレクション|mega スタートデッキ100/,fixed:891,source:'ポケモンカード公式 商品情報',url:'https://www.pokemon-card.com/ex/mc/index.html'},
 {test:/マクドナルド.*プロモカードパック/,fixed:0,source:'非売品プロモ（購入原価0円）',url:''},
 {test:/30th celebration/,pack:360,box:7200,source:'ポケモンカード公式 30周年商品',url:'https://www.30th.pokemon-card.com/product/m6a'},
 {test:/ストームエメラルダ/,pack:200,box:6000,source:'ポケモンカード公式',url:'https://www.pokemon-card.com/ex/m6/'},
 {test:/アビスアイ/,pack:200,box:6000,source:'ポケモンカード公式',url:'https://www.pokemon-card.com/ex/m5/'},
 {test:/ニンジャスピナー/,pack:180,box:5400,source:'ポケモンカード公式',url:'https://www.pokemon-card.com/ex/m4/'},
 {test:/ムニキスゼロ/,pack:180,box:5400,source:'ポケモンカード公式',url:'https://www.pokemon-card.com/ex/m3/'},
 {test:/megaドリームex/,pack:550,box:5500,source:'ポケモンカード公式（1パック550円・BOX10パック換算）',url:'https://www.pokemon-card.com/ex/m2a/index.html'},
 {test:/インフェルノx/,pack:180,box:5400,source:'ポケモンカード公式',url:'https://www.pokemon-card.com/ex/m2/'},
 {test:/メガブレイブ|メガシンフォニア/,pack:180,box:5400,source:'ポケモンカード公式',url:'https://www.pokemon-card.com/ex/m1/'},
 {test:/ブラックボルト(?!.*デラックス)/,pack:290,box:5800,source:'ポケモンカード公式（1パック290円・BOX20パック換算）',url:'https://www.pokemon-card.com/ex/sv11/index.html'},
 {test:/brightness of hope/,pack:240,box:5760,source:'ドラゴンボール フュージョンワールド公式',url:'https://www.dbs-cardgame.com/fw/jp/events/01_495.html'},
 {test:/決戦の刻.*op-?16|op-?16.*決戦の刻/,pack:220,box:5280,source:'ONE PIECE公式（1パック220円・BOX24パック換算）',url:'https://one-piece.com/news/79716/index.html'},
 {test:/世界最強の戦士.*op-?17|op-?17.*世界最強の戦士/,pack:240,box:5760,source:'BANDAI公式（1パック240円・BOX24パック換算）',url:'https://www.bandai.co.jp/catalog/item.php?jan_cd=4582770058390000'}
];
function choosePrice(hit,n,c,quantity){
 if(hit.fixed!=null)return hit.fixed;
 if(c==='パック')return hit.pack;
 if(c==='BOX')return hit.box;
 const q=Number(quantity)||1;
 if(/(?:^|\D)(\d+)\s*box分/.test(n)&&q===1){const m=n.match(/(?:^|\D)(\d+)\s*box分/);return hit.box*Number(m[1]);}
 if(/box|ボックス|シュリンク|テープ/.test(n))return hit.box;
 if(q>=5)return hit.pack;
 return hit.box;
}
export function retailPriceInfo(product,category,quantity=1){
 const c=String(category||'').trim(),n=norm(product);if(!n||c==='カード')return null;
 const hit=CATALOG.find(x=>x.test.test(n));if(!hit)return null;
 const price=choosePrice(hit,n,c,quantity);return Number.isFinite(price)?{price,source:hit.source,url:hit.url,basis:'希望小売価格'}:null;
}
