const DATA_FILE_ID = '1Q9ZzWA-I7ggmufCAV-WUnDw2VFY8Pd3F';
const TZ = 'Asia/Tokyo';
const MAX_IDS = 3000;
const RESULT_WORDS = /(当選|ご当選|落選|残念|抽選結果)/;
const CARD_WORDS = /(ポケモン|ポケカ|ONE ?PIECE|ワンピース|ドラゴンボール|ウマ娘)/i;

function installTorecaVaultAutomation() {
  removeTorecaVaultTriggers_();
  ScriptApp.newTrigger('runTorecaVaultLotterySync').timeBased().atHour(12).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('runTorecaVaultLotterySync').timeBased().atHour(19).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  PropertiesService.getScriptProperties().setProperty('TV_INSTALLED_AT', new Date().toISOString());
  return runTorecaVaultLotterySync();
}

function runTorecaVaultLotterySync() {
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
    const report = { updated: 0, duplicate: 0, outside: 0, review: 0, scanned: 0, since: since.toISOString(), at: now.toISOString() };
    const newIds = [];
    const updates = [];
    const threads = GmailApp.search('newer_than:3d', 0, 200);

    threads.forEach(thread => thread.getMessages().forEach(message => {
      if (message.getDate() <= since) return;
      const messageId = message.getId();
      const text = [message.getSubject(), message.getPlainBody()].join('\n');
      if (!RESULT_WORDS.test(text) || !CARD_WORDS.test(text)) return;
      report.scanned++;
      if (processed.has(messageId)) { report.duplicate++; return; }

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
          const same = item.status === parsed.status &&
            item.resultDate === parsed.resultDate &&
            (!parsed.receiveDeadline || item.receiveDeadline === parsed.receiveDeadline);
          if (same) {
            report.duplicate++;
          } else {
            item.status = parsed.status;
            item.resultDate = parsed.resultDate;
            if (parsed.receiveDeadline) item.receiveDeadline = parsed.receiveDeadline;
            if (parsed.receivePeriod) item.receivePeriod = parsed.receivePeriod;
            if (parsed.shippingSchedule) item.shippingSchedule = parsed.shippingSchedule;
            if (parsed.status === '当選' && !['受取済み','未受取'].includes(item.receiptStatus)) item.receiptStatus = '未受取';
            if (parsed.status === '落選') item.receiptStatus = '対象外';
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
    automation.needsReview = [...(automation.needsReview || []), ...updates].slice(-200);
    root.automation = automation;

    if (report.updated || newIds.length) {
      data.updatedAt = now.toISOString();
      root.exportedAt = now.toISOString();
      const out = JSON.stringify(root, null, 2);
      JSON.parse(out);
      file.setContent(out);
    }
    props.setProperty('TV_LAST_RUN', now.toISOString());
    if (report.updated || report.outside || report.review) sendReport_(report, updates);
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
  const hay = normalize_(text);
  const candidates = lotteries.filter(x => {
    const title = productKey_(x.title || '');
    const store = storeKey_(x.store || '');
    return title && store && hay.includes(title) && hay.includes(store);
  });
  if (candidates.length === 1) return { kind: 'match', item: candidates[0] };
  if (candidates.length > 1) return { kind: 'review', reason: '登録済み抽選が複数一致' };

  const productOnly = lotteries.filter(x => {
    const title = productKey_(x.title || '');
    return title && hay.includes(title);
  });
  if (productOnly.length) return { kind: 'review', reason: '商品は一致したが店舗を特定できない' };
  return { kind: 'outside' };
}

function parseResult_(text, receivedAt) {
  const win = /(ご当選|当選しました|当選のお知らせ|当選者)/.test(text);
  const loss = /(落選|残念ながら|ご用意できません|当選に至りません)/.test(text);
  const result = {
    status: win !== loss ? (win ? '当選' : '落選') : '',
    resultDate: Utilities.formatDate(receivedAt, TZ, 'yyyy-MM-dd')
  };
  result.receiveDeadline = contextualDate_(text, /(購入期限|購入期間|お支払期限|引取期限|受取期限)/);
  result.receivePeriod = contextualText_(text, /(受取期間|引取期間|受け取り期間)/);
  result.shippingSchedule = contextualText_(text, /(発送予定|発送時期|お届け予定)/);
  return result;
}

function contextualDate_(text, label) {
  const line = String(text).split(/\r?\n/).find(x => label.test(x));
  if (!line) return '';
  const m = line.match(/(?:(20\d{2})[年\/.-])?(\d{1,2})[月\/.-](\d{1,2})日?/);
  if (!m) return '';
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
  const lines = [
    '更新 ' + report.updated + '件',
    '重複無視 ' + report.duplicate + '件',
    '対象外 ' + report.outside + '件',
    '要確認 ' + report.review + '件'
  ];
  reviews.slice(0, 20).forEach(x => lines.push('要確認: ' + x.reason + ' / ' + x.subject));
  GmailApp.sendEmail(address, 'Toreca Vault 抽選結果更新', lines.join('\n'));
}

function removeTorecaVaultTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runTorecaVaultLotterySync') ScriptApp.deleteTrigger(t);
  });
}
