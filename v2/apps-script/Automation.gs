// Deployment sync probe 11: market writer skeleton hard-locked; source adapter fail-closed.
/**
 * Toreca Vault V2 automation runner (separate Apps Script project).
 *
 * Deploy this in a DIFFERENT Apps Script project from the V2 persistence API.
 * Required Script Property:
 *   TV_V2_DATA_FILE_ID
 *
 * Safety:
 * - never writes the V1 file
 * - uses ScriptLock
 * - save -> reread -> canonical compare
 * - restores the original bytes and verifies rollback on failure
 * - no triggers are created until installTorecaVaultV2Automation() is run manually
 */
var TV2_AUTO_TZ = 'Asia/Tokyo';

function installTorecaVaultV2Automation() {
  tv2AutoAssertProductionReady_();
  tv2AutoRemoveTriggers_();
  ScriptApp.newTrigger('runTorecaVaultV2LotterySync').timeBased().atHour(12).nearMinute(30).everyDays(1).inTimezone(TV2_AUTO_TZ).create();
  ScriptApp.newTrigger('runTorecaVaultV2LotterySync').timeBased().atHour(19).nearMinute(0).everyDays(1).inTimezone(TV2_AUTO_TZ).create();
  ScriptApp.newTrigger('runTorecaVaultV2MarketSync').timeBased().atHour(13).nearMinute(0).everyDays(1).inTimezone(TV2_AUTO_TZ).create();
  PropertiesService.getScriptProperties().setProperty('TV_V2_AUTOMATION_INSTALLED_AT', new Date().toISOString());
  return {ok:true, installed:true};
}

function uninstallTorecaVaultV2Automation() {
  tv2AutoRemoveTriggers_();
  return {ok:true, installed:false};
}

function acceptTorecaVaultV2ReadOnly() {
  var preview = previewTorecaVaultV2Automation();
  var inspection = inspectTorecaVaultV2Automation();
  if (!preview.readOnly || !inspection.readOnly) throw new Error('read-only acceptance failed');
  if (Number(preview.schemaVersion) !== 2) throw new Error('unexpected schemaVersion');
  if (inspection.productionReady) throw new Error('production writers must remain locked');
  if (inspection.v2TriggerHandlers.length) throw new Error('V2 triggers must not exist during read-only acceptance');
  return {
    ok: true,
    readOnly: true,
    accepted: true,
    revision: preview.revision,
    lastMutationId: preview.lastMutationId,
    transactions: preview.transactions,
    lotteries: preview.lotteries,
    inventoryQuantity: preview.inventoryQuantity,
    productionReady: false,
    v2TriggerHandlers: []
  };
}

function preflightTorecaVaultV2Deployment() {
  var inspection = inspectTorecaVaultV2Automation();
  if (!inspection.dataFileConfigured) throw new Error('TV_V2_DATA_FILE_ID is not configured');
  if (!inspection.readOnly || inspection.productionReady) throw new Error('deployment must remain read-only');
  if (inspection.v2TriggerHandlers.length) throw new Error('V2 triggers already exist');
  return {ok:true, readOnly:true, productionReady:false, dataFileConfigured:true, v2TriggerHandlers:[]};
}

function getTorecaVaultV2DeploymentChecklist() {
  var inspection = inspectTorecaVaultV2Automation();
  return {
    ok:true,
    readOnly:true,
    sourceComplete:
      typeof acceptTorecaVaultV2ReadOnly === 'function' &&
      typeof acceptTorecaVaultV2MarketReadOnly === 'function' &&
      typeof preflightTorecaVaultV2Deployment === 'function',
    dataFileConfigured:inspection.dataFileConfigured,
    productionReady:inspection.productionReady,
    v2TriggerHandlers:inspection.v2TriggerHandlers,
    nextAction:'acceptTorecaVaultV2Deployment'
  };
}

function acceptTorecaVaultV2Deployment() {
  preflightTorecaVaultV2Deployment();
  var base = acceptTorecaVaultV2ReadOnly();
  var market = acceptTorecaVaultV2MarketReadOnly();
  var lottery = previewTorecaVaultV2LotteryMailParsing();
  var inspection = inspectTorecaVaultV2Automation();
  if (!base.accepted || !market.accepted) throw new Error('read-only acceptance incomplete');
  if (inspection.productionReady) throw new Error('production must remain locked');
  if (inspection.v2TriggerHandlers.length) throw new Error('V2 triggers must remain absent');
  return {
    ok:true,
    readOnly:true,
    accepted:true,
    revision:base.revision,
    transactions:base.transactions,
    lotteries:base.lotteries,
    inventoryQuantity:base.inventoryQuantity,
    marketAccepted:true,
    lotteryPreview:{accepted:lottery.accepted, review:lottery.review, providers:lottery.providers},
    productionReady:false,
    v2TriggerHandlers:[]
  };
}

function inspectTorecaVaultV2Automation() {
  var triggers = ScriptApp.getProjectTriggers().map(function(t) {
    return String(t.getHandlerFunction());
  }).filter(function(name) {
    return ['runTorecaVaultV2LotterySync','runTorecaVaultV2MarketSync'].indexOf(name) >= 0;
  });
  return {
    ok: true,
    readOnly: true,
    dataFileConfigured: !!PropertiesService.getScriptProperties().getProperty('TV_V2_DATA_FILE_ID'),
    lotteryWriterReady: tv2AutoLotteryWriterReady_(),
    marketWriterReady: tv2AutoMarketWriterReady_(),
    productionReady: tv2AutoLotteryWriterReady_() && tv2AutoMarketWriterReady_(),
    v2TriggerHandlers: triggers
  };
}

function previewTorecaVaultV2LotteryMailParsing() {
  var threads = GmailApp.search('newer_than:30d (LivePocket OR "日本トイザらス株式会社" OR "フォームにご記入いただきありがとうございます")', 0, 100);
  var accepted = 0, review = 0, providers = {};
  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      var parsed = tv2AutoParseLotteryMail_({
        id:String(message.getId() || ''),
        subject:String(message.getSubject() || ''),
        body:String(message.getPlainBody() || ''),
        receivedAt:message.getDate() ? message.getDate().toISOString() : ''
      });
      if (parsed.ok) {
        accepted++;
        var source = String(parsed.input.source || 'unknown');
        providers[source] = (providers[source] || 0) + 1;
      } else review++;
    });
  });
  return {ok:true, readOnly:true, threads:threads.length, accepted:accepted, review:review, providers:providers, productionReady:false};
}

function tv2AutoNormalizeLotteryMail_(input) {
  var x=input||{}, id=String(x.id||'').trim(), applicationId=String(x.applicationId||x.livePocketId||'').trim();
  if (!id && !applicationId) return {ok:false, review:true, reason:'missing-stable-id'};
  var out={};
  ['id','applicationId','livePocketId','store','product','tcg','status','source','receivedAt'].forEach(function(k){
    if (x[k] !== undefined && x[k] !== null && String(x[k]).trim() !== '') out[k] = typeof x[k] === 'string' ? x[k].trim() : x[k];
  });
  if (!out.store || !out.product) return {ok:false, review:true, reason:'missing-store-or-product'};
  return {ok:true, review:false, input:out};
}
function tv2AutoClassifyTcg_(value) {
  var x=String(value||'');
  if (/ポケモン|ポケカ|Pokémon|Pokemon/i.test(x)) return 'pokemon';
  if (/ワンピース|ONE\s*PIECE/i.test(x)) return 'one-piece';
  if (/ドラゴンボール|DRAGON\s*BALL/i.test(x)) return 'dragon-ball';
  if (/ユニオンアリーナ|UNION\s*ARENA/i.test(x)) return 'union-arena';
  if (/遊戯王|YU-?GI-?OH/i.test(x)) return 'yu-gi-oh';
  return 'other-tcg';
}
function tv2AutoParseLivePocket_(mail) {
  var id=String(mail.id||'').trim(), subject=String(mail.subject||''), body=String(mail.body||'');
  if (!id || !body || subject.indexOf('[LivePocket]') < 0) return {ok:false, review:true, reason:'not-livepocket'};
  var am=subject.match(/[（(](\d{6,})[）)]/) || body.match(/申込番号[：:]\s*(\d{6,})/);
  var em=body.match(/イベント名[：:]\s*([^\n]+)/), vm=body.match(/会場[：:]\s*([^\n]+)/);
  if (!am || !em || !vm) return {ok:false, review:true, reason:'livepocket-fields-missing'};
  var status='応募済み';
  if (/落選となりました/.test(body)) status='落選';
  else if (/当選となりました|当選いたしました|ご当選/.test(body)) status='当選';
  else if (!/申込みが完了しました/.test(body)) return {ok:false, review:true, reason:'livepocket-status-unknown'};
  return tv2AutoNormalizeLotteryMail_({id:id,applicationId:am[1],livePocketId:am[1],store:vm[1],product:em[1],tcg:tv2AutoClassifyTcg_(em[1]),status:status,source:'LivePocket',receivedAt:mail.receivedAt});
}
function tv2AutoParseToysRUs_(mail) {
  var id=String(mail.id||'').trim(), subject=String(mail.subject||''), body=String(mail.body||'');
  if (!id || !body || !/^申込受付完了/.test(subject) || !/日本トイザらス株式会社/.test(body)) return {ok:false, review:true, reason:'not-toysrus'};
  var pm=subject.match(/申込受付完了[『「]\s*([^』」]+)[』」]/) || body.match(/[『「]([^』」]+)[』」]の抽選受付が完了/);
  var sm=body.match(/受取登録店舗は[「『]([^」』]+)[」』]/);
  if (!pm || !sm || !/抽選受付が完了しました/.test(body)) return {ok:false, review:true, reason:'toysrus-fields-missing'};
  return tv2AutoNormalizeLotteryMail_({id:id,store:'トイザらス '+sm[1],product:pm[1],tcg:tv2AutoClassifyTcg_(pm[1]),status:'応募済み',source:'ToysRUs',receivedAt:mail.receivedAt});
}
function tv2AutoParseGoogleForm_(mail) {
  var id=String(mail.id||'').trim(), subject=String(mail.subject||''), body=String(mail.body||'');
  if (!id || !body || !/^フォームにご記入いただきありがとうございます:/.test(subject)) return {ok:false, review:true, reason:'not-google-form'};
  var store='', m;
  if (/owned by カードラボ ゲーマーズ/.test(body)) { m=subject.match(/【([^】]+)】/); if (m) store='カードラボ '+m[1]; }
  else { m=body.match(/こちらは([^\n]+?)の抽選販売応募フォームです/); if (m) store=m[1].trim(); }
  var selected=[], re=/✓\s*\n([^\n]+)/g, hit;
  while ((hit=re.exec(body)) !== null) selected.push(hit[1].trim());
  if (!store || selected.length !== 1) return {ok:false, review:true, reason:selected.length>1?'multiple-products-review':'google-form-fields-missing'};
  return tv2AutoNormalizeLotteryMail_({id:id,store:store,product:selected[0],tcg:tv2AutoClassifyTcg_(subject+' '+selected[0]),status:'応募済み',source:'GoogleForms',receivedAt:mail.receivedAt});
}
function tv2AutoParseLotteryMail_(mail) {
  var parsers=[tv2AutoParseLivePocket_,tv2AutoParseToysRUs_,tv2AutoParseGoogleForm_];
  for (var i=0;i<parsers.length;i++) { var r=parsers[i](mail); if (r.ok) return r; }
  return {ok:false, review:true, reason:'unsupported-lottery-mail'};
}

function runTorecaVaultV2LotterySync() {
  if (!tv2AutoLotteryWriterReady_()) return tv2AutoRecordHealthOnly_('lottery', 'writer-locked');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var before = tv2AutoRead_();
    var prepared = tv2AutoCollectLotteryInputs_();
    if (prepared.review > 0) return {ok:false, skipped:true, kind:'lottery', reason:'review-required', review:prepared.review, revision:Number(before.revision)||0};
    var merged = tv2AutoMergeLotteryInputs_(before, prepared.accepted);
    if (!merged.changed) return {ok:true, skipped:true, kind:'lottery', reason:'no-change', revision:Number(before.revision)||0};
    var next = merged.state;
    next.revision = Number(before.revision || 0) + 1;
    next.lastMutationId = 'auto-lottery-' + Utilities.getUuid();
    next.auditLog.push({mutationId:next.lastMutationId, revision:next.revision, automation:'lottery', created:merged.created, updated:merged.updated});
    var preflight = tv2AutoPreviewVerifiedSave_(before, next);
    if (!preflight.ok || !preflight.wouldWrite) throw new Error('lottery save preflight failed');
    var saved = tv2AutoSaveVerified_(before, next);
    return {ok:true, kind:'lottery', revision:Number(saved.revision), mutationId:saved.lastMutationId, created:merged.created, updated:merged.updated};
  } finally {
    lock.releaseLock();
  }
}

function tv2AutoCollectLotteryInputs_() {
  var threads = GmailApp.search('newer_than:30d (LivePocket OR "日本トイザらス株式会社" OR "フォームにご記入いただきありがとうございます")', 0, 100);
  var accepted=[], review=0;
  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      var parsed = tv2AutoParseLotteryMail_({id:String(message.getId()||''),subject:String(message.getSubject()||''),body:String(message.getPlainBody()||''),receivedAt:message.getDate()?message.getDate().toISOString():''});
      if (parsed.ok) accepted.push(parsed.input); else review++;
    });
  });
  return {accepted:accepted, review:review};
}

function tv2AutoLotteryKey_(x) {
  return String((x||{}).applicationId || (x||{}).entryNo || (x||{}).orderNo || (x||{}).livePocketId || '').trim().toLocaleLowerCase('ja');
}
function tv2AutoNorm_(x) { return String(x||'').trim().toLocaleLowerCase('ja'); }
function tv2AutoMergeLotteryInputs_(state, inputs) {
  var next = JSON.parse(JSON.stringify(state)), created=0, updated=0, changed=false;
  inputs.forEach(function(input) {
    var key=tv2AutoLotteryKey_(input), matches=[];
    if (key) matches=next.lotteries.filter(function(x){return tv2AutoLotteryKey_(x)===key;});
    if (!key) matches=next.lotteries.filter(function(x){return tv2AutoNorm_(x.store)===tv2AutoNorm_(input.store)&&tv2AutoNorm_(x.product)===tv2AutoNorm_(input.product);});
    if (matches.length > 1) return;
    if (matches.length === 1) {
      var i=next.lotteries.indexOf(matches[0]), merged={};
      Object.keys(next.lotteries[i]).forEach(function(k){merged[k]=next.lotteries[i][k];});
      Object.keys(input).forEach(function(k){merged[k]=input[k];});
      merged.id=next.lotteries[i].id;
      if (tv2AutoCanonical_(merged)!==tv2AutoCanonical_(next.lotteries[i])) { next.lotteries[i]=merged; updated++; changed=true; }
      return;
    }
    next.lotteries.push(JSON.parse(JSON.stringify(input))); created++; changed=true;
  });
  return {state:next, created:created, updated:updated, changed:changed};
}

function previewTorecaVaultV2Automation() {
  var root = tv2AutoRead_();
  var positive = root.inventoryLots.filter(function(x) { return Number(x.quantity) > 0; });
  return {
    ok: true,
    readOnly: true,
    schemaVersion: Number(root.schemaVersion),
    revision: Number(root.revision) || 0,
    lastMutationId: String(root.lastMutationId || ''),
    transactions: root.transactions.length,
    lotteries: root.lotteries.length,
    positiveInventoryLots: positive.length,
    inventoryQuantity: positive.reduce(function(n, x) { return n + Number(x.quantity || 0); }, 0)
  };
}

function tv2AutoNormalizeMarketFetch_(result) {
  var x = result || {};
  var price = Number(x.price);
  if (x.ok !== true || !isFinite(price) || price < 0) return {ok:false, reason:'invalid-market-result'};
  var checkedAt = String(x.checkedAt || '').trim();
  var source = String(x.source || '').trim();
  if (!checkedAt || !source) return {ok:false, reason:'missing-market-provenance'};
  return {ok:true, price:price, checkedAt:checkedAt, source:source};
}

function tv2AutoPreviewMarketFetch_(result) {
  var normalized = tv2AutoNormalizeMarketFetch_(result);
  return {
    ok: normalized.ok,
    readOnly: true,
    wouldUpdate: normalized.ok,
    reason: normalized.ok ? '' : normalized.reason,
    price: normalized.ok ? normalized.price : null,
    checkedAt: normalized.ok ? normalized.checkedAt : '',
    source: normalized.ok ? normalized.source : ''
  };
}

function acceptTorecaVaultV2MarketReadOnly() {
  var inspection = inspectTorecaVaultV2Automation();
  var good = tv2AutoPreviewMarketFetch_({ok:true, price:1234, checkedAt:'acceptance-check', source:'acceptance-fixture'});
  var bad = tv2AutoPreviewMarketFetch_({ok:true, price:1234});
  if (!inspection.readOnly || inspection.productionReady) throw new Error('market read-only lock failed');
  if (!good.readOnly || !good.wouldUpdate || good.price !== 1234) throw new Error('market normalization acceptance failed');
  if (!bad.readOnly || bad.wouldUpdate || bad.reason !== 'missing-market-provenance') throw new Error('market fail-closed acceptance failed');
  return {ok:true, readOnly:true, accepted:true, productionReady:false, validPreview:good, invalidPreview:bad};
}

function runTorecaVaultV2MarketSync() {
  if (!tv2AutoMarketWriterReady_()) return tv2AutoRecordHealthOnly_('market', 'writer-locked');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var before=tv2AutoRead_(), targets=tv2AutoMarketTargets_(before);
    if (!targets.length) return {ok:true,skipped:true,kind:'market',reason:'no-targets',revision:Number(before.revision)||0};
    var next=JSON.parse(JSON.stringify(before)),updated=0,preserved=0;
    targets.forEach(function(target){var a=tv2AutoApplyMarketQuote_(next,target,tv2AutoFetchMarketQuote_(target));next=a.state;if(a.updated)updated++;else preserved++;});
    if (!updated) return {ok:false,skipped:true,kind:'market',reason:'no-valid-updates',preserved:preserved,revision:Number(before.revision)||0};
    next.revision=Number(before.revision||0)+1; next.lastMutationId='auto-market-'+Utilities.getUuid();
    next.auditLog.push({mutationId:next.lastMutationId,revision:next.revision,automation:'market',updated:updated,preserved:preserved});
    var preflight=tv2AutoPreviewVerifiedSave_(before,next); if(!preflight.ok||!preflight.wouldWrite)throw new Error('market save preflight failed');
    var saved=tv2AutoSaveVerified_(before,next);
    return {ok:preserved===0,kind:'market',revision:Number(saved.revision),mutationId:saved.lastMutationId,updated:updated,preserved:preserved};
  } finally { lock.releaseLock(); }
}
function tv2AutoMarketTargets_(state) {
  var seen={},out=[];(state.inventoryLots||[]).forEach(function(lot){if(Number(lot.quantity)<=0)return;var k=String(lot.productKey||lot.product||'')+'|'+String(lot.condition||'');if(seen[k])return;seen[k]=true;out.push({product:lot.product,productKey:lot.productKey,category:lot.category,condition:lot.condition});});return out;
}
function tv2AutoFetchMarketQuote_(target) { return {ok:false,reason:'source-adapter-not-enabled'}; }
function tv2AutoApplyMarketQuote_(state,target,result) {
  var next=JSON.parse(JSON.stringify(state)),price=Number(result&&result.price);
  if(!result||result.ok!==true||!isFinite(price)||price<0||!String(result.checkedAt||'').trim()||!String(result.source||'').trim())return{state:next,updated:false};
  var k=String(target.productKey||target.product||'')+'|'+String(target.condition||''),i=-1;
  for(var n=0;n<(next.marketQuotes||[]).length;n++){var q=next.marketQuotes[n];if(String(q.productKey||q.product||'')+'|'+String(q.condition||'')===k){i=n;break;}}
  var h=i>=0?(next.marketQuotes[i].history||[]).slice():[];h.push({price:price,checkedAt:String(result.checkedAt),source:String(result.source)});
  var quote={product:target.product,productKey:target.productKey,category:target.category,condition:target.condition,price:price,checkedAt:String(result.checkedAt),source:String(result.source),history:h};
  if(i>=0)next.marketQuotes[i]=quote;else{next.marketQuotes=next.marketQuotes||[];next.marketQuotes.push(quote);}return{state:next,updated:true};
}

function tv2AutoRecordHealthOnly_(kind, reason) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var root = tv2AutoRead_();
    tv2AutoValidate_(root);
    return {ok:false, skipped:true, kind:kind, reason:reason, revision:Number(root.revision)||0};
  } finally {
    lock.releaseLock();
  }
}

function tv2AutoPreviewVerifiedSave_(before, next) {
  tv2AutoValidate_(before);
  tv2AutoValidate_(next);
  var current = tv2AutoRead_();
  var sameBase = Number(current.revision) === Number(before.revision) &&
    String(current.lastMutationId || '') === String(before.lastMutationId || '') &&
    tv2AutoCanonical_(current) === tv2AutoCanonical_(before);
  var nextValid = Number(next.revision) === Number(before.revision) + 1 &&
    !!next.lastMutationId && next.lastMutationId !== before.lastMutationId;
  return {ok:sameBase && nextValid, readOnly:true, sameBase:sameBase, nextValid:nextValid, wouldWrite:sameBase && nextValid};
}

function tv2AutoSaveVerified_(before, next) {
  tv2AutoValidate_(before);
  tv2AutoValidate_(next);
  var current = tv2AutoRead_();
  if (Number(current.revision) !== Number(before.revision) || String(current.lastMutationId || '') !== String(before.lastMutationId || '')) throw new Error('stale automation write');
  if (tv2AutoCanonical_(current) !== tv2AutoCanonical_(before)) throw new Error('automation base changed before save');
  if (Number(next.revision) !== Number(before.revision) + 1) throw new Error('revision must increment by 1');
  if (!next.lastMutationId || next.lastMutationId === before.lastMutationId) throw new Error('new mutationId required');
  var file = DriveApp.getFileById(tv2AutoProp_('TV_V2_DATA_FILE_ID'));
  var original = file.getBlob().getDataAsString('UTF-8');
  var out = JSON.stringify(next, null, 2);
  try {
    file.setContent(out);
    var reread = tv2AutoRead_();
    if (tv2AutoCanonical_(reread) !== tv2AutoCanonical_(next)) throw new Error('post-save canonical verification failed');
    if (Number(reread.revision) !== Number(next.revision) || reread.lastMutationId !== next.lastMutationId) throw new Error('post-save revision/mutation verification failed');
    return reread;
  } catch (err) {
    file.setContent(original);
    var restored = file.getBlob().getDataAsString('UTF-8');
    if (restored !== original) throw new Error('save failed and rollback verification failed');
    throw err;
  }
}

function tv2AutoRead_() {
  var text = DriveApp.getFileById(tv2AutoProp_('TV_V2_DATA_FILE_ID')).getBlob().getDataAsString('UTF-8');
  var root = JSON.parse(text);
  tv2AutoValidate_(root);
  return root;
}

function tv2AutoValidate_(x) {
  if (!x || Number(x.schemaVersion) !== 2) throw new Error('invalid schemaVersion');
  ['transactions','inventoryLots','lotteries','marketQuotes','auditLog'].forEach(function(k){
    if (!Array.isArray(x[k])) throw new Error('invalid '+k);
  });
  return true;
}

function tv2AutoCanonical_(x) { return JSON.stringify(x); }
function tv2AutoLotteryWriterReady_() { return false; }
function tv2AutoMarketWriterReady_() { return false; }
function tv2AutoAssertProductionReady_() {
  if (!tv2AutoLotteryWriterReady_()) throw new Error('lottery writer is not acceptance-tested');
  if (!tv2AutoMarketWriterReady_()) throw new Error('market writer is not acceptance-tested');
}
function tv2AutoProp_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error(name+' is not configured');
  return v;
}
function tv2AutoRemoveTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (['runTorecaVaultV2LotterySync','runTorecaVaultV2MarketSync'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
}
