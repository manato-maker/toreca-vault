import assert from'node:assert/strict';import fs from'node:fs';
const code=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
assert.match(code,/parsed\.status==='落選'&&item\.receiptStatus!=='受取済み'/);
assert.match(code,/everyMinutes\(15\)/);
assert.match(code,/gmailMessageIds/);
assert.match(code,/gmailNeedsReview/);
assert.match(code,/draft\.deleteDraft\(\)/);
console.log('lottery automation safety: ok');
