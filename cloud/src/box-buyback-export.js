/**
 * Private, read-only BOX inventory presentation for a user-authorized
 * buyback-price comparison. Never derives stock from transactions, never
 * guesses wrapping/tape status, and never includes store, prices or IDs.
 */
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/g, '');
const cleanName = s => String(s || '').normalize('NFKC').replace(/[\r\n\t]+/g, ' ').trim();

export function classifyBoxCondition(raw) {
  const value = norm(raw);
  if (/(開封済|開封用|開封後|開梱済|バラパック|パックのみ|残パック|空箱|テープカット|テープ切断|テープ剥がし)/.test(value)) {
    return { label: '開封済・テープカット等', group: 'excluded' };
  }
  // Conservatively reject contradictory or unspecified sealing labels.
  const shrinkAbsent = /シュリンク(?:なし|無し|無|剥がし|はがし)/.test(value);
  const shrinkPresent = /シュリンク(?:あり|有り|有|付き|付|未開封)/.test(value);
  const tapeAbsent = /テープ(?:なし|無し|無|剥がし|はがし)/.test(value);
  const tapePresent = /テープ(?:あり|有り|有|付き|付|未カット|未切断)/.test(value);
  if ((shrinkPresent && shrinkAbsent) || (tapePresent && tapeAbsent)
    || (shrinkPresent || shrinkAbsent) && (tapePresent || tapeAbsent)) {
    return {label:'封印状態に矛盾・混在あり',group:'review'};
  }
  if (shrinkPresent) return { label: 'シュリンクあり', group: 'target' };
  if (shrinkAbsent) return { label: 'シュリンクなし', group: 'target' };
  if (/テープ(?:未カット|未切断)/.test(value)) return { label: 'テープ未カット', group: 'target' };
  if (tapePresent) return { label: 'テープ付き（カット有無未確認）', group: 'review' };
  if (tapeAbsent) return { label: 'テープなし（要確認）', group: 'review' };
  return { label: 'シュリンク・テープ状態未記録', group: 'review' };
}

export function buildBoxBuybackExport(canonical) {
  if (!canonical || !Number.isSafeInteger(canonical.revision) || canonical.revision < 0
    || canonical.payload?.revision !== canonical.revision
    || !Array.isArray(canonical.payload.inventoryLots)) {
    throw new Error('canonical snapshot unavailable or inconsistent');
  }
  const entries = new Map();
  for (const lot of canonical.payload.inventoryLots) {
    if (lot?.category !== 'BOX') continue;
    const quantity = lot.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error('BOX inventory quantity requires review; no export created');
    }
    if (quantity === 0) continue;
    const product = cleanName(lot.product || lot.productKey);
    if (!product || product.length > 500) throw new Error('BOX inventory product name is invalid');
    const state = classifyBoxCondition(lot.condition);
    const key = JSON.stringify([norm(product),state.group,state.label]);
    const prior = entries.get(key);
    const total = (prior?.quantity || 0) + quantity;
    if (!Number.isSafeInteger(total)) throw new Error('BOX quantity overflow; no export created');
    entries.set(key,{product:prior?.product || product,quantity:total,...state});
  }
  const sort = x => x.sort((a,b)=>a.product.localeCompare(b.product,'ja') || a.label.localeCompare(b.label,'ja'));
  const all=[...entries.values()];
  return {
    revision:canonical.revision,
    target:sort(all.filter(x=>x.group==='target')),
    review:sort(all.filter(x=>x.group==='review')),
    excluded:sort(all.filter(x=>x.group==='excluded'))
  };
}

export function formatBoxBuybackExport(exported, time = new Date()) {
  if (!exported || !Array.isArray(exported.target) || !Array.isArray(exported.review)
    || !Array.isArray(exported.excluded) || Number.isNaN(time.getTime())) {
    throw new TypeError('valid export and capture date required');
  }
  const timestamp=new Intl.DateTimeFormat('ja-JP',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hour12:false
  }).format(time);
  const lines=[
    '【Toreca Vault｜Grok用BOX買取調査リスト】',
    '抽出日時: '+timestamp+'（日本時間）',
    '元データ: staging Firestore 正本 revision '+exported.revision,
    '在庫の真偽はこの取得時点に限る。買取価格の照合に使い、固定データを最新在庫として扱わないこと。',
    '',
    '■ 買取価格の調査対象（状態を確認できたBOX）'
  ];
  if(exported.target.length===0) lines.push('該当なし');
  for(const row of exported.target)lines.push('- '+row.product+'｜'+row.quantity+'BOX｜'+row.label);
  lines.push('', '■ 状態未確認BOX（商品名で参考価格を調査する候補。状態確定前は査定額を算定しない）');
  if(exported.review.length===0)lines.push('該当なし');
  for(const row of exported.review)lines.push('- '+row.product+'｜'+row.quantity+'BOX｜'+row.label);
  lines.push('', '■ 除外（開封済み・テープカット等）');
  if(exported.excluded.length===0) lines.push('該当なし');
  for(const row of exported.excluded)lines.push('- '+row.product+'｜'+row.quantity+'BOX｜'+row.label);
  lines.push('', '価格確認: 買取ミミ / カードショップアリウム / AMTAF日本橋',
    '状態未確認BOXについても商品名で投稿を検索し、状態別の参考買取額を記録する。状態が一致した確定買取額として扱わない。',
    '同一商品らしい別表記があっても、所有者による確認なしに数量を統合しない。',
    '画像と商品・封印状態を照合し、投稿日時・X URL・店舗別買取額を添える。未確認の価格は推測しない。',
    '※購入原価、店舗、取引履歴、ユーザー識別子は出力していません。');
  return lines.join('\n')+'\n';
}
