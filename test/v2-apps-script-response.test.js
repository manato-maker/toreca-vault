import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');
test('Apps Script V2 client accepts JSON and JSONP responses',()=>{
 assert.match(src,/function tv2ParseResponse_/);
 assert.match(src,/JSON\.parse\(json\)/);
 assert.match(src,/const j=tv2ParseResponse_\(r\.getContentText\(\)\)/);
 assert.match(src,/response is not JSON\/JSONP/);
});


test('V2 automation reuses the existing canonical V2 sync token property', () => {
  const source = fs.readFileSync(new URL('../automation/V2Automation.gs', import.meta.url), 'utf8');
  assert.match(source, /getProperty\('TV_V2_SYNC_TOKEN'\)/);
  assert.match(source, /getProperty\(TV2_SYNC_TOKEN_PROP\).*getProperty\('TV_V2_SYNC_TOKEN'\)/);
});
