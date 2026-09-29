const DATA_FILE_ID = PropertiesService.getScriptProperties().getProperty('TV_DATA_FILE_ID');
const TZ = 'Asia/Tokyo';
const MAX_IDS = 3000;
const RESULT_WORDS = /(当選|ご当選|落選|残念|抽選結果)/;
const APPLICATION_WORDS = /(抽選申込完了|抽選申込み受付完了|申込受付完了|申込み受付完了|申し込み受付完了|抽選販売応募完了|応募完了|申込みが完了|申込完了|申込み完了|申込み受付が完了|お申込み受付が完了|抽選販売へのお申込み受付)/;
const CARD_WORDS = /(ポケモン|ポケカ|ONE ?PIECE|ワンピース|ドラゴンボール|ウマ娘|遊戯王|YU[- ]?GI[- ]?OH|遊戯王OCG|UNION ?ARENA|ユニオンアリーナ)/i;

function installTorecaVaultAutomation() {
  return installTv2Automation();
}

function runTorecaVaultLotterySync() {
  tv2EnsureSimpleAutomationSchedule_(true);
  return runTv2Automation();
}

function runTorecaVaultMarketSync() {
  tv2EnsureSimpleAutomationSchedule_(true);
  return runTv2Automation();
}

function validate_(root) {
  if (!root || root.app !== 'toreca-vault' || !root.data) throw new Error('Toreca Vault JSONではありません');
  ['lotteries','purchases','boxes','packs','cards','openings','sales','products'].forEach(k => {
    if (!Array.isArray(root.data[k])) throw new Error(k + ' が配列ではありません');
  });
}

function matchLottery_(lotteries, text) {
  const applicationNo = extractApplicationNo_(text);
  if (applicationNo) {
    const byNo = lotteries.filter(x => String(x.id || '').includes(applicationNo) || String(x.memo || '').includes(applicationNo));
    if (byNo.length === 1) return { kind: 'match', item: byNo[0] };
    if (byNo.length > 1) return { kind: 'review', reason: '申込番号が複数の登録に一致' };
  }

  const hay = normalize_(text);
  const candidates = lotteries.filter(x => {
    const title = productKey_(x.title || '');
    const store = storeKey_(x.store || '');
    return title && store && productMatches_(hay, title) && storeMatches_(hay, store);
  });
  if (candidates.length === 1) return { kind: 'match', item: candidates[0] };
  if (candidates.length > 1) return { kind: 'review', reason: '登録済み抽選が複数一致' };

  const productOnly = lotteries.filter(x => {
    const title = productKey_(x.title || '');
    return title && productMatches_(hay, title);
  });
  if (productOnly.length === 1) return { kind: 'match', item: productOnly[0] };
  if (productOnly.length > 1) return { kind: 'review', reason: '商品は一致したが店舗を特定できない' };
  return { kind: 'outside' };
}

function upsertApplication_(lotteries, text, message, now) {
  let applicationNo = extractApplicationNo_(text);
  const sourceText=[text, String(message.getFrom ? message.getFrom() : '')].join('\n');
  const isToysRUs = /toysrus|トイザらス|las\.toysrus\.co\.jp/i.test(sourceText);
  const isSanyodo = /三洋堂|select-type\.com/i.test(sourceText);
  const isGeo = /geonet\.jp|ゲオ|GEO/i.test(sourceText);
  if (!applicationNo && (isToysRUs || isSanyodo || isGeo)) applicationNo = 'mail-' + message.getId();
  if (!applicationNo) return { kind: 'review', reason: '申込番号を抽出できない' };
  if (lotteries.some(x => String(x.id || '').includes(applicationNo) || String(x.memo || '').includes(applicationNo))) {
    return { kind: 'duplicate' };
  }
  let title = extractLineValue_(text, /^(?:イベント名|商品名)\s*[:：]/m);
  if (!title && isToysRUs) { const m = String(message.getSubject ? message.getSubject() : '').match(/[『「]\s*([^』」]+)[』」]/); if (m) title = m[1].trim(); }
  if (!title && isSanyodo) { const m = String(text).match(/^(.+?)抽選販売へご応募/m); if (m) title = m[1].trim(); }
  if (!title && isGeo) { const m = String(text).match(/\[(?:お申し込みいただいた商品|当選した商品)\]\s*\n\s*([^\r\n]+)/); if (m) title = m[1].trim(); }
  let store = extractLineValue_(text, /^(?:会場|店舗名|受取店舗|受取登録店舗)\s*[:：は]*\s*[「『]?/m).replace(/[」』]$/,'').trim();
  if (isToysRUs) { const sm=String(text).match(/受取登録店舗は[「『]([^」』]+)[」』]/); if(sm) store=sm[1].trim(); }
  if (!store && isSanyodo) { const answers=[...String(text).matchAll(/━回答内容━+\s*\n+\s*([^\r\n]+)/g)].map(m=>m[1].trim()); if(answers.length) store=answers[answers.length-1]; }
  if (!store && isGeo) store = 'GEO（受取店舗未確定）';
  if (!store && (/konamistyle\.jp/i.test(String(message.getFrom ? message.getFrom() : '')) || /コナミスタイル|KONAMI STYLE/i.test(text))) store = 'KONAMI STYLE';
  if (!title || !store) return { kind: 'review', reason: '商品名または店舗名を抽出できない' };
  const resultDate = contextualDate_(text, /(当選発表予定日|当選発表|当選者の発表|結果発表|当選メール)/);
  lotteries.push({
    id: 'lottery-livepocket-' + applicationNo,
    title: resultDate ? cleanLotteryTitle_(title) : '詳細不明',
    store: cleanStoreName_(store),
    status: '応募済',
    resultDate: resultDate,
    receiptStatus: '対象外',
    receivedDate: '',
    memo: '自動登録｜申込番号 ' + applicationNo,
    gmailMessageId: message.getId(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
  if ((store === 'KONAMI STYLE' || isGeo) && !resultDate) lotteries[lotteries.length - 1].title = cleanLotteryTitle_(title);
  return { kind: 'created' };
}

function extractApplicationNo_(text) {
  const m = String(text).normalize('NFKC').match(/(?:(?:お)?申込(?:み)?番号(?:\s*[（(]ご注文番号[）)])?|ご注文番号|注文番号|受付番号)\s*[（(]?\s*[:：]?\s*(\d{7,14})/);
  return m ? m[1] : '';
}

function extractLineValue_(text, label) {
  const line = String(text).split(/\r?\n/).find(x => label.test(x.trim()));
  return line ? line.replace(label, '').trim() : '';
}

function cleanLotteryTitle_(s) {
  return String(s).replace(/^[「『【]+|[」』】]+$/g, '').replace(/購入権(?:利)?抽選.*$/,'').replace(/購入権抽選.*$/,'').trim();
}

function cleanStoreName_(s) {
  return String(s).replace(/[（(](?:その他|大阪府|奈良県|京都府|兵庫県|東京都|神奈川県|愛知県)[）)]/g, '').trim();
}

function productMatches_(hay, key) {
  if (hay.includes(key)) return true;
  const compact = key.replace(/(mega|拡張パック|プレミアム|デッキセット|購入権|抽選販売)/g, '');
  return compact.length >= 8 && hay.includes(compact);
}

function storeMatches_(hay, key) {
  if (hay.includes(key)) return true;
  const geoKey=key.replace(/^geo/i,'ゲオ');
  const geoHay=hay.replace(/geo/g,'ゲオ');
  if(geoKey!==key && geoHay.includes(geoKey))return true;
  const aliases = {
    'イエローサブマリン': ['イエローサブマリン','yellowsubmarine'],
    'bigmagicなんば店': ['bigmagicなんば店','bigmagic難波店','bigmagicなんば'],
    'tsutayaあべの橋店': ['tsutayaあべの橋店','tsutayaあべの橋','あべの橋店']
  };
  const list = aliases[key] || [];
  return list.some(x => hay.includes(normalize_(x)));
}

function parseResult_(text, receivedAt) {
  const win = /(ご当選|当選しました|当選されました|当選となりました|当選のお知らせ|当選者)/.test(text);
  const loss = /(落選|残念ながら|ご用意できません|当選に至りません)/.test(text);
  const result = { status: win !== loss ? (win ? '当選' : '落選') : '', resultDate: Utilities.formatDate(receivedAt, TZ, 'yyyy-MM-dd') };
  result.receiveDeadline = contextualDate_(text, /(購入期限|購入期間|お支払期限|引取期限|受取期限)/);
  result.receivePeriod = contextualText_(text, /(受取期間|引取期間|受け取り期間|イベント開催日)/);
  result.shippingSchedule = contextualText_(text, /(発送予定|発送時期|お届け予定)/);
  return result;
}

function contextualDate_(text, label) {
  const line = String(text).split(/\r?\n/).find(x => label.test(x));
  if (!line) return '';
  const dates = [...line.matchAll(/(?:(20\d{2})[年\/.-])?(\d{1,2})[月\/.-](\d{1,2})日?/g)];
  if (!dates.length) return '';
  const m = dates[dates.length - 1];
  const year = m[1] || Utilities.formatDate(new Date(), TZ, 'yyyy');
  return year + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0');
}

function contextualText_(text, label) {
  const line = String(text).split(/\r?\n/).find(x => label.test(x));
  return line ? line.trim().slice(0, 300) : '';
}

function normalize_(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g, '');
}

function productKey_(s) {
  return normalize_(s).replace(/\d+(box|ボックス|パック|個|点)$/g, '').replace(/(box|ボックス)$/g, '');
}

function storeKey_(s) {
  return normalize_(s).replace(/(オンラインストア|オンラインショップ|オンライン|公式サイト)$/g, '');
}

function sendReport_(report, reviews) {
  const address = Session.getActiveUser().getEmail();
  if (!address) return;
  const lines = ['更新 ' + report.updated + '件', '新規応募 ' + (report.created || 0) + '件', '重複無視 ' + report.duplicate + '件', '対象外 ' + report.outside + '件', '要確認 ' + report.review + '件'];
  reviews.slice(0, 20).forEach(x => lines.push('要確認: ' + x.reason + ' / ' + x.subject));
  GmailApp.sendEmail(address, 'Toreca Vault 抽選結果更新', lines.join('\n'));
}

function removeTorecaVaultTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['runTorecaVaultLotterySync','runTorecaVaultMarketSync'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
}

function legacyDisabledRunTorecaVaultMarketSync_() {
  if(typeof tv2ProcessChatTradeDrafts_==='function')tv2ProcessChatTradeDrafts_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { skipped: true, reason: 'locked' };
  try {
    const file = DriveApp.getFileById(DATA_FILE_ID);
    const root = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
    validate_(root);
    const now = new Date();
    const date = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
    const report = { updated: 0, unchanged: 0, review: 0, unsupported: 0, at: now.toISOString(), source: 'カードラッシュ買取表' };
    const reviews = [];
    let cardrushRows = [];
    try { cardrushRows = fetchCardrushRows_(); } catch (err) { report.fetchError = String(err); }
    root.data.cards.forEach(card => {
      const model = extractModel_(card.set);
      if (!model) { card.marketFresh = false; card.marketTrend = 'stale'; report.review++; reviews.push((card.product || '') + ': 型番を特定できません・前回価格維持'); return; }
      try {
        let result = findCardrushBuyback_(cardrushRows, card.product, model);
        if (!result) result = fetchAltemaBuyback_(card.product, model);
        if (!result || !result.price) { card.marketFresh = false; card.marketTrend = 'stale'; report.review++; reviews.push((card.product || '') + ' ' + model + ': 完全一致なし・前回価格維持'); return; }
        const old = Number(card.buybackPrice || 0);
        if (old === result.price) { card.marketCheckedAt = date; card.marketSource = result.source; card.marketTrend = 'same'; card.marketFresh = true; report.unchanged++; return; }
        card.marketPreviousPrice = old;
        card.marketTrend = result.price > old ? 'up' : result.price < old ? 'down' : 'same';
        card.marketFresh = true;
        card.buybackPrice = result.price;
        card.marketCheckedAt = date;
        card.marketSource = result.source;
        const history = Array.isArray(card.marketHistory) ? card.marketHistory : [];
        if (!history.some(x => x.date === date && Number(x.value) === result.price)) history.push({ date, value: result.price, source: result.source });
        card.marketHistory = history.slice(-400);
        report.updated++;
      } catch (err) { card.marketFresh = false; card.marketTrend = 'stale'; report.review++; reviews.push((card.product || '') + ' ' + model + ': 取得失敗・前回価格維持'); }
    });
    refreshSealedMarketCandidates_(root.data, date, reviews);
    const sealedReport = syncSealedMarketCandidates_(root.data, date, reviews);
    report.updated += sealedReport.updated;
    report.unchanged += sealedReport.unchanged;
    report.review += sealedReport.review;
    report.unsupported = sealedReport.unsupported;
    root.automation = root.automation || {};
    root.automation.lastMarketRunAt = now.toISOString();
    root.automation.lastMarketReport = report;
    root.automation.health = root.automation.health || {};
    root.automation.health.lastMarketRunAt = now.toISOString();
    root.automation.health.marketReview = report.review;
    root.automation.health.marketStatus = (report.fetchError || report.review) ? 'review' : 'ok';
    root.automation.marketNeedsReview = reviews.slice(-200);
    if (report.updated) root.data.updatedAt = now.toISOString();
    root.exportedAt = now.toISOString();
    const out = JSON.stringify(root, null, 2);
    JSON.parse(out);
    file.setContent(out);
    if (report.updated) {
      const address = Session.getActiveUser().getEmail();
      if (address) GmailApp.sendEmail(address, 'Toreca Vault カード相場更新', ['更新 ' + report.updated + '件', '変更なし ' + report.unchanged + '件', '要確認 ' + report.review + '件', 'BOX・パック保留 ' + report.unsupported + '件'].concat(reviews.slice(0, 20)).join('\n'));
    }
    console.log(JSON.stringify(report));
    return report;
  } finally { lock.releaseLock(); }
}

function extractModel_(setText) {
  const m = String(setText || '').normalize('NFKC').match(/\b\d{3}\/[A-Z0-9-]{3,}\b/i);
  return m ? m[0].toUpperCase() : '';
}

const CARDRUSH_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQT3Q9qDbZUpnP3_WH2I5qw8O-U_PqXVhhoIzH2o-tSzeDND9FTuoGKbZiNHTbrzTgKAUA2_SvXFh_2/pub?gid=1490875147&single=true&output=csv';

function fetchCardrushRows_() {
  const response = UrlFetchApp.fetch(CARDRUSH_CSV + '&v=' + Date.now(), { muteHttpExceptions: true, followRedirects: true });
  if (response.getResponseCode() !== 200) throw new Error('Cardrush CSV HTTP ' + response.getResponseCode());
  const rows=Utilities.parseCsv(response.getContentText('UTF-8'));
  if(!Array.isArray(rows)||rows.length<10)throw new Error('Cardrush CSV is empty or malformed');
  return rows;
}

function findCardrushBuyback_(rows, product, model, variant) {
  const pn = normalize_(product);
  const mn = normalize_(model);
  const vn = normalize_(variant || '');
  // These numbers have ordinary, mirror, and/or Master Ball prints at very
  // different prices. A number alone does not identify the owned print.
  if (['225/742', '025/165'].includes(String(model).toUpperCase()) && !vn) return null;
  const matches = rows.filter(row => {
    const text = normalize_(row.join(' '));
    if (!text.includes(pn) || !text.includes(mn)) return false;
    if (vn === normalize_('マスターボールミラー')) return text.includes(vn);
    if (vn === normalize_('モンスターボールミラー')) return text.includes(vn) && !text.includes(normalize_('マスターボール'));
    if (vn === normalize_('ミラー')) return text.includes(vn) && !text.includes(normalize_('モンスターボール')) && !text.includes(normalize_('マスターボール'));
    if (vn === normalize_('通常版')) return !/ミラー|エラー|加工エラー/.test(text);
    return !vn && !/ミラー|エラー|加工エラー/.test(text);
  }).map(row => {
    const prices = row.map(cell => {
      const s = String(cell || '').normalize('NFKC').replace(/[,，円¥￥\s]/g, '');
      return /^\d{2,7}$/.test(s) ? Number(s) : 0;
    }).filter(x => x >= 10);
    return prices.length ? prices[prices.length - 1] : 0;
  }).filter(Boolean);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? { name: product, model, price: unique[0], source: 'カードラッシュ' } : null;
}




function fetchCardrushMediaBuyback_(product, model, variant) {
  const base='https://cardrush.media/pokemon/buying_prices';
  const pn=normalize_(product),mn=normalize_(model),vn=normalize_(variant||''),prices=[];
  // New sets are sometimes not returned when Cardrush's model_number filter
  // expects an expansion-prefixed value (e.g. M6-095/076). Retry by exact
  // product name without the site-side model filter, then filter rows locally
  // by product + card number. This stays fail-closed: only one unique buyback
  // price across exact-matching standard-condition rows is accepted.
  for(const modelFilter of [model,'']){
    const query=[
      'displayMode='+encodeURIComponent('リスト'),
      'limit=100',
      'name='+encodeURIComponent(product),
      'rarity=',
      'model_number='+encodeURIComponent(modelFilter),
      'amount=',
      'page=1',
      'sort%5Bkey%5D=amount',
      'sort%5Border%5D=desc'
    ].join('&');
    const response=UrlFetchApp.fetch(base+'?'+query,{muteHttpExceptions:true,followRedirects:true});
    if(response.getResponseCode()!==200)continue;
    const html=response.getContentText('UTF-8');
    const rows=[...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]);
    for(const row of rows){
      const text=row.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&yen;|&#165;/gi,'¥').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
      const nn=normalize_(text);
      if(!nn.includes(pn)||!nn.includes(mn))continue;
      if(/未開封|PSA\d|BGS\d|CGC\d|ARS\d|鑑定済|状態A-|状態B|状態C|状態難/i.test(text))continue;
      if(/エラー|加工エラー/.test(text)&&vn!==normalize_('エラー版'))continue;
      if(vn===normalize_('マスターボールミラー')){
        if(!nn.includes(vn))continue;
      }else if(vn===normalize_('モンスターボールミラー')){
        if(!nn.includes(vn)||nn.includes(normalize_('マスターボール')))continue;
      }else if(vn===normalize_('ミラー')){
        if(!nn.includes(vn)||nn.includes(normalize_('モンスターボール'))||nn.includes(normalize_('マスターボール')))continue;
      }else if(/ミラー/.test(text))continue;
      const found=[...text.matchAll(/[¥￥]\s*([0-9][0-9,]{1,8})/g)].map(m=>Number(m[1].replace(/,/g,''))).filter(x=>Number.isFinite(x)&&x>0);
      if(found.length)prices.push(found[found.length-1]);
    }
  }
  const unique=[...new Set(prices)];
  return unique.length===1?{name:product,model,price:unique[0],source:'カードラッシュ買取表'}:null;
}

function tv2ToretokuNameMatches_(wanted,actual,model,variant){
  const w=normalize_(wanted),a=normalize_(actual),v=normalize_(variant||'');
  if(a===w)return true;
  const raw=String(actual||'').replace(/[（(](?:マスターボールミラー|モンスターボールミラー|ミラー)[）)]/g,'');
  const stripped=normalize_(raw);
  if(stripped===w)return true;
  // Reprint names can carry the historical LV. suffix while inventory keeps
  // the canonical Pokémon name. The caller already requires an exact card
  // number/set match, so removing only this suffix remains fail-closed.
  const noLevel=normalize_(raw.replace(/\s*LV\.?\s*\d+(?:\.\d+)?\s*$/i,''));
  if(noLevel===w)return true;
  // The owned M2a card was confirmed by the user as the normal print. Toretoku
  // lists its canonical name with the X that older imported inventory omitted.
  if(String(model||'').toUpperCase()==='223/193'&&w===normalize_('メガリザードンex')&&stripped===normalize_('メガリザードンXex'))return true;
  return false;
}
function tv2ToretokuVariantMatches_(actualName,rarity,variant){
  const text=normalize_(String(actualName||'')+' '+String(rarity||'')),v=normalize_(variant||'');
  if(v===normalize_('マスターボールミラー'))return text.includes(normalize_('マスターボールミラー'))||text.includes(normalize_('マスターボール'));
  if(v===normalize_('モンスターボールミラー'))return (text.includes(normalize_('モンスターボールミラー'))||text.includes(normalize_('モンスターボール')))&&!text.includes(normalize_('マスターボール'));
  if(v===normalize_('ミラー'))return text.includes(normalize_('ミラー'))&&!text.includes(normalize_('モンスターボール'))&&!text.includes(normalize_('マスターボール'));
  if(v===normalize_('通常版'))return !/ミラー|エラー|加工エラー/.test(text);
  return !/ミラー|エラー|加工エラー/.test(text);
}
function fetchToretokuBuyback_(product, setText, model, variant) {
  const full=normalize_(setText||''),mn=normalize_(model),seen=new Set(),matches=[];
  const queries=[product,model].filter((x,i,a)=>x&&a.indexOf(x)===i);
  for(const keyword of queries){
    const query=['genre=pokemon','keyword='+encodeURIComponent(keyword)].join('&');
    const response=UrlFetchApp.fetch('https://www.toretoku.jp/kaitori/pokemon/item-search?'+query,{
      muteHttpExceptions:true,followRedirects:true,headers:{'User-Agent':'Mozilla/5.0'}
    });
    if(response.getResponseCode()!==200)continue;
    const html=response.getContentText('UTF-8');
    const re=/\{\\"name\\":\\"([^\\"]+)\\",\\"itemCode\\":\\"([^\\"]+)\\",\\"price\\":(\d+),\\"sellPrice\\":\d+,\\"modelNumber\\":\\"([^\\"]+)\\",\\"imageUrl\\":\\"[^\\"]+\\",\\"rarity\\":\\"([^\\"]*)\\"\}/g;
    let m;
    while((m=re.exec(html))){
      const name=String(m[1]||''),itemCode=String(m[2]||''),price=Number(m[3]),modelNumber=String(m[4]||''),rarity=String(m[5]||'');
      const itemModel=normalize_(modelNumber);
      if(!Number.isFinite(price)||price<=0)continue;
      if(full?itemModel!==full:!itemModel.endsWith(mn))continue;
      if(!tv2ToretokuNameMatches_(product,name,model,variant))continue;
      if(!tv2ToretokuVariantMatches_(name,rarity,variant))continue;
      const key=[itemCode,price,modelNumber,rarity].join('|');if(seen.has(key))continue;seen.add(key);
      matches.push({price,rarity,modelNumber,name});
    }
    const prices=[...new Set(matches.map(x=>x.price))];
    if(prices.length===1)return{name:product,model,price:prices[0],source:'トレトク買取'};
    if(prices.length>1)return null;
  }
  return null;
}

function tv2EscapeRegex_(text){return String(text||'').replace(/[.*+?^$(){}|[\]\\]/g,'\\$&')}
function tv2PlainHtmlText_(html){
  return String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&yen;|&#165;/gi,'¥').replace(/&amp;/gi,'&').replace(/&#39;|&apos;/gi,"'").replace(/&quot;/gi,'"').replace(/\s+/g,' ').trim();
}
function fetchGamepediaBuyback_(product,setText,model,variant){
  if(variant&&normalize_(variant)!==normalize_('通常版'))return null;
  const response=UrlFetchApp.fetch('https://premium.gamepedia.jp/pokeca/card/'+encodeURIComponent(product),{muteHttpExceptions:true,followRedirects:true,headers:{'User-Agent':'Mozilla/5.0'}});
  if(response.getResponseCode()!==200)return null;
  const text=tv2PlainHtmlText_(response.getContentText('UTF-8'));
  const setCode=String(setText||'').trim().split(/\s+/)[0]||'',fullModel=(setCode?setCode+'-':'')+String(model||'');
  if(!normalize_(text).includes(normalize_(product))||!normalize_(text).includes(normalize_(fullModel)))return null;
  const escaped=tv2EscapeRegex_(fullModel),prices=[];
  for(const re of [
    new RegExp('型番\\s*'+escaped+'[\\s\\S]{0,500}?買取価格\\s*([0-9][0-9,]{1,8})\\s*円','gi'),
    new RegExp(escaped+'[\\s\\S]{0,450}?閉じる\\s*([0-9][0-9,]{1,8})\\s*円','gi')
  ]){
    let m;while((m=re.exec(text))){const price=Number(String(m[1]||'').replace(/,/g,''));if(Number.isFinite(price)&&price>0)prices.push(price)}
    const unique=[...new Set(prices)];if(unique.length===1)return{name:product,model,price:unique[0],source:'攻略大百科'};
    if(unique.length>1)return null;
  }
  return null;
}
const TORESIA_EXACT_CARD_URLS_={
  'M6A 137/103':'https://toresia.net/pokeca/cards/c01mxty',
  'M6A 165/103':'https://toresia.net/pokeca/cards/c01ms6y'
};
function fetchToresiaBuyback_(product,setText,model,variant){
  if(variant&&normalize_(variant)!==normalize_('通常版'))return null;
  const setCode=String(setText||'').trim().split(/\s+/)[0]||'',key=(setCode+' '+String(model||'')).trim().toUpperCase(),url=TORESIA_EXACT_CARD_URLS_[key];
  if(!url)return null;
  const response=UrlFetchApp.fetch(url,{muteHttpExceptions:true,followRedirects:true,headers:{'User-Agent':'Mozilla/5.0'}});
  if(response.getResponseCode()!==200)return null;
  const text=tv2PlainHtmlText_(response.getContentText('UTF-8')),n=normalize_(text);
  if(!n.includes(normalize_(product))||!n.includes(normalize_(setCode))||!n.includes(normalize_(model)))return null;
  const prices=[...text.matchAll(/基準買取価格\s*[¥￥]\s*([0-9][0-9,]{1,8})/g)].map(m=>Number(m[1].replace(/,/g,''))).filter(x=>Number.isFinite(x)&&x>0);
  const unique=[...new Set(prices)];
  return unique.length===1?{name:product,model,price:unique[0],source:'トレシア'}:null;
}

function fetchCardValueBuyback_(product,setText,model,variant){
  if(variant&&normalize_(variant)!==normalize_('通常版'))return null;
  // Avoid pages where the same number is known to have a special error print.
  if(normalize_(variant)===normalize_('通常版')&&String(model||'').toUpperCase()==='223/193')return null;
  const slug=String(model||'').toUpperCase().replace(/[^0-9A-Z/-]/g,'').replace('/','-');
  if(!/^\d{3}-[A-Z0-9-]{3,}$/.test(slug))return null;
  const response=UrlFetchApp.fetch('https://card-value.jp/pokemon/cards/'+slug+'/',{muteHttpExceptions:true,followRedirects:true,headers:{'User-Agent':'Mozilla/5.0'}});
  if(response.getResponseCode()!==200)return null;
  const text=response.getContentText('UTF-8').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&yen;|&#165;/gi,'¥').replace(/\s+/g,' ').trim();
  const n=normalize_(text),pn=normalize_(product),mn=normalize_(model),setCode=normalize_(String(setText||'').split(/\s+/)[0]||'');
  if(!n.includes(pn)||!n.includes(mn)||(setCode&&!n.includes(setCode)))return null;
  const prices=[...text.matchAll(/最高買取(?:価格)?\s*[¥￥]\s*([0-9][0-9,]{1,8})/g)].map(m=>Number(m[1].replace(/,/g,''))).filter(x=>Number.isFinite(x)&&x>0);
  const unique=[...new Set(prices)];
  return unique.length===1?{name:product,model,price:unique[0],source:'ポケカ相場ナビ'}:null;
}

function fetchAltemaBuyback_(product, model) {
  const query = encodeURIComponent(product + ' ' + model);
  const searchUrl = 'https://altema.jp/pokemoncard/?s=' + query;
  const search = UrlFetchApp.fetch(searchUrl, { muteHttpExceptions: true, followRedirects: true });
  if (search.getResponseCode() !== 200) return null;
  const html = search.getContentText('UTF-8');
  const links = [...html.matchAll(/href=["'](https:\/\/altema\.jp\/pokemoncard\/[^"'#?]+)["']/gi)].map(m => m[1]).filter((x, i, a) => a.indexOf(x) === i).slice(0, 8);
  for (const url of links) {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (response.getResponseCode() !== 200) continue;
    const text = response.getContentText('UTF-8').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&#165;|&yen;/gi, '円');
    if (!normalize_(text).includes(normalize_(product)) || !normalize_(text).includes(normalize_(model))) continue;
    const pos = Math.max(0, text.toUpperCase().indexOf(model.toUpperCase()));
    const around = text.slice(Math.max(0, pos - 600), pos + 1800);
    const prices = [...around.matchAll(/(?:買取価格|買取相場|買取)\s*[:：]?\s*([0-9,]+)円/g)].map(m => Number(m[1].replace(/,/g, ''))).filter(x => x > 0);
    const unique = [...new Set(prices)];
    if (unique.length === 1) return { name: product, model, price: unique[0], source: 'アルテマ' };
  }
  return null;
}

/**
 * Vaultからの認証付き更新API。
 * doPostは mutationId + expectedRevision で二重実行/競合を防ぎ、
 * 保存後に同じDriveファイルを再読込して mutationId を照合する。
 */
const SEALED_MARKET_STORES = new Set(['買取ミミ','AMTAF','アリウム']);
function syncSealedMarketCandidates_(data, date, reviews) {
  const report = { updated:0, unchanged:0, review:0, unsupported:0 };
  const candidates = Array.isArray(data.marketCandidates) ? data.marketCandidates : [];
  [...(data.boxes||[]), ...(data.packs||[])].filter(x=>Number(x.quantity)>0).forEach(item=>{
    const product = String(item.product||'').trim();
    const condition = String(item.condition||item.shrinkStatus||'').trim();
    const exact = candidates.filter(q=>String(q.product||'').trim()===product && String(q.condition||'').trim()===condition && SEALED_MARKET_STORES.has(String(q.store||'').trim()) && Number(q.price)>0 && String(q.checkedAt||'')===date && q.verified===true && (!q.imageDerived || ['official','google'].includes(String(q.verifiedBy||'').toLowerCase())));
    if(!exact.length){ item.marketFresh=false; item.marketTrend='stale'; report.review++; report.unsupported++; reviews.push(product+': 3店の同一商品・同一状態の確認済み価格なし・前回価格維持'); return; }
    const best=exact.reduce((a,b)=>Number(b.price)>Number(a.price)?b:a);
    const old=Number(item.marketPrice||item.buybackPrice||0);
    item.marketPreviousPrice=old;
    item.marketTrend=Number(best.price)>old?'up':Number(best.price)<old?'down':'same';
    item.marketFresh=true;
    item.marketPrice=Number(best.price);
    item.marketCheckedAt=date;
    item.marketSource=String(best.store)+' '+date;
    const history=Array.isArray(item.marketHistory)?item.marketHistory:[];
    if(!history.some(h=>h.date===date&&Number(h.value)===Number(best.price)))history.push({date,value:Number(best.price),source:item.marketSource});
    item.marketHistory=history.slice(-400);
    if(old===Number(best.price))report.unchanged++;else report.updated++;
  });
  return report;
}


// Structured feed parsing keeps product/condition/X-source matching fail-closed and deployment-tested and active-trigger patched and idempotent; fixture-compatible.
const SEALED_MARKET_FEED_URL = 'https://torekakaku-navi.com/';
function refreshSealedMarketCandidates_(data, date, reviews) {
  let html='';
  try{
    const r=UrlFetchApp.fetch(SEALED_MARKET_FEED_URL,{muteHttpExceptions:true,followRedirects:true});
    if(r.getResponseCode()!==200)throw new Error('HTTP '+r.getResponseCode());
    html=r.getContentText('UTF-8');
  }catch(err){reviews.push('BOX/パック相場フィード取得失敗: '+String(err));return}
  if(typeof tv2ParseSealedFeed_!=='function'){reviews.push('BOX/パック相場: 構造化パーサー未配布のため前回価格維持');return}
  const feed=tv2ParseSealedFeed_(html,date);
  if(feed.error){reviews.push(feed.error+'・前回価格維持');return}
  const rows=[];
  const boxes=data.boxes||[],packs=data.packs||[];
  [...boxes,...packs].filter(x=>Number(x.quantity)>0).forEach(item=>{
    const product=String(item.product||'').trim(),condition=String(item.condition||item.shrinkStatus||'').trim();
    const category=boxes.includes(item)?'BOX':'パック';
    const sealedCondition=tv2SealedCondition_({category,condition,product});
    const sealedName=tv2SealedName_(product);
    if(!product||!sealedCondition||!sealedName)return;
    const matches=feed.products.filter(p=>[p.name,p.official].some(s=>tv2SealedName_(s)===sealedName));
    if(matches.length!==1){reviews.push(product+': 相場フィードの商品一致を一意に確認できず前回価格維持');return}
    (matches[0].offers[sealedCondition]||[]).forEach(offer=>{
      if(!SEALED_MARKET_STORES.has(String(offer.shop||''))||!/^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(String(offer.url||'')))return;
      rows.push({product,condition,store:offer.shop,price:Number(offer.price),checkedAt:feed.date,verified:true,imageDerived:false,verifiedBy:'x-post',sourceUrl:offer.url});
    });
  });
  if(rows.length)data.marketCandidates=rows;
}
