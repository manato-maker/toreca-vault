import test from'node:test';import assert from'node:assert/strict';
import{v2ViewModel,v2Assets,v2RealizedProfit}from'../v2/view-model.js';
const state={schemaVersion:2,transactions:[{id:'p',type:'purchase',product:'A',quantity:1,price:100},{id:'s',type:'sale',product:'A',quantity:1,price:160,fee:10,acquisitionCost:100}],inventoryLots:[{id:'l',product:'B',productKey:'B',category:'BOX',condition:'あり',quantity:2,unitCost:50,acquiredAt:'2026-01-01'}],lotteries:[{id:'x'}],marketQuotes:[{product:'B',productKey:'B',condition:'あり',price:80}],auditLog:[]};
test('v2 view model exposes canonical data without store inventory dimension',()=>{const x=v2ViewModel(state);assert.equal(x.boxes[0].marketPrice,80);assert.equal(x.boxes[0].store,undefined);assert.equal(x.sales.length,1);assert.equal(x.lotteries.length,1)});
test('v2 assets and realized profit use canonical state',()=>{assert.deepEqual(v2Assets(state),{inventoryCost:100,boxes:160,packs:0,cards:0,total:160,purchases:100,difference:60});assert.equal(v2RealizedProfit(state),50)});
test('unknown acquisition cost is excluded from realized profit',()=>{const x=structuredClone(state);x.transactions.push({id:'unknown',type:'sale',product:'C',quantity:1,price:999,acquisitionCost:null});assert.equal(v2RealizedProfit(x),50)});

import{applyV2ReadOnlyToUi}from'../js/v2-readonly.js';
test('read-only UI adapter does not alter fallback state without snapshot',()=>{const fallback={purchases:[{id:'old'}]};const x=applyV2ReadOnlyToUi(fallback,null);assert.equal(x.state,fallback);assert.equal(x.active,false)});
test('read-only UI adapter uses V2 projection when snapshot exists',()=>{const projected=v2ViewModel(state);const x=applyV2ReadOnlyToUi({purchases:[]},{state:projected,assets:{total:160},realizedProfit:50,revision:2,lastMutationId:'m'});assert.equal(x.active,true);assert.equal(x.state,projected);assert.equal(x.revision,2);assert.equal(x.lastMutationId,'m')});

test('inventory projection shows newest acquired lots first',()=>{const x=structuredClone(state);x.inventoryLots.push({id:'new',product:'Newest',productKey:'Newest',category:'BOX',condition:'あり',quantity:1,unitCost:1,acquiredAt:'2026-09-20'});const view=v2ViewModel(x);assert.equal(view.boxes[0].product,'Newest')});
