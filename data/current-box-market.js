// BOX/バラパック相場ポリシー:
// 大阪日本橋の買取ミミ・AMTAF・アリウムを優先。
// 画像由来の価格は、商品同定を公式商品情報またはGoogle検索で確認できた場合だけ採用する。
// 状態（シュリンク有/無、バラ等）が一致しない価格は流用しない。
export const currentBoxMarketQuotes=[
{product:'ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION',condition:'あり',price:21000,checkedAt:'2026-09-24',source:'AMTAF大阪日本橋 2026-09-24（シュリンクあり）'},
{product:'MEGAドリームex',condition:'あり',price:11500,checkedAt:'2026-09-24',source:'AMTAF大阪日本橋 2026-09-24'},
{product:'インフェルノX',condition:'あり',price:15500,checkedAt:'2026-09-24',source:'AMTAF大阪日本橋 2026-09-24'}
];
export const currentBoxMarketMeta={checkedAt:'2026-09-24',count:currentBoxMarketQuotes.length,stores:['買取ミミ','AMTAF大阪日本橋','カードショップアリウム'],policy:'同一商品・同一状態の3店価格を確認し、確認できた最高買取価格を採用。画像で商品を判断する場合は公式商品情報またはGoogle検索で商品同定後のみ採用。'};
