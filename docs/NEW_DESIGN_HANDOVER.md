# Toreca Vault V2 — New System Design Handoff

Updated: 2026-11-03 (JST)

## Goal

Use regular ChatGPT Chat as the daily entry point: the user reports purchases, receipt, opening, sales, lottery applications, and results in text or screenshots. The system turns confirmed reports into idempotent V2 updates. Use Work for code changes, review, and operational repair. Preserve the current V2 history and avoid duplicate purchases, sales, lottery records, or cost basis.

## Proposed architecture

```text
Regular Chat / screenshot
        ↓ structured command + stable requestId
Existing Google Sheets command queue (transition bridge)
        ↓ 15-minute worker
Cloud Run Node.js service ── Firestore V2 canonical state
        ↑ separate scheduled jobs
Gmail lottery scanner / focused result checks / market refresh
```

The existing GitHub Pages UI remains available during migration. The Chat-to-queue connection is a transitional bridge; do not assume a direct Chat-to-Cloud API connector exists until verified.

### Responsibilities

1. **Chat intake**: interpret text and screenshots, derive a typed command, ask only when a key fact is ambiguous, and assign a stable `requestId`. A screenshot that clearly shows an application completion is evidence of an application; do not require a Gmail application email.
2. **Command queue**: keep the existing Google Sheet as the only command queue during transition. Read and claim pending rows by `requestId`; never submit the same command to both Sheets and a new queue. Do not send `[Toreca Vault Command]` drafts.
3. **Cloud Run API**: Node.js 22 service with V2 `schemaVersion: 2` compatibility. Validate commands, enforce expected revision and mutation ID, and read back the saved canonical state before reporting success.
4. **Firestore**: initially store the whole V2 snapshot to preserve the existing client contract. Fail closed above 900,000 bytes. Measure the verified canonical export first; normalize into collections before migration if the size headroom is inadequate.
5. **Workers**: separate the Sheets command worker from Gmail inbox scanning. The market job is independent of Gmail quota and failure.
6. **Job execution**: one dispatcher runs every 15 minutes. Firestore job ledger claims stable job keys transactionally, uses lease tokens to fence stale workers, and limits attempts. Business-level `requestId`, Gmail message ID, and V2 `mutationId` remain mandatory because a crash after an external side effect cannot be made exactly-once by a lease alone.
7. **Market data**: preserve source URL, checked time, freshness, and result state. Failed or ambiguous lookups keep the last confirmed price and mark it stale/review; never fill missing prices with guesses.

## Planned schedule (not deployed)

| Job | Planned schedule (JST) | Implementation rule |
| --- | --- | --- |
| V2 command queue | Every 15 minutes | Process only existing pending queue requests; bounded retry and idempotent mutation. |
| Gmail lottery inbox scan | Hourly, 07:00–24:00 JST | Overlapping search/checkpoint for late mail; cap search range and results; deduplicate by message ID. |
| Lottery-result focus | 12:30 and 19:00 | 12:30 is one focused scan. At 19:00 merge the focus flag into the hourly Gmail scan; do not schedule a second Gmail job. |
| Market refresh | Once daily at 13:45 | First 15-minute tick after 13:30. Run once per JST date; preserve last good quote on failure. |

These are desired target schedules, not current production triggers. The new schedule planner is unit-tested only; no Cloud Scheduler or worker is running.

## Safety invariants

- V2 canonical data remains authoritative. V1/local fallback is prohibited.
- Never create a sale or purchase again to bypass a blocked worker. Existing queue rows are the only pending copy.
- A purchase cost is counted once. Opened packs create singles at zero acquisition cost; retain the original pack purchase cost/history.
- A sold item leaves available inventory. Opened packs/boxes do not remain sealed stock.
- Lottery application evidence can come from user screenshots; purchase/inventory changes only after purchase/receipt.
- Never send command drafts. Never delete a pending command before confirmed successful processing.
- Keep Apps Script triggers and the old system intact during shadow comparison. Do not let old and new workers process the same queue simultaneously.
- Report “queued”, “processed”, and “canonical readback verified” as separate states.

## Implemented prototype in PR #105

- Draft PR: [Start Cloud Run and Firestore migration foundation](https://github.com/manato-maker/toreca-vault/pull/105)
- Branch: `build/cloudrun-firestore-foundation-20261103`
- Latest PR head when this handoff was written: `a6db624413f096290d827cac7a2eff03426c2a12`
- V2 snapshot HTTP adapter, Firestore compare-and-swap, revision validation, mutation ID duplicate guard, read-after-write verification, Bearer auth, exact-origin CORS.
- Writes are disabled by default; missing Firestore state is not auto-created; snapshot writes fail closed above 900,000 bytes.
- Read-only migration report emits aggregate counts, quantities, revision, hash, and size estimate without product names or transaction IDs.
- Pure JST schedule planner, Firestore job ledger, and independent dispatcher are present. Ledger uses hashed job keys, per-claim lease tokens, bounded attempts, sanitized error codes, and a proposed `expireAt` field.
- Local `npm test --prefix cloud`: 25 passed. `npm run check --prefix cloud`: passed. GitHub Actions [#41556918790](https://github.com/manato-maker/toreca-vault/actions/runs/41556918790): test and check passed.

## Not implemented or verified

- No Cloud Run or Firestore production resources were created or connected.
- No live Gmail or Sheets worker, OAuth grant, Cloud Scheduler, or price-source refresh is connected.
- The Firestore Emulator has not tested transaction races or lease expiry. The proposed 90-day TTL policy is not configured.
- No canonical JSON migration, staging comparison, production cutover, or trigger change has occurred.
- Apps Script API diagnosis previously returned `function_not_found`; this migration prototype does not fix that live issue.

## Data and current blocker

The latest previously readable V2 JSON is named `toreca-vault-v2-staging.json`, so its canonical identity is unconfirmed. A Drive search did not find another V2 JSON file. Do not import it as canonical until the configured production source is confirmed and a read-only backup/hash/count report is available.

The existing Sheets queue still contains eight pending sales and the TCG193 lottery row. They have not been re-submitted or processed in this migration work. Do not replay them through a second worker.

## Next implementation sequence

1. Confirm the canonical source identity and read it without mutation. Record revision, hash, transaction/lottery counts, inventory quantities, purchase costs, asset totals, and size.
2. Run lease, duplicate-key, concurrent-claim, retry, and TTL tests against an isolated Firestore Emulator/project.
3. Verify the target Google Cloud project, billing/quota posture, service account access, and minimum OAuth scopes. Do not grant broad Gmail scopes merely to access Sheets.
4. Implement a Sheets-only command worker and a Gmail read-only lottery worker as separate handlers. Gmail failures must not block the command queue or market refresh.
5. Add tests for duplicate sales, insufficient inventory, opening, zero-cost singles, screenshot-backed lottery applications, late Gmail delivery, duplicate Gmail IDs, and failed/stale market quotes.
6. Run a read-only migration dry run, then a staging shadow comparison. Keep existing Apps Script triggers unchanged until no duplicate processing is possible and owner acceptance is explicit.
7. Only after explicit cutover acceptance, switch one input source at a time, verify V2 canonical readback and health logs, then decide whether legacy triggers can be retired.

## Handoff rule

After every work turn, append the actual result, verified tests/CI, next scheduled work, and blockers to Google Docs `Toreca Vault Handoff (CURRENT)` and GitHub `docs/HANDOVER.md`. Also provide a dated portable handoff file. Never copy planned schedule values as if production automation were live.


## Progress update — 2026-11-03 (idempotent command intake)

Added a disabled-by-default authenticated command intake slice to PR #105:

- POST /api/v2 action enqueueCommand with Firestore create-once documents keyed by SHA-256(requestId).
- Existing nine Apps Script command types are allowlisted; request ID must match the payload. Payloads are canonicalized for exact duplicate detection; same ID with different contents is rejected as a collision.
- Fenced queue claims, retry attempts capped at three, expired lease recovery, and review state after attempts are exhausted.
- API does not execute commands; no worker is connected. Queue persistence is append-only for now; no TTL or retention configuration exists.
- Runtime flag TV2_ENABLE_COMMAND_QUEUE=false by default. Cloud resources are still absent; no production records or pending queue rows were changed.
- Local verification: 31 tests pass and syntax checks pass. No Firestore emulator or real API/auth execution has been verified.

### Next work

1. Add Firestore emulator integration tests for transaction create-once semantics and concurrent claims.
2. Decide retention for command payloads and dedupe IDs; then implement redacted result/status polling for clients.
3. Implement command handlers as pure domain transformations over the V2 schema. Validate purchase cost, sale inventory, open-pack removal, zero-cost acquired singles, lottery application evidence, revision, and mutation IDs before wiring persistence.
4. Build the legacy Sheets bridge as read-only shadow first. Never let old Apps Script and new Cloud Run both execute a request.
5. Verify canonical JSON source, export/hash/totals, isolated import and readback before any production cutover.

Current state: PR #105 draft, no merge/deploy; existing Apps Script and V2 data remain authoritative.


### Follow-up — retry exhaustion and result-code safety (2026-11-03)

Queue result metadata now stores only short safe codes; raw worker text is discarded. When the retry cap is reached, the command moves to `review`. Local tests: 32 passed; syntax check passed. No Firestore Emulator or deployed service test yet. The latest code commit still awaits its GitHub Actions result.


CI follow-up (2026-11-03): code commit 588f01b passed GitHub Actions v2-ci #41578881857 (32 tests). Subsequent branch commits only update handoff documentation.


Environment blocker (2026-11-03): this local workspace has no gcloud or Firebase CLI, so Cloud Run/Firestore provisioning and Emulator startup could not be performed here. GitHub CI success covers code tests only, not deployed API auth/execution or canonical V2 readback.


## Progress update — pure V2 command transitions (2026-11-03)

Added first domain slice and queue worker to draft PR #105:

- Supported in the pure transition layer: purchase, sale, pack opening, and lottery application.
- Purchase cost must be explicit; singles created from an opened BOX are recorded at zero cost. Sale consumes FIFO lots and removes exhausted stock. Pack opening preserves purchase history and reduces sealed stock. Lottery application creates no purchase or inventory record and can mark screenshot evidence.
- The worker orders claim → pure transition → revision-CAS save/readback → queue settlement. If persistence succeeds but queue settlement is lost, retry sees the V2 mutation ID and completes without another transaction/revision.
- Ambiguous/invalid commands and unsupported lottery result/receipt/bulk/spouse/repair variants go to review. The worker is not wired to the API, schedule, Sheets, Apps Script, or Gmail.
- Local verification: 44 tests and syntax checks pass; CI for the new code is pending. No Firestore Emulator or production verification.
- Production state: unchanged; pending items are not replayed.

Next: implement remaining safe transitions, then Emulator concurrency/lease/CAS tests; decide payload retention; build only a read-only Sheets shadow adapter until cutover review.


CI follow-up (2026-11-03): GitHub Actions v2-ci #41631701365 succeeded for the new V2 transition and command-worker code. The test and syntax-check steps passed. Later branch commits only updated handoff documentation. Emulator, deployed service, and production-state verification remain pending.


### 2026-11-03 — Lottery transition extension

- Added exact lottery result, receipt status, and guarded bulk result transitions. Matching must be unique; bulk fails closed if no target or any target is purchased/received. These updates do not create purchase/inventory rows.
- Supported pure transitions now cover seven types: purchase, sale, open-packs, lottery application, exact result, receipt, and bulk result. Pokémon Center spouse-specific result and receipt-sale repair remain review-only.
- Local verification: 47 tests and syntax check pass. CI for this extension was pending at the time of this handoff update. No Emulator/production data tests.


CI follow-up (2026-11-03): GitHub Actions v2-ci #41632052953 succeeded for the lottery result/receipt/bulk extension. Test and syntax-check steps passed; subsequent branch commits only update handoff docs. Emulator and production checks remain unverified.


Queue identity guard (2026-11-03): the worker now checks that the claimed document requestId matches the payload requestId immediately before reading or mutating V2. A mismatch enters review before any canonical write. Local verification is 48 tests plus syntax check; CI for this addition was pending at handoff time.


CI follow-up (2026-11-03): GitHub Actions v2-ci #41632298133 passed for the requestId cross-check. Test and syntax-check steps succeeded; later commits are documentation-only. Emulator/production verification remains outstanding.


### 2026-11-03 — Progress estimate and Gmail message dedupe planning

- Whole project is estimated at ~25% through production cutover (stage-weighted, approximate). Architecture/schedule design is complete; API/queue and seven command transitions are prototype-tested but not runtime-connected. Gmail API/parser, market worker, cloud provisioning, canonical migration, E2E verification, and cutover have not started.
- Added bounded-page Gmail message planning using only provider IDs, stable SHA-256 job keys, per-page duplicate removal, and fail-closed oversized-page handling. Planner retains no body, subject, sender, or labels; Gmail API is not connected.
- Local verification: 51 tests and syntax check pass. GitHub Actions v2-ci #41634692957 succeeded. No Firestore Emulator or production check.


### 2026-11-03 — Bounded Gmail scan windows and pagination

- Added a pure Gmail query/cursor planner: seven-day initial backfill, 15-minute overlap for hourly scanning, six-hour overlap for result-focused scanning, maximum 100 messages per page.
- The query upper bound stays fixed across `nextPageToken` pages. A successful timestamp advances only after the final page is durably processed; invalid/oversized inputs fail closed. Combined with the message-ID ledger key planner, repeated messages are not applied again.
- Local verification: 55 tests and syntax check pass. GitHub Actions v2-ci #41635098677 succeeded. Gmail API, OAuth, parsing, and persisted checkpoints remain unconnected.
- Project progress estimate: about 25% to production cutover; breakdown in the portable handoff.


## 2026-11-04 — Gmail classifier port

- Ported the current Apps Script lottery Gmail eligibility rules (result/application/card keyword filters) into a pure Node classifier. It emits only a classification/reason and does not persist mail fields or mutate V2.
- Added tests for results, applications, focused result scans, and non-matching mail; registered the test and syntax check.
- Local verification: cloud test suite 58 passed; syntax check passed. Latest PR head `0eabd4071ba23dc169ebb0ad118d8e612369106f`: Actions v2-ci #41721123698 succeeded; both `npm test` and `npm run check` steps passed.
- No Gmail provider/OAuth, runtime connection, production trigger, Apps Script deployment, or V2 mutation. Existing production data and triggers were left untouched; no queued sales were replayed.
- Next: verify CI, implement a read-only Gmail adapter with least-privilege OAuth and durable bounded checkpoints, add quota/retry recovery coverage, and continue market adapter work. Canonical V2 identity and cloud permissions remain prerequisites to migration/runtime.


## 2026-11-04 — Gmail page worker

- Added a provider-agnostic Gmail scan worker connecting the bounded query planner, provider message IDs, durable message-job ledger, and injected processor. No message subject/body/from is persisted by this layer.
- Checkpoint advances only after every returned message job is complete or already complete. Failed/busy/exhausted jobs leave the cursor unchanged; successful final page alone updates lastSuccessfulAt.
- Added failure/pagination/final-page tests. Local verification: 61 tests passed; syntax check passed. Latest PR head `c092911bf612d5cf4234385bffd0329a611bc665`: Actions v2-ci #41721641270 succeeded; both `npm test` and `npm run check` passed.
- Gmail OAuth/provider, durable checkpoint implementation, production wiring, Apps Script deployment, and V2 changes remain unimplemented. Existing production data/triggers unchanged.
- Next: verify Actions, implement Firestore cursor persistence + quota-aware provider contract, then the least-privilege Gmail adapter when Google Cloud credentials/permissions are available.


Latest handover commit `9933e4238c769cd3d9794ebc13a206e4e00fd7cc`: Actions v2-ci #41721758957 succeeded, including `npm test` and `npm run check`.


## 2026-11-04 — Firestore Gmail checkpoints and quota-aware provider

- Implemented a Firestore checkpoint store that records only bounded scan metadata. A scan window is persisted before the provider call; expected-cursor compare-and-swap rejects stale page writes; the final page clears the cursor and advances `lastSuccessfulAtMs` atomically.
- Implemented an injected provider wrapper with bounded retry for HTTP 429/5xx and recognized rate/quota 403 errors. It honors `Retry-After` within the configured cap and does not retry authentication failures.
- Added store, worker-resume, and provider retry tests. Actions v2-ci #41830898928 succeeded; `npm test` and `npm run check` both passed.
- These are not live Gmail/Firestore integrations: no Gmail API client/OAuth, emulator, deployed service, production checkpoint, or V2 mutation. Existing Apps Script, triggers, and pending rows remain untouched.
- Next: emulator concurrency tests, then a least-privilege Gmail API adapter and staging wiring after cloud authorization. Canonical source identity must be confirmed before any migration.


### Checkpoint generation fencing follow-up — 2026-11-04

- Checkpoint CAS now compares both the expected cursor and prior `lastSuccessfulAtMs`, so an older in-flight scan cannot restart a completed generation after the cursor is cleared.
- Added a stale-generation regression test. Focused local run: 10 tests pass. GitHub Actions v2-ci #41831501955 passed `npm test` and `npm run check`.
- Emulator/live Gmail and Firestore remain unverified; no production connection or data change.


### Firestore Emulator race-test scaffold — 2026-11-04

- Added an opt-in Admin SDK integration test covering simultaneous cursor updates, stale-generation rejection, and final readback, plus a demo-project emulator config and dedicated npm command.
- Local focused tests: 10 passed; emulator test skipped because `FIRESTORE_EMULATOR_HOST` is not set. Firebase CLI/gcloud are not installed here, so no emulator race execution is claimed.
- GitHub Actions v2-ci #41832445196 passed the full `npm test` and `npm run check` steps. The emulator integration test is opt-in and was not run by CI.
- No production state or credentials were accessed. Next: run the opt-in test on an isolated emulator, then implement Gmail API OAuth adapter when authorized cloud credentials are available.


### Firestore Emulator race tests passed — 2026-11-04

- Added a dedicated CI Emulator job using Firebase CLI `emulators:exec` with the isolated `demo-toreca-vault` project. Emulator config specifies deny-all client rules; the integration test uses the Admin SDK and unique per-run document path.
- The first run exposed a cleanup call using unsupported `db.close()`; fixed it to `db.terminate()` and reran.
- Actions v2-ci #41833501945 succeeded. Both test/check job and emulator job passed; Emulator race test result was 1 passed, 0 failed, 0 skipped. The test confirmed one winner under concurrent CAS, stale generation rejection after finalization, and final checkpoint readback.
- This does not verify production Firestore/Gmail/OAuth or canonical V2 migration. No production state was accessed or modified.
- Next: build the read-only Gmail API adapter once authorized project credentials and least-privilege scope are available; maintain staging and migration gates.


### Read-only Gmail API list adapter — 2026-11-04

- Added a Gmail REST `users/me/messages` list adapter. It requests the single `gmail.readonly` scope from an injected token source and returns only message IDs/page tokens; it never fetches email bodies, subjects, senders, or labels.
- Integrated bounded quota retries and per-attempt token refresh. Request duration, max page size, page token size, and returned IDs are validated; error bodies are reduced to safe status/reason metadata.
- Four mocked transport tests pass locally. Actions v2-ci #41834363103 passed the normal test/check job and the Firestore Emulator job.
- OAuth grant/token source, live Gmail account, production wiring, and canonical V2 migration are still unimplemented/unauthorized. No production data was accessed.
- Next: add the authorized least-privilege OAuth token source once Cloud project credentials are available, then test only in staging.


### 2026-11-04 — Bounded Gmail detail reader and transient classification
- Extended the read-only Gmail adapter with per-message detail reads using the same injected `gmail.readonly` token source. The API field mask selects the message payload, subject header, and bounded MIME text parts; the adapter returns only the subject and decoded `text/plain` to the immediate caller. It excludes sender/recipient fields from its returned value and fails closed beyond 512 KiB of decoded classifier text, 128 MIME parts, or 8 nesting levels.
- Added a pure classifier processor that consumes these transient fields and returns only the classifier kind/reason. No body, subject, sender, or classification is written to Firestore or V2 by this slice.
- Added mock coverage for the detail endpoint, field mask, transient output, oversized body rejection, and processor privacy boundary. GitHub Actions v2-ci #41837018173 succeeded: the full npm test and syntax-check job passed, as did the isolated Firestore Emulator job. The task workspace had no local repository checkout, so the tests ran in CI.
- Current implementation gap: the generic dispatcher ignores handler return values and only records job completion. Therefore the classifier processor is not yet wired into the Gmail scan worker; a safe durable classification outcome/consumer is required first so a message cannot be silently marked complete while its classification is lost.
- No Gmail account/OAuth grant, live mail, Cloud Run/production Firestore, Apps Script, trigger, V2 data, or pending queue rows were accessed or changed. Existing Apps Script and V2 remain authoritative; the eight pending sales and TCG193 remain untouched.
- Next: verify this CI run, implement a durable result-code path that stores only message ID hash plus classification code/reason, and then add conservative classification-to-V2 matching tests. Before live staging, verify the Cloud project/token source and restricted-scope approval path; canonical V2 identity remains a migration gate.


### 2026-11-04 — Redacted Gmail classification outcome store

- Added a Firestore collection for compact classifier outcomes. Each document ID is SHA-256(messageId); stored fields are the hash, schema version, classification kind, optional allowlisted ignore reason, and timestamp. No raw message ID, headers, subject, or body is stored.
- The classifier processor now writes its outcome before returning. If the durable write fails, the handler fails and the scan worker will not advance the cursor. If ledger completion later fails, retry sees the same classification record and returns an idempotent duplicate; a conflicting reclassification fails closed.
- Added tests for write-once outcomes, hashed IDs, privacy bounds, conflict rejection, and processor ordering. GitHub Actions v2-ci #41838849830 succeeded: full npm test, npm run check, and isolated Firestore Emulator jobs passed.
- The processor is still not wired into a live scanner/runtime. No OAuth grant, live Gmail, Cloud Run/production Firestore, Apps Script, triggers, V2 writes, or queue replay. Existing data and the eight pending sales plus TCG193 remain untouched.
- Next: verify CI, compose the existing scan worker with the detail provider, Firestore checkpoint, message ledger, and classifier processor in isolated tests; then test unique/ambiguous V2 matching without writes. Cloud project/token source and canonical V2 identity remain staging/cutover gates.


### 2026-11-04 — Gmail scan/classifier composition tests

- Added isolated composition tests for the read-only detail provider contract, the bounded scanner, message job ledger, classifier processor, and Firestore classification result store.
- Verified ordering: persist hashed-ID classification outcome → complete message job → advance the scan checkpoint. If the outcome write fails, the job remains incomplete and the cursor stays at its saved window.
- GitHub Actions v2-ci #41838849830 passed npm test, npm run check, and the Firestore Emulator job. The scan composition is still mock-only; no Gmail/OAuth or production runtime is connected.
- Next: confirm canonical V2 source identity and target Cloud project/token source, then add privacy-preserving unique/ambiguous match rules before any staging V2 transition. Production cutover and Apps Script changes remain gated.


### 2026-11-04 — Canonical V2 source identity check

- Performed read-only Google Drive searches for `toreca-vault-v2`, the exact `toreca-vault-v2-staging.json` name, and JSON files matching the project name. Results exposed the handoff document and command queue only; no V2 JSON candidate was discoverable in Drive search.
- The Apps Script configured source ID/ScriptProperties cannot be inspected with the connected tools available in this session. Therefore canonical identity remains unverified; no candidate was read as canonical, imported, or changed.
- No queue rows, Apps Script triggers, V2 data, or Gmail messages were read or mutated by this check. Eight pending sales and TCG193 remain untouched.
- Next: obtain a read-only export/source ID from the configured Apps Script project (or an explicitly confirmed canonical Drive file), then compare revision/hash/counts before any staging import. Keep production cutover disabled.


### 2026-11-04 — Canonical source search follow-up

- Expanded read-only Drive searches to the configured source-key name, project-name variants, V2Automation.gs, and the Apps Script project MIME type. No Apps Script project or V2 JSON was returned; search exposed only the handoff and command queue.
- Checked diagnostic Actions run #40676318499 for artifacts; none were attached. The Apps Script workflow uses the configured source ID for push/deploy and is not a safe read-only lookup path.
- Canonical V2 identity remains unverified. No Apps Script settings/source, V2 data, Gmail messages, triggers, or queue rows were accessed or changed. Eight pending sales and TCG193 remain untouched.
- No further implementation can safely depend on live V2 identity here. Resume after a read-only configured source ID/export or explicitly confirmed canonical Drive file is available; record revision/hash/counts before isolated import and matching checks. Keep production cutover disabled.
- Latest code CI #41839376404 was reported successful for npm test, npm run check, and the Firestore Emulator job; it does not verify live Google access or canonical V2 data.


## 2026-11-05 — Confirmed requirements from regular Chat

Status: user-approved requirements; implementation and production wiring remain incomplete. Earlier dated history is retained; this section is the active specification.

- Build the replacement app, not a repair of the old V2 Apps Script. Reuse the existing Cloud Run/Firestore prototype and tests. Avoid Apps Script version quotas and prefer non-Apps-Script APIs, scheduled work, and Gmail integration.
- Gmail: poll hourly at 07:00, 08:00, …, 23:00, and 24:00 JST (midnight at the start of the following day). This is independent from the Chat command queue. Change recorded 2026-11-05: the prior Work note's 30-minute interval was a temporary direction; the user reconfirmed hourly and said 30 minutes is unnecessary.
- Chat command queue: process every 15 minutes. Completion requires ordinary Chat text and screenshot reports to be able to submit lottery, purchase/receipt, opening, and sale commands; Work-only entry is insufficient.
- Market refresh: once daily after 13:30 JST for BOX, packs, and singles. Store source and checked time; preserve the prior quote and mark unavailable/stale on failure; never guess. Keep market refresh independent of Gmail failures.
- Migration: preserve lottery, purchase, sale, opening, inventory, and cost-basis history; prevent duplicate entries and double-counted cost. Exclude the user's schemaVersion 1 file and the unconfirmed staging JSON. Never replay pending sales. No writes to old V2 before data validation; production cutover and retirement of the old system require user acceptance.
- Persistence path discovery: current GitHub V2 automation sends action=load to the Apps Script Web App URL in TV2_SYNC_URL and validates schemaVersion 2. In the authenticated Apps Script list, the Toreca Vault V2 API project and V2Api.gs were found; its settings contain TV_V2_DATA_FILE_ID, described in code as a dedicated V2 JSON file separate from V1. The old app's backup action failed because this browser app had no V2 connection URL configured.
- Data read status: the storage route is identified, but the JSON contents have not been retrieved. Schema/revision/timestamp/counts/quantities/cost/asset totals/hash remain unverified, and no backup exists. Exclude toreca-vault-data.json (schemaVersion 1, last modified 2026-10-05) and unconfirmed toreca-vault-v2-staging.json. Never record tokens or secrets in handoff files.
- Verification and cost: reuse the existing PR #105 prototype. Latest recorded code CI #41839376404 passed tests/checks/Firestore Emulator. Live Google API/OAuth, canonical data, Cloud resources, real Chat intake, and free-tier usage are unverified. Cloud Run + Firestore remains the baseline candidate; verify quotas and cost.
- Next: read the dedicated V2 file without mutation, validate revision/content/totals/hash, and save a backup. Continue independent new-app work even if V2 data retrieval remains blocked. Align Gmail scheduling with the hourly 07:00–24:00 requirement.



## 2026-11-05 — V2 storage-target follow-up

- The configured TV_V2_DATA_FILE_ID in the authenticated Toreca Vault V2 API project resolved by Drive URL to a file named toreca-vault-v2-staging.json. It remains unconfirmed staging, so no record aggregation, migration, backup, or hash was performed on it.
- The Drive folder “Toreca Vault Private” lists the handoff Doc and the user's schemaVersion 1 toreca-vault-data.json only; no separate V2 JSON candidate was visible there.
- The old V2 app backup action failed because the Work browser app has no Apps Script connection URL configured. Production V2 contents remain unverified; no backup/hash exists.
- Needed to resume canonical data validation: attach a read-only JSON export produced by the already-connected regular browser/app, or provide the confirmed production Drive file link. No token/Secret is needed. Do not alter old V2 settings or redeploy.



## 2026-11-05 — 通常ChatとWorkの決定事項引き継ぎ手順（確定）

- 適用範囲: Google Docs「Toreca Vault Handoff (CURRENT)」、このファイル、`docs/NEW_DESIGN_HANDOVER.md`。新アプリ専用のLibrary引き継ぎ資料にも同じ状態を反映する。会話間の自動共有は前提にしない。
- 作業開始時: 最新版のGoogle DocsとGitHubの両引き継ぎ、新アプリ専用資料を読み、相互の差分と直近の変更履歴を確認する。
- 新しい仕様・設定・運用方針が通常Chatで決まった場合: Workで開発に着手する前に、ユーザーが共有した決定内容を各引き継ぎ先へ記録する。通常Chatの会話をWorkから取得できない場合は自動共有済みと扱わず、共有された内容だけを記録する。
- 既定事項を変更する場合: 過去の記録を削除・上書きせず、追記で旧仕様、新仕様、変更日、変更理由を残す。ユーザー承認なしに確定仕様を変えない。
- 状態表示: 各項目を「決定済み」「検討中」「実装済み」「未実装」「検証済み」の該当状態で明記する。実装済みと検証済みは別々に扱い、未検証を完了と表現しない。
- 保存後: Google Docs、GitHub各ファイル、Library資料を再読込し、追記内容が保存されたことを確認する。確認できない場合は未確認と報告する。
- 秘密情報: 認証トークン、Secret、同期キーなどを引き継ぎに記載しない。

### 現在の確定仕様（2026-11-05）

- 旧V2を修復せず、新アプリを開発する。Cloud Run + Firestoreを基本候補とし、Apps Scriptの保存版上限に依存しない。
- Gmail抽選メール確認: 毎日07:00〜24:00 JST、1時間ごと。24:00は翌暦日の00:00。通常Chat登録キュー処理: 15分ごと。両スケジュールは独立。
- 買取相場: 毎日13:30以降に1回。Gmail障害と独立し、未取得時に前回価格と未更新状態を区別し、推測価格を登録しない。
- 通常Chatからテキスト・スクリーンショットで報告して自動登録することを最終要件とする。
- 旧V2の購入・売却・在庫・原価・抽選履歴を安全に移行する。未確認のstaging JSONは移行元にしない。正本検証前の書込みや切替は行わない。
- 無料枠、API上限、長期保守性を考慮する。確定仕様の変更と本番切替はユーザー承認後。
