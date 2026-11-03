// Kept in step with automation/Code.gs and automation/V2Automation.gs.
// Classification is pure: callers may discard the message text after this call.
const RESULT_WORDS = /(当選|ご当選|落選|残念|抽選結果)/;
const APPLICATION_WORDS = /(抽選申込完了|抽選申込み受付完了|申込受付完了|申込み受付完了|申し込み受付完了|抽選販売応募完了|応募完了|申込みが完了|申込完了|申込み完了|申込み受付が完了|お申込み受付が完了|抽選販売へのお申込み受付)/;
const SUBJECT_APPLICATION_WORDS = /(?:抽選申込完了|申込受付完了|抽選販売応募完了|応募完了|申込完了|申込み完了|申込み受付が完了|お申込み受付が完了|抽選販売へのお申込み受付)/;
const CARD_WORDS = /(ポケモン|ポケカ|ONE ?PIECE|ワンピース|ドラゴンボール|ウマ娘|遊戯王|YU[- ]?GI[- ]?OH|遊戯王OCG|UNION ?ARENA|ユニオンアリーナ)/i;

/** Mirror the Apps Script Gmail filters without retaining or mutating message data. */
export function classifyLotteryMessage({ subject = '', text = '', resultOnly = false } = {}) {
  const subjectText = String(subject);
  const bodyText = String(text);
  const normalized = (subjectText + '\n' + bodyText).normalize('NFKC');
  const isResult = RESULT_WORDS.test(subjectText);
  const isApplication = SUBJECT_APPLICATION_WORDS.test(subjectText)
    || APPLICATION_WORDS.test(subjectText)
    || (APPLICATION_WORDS.test(subjectText + '\n' + bodyText) && !RESULT_WORDS.test(subjectText));
  if (!CARD_WORDS.test(normalized)) return { kind: 'ignore', reason: 'not-card-related' };
  if (resultOnly && !isResult) return { kind: 'ignore', reason: 'not-result' };
  if (isResult) return { kind: 'result' };
  if (isApplication) return { kind: 'application' };
  return { kind: 'ignore', reason: 'not-lottery-mail' };
}
