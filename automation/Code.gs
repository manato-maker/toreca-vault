const DATA_FILE_ID = PropertiesService.getScriptProperties().getProperty('TV_DATA_FILE_ID');
const TZ = 'Asia/Tokyo';
const MAX_IDS = 3000;
const RESULT_WORDS = /(当選|ご当選|落選|残念|抽選結果)/;
const APPLICATION_WORDS = /(抽選申込完了|申込受付完了|申込みが完了|申込完了|申込み完了|申込み受付が完了|お申込み受付が完了|抽選販売へのお申込み受付)/;
const CARD_WORDS = /(ポケモン|ポケカ|ONE ?PIECE|ワンピース|ドラゴンボール|ウマ娘|遊戯王|YU[- ]?GI[- ]?OH|遊戯王OCG)/i;

function installTorecaVaultAutomation() {
  if (!DATA_FILE_ID) throw new Error('TV_DATA_FILE_ID が未設定です');
  removeTorecaVaultTriggers_();
  ScriptApp.newTrigger('runTorecaVaultLotterySync').timeBased().atHour(12).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('runTorecaVaultLotterySync').timeBased().atHour(19).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('runTorecaVaultMarketSync').timeBased().atHour(13).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  PropertiesService.getScriptProperties().setProperty('TV_INSTALLED_AT', new Date().toISOString());
  return runTorecaVaultLotterySync();
}

function runTorecaVaultLotterySync() {
  if(typeof tv2ProcessChatTradeDrafts_==='function')tv2ProcessChatTradeDrafts_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { skipped: true, reason: 'locked' };
  try {
    const file = DriveApp.getFileById(DATA_FILE_ID);
    const raw = file.getBlob().getDataAsString('UTF-8');
    const root = JSON.parse(raw);
    validate_(root);
    const data = root.data;
    const props = PropertiesService.getScriptProperties();
    const now = new Date();
    const lastIso = props.getProperty('TV_LAST_RUN');
    const since = lastIso ? new Date(lastIso) : new Date(now.getTime() - 2 * 86400000);
    const automation = root.automation || {};
    const processed = new Set(automation.gmailMessageIds || []);
    const report = { updated: 0, created: 0, duplicate: 0, outside: 0, review: 0, scanned: 0, since: since.toISOString(), at: now.toISOString() };
    const newIds = [];
    const updates = [];
    const threads = GmailApp.search('newer_than:3d', 0, 200);

    threads.forEach(thread => thread.getMessages().forEach(message => {
      if (message.getDate() <= since) return;
      const messageId = message.getId();
      const text = [message.getSubject(), message.getPlainBody()].join('\n');
      if (!CARD_WORDS.test(text) || (!RESULT_WORDS.test(text) && !APPLICATION_WORDS.test(text))) return;
      report.scanned++;
      if (processed.has(messageId)) { report.duplicate++; return; }

      if (APPLICATION_WORDS.test(text) && !RESULT_WORDS.test(text)) {
        const created = upsertApplication_(data.lotteries, text, message, now);
        if (created.kind === 'created') report.created++;
        else if (created.kind === 'duplicate') report.duplicate++;
        else {
          report.review++;
          updates.push({ messageId, reason: created.reason, subject: message.getSubject() });
        }
        newIds.push(messageId);
        return;
      }

      const match = matchLottery_(data.lotteries, text);
      if (match.kind === 'outside') {
        report.outside++;
      } else if (match.kind === 'review') {
        report.review++;
        updates.push({ messageId, reason: match.reason, subject: message.getSubject() });
      } else {
        const parsed = parseResult_(text, message.getDate());
        if (!parsed.status) {
          report.review++;
          updates.push({ messageId, reason: '当落を一意に判別できない', subject: message.getSubject() });
        } else {
          const item = match.item;
          const same = item.status === parsed.status && item.resultDate === parsed.resultDate &&
            (!parsed.receiveDeadline || item.receiveDeadline === parsed.receiveDeadline);
          if (same) {
            if (!item.gmailMessageId) item.gmailMessageId = messageId;
            report.duplicate++;
          } else {
            item.status = parsed.status;
            item.resultDate = parsed.resultDate;
            if (parsed.receiveDeadline) item.receiveDeadline = parsed.receiveDeadline;
            if (parsed.receivePeriod) item.receivePeriod = parsed.receivePeriod;
            if (parsed.shippingSchedule) item.shippingSchedule = parsed.shippingSchedule;
            if (parsed.status === '当選' && !['受取済み','未受取'].includes(item.receiptStatus)) item.receiptStatus = '未受取';
            if (parsed.status === '落選' && item.receiptStatus !== '受取済み') item.receiptStatus = '対象外';
            item.gmailMessageId = messageId;
            item.updatedAt = now.toISOString();
            report.updated++;
          }
        }
      }
      newIds.push(messageId);
    }));

    automation.gmailMessageIds = [...processed, ...newIds].slice(-MAX_IDS);
    automation.lastGmailRunAt = now.toISOString();
    automation.lastReport = report;
    automation.health = automation.health || {};
    automation.health.lastGmailRunAt = now.toISOString();
    automation.health.gmailReview = report.review;
    automation.health.gmailStatus = report.review ? 'review' : 'ok';
    automation.needsReview = [...(automation.needsReview || []), ...updates].slice(-200);
    root.automation = automation;

    if (report.updated || report.created) data.updatedAt = now.toISOString();
    root.exportedAt = now.toISOString();
    const out = JSON.stringify(root, null, 2);
    JSON.parse(out);
    file.setContent(out);

    props.setProperty('TV_LAST_RUN', now.toISOString());
    if (report.updated || report.created || report.outside || report.review) sendReport_(report, updates);
    console.log(JSON.stringify(report));
    return report;
  } finally {
    lock.releaseLock();
  }
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
  const isToysRUs = /toysrus|トイザらス|las\.toysrus\.co\.jp/i.test([text, String(message.getFrom ? message.getFrom() : '')].join('\n'));
  if (!applicationNo && isToysRUs) applicationNo = 'mail-' + message.getId();
  if (!applicationNo) return { kind: 'review', reason: '申込番号を抽出できない' };
  if (lotteries.some(x => String(x.id || '').includes(applicationNo) || String(x.memo || '').includes(applicationNo))) {
    return { kind: 'duplicate' };
  }
  let title = extractLineValue_(text, /^(?:イベント名|商品名)\s*[:：]/m);
  if (!title && isToysRUs) { const m = String(message.getSubject ? message.getSubject() : '').match(/[『「]\s*([^』」]+)[』」]/); if (m) title = m[1].trim(); }
  let store = extractLineValue_(text, /^(?:会場|店舗名|受取店舗|受取登録店舗)\s*[:：は]*\s*[「『]?/m).replace(/[」』]$/,'').trim();
  if (!store && (/konamistyle\.jp/i.test(String(message.getFrom ? message.getFrom() : '')) || /コナミスタイル|KONAMI STYLE/i.test(text))) store = 'KONAMI STYLE';
  if (!title || !store) return { kind: 'review', reason: '商品名または店舗名を抽出できない' };
  const resultDate = contextualDate_(text, /(当選発表予定日|当選発表|結果発表)/);
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
  if (store === 'KONAMI STYLE' && !resultDate) lotteries[lotteries.length - 1].title = cleanLotteryTitle_(title);
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
  const win = /(ご当選|当選しました|当選のお知らせ|当選者)/.test(text);
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

function runTorecaVaultMarketSync() {
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
  return Utilities.parseCsv(response.getContentText('UTF-8'));
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
    return !vn && !/ミラー/.test(text);
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
  const query=[
    'displayMode='+encodeURIComponent('リスト'),
    'limit=100',
    'name='+encodeURIComponent(product),
    'rarity=',
    'model_number='+encodeURIComponent(model),
    'amount=',
    'page=1',
    'sort%5Bkey%5D=amount',
    'sort%5Border%5D=desc'
  ].join('&');
  const response=UrlFetchApp.fetch(base+'?'+query,{muteHttpExceptions:true,followRedirects:true});
  if(response.getResponseCode()!==200)return null;
  const html=response.getContentText('UTF-8');
  const rows=[...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]);
  const pn=normalize_(product),mn=normalize_(model),vn=normalize_(variant||''),prices=[];
  for(const row of rows){
    const text=row.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&yen;|&#165;/gi,'¥').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
    const nn=normalize_(text);
    if(!nn.includes(pn)||!nn.includes(mn))continue;
    if(/未開封|PSA\d|BGS\d|CGC\d|ARS\d|鑑定済|状態A-|状態B|状態C|状態難/i.test(text))continue;
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
  const unique=[...new Set(prices)];
  return unique.length===1?{name:product,model,price:unique[0],source:'カードラッシュ買取表'}:null;
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
function doGet(e) {
  const p = (e && e.parameter) || {};
  const callback = String(p.callback || '');
  try {
    assertSyncToken_(p.token);
    if (String(p.action || '') !== 'load') throw new Error('unsupported action');
    const root = readVaultRoot_();
    const meta = root.sync || {};
    return jsonpResponse_(callback, { ok:true, payload:root, revision:vaultRevision_(root), lastMutationId:String(meta.lastMutationId || '') });
  } catch (err) {
    return jsonpResponse_(callback, { ok:false, error:String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return jsonResponse_({ ok:false, error:'locked' });
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    assertSyncToken_(req.token);
    if (!req.payload || req.payload.app !== 'toreca-vault' || !req.payload.data) throw new Error('invalid payload');
    const current = readVaultRoot_();
    const currentRevision = vaultRevision_(current);
    const mutationId = String(req.mutationId || '');
    if (!mutationId) throw new Error('mutationId required');
    if (String((current.sync || {}).lastMutationId || '') === mutationId) {
      return jsonResponse_({ ok:true, duplicate:true, revision:currentRevision, lastMutationId:mutationId });
    }
    if (req.expectedRevision && String(req.expectedRevision) !== currentRevision) {
      return jsonResponse_({ ok:false, conflict:true, error:'revision conflict', revision:currentRevision });
    }
    const next = req.payload;
    validate_(next);
    next.sync = Object.assign({}, current.sync || {}, { lastMutationId:mutationId, updatedAt:new Date().toISOString() });
    next.exportedAt = new Date().toISOString();
    const out = JSON.stringify(next, null, 2);
    JSON.parse(out);
    DriveApp.getFileById(DATA_FILE_ID).setContent(out);

    const confirmed = readVaultRoot_();
    if (String((confirmed.sync || {}).lastMutationId || '') !== mutationId) throw new Error('post-save verification failed');
    return jsonResponse_({ ok:true, revision:vaultRevision_(confirmed), lastMutationId:mutationId });
  } catch (err) {
    return jsonResponse_({ ok:false, error:String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function readVaultRoot_() {
  if (!DATA_FILE_ID) throw new Error('TV_DATA_FILE_ID が未設定です');
  const root = JSON.parse(DriveApp.getFileById(DATA_FILE_ID).getBlob().getDataAsString('UTF-8'));
  validate_(root);
  return root;
}

function vaultRevision_(root) {
  const text = JSON.stringify(root);
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b < 0 ? b + 256 : b).toString(16))).slice(-2)).join('');
}

function assertSyncToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('TV_SYNC_TOKEN');
  if (!expected || expected.length < 24) throw new Error('TV_SYNC_TOKEN が未設定です');
  if (String(token || '') !== expected) throw new Error('unauthorized');
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function jsonpResponse_(callback, obj) {
  const body = callback ? callback + '(' + JSON.stringify(obj) + ')' : JSON.stringify(obj);
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JAVASCRIPT);
}


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
