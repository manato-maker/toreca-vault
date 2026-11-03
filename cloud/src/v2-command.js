import { validateState } from '../../v2/core.js';

const CATEGORIES = new Set(['BOX', 'パック', 'カード']);
const LOTTERY_STATUSES = new Set(['応募前', '応募済', '当選', '落選', '購入済']);
const clone = (value) => structuredClone(value);
const qty = (value) => Number(value?.quantity) || 0;
const norm = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000]/g, '');
const isoDate = (value) => {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
};

function requestParts(command) {
  const requestId = String(command?.requestId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(requestId)) throw new TypeError('requestId is missing or invalid');
  const type = String(command?.type || '');
  const mutationId = `chat:${type}:${requestId}`;
  return { requestId, type, mutationId };
}

function transactionIdExists(state, id) {
  return state.transactions.some((row) => String(row.id || '') === id);
}

function finishMutation(state, mutationId, transactionIds = []) {
  state.revision = Number(state.revision || 0) + 1;
  state.lastMutationId = mutationId;
  state.auditLog.push({ mutationId, transactionIds, revision: state.revision });
  validateState(state);
  return state;
}

function priorMutation(state, mutationId) {
  return state.lastMutationId === mutationId || state.auditLog.some((row) => row.mutationId === mutationId);
}

function checkBase(state) {
  validateState(clone(state));
  if (!Array.isArray(state.transactions) || !Array.isArray(state.inventoryLots) || !Array.isArray(state.lotteries)) {
    throw new TypeError('V2 collections are not initialized');
  }
}

function consumeLots(state, lots, quantity) {
  const available = lots.reduce((sum, lot) => sum + qty(lot), 0);
  if (available < quantity) throw new Error('insufficient inventory');
  lots.sort((a, b) => String(a.acquiredAt || '').localeCompare(String(b.acquiredAt || '')) || String(a.id || '').localeCompare(String(b.id || '')));
  let remaining = quantity;
  let cost = 0;
  let unknownCost = false;
  for (const lot of lots) {
    if (!remaining) break;
    const take = Math.min(qty(lot), remaining);
    const unitCost = lot.unitCost;
    if (unitCost === null || unitCost === undefined || unitCost === '' || !Number.isFinite(Number(unitCost))) unknownCost = true;
    else cost += take * Number(unitCost);
    lot.quantity = qty(lot) - take;
    remaining -= take;
  }
  state.inventoryLots = state.inventoryLots.filter((lot) => qty(lot) > 0);
  return unknownCost ? null : cost;
}

function commandDate(command, field = 'date') {
  const date = String(command[field] || '');
  if (!isoDate(date)) throw new TypeError(`${field} must be a valid YYYY-MM-DD date`);
  return date;
}

function applyPurchase(state, command, requestId, mutationId) {
  const product = String(command.product || '').trim();
  const category = String(command.category || '').trim();
  const condition = String(command.condition || '').trim();
  const store = String(command.store || '').trim();
  const date = commandDate(command);
  const quantity = Number(command.quantity);
  const enteredCost = Number(command.unitCost ?? command.price);
  const openingBox = String(command.openingBoxProduct || '').trim();
  const cardSet = String(command.cardSet || command.cardCode || '').trim();
  if (!product || !CATEGORIES.has(category) || !Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError('invalid purchase fields');
  if (!Number.isFinite(enteredCost) || enteredCost < 0) throw new TypeError('purchase unitCost must be explicit and non-negative');
  if (openingBox && (category !== 'カード' || quantity !== 1 || !cardSet)) throw new TypeError('opened-box card fields are incomplete');
  if (openingBox && enteredCost !== 0) throw new TypeError('a single acquired from an opened box must have zero cost');

  const purchaseId = `chat-purchase-${requestId}`;
  const openingId = `chat-opening-${requestId}`;
  const lotId = `${purchaseId}-lot`;
  const hasPurchase = transactionIdExists(state, purchaseId);
  const hasOpening = transactionIdExists(state, openingId);
  const hasLot = state.inventoryLots.some((lot) => String(lot.id || '') === lotId);
  if (hasPurchase || hasLot || (openingBox && hasOpening)) {
    if (hasPurchase && hasLot && (openingBox ? hasOpening : !hasOpening) && priorMutation(state, mutationId)) return { state: clone(state), duplicate: true, mutationId };
    throw new Error('partial duplicate purchase detected; manual review required');
  }

  const next = clone(state);
  const transactionIds = [];
  let source = 'chat';
  let memo = '';
  let actualUnitCost = enteredCost;
  if (openingBox) {
    const wanted = norm(openingBox);
    let boxes = next.inventoryLots.filter((lot) => lot.category === 'BOX' && qty(lot) > 0 && (norm(lot.productKey || lot.product) === wanted));
    const requestedSource = String(command.openingBoxPurchaseRequestId || '').trim();
    if (requestedSource) boxes = boxes.filter((lot) => String(lot.requestId || '') === requestedSource);
    const specifiedCondition = String(command.openingBoxCondition || '').trim();
    if (specifiedCondition) boxes = boxes.filter((lot) => String(lot.condition || '') === specifiedCondition);
    if (!boxes.length) throw new Error('opened box inventory was not found');
    if (!specifiedCondition && new Set(boxes.map((lot) => String(lot.condition || ''))).size > 1) throw new Error('box condition is ambiguous');
    const boxCost = consumeLots(next, boxes, 1);
    next.transactions.push({
      id: openingId, type: 'opening', product: openingBox, productKey: openingBox, category: 'BOX',
      condition: specifiedCondition || String(boxes[0]?.condition || ''), quantity: 1, price: 0, total: 0,
      date, source: 'chat', requestId, memo: `BOX開封｜${openingBox}`, acquisitionCost: boxCost
    });
    transactionIds.push(openingId);
    source = 'opening';
    memo = `開封獲得｜${openingBox}`;
    actualUnitCost = 0;
  }

  const total = actualUnitCost * quantity;
  const tx = {
    id: purchaseId, type: 'purchase', product, productKey: product, category, condition,
    set: category === 'カード' ? cardSet : '', quantity, price: actualUnitCost, total,
    date, store, source, requestId, memo
  };
  const lot = {
    id: lotId, product, productKey: product, category, condition,
    set: category === 'カード' ? cardSet : '', quantity, unitCost: actualUnitCost,
    acquiredAt: date, store, source, sourceTransactionId: purchaseId, requestId, memo
  };
  next.transactions.push(tx);
  next.inventoryLots.push(lot);
  transactionIds.push(purchaseId);
  finishMutation(next, mutationId, transactionIds);
  return { state: next, duplicate: false, mutationId, transactionIds };
}

function applySale(state, command, requestId, mutationId) {
  const product = String(command.product || '').trim();
  const category = String(command.category || '').trim();
  const condition = String(command.condition || '').trim();
  const store = String(command.store || command.soldTo || '').trim();
  const date = commandDate(command);
  const quantity = Number(command.quantity);
  const unitPrice = Number(command.unitPrice ?? command.price);
  const fee = Number(command.fee || 0);
  if (!product || !store || !CATEGORIES.has(category) || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0 || !Number.isFinite(fee) || fee < 0) {
    throw new TypeError('invalid sale fields');
  }
  const id = `chat-sale-${requestId}`;
  if (transactionIdExists(state, id)) {
    if (priorMutation(state, mutationId)) return { state: clone(state), duplicate: true, mutationId };
    throw new Error('sale ID exists without its mutation record; manual review required');
  }
  const productKey = norm(product);
  const candidates = state.inventoryLots.filter((lot) => qty(lot) > 0 && lot.category === category && norm(lot.productKey || lot.product) === productKey);
  const eligible = condition ? candidates.filter((lot) => String(lot.condition || '') === condition) : candidates;
  if (condition && !eligible.length) throw new Error('sale inventory was not found');
  if (!condition && new Set(eligible.map((lot) => String(lot.condition || ''))).size > 1) throw new Error('inventory condition is ambiguous');
  if (!eligible.length) throw new Error('sale inventory was not found');
  const next = clone(state);
  const lotIds = new Set(eligible.map((lot) => lot.id));
  const lots = next.inventoryLots.filter((lot) => lotIds.has(lot.id));
  const cost = consumeLots(next, lots, quantity);
  const tx = {
    id, type: 'sale', product, productKey: product, category, condition: condition || String(lots[0]?.condition || ''),
    quantity, price: unitPrice, total: unitPrice * quantity, fee, date, store, soldTo: store,
    source: 'chat', requestId, acquisitionCost: cost
  };
  next.transactions.push(tx);
  finishMutation(next, mutationId, [id]);
  return { state: next, duplicate: false, mutationId, transactionIds: [id] };
}

function applyOpening(state, command, requestId, mutationId) {
  const product = String(command.product || '').trim();
  const date = commandDate(command);
  const quantity = Number(command.quantity);
  const store = String(command.store || '').trim();
  if (!product || !Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError('invalid pack opening fields');
  const id = `chat-opening-${requestId}`;
  if (transactionIdExists(state, id)) {
    if (priorMutation(state, mutationId)) return { state: clone(state), duplicate: true, mutationId };
    throw new Error('opening ID exists without its mutation record; manual review required');
  }
  let candidates = state.inventoryLots.filter((lot) => qty(lot) > 0 && lot.category === 'パック' && norm(lot.productKey || lot.product) === norm(product));
  const sourceIds = new Set((Array.isArray(command.sourcePurchaseRequestIds) ? command.sourcePurchaseRequestIds : [command.sourcePurchaseRequestId]).filter(Boolean).map(String));
  if (sourceIds.size) candidates = candidates.filter((lot) => sourceIds.has(String(lot.requestId || '')));
  if (store) candidates = candidates.filter((lot) => norm(lot.store) === norm(store));
  if (!candidates.length) throw new Error('pack inventory was not found');
  if (candidates.length > 1 && !sourceIds.size) throw new Error('pack source lot is ambiguous; provide sourcePurchaseRequestId');
  const next = clone(state);
  const lotIds = new Set(candidates.map((lot) => lot.id));
  const lots = next.inventoryLots.filter((lot) => lotIds.has(lot.id));
  const cost = consumeLots(next, lots, quantity);
  const selectedStore = store || String(lots[0]?.store || '');
  next.transactions.push({
    id, type: 'opening', product, productKey: product, category: 'パック', condition: '開封済み',
    quantity, price: 0, total: 0, date, store: selectedStore, source: 'chat', requestId,
    memo: String(command.memo || 'パック開封｜シングルは別途報告'), acquisitionCost: cost,
    acquisitionCostBasis: '購入履歴のみ保持'
  });
  finishMutation(next, mutationId, [id]);
  return { state: next, duplicate: false, mutationId, transactionIds: [id] };
}

function applyLottery(state, command, requestId, mutationId, now) {
  const title = String(command.title || command.product || '').trim();
  const store = String(command.store || '').trim();
  const status = String(command.status || '応募済').trim();
  const applicationDate = commandDate(command, 'applicationDate');
  if (!title || !store || !LOTTERY_STATUSES.has(status) || !['応募前', '応募済'].includes(status)) throw new TypeError('invalid lottery application fields');
  for (const field of ['deadline', 'resultDate', 'receiveDeadline']) {
    if (command[field] && !isoDate(command[field])) throw new TypeError(`${field} must be a valid YYYY-MM-DD date`);
  }
  const id = `chat-lottery-${requestId}`;
  const existing = state.lotteries.filter((item) => String(item.id || '') === id);
  if (existing.length) {
    if (existing.length === 1 && priorMutation(state, mutationId)) return { state: clone(state), duplicate: true, mutationId };
    throw new Error('lottery ID exists without its mutation record; manual review required');
  }
  const next = clone(state);
  next.lotteries.push({
    id, title, store, status, deadline: String(command.deadline || ''),
    resultDate: String(command.resultDate || ''), receiveDeadline: String(command.receiveDeadline || ''),
    receiptStatus: status === '当選' ? '未受取' : status === '購入済' ? '受取済み' : '対象外',
    receivedDate: '', shrinkStatus: '未選択', memo: String(command.memo || ''), owner: String(command.owner || ''),
    applicationDate, source: 'chat', requestId, evidenceType: command.evidenceType === 'screenshot' ? 'screenshot' : 'chat-report',
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
  });
  finishMutation(next, mutationId, []);
  return { state: next, duplicate: false, mutationId, lotteryIds: [id] };
}

/** Pure V2 state transition for the first safe command set; it never performs I/O. */
export function applyChatCommand(currentState, command, { now = Date.now() } = {}) {
  checkBase(currentState);
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a non-negative timestamp');
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new TypeError('command must be an object');
  const { requestId, type, mutationId } = requestParts(command);
  if (priorMutation(currentState, mutationId)) return { state: clone(currentState), duplicate: true, mutationId };
  switch (type) {
    case 'purchase': return applyPurchase(currentState, command, requestId, mutationId);
    case 'sale': return applySale(currentState, command, requestId, mutationId);
    case 'open-packs': return applyOpening(currentState, command, requestId, mutationId);
    case 'lottery': return applyLottery(currentState, command, requestId, mutationId, now);
    default: throw new Error(`command type ${type || '(empty)'} is not implemented; manual review required`);
  }
}
