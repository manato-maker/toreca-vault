const MAX_INPUT_BYTES = 512 * 1024;
const FIELD_PATTERNS = {
  applicationId: /^\s*(?:[・●*]\s*)?(?:応募(?:受付)?(?:番号|ID)|お?申(?:し)?込(?:み)?(?:受付)?(?:番号|ID)|エントリー(?:番号|ID)|application\s*(?:id|number))\s*[:：#]\s*([A-Za-z0-9][A-Za-z0-9._-]{2,79})\s*$/i,
  store: /^\s*(?:[・●*]\s*)?(?:店舗名|応募店舗|販売店|ショップ名|ストア名|store(?:\s*name)?)\s*[:：]\s*(.{1,120}?)\s*$/i,
  title: /^\s*(?:[・●*]\s*)?(?:商品名|対象商品|抽選商品)\s*[:：]\s*(.{1,200}?)\s*$/i,
  applicationDate: /^\s*(?:[・●*]\s*)?(?:応募日|申込日|申込年月日|application\s*date)\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s*$/i,
  resultDate: /^\s*(?:[・●*]\s*)?(?:抽選結果日|結果発表日|結果日)\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s*$/i,
  resultStatus: /^\s*(?:[・●*]\s*)?(?:抽選結果|当落|結果)\s*[:：]\s*(当選|落選)\s*$/,
  owner: /^\s*(?:[・●*]\s*)?(?:応募者|申込者|名義|owner)\s*[:：]\s*(.{1,80}?)\s*$/i
};
const normAlias = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('ja').replace(/\s+/g, ' ');
const isoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

function uniqueLabel(lines, pattern) {
  const found = new Set();
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) found.add(match[1].normalize('NFKC').trim());
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Build only from explicit labelled plain-text facts; missing/conflicting evidence returns null for review. */
export function buildGmailLotteryCommandDraft({ kind, subject = '', text = '', retailerAliases = {} } = {}) {
  if (!['application', 'result'].includes(kind)) return null;
  if (typeof subject !== 'string' || typeof text !== 'string'
    || Buffer.byteLength(subject, 'utf8') + Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES
    || !retailerAliases || typeof retailerAliases !== 'object' || Array.isArray(retailerAliases)) return null;

  const lines = `${subject}\n${text}`.normalize('NFKC').split(/\r?\n/);
  const applicationId = uniqueLabel(lines, FIELD_PATTERNS.applicationId);
  const storeLabel = uniqueLabel(lines, FIELD_PATTERNS.store);
  const title = uniqueLabel(lines, FIELD_PATTERNS.title);
  const retailerMap = new Map();
  for (const [label, key] of Object.entries(retailerAliases)) {
    if (typeof key !== 'string' || !key.trim()) return null;
    const normalized = normAlias(label);
    if (!normalized || retailerMap.has(normalized) && retailerMap.get(normalized) !== key) return null;
    retailerMap.set(normalized, key.trim());
  }
  const retailerKey = storeLabel ? retailerMap.get(normAlias(storeLabel)) : null;
  if (!applicationId || !retailerKey || !title) return null;

  const businessEventIdentity = { retailerKey, applicationId };
  if (kind === 'application') {
    const applicationDate = uniqueLabel(lines, FIELD_PATTERNS.applicationDate);
    if (!applicationDate || !isoDate(applicationDate)) return null;
    const owner = uniqueLabel(lines, FIELD_PATTERNS.owner);
    return {
      command: { type: 'lottery', title, store: storeLabel, status: '応募済', applicationDate, ...(owner ? { owner } : {}) },
      businessEventIdentity
    };
  }

  const resultDate = uniqueLabel(lines, FIELD_PATTERNS.resultDate);
  const status = uniqueLabel(lines, FIELD_PATTERNS.resultStatus);
  if (!resultDate || !isoDate(resultDate) || !status) return null;
  const owner = uniqueLabel(lines, FIELD_PATTERNS.owner);
  return {
    command: { type: 'lottery-result-exact', title, store: storeLabel, status, resultDate, ...(owner ? { owner } : {}) },
    businessEventIdentity
  };
}
