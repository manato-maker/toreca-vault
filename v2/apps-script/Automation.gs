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
