import { v2Assets, v2RealizedProfit, v2ViewModel } from '../../v2/view-model.js';

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const quantity = row => Math.max(0, number(row?.quantity));
const yen = value => number(value);

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
    inventory
  };
}
