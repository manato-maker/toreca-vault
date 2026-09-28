import fs from'node:fs';
const file=process.argv[2];if(!file)throw new Error('usage: node patch-v2-market-refresh-route.mjs <Code.js>');
let s=fs.readFileSync(file,'utf8');
const marker="function doPost(e) {";
const getMarker="function doGet(e) {";
if(!s.includes(marker))throw new Error('doPost not found');
if(!s.includes(getMarker))throw new Error('doGet not found');
const route=`function doPost(e) {
  var __tv2EarlyReq = {};
  try { __tv2EarlyReq = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) {}
  if (String(__tv2EarlyReq.action || '') === 'process-mega-rayquaza-once') {
    try { return jsonResponse_(tv2ProcessMegaRayquazaOnceWeb_()); }
    catch (err) { return jsonResponse_({ok:false,error:String(err && err.message || err)}); }
  }
  if (['refresh-market-v2','refresh-single-market-v2','repair-known-card-identities-v2','process-command-queue-v2'].includes(String(__tv2EarlyReq.action || ''))) {
    try { return tv2HandleMarketRefreshWeb_(__tv2EarlyReq); }
    catch (err) { return jsonResponse_({ok:false,error:String(err && err.message || err)}); }
  }`;
if(!s.includes("__tv2EarlyReq"))s=s.replace(marker,route);
const liveEarly="  if (['refresh-market-v2','process-command-queue-v2'].includes(String(__tv2EarlyReq.action || ''))) {";
if(!s.includes("process-mega-rayquaza-once")){
  s=s.replace(liveEarly,`  if (String(__tv2EarlyReq.action || '') === 'process-mega-rayquaza-once') {
    try { return jsonResponse_(tv2ProcessMegaRayquazaOnceWeb_()); }
    catch (err) { return jsonResponse_({ok:false,error:String(err && err.message || err)}); }
  }
${liveEarly}`);
}
const getRoute=`function doGet(e) {
  var __tv2OneTimeAction = String(e && e.parameter && e.parameter.action || '');
  if (__tv2OneTimeAction === 'gmail-sync-now-20260928b') {
    try { return jsonResponse_({ok:true,result:runTv2LotteryAuto()}); }
    catch (err) { return jsonResponse_({ok:false,error:String(err && err.message || err)}); }
  }
  if (__tv2OneTimeAction === 'process-mega-rayquaza') {
    try { return jsonResponse_(tv2ProcessOneCommandByNonce_(e.parameter.requestId, e.parameter.nonce)); }
    catch (err) { return jsonResponse_({ok:false,error:String(err && err.message || err)}); }
  }`;
if(!s.includes("__tv2OneTimeAction"))s=s.replace(getMarker,getRoute);
s=s.replace(/  if \\(__tv2OneTimeAction === 'gmail-sync-now-20260928'\\) \\{[\\s\\S]*?\\n  \\}\\n/g,'');
s=s.replace(/  if \\(__tv2OneTimeAction === 'gmail-pickup-verify-20260928'\\) \\{[\\s\\S]*?\\n  \\}\\n/g,'');
if(s.includes("__tv2OneTimeAction")&&!s.includes("gmail-sync-now-20260928b")){
  s=s.replace("  var __tv2OneTimeAction = String(e && e.parameter && e.parameter.action || '');\n","  var __tv2OneTimeAction = String(e && e.parameter && e.parameter.action || '');\n  if (__tv2OneTimeAction === 'gmail-sync-now-20260928b') {\n    try { return jsonResponse_({ok:true,result:runTv2LotteryAuto()}); }\n    catch (err) { return jsonResponse_({ok:false,error:String(err && err.message || err)}); }\n  }\n");
}
fs.writeFileSync(file,s);
