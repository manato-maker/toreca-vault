/**
 * Toreca Vault v2 fixed persistence API.
 * IMPORTANT: deploy this code directly in Apps Script.
 * It never downloads/evals application code during a request.
 *
 * Script properties:
 * TV_V2_DATA_FILE_ID  - dedicated v2 JSON file (NOT the v1 production file)
 * TV_V2_SYNC_TOKEN    - random secret, 24+ chars
 */
function doGet(e) {
  try {
    tv2Auth_(e && e.parameter && e.parameter.token);
    if ((e.parameter.action || 'load') !== 'load') throw new Error('unsupported action');
    var root = tv2Read_();
    return tv2Reply_(e, {ok:true, payload:root, revision:Number(root.revision)||0, lastMutationId:root.lastMutationId||''});
  } catch (err) {
    return tv2Reply_(e, {ok:false, error:String(err && err.message || err)});
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var req = JSON.parse(e.postData && e.postData.contents || '{}');
    tv2Auth_(req.token);
    if (req.action === 'load') {
      var loaded = tv2Read_();
      return tv2Json_({ok:true, payload:loaded, revision:Number(loaded.revision)||0, lastMutationId:loaded.lastMutationId||''});
    }
    if (!req.mutationId) throw new Error('mutationId required');
    var current = tv2Read_();
    if (current.lastMutationId === req.mutationId) {
      return tv2Json_({ok:true, duplicate:true, revision:Number(current.revision)||0, lastMutationId:current.lastMutationId});
    }
    if (Number(req.expectedRevision) !== Number(current.revision)) {
      return tv2Json_({ok:false, conflict:true, error:'revision conflict', revision:Number(current.revision)||0});
    }
    var next = req.payload;
    tv2Validate_(next);
    if (next.lastMutationId !== req.mutationId) throw new Error('mutationId mismatch');
    if (Number(next.revision) !== Number(current.revision)+1) throw new Error('revision must increment by 1');

    var file = DriveApp.getFileById(tv2Prop_('TV_V2_DATA_FILE_ID'));
    var before = file.getBlob().getDataAsString('UTF-8');
    try {
      file.setContent(JSON.stringify(next, null, 2));
      var reread = tv2Read_();
      tv2Validate_(reread);
      if (reread.lastMutationId !== req.mutationId || Number(reread.revision) !== Number(next.revision) || tv2Canonical_(reread) !== tv2Canonical_(next)) {
        throw new Error('post-write verification failed');
      }
      return tv2Json_({ok:true, revision:Number(reread.revision), lastMutationId:reread.lastMutationId});
    } catch (writeErr) {
      // Roll back and verify restoration. Never report success if either verification fails.
      try {
        file.setContent(before);
        var restored = file.getBlob().getDataAsString('UTF-8');
        if (restored !== before) throw new Error('rollback verification failed');
      } catch (rollbackErr) {
        throw new Error('write failed and rollback was not verified: '+String(rollbackErr && rollbackErr.message || rollbackErr));
      }
      throw writeErr;
    }
  } catch (err) {
    return tv2Json_({ok:false, error:String(err && err.message || err)});
  } finally {
    lock.releaseLock();
  }
}

function tv2Read_() {
  var text = DriveApp.getFileById(tv2Prop_('TV_V2_DATA_FILE_ID')).getBlob().getDataAsString('UTF-8');
  var root = JSON.parse(text);
  tv2Validate_(root);
  return root;
}
function tv2Validate_(x) {
  if (!x || Number(x.schemaVersion) !== 2) throw new Error('invalid schemaVersion');
  ['transactions','inventoryLots','lotteries','marketQuotes','auditLog'].forEach(function(k){
    if (!Array.isArray(x[k])) throw new Error('invalid '+k);
  });
  var tx = {};
  x.transactions.forEach(function(t){if(!t.id || tx[t.id]) throw new Error('duplicate transactionId'); tx[t.id]=true;});
  var lots = {};
  x.inventoryLots.forEach(function(l){if(!l.id || lots[l.id]) throw new Error('duplicate inventory lot'); lots[l.id]=true; if(!(Number(l.quantity)>0)) throw new Error('invalid inventory quantity');});
  return true;
}
function tv2Canonical_(x) { return JSON.stringify(x); }
function tv2Auth_(token) {
  var expected = tv2Prop_('TV_V2_SYNC_TOKEN');
  if (!token || token !== expected) throw new Error('unauthorized');
}
function tv2Prop_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error(name+' is not configured');
  return v;
}
function tv2Json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function tv2Reply_(e,obj) {
  var cb = e && e.parameter && e.parameter.callback;
  if (cb && /^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(cb)) {
    return ContentService.createTextOutput(cb+'('+JSON.stringify(obj)+');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return tv2Json_(obj);
}


function runTorecaVaultV2MarketSync() {
  var lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    var current=tv2Read_(),next=JSON.parse(JSON.stringify(current)),rows=tv2FetchCardrushRows_(),date=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd'),updated=0,preserved=0;
    next.inventoryLots.filter(function(l){return l.category==='カード'&&Number(l.quantity)>0}).forEach(function(l){
      var model=tv2ExtractModel_(l),result=model?tv2FindCardrushBuyback_(rows,l.product,model):null;
      if(!result){preserved++;return}
      var k=tv2MarketKey_(l),i=next.marketQuotes.findIndex(function(q){return tv2MarketKey_(q)===k}),old=i>=0?next.marketQuotes[i]:null;
      var history=(old&&Array.isArray(old.history)?old.history.slice():[]);
      if(!history.some(function(h){return String(h.checkedAt||h.date)===date&&Number(h.price||h.value)===result.price}))history.push({price:result.price,checkedAt:date,source:result.source});
      var quote={product:l.product,productKey:l.productKey,category:l.category,condition:l.condition,price:result.price,checkedAt:date,source:result.source,history:history.slice(-400)};
      if(i>=0)next.marketQuotes[i]=quote;else next.marketQuotes.push(quote);updated++;
    });
    if(!updated)return{ok:false,updated:0,preserved:preserved,revision:Number(current.revision)||0};
    next.revision=(Number(current.revision)||0)+1;next.lastMutationId='market-sync-'+new Date().getTime();
    next.auditLog.push({id:next.lastMutationId,at:new Date().toISOString(),type:'market-sync',revision:next.revision,updated:updated,preserved:preserved});
    var file=DriveApp.getFileById(tv2Prop_('TV_V2_DATA_FILE_ID')),before=file.getBlob().getDataAsString('UTF-8');
    try{tv2Validate_(next);file.setContent(JSON.stringify(next,null,2));var reread=tv2Read_();if(tv2Canonical_(reread)!==tv2Canonical_(next))throw new Error('market sync verification failed');return{ok:true,updated:updated,preserved:preserved,revision:next.revision}}
    catch(err){file.setContent(before);throw err}
  }finally{lock.releaseLock()}
}
function tv2ExtractModel_(x){var text=[x.set,x.product,x.productKey].filter(Boolean).join(' ').normalize('NFKC');var m=text.match(/\b[A-Z0-9-]*\d[A-Z0-9-]*\s+\d{3}\/\d{3}\b/i)||text.match(/\b\d{3}\/\d{3}\b/i);return m?m[0].toUpperCase().replace(/\s+/g,' '):''}
var TV2_CARDRUSH_CSV='https://docs.google.com/spreadsheets/d/e/2PACX-1vQT3Q9qDbZUpnP3_WH2I5qw8O-U_PqXVhhoIzH2o-tSzeDND9FTuoGKbZiNHTbrzTgKAUA2_SvXFh_2/pub?gid=1490875147&single=true&output=csv';
function tv2FetchCardrushRows_(){var r=UrlFetchApp.fetch(TV2_CARDRUSH_CSV+'&v='+Date.now(),{muteHttpExceptions:true,followRedirects:true});if(r.getResponseCode()!==200)throw new Error('Cardrush CSV HTTP '+r.getResponseCode());return Utilities.parseCsv(r.getContentText('UTF-8'))}
function tv2Norm_(x){return String(x||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'')}
function tv2FindCardrushBuyback_(rows,product,model){var pn=tv2Norm_(String(product||'').replace(model,'')),mn=tv2Norm_(model),hits=rows.filter(function(row){var t=tv2Norm_(row.join(' '));return t.indexOf(pn)>=0&&t.indexOf(mn)>=0}).map(function(row){var ps=row.map(function(cell){var s=String(cell||'').normalize('NFKC').replace(/[,，円¥￥\s]/g,'');return /^\d{2,7}$/.test(s)?Number(s):0}).filter(function(x){return x>=10});return ps.length?ps[ps.length-1]:0}).filter(Boolean),unique=hits.filter(function(x,i,a){return a.indexOf(x)===i});return unique.length===1?{price:unique[0],source:'カードラッシュ'}:null}
function tv2MarketKey_(x){return tv2Norm_(x.productKey||x.product)+'::'+String(x.condition||'')}
