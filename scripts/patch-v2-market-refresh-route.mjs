import fs from'node:fs';
const file=process.argv[2];if(!file)throw new Error('usage: node patch-v2-market-refresh-route.mjs <Code.js>');
let s=fs.readFileSync(file,'utf8');
const marker="function doPost(e) {";
if(!s.includes(marker))throw new Error('doPost not found');
const route=`function doPost(e) {
  var __tv2EarlyReq = {};
  try { __tv2EarlyReq = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) {}
  if (String(__tv2EarlyReq.action || '') === 'refresh-market-v2') {
    try { return tv2HandleMarketRefreshWeb_(__tv2EarlyReq); }
    catch (err) { return jsonResponse_({ok:false,error:String(err && err.message || err)}); }
  }`;
if(!s.includes("__tv2EarlyReq"))s=s.replace(marker,route);
fs.writeFileSync(file,s);
