# Toreca Vault v2 implementation status

This branch remains isolated from production UI deployment. The v1 Drive file is retained as a backup/readable source.

## Implemented and verified
- schemaVersion 2 canonical state
- transaction/mutation idempotency
- product + condition inventory keys; store is not an inventory dimension
- FIFO lot consumption sorted by acquired date
- atomic failure on insufficient stock
- realized profit excludes unknown acquisition cost
- positive-inventory market target deduplication
- dedicated v2 Drive JSON; v1 production file is not overwritten
- fixed Apps Script persistence API with no request-time remote fetch/eval
- optimistic revision conflict detection and ScriptLock serialization
- post-write reread/canonical verification with verified rollback on failure
- deployed TEST-copy acceptance: normal write, duplicate mutation protection, stale-revision rejection
- browser/API client reread verification
- V2 read-only projection into the existing UI
- V2 purchase/sale/opening writer behind a session-only write gate
- write gate bound to the verified revision; stale sessions cannot keep writing after revision changes
- explicit inventory condition required for V2 purchase/sale/opening input
- unknown acquisition-cost sales excluded from displayed realized profit
- sync token is never hardcoded in GitHub and is kept in sessionStorage, not persistent localStorage
- migration staging/reconciliation for the current dataset, including the 2026-09-19 AMTAF premium-deck sale
- automated CI regression/syntax checks

## Production cutover blockers
1. Rotate `TV_V2_SYNC_TOKEN`. A previously used token was exposed during setup and must not be reused.
2. Reconnect the browser with the new token and verify a read of the REAL v2 file.
3. Perform a smartphone read-only/UI acceptance on the production frontend build.
4. Only after 1-3, deliberately enable the session write gate. Do not perform a test mutation against REAL merely to prove writing.
5. Deploy/verify the separated V2 Gmail/market automation path before claiming those automations are operational.
6. Inspect/remove obsolete Apps Script triggers from the old combined project so deleted V1 automation functions do not keep failing.

## Cutover safety rules
- REAL v2 file is not a write-test target.
- A successful API response alone never means reflected; save -> reread -> mutation/revision/invariant checks are mandatory.
- On any mismatch, report the mutation as not reflected and leave the write gate closed.
- Keep the v1 Drive file untouched until v2 has operated cleanly and recovery is no longer needed.
- Never restore the old `requiredPermissions_()` function.
