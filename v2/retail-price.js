export const RETAIL_PRICE_POLICY_VERSION='msrp-non-single-v1';
const norm=x=>String(x||'').normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/g,' ').trim();
const CATALOG=[
 {category:'BOX',test:/30th celebration.*カードセット.*9種|カードセット.*9種/,price:10800,source:'ポケモンカード公式 30周年商品（9種セット）',url:'https://www.pokemon-card.com/info/005510.html'},
 {category:'BOX',test:/30th celebration.*futuristic box|futuristic box/,price:27500,source:'ポケモンカード公式 30周年商品',url:'https://www.30th.pokemon-card.com/product/furbox'},
 {category:'BOX',test:/30th celebration.*プレミアムデッキセット|プレミアムデッキセット.*エーフィ.*ブラッキー/,price:6200,source:'ポケモンカード公式 30周年商品',url:'https://www.pokemon-card.com/info/005510.html'},
 {category:'BOX',test:/30th celebration.*カードセット/,price:1200,source:'ポケモンカード公式 30周年商品',url:'https://www.30th.pokemon-card.com/product/cardset'},
 {category:'BOX',test:/30th celebration/,price:7200,source:'ポケモンカード公式 30周年商品',url:'https://www.pokemon-card.com/info/005510.html'},
 {category:'パック',test:/30th celebration/,price:360,source:'ポケモンカード公式 30周年商品',url:'https://www.30th.pokemon-card.com/product/m6a'},
 {category:'BOX',test:/ストームエメラルダ/,price:6000,source:'ポケモンカード公式（1パック200円×30パック）',url:'https://www.pokemon-card.com/ex/m6/'},
 {category:'パック',test:/ストームエメラルダ/,price:200,source:'ポケモンカード公式',url:'https://www.pokemon-card.com/ex/m6/'},
 {category:'BOX',test:/インフェルノx/,price:5400,source:'ポケモンカード公式（1パック180円×30パック）',url:'https://www.pokemon-card.com/ex/m2/'},
 {category:'パック',test:/インフェルノx/,price:180,source:'ポケモンカード公式',url:'https://www.pokemon-card.com/ex/m2/'},
 {category:'BOX',test:/brightness of hope/,price:5760,source:'ドラゴンボール フュージョンワールド公式（1BOX 24パック）',url:'https://www.dbs-cardgame.com/fw/jp/events/01_495.html'},
 {category:'パック',test:/brightness of hope/,price:240,source:'ドラゴンボール フュージョンワールド公式',url:'https://www.dbs-cardgame.com/fw/jp/products/'}
];
export function retailPriceInfo(product,category){
 const c=String(category||'').trim(),n=norm(product);if(!n||c==='カード')return null;
 const hit=CATALOG.find(x=>x.category===c&&x.test.test(n));return hit?{price:hit.price,source:hit.source,url:hit.url,basis:'希望小売価格'}:null;
}
