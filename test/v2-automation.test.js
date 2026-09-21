import test from'node:test';import assert from'node:assert/strict';import{emptyV2}from'../v2/core.js';import{matchLottery,mergeLotteryMail,applyMarketFetch,recordAutomationHealth,runMarketBatch,runLotteryBatch,normalizeLotteryMail,prepareLotteryMailBatch,parseLivePocketLotteryMail,classifyTradingCardLottery,prepareLotteryMailForMerge,parseToysRUsLotteryMail,parseGoogleFormLotteryMail}from'../v2/automation.js';
test('same application id duplicates are ignored, not review',()=>{const s=emptyV2();s.lotteries=[{id:'a',applicationId:'104'},{id:'b',applicationId:'104'}];assert.equal(matchLottery(s.lotteries,{applicationId:'104'}).kind,'duplicate');assert.equal(mergeLotteryMail(s,{applicationId:'104'}).outcome,'duplicate')});
test('truly ambiguous fallback goes to review',()=>{const s=emptyV2();s.lotteries=[{id:'a',store:'X',product:'Y'},{id:'b',store:'X',product:'Y'}];assert.equal(matchLottery(s.lotteries,{store:'X',product:'Y'}).kind,'review')});
test('market fetch failure preserves prior quote',()=>{const s=emptyV2();s.marketQuotes=[{productKey:'p',condition:'あり',price:100,history:[]}];const r=applyMarketFetch(s,{productKey:'p',product:'P',category:'BOX',condition:'あり'},{ok:false});assert.equal(r.outcome,'preserved');assert.equal(r.state.marketQuotes[0].price,100)});
test('market success updates quote and history',()=>{const s=emptyV2();const r=applyMarketFetch(s,{productKey:'p',product:'P',category:'BOX',condition:'あり'},{ok:true,price:120,checkedAt:'2026-09-19',source:'S'});assert.equal(r.state.marketQuotes[0].price,120);assert.equal(r.state.marketQuotes[0].history.length,1)});
test('health retains last success across failure',()=>{let s=recordAutomationHealth(emptyV2(),'market',{ok:true,at:'a',externalFetchCount:2});s=recordAutomationHealth(s,'market',{ok:false,at:'b',error:'x'});assert.equal(s.automation.health.market.lastSuccessAt,'a');assert.equal(s.automation.health.market.lastFailureAt,'b')});

test('market batch preserves failed quote and records health',()=>{const s=emptyV2();s.marketQuotes=[{productKey:'p',condition:'あり',price:100,history:[]}];const r=runMarketBatch(s,[{productKey:'p',product:'P',category:'BOX',condition:'あり'}],()=>({ok:false}),'t');assert.equal(r.preserved,1);assert.equal(r.state.marketQuotes[0].price,100);assert.equal(r.state.automation.health.market.ok,false)});
test('lottery batch counts duplicate without review',()=>{const s=emptyV2();s.lotteries=[{id:'a',applicationId:'104'},{id:'b',applicationId:'104'}];const r=runLotteryBatch(s,[{applicationId:'104'}],'t');assert.equal(r.duplicate,1);assert.equal(r.review,0);assert.equal(r.state.automation.health.lottery.ok,true)});

test('lottery mail without stable id is review and cannot create a record',()=>{const s=emptyV2();const r=mergeLotteryMail(s,{store:'X',product:'Y'});assert.equal(r.outcome,'review');assert.equal(r.state.lotteries.length,0)});
test('lottery batch rejects non-array input',()=>{assert.throws(()=>runLotteryBatch(emptyV2(),null,'t'),/array/)});


test('lottery mail normalization rejects unstable or incomplete records',()=>{assert.equal(normalizeLotteryMail({store:'X',product:'Y'}).reason,'missing-stable-id');assert.equal(normalizeLotteryMail({id:'m1',store:'X'}).reason,'missing-store-or-product')});
test('lottery mail normalization trims accepted fields',()=>{const r=normalizeLotteryMail({id:' m1 ',store:' X ',product:' Y ',applicationId:' 104 '});assert.equal(r.ok,true);assert.deepEqual(r.input,{id:'m1',applicationId:'104',store:'X',product:'Y'})});
test('lottery mail batch separates review items before merge',()=>{const r=prepareLotteryMailBatch([{id:'m1',store:'X',product:'Y'},{store:'X',product:'Y'}]);assert.equal(r.accepted.length,1);assert.equal(r.review.length,1);assert.equal(r.review[0].reason,'missing-stable-id')});


test('LivePocket application mail parses stable id venue product and status',()=>{const r=parseLivePocketLotteryMail({id:'m1',subject:'[LivePocket]抽選申込完了のお知らせ（1048795963）',body:'下記のチケットの申込みが完了しました。\nイベント名：古本市場猪名寺店　ポケカ抽選販売　「プレミアムデッキエーフィ・ブラッキー」\n会場：古本市場猪名寺店（兵庫県）\n申込番号：1048795963'});assert.equal(r.ok,true);assert.equal(r.input.applicationId,'1048795963');assert.equal(r.input.status,'応募済み');assert.match(r.input.product,/プレミアムデッキ/)});
test('LivePocket result mail parses rejection without guessing',()=>{const r=parseLivePocketLotteryMail({id:'m2',subject:'[LivePocket]抽選結果のお知らせ（1038419350）',body:'下記のお申込みについては、残念ながら落選となりました。\nイベント名：ポケモンカードゲーム拡張パック「30th CELEBRATION」【Ｂグループ】購入権抽選\n会場：イエローサブマリン（その他）\n申込番号：1038419350'});assert.equal(r.ok,true);assert.equal(r.input.status,'落選');assert.equal(r.input.applicationId,'1038419350')});
test('LivePocket parser fails closed on unknown status or missing fields',()=>{assert.equal(parseLivePocketLotteryMail({id:'m3',subject:'[LivePocket]通知（123456）',body:'イベント名：X\n会場：Y\n申込番号：123456'}).review,true);assert.equal(parseLivePocketLotteryMail({id:'m4',subject:'other',body:'x'}).review,true)});




test('LivePocket parser accepts trading card games beyond Pokemon',()=>{
 for(const [id,event] of [['1046856255',"ワンピースカードゲーム 『蒼海の七傑』"],['1046856256','ドラゴンボールスーパーカードゲーム'],['1046856257','UNION ARENA ユニオンアリーナ'],['1046856258','遊戯王OCG']]){
  const r=parseLivePocketLotteryMail({id:'mail-'+id,subject:'[LivePocket]抽選結果のお知らせ（'+id+'）',body:'残念ながら落選となりました。\nイベント名：'+event+' 抽選販売\n会場：トレカ店\n申込番号：'+id});
  assert.equal(r.ok,true);assert.equal(r.input.status,'落選');
 }
});


test('trading card lottery classifier recognizes major TCGs without excluding others',()=>{
 assert.equal(classifyTradingCardLottery('ポケモンカードゲーム'),'pokemon');
 assert.equal(classifyTradingCardLottery('ONE PIECE カードゲーム'),'one-piece');
 assert.equal(classifyTradingCardLottery('ドラゴンボールスーパーカードゲーム'),'dragon-ball');
 assert.equal(classifyTradingCardLottery('UNION ARENA'),'union-arena');
 assert.equal(classifyTradingCardLottery('遊戯王OCG'),'yu-gi-oh');
 assert.equal(classifyTradingCardLottery('新作トレーディングカード抽選'),'other-tcg');
});


test('LivePocket parser carries TCG classification through normalization',()=>{
 const cases=[['ポケモンカードゲーム','pokemon'],['ワンピースカードゲーム','one-piece'],['ドラゴンボールスーパーカードゲーム','dragon-ball'],['UNION ARENA','union-arena'],['遊戯王OCG','yu-gi-oh']];
 for(let i=0;i<cases.length;i++){const [event,tcg]=cases[i],id=String(1050000000+i);const r=parseLivePocketLotteryMail({id:'tcg-'+i,subject:'[LivePocket]抽選申込完了のお知らせ（'+id+'）',body:'下記のチケットの申込みが完了しました。\nイベント名：'+event+' 抽選販売\n会場：トレカ店\n申込番号：'+id});assert.equal(r.ok,true);assert.equal(r.input.tcg,tcg)}
});


test('lottery mail preparation pipeline accepts parsed TCG mail and quarantines unknown mail',()=>{
 const ok=prepareLotteryMailForMerge({id:'pipe-1',subject:'[LivePocket]抽選申込完了のお知らせ（1051234567）',body:'申込みが完了しました。\nイベント名：ONE PIECE カードゲーム 抽選販売\n会場：カードショップ\n申込番号：1051234567'});
 assert.equal(ok.accepted.length,1);assert.equal(ok.review.length,0);assert.equal(ok.accepted[0].tcg,'one-piece');
 const bad=prepareLotteryMailForMerge({id:'pipe-2',subject:'不明な抽選メール',body:'結果'});
 assert.equal(bad.accepted.length,0);assert.equal(bad.review.length,1);assert.equal(bad.review[0].reason,'not-livepocket-or-missing-id');
});


test('ToysRUs parser extracts product and pickup store without persisting member number',()=>{
 const r=parseToysRUsLotteryMail({id:'toys-1',subject:'申込受付完了『 ポケモンカードゲーム MEGA 30th CELEBRATION カードセット ボックス販売』',body:'ご応募ありがとうございました。\n会員番号「0000-0000-0000」にて『 ポケモンカードゲーム MEGA 30th CELEBRATION カードセット ボックス販売』の抽選受付が完了しました。\n受取登録店舗は「奈良橿原店」です。\n落選の場合はご連絡いたしません。\n●配信元：日本トイザらス株式会社'});
 assert.equal(r.ok,true);assert.equal(r.input.store,'トイザらス 奈良橿原店');assert.equal(r.input.tcg,'pokemon');assert.equal(r.input.status,'応募済み');assert.equal(JSON.stringify(r.input).includes('0000-0000-0000'),false);
});
test('ToysRUs parser fails closed on incomplete or unrelated mail',()=>{
 assert.equal(parseToysRUsLotteryMail({id:'toys-2',subject:'申込受付完了『商品』',body:'抽選受付が完了しました。'}).review,true);
 assert.equal(parseToysRUsLotteryMail({id:'',subject:'申込受付完了『商品』',body:'●配信元：日本トイザらス株式会社'}).review,true);
});


test('Google Forms lottery parser accepts one selected product and strips personal fields',()=>{
 const r=parseGoogleFormLotteryMail({id:'gf-1',subject:'フォームにご記入いただきありがとうございます: ONE PIECEカードゲーム【OP-17】抽選販売応募フォーム',body:'フォームの回答\nこちらはトレカプラザ55通販店の抽選販売応募フォームです\n顧客ID *\n123456789\nお名前 *\nテスト太郎\n✓\nブースターパック 「世界最強の戦士」1BOX(24パック) ¥5,760'});
 assert.equal(r.ok,true);assert.equal(r.input.store,'トレカプラザ55通販店');assert.equal(r.input.tcg,'one-piece');assert.equal(JSON.stringify(r.input).includes('123456789'),false);assert.equal(JSON.stringify(r.input).includes('テスト太郎'),false);
});
test('Google Forms lottery parser sends multi-product responses to review',()=>{
 const r=parseGoogleFormLotteryMail({id:'gf-2',subject:'フォームにご記入いただきありがとうございます: 【なんば店】抽選応募フォーム',body:'This form is owned by カードラボ ゲーマーズ.\n✓\n商品A\n✓\n商品B'});
 assert.equal(r.review,true);assert.equal(r.reason,'multiple-products-review');
});
