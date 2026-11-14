import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyV2 } from '../../v2/core.js';
import { createGoogleSheetsIntakeProcessor } from '../src/google-sheets-intake.js';
import { createGoogleSheetsIntakeStatusProcessor } from '../src/google-sheets-intake-status.js';
import { processQueuedCommand } from '../src/command-worker.js';

const SPREADSHEET_ID = '1abcdefghijklmnopqrstuvwxyz0123456789';
const digest = (value) => createHash('sha256').update(value).digest('hex');

// Contract-level integration without Google credentials, traffic or real stock.
// The fixture deliberately models one append-only Intake row, create-once queue,
// CAS canonical state and final receipt reconciliation as separate stages.
function harness(commands) {
  let nextRow = 2;
  let canonical = { payload: emptyV2(), revision: 0, lastMutationId: '' };
  const rows = commands.map((command, index) => ({
    rowNumber: index + 2,
    values: [command.requestId, JSON.stringify(command), '', 'new']
  }));
  const receipts = [];
  const work = new Map();
  const eventKeys = new Map();
  let leaseNumber = 0;
  const provider = {
    async readRows({ startRow, limit }) {
      return rows.filter(row => row.rowNumber >= startRow && row.rowNumber < startRow + limit)
        .map(row => structuredClone(row));
    },
    async writeReceipt(rowNumber, receipt, sourceRequestId = receipt.acceptedRequestId) {
      const row = rows.find(item => item.rowNumber === rowNumber);
      assert.ok(row, 'sheet row must exist');
      assert.equal(row.values[0], sourceRequestId, 'compare-before-write must use original request ID');
      row.values = [...row.values.slice(0, 3),
        receipt.status, receipt.resultCode, receipt.acceptedRequestId, receipt.processedAtMs];
      receipts.push({ rowNumber, ...receipt });
    }
  };
  const cursorStore = {
    async read() { return { nextRow }; },
    async advance({ expectedNextRow, nextRow: proposed }) {
      if (nextRow !== expectedNextRow) return false;
      nextRow = proposed;
      return true;
    }
  };
  const queue = {
    async enqueue({ requestId, command, businessEventKey, intakeReceipt }) {
      const existing = work.get(requestId);
      if (existing) {
        if (JSON.stringify(existing.command) !== JSON.stringify(command)) {
          return { status: 'collision', accepted: false };
        }
        return { accepted: true, duplicate: true, status: existing.status };
      }
      if (businessEventKey && eventKeys.has(businessEventKey)) {
        return { businessDuplicate: true, existingRequestId: eventKeys.get(businessEventKey) };
      }
      work.set(requestId, {
        requestId, command: structuredClone(command), status: 'pending', resultCode: '',
        intakeReceipt: { ...intakeReceipt, state: 'queued' },
        updatedAtMs: 200, leaseToken: ''
      });
      if (businessEventKey) eventKeys.set(businessEventKey, requestId);
      return { accepted: true, duplicate: false, status: 'pending' };
    },
    async claim(requestId) {
      const item = work.get(requestId);
      if (!item || item.status !== 'pending') return { claimed: false, status: item?.status || 'missing' };
      item.status = 'processing';
      item.leaseToken = 'lease-' + ++leaseNumber;
      return {
        claimed: true, status: 'claimed', claimToken: item.leaseToken,
        command: structuredClone(item.command)
      };
    },
    async finish(requestId, token, { outcome, resultCode }) {
      const item = work.get(requestId);
      if (item?.leaseToken !== token) return { status: 'lease-lost', updated: false };
      item.status = outcome;
      item.resultCode = resultCode;
      item.updatedAtMs += 1;
      return { status: outcome, updated: true };
    },
    async listIntakeReceipts() {
      return [...work.values()].filter(item => item.intakeReceipt.state !== 'final').map(item => ({
        requestId: item.requestId,
        requestIdHash: digest(item.requestId),
        spreadsheetIdHash: item.intakeReceipt.spreadsheetIdHash,
        rowNumber: item.intakeReceipt.rowNumber
      }));
    },
    async inspectByRequestIdHash(idHash) {
      const item = [...work.values()].find(row => digest(row.requestId) === idHash);
      return item ? structuredClone(item) : null;
    },
    async setIntakeReceiptStatus(requestId, { state }) {
      const item = work.get(requestId);
      if (!item) return { updated: false };
      item.intakeReceipt.state = state;
      return { updated: true };
    }
  };
  const store = {
    async read() { return structuredClone(canonical); },
    async save({ expectedRevision, mutationId, payload }) {
      assert.equal(expectedRevision, canonical.revision, 'CAS revision must match');
      canonical = {
        payload: structuredClone(payload), revision: payload.revision, lastMutationId: mutationId
      };
      // Real Firestore adapter readbacks the persisted version on successful CAS.
      return structuredClone(canonical);
    }
  };
  const intake = createGoogleSheetsIntakeProcessor({
    provider, queue, cursorStore, spreadsheetId: SPREADSHEET_ID, now: () => 100
  });
  const reconcile = createGoogleSheetsIntakeStatusProcessor({
    provider, queue, spreadsheetId: SPREADSHEET_ID, now: () => 300
  });
  return {
    intake, reconcile, rows, receipts, queue, store,
    async process(requestId) {
      return processQueuedCommand({
        queue, store, requestId, clock: () => 250
      });
    },
    readState: () => structuredClone(canonical),
    getCursor: () => nextRow
  };
}

test('Chat purchase → Intake → queue → canonical CAS → verified receipt, with one stock lot', async () => {
  const command = {
    requestId: 'chat:e2e:purchase:1', type: 'purchase', product: '商品A',
    category: 'BOX', condition: 'あり', quantity: 1,
    unitCost: 7200, date: '2026-11-14', store: '実店舗A'
  };
  const h = harness([command]);
  assert.deepEqual(await h.intake(), {
    seen: 1, enqueued: 1, duplicate: 0, review: 0, skipped: 0
  });
  assert.equal(h.rows[0].values[3], 'queued');
  assert.equal(h.getCursor(), 3);
  assert.equal(h.readState().revision, 0);
  assert.deepEqual(await h.reconcile(), { checked: 1, finalized: 0, pending: 1 });
  assert.equal((await h.process(command.requestId)).resultCode, 'v2-applied');
  assert.deepEqual(await h.reconcile(), { checked: 1, finalized: 1, pending: 0 });
  assert.deepEqual(await h.reconcile(), { checked: 0, finalized: 0, pending: 0 });
  assert.deepEqual(h.rows[0].values.slice(3, 6),
    ['v2-applied', 'canonical-readback-verified', command.requestId]);
  const state = h.readState().payload;
  assert.equal(state.transactions.length, 1);
  assert.equal(state.inventoryLots.length, 1);
  assert.equal(state.inventoryLots[0].quantity, 1);
  assert.equal(state.inventoryLots[0].unitCost, 7200);
  assert.equal(state.revision, 1);
  assert.equal((await h.process(command.requestId)).status, 'done');
  assert.equal(h.readState().revision, 1);
});

test('confirmed Chat lottery without external ID reaches calendar data, not purchase/inventory', async () => {
  const command = {
    requestId: 'chat:e2e:lottery:1', type: 'lottery',
    title: '商品B抽選', product: '商品B', store: '実店舗B',
    status: '応募済', applicationDate: '2026-11-14',
    owner: '本人', evidenceType: 'chat-report', quantity: 2, category: 'BOX',
    deadline: '2026-11-19', resultDate: '2026-11-21',
    officialMsrpYen: 6000, officialProductUrl: 'https://example.com/product-b',
    paymentStatus: '未購入・未支出'
  };
  const h = harness([command]);
  assert.equal((await h.intake()).enqueued, 1);
  assert.equal((await h.process(command.requestId)).resultCode, 'v2-applied');
  assert.equal((await h.reconcile()).finalized, 1);
  assert.equal(h.rows[0].values[3], 'v2-applied');
  const state = h.readState().payload;
  assert.equal(state.lotteries.length, 1);
  assert.equal(state.lotteries[0].quantity, 2);
  assert.equal(state.lotteries[0].officialMsrpYen, 6000);
  assert.equal(state.lotteries[0].resultDate, '2026-11-21');
  assert.equal(state.lotteries[0].status, '応募済');
  assert.equal(state.transactions.length, 0);
  assert.equal(state.inventoryLots.length, 0);
});

test('uncertain lottery stays review-only; never queued or written as an application', async () => {
  const h = harness([{
    requestId: 'chat:e2e:lottery:unknown', type: 'lottery',
    title: '商品A抽選', store: '店舗A', status: '応募済',
    applicationDate: '2026-11-14', evidenceType: 'screenshot',
    // No explicit applicant or externally issued ID: fail closed.
  }]);
  assert.equal((await h.intake()).review, 1);
  assert.equal(h.rows[0].values[3], 'review');
  assert.equal(h.rows[0].values[4], 'lottery-identity-missing');
  assert.equal(h.readState().revision, 0);
  assert.deepEqual(await h.reconcile(), { checked: 0, finalized: 0, pending: 0 });
});
