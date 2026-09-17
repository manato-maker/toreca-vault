import test from'node:test';
import assert from'node:assert/strict';
import{emptyState}from'../js/schema.js';
import{applyPurchase,applySale}from'../js/inventory.js';

const memory=new Map();
globalThis.localStorage={getItem:k=>memory.has(k)?memory.get(k):null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)};
const{save,load}=await import('../js/storage.js');

test('売却済み在庫は保存後の再読込で復活しない',()=>{
 memory.clear();
 let s=applyPurchase(emptyState(),{id:'p1',product:'30th CELEBRATION',inventoryKey:'pokemon-30th-celebration-box',shrinkStatus:'シュリンクなし',category:'BOX',quantity:2,price:7000,inventoryAction:'在庫へ追加'});
 s=applySale(s,{id:'s1',product:'30th CELEBRATION',inventoryKey:'pokemon-30th-celebration-box',shrinkStatus:'シュリンクなし',category:'BOX',quantity:2,price:16600,inventoryAction:'在庫から減算'});
 assert.equal(s.boxes.length,0);
 save(s,{touch:false});
 const reloaded=load();
 assert.equal(reloaded.boxes.length,0);
 assert.equal(reloaded.purchases.length,1);
 assert.equal(reloaded.sales.length,1);
});

test('数量0の古い在庫は読込時に除外する',()=>{
 memory.clear();
 const s=emptyState();
 s.boxes=[{id:'sold',product:'売却済み',quantity:0,cost:7000}];
 save(s,{touch:false});
 assert.equal(load().boxes.length,0);
});
