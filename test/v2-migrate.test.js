import test from'node:test';import assert from'node:assert/strict';import{migrateV1,assertMigrationReconciled}from'../v2/migrate.js';
const root={data:{purchases:[{id:'p1'}],sales:[],openings:[],lotteries:[{id:'l1'}],boxes:[
{id:'s1',product:'スペシャルBOX ポケモンセンターフクオカ',quantity:1,cost:2090},
{id:'i1',product:'インフェルノX',quantity:1,cost:5400},
{id:'m1',product:'マクドナルド プロモカードパック',quantity:1,cost:null}
],packs:[],cards:[]}};
test('confirmed legacy condition/category normalization reconciles',()=>{const v=migrateV1(root);assert.equal(v.inventoryLots.find(x=>x.id==='migrated-s1').condition,'未開封');assert.equal(v.inventoryLots.find(x=>x.id==='migrated-i1').condition,'あり');const m=v.inventoryLots.find(x=>x.id==='migrated-m1');assert.equal(m.category,'パック');assert.equal(m.condition,'未開封');assert.equal(m.unitCost,null);assert.equal(assertMigrationReconciled(root,v).v2InventoryQty,3)});

test('explicitly unallocated zero legacy cost stays pending',()=>{const old={data:{purchases:[],sales:[],openings:[],lotteries:[],boxes:[],packs:[],cards:[{id:'c1',product:'エーフィ',quantity:1,cost:0,memo:'取得原価はセット内カードへ未配賦'}]}};const v=migrateV1(old);assert.equal(v.inventoryLots[0].unitCost,null);assert.equal(assertMigrationReconciled(old,v).v2InventoryQty,1)});
