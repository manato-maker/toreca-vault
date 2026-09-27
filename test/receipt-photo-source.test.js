import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
test('receipt registration offers both camera capture and saved photo selection',()=>{
 assert.match(html,/id="receipt-camera"[^>]*capture="environment"/);
 assert.match(html,/id="receipt-photo"[^>]*accept="image\/\*"/);
 assert.doesNotMatch(html,/id="receipt-photo"[^>]*capture=/);
 assert.match(html,/保存済み写真を選択/);
});
test('receipt OCR and save use either selected photo source',()=>{
 assert.match(app,/const receiptPhotoInputs=\['receipt-camera','receipt-photo'\]/);
 assert.match(app,/const file=selectedReceiptPhoto\(\)/);
});
