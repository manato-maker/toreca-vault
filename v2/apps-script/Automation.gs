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

function runTorecaVaultV2LotterySync() {
  // Production Gmail parsing is deliberately not enabled until its parser is
  // deployed and acceptance-tested against current REAL mail samples.
  return tv2AutoRecordHealthOnly_('lottery', 'parser-not-enabled');
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
  // Production market fetching is deliberately not enabled until current
  // source parsing is acceptance-tested. Existing quotes must never be erased.
  return tv2AutoRecordHealthOnly_('market', 'fetcher-not-enabled');
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

function tv2AutoSaveVerified_(before, next) {
  tv2AutoValidate_(before);
  tv2AutoValidate_(next);
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
