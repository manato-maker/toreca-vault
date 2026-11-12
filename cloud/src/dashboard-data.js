import { v2Assets, v2RealizedProfit, v2ViewModel } from '../../v2/view-model.js';

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const quantity = row => Math.max(0, number(row?.quantity));
const yen = value => number(value);

function exactDate(value) {
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const parsed = new Date(date + 'T00:00:00.000Z');
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date ? '' : date;
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function calendarEvent({ date, type, title, store = '', status = '', receiptStatus = '', memo = '', sourceUrl = '', amount = null, quantity: count = null }) {
  const eventDate = exactDate(date);
  if (!eventDate) return null;
  return {
    date: eventDate,
    type,
    title: String(title || '予定'),
    store: String(store || ''),
    status: String(status || ''),
    receiptStatus: String(receiptStatus || ''),
    memo: String(memo || ''),
    sourceUrl: safeSourceUrl(sourceUrl),
    amount: amount === null ? null : yen(amount),
    quantity: count === null ? null : quantity({ quantity: count })
  };
}

export function dashboardReadModel(state, updatedAt = new Date().toISOString()) {
  const model = v2ViewModel(state);
  const assets = v2Assets(state);
  const inventory = [...model.boxes, ...model.cards, ...model.packs].map(row => ({
    product: String(row.product || row.productKey || ''),
    category: String(row.category || ''),
    set: String(row.set || ''),
    condition: String(row.condition || ''),
    quantity: quantity(row),
    unitCost: row.cost == null || row.cost === '' || !Number.isFinite(Number(row.cost)) ? null : Number(row.cost),
    marketPrice: row.marketPrice == null || !Number.isFinite(Number(row.marketPrice)) ? null : Number(row.marketPrice),
    marketCheckedAt: String(row.marketCheckedAt || ''),
    marketSource: String(row.marketSource || ''),
    marketFresh: row.marketFresh === true,
    identityNeedsReview: row.identityNeedsReview === true
  })).filter(row => row.product && row.quantity > 0);

  const sales = (state.transactions || []).filter(row => row.type === 'sale');
  const salesTotal = sales.reduce((sum, row) =>
    sum + yen(row.price) * quantity(row) - yen(row.fee), 0);
  const unknownCostLots = inventory.filter(row => row.unitCost === null).length;
  const transactions = (state.transactions || [])
    .slice()
    .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')))
    .slice(0, 30)
    .map(row => {
      const rowQuantity = Math.max(1, quantity(row));
      const type = String(row.type || '');
      const amount = type === 'sale'
        ? yen(row.price) * rowQuantity - yen(row.fee)
        : type === 'purchase'
          ? yen(row.total) || yen(row.price) * rowQuantity
          : 0;
      return {
        type: type === 'purchase' ? '購入' : type === 'sale' ? '売却' : type === 'opening' ? '開封' : '記録',
        date: String(row.date || ''),
        product: String(row.product || ''),
        quantity: rowQuantity,
        amount
      };
    });

  const calendarEvents = [];
  for (const item of state.lotteries || []) {
    const title = String(item.title || item.product || '抽選');
    const shared = {
      title,
      store: item.store,
      status: item.status,
      receiptStatus: item.receiptStatus,
      memo: item.memo,
      sourceUrl: item.sourceUrl || item.url
    };
    for (const [field, type] of [
      ['applicationDate', '応募'],
      ['deadline', '応募締切'],
      ['resultDate', '当選発表'],
      ['receiveDeadline', '受取期限'],
      ['receivedDate', '受取']
    ]) {
      const event = calendarEvent({ ...shared, date: item[field], type });
      if (event) calendarEvents.push(event);
    }
  }
  for (const row of state.transactions || []) {
    const type = row.type === 'purchase' ? '購入' : row.type === 'sale' ? '売却' : row.type === 'opening' ? '開封' : '';
    if (!type) continue;
    const amount = type === '購入'
      ? yen(row.total) || yen(row.price) * quantity(row)
      : type === '売却'
        ? yen(row.price) * quantity(row) - yen(row.fee)
        : null;
    const event = calendarEvent({
      date: row.date,
      type,
      title: row.product,
      store: row.store || row.soldTo,
      amount,
      quantity: row.quantity
    });
    if (event) calendarEvents.push(event);
  }
  calendarEvents.sort((left, right) => left.date.localeCompare(right.date)
    || left.type.localeCompare(right.type, 'ja'));

  return {
    ok: true,
    revision: Number(state.revision) || 0,
    updatedAt,
    assets: {
      inventoryCost: yen(assets.inventoryCost),
      cards: yen(assets.cards),
      boxes: yen(assets.boxes),
      packs: yen(assets.packs),
      total: yen(assets.total),
      purchases: yen(assets.purchases),
      sales: salesTotal,
      difference: yen(assets.difference)
    },
    realizedProfit: yen(v2RealizedProfit(state)),
    stockKinds: inventory.length,
    stockQuantity: inventory.reduce((sum, row) => sum + row.quantity, 0),
    unknownCostLots,
    inventory,
    transactions,
    calendarEvents
  };
}
