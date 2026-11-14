import { createHash } from 'node:crypto';
import { createLotteryBusinessEventKey } from './business-event-identity.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const EVENT_KINDS = new Map([
  ['lottery', 'application'],
  ['lottery-result-exact', 'result'],
  ['lottery-receipt', 'receipt']
]);

function parseJsonCell(value, label, optional = false) {
  const text = String(value ?? '').trim();
  if (!text && optional) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`${label} is not valid JSON`), { reasonCode: 'invalid-json' });
  }
}

/**
 * A Chat or screenshot may prove a lottery was submitted even if the retailer
 * shows no externally issued application ID. Create a conservative source-
 * independent fingerprint only for a fully specified, confirmed application.
 * It is NOT an applicationId and must never be copied into the retailer-ID field.
 */
function confirmedChatLotteryFingerprint(command) {
  if (command.type !== 'lottery' || command.status !== '応募済'
    || !['screenshot', 'chat-report'].includes(command.evidenceType)) return null;
  const canonical = (value) => String(value || '').normalize('NFKC').trim()
    .toLocaleLowerCase('ja').replace(/[\s\u3000]+/g, ' ');
  const store = canonical(command.store);
  const title = canonical(command.title || command.product);
  const owner = canonical(command.owner);
  const applicationDate = String(command.applicationDate || '');
  if (!store || !title || !owner || store.length > 120 || title.length > 180
    || owner.length > 100 || !/^\d{4}-\d{2}-\d{2}$/.test(applicationDate)
    || Number.isNaN(Date.parse(applicationDate + 'T00:00:00Z'))
    || new Date(applicationDate + 'T00:00:00Z').toISOString().slice(0, 10) !== applicationDate) return null;
  // Deliberately do not include quantity/price: a corrected quantity must not
  // create another distinct application. Subsequent edits use the original ID.
  const payload = JSON.stringify(['toreca-vault-chat-verified-lottery-application', 1,
    store, title, owner, applicationDate]);
  return 'lottery:confirmed-report:v1:' + createHash('sha256').update(payload).digest('hex');
}

function parseIdentity(value, command) {
  const kind = EVENT_KINDS.get(String(command.type || ''));
  if (value === null) {
    if (kind === 'application') {
      const fingerprint = confirmedChatLotteryFingerprint(command);
      if (fingerprint) return { businessEventKey: fingerprint };
    }
    if (kind) throw Object.assign(new Error('lottery identity is required'), { reasonCode: 'lottery-identity-missing' });
    return { businessEventKey: undefined };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['retailerKey', 'applicationId', 'kind'].includes(key))) {
    throw Object.assign(new Error('business event identity is invalid'), { reasonCode: 'invalid-event-identity' });
  }
  if (!kind) throw Object.assign(new Error('business event identity is unsupported'), { reasonCode: 'unsupported-event-identity' });
  // Older intake rows include an explicit kind. Only tolerate it when it
  // matches the command type; never let user-supplied kind override the type.
  if (value.kind !== undefined && value.kind !== kind) {
    throw Object.assign(new Error('lottery event kind does not match command'), { reasonCode: 'lottery-kind-mismatch' });
  }
  const resolved = createLotteryBusinessEventKey({ retailerKey: value.retailerKey, applicationId: value.applicationId, kind });
  if (resolved.status !== 'ready') {
    throw Object.assign(new Error('business event identity needs review'), { reasonCode: resolved.reasonCode || 'invalid-event-identity' });
  }
  return { businessEventKey: resolved.businessEventKey };
}

function parseInputRow(row) {
  const requestId = String(row.values?.[0] ?? '').trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) throw Object.assign(new Error('request ID is invalid'), { reasonCode: 'invalid-request-id' });
  const command = parseJsonCell(row.values?.[1], 'command');
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw Object.assign(new Error('command must be an object'), { reasonCode: 'invalid-command' });
  }
  if (String(command.requestId || '').trim() !== requestId) {
    throw Object.assign(new Error('request ID does not match the command'), { reasonCode: 'request-id-mismatch' });
  }
  const identity = parseJsonCell(row.values?.[2], 'business event identity', true);
  return { requestId, command, ...parseIdentity(identity, command) };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Reads only rows explicitly marked `new`, then uses the durable queue's
 * create-once request/business keys. It never edits source cells A:C.
 */
export function createGoogleSheetsIntakeProcessor({ provider, queue, cursorStore, spreadsheetId, maxRowsPerRun = 20, now = Date.now } = {}) {
  if (!provider || typeof provider.readRows !== 'function' || typeof provider.writeReceipt !== 'function') {
    throw new TypeError('a Google Sheets intake provider is required');
  }
  if (!queue || typeof queue.enqueue !== 'function') throw new TypeError('a durable command queue is required');
  if (!cursorStore || typeof cursorStore.read !== 'function' || typeof cursorStore.advance !== 'function') {
    throw new TypeError('a durable intake cursor store is required');
  }
  if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(spreadsheetId)) {
    throw new TypeError('a dedicated intake spreadsheet ID is required');
  }
  const spreadsheetIdHash = createHash('sha256').update(spreadsheetId).digest('hex');
  if (!Number.isSafeInteger(maxRowsPerRun) || maxRowsPerRun < 1 || maxRowsPerRun > 50) {
    throw new RangeError('maxRowsPerRun must be from 1 to 50');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  return async function processIntake() {
    const cursor = await cursorStore.read();
    const startRow = cursor?.nextRow;
    if (!Number.isSafeInteger(startRow) || startRow < 2 || startRow > 100_002) {
      throw new Error('Google Sheets intake cursor is invalid');
    }
    const result = { seen: 0, enqueued: 0, duplicate: 0, review: 0, skipped: 0 };
    if (startRow === 100_002) return result;
    const limit = Math.min(maxRowsPerRun, 100_002 - startRow);
    const rows = await provider.readRows({ startRow, limit });
    if (!Array.isArray(rows) || rows.length > limit) throw new Error('Google Sheets returned an invalid row page');

    for (const row of rows) {
      if (!Number.isSafeInteger(row?.rowNumber) || row.rowNumber !== startRow + result.skipped + result.seen) {
        throw new Error('Google Sheets returned an invalid row sequence');
      }
      const status = String(row.values?.[3] ?? '').trim();
      if (status !== 'new') {
        result.skipped++;
        continue;
      }
      result.seen++;
      let parsed;
      try {
        parsed = parseInputRow(row);
      } catch (error) {
        await provider.writeReceipt(row.rowNumber, {
          status: 'review',
          resultCode: /^[a-z0-9-]{1,48}$/.test(String(error?.reasonCode || '')) ? error.reasonCode : 'invalid-input',
          acceptedRequestId: '',
          processedAtMs: now()
        }, String(row.values?.[0] ?? ''));
        result.review++;
        continue;
      }

      let queued;
      try {
        queued = await queue.enqueue({
          requestId: parsed.requestId,
          command: parsed.command,
          businessEventKey: parsed.businessEventKey,
          intakeReceipt: { spreadsheetIdHash, rowNumber: row.rowNumber }
        });
      } catch {
        // Leave the source row as `new`; a later tick retries with the same requestId.
        throw new Error('Google Sheets command enqueue failed');
      }

      if (queued?.businessDuplicate) {
        await provider.writeReceipt(row.rowNumber, {
          status: 'duplicate', resultCode: 'business-duplicate',
          acceptedRequestId: String(queued.existingRequestId || ''), processedAtMs: now()
        }, parsed.requestId);
        result.duplicate++;
      } else if (queued?.accepted) {
        await provider.writeReceipt(row.rowNumber, {
          status: queued.duplicate ? 'duplicate' : 'queued',
          resultCode: queued.duplicate ? 'request-duplicate' : 'accepted',
          acceptedRequestId: parsed.requestId,
          processedAtMs: now()
        }, parsed.requestId);
        if (queued.duplicate) result.duplicate++;
        else result.enqueued++;
      } else {
        const collision = queued?.status === 'business-event-collision' ? 'business-collision'
          : queued?.status === 'collision' ? 'request-collision' : 'queue-rejected';
        await provider.writeReceipt(row.rowNumber, {
          status: 'review', resultCode: collision,
          acceptedRequestId: '', processedAtMs: now()
        }, parsed.requestId);
        result.review++;
      }
    }

    if (rows.length > 0) {
      const advanced = await cursorStore.advance({ expectedNextRow: startRow, nextRow: startRow + rows.length });
      if (!advanced) throw new Error('Google Sheets intake cursor changed during processing');
    }

    return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, safeCount(value)]));
  };
}

