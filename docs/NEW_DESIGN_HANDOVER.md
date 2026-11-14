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


## 2026-11-05 — Gmail確認時刻の実装・検証状況

- 決定済み: Gmail抽選メール確認は毎日07:00、08:00、…、23:00、24:00（翌暦日の00:00）の1時間ごと。通常Chat登録キューの15分間隔とは独立。
- 実装済み: `cloud/src/schedule.js` のGmail due判定を上記時間に合わせ、`cloud/test/schedule.test.js` に07:00・各時刻・翌日00:00、01:00〜06:00の時間外、07:30の非実行境界を確認するテストを追加。関連コミット: `3d843c2`、`9bbd7d0`。
- 検証済み: ローカルのscheduleテスト5件成功。GitHub Actions `v2-ci #42022058028` がcommit `9bbd7d050f8448263d00dbb9db8a3f636d6740cd` で成功。
- 未実装/未検証: Cloud Scheduler等への本番設定、Gmail worker/OAuthの接続、実Gmailでの時刻・API利用量の運用確認は未完了。今回、旧V2やトリガーへの変更は行っていない。


## 2026-11-05 — 新アプリ設計監査と予防的改善

### 発見と判断

- **A Firestore容量** — 現行adapterはV2全体を1ドキュメントに保持し、900,000 bytesで書込みをfail-closedする。Firestore Nativeの文書上限は1 MiB-4 bytes。V2正本のサイズと成長率をまだ取得できず、今コレクション分割すると複数文書の整合性・トランザクション・追加read/writeを増やすため、移行前の分割は保留。正本をread-only検査し、630,000 bytes超または90日実測成長から12か月以内に安全上限到達が見込まれる場合は移行を止め、分割案を再設計する。現状のfail-closedは維持。
- **B 定期処理** — plannerが実起動時刻を予定時刻として使い、19:00の重点確認を別Gmail jobとして出していた。plannerに予定時刻入力を追加し、遅延起動でもjob keyを予定slotに固定。19:00は毎時Gmail job一つに重点フラグを付け、12:30重点確認は維持。保留コマンドとGmail固定window/checkpointは再開可能な状態を保持する。一方、Cloud Schedulerの予定時刻headerをruntimeで渡す接続、永続heartbeat、実行漏れアラートは未実装。
- **C Gmail** — 各ページの上限を100件から50件へ下げ、plannerとproviderの両方で強制。Googleの現在の表ではmessages.listは5 units、完全形式messages.getは60 units、ユーザーごとの上限は6,000 units/分。50件の1ページは最大3,005 units（list 1回+full get 50回）で、短時間の上限到達余地を減らす。ページング/checkpointは継続する。19:00の二重実行は解消、12:30は保持。OAuth grant/token source、refresh失敗通知、実Gmail接続は未実装。認証エラーは自動再試行しない。
- **D 通常Chat登録** — 認証済みAPIにPOST queue受付とstatus-only GETを追加し、pending/processing/done/reviewと正本readback確認を区別。status APIはコマンド本文を返さない。`cloud/openapi-chat-action.yaml` を追加した。API/queueは既定無効で、Cloud Run未配備のため通常Chatからのend-to-end投入は未検証。queueのrequestId+payload hashは完全再送を防ぐが、ChatとGmailの異なるIDを同じ抽選イベントとして認識する業務キーは未実装。Gmailはまだ分類のみでV2履歴を書かない。この照合ができるまではGmail結果をV2へ適用しない。
- **E バックアップ/復旧** — 定期backup、restore drill、破損時の復元手順は未実装。Firestore backup/PITR/restoreとTTL削除に無料枠外の費用があり得るため、費用見積りとユーザー承認の前に有効化しない。隔離環境で復元検証と保存期間を設計する。
- **F 監視** — 現在の`/health`は初期化と書込み設定のみ。Gmail最終成功、queue未処理・失敗、相場、backup、auth error、budgetの運用監視と通知は未実装。
- **G 費用** — Cloud本番資源は未作成、利用量も実測なし。公式料金の確認ではCloud Schedulerはbilling account単位で3 jobs/月が無料、Firestore標準無料枠は1日50,000 read/20,000 write/20,000 deleteと1 GiB、Cloud Run request-basedは月200万requestなどの無料枠がある。一つの15分dispatcherはScheduler無料枠内に収まる見込みだが、既存billing accountの利用分とFirestore/Cloud Run/ネットワーク/backup/TTLを含む全体無料は未検証。Gmail quotaはusage limitであってCloud費用の保証ではない。課金設定は未変更。

### 実装・検証結果

- 実装済み: `cloud/src/schedule.js`予定時刻入力、19:00 Gmail job統合、Gmailページ上限50、command status API、`cloud/openapi-chat-action.yaml`。
- テスト済み: schedule・API status・Gmail page/checkpoint・quota retry/providerの関連ローカルテスト29件成功、0失敗。OpenAPI YAML parseとserver/schedule構文確認も成功。GitHub Actions全体CIは今回の新commitについて確認待ち。
- 関連commit: schedule/status/API/schema `ef7bf9c` / `ebec886` / `d7d4159`; Gmailページ上限 `7479b33`; quota/page tests `5671b68`。
- 本番影響: Cloud Run/Firestore、Gmail、Apps Script、既存queue、V2正本は未変更。未処理売却queueの再投入なし。確定した時刻仕様の変更なし。

### 次工程

- GitHub CI全体結果を確認し、Schedule header接続・scheduler heartbeat/alertの実装範囲を決める。
- V2正本取得後にsize/growth reportでsingle-documentか分割か判断し、バックアップとrestore drillを課金見積り付きで提案する。
- requestIdとは別の業務event keyでChat/Gmail抽選を照合する設計を実装前にテストする。通常Chat Actionの実接続は認証・Cloud配備後に検証する。


## 2026-11-05 — 設計監査後のCI確認

- GitHub Actions `v2-ci #42027010332` は成功。`test` job（`npm test` と `npm run check`）および `firestore-emulator` jobの両方が完了成功。
- 変更したSchedule/API/Gmail quota guardの関連ローカルテスト29件は成功、失敗0件。OpenAPI YAML parseとserver/schedule構文確認も成功。
- 変更はPR #105のdraft branchにあり、未マージ・未配備。CI/emulator成功は本番Cloud、OAuth、通常Chat Action、V2正本接続の検証ではない。


## 2026-11-05 — 定期実行の取りこぼし範囲を再確認

- 状態: 予定時刻固定と同一jobKeyの重複防止は実装済み・CI検証済み（v2-ci #42027010332成功）。ただし、遅延起動テストが確認するのはSchedulerが予定時刻を渡した場合で、Scheduler起動自体が丸ごと抜けたケースのheartbeat検知やcatch-up実行を検証したものではない。
- 既存の保留Chat queueは次回dispatcherが保留行を処理でき、Gmailは保存済みwindow/cursorと最終成功時刻から再開し、marketは当日安定jobKeyで13:45以降のtickから起動できる設計。ページ失敗時にGmail cursorを進めないcheckpointテストも通過済み。これは次の起動後にサービス単位の保留データを再開する仕組みであり、実行漏れそのものを監視・通知するheartbeatではない。
- 未実装: scheduler runtimeで予定時刻headerを渡す接続、最後の成功tick/経過時間の保存、未実行アラート、長時間停止の運用通知。したがって「数日停止を検知する」は未達成。今回、heartbeatだけ追加して自動復旧済みと扱う変更はしていない。
- 改善判断: catch-upはサービスごとの耐久cursor/queueを使って分離実装し、Gmail失敗でChat/marketを止めない。runtimeを接続する工程で、欠落slot数の検知と閾値アラートを追加し、長時間の重複scanや一括再実行を避ける。実装・統合テストとCloud設定は次工程。
- 本番状態・制約: Cloud Scheduler/Run、OAuth、queue、旧V2正本は未変更。未処理売却queueの再投入なし。PR #105はdraft・未マージ・未配備。


## 2026-11-05 — V2 JSON候補の読み取り専用取得

- ユーザーの今回の指示により、Apps Script設定が参照する `toreca-vault-v2-staging.json` を未確認候補として読み取り専用で取得。JSON解析に成功し、schemaVersion 2、revision 2563を確認。Drive上の更新日時は2026-11-05 12:41:09 UTC。
- 正本と確認されていないため、移行データ・本番バックアップ・canonical snapshotとして扱わない。V1 JSONも使用しない。取得した候補JSONとSHA-256 sidecarは個人用Libraryに保存。ハッシュ値自体やファイルID、認証情報はこの公開リポジトリへ記録しない。
- 取得は読み取り専用。Apps Script、Drive原本、V2、queue、トリガー、Cloud資源への書き込み・設定変更は行っていない。未処理売却queueの再投入なし。
- 次: 本番正本として確認できるソースが判明したら別途取得し、候補と混同せず検証する。現在の候補を移行に使う判断は未確定。


## 2026-11-05 — Firestore容量監査と分割保存の予防実装

### 決定変更と理由

- 旧設計の「900,000 bytesを超えたら保存を停止し、移行前に別途分割を再設計する」から、「900,000 bytes以下は従来どおり単一ドキュメント、超過時はFirestore内のchunked-v1へ切り替える」に変更。候補JSONのcompact payload-envelope見積りが1,009,515 bytesとなり、単一ドキュメントの内部安全予算を超えたため。変更日は2026-11-05。これは本番保存先・正本・移行元を変更するものではない。
- 先の説明にあった「raw JSON 1.24 MBだからFirestoreの1 MiB上限を超える」という断定は誤りとして訂正する。raw JSONは1,242,326 bytes、JSON compact payload-envelope見積りは1,009,515 bytesで、Firestoreの公称1 MiB-4 bytesを下回る。Firestoreの実際の符号化サイズは未計測なので、上限超過とは断定できない。一方、900,000-byte内部安全予算は超える。
- staging名の候補は未確認データであり、現行V2 validatorがBOX conditionを拒否する。正本・有効な移行スナップショットとして扱わず、件数・在庫・原価・資産集計も検証済みとは扱わない。

### 実装

- PR #105の cloud/src/firestore-store.js にlegacy単一ドキュメント読込互換を残し、保存時は900,000 bytes以下ならsingle、超過時はchunked-v1を使う。
- chunked-v1は配列フィールドを最大650,000 bytesのsegmentへ分割し、revision・順序・件数・payload SHA-256をmanifestで照合する。rootとsegmentsを1トランザクションで保存し、余剰segmentの削除・保存後readbackも行う。7,000,000-byte payload等の安全上限を超えたらfail-closed。
- API body上限を7,500,000 bytesへ整合。Firestore index設定に保存payload/manifest配列のindex exemptionを追加したが、本番へ適用していない。
- migration reportはsingle/chunked/blockedを区別する。candidateの実移行・本番V2書込み・Firestore配備は行っていない。

### 検証・状態

- 保存方式とmigration reportのローカルテストは12件成功、0件失敗。
- GitHub Actions v2-ci #42033589572 はtest/checkとFirestore Emulatorを含め成功。Emulatorでは合成データでchunked save・readback・manifest・segmentサイズを確認した。これは本番データ、OAuth、通常Chat接続の検証ではない。
- PR #105はdraft・未merge・未配備。Cloud請求設定、旧Apps Script、queue、trigger、V2正本に変更なし。未処理売却queueの再投入なし。
- 全体進捗は約25%のまま。コアコードの範囲は広がったが、正本確認、通常Chat実接続、Cloud実運用、バックアップ復元、監視と本番切替は未完了。無料枠内の継続運用も実測前で未保証。

### 次工程

- V2正本の保存経路を特定し、有効な読み取り専用exportを得た後にだけvalidator・保存サイズ・件数・在庫/原価/資産集計を再検査する。候補JSONは使用しない。
- chunked-v1の障害ケース、複数更新、segment cleanupと費用/読み書き数を検証し、Firestore実サイズの見積りに余裕を持たせる。
- 通常Chat Actionからの受付実接続、業務event keyによるChat/Gmail重複防止、Scheduler欠落監視、バックアップ/復元、Cloud利用量を引き続き未解決事項として扱う。


## 2026-11-06 — Firestore分割保存の整合性テスト

- 分割保存の失敗時に破損状態を受け入れないことを確認する単体テストを追加: segment欠落、segment内容改変によるpayload hash不一致、異なるrevisionのsegmentを検出する。
- 大きなスナップショットをrevision 1から2へ更新し、readback payloadと全segmentのrevisionが一致することを確認する。
- 関連ローカルテスト16件が成功、失敗0件。GitHub Actions v2-ci #42110925076はtest、check、Firestore Emulatorを含め成功。新しい不整合テストはfake Firestore transactionで検証し、Emulatorは合成データのchunked save/readbackを検証した。
- これは新アプリのコード検証であり、本番FirestormやV2データの検証ではない。PR #105はdraft・未merge・未配備。本番V2、Apps Script、trigger、queue、課金設定は変更なし。売却queue再投入なし。
- 次工程: scheduler実行欠落のheartbeat/catch-up、読み書きコスト評価、backup/restore設計、通常Chatからの実接続を独立した安全な段階で進める。正本取得は依然として移行のblocker。全体進捗は約25%のまま。


## 2026-11-06 — Firestore Emulator連続更新・破損検知

- Emulator統合テストを拡張し、chunked-v1を2 revision連続で保存した際のroot/segment revision一致とreadbackを検証。segmentの内容を改変した後にhash不一致で読み込みが拒否されることも確認した。
- GitHub Actions v2-ci #42111400132（run #685）は通常test、check、Firestore Emulatorの全jobが成功。前回追加のsegment欠落・改変・revision mismatch・連続更新単体テスト16件も成功済み。
- すべて合成データを使った隔離検証。本番Firestore、V2正本、Apps Script、Gmail、queue、課金設定へのアクセスや変更なし。PR #105はdraftのまま。


## 2026-11-06 — Firestore操作数の基準見積り

- migration reportへ成功更新あたりのFirestore document read/write基準見積りを追加。single保存は3 reads・1 write。chunked保存は segment count=N のとき 3+2N reads・1+N writes。
- 根拠は現行adapterのduplicate確認read、revision-CAS root read、保存後readback。chunkedの初回readとreadbackは全segmentを含む。SDK transaction retryおよび旧segment削除writes/deletesは見積りに含めない。これは基準値であり実測や課金額ではない。
- 操作数見積りを含む保存方式/migration reportのローカル16件は成功。記録時点ではCI未確認だったが、その後のGitHub Actions v2-ci #42112277167（run #688）がbranch head 8ae3436でtest/check/Firestore Emulator全job成功。このheadはoperation estimate変更を含む。
- 無料枠への適合は実際の保存回数、segment数、既存プロジェクトの他利用量を測るまで未保証。Cloud請求設定は変更していない。


## 2026-11-06 — 12:30 lottery focus catch-up

- A missed 12:30 Scheduler tick no longer loses the daily focused result check: 12:30–18:45 JST quarter-hour slots reuse the stable key `lottery-result-focus:YYYY-MM-DD`, keep `scheduledAt` fixed at 12:30, record actual `triggeredAt`, and mark later slots `catchUp: true`. A durable completed key suppresses repeats. At 19:00 the focus flag stays on the single hourly Gmail job.
- Added schedule tests for normal/catch-up slots, completion suppression, delayed execution, and the 19:00 merge. GitHub Actions v2-ci #42114904105 (run #690) passed `npm test`, `npm run check`, and Firestore Emulator.
- Runtime wiring, scheduler heartbeat/alerts, and live recovery remain unverified. PR #105 is still draft, branch head `36661d2b56d124d18a222a425590b96c890fcf06`. No production, V2, Apps Script, Gmail, queue, or billing changes; canonical V2 remains unconfirmed and no pending sale work was replayed.


## 2026-11-06 — Scheduler heartbeat and liveness endpoint

- Added a Firestore heartbeat store and health evaluator: it records only scheduled/completed timestamps, missed-slot count, and failed-job count. Duplicate scheduler retries are idempotent; a later success for the same slot refreshes completion/failure state; out-of-order slots are ignored; corrupt schemas fail closed. No command, email, or raw error text is stored.
- Added `GET /health/scheduler`: returns 200 only when the latest tick is within 45 minutes and reports no missing slots or failed jobs; otherwise 503. The Firestore store is configured at service start. The live dispatcher still must call `recordSuccess` after each scheduled run, so this endpoint deliberately indicates not-yet-running until that wiring exists.
- Cost estimate: at most one heartbeat document write per successful 15-minute tick (about 96/day); health endpoint reads and existing project usage are not measured.
- Local schedule/heartbeat tests: 11 passed. CI #693 caught a health response bug, which was fixed; v2-ci #694–#697 passed test/check and Firestore Emulator. Run #697 also verified heartbeat persistence, missed-slot counts, same-slot retry refresh, and recovery in the Emulator.
- Still pending: Scheduler time-header/runtime connection, heartbeat writer invocation from the dispatcher, Cloud Monitoring notifications, deployed operation, V2 canonical source, and cost validation. PR #105 remains draft; production Cloud/V2, Apps Script, Gmail, queues, and billing settings are unchanged. No sale queue was replayed.
- Code commit: `15ab435b1787e7a74d7bc25fa77be5bc390eb3a1`.


## 2026-11-07 — Scheduled dispatcher orchestration

- Added `cloud/src/scheduled-runtime.js` to parse the Cloud Scheduler RFC3339 schedule-time value, plan due jobs, read the durable ledger to suppress completed daily focus/market work, dispatch jobs under existing leases, summarize safe failure states, and record a bounded heartbeat.
- Missed work resumes through existing durable state: pending Chat commands at the next queue tick, Gmail from its checkpointed fixed window, market on the next 13:45-or-later tick until its daily key is complete, and the 12:30 focus key through 18:45. No bulk historical replay is introduced.
- 14 related local tests passed. GitHub Actions v2-ci #699 passed `npm test`, `npm run check`, and Firestore Emulator.
- Estimated added Firestore operations at a full-day 15-minute schedule: at most 96 heartbeat writes/day and 67 daily focus/market ledger reads/day. Health polling and existing project traffic are excluded; free-tier fit remains unmeasured.
- Runtime parsing/orchestration is implemented but not mounted on an authenticated Cloud Run Scheduler route, and production queue/Gmail/market handlers are not composed into it. No Scheduler, Monitoring, Cloud Run, V2, Apps Script, queue, or billing changes. PR #105 remains draft; canonical V2 remains unconfirmed and no sale queue was replayed.
- Code commit: `5a5c1a65b87a5517d0df3f7cca29549e35d35929`.


## 2026-11-07 JST — 認証済みApps Script画面の読み取り確認

- WorkクラウドブラウザでApps Script dashboardを読み取り専用で開こうとしたが、公式のApps Script dashboardリンクを開いても公開Apps Scriptドキュメントページへリダイレクトされ、Apps Scriptプロジェクト一覧/エディタは表示されなかった。認証済みUI、旧V2のScript Properties、TV_V2_DATA_FILE_ID、保存経路は確認できていない。
- Secret/tokenの入力や共有、Apps Script/Gmail/Driveの変更は行っていない。正本JSONの取得、SHA-256、revision、件数/在庫/原価/資産集計の検証は未実施。既知のV1 JSONとstaging候補は引き続き移行対象外。
- ローカルの新アプリ関連テスト29件は28 passed、1 emulator test skipped（FIRESTORE_EMULATOR_HOSTなし）。GitHub Actions v2-ci #701はsuccess（PR head 72c714eb750e7ea7c4d1e5e1c5e38868218c95dd）。
- PR #105はdraft・未merge・未配備、全体進捗は約25%。Cloud runtimeをScheduler route/production handlersに接続する実装、本番OAuth/Gmail、通常Chatの実送信、backup/restore実環境確認が次工程。Cloud課金や旧システムは変更していない。


## 2026-11-07 JST — Scheduler HTTP入口の安全な土台

- `cloud/src/server.js` に `/internal/scheduler/tick` を追加。明示的なschedulerAuthorizeとschedulerTickの両方が未注入なら503で無効、認証失敗は401、Scheduler marker/予定時刻ヘッダーを検査してから処理する。失敗件数がある場合は本文を露出せず503を返し、Cloud Schedulerの再試行につなぐ。
- `test/cloud-api.test.js` にデフォルト無効、認証、時刻/marker検証、成功、失敗時503のテストを追加。関連ローカルテスト9件、audit-tests全25件が成功。GitHub Actions v2-ci #703はnpm test/checkとFirestore Emulatorの両jobがsuccess。
- このendpointは新しい認証関数/runtimeの注入が必要で、`start()`からは未接続・未有効。Cloud Run IAM/OIDCの構成、本番handler、Cloud Scheduler/Cloud Run配備は未実施。PR #105はdraft、既存V2/Apps Script/queue/課金設定に変更なし。
- code head: `de8e2fa560884bce60658da0cca89e3b648cbfc2`。


## 2026-11-07 JST — Scheduled job handler失敗の分離

- 発見: `dispatchJobs`は全予定jobのhandler存在を事前検証するため、Gmailなど1 handlerの未設定だけで、同じtickのcommand queue等も起動しない可能性があった。これはGmail障害と独立処理要件に反する。
- 修正: `runScheduledTick`でjobごとにdispatch。handler未設定はpayloadや名前を出さず`unconfigured`/`HandlerUnavailable`として失敗件数とheartbeatへ記録し、他の設定済みjobは続行する。
- 検証: schedule/runtime/dispatcher関連12件成功。全cloud単体テストは30 passed、1 emulator test skipped（ローカルにEmulatorなし）。GitHub Actions v2-ci #706はtest/checkとFirestore Emulator両job success。
- 実handler/OAuth/Cloud Run/Schedulerは未接続。PR #105はdraft・未配備、進捗約25%。本番・旧V2・Apps Script・既存queue・課金は変更なし。
- code head: `8f4d0f61faffa52af9775fa156d2657510da1f55`。


## 2026-11-07 JST — Offline backup integrity and restore-preview foundation

- Added a versioned V2 backup artifact with canonical JSON SHA-256, a separate metadata hash, schema/revision checks, inventory cost/quantity validation, and a 7.5 MB fail-closed limit. Added a local-only CLI for create, verify, and restore preview. Creation refuses to overwrite an existing output and writes with owner-only permissions; input snapshots remain unchanged.
- Restore preview requires the observed current revision and returns only aggregate counts, total quantity, known acquisition cost, and unknown-cost lot count. It never applies a restore or exposes product names, transaction IDs, or lottery IDs.
- Focused backup and migration-report tests: 10 passed locally. GitHub Actions v2-ci #716 passed test/check and Firestore Emulator. Code head: `0bf32262cdd425cf559f9492d7567a857d49fd21`.
- This is an offline backup-file foundation, not automated/retained cloud backup or a restore drill. No canonical V2 export, Cloud storage, retention, automatic restore, production data, Apps Script, queue, or billing configuration was touched. Existing V1/staging candidates remain excluded; pending sale work was not replayed.
- Overall development estimate: about 30% (previously about 25%). The backup artifact and dry-run path are now implemented; authenticated regular-Chat integration, canonical V2 confirmation, live runtime/OAuth, scheduled backup retention and actual restore drill, monitoring, and cost measurement remain open. The requested 35% milestone is not yet reached.


## 2026-11-07 JST — Backup export path and isolated restore drill

- Added a create-once backup export task over the read-only canonical store contract. It checks snapshot/revision agreement, writes a deterministic date/revision/payload-hash key through an injected repository, reloads the object, and verifies its artifact hash and payload hash. Retry of the same daily snapshot is idempotent; storage mismatch fails closed.
- Added a local file repository and `backup-snapshot.js export` CLI path. Files use exclusive creation and mode 0600; newly created directories use mode 0700; unsafe keys and overwrite attempts are rejected. No Cloud storage provider is connected.
- Added an isolated Firestore Emulator drill that restores a synthetic chunked backup into a fresh test document and confirms revision, complete payload readback, and matching SHA-256. GitHub Actions v2-ci #729 passed test/check and Firestore Emulator. Backup-focused local tests: 8 passed. Code head: `129911336026aac176a5094e67252791488195de`.
- Overall development estimate updated from about 30% to about 35% because the backup path now has an executable export, create-once persistence contract, readback integrity checks, and an Emulator restore drill. This is not production operation. Cloud backup schedule/provider/retention, live canonical export, automated restore, regular Chat integration, OAuth/runtime wiring, monitoring, and cost measurement remain open. Production V2, Apps Script, existing queues, and billing were not changed; no pending sale work was replayed.


## 2026-11-07 JST — Market, Gmail scheduler binding, and queue health foundation

- Added a scheduled market-refresh worker using one injected batch lookup over positive inventory targets. It accepts only a nonnegative integer JPY price with a nonempty source; missing, duplicate, invalid, or failed results preserve the last confirmed price/source/time and mark the quote stale. Stable daily job keys prevent repeat provider calls after a committed mutation; V2 CAS save/readback is required. Bounded aggregate health metadata is written under `automation.health.marketRefresh`. No market source is configured and no live prices were requested.
- Bound the existing Gmail scanner to the scheduled hourly and result-focus job contracts. Hourly jobs use their planned time; the 12:30 result catch-up uses the actual trigger time as the query upper bound while keeping the stable daily ledger key. At 19:00 the hourly job remains one scan with result terms included. Gmail uses separate hourly/results checkpoints and a 50-message cap.
- Added a queue summary using two Firestore aggregate queries for pending/processing and review counts; it returns counts only. Unit tests and a real Firestore Emulator aggregate test cover the result.
- Local focused tests: market worker 5 passed, scheduled Gmail handlers 3 passed, queue summary 2 passed. GitHub Actions v2-ci #747 passed full test/check and Firestore Emulator. Code head: `a0d1575db56c0c54c7c02d58505c956a4eee2927`.
- Overall estimate updated from about 35% to about 50%: backup export/restore foundation, daily market transition, Gmail scheduled binding, and queue health aggregation now have executable tested paths. This remains pre-production code. Live Gmail OAuth, a confirmed market provider, Cloud Scheduler/runtime composition, regular Chat end-to-end, canonical V2 export/migration, complete alerting, backup retention/provider, and real cost measurement remain open. No production data, old V2, Apps Script, pending queue, or billing configuration was changed.


## 2026-11-07 JST — Cross-source business event deduplication foundation

- Problem: queue idempotency based only on requestId did not prevent the same lottery application from being submitted by Chat and Gmail under different request IDs.
- Added optional top-level businessEventKey to the command API. When supplied, the queue hashes the key and normalized command payload (excluding only requestId), then atomically creates a hash-only business-event index with the queue entry. A matching event returns accepted=false, duplicate=true, and the existing request ID; a key reused with different business data fails closed as business-event-collision (HTTP 409). Raw event keys are not persisted.
- Updated the Chat Action OpenAPI contract and server response to distinguish cross-source duplicates from newly accepted commands and requestId replays. Requests without a reliable key continue to use requestId idempotency only; no key is inferred from ambiguous evidence.
- Local targeted run: 13 passed, 1 Firestore Emulator test skipped because no local emulator was running. GitHub Actions v2-ci #749 passed test/check and Firestore Emulator, including the concurrent two-source enqueue test. Code commit: 2c5faf7d7c0cf5e6cbfcb4893384da1680481c2f.
- Overall estimate: about 52% (rough implementation/tested-path estimate), not production readiness. The Gmail classifier and Chat normalizer do not yet derive/share a common key; no live end-to-end run was done. Business-key retention/cost are unmeasured. PR #105 remains draft/unmerged/undeployed. No production V2, old Apps Script, existing queue, pending sale item, or billing configuration changed.


## 2026-11-07 JST — Lottery identity resolution and scheduled backup foundation

- Added a shared lottery business-key builder from event kind, canonical retailer key, and an explicit external application ID. It NFKC-normalizes stable retailer spelling, hashes the complete identity, and returns only the hash key. Missing/invalid identity yields a review result with no key. The API maps lottery application/result/receipt command types to the event kind, derives the same key server-side, and rejects identity fields on unsupported command types. No raw external ID is written into the queue index.
- Added a proposed, not deployed, daily canonical-backup job at 02:00 JST. A later 15-minute tick retries the same date key until the durable ledger records completion; successful daily keys are suppressed. Added a backup handler that validates the scheduled slot and integrity receipt from the existing create-once export task. It still requires a persistent repository/provider and runtime handler wiring before deployment.
- Focused local verification: 33 tests passed, including Chat API identity derivation, missing-ID review, normalization, daily schedule recovery, ledger suppression, and backup receipt validation. GitHub Actions v2-ci #751 passed the full test/check and Firestore Emulator jobs. Code commit: 99ef62c699b21a00ff076eae83a2ca0a17df63c7.
- Overall estimate updated from about 52% to about 60%, based on tested code paths; this is not production readiness. Gmail does not yet extract a confirmed application ID or provide the same retailer key, so cross-source deduplication remains unverified end to end. Backup storage, retention, and recovery against production data are unconfigured. Regular Chat end-to-end, canonical V2 export/migration, OAuth, deployed Scheduler/runtime wiring, complete alerting, and real cost measurement remain open. PR #105 stays draft/unmerged/undeployed; no production data, Apps Script, existing queue, pending sale item, or billing configuration changed.

## 2026-11-07 — Conservative cross-source lottery ID extraction (CI #755)

- Reused draft PR #105 and added `cloud/src/lottery-source-identity.js`: pure Gmail identity resolver for explicit externally issued lottery application IDs plus retailer names marked by labels. Retailer aliases must be allowlisted and mapped to a canonical retailer key; no guessing from product, sender, date, or unlabelled numbers. NFKC/whitespace normalization feeds the existing shared hashed business-event key builder.
- Missing/unknown/conflicting retailer aliases or application IDs return review-only results without any event key. No raw Gmail body/application ID appears in the resolver output. The parser is intentionally not connected to the production Gmail scanner/queue.
- Added `cloud/test/lottery-source-identity.test.js` (9 tests): Chat screenshot-confirmed key equals Gmail extracted key, event kind separation, repeated labels, missing/unknown/conflicting identity, invalid/oversized mail, privacy, synthetic shared-key queue duplicate suppression, and conflicting business payload fail-closed. `cloud/package.json` now runs the new test and syntax-check.
- Local extraction-only tests: 7 passed before adding the two queue-integration cases. GitHub Actions v2-ci #755 (head `d5041a025657a7617f7127c865e7ef0fed5134a8`) passed `test` (npm test and check) and Firestore Emulator jobs, including the new queue-integration tests. This is mock/Emulator verification, not live Gmail or Chat E2E.
- Progress stays approximately 60% as a rough implementation/test estimate, not production readiness. Gmail identity resolver is not attached to the live classification-to-command path. Retailer aliases for real stores and the durable enqueue/settlement handoff must be reviewed before activating; different business command payloads sharing one event key correctly produce review/collision, not silent merge.
- Still missing: normal Chat action live integration, Gmail OAuth/live inbox, Cloud Scheduler/Cloud Run runtime handlers, confirmed market provider, canonical V2 read-only export and migration audit, persistent cloud backup/retention/restore drill, monitoring and measured free-tier usage. V2 canonical identity still unknown; V1/staging is not an import source.
- No live Cloud Run/Firestore, Gmail, old V2, Apps Script, existing queue/pending sales, billing, deletion, merge, or production cutover changes. PR #105 remains draft/unmerged/undeployed. Next: documented real retailer alias fixtures (sanitized), review-safe durable Gmail-to-command outbox, mocked E2E including crash/retry, then disabled-by-default runtime/OAuth wiring.


## 2026-11-08 JST — Durable backup storage adapter and retention proposal; about 70%

- Added a Cloud Storage repository adapter for the existing verified create-once backup export contract. Keys are limited to the generated `v2/YYYY-MM-DD/revision-<n>-<sha256>.json` namespace; uploads use the generation-match-zero precondition so an existing live object is never overwritten. A precondition conflict is treated as an idempotent duplicate. Uploads carry content type, schema marker, and SHA-256 metadata; reads enforce the 7.5 MB artifact bound. Cloud Storage SDK/runtime wiring is intentionally not included.
- Added `cloud/backup-lifecycle-proposed.json`, a reviewable 90-day delete rule limited to the `v2/` prefix. It is a proposal only and has not been applied to any bucket. Daily backup remains unconnected to a persistent destination and has not run against canonical production data.
- Tests cover create-once/precondition behavior, SHA-256 metadata, readback, key/size rejection, and the limited lifecycle scope. Local full suite on the working tree: 138 passed, 0 failed, 1 Firestore Emulator test skipped because no local emulator was configured; `npm run check --prefix cloud` passed. GitHub Actions v2-ci #758 passed on PR head `10f38a2cf2e21edf03913af02799f3ed115d7975`.
- Overall development estimate updated from about 60% to about 70%, reflecting the additional tested backup storage/retention path foundation. This remains a rough implementation estimate, not production readiness or a percentage of live operation.
- Cost/free-tier: Cloud Run published free usage is shared by project and requires an active billing account for use; overages are billable. Cloud Storage's published always-free Standard allowance is restricted to three US regions, so a Japan-region bucket would not receive that storage allowance. Standard storage is the proposed class because daily backups need straightforward verification/recovery; actual bytes, request volume, network costs, region-specific estimate, and project-wide free-tier fit remain unmeasured. No billing setting was enabled. Sources: [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Storage pricing](https://cloud.google.com/storage/pricing).
- V2 canonical JSON: still unavailable/unverified. No Drive V1 or staging JSON was used. No production data, Apps Script, queue, pending sale, Cloud resource, or billing setting was changed; no deploy, merge, cutover, or old-system shutdown occurred. PR #105 remains open, draft, unmerged, and undeployed.
- Still open: normal Chat-to-command live path and screenshot E2E; real Gmail/Chat common-key E2E and durable review-safe outbox; live Gmail OAuth; Scheduler/runtime production composition; confirmed market source; canonical V2 read-only export and migration reconciliation; persistent backup configuration/retention decision and production-data restore drill; monitoring/alerts and measured costs.
- Next: build a mocked crash/retry-safe Gmail classification-to-command outbox and connect the regular Chat Action path end to end in isolated tests; then propose disabled-by-default authenticated Cloud Run composition. Keep the GCS lifecycle unapplied pending explicit retention/location/cost review.


## 2026-11-08 JST — Gmail command outbox and cross-source retry safety; about 80%

### Implemented

- Reused PR #105. Added a Firestore-backed Gmail command outbox and optional composition point in the classifier processor. For explicitly complete commands, it writes a durable outbox record before queue submission. The requestId is stable and derived from the SHA-256 of the Gmail message ID; raw message IDs and mail text are not persisted by the outbox.
- The outbox derives the same business-event key from explicit retailer key/application ID as the Chat API. If required command fields or identity are missing, it records a compact review state and does not queue. Queue payload conflict also routes to review.
- Queue delivery happens after the durable outbox write. If the process fails after queue acceptance but before marking the outbox submitted, retry resends the same requestId and business key; the queue’s existing idempotency/business-event index suppresses a second mutation.
- buildCommandDraft is an optional injected pure composition point. This change does not add real Gmail field extraction for title/date/target lottery, retailer alias deployment, Gmail OAuth, or production runtime wiring; without a complete explicitly constructed draft, the item remains review-only.

### Verified

- Added tests for crash after queue acceptance and retry, missing identity/fields to review, processor-to-outbox ordering, no persistence of raw message ID or email body, queue collision, and Chat/Gmail same business key under different request IDs.
- Focused local tests: 5 passed. Working-tree full suite: 143 passed, 0 failed, 1 skipped because local Firestore Emulator was not configured. npm run check --prefix cloud passed.
- GitHub Actions v2-ci #762 passed on code head f4985cf20c77f30305a0f474e9ebaecc08add436.

### Not yet verified / next

- This is mocked/Firestore-adapter test coverage, not live Gmail, Chat Action, or Cloud Run E2E. The classifier’s real-to-command builder, reviewed retailer alias configuration, and review inbox/monitoring are not connected. Regular Chat Action API/schema already exists but no deployed endpoint or screenshot report E2E is available.
- Remaining: live Gmail OAuth, authenticated and deployed Cloud Run/Scheduler composition, confirmed market provider, canonical V2 read-only export and migration reconciliation, persistent backup bucket/location/retention decision and production restore drill, operational alerts, and measured project-wide cost/free-tier fit.
- V2 canonical JSON is still unavailable; V1/staging is excluded. No production V2, Apps Script, existing queue, pending sale, billing setting, cloud resource, or deployment changed. PR #105 remains open, draft, unmerged, and undeployed.
- Overall progress estimate updated from about 70% to about 80%; this is a rough implementation/test estimate, not production readiness. Confirmed Gmail schedule (07:00–24:00 JST hourly, 12:30 focus, 19:00 merged), independent 15-minute Chat queue, and daily 13:30+ market schedule are unchanged. The 90-day GCS lifecycle remains an unapplied proposal.
- Next: add a conservative, tested Gmail command-draft builder for only explicitly labelled fields; missing/ambiguous evidence must stay in review. Then compose and test the disabled-by-default Chat Action + Gmail + queue path. Do not enable OAuth, billing, production queues, or lifecycle policy in this phase.



## 2026-11-08 JST — Gmail outbox privacy and ambiguity guard follow-up

- Tightened the optional Gmail command builder boundary after code review: the outbox now reconstructs commands from a type-specific allowlist. Unknown properties (including body/raw mail fields or caller-supplied requestId), conflicting title/product values, control characters, oversized strings, and malformed optional dates send the item to review without queue submission or persistence of the rejected fields.
- Focused outbox tests: 7 passed. Working-tree full suite: 145 passed, 0 failed, 1 skipped without local Firestore Emulator. Syntax check passed. GitHub Actions v2-ci #765 passed on code head b73951fc0a5fd99f8da5143eaf5a4573110ddbb7.
- Remaining functional gap: review states are safely retained, but a review inbox and explicit user-confirmation-to-command flow are not implemented or connected. This and the live Chat/Gmail/Cloud Run path remain product-completion work. Progress estimate stays about 80%; the estimate is not a production readiness claim.



## 2026-11-08 JST — Labelled Gmail command builder and Chat/Gmail mock E2E; about 90%

### Implemented

- Added a conservative Gmail lottery command builder for only explicit labelled fields: external application ID, allowlisted retailer name, product, and ISO date; result status/date are also required for results. It does not infer from sender, product codes, unlabelled numbers, message timestamps, or surrounding prose. Conflicting/missing labels, unknown store aliases, malformed/oversized data return no draft and stay in review. The builder emits only the command fields needed by V2; outbox applies its own command allowlist.
- Added a mocked end-to-end test: a regular Chat Action HTTP request submits a lottery application, then the Gmail classifier/parser/outbox sees the same explicit event under a different Gmail ID and is suppressed by the same business-event key. This is isolated HTTP/mock coverage, not an actual ChatGPT screenshot or live network connection.
- Added an opt-in Firestore Emulator test for concurrent outbox create-once calls, readback, hashed message ID, and submitted-state update.

### Verified

- Focused builder/outbox tests: 12 passed. Working-tree full suite: 150 passed, 0 failed, 2 skipped locally because no Firestore Emulator was configured. Syntax check passed.
- GitHub Actions v2-ci #769 passed, including full test/check and Firestore Emulator jobs. Code head: `63f34b818a4671040b873b7f2a872a4febe86364`.

### Remaining / completion gates

- Overall progress estimate updated from about 80% to about 90%; this remains implementation/test coverage, not production readiness. Real store aliases and Gmail templates have not been reviewed against actual messages. Result commands still depend on the V2 worker finding exactly one matching lottery row; otherwise the existing worker must leave them in review.
- Normal ChatGPT Action is not deployed or configured. Screenshot interpretation, actual endpoint/auth, live Gmail OAuth, Cloud Scheduler/runtime composition, review inbox and explicit review-resolution flow are unverified/unimplemented. No command is being registered automatically from this ordinary Chat session.
- Canonical V2 JSON remains unavailable; no V1/staging source is used. Migration reconciliation, persistent Cloud backup connection/retention application/restore drill, confirmed market provider, operational alerts, and project-wide cost measurement remain open. GCS lifecycle remains unapplied. No production data, Apps Script, pending queue, Cloud resource, billing setting, deployment, or cutover changed.
- Reaching production completion requires owner-side access to export the configured canonical V2 JSON read-only, reviewed store aliases and representative sanitized Gmail templates, plus approval before any billing/project activation. Do not send tokens or secrets in chat.
- Next safe step: test the strict builder against sanitized, real retailer mail formats and add an explicit review resolution path. Then prepare disabled-by-default Cloud Run composition and a reviewable setup/cost plan before any external activation.


## 2026-11-08 explicit Gmail review approval path (~92% implementation/test estimate)

- Added a code-only outbox review resolution method. It requires an explicit `confirmed: true`, a current review payload hash (optimistic concurrency), complete validated command fields, and explicit retailer/application identity. Firestore atomically transitions only the unchanged `review` row to `ready`; delivery uses the original stable Gmail request ID and shared lottery event key. Missing, stale, already-submitted, malformed, or conflicting states fail closed.
- The path is not exposed as an HTTP endpoint and has no review UI or owner authentication integration. It is a library method exercised with a fake Firestore store. It is not safe to present as a user-facing approval flow yet.
- Focused Gmail outbox tests: 9 passed. Full local cloud suite: 151 passed, 0 failed, 2 Firestore Emulator tests skipped without local Emulator; `npm run check --prefix cloud` passed.
- Gmail OAuth/live retailer templates, Chat Action deployment, Cloud Run auth/runtime, review UI and authorization, canonical V2 export, deployed backup storage/restore, and measured operating cost remain unverified. No V2 data was read or changed; billing, production deployment, and cutover remain untouched. PR stays Draft, unmerged, undeployed.


### CI follow-up
- Hashed-reference version of the review resolver passed GitHub Actions v2-ci #774 on commit `43d40d3a5acacfc813e3a1a5318fff444b11e5b2`, including the Firestore Emulator job. This remains code/CI validation only; no live review authorization or runtime connection.


### Free-tier review (2026-11-08; official pricing pages)
- A single default Firestore Standard database has a free allowance of 1 GiB stored, 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day, and 10 GiB outbound/month. Firestore managed deletes/TTL, PITR, backups, and restores are billed features and require billing.
- Cloud Run request-based allowance includes 2 million requests/month plus CPU/RAM allowances; it is a billing-account-level allowance, not a guarantee of zero cost. Cloud Scheduler provides 3 free jobs/account/month; one dispatcher job fits the job count.
- Cloud Storage Always Free storage applies only in US-WEST1, US-CENTRAL1, US-EAST1, so a Japan-region backup bucket is outside that free storage allowance.
- This is quota fit, not a cost forecast. Actual Firestore operations, dataset size, logging/egress, and backup/restore cost are unmeasured; no billing setting or resource was enabled. Sources: https://cloud.google.com/firestore/quotas ; https://cloud.google.com/run/pricing ; https://cloud.google.com/scheduler/pricing ; https://cloud.google.com/storage/pricing


## 2026-11-08 bounded command worker and verification (~94% implementation/test estimate)

- Added a bounded Firestore pending-command page and Cloud Run `POST /internal/worker/commands` route. Each tick processes up to 10 commands by default (hard cap 50), using existing lease claims, V2 revision CAS, readback verification, and queue settlement. The route requires separate worker authorization, Cloud Scheduler headers, and explicit V2 writes + command queue enablement. Production startup rejects worker enablement unless both write and queue flags are explicitly true; all flags default off.
- Added unit/API coverage and a Firestore Emulator queue-page test. Focused local tests: 20 passed. Full local cloud suite: 155 passed, 0 failed, 4 skipped without Emulator; `npm run check` passed. GitHub Actions v2-ci #782 passed on code commit `ac805f49ba964e7f770f26091627e970f7229e4c`: 415 tests, 407 passed, 0 failed, 8 skipped; Firestore Emulator job succeeded.
- Added setup notes to `cloud/README.md`. This is not an active 15-minute schedule: Cloud Scheduler job, Cloud Run deployment, Secret Manager binding, regular ChatGPT Action registration, live Gmail OAuth/runtime, and complete dispatcher wiring remain unconnected. Do not enable the worker before canonical V2 import and verification.
- No V2 source was retrieved or changed, no pending sale queue was replayed, and no billing, production resource, deployment, or cutover was enabled. PR #105 remains Draft, unmerged, undeployed. Progress remains an implementation/test estimate, not production readiness.


### ChatGPT conversation integration gate (2026-11-08)
- The current OpenAI connection is only a backend API and a GPT Action OpenAPI template; ordinary Chat does not call that endpoint automatically.
- OpenAI’s current Help Center says personal Free/Go/Plus/Pro accounts cannot create or publish new GPTs. Existing GPTs may remain usable/editable if they already exist and account permissions allow, but none has been connected or tested here. Custom MCP write/modify support is currently documented for Business/Enterprise/Edu; Pro custom MCP is read/fetch only. Therefore a Plus account has no documented self-serve custom write MCP route at this time.
- The Apps SDK public directory route is a separate possibility, but it requires building and submitting an app for review, public hosting, privacy/auth design, and user installation. No public app submission or publication is authorized or performed.
- This is a product/connection blocker, not a backend test failure. Before the user goal can be called complete, there must be a supported ChatGPT integration installed and an end-to-end test from a normal conversation with text and screenshot reports. Official references: https://help.openai.com/en/articles/8554397-creating-and-editing-gpts ; https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt ; https://help.openai.com/en/articles/12515353-building-with-the-apps-sdk


### Final verification checkpoint (2026-11-08)
- Latest worker code commit `2e4c32a7f3e9102a71d4a42c9a2ef6a26b350dcf` passed v2-ci #785: 416 tests, 408 passed, 0 failed, 8 skipped; Firestore Emulator job passed. Local cloud suite: 156 passed, 0 failed, 4 skipped without local Emulator; `npm run check` passed.
- Latest handoff/document commit `a658c17ca52e24e56698edef187e111a524f77d3` passed v2-ci #786. This is documentation validation only.
- Current estimate remains ~94% of implementation/test work, not production readiness. Normal ChatGPT write integration, V2 canonical export, billing approval, deployment/runtime connections, backup restore drill, and measured spend remain gates.

### 2026-11-08 JST — Command worker Scheduler認証をOIDC化

- `TV2_WORKER_TOKEN` の共有Secret方式を取り除き、Google `OAuth2Client.verifyIdToken` で署名済みID tokenのaudienceを検証し、設定済みScheduler service account emailとemail_verifiedも照合する認証middlewareを追加。token欠落・署名不正・audience/identity不一致は拒否する。Cloud RunサービスURLと専用Scheduler service accountは識別情報で、Secretではない。
- workerは引き続き既定無効。worker/queue/writeの3 flag、Scheduler marker/予定時刻、既存canonical stateと各IAM設定の確認が必要。`roles/run.invoker`付与、Scheduler作成、deploy、課金設定は実施していない。
- 検証: ローカル `npm test --prefix cloud` 160 passed、0 failed、4 skipped（local Firestore Emulator未起動）。`npm run check --prefix cloud`成功。PR #105への反映後、v2-ci #791のtest/checkとFirestore Emulator jobがsuccess。
- 進捗概算は約94%の実装・テスト作業で据置。これは本番readinessではない。通常Chat書込統合、V2正本export/migration、Gmail OAuth/実接続、Cloud Run/Scheduler本番配備、backup保持/production restore、障害通知、利用量と費用の実測、ユーザー承認が必要な本番移行は未完了。V2正本JSONは未取得。無料枠適合と実費は未測定。既存V2/Apps Script/queue/売却保留/課金設定に変更なし。

### 2026-11-08 JST — Gmail identity一致ゲートとFirestore Emulator cross-source E2E

- Gmail classifier processorは、共有identity resolverとfield-to-command builderの `retailerKey` / `applicationId` が両方一致した場合だけoutboxへ送る。片側の別名設定や抽出結果が食い違う場合はcommandをnullにしてreviewへ送る。
- 合成データのFirestore Emulator testでChat HTTP endpointが先に応募を受け付け、その後Gmail classifier→builder→outboxから異なるrequestIdで同一応募を送ったとき、Firestore上のcommand本体とbusiness-event indexが各1件であることを確認。ID欠落と同一キー・異なるcommand内容もreview/collision扱いで検証した。
- 検証: ローカル cloud suite 161 passed / 0 failed / 5 skipped（local Emulatorなし）、check成功。GitHub Actions v2-ci #796のtest/checkとFirestore Emulatorがsuccess。Emulator内の該当統合testはpass、0 skipped。
- Live Gmail/OAuthからの呼出、通常Chatとの実接続、production Cloud Run/Scheduler、V2正本export/migration、backup保持とproduction復元、監視/費用実測は未完了。V2正本未取得。進捗約94%は実装・テストの概算で本番readinessではない。既存V2、Apps Script、現行queue、売却保留、課金設定に変更なし。

### 2026-11-08 JST — Google Cloud無料枠/backup費用の公式確認

- 現行Google公式料金表: Firestore Standard無料枠は1 GiB、50,000 reads/day、20,000 writes/day、20,000 deletes/dayだが、Backup/Restore/PITR/TTLは無料利用対象外で課金有効化が必要。Cloud Runの公表無料枠は月2M requests等、Cloud Schedulerはbilling accountごと3 jobs/month。1件のdispatcher jobはjob数の無料枠内だが、全体無料を保証しない。
- Cloud Storage Always Freeは標準storage 5 GB-months等だがUS-WEST1/US-CENTRAL1/US-EAST1限定。Tokyo/Osaka bucketはこの無料保存枠対象外。したがって日本リージョンの永続backupは無料前提にできず、Firestore managed backup/restoreも課金なしでは使えない。
- 実データ容量・実API利用量・既存billing accountの使用量が未確認で、実月額は未算出。billingは有効化しておらず、backup保存先・保持日数・削除lifecycleも確定/適用していない。90日削除ポリシー等は承認前に適用しない。
- Official sources: https://cloud.google.com/firestore/pricing ; https://cloud.google.com/run/pricing ; https://cloud.google.com/scheduler/pricing ; https://cloud.google.com/storage/pricing

### 2026-11-08 JST — Gmail頻度とGoogle Drive backup費用の評価（検討中）

- 確定済みGmail予定（07:00〜24:00 hourly、12:30重点確認、19:00は毎時scanへ統合）は変更していない。実装上の15分dispatcherはGmail以外にcommand queueも扱うため、Gmail scanを減らしてもdispatcherのCloud Run起動回数は減らない。Gmail API標準利用は追加料金なしで、現行新quotaのdaily threshold 80,000,000 units/day未満は追加料金なし。仮に19 scan/day、各scanがlist 1件 + 最大50件の`messages.get`をfull相当60 unitsで取得しても約57,095 units/day。これは概算で実測ではなく、projectの作成年/2025-11〜2026-04 API利用有無で適用quotaが変わる。Hourly設定を落としてもCloud請求アカウント要件は解消しない。
- Google Driveの既存ユーザー領域は最大15 GBでGmail/Drive/Photos共有。標準Drive API利用は通常追加料金なしのため、空きがありユーザーOAuthで書ける場合、既存Drive folderをbackup先にする案はCloud Storage Japan regionより保存料を抑えられる候補。OAuth scopes/Drive API quota/利用可能容量は未確認。
- Driveのcreate-onceを維持する候補設計: `files.generateIds`のIDをFirestoreのstable backup-key registryへtransactionalに保存し、そのIDでDrive fileを作成。競合/再試行は同じIDの409とSHA-256 readbackで照合。Firestore registryは引き続きGoogle Cloudサービスなのでactive billing account要件が残る。Firestore managed Backup/Restore機能は利用せず、application-generated JSON backupをDriveへ保存する案。
- Google Cloud projectはactive Cloud Billing accountへリンクしないと、free tier範囲だけの利用でもGoogle Cloud resourceを使えない。従って「利用料0円の可能性」と「課金を有効にしなくても動作」は別。現在billingは未有効化。GCS Japan保存、retention period、自動削除lifecycle、Drive接続はいずれも未設定。
- Status: Drive案は検討中、仕様変更/実装/接続/削除なし。保持容量を超えた場合の扱いと保持期間は未決定。Sources: https://developers.google.com/workspace/gmail/api/reference/quota ; https://developers.google.com/workspace/drive/api/guides/limits ; https://developers.google.com/workspace/drive/api/guides/create-file ; https://support.google.com/drive/answer/9312312 ; https://docs.cloud.google.com/billing/docs/how-to/manage-billing-account


### 2026-11-08 JST — Drive backup adapter prototype (unconnected)

- Added an optional Google Drive backup repository candidate plus a Firestore transactional stable-key → generated Drive file ID registry. Retries reuse the reserved ID; an existing file is accepted only when the key hash and payload SHA-256 match. Readback verifies payload bytes/hash, and payload size is bounded at 7.5 MB.
- Verification: local cloud suite 166 passed, 0 failed, 5 skipped (local Firestore Emulator is unavailable); `npm run check --prefix cloud` passed. PR #105 v2-ci #803 passed both the full test/check job and the Firestore Emulator job, including the concurrent registry reservation test.
- This is an unconnected candidate implementation. It is not wired to backup export or runtime, and has not been tested against Google Drive API/OAuth. No Drive folder, OAuth grant, retention, or deletion lifecycle was configured; no backup data was written. Existing backup location and Gmail schedule are unchanged.
- Progress remains about 94% implementation/test work, not production readiness. The V2 canonical export remains unavailable/unverified. Production authentication/runtime, normal ChatGPT intake, live Gmail/OAuth, recovery drill, monitoring, cost measurements, billing approval, and migration validation remain outstanding.
- Cost note: Drive may use available user storage quota, but Cloud Run/Firestore still require an active billing account linked to the project. No billing configuration was enabled and actual free-tier fit remains unmeasured.


### 2026-11-08 JST — scheduler health route and regular ChatGPT integration gate

- Wired `GET /health/scheduler` to the Firestore scheduler-heartbeat store in the Cloud Run startup path. It returns only bounded timestamps/counts; it returns 200 only for a fresh heartbeat with zero missed slots and zero failed jobs, and 503 for missing/stale/inconsistent/unavailable health. It does not expose command, email, or raw error data.
- Local verification: API tests 14 passed; full cloud suite 167 passed, 0 failed, 5 skipped without local Emulator; `npm run check --prefix cloud` passed. PR #105 v2-ci #806 passed both test/check and Firestore Emulator jobs. The route is implemented, but the live dispatcher/Scheduler is not configured, so no operational heartbeat exists and the health route should remain 503 until a real dispatcher is connected.
- Read-only Drive search for a current V2 JSON/export found only the handoff document. The canonical V2 JSON remains unavailable/unverified. No old schemaVersion 1 or unverified staging JSON was opened or used.
- Current OpenAI product documentation changes the feasible regular-Chat connection path: personal ChatGPT Plus accounts cannot create/publish new GPTs; existing GPTs may remain usable under account rules. Custom MCP write connections are documented for Business/Enterprise/Edu workspaces. The public plugin directory accepts remote MCP apps, but requires a stable public HTTPS endpoint, verified developer identity, and review. No app was submitted, published, or connected. This is a feasibility update, not a change to the requirement that ordinary ChatGPT must support text/screenshot reporting.
- Operational blockers remain: confirmed V2 canonical export, Cloud billing approval and deployment, live OAuth/provider connections, public ChatGPT integration publication/installation, scheduled handler composition, backup retention and restore verification, alerts, and measured usage/cost. No billing, production data, V2, Apps Script, Scheduler, or Drive destination was changed.
- Official product references: https://help.openai.com/en/articles/8554407-what-are-gpts ; https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt ; https://developers.openai.com/plugins/deploy/submission ; https://help.openai.com/en/articles/12515353-building-with-the-apps-sdk


### 2026-11-08 JST — ChatGPT MCP authentication requirement clarified

- Current OpenAI authenticated MCP guidance requires an OAuth 2.1 authorization flow for write-capable/customer-specific tools and states ChatGPT cannot present custom API keys. The existing Cloud Run REST bearer token therefore cannot be reused as the ChatGPT app connector credential. No OAuth authorization server/provider has been selected or implemented.
- The public plugin directory remains a possible regular-Chat path, but it requires the remote MCP endpoint, OAuth flow, verified developer identity, and submission review. This is not a change to the user requirement; it is a newly confirmed product authentication gate. Do not publish or enable write access until the OAuth design, deployment, canonical data, and reviewable permission scope are ready.
- Official reference: https://developers.openai.com/plugins/build/auth


### 2026-11-08 JST — 通常Chat未登録2件の読み取り専用照合

- 通常Chatの報告内容を確認したが、Chat→新アプリqueueには送信されていない。V2にも反映されていない。①11/6 30th CELEBRATION 1BOX、イトーヨーカドー アリオ八尾店、シュリンク付き、原価7,200円（支払7,205円から袋代5円除外）。②11/7 ORIGINAL ARTWORK DUEL SET 3種類各1個・合計1セット、過去支払済みで新規原価なし。
- ユーザーがV2アプリ画面の「V2正本を書き出す」から出力したsnapshotをread-only確認。schemaVersion 2、revision 2708、exportedAt 2026-11-08 17:39 JST、SHA-256 `930bb73fca5c9d8145cf78008dc7595b01985565d4bccc646cad930d2ec70b88`。画面表示はrevision 2709のため、snapshotは画面より1 revision古い。
- revision 2708のtransactions/inventoryLotsに2件と一致する記録なし。類似名称「オリジナルアートワークコレクション 1BOX」の抽選応募3件は別記録として扱い、DUEL SETと自動同一視しない。
- 既存Google Sheets Command Queueを読み取り専用で確認し、9行中8行が保留売却、1行が抽選。今回の2件に一致する行なし。Queueは一切変更せず、保留売却を再投入していない。
- 現行migration validatorはBOX condition「シュリンクなし」で失敗。canonical exportの誤りではなく、新アプリ側の値互換性不足。原本JSONは変更していない。原価不明の在庫4ロットは推測補完しない。
- 状態: 報告内容確認済み / queue送信なし / V2反映なし / 登録後の正本再読込検証なし。read-only exportのみ検査済み。Cloud Run queue実接続は未完了であり、旧V2直接書込みは禁止。
- 登録案: 30thはpurchase commandにできるが、live queueがないため未送信。DUEL SETは汎用のreceipt-only/no-new-cost commandが未実装。0円purchaseで代用せず、原価二重計上を防ぐ受取専用処理を設計する。revision 2709以降の再export・二重登録確認・登録内容提示とユーザー承認を経るまで登録しない。
- Overall estimate remains approximately 94% implementation/test work, not production readiness. No production, Apps Script, V2, queue, billing, deployment, or cutover changes.


### 2026-11-08 JST — V2エクスポート形式の検証と互換性修正

- `v2/core.js` が既存BOX状態「シュリンクなし」を有効値として許容するよう修正。値の書換えや正規化はせず、元データ表記を維持する。
- `inspectV2Snapshot` がV2アプリのエクスポート外枠（app/schemaVersion/exportedAt/revision/data）を読み取れるよう修正。外枠とpayloadのrevision不一致は拒否し、SHA-256はJSON出力ファイル全体を対象に計算する。エクスポート形式、原本ハッシュ、revision不一致、既存BOX状態をテスト。
- GitHub Actions v2-ci #810 は npm test、npm run check、Firestore Emulator jobがすべて成功。code head: `57463dcb7f39c19f0491cabe7744feb9fd14468b`。
- 適用結果: ユーザーのV2アプリ画面から出力されたschemaVersion 2 / revision 2708 JSONをread-only検証。SHA-256 `930bb73fca5c9d8145cf78008dc7595b01985565d4bccc646cad930d2ec70b88`、sourceBytes 1,341,567、取引97（購入56/売却34/開封7）、在庫32ロット・数量37、抽選517、相場25、監査2,728。画面表示はrevision 2709で、JSONは1 revision古い。
- Firestore保存見積りはpayload 1,036,003 bytes。単一document安全上限900,000 bytesを超えるためchunked-v1 5 segment（基準13 reads/6 writes per successful mutation）を選択。payload size/segment limits内で安全計画可能。これは設計見積りで実測費用ではない。原価不明lot 4件は推測補完しない。
- 既存Sheets queueは9行（未処理売却8、抽選1）、今回2件と一致なし。似た名称の「オリジナルアートワークコレクション 1BOX」抽選応募3件はDUEL SET受取と別扱い。
- 通常Chat報告は確認済みだが、新アプリqueue送信なし、V2反映なし、登録後readbackなし。新アプリAPI/Cloud Runは未配備、旧V2書込みと未処理売却再投入なし。受取専用（原価を二重計上しない）一般commandは未実装。通常Chat連携とreceipt-only設計が次工程。PR #105はDraft・未merge・未deploy。


### 2026-11-08 JST — 通常Chat接続の公開Plugin経路（検討中）

- 新規GPT作成や個人用の直接MCP接続を前提にせず、ChatGPTの公開Plugin／アプリディレクトリから通常Chatへ接続する経路を候補として調査した。公開PluginはChatGPTのモバイルでも利用できる設計だが、個々のPluginの提供プラン・画面は異なるため、PlusのAndroidでの利用可否は公開候補の実機テストで確認する。
- 公開には安定した公開HTTPS MCP endpoint、OAuth 2.1 user authentication、開発者本人確認、公開レビュー、モバイルを含む動作テストが必要。既存RESTのBearer API tokenはChatGPTの公開MCP認証として流用しない。OAuth providerは未選定。
- 現時点は「候補・未実装・未検証」。公開申請、公開、配備、本番データ接続、課金設定の有効化は行っていない。API queue/worker/write flagsも有効化しない。
- 次工程: 既存Cloud Run APIに対する独立したMCP/OAuth adapter案、ローカル/CI mock E2E、公開審査要件一覧を作る。安全なステージング接続と費用・billing案をレビュー可能にしてから、必要な承認を得る。
- 旧V2書込み、売却queue再投入、本番切替は禁止。通常Chat未登録の2件は確認済みだがqueue送信なし/V2反映なし。JSONはrevision 2708で画面revision 2709より古く、移行には2709以降の正本再出力が必要。
- Official refs: https://help.openai.com/en/articles/20001256-plugins-in-chatgpt ; https://developers.openai.com/plugins/build/auth ; https://developers.openai.com/plugins/deploy/app-review ; https://developers.openai.com/plugins/plugin-guidelines


### 2026-11-08 JST — 通常Chat入力の短期ブリッジ候補（Google Driveアプリ＋専用受付シート）

- 公開Pluginの審査/OAuth準備とは別に、ChatGPT標準のGoogle Driveアプリが通常会話でGoogle Sheetsの更新を許可する場合、専用受付シートを新アプリのinput bridgeにする候補を評価する。OpenAIの現行ヘルプはGoogle Sheets/Docs/Slidesのソース更新を説明しているが、個々のactionはプラン・権限・surfaceに依存する。
- 使用する場合も既存V2 Command Queue、V2 JSON、Apps Scriptには書き込まない。新アプリ専用sheetに未処理報告を置き、Cloud Runのread-only readerが検証・idempotent Firestore enqueueを行い、処理結果を専用sheetへ記録する設計候補。
- Plus AndroidでGoogle Sheets更新actionが利用可能か、行追加と読み戻しまでの通常Chat E2Eは未確認。サービスアカウント共有、Cloud Run課金、表の書込範囲、保持・削除方針も未決定。この方式を確定仕様とはしない。
- 次: row parserとpoll result→Firestore queue importerを副作用のないpure function/adapterとしてテストする。受取専用・原価なしはpurchaseに変換しない。OAuth / public MCP案は審査準備を要する代替候補として保持。
- No production sheet/resource was created or modified. Billing, old V2, old queue, cutover remain unchanged.
- Official reference: https://help.openai.com/en/articles/10929079-google-drive-app-and-setup-in-chatgpt ; https://help.openai.com/en/articles/20001256-plugins-in-chatgpt


### 2026-11-08 JST — 専用Sheets受付workerの実装

- `Toreca Vault New App Intake` 専用Spreadsheetから `new` 行を最大20件（provider上限50件）読み、Firestore create-once queueへ登録するprocessor、Sheets API provider、Scheduler認証付き `/internal/worker/sheets-intake` handlerを追加。status/result/accepted request ID/処理時刻だけを同じ専用sheetのD:Gへ返し、A:Cは変更しない。既存V2 Queueのファイル名・IDは設定不可で、旧V2 API/CASへは接続しない。
- 申込・結果・受取の抽選イベントでは、明示されたretailerKeyとapplicationIdが無い/不正なら`review`へ送り、requestIdの違うChat/Gmail報告でも共通businessEventKeyで重複を防ぐ。再試行は同一requestIdを使い、queue成功後のreceipt書込み失敗時も重複登録しない。
- Verification: `npm run check --prefix cloud` passed. Full cloud suite: 180 passed, 0 failed, 5 Emulator integration tests skipped because `FIRESTORE_EMULATOR_HOST` is not configured. Google Sheets parser/provider 9 tests and HTTP handler auth/disabled-gate tests passed. No live Google Sheets, ChatGPT Android, Cloud Run, Scheduler, OAuth, or Firestore project was connected.
- `TV2_ENABLE_GOOGLE_SHEETS_INTAKE` is false in `.env.example`; runtime also requires the queue gate and Scheduler OIDC settings. All production flags remain off. No spreadsheet, account grant, billing, or deployment was created. Standard Chat to sheet row write and end-to-end result visibility remain unverified, so ordinary reports are still not considered queued.
- Implementation/test progress estimate: approximately 95% (code and local tests only), not operational readiness. V2 canonical export state remains unchanged: schemaVersion 2/revision 2708 export trails screen revision 2709 by one; no V2 writes. Two reported items remain confirmed/unregistered/not queued/not applied. Existing queue untouched; pending sales not replayed.
- Next: verify the user-facing normal Chat Google Sheets write/read action on Android; create the isolated intake sheet only when that path is confirmed; separately review Cloud Run identity, Scheduler, active billing requirement, cost estimate, service access and production gates. Until then do not enable flags, deploy or migrate.


### 2026-11-08 JST — 専用受付シート準備・CI確認

- Google Driveに専用Spreadsheet「Toreca Vault New App Intake」を作成し、`Intake` tabとA1:G1の7列headerを設定。A2:G2以降にデータ行が無いことを再読込で確認。既存V2 Command Queueとは別ファイルで、報告データは投入していない。
- GitHub Actions v2-ci #814 passed on head `82b8230705d4a3a3534d2fb1fcf968fd22a825c7`; `test` and Firestore Emulator jobs both succeeded. PR #105 remains open, Draft, unmerged, undeployed.
- Google Drive/Sheets access is available in this Work session, but this does not prove the user's standard ChatGPT Android client can write rows. Service-account permission, Cloud Run, Scheduler, OAuth, production flags, and billing remain unset. No queue delivery or V2 update is claimed.
- Next: test a harmless write/read from ordinary ChatGPT Android. Only after that succeeds connect a dedicated Cloud Run identity to this sheet. Do not enter a real transaction until queue receipt/status and retry behavior are end-to-end verified.


### 2026-11-08 JST — 通常Chat AndroidからSheetsへの基本書込確認

- ユーザーが通常Chatから「Toreca Vault New App Intake」の`Intake!A2`へ`normal-chat-smoke-test`を書き込み、同セルの読み戻しに成功したと報告。Work側でも同値をread-only再確認し、A2だけを空に戻した。再読込でA1:G1の見出しが保たれ、A2:G3にテスト行/取引行が残っていないことを確認。
- これで通常Chat Androidから接続済みGoogle Driveアプリを使った基本write/readは確認できた。ただしChatが取引報告を安全なcommand JSONへ変換する処理、通常Chat→queue→worker→結果表示のE2E、スクリーンショット報告はまだ未検証。テスト値はqueueに送信していない。
- 通常Chatの入力経路は「Google Driveアプリ＋専用受付シート」で表面上の基本接続を検証済み、backend連携は未実装/未接続として扱う。通常Chatの投稿のみで取引登録できるという完成条件は未達。
- 次工程: Cloud Run service identity、Scheduler OIDC、Firestore queueの接続仕様と具体的な費用見積りをレビュー可能にする。Cloud billing有効化・deployment・service-account共有はユーザー承認前に行わない。受取のみ/原価計上なしcommandと処理結果readback E2Eも引き続き未完了。

### 2026-11-08 JST — IntakeのFirestoreページカーソル

- 通常Chat AndroidからGoogle Driveアプリ経由で専用sheet A2にテスト値を書き、読み戻せることを確認。Workで同値を再確認後、A2のみクリアし、header保持と空データ行を確認した。これは基本write/readだけで、実取引をqueueに送っていない。
- intakeが常に先頭20行だけを見て以後の新しい行を見落とす問題を解消するため、Firestoreにページカーソルを追加。保存するのはspreadsheet IDのhash、nextRow、generation、timestampだけ。連続20行を処理し、全receipt完了後にCAS advanceする。queue/receiptが失敗すると位置を進めず、再実行はstable requestIdとbusinessEventKeyで冪等。
- append-only運用を前提とする。シート上で過去行をsort/delete/insertせず、訂正は新行・新requestIdで行う。データやcommand内容はcursor storeに保存しない。
- Local check passed; full cloud suite 183 passed/0 failed/6 skipped (local Firestore Emulator未設定)。Firestore Emulator用cursor競合テストを追加。GitHub Actions v2-ci #817 passed test/check and Firestore Emulator.
- 運用未完: normal Chat command JSON生成・queue反映・15分処理・結果表示E2E、Cloud Run/Scheduler/Firestore接続、OAuth/Service Account access、billing approval、canonical V2最新export/migration、receipt-only no-cost command。production flagsはoff、V2/旧Queueは変更なし。

### 2026-11-08 JST — 受付結果のreadback guard

- Sheets intake providerはD:Gへreceiptを書いた後、同じ4セルを再読込して値が一致した場合のみ成功を返す。空欄や不一致の場合はworkerがcursorを進めず同一pageを再試行する。
- queueへの再送は安定requestIdで冪等。通常Chatの実取引報告、queueからworkerの本番E2E、画像報告、Cloud Run実接続は未検証。
- Receipt readbackの成功/欠落/不一致テストを追加。`npm test --prefix cloud`: 184 passed, 0 failed, 6 skipped (local Emulator未設定); `npm run check --prefix cloud` passed. GitHub Actions v2-ci #819 passed test/check and Firestore Emulator.

### 2026-11-09 JST — Intake受付からV2結果までのstatus追跡

- Accepted Sheets rows now receive a request correlation embedded in the existing queue item: SHA-256(sheet ID), row number, and a small receipt state. No raw sheet ID is copied into Firestore. The existing 15-minute Sheets worker reconciles terminal queue outcomes; no extra Scheduler job is required.
- The sheet remains `queued` while the queue is pending or processing, avoiding stale concurrent status regressions. After the command worker has verified the V2 revision/mutation readback, the status reconciler writes `v2-applied` plus `canonical-readback-verified` (or `duplicate`/`review`) to D:G, rereads all four cells, then marks the receipt final in Firestore. Failures leave reconciliation retryable.
- Local full suite: 188 passed, 0 failed, 7 skipped without local Emulator; `npm run check --prefix cloud` passed. GitHub Actions v2-ci #821 passed test/check and Firestore Emulator, including hashed queue correlation and finalization.
- No production runtime, Cloud Run, Scheduler, Firestore, Gmail, V2, or billing was connected. Normal Chat real-report/result E2E and screenshot intake remain unverified; the two historical reports are still not queued/not applied.


### 2026-11-09 JST — Firestore Emulator intake-to-final-receipt integration

- Added a synthetic integration path: the intake processor enqueues a dedicated-sheet row, the command worker applies it to a test V2 snapshot and reads back the saved revision/mutation, then the status reconciler writes v2-applied / canonical-readback-verified for the same row and finalizes the Firestore correlation.
- GitHub Actions v2-ci #823 passed both the normal test/check job and the Firestore Emulator job. Local suite: 188 passed, 0 failed, 8 skipped (Emulator tests ran in CI); npm run check --prefix cloud passed.
- Scope: Firestore queue/correlation used the real Emulator; the Sheets provider and V2 snapshot store were test doubles. No live Sheets, Cloud Run, Scheduler, OAuth, or canonical V2 connection was made. Real transaction or screenshot reporting from ordinary ChatGPT remains unverified.
- PR #105 head 5e230653e11081e9fa3e9de2122c9bdd67129bdd remains Draft/open/unmerged/undeployed. The development estimate remains about 94% of implementation/test work, not production readiness. The schemaVersion 2 export is revision 2708 while the app screen showed 2709; canonical latest revision is unconfirmed. The two historical reports remain unqueued/unapplied; old queue and pending sales were untouched. No billing or production cutover was enabled.


### 2026-11-09 JST — Verify intake row identity before writing receipts

- Before writing a queued or terminal receipt to D:G, the Sheets provider rereads the target row A:D and verifies that its A-column request ID still matches the queue's accepted request ID. A mismatch fails closed and leaves the Firestore receipt correlation retryable, preventing a moved/replaced row from receiving another command's status.
- Added coverage for source-row mismatch and retained write/readback failure coverage. Local full suite: 189 passed, 0 failed, 8 skipped (Emulator cases run in CI); npm run check --prefix cloud passed. GitHub Actions v2-ci #825 passed normal test/check and Firestore Emulator jobs.
- This is code/CI verification, not a live Sheets/Cloud Run test. PR #105 remains Draft/open/unmerged/undeployed. No V2/old-queue/pending-sale/billing/cutover changes; normal Chat transaction/screenshot E2E and latest canonical V2 export remain unverified.


### 2026-11-09 JST — Recheck of regular Chat mobile route and free-tier requirements

- Current official OpenAI help says full custom MCP write support is available to Business and Enterprise/Edu on ChatGPT web; custom MCP servers are not connectable on mobile. A direct custom MCP write app is therefore not an available Plus/Android path.
- Submitting an app for the public ChatGPT app directory remains a candidate route. Availability and functionality vary by plan/region, and Android support must be tested after review/publication. It requires a public endpoint, OAuth, privacy/safety review, and app approval.
- Google Cloud requires a valid Cloud Billing account even when usage is intended to remain inside Free Tier. Low-volume Cloud Run/Firestore/Scheduler usage may fit published quotas, but overages and backup storage/features may bill. Firestore backup/restore features are excluded from free usage; Cloud Storage Always Free applies only to three US regions. Actual project-wide cost remains unmeasured.
- No billing link, deployment, OAuth grant, or public app submission was made. This Work session has no Google Cloud Console control. Do not enable billing before the user's approval.
- Progress remains approximately 94% of implementation/test work, not operational readiness. PR #105 is still Draft/unmerged/undeployed. Normal Chat text/screenshot transaction E2E and canonical latest V2 export (2708 file vs 2709 screen) remain unresolved.


### 2026-11-09 JST — 新Work継続時の状態照合

- PR #105 remains open, Draft, unmerged, and undeployed. Branch head at this check: `38f494d495de0d59ef73f2c01ec13e726fb5947c`. GitHub Actions v2-ci #825 and the newer #828 both completed successfully; #828 is the latest observed run for this head. These are CI results only.
- Read-only inspection of the isolated `Toreca Vault New App Intake` sheet found the seven-column header and no data rows in A2:G5. No test or transaction was written during this check.
- The app feature set includes lottery receipt, which updates a matched lottery record without adding purchase or inventory. It does not include a general receipt-only command for a previously paid non-lottery order. Do not encode such a report as a zero-cost purchase or enqueue it until its V2 inventory/history semantics are explicit.
- Current canonical export evidence remains schemaVersion 2/revision 2708, while the app screen was reported as revision 2709. Do not migrate, deduplicate against, or apply commands to the stale export until the latest canonical read-only export is confirmed and compared.
- The 2026-11-06 30th CELEBRATION purchase and 2026-11-07 ORIGINAL ARTWORK DUEL SET receipt remain unqueued and unapplied pending duplicate checks. The receipt-only report must preserve prior cost without a second cost entry. Existing sale queue and pending sales remain untouched.
- Safe next work: establish the general receipt-only state transition and tests against a confirmed current schema, then verify normal Chat report → intake row → queue → worker → canonical readback end to end. Live Sheets/Cloud Run/Scheduler/OAuth, screenshot reporting, canonical revision match, billing, migration, and production deployment remain unverified or disabled.


### 2026-11-10 JST — 最新V2 export revision 2789の重複照合

- ユーザー添付の `toreca-vault-v2-2026-11-10.json` をscratch上で読み取り専用検証。app/schemaVersion=2、data.schemaVersion=2、revision=2789が一致。exportedAtは2026-11-09T22:06:52Z（2026-11-10 07:06 JST）。transactions=97、inventoryLots=32、lotteries=520、marketQuotes=25、auditLog=2809。
- revision 2789に2026-11-06または11-07の日付のtransactionはない。2026-11-06の「30th CELEBRATION」1 BOX（イトーヨーカドー アリオ八尾店）と同名の在庫lotは見つからない。ただし過去の30th商品取引/他セット在庫は複数存在するため、今回のBOXと別商品であることを保って登録する。
- 2026-11-07のORIGINAL ARTWORK DUEL SETについて、transaction/inventoryLotsに報告された英語・日本語の商品名および一般的なカード名の一致は見つからない。過去支払いの記録は別の商品表記の可能性もあるため、費用を再計上せずに受取だけを記録できるcommandが必要。汎用receipt-only commandは未実装。
- 旧handoverに記録したexport revision 2708 / screen 2709の差は、この添付revision 2789により古い状態の記録となった。添付内容と構造は変えていない。2件はまだsheet/queueへ送信せず、V2も書き換えていない。
- 30th purchaseは既存purchase commandで表現可能。実行前にnormal Chat→intake→queue→worker→canonical readbackの実E2Eを完了させる。ORIGINAL ARTWORK受取は項目名と既払費用の対応を確認し、no-double-cost receipt transitionを追加してテストする。Cloud Run/Scheduler/OAuth、課金、deployment、migrationは未実施。


### 2026-11-10 JST — 報告2件を専用Intakeへ記録

- revision 2789のread-only照合を踏まえ、専用「Toreca Vault New App Intake」の Intake!A2:G3 に2件を記録し、値を読み戻して確認。
- 11/6の30th CELEBRATION 1BOXはrequestId normalchat:2026-11-06:30th-celebration-arion-yao、status=new。既存purchase commandとして受付待ちにした。商品原価は7,200円（袋代5円を除外）、数量1、シュリンクあり、購入店/日付を記録。これはIntakeへのステージングであり、Firestore queue受理・worker処理・V2反映を意味しない。
- 11/7のORIGINAL ARTWORK DUEL SETはrequestId review:2026-11-07:original-artwork-duel-set、status=review / resultCode=needs-review。3種類各1個・合計1セット、過去支払済みと記録し、商品別名と既払原価の対応が照合できるまで在庫・原価commandを投入しない。
- Sheetはappend-only運用。要確認行を後から new に変更しない。照合後に処理する場合は、新しいrequestIdで新行を追加し、既払原価の二重計上を防ぐ。
- 最新の読み戻しで両行の内容とstatusを確認。Firestore queue、Cloud Run worker、canonical readback、通常Chatからの完全E2Eは未検証。PR #105はDraft/unmerged/undeployed。V2原本・旧queue・未処理売却8件・billing・本番deploymentに変更なし。


CI follow-up (2026-11-10 JST): GitHub Actions v2-ci #834 passed on commit 7e169dcafe2be762b3cac4a0ff8b726420d45c36 after both handover files had been updated. The latest intake staging state is documented above; CI is code/docs validation only and does not process the staged row.

### 2026-11-10 JST — 承認済みステージング作成の実行ブロッカー

- ユーザーは新アプリ用ステージング環境の作成・デプロイと必要な課金有効化を承認。旧V2への書込みと本番移行は別途承認。
- 実行前に既存手順と構成を確認。GitHubのcloud/README.mdでは未配備、Firestore接続・Cloud Run・Cloud Scheduler・production runtimeは未接続と記載。PR #105のflagsは既定でoff。
- 操作環境にGCP provisioning connectorがなく、作業用workspaceにもgcloud/firebase CLIがない。承認されたCloud Console URLを開いて再読込したが、両方とも「Site Unavailable」。アカウント/project/既存billing状態を確認できず、作成・課金・deploymentは一切行っていない。
- 次はConsole/適切なGCP APIアクセスが利用可能な環境で、ステージング専用project/region、最小API/identity/IAM、予算通知を確認し、syntheticデータだけでdeploymentとintake→Firestore→worker→readbackを検証する。旧V2書込み、本番移行、既存queue処理、billing範囲拡大は含めない。

### 2026-11-12 JST — ステージングCloud RunとIntake取込を実測

- ユーザー承認を受け、新アプリ専用Cloud Run/Firestoreステージングを作成・デプロイ。Cloud Run service `toreca-vault-staging`（asia-northeast1）はReadyで100% traffic、未認証アクセスは不可。ビルド時にCloud Build実行SAへroles/run.builderを付与し、Dockerfileがリポジトリroot相対のv2/core.jsとcloud/を参照するため、デプロイ用一時ビルドcontextを組み立てて修正。アプリコードは変更せず、PRのコードSHAはデプロイ時点で5e04ab8e436a555db67775e0122729a3d00369b0。
- 非公開の認証付きGET /healthはHTTP 200。応答は canonicalInitialized=false / writesEnabled=false。FirestoreのV2 canonical snapshotはまだ初期化しておらず、インポートもしていない。
- 専用「Toreca Vault New App Intake」だけをstaging runtime service accountへwriter共有。Cloud RunはSheets intakeとFirestore command queueだけ有効。TV2_ENABLE_WRITES=false、TV2_ENABLE_COMMAND_WORKER=falseのまま。専用Scheduler SAに当該Cloud Run serviceのrun.invokerだけを付与し、Asia/Tokyoで15分ごとのintake Scheduler jobをenabledにした。
- Intake!A2の2026-11-06 30th CELEBRATION購入報告（商品原価7,200円、袋代5円除外）はFirestore staging queueへ一度受理され、Sheets receiptを読み戻してstatus=queued / resultCode=accepted / acceptedRequestId一致を確認。これは受付・queue readback確認であり、V2反映ではない。
- Intake!A3の2026-11-07 ORIGINAL ARTWORK DUEL SETはstatus=review / needs-reviewのまま。新たなpurchase/receipt commandは作っておらず、二重原価計上を防いでいる。
- 旧V2、本番データ、既存queue、未処理売却8件、Gmail、旧Apps Scriptは未変更。V2 canonical import、command worker、V2 writes、本番移行は未実施。
- 確認できたのは専用Sheet→Cloud Scheduler OIDC→Cloud Run intake→Firestore queue→Sheet receipt readbackまで。通常Chatの自然文/画像からcommandJsonを作るend-to-end、queue status polling、canonical V2への適用/readbackは未確認。通常Chat Androidの単一セルwrite/read smoke testは別途確認済み。
- PR #105はDraft/open/unmerged。今回のhandover更新でCIを再実行し、結果を追記する。実装・テスト進捗約94%は本番運用可能率ではない。

次工程: private APIのqueue statusを読み取り確認し、通常Chatからの画像/文章報告→専用sheet→staging queueの経路を安全な合成報告で検証。その後もcommand workerはcanonical schemaVersion 2の最新exportを確定・照合し、移行が別途承認されるまでoffに保つ。

### CI follow-up — 2026-11-12 JST

- GitHub Actions v2-ci #839 for handover commit `f5185dbfb1298d1c25362bfb237b7932b97bb47c` completed successfully: test/check and Firestore Emulator jobs passed. This verifies code/CI only; it does not enable the command worker or apply the queued 30th CELEBRATION report to V2.
- Staging intake evidence remains: A2 accepted/queued with receipt readback; A3 remains review/needs-review. Cloud Run is private and healthy. V2 writes and command worker remain disabled; PR #105 remains Draft/open/unmerged.


CI follow-up — 2026-11-12 JST: v2-ci #840 (handover update) and #841 (PR/handover status update) both completed successfully. Test/check and Firestore Emulator jobs passed. The staging configuration and data-path status above are unchanged; V2 writes/command worker remain disabled.


### 2026-11-12 JST — staging API認証とキュー状態のread-only確認

- staging API Secretの内容は65 bytesで末尾LF付きと確認。Cloud Shellのcommand substitutionがLFを落とすため、Authorization Bearer値がCloud Run環境変数と不一致になり401となっていた。Secret本文は出力せず、LFを除いたsecret version 2を追加し、Cloud Run `toreca-vault-staging` を再deploy。revision `toreca-vault-staging-00003-a54` がReady/100% traffic。
- 認証付きGET `/api/v2/commands/{requestId}` が成功し、30th CELEBRATION requestIdのqueue状態を `pending`、`processed=false`、`canonicalReadbackVerified=false` と確認。キューに存在するがworkerはOFFのため、V2適用済みではない。A2 receipt/readbackの受付状態とも矛盾なし。
- V2 writes/command workerはOFF。canonical V2 import、旧V2、既存queue、未処理売却8件、本番migrationに変更なし。PR #105はDraft/open/unmerged。
- 前回handover CI v2-ci #842は成功。今回のhandover docs更新後のCI結果は次のfollow-upで記録する。


### 2026-11-12 JST — 通常Chat Intake運用境界の明文化

- `cloud/README.md`の古い「未deploy/bridge未接続」記述を現在のstaging状態で補正し、Intake A:Gの列と安全な行ルールを追記。A=requestId、B=commandJson、C=抽選識別子JSON、D=status、E:G=receipt。正常な新規行だけD=`new`、曖昧/重複/原価未確認はD=`review`。既存行の並替え・修正・再送は禁止。
- normal Chat Androidの単一セルSheets write/readは確認済み。自然文/画像を自動解析して完全なrowを作成するE2E、およびV2 canonical readbackは未確認。A2はstaging queueでpendingのまま。V2 writes/workerはOFF、PR #105はDraft/open/unmerged。
- README変更commit `8b12bae00969d1bfe57314c35454ebba76a9dcdf`後のCIを確認する。

### 2026-11-12 JST — 通常Chat用staging受付quickstart

- `docs/STAGING_CHAT_QUICKSTART.md`を追加し、Android通常Chatで使う初期指示、Intake A:G列、requestId重複確認、曖昧情報をreviewにするルール、queued/pendingとV2反映の区別を明記。`cloud/README.md`からリンク。
- DriveのV2 JSON検索ではschemaVersion 2の最新エクスポートを確認できず（handoffと旧V2 queueのみ）。既知のrevision 2789は2026-11-10のexportであり、これだけでは最新canonicalと断定せずstaging canonical初期化に使わない。
- したがって新しいIntake rowsはFirestore staging queueまで受付可能だが、canonical V2 stateが未初期化、command worker/V2 writesはOFF。通常Chat full text/image-to-row E2E未検証。本番登録運用はまだ開始できない。
- 未処理売却8件・旧V2/queueは未変更。本番移行と旧V2書込みは別途承認が必要。直近のCI v2-ci #844は成功。


### 2026-11-12 JST — staging canonical初期化ガードと運用停止条件

- 空のFirestore staging canonicalへ、検証済みschemaVersion 2 snapshotを一度だけ取り込む専用初期化処理を追加。通常のsaveは従来どおり未初期化canonicalへの書込みを拒否し、初期化処理も既存canonicalがあれば拒否、実行後は全payload/revision/lastMutationIdを読み戻して照合する。
- `cloud/scripts/initialize-staging-snapshot.js`は専用project `project-8ff0bbc4-675d-4596-a8a`と`torecaVaultStaging/canonical`に固定し、schemaVersion 2 envelope・明示revision一致・サイズ上限を検証。synthetic chunked snapshotを含むFirestore Emulator統合テストを追加。GitHub Actions v2-ci #854（commit `c172f1455b68f7d14d807bd69465d8bfd8ea4d92`）は成功。
- 運用判定は引き続き停止。Driveで新しいschemaVersion 2 exportを再検索したが確認できず、手元で確認できるrevision 2789は2026-11-10時点で現在のcanonicalと証明できないため、stagingへもインポートしていない。Cloud Run command worker / V2 writesはOFFのまま。A2の30th CELEBRATIONはqueue pending、ORIGINAL ARTWORK DUEL SETはreviewのまま。
- 次に必要なのは、正本アプリから新たに書き出した最新V2 JSONをCloud Shellへ配置し、revisionを照合した上でstaging専用importerを一度実行すること。その readback が一致するまでworkerを有効化しない。これはstaging snapshotの準備であり、旧V2への書込みや本番切替ではない。


### 2026-11-12 JST — 最新export revision 2924の検証

- ユーザー添付の最新export `toreca-vault-v2-2026-11-12.json`を読み取り検証。app=`toreca-vault`、schemaVersion 2、top/data revision=2924で一致、exportedAt=`2026-11-12T11:23:34.111Z`（20:23 JST）。SHA-256=`286843691c5d741b9d7498e75ddc43570b2d0c99b03c7168c83579acb4f8bf7e`。transactions=97、inventoryLots=32、lotteries=521、marketQuotes=25、auditLog=2944。現在のPR branch `v2/core.js` / `migration-report.js`で構造・schema検証に成功し、Firestore storage planはchunked / 5 segments、上限内。
- read-only duplicate scanで2026-11-06の30th CELEBRATION購入はtransactions/inventoryLotsに見つからず、ORIGINAL ARTWORK DUEL SET表記も見つからない。既存A2 commandはstaging queue pendingのままなので、このsnapshotをstaging canonicalへ入れた後のstaging worker処理候補とする。A3はreview/needs-reviewのまま。
- import CLIのsnapshot validation呼出しを修正。v2-ci #856（commit `00acde974267325a42d61354b1cee39248e97a0d`）成功。
- このChatGPT実行環境のCloud ShellページはSite Unavailableで、GCP provision/deploy connectorもないため、snapshot importやworker有効化は未実施。latest exportはChatGPT workspaceへ添付済みだが、Cloud Shellホームへは未配置。canonicalは前回のhealth確認時点で未初期化、command worker/V2 writesはOFF。実操作はCloud Shellでのimport・readback確認後に限る。旧V2/旧queue/未処理売却には変更なし。


### 2026-11-12 JST — staging canonical初期化成功

- ユーザー実行のstaging importer結果で `ok=true`、target=`project-8ff0bbc4-675d-4596-a8a / torecaVaultStaging/canonical`、sourceRevision=2924、storagePlan=chunked、5 segments、readbackVerified=trueを確認。対象は最新exportであり旧V2には書き込んでいない。
- 新アプリ専用IntakeのA2はrequestId `normalchat:2026-11-06:30th-celebration-arion-yao`、status=queued/accepted。最新snapshotに同日購入が無いため、staging worker有効化後の処理対象とする。A3 ORIGINAL ARTWORK DUEL SETはreview/needs-reviewのままで原価・在庫を処理しない。
- 次はstaging `TV2_ENABLE_WRITES=true` / `TV2_ENABLE_COMMAND_WORKER=true`を設定し、既存scheduler service accountで15分間隔のprivate command worker jobを作成/更新して初回実行する。その後A2のsheet receiptが`v2-applied` / `canonical-readback-verified`になることを確認する。旧V2、旧queue、未処理売却8件、本番切替は対象外。


### 2026-11-12 JST — staging購入1件の処理と最終readback確認

- staging Firestore canonicalは最新のV2 export revision 2924（schemaVersion 2、chunked 5 segments）から初期化済み。対象は専用project `project-8ff0bbc4-675d-4596-a8a` / document `torecaVaultStaging/canonical`。初期化readbackVerified=true。
- staging Cloud Run `toreca-vault-staging`でcommand worker/V2 writesを有効化し、15分間隔のstaging Scheduler経路を実行。購入requestId `normalchat:2026-11-06:30th-celebration-arion-yao` はstatus `done`、`processed=true`、resultCode `v2-applied`、`canonicalReadbackVerified=true`。Intake!A2:G2を再読込し、D=`v2-applied`、E=`canonical-readback-verified`、F=requestIdを確認。
- ORIGINAL ARTWORK DUEL SET（A3）は`review` / `needs-review`を維持。過去支払済みの原価照合が済むまで登録しない。
- stagingにおける専用Intake → Firestore queue → worker → canonical適用 → readback確認の購入1件は完了し、同経路での限定的なstaging運用を開始できる。自然文/画像からIntake行を完全自動生成するE2E、Gmail/OAuth・相場更新・全取引種別、backup/restore、実費の無料枠確認は未検証。アプリ全機能の完成や本番cutoverとは区別する。
- 旧V2本番、旧queue、未処理売却8件、旧Apps Script、本番データ、billing設定は変更なし。本番移行は未実施。


### 2026-11-13 JST — スマホ閲覧UIの分離実装（コード段階）

- **現状の問題**: Cloud Run `toreca-vault-staging` はAPI/workerであり、認証付き `GET /` がHTTP 404になるのは画面ルートがないため。既存サービスで直接IAPを有効にすると、OIDC認証のCloud Scheduler intake/command-workerに影響する可能性がある。
- **設計変更**: 元APIを触らず、別の `toreca-vault-ui-staging` を新設する方針に変更。理由は自動登録の継続性とアクセス権分離。旧方式（APIにIAPとUIを同居）は採用せず、別サービスIAP、最小権限の閲覧専用Firestore SAとする。変更日2026-11-13。
- **実装済（GitHub PR #105ブランチ）**: `cloud/src/dashboard-view.js`（資産サマリー、在庫、抽選予定カレンダー、直近取引のモバイル表示）、`dashboard-auth.js`（Google署名付きIAP JWT/対象audience/許可メール検証）、`dashboard-server.js`（GET/HEADのみ、ステージングFirestore正本の読み取り、キャッシュ禁止/CSP）、`cloud/Dockerfile.dashboard`（非root起動）、`cloud/test/dashboard.test.js`、専用Cloud Shellデプロイスクリプト、`docs/STAGING_DASHBOARD_ROLLOUT.md`。
- **安全措置**: 署名なしのIAP identityヘッダーを信頼しない。IAP未設定で画面を見せない。APIトークンをブラウザへ露出しない。対象は専用projectと `torecaVaultStaging/canonical` に限定、旧V2/元Cloud RunのAPI/worker、売却8件、既存Sheet queueを変更しない。
- **テスト**: 新画面・署名IAP拒否/許可・文字列エスケープ・書込み拒否をテスト追加。GitHub Actions v2-ci #867はコードテストとFirestore Emulatorの両方が成功。後続のnon-root化、Cloud Shell環境変数明示、スクロール修正後のCIは別途確認。
- **未実施**: Cloud Shellからの別サービスdeploy、IAP有効化とWeb App User権限設定、実機でGoogleログイン→在庫/資産/予定の表示確認、実費検証。コード実装と実運用開始を混同しない。元APIにIAPはまだ設定しない。
- **次工程**: 新サービスだけをCloud Shellからデプロイ→UIサービスのIAPとアクセス許可設定→スマホ表示テスト→元のScheduler/command-worker動作確認。GitHub PR #105はDraft/openのまま、本番移行や旧V2への書込みは対象外。


### 2026-11-13 JST — スマホでの閲覧画面/IAP動作確認

- ユーザー提供スクリーンショットから、専用 Cloud Run サービス `toreca-vault-ui-staging` のモバイル画面に Google アカウントのIAP認証を通ってアクセスできたことを確認。初回は `You don't have access` が表示されたが、再度開いた画面で閲覧成功。403解消理由の断定は避ける。
- 画面に `STAGING · 閲覧専用`、`資産ダッシュボード`、`V2 revision 2926`、資産・在庫評価カード、在庫一覧、下部ナビ（資産/在庫/予定/履歴）を確認。個別の金額、商品名、メールアドレスは公開リポジトリの記録に転記しない。
- **検証済み**: スマホ実機からIAPを経由して閲覧専用ダッシュボードの初期画面を表示し、staging Firestore snapshotを基に集計表示。
- **未検証**: カレンダー/履歴への実際の画面遷移、データの新鮮性・金額照合、全取引種別と通常Chatの登録、Gmail実接続、バックアップ復旧、本番移行。旧V2本番に関する完了とは区別する。
- 元のCloud Run `toreca-vault-staging` のIAP設定には触れず、閲覧画面だけを別サービスとして維持する。追加の変更やデプロイはなし。


### 2026-11-13 JST — モバイル予定カレンダー表示の実機確認

- ユーザーから提供された新しい `toreca-vault-ui-staging` のスマホスクリーンショットで、閲覧専用の予定カレンダー画面を確認した。
- 2026年11月の月間グリッド、当日強調表示、日付ごとの予定件数、下部の予定一覧（応募締切・商品・店舗）、前月/翌月ボタンの存在を確認。
- **検証済み**: モバイルブラウザで「予定」位置まで移動して、Firestore staging snapshot に由来する予定を表示できる。
- **未検証**: 前月/翌月ボタンの実操作、日付タップによる個別予定の絞り込み（現状の実装には未搭載）、履歴タブ実画面、全データの正確性/鮮度。カレンダー表示は旧V2本番やGmail運用の完了を意味しない。
- **今後のUI改善候補**: 日付選択で当日の予定へジャンプ、直近の応募締切/結果発表を優先表示。機能改善は現時点では未実装。


### 2026-11-13 JST — 売却履歴の全件表示フィルターを追加

- ユーザー実機スクリーンショットで、`履歴` 画面が時系列の「直近12件」に限定され、直近の購入が多いと売却が見えない問題を確認。保存済みの売却データが削除されたことを意味しない。
- **旧仕様**: 全取引を日付順に混ぜて上位12件のみ表示。**新仕様**: 「すべて」「購入」「売却」「開封」のGETクエリによる切替。「すべて」は直近12件の概要、各種別では当該種別の全件を表示。変更理由: 古い売却履歴が見つからない問題を防ぐ。変更日: 2026-11-13。
- **実装済み（PR #105作業ブランチ）**: `cloud/src/dashboard-view.js` に履歴フィルターと売却ごとの利益（売却金額×数量−手数料−確定取得原価）を追加。`cloud/src/dashboard-server.js` で `type` パラメータを読み取り、既知種別以外は「すべて」へフォールバック。画面はサーバ側HTMLでGETのみ、IAP/閲覧専用権限は維持。
- **テスト済み**: 古い売却レコードが通常の直近12件に埋もれても「売却」タブでは表示されること、種別外の取引を表示しないこと、表示文字列がHTMLエスケープされること、原価の有無と利益表示、認証付きGETの表示を検証。GitHub Actions v2-ci #875 のコードとEmulatorジョブは成功。開発側の合成データに対する描画チェックも成功。
- **未反映/未検証**: 現在のCloud Run `toreca-vault-ui-staging` にはまだ新しいコードを再デプロイしていない。Googleログイン/IAP維持と実機画面から「売却」タブの全件表示を確認する必要あり。
- **次工程**: Cloud Shellで既存 `~/tv-ui-staging` のブランチを `git pull --ff-only` で更新し、`cloud/scripts/deploy-dashboard-staging.sh` で画面専用サービスだけ再デプロイ。元API、旧V2、旧キュー、未処理売却には触れない。再デプロイ後にGoogleログインで売却履歴を確認する。


### 2026-11-13 — 未処理売却8件の重複防止付き照合

- 通常Chatでユーザーが「二重登録だけ避けてあとは登録して」と明示的に依頼。原本キューの再投入をしないこと、同一売却の二重減算・二重利益計上を防ぐことが最優先。
- Google Sheets「Toreca Vault V2 Command Queue」の `Queue!A1:H10` を読み取り専用で確認。旧売却8行（3〜10行）の `status=pending`、`attempts=0`、`processedAt` は空白。別の抽選キュー1行が先頭にある。8件を新しい requestId で再送しない。
- Google Sheets「Toreca Vault New App Intake」の `Intake!A1:G6` を確認。旧売却8件はこの新App受付行にはなく、既存の別の報告だけが存在。ユーザーが指定した売却4件は2026-11-12の旧V2 export（revision 2924）の `transactions` に存在し、新たに書き込まない。
- revision 2924 の旧正本JSONを読み取り専用で照合した結果、8件のうち、商品名・condition・数量が一致する当時の在庫lotがあるのは、10/25の2個セット、11/1のMEGAドリームex、11/1のメガシンフォニア。残り（11/1の9種セット1件、スターターセット3件、30th BOX1件）は、元の売却と同日までの時系列で単純処理すると在庫lotが一致せず、原価/商品名/既払照合の修復が必要。10/25の2個セットは過去の割引反映前のunitCostとの差があるため、正しい原価での利益計上を先に確定する必要あり。
- **未実施**: 旧キューからの処理、Firestore stagingへの転送・販売適用、旧キューの状態変更、既存在庫や原価の変更、旧V2正本変更。ChatセッションからCloud Run/Firestoreの認証済み書込みツールがなく、現在のstaging revision 2926を直接transaction ID/lot毎にreadbackする手段もないため、現時点で書込みを伴う重複防止確認を完了できない。
- **次工程（Work/Cloud Shell）**: staging最新snapshotを read-only 検証 → 現行のtransaction / auditLog / queue / lot単位で8個の旧`requestId`を照合 → 補正が必要な在庫・割引原価を確認 → 原本のrequestIdをそのまま利用して、在庫が足りていて旧V2にも未反映のものだけを一度実行 → 1件ごとにcanonical readback・revision・残在庫・利益・キュー処理結果を照合。旧キューと新App intakeの二重消化は禁止。未確認の5件はレビューのまま。通常Chatによる金額報告と照合記録は新アプリへの適用完了を意味しない。


### 2026-11-13 — 売却登録は「記録＋在庫減算」を優先する

- 通常Chatでユーザーは売却済み商品の在庫減算を最優先と明示。過度な原価照合によって売却事実そのものの記録を止めないこと。
- **旧方針**: 原価・名称・lotの完全一致が未解決なら売却履歴全体の登録を延期。**新方針**: 売却済みである事実・売却額・数量を登録し、既存在庫は商品別に残数を超えない範囲で一度だけ減算する。原価が不明なら利益のみ「原価未確認」とし、売却記録の受付まで止めない。変更理由: ユーザーが日常運用で必要とするのは、報告済み売却の即時履歴化と在庫数量の整合であるため。変更日: 2026-11-13。
- **重複防止**: 既存の旧キューrequestIdを再利用し、新規requestIdを採番しない。既登録済みの売却は二重作成・二重減算しない。再実行時も同一キーはno-op。
- **不足在庫**: 該当する在庫が0点ならマイナス在庫を作らない。売却の事実は記録し、「在庫照合待ち/原価未確定」の管理対象に分ける。旧queueと新app queueの並行二重実行をしない。
- **状況**: 方針変更の記録のみ。本件でFirestore正本・キュー・在庫の更新を実行した事実はない。実装・実データへの反映は未完了。公開GitHubリポジトリへ顧客固有の売却明細を転載しない。


### 2026-11-13 — 原価不明・在庫不明時の売却処理ルール

- **確定指示（通常Chat）**: 売却時の購入原価が不明なら、まずメーカー・販売元などの公式情報で当該商品の**定価（税込）**を調べる。商品名・セット内容・販売単位が一致する公式根拠を確認し、参照元と金額を残す。
- ユーザー報告の実際の購入原価・割引後の実支払額が分かる場合はそれを優先し、公式定価は不明時の**代用原価**として扱う。「実購入価格が確認済み」と偽らず、`costBasis=official_list_price_proxy` 等の区別と公式参照URL・確認日を保持する。公式価格が確認できない／商品同定が曖昧な場合はユーザーに確認する。
- 売却対象に対応する在庫lotが**見つからない場合、数量不足の場合、商品の同一性が曖昧な場合**は、その商品についてユーザーに相談し、回答まで減算・新規在庫作成・売却の正本確定をしない。マイナス在庫も作らない。
- 売却の二重登録防止は継続。既存の旧キュー8件の`requestId`を新規採番せず、既存記録と照合して未登録分だけ一度処理する。すでに記録済みの4件には触れない。
- **旧方針から変更**: 「在庫が見つからなくても売却履歴だけは先に確定」としていた直前案を取り消し、在庫未発見の場合はユーザーに相談してから処理する。変更理由: 2026-11-13のユーザー明示指示。
- **実装区分**: ここでは運用ルールの文書更新のみ。Cloud Run/Firestoreの実データ・原価・売却履歴・旧キューの変更はしていない。原価代用の自動判定・UI表示分離は設計・実装検証が必要。


### 2026-11-13 — 売却8件の公式定価確認と在庫照合（書込前）

- 通常Chatにてユーザーから「在庫減算、売却登録して」と明示指示。**現時点ではFirestoreへの書込みが可能な認証済みアクションを通常Chatから呼び出せないため、未実行**。完了と偽らない。
- 接続済みGoogle Sheetsを再確認: 旧V2 Command Queueの売却8行は2026-11-13時点で全件`pending`、`attempts=0`。新App Intakeにはこの8件の重複入力はない。再投入・状態変更は未実施。
- 2026-11-12 旧V2 export rev2924の在庫照合: 10/25のカードセット9種×2、11/1のMEGAドリームex×1、メガシンフォニア×1は商品/数量一致。在庫内には11/1のカードセット9種×1に相当する表記揺れの別lotも複数あるが販売元の特定ができない。一方、11/1のスターターセットex 3種×各1と30th CELEBRATIONシュリンクあり1BOXのlotが見つからない。これらの状態は最新Firestore rev2926の照合ではない。
- ポケモンカードゲーム公式で確認した税込定価（**実購入価格でなく代用**）: スターターセットex イーブイex、ゾロア＆ゾロアークex、ニャオハ＆マスカーニャex = 各1,800円（`https://www.pokemon-card.com/ex/me/`）。30th CELEBRATION 1BOX = 7,200円（`https://www.pokemoncenter-online.com/news/?id=20260803`）。
- 実装済コードは`applyChatCommand`の`sale`で既存lotの完全正規化文字列一致を必要とし、対応lotがない場合は`sale inventory was not found`として売却も減算も拒否する。表記揺れを勝手に空在庫扱いせず、商品同定の修正と最新正本照合を先に実施。
- **要確認（ユーザーへ相談）**: 最新正本でも上記4商品の在庫がなければ既登録済かどうかをユーザーに確認。カードセット9種の11/1売却をどのlotから差し引くかは、同一商品・同一条件の複数lotと10/25売却の差引後残数を照合して決定。原価不明のみ公式代用。重複回避のため旧requestIdを維持。
- **次工程**: 認証可能なCloud Shell/Work実行環境で、最新Firestore正本のread-only transaction, lot, audit確認→未登録かつ在庫一致のものを既存IDで1件ずつ適用→canonical readback→旧queue/新App intakeの二重処理を防ぐステータス整合。旧V2本番と元のAPIを変更しない。


### 2026-11-13 — 30th BOX購入漏れの根拠確認

- ユーザーから「スターターセットは登録してなかった」「30th CELEBRATIONはカードボックス日本橋で購入歴なかったかな？」との訂正・確認あり。
- 接続先の正本ドキュメント「Toreca Vault Handoff (CURRENT)」を再読。2026-10-16にカードボックス日本橋で30th CELEBRATION拡張パック1BOXを商品原価7,200円で購入したとのユーザー報告が記載済み。これは9種カードセットではなく拡張BOXで、11/1のアリウム売却の原価参照対象。同一取引の売却金額は19,500円、原価差額12,300円（別費用がなければ）。
- 11/12 export rev2924の`transactions` には、該当日付・該当店舗の同商品の購入レコードは確認できず、対応する`inventoryLots`も見当たらない。ユーザーの購入事実と既存正本の登録済み事実を区別する。旧キューには売却処理が`pending`で残っている。
- **方針**: 最新stagingでも未登録と確認できるなら、10/16購入の記録と在庫を正しく復元したうえで、既存の11/1売却requestIdを使用して1点減算する。購入→売却の2段階を同じ業務として検証し、処理後に余分な在庫1点が残らないことを確認。すでに購入・売却が記録済みなら重複作成しない。
- スターターセットex3種類は、ユーザーによれば過去の在庫登録をしていなかった。旧在庫からの単純減算はできない。取得日・購入店舗が不明な購入レコードを捏造しない。公式定価が確認できている場合は実原価と区別した代用として扱い、買付履歴の未確認部分は明示する。
- **実行状況**: 根拠資料の照合と方針記録のみ完了。Firestore正本への購入復元・売却登録・在庫減算・旧キュー状態変更は実行していない。ユーザーの過去の購入報告を再質問しない。


### 2026-11-13 — X買取相場の3店舗・画像識別仕様を確定

- **決定事項**: 参考買取相場の監視対象をXの「買取ミミ」「カードショップアリウム」「トレカショップKURO」の公式投稿に定める。真正なアカウントIDは未照合であり、ハンドルを推測登録しない。
- **旧仕様**: 相場取得先未設定の抽象的なmarket-refreshバッチ処理のみ。**新仕様**: 投稿本文・画像OCR・パッケージ視覚判定を統合し、公式商品デザイン（BOX・パック・色・ロゴ・主要キャラクター・商品形状）と照合する。30th CELEBRATIONのBOXと9種セット等の類似商品の取り違え、価格札の誤割当、状態違いを防ぐ。**変更理由**: ユーザーからの2026-11-13明示指示。
- **自動採用条件**: 一次投稿・店舗ID・投稿日時・公式商品ID・単位・状態・買取金額・証拠の整合性と鮮度が揃う場合のみ。曖昧・画像不明瞭・矛盾・旧投稿等はreview。商品の参考買取価格を売却成約額や購入原価へ転用しない。
- **運用**: 既存の毎日13:45 JSTのmarket-refresh予定へ統合。ただしXの自動取得は規約準拠のAPI等の許可経路が前提であり、非APIの自動スクレイピングはしない。自動取得が無理ならX投稿URL/スクリーンショットの手動取込みから導入。失敗時は前回の根拠ある相場をstaleとして保持。
- **仕様正本**: [docs/X_BUYBACK_QUOTES_SPEC.md](X_BUYBACK_QUOTES_SPEC.md)。データ項目・UI・商品マスタ・画像評価・レビュー条件・導入段階・受け入れテストを含む。
- **状態区分**: 文書設計を確定。**X API接続、画像OCR・視覚解析、3店舗の自動相場取得、実際のCloud Run反映は未実装／未検証**。市場参考価格が更新されたと誤認させない。公開GitHubリポジトリに個人の在庫や売却額を掲載しない。


### 2026-11-14 JST — 買取ミミ画像からの買取価格読取ルールを具体化

- **情報源**: ユーザー指定のXアカウント候補 `https://x.com/mimi_kaitori` と提供した買取表2画像。ポケカは画像内「11月13日12:00更新」、ONE PIECEは「11月12日12:00更新」。個別の元ポストURL・投稿ID・真正性と適用時点は未照合。画像そのものは公開GitHubへ置かない。
- **旧仕様**: X文章／OCR／商品画像から商品・価格・状態を照合する汎用ルールのみで、買取ミミの画像内の2段表示の意味は未定義。
- **新仕様**: ポケカBOXは**赤い上段＝シュリンクあり1BOX、青い下段＝シュリンクなし1BOX**。赤のみ・下段「-」は青価格を作らない。青欄の「段ボール未開封」は価格ではなく特殊条件注記（必要ならレビュー）。ONE PIECEは**テープ付きのみ**、**赤い上段＝1BOX、青い下段＝1カートン/ケース**。ケース総額をBOX単価に換算しない。商品パッケージと金額は画像の枠・行列位置で対応させ、公式商品マスタと照合し、不明ならreview。
- **変更理由**: 同じ赤／青の2段レイアウトでも、ゲームごとに「状態差」と「販売単位差」で意味が全く異なるため。誤った資産評価の防止。
- **記録した参考例**: ONE PIECEの左上画像枠は赤33,000円/BOXと青402,000円/ケース。ポケカ左上の赤13,500円に対する青欄は「段ボール未開封」という注記（価格扱いしない）。商品ID未同定のため現行相場として未登録。
- **設計済・未実装**: `docs/X_BUYBACK_QUOTES_SPEC.md` v1.1にレイアウト、例外、保存属性と受け入れテストを追加。X API、OCR/画像認識、Firestore相場登録、Cloud Runデプロイ、正本の価格更新はこの変更では行わない。既存売却8件、在庫、購入原価、旧キューへ変更なし。
- **次工程**: 買取ミミの元投稿リンク確認、公式商品画像マスタ作成、提供画像を非公開テストデータで検証、画像抽出コードの実装、review判定、他2店舗の店舗固有レイアウト追加。


### 2026-11-14 JST — カードショップアリウム買取表の画像読取とピックアップ更新規則

- ユーザー指定のXアカウント候補 `https://x.com/cardshop_allium` と11/13表示の「未開封BOX買取表」「数量限定高価買取」画像を確認。元投稿URL／postId／最新時点での受付可否は未検証。
- **旧仕様**: 買取ミミなどの一般的な画像識別のみ。**新仕様**: アリウムのポケカでは上段の水色＝シュリンクあり1BOX、下段の黒＝シュリンクなし1BOX。ハイフンや空欄は価格未掲載。通常表と数量限定ピックアップ表の両方を同じ凡例で読む。商品画像と上下価格欄は位置＋公式商品デザインで結びつける。
- **相場の優先順位**: 同一商品・同一条件は、投稿の更新日時・数量制限・失効/規定数終了の告知を照合して取得時点の**最新有効価格**を選ぶ。単に高い方・過去最高額を採らない。数量枠の継続が未確認のピックアップは条件付き/未確認表示であり、確定資産評価へ無条件転用しない。通常表も同日限りの注記を尊重し、失効後に最新と偽って復活させない。異なる出典・値段は履歴として保存する。
- **変更理由**: ピックアップ高価買取と通常買取が併記されるため、価格更新と終了条件を無視すると虚偽の相場・資産評価になる。
- **資料更新**: `docs/X_BUYBACK_QUOTES_SPEC.md` v1.2 に専用ルール/受け入れテストを記録。実装・Firestore反映・Cloud Runへのデプロイ・売却8件の処理は今回未実施。今後はX一次ポスト照合、公式マスタ、画像抽出、最新有効価格ロジック、終了通知テストを実装する。


### 2026-11-14 JST — 通常Chatの抽選報告時に公式商品マスタを照合する確定ルール

- **新指示:** 通常Chatでトレカの抽選応募・応募完了・当選/落選などを、文章またはスクリーンショットで報告された場合、**メーカー・販売元・権利元の公式商品ページ／公式商品画像**をその時点で確認し、正式商品名と商品ID、パッケージ画像の特徴、発売商品タイプ、**公式税込定価**を照合する。抽選店舗の画像・略称・抽選ページの表示だけを根拠に曖昧な商品を別商品と混同しない。
- **照合項目:** (1) 正式名称・略称・シリーズ/型番、(2) BOX/パック/カートン/限定セット/カードセット、セット内容・数量などの販売単位、(3) 公式画像に基づく外箱/パックの色・ロゴ・主要キャラクター・構図と商品形状、(4) 定価（税込円、何単位当たりか）・公式参照URL・確認日、(5) 抽選先・申込数量・状態（シュリンクなし/テープ付きなど）・応募締切/発表日/受取条件（根拠にある場合だけ）。
- **判定:** 画像のOCR＋視覚的特徴＋公式画像を突き合わせ、複数候補・旧パッケージ・類似シリーズ・単位違い・定価の根拠不足なら `productMatchStatus=review` とし、無理に確定しない。公式商品画像の転載は前提にせず出典URLと識別特徴を保持。公式の値段が見つからない場合は `officialMsrpYen=null` / `msrpStatus=unverified` とし、買取価格やショップ販売価格を定価の代用にしない。
- **状態の区別:** スクリーンショットが応募完了を示すなら `lottery=applied` の根拠とするが、応募画面の閲覧だけなら完了扱いしない。当選/落選は独立のステータス更新。**応募/当選だけでは購入・在庫・購入原価を計上しない**。決済/購入/受取を別途確認して、そこで初めて購入履歴・在庫処理の対象とする。定価は**参考値**であり、実購入額が確認できない場合にも自動的に実際の支払原価として確定させない。
- **重複防止:** 同一店舗・同一抽選企画・同一商品/応募識別子に対して、報告の再送/メール結果が来ても同一抽選を二重登録しない。商品マスタは抽選、購入、在庫、売却、X参考買取相場で共通の安定 `productId` を使用する。
- **旧仕様→新仕様/理由:** 旧仕様は自然文・画像の抽選報告を型付きcommandへ変換する方針のみ。新仕様では**チャット報告ごとの公式商品デザイン＋正式名称＋税込定価の積極的な確認**を必須の識別工程に追加。理由は写真/略称だけで誤認すると抽選、将来の購入原価、買取相場が別商品へ結びつくため。
- **実装区分:** 2026-11-14に**運用ルールと設計を確定し文書化**。この変更のみで、通常Chat→新アプリへの抽選データ自動登録、OCR/画像同定の自動化、公式商品マスタ同期、Firestore書込み、実データreadbackが完了したわけではない。通常Chatに認証済み書込経路がない場合は、チャット上で整理/照合したことと「登録済」を区別して報告する。
- **受け入れテスト:** 同名別セット/BOXを公式画像で区別、税込定価に単位を保持、未確認定価に架空値を入れない、応募完了画像を応募として扱い購入/在庫にしない、当選メールによる重複応募を作らない、公式画像/販売情報と応募店舗の販売条件を混同しない。


### 2026-11-14 JST — Chat/Workの引き継ぎ共通化とアプリからの最新版ダウンロード（コード追加）

- **ユーザー希望**: 日常の抽選/購入/受取/売却等は通常Chat、アプリの開発・修正・運用障害はWorkへ分担。スレッドが上限になっても、双方が同じ引き継ぎを参照し、アプリから最新版をダウンロードして新スレッドへ持ち込めるようにする。
- **旧構成→新構成**: 従来のCloud Run閲覧画面には引き継ぎへの導線なし。新コードでは閲覧専用ダッシュボードに「引継ぎ」メニュー/カード、「最新版を開く」「引き継ぎをダウンロード (.txt)」を追加。共通正本は既存の非公開Google Doc「Toreca Vault Handoff (CURRENT)」。リンクをクリックするたびGoogle Docsのその時点の内容を参照/エクスポートし、別コピーの定期同期を不要にする。
- **技術/権限**: `TV2_HANDOVER_DOC_ID` で参照先を設定（ステージング用deploy scriptに既存Doc IDのデフォルトを設定）。Google Docs自体のアクセス権を保持し、IAPで保護されたHTMLに内容を複製しない。Google Docs閲覧権限を持つGoogleアカウントでのアクセスが必要。Firestoreや旧V2の個人データを公開GitHubへ転載しない。Cloud Run UI側の書込み権限は不要で、元API・workerは変更しない。
- **運用ルール**: 通常ChatとWorkの重要な決定/最新状況は共通Google Docに実際に追記してから「引き継ぎ更新済み」と報告。技術の変更はGitHubドキュメントにも反映し、Google Docに参照/検証状況を残す。自動登録や履歴処理は別の機能であり、文書ダウンロードができてもデータのアプリ反映済みを意味しない。
- **作業状況**: PR #105ブランチの `dashboard-view.js`、`dashboard-server.js`、`deploy-dashboard-staging.sh` に機能追加、`dashboard.test.js` にリンクID検証とIAP保護のテストを追加。**GitHubへのコード反映まで。Cloud Runの再デプロイ/実機ダウンロード検証は未実施**。Google Docを更新した場合、外部リンクを開いた時に最新内容が取れる方式であり、アプリ内に編集時刻や本文が自動表示される訳ではない。
- **変更理由**: ChatとWorkの作業領域を分けつつ、人手で.mdファイルをコピーし直す負担と二重正本の不整合を減らすため。ユーザー情報を公開ソースへ置かないことを優先。


### 2026-11-14 JST — 通常Chat日常報告の受付基盤改善（CI成功、未デプロイ）

- **依頼**: 通常Chatに抽選・購入・受取・開封・売却を報告するだけで新アプリに実反映できる段階まで進める。Chatは報告用、Workは開発/運用用。共通Google Docsを正本にする。
- **再利用する仕組み**: 接続済み `Toreca Vault New App Intake` → Firestore command queue → Cloud Run command worker → staging canonical readback → SheetのD:G receipt。既存経路に新しい第二のキューを作らない。通常Chatは接続済みGoogle Sheets編集アクションが利用可能な場合だけ、既存行との重複照合後、新規行A:Dへ`new`を追加する。受付とFirestore適用は別ステータス。
- **実測確認**: 2026-11-14 JST、専用Google Sheetsの購入1行は`v2-applied / canonical-readback-verified`、他に`queued`や`new`の行があり、現行本番として全件処理済みではない。受付workerの実稼働・Scheduler・Sheets権限はCloud Shell/Workから要検証。旧売却8件は再投入禁止。
- **修正**: `cloud/src/google-sheets-intake.js` / `google-sheets-intake-provider.js` のreview・業務重複receiptの比較対象を原本sourceRequestIdへ修正（acceptedRequestIdが空または別IDでもD:Gを正しく書ける）。A:Cの入力原本と既存requestIdは不変。
- **抽選の改善**: 応募完了の明示Chat報告・スクリーンショットで`status=応募済`、`evidenceType=chat-report|screenshot`、`title/store/owner/applicationDate`が揃う場合に限り、外部応募番号なしでも専用の内部指紋で受付できる。これは発行元の応募IDの代用・捏造ではない。同一応募と考えられる別IDの再申込を正本側でreviewに止める。確証のない応募、結果・受取の曖昧さはreview継続。
- **商品の保存**: `cloud/src/v2-command.js` の抽選レコードに商品/商品ID、申込数/単位/シュリンク条件、応募表示価格、メーカー税込定価/公式URL/確認日、支払ステータスを加えた。抽選だけでは購入/在庫/実原価を増やさない。
- **手順**: `docs/CHAT_DAILY_REPORTING_RUNBOOK.md` に通常Chat側の操作ルールを記録。公式商品ページ・パッケージ・定価の照合、Sheet照合、重複回避、状態報告、確認待ちの扱いを明示。通常Chatからの自動writeはこの文書を共有するだけでは起動せず、実際のコネクタ呼び出しが必要。
- **検証**: GitHub Actions [v2-ci #43527682483](https://github.com/manato-maker/toreca-vault/actions/runs/43527682483) が`test`および`firestore-emulator`ともにsuccess。receiptの空ID/別ID、確定済みスクリーンショット、重複報告、未確定・日付不正報告、抽選原価非計上のテストを追加。
- **未完了**: `toreca-vault-staging`への改修デプロイ、15分間隔のprivate Sheets intake workerの最新稼働確認、新Chatの報告→Sheet追加→Queue→canonical→スマホ画面の実E2E、外部応募IDが無い結果・受取の取り扱い。GCPの認証付き操作経路がこのチャットにないため、Firestore実データ、旧キュー、旧売却8件、staging UIは変更していない。
- **次工程**: Work/Cloud Shellで既存環境設定を読み取り、デプロイ前後の構成比較→APIだけ更新→Intake Scheduler/IAM/Sheets accessを安全に検証→既存`new`の重複/状態を確認→新規の実報告1件でE2E readback。必要な所有者操作があれば権限確認を求める。旧V2本番/IAPを変更しない。


### 2026-11-14 JST — 無料枠優先監査とCloud Run UI低コスト設定

- **ユーザーの「無料枠内でいける？ → すすめて」への対応**：通常Chat報告機能の継続開発は月額0円を目標にし、課金や既存IAP/Workerを勝手に変更しない。Google Cloud公式料金を再確認し、請求実績/設定を見ないで「無料確定」とは断言しない。
- **旧→新**：`cloud/scripts/deploy-dashboard-staging.sh` はUIのmin0/max1/CPU1/RAM512MiBは既存。新たに`--cpu-throttling --concurrency=40 --timeout=30s`を明示してリクエストベースの課金設定を維持する（コード変更のみ、Cloud Run未適用）。
- **追加した監査ツール**：`cloud/scripts/audit-free-tier-staging.py`。Google Cloud Shellで `python3 cloud/scripts/audit-free-tier-staging.py`を実行すると、固定stagingプロジェクト番号を検証後、Cloud Run UI/APIのmin/max/CPU課金方式、Firestoreデータベース一覧、Schedulerの東京リージョンジョブ数、billing有効状況を**読み取り専用**で点検する。権限/情報不足はUNVERIFIED扱い。アカウントIDや認証情報は出力しない。GCPの書込みなし。
- **無料枠の落とし穴**：Scheduler無料3ジョブは同一billing account全体（pauseも数える）。Firestoreはeligibleなデータベース1個のみ。Cloud Runの無料CPU/RAM/リクエスト枠やArtifact Registryの保存容量はbilling account単位。Cloud Build・保存容量・ネットワーク・バックアップも実請求確認。予算通知だけで支出は停止しない。有料X APIや画像AIの定期実行は費用確認まで保留。
- **詳細**：`docs/FREE_TIER_STAGING_COST_PLAN.md`を追加。旧売却8件・旧キュー・Firestore正本・UI本番設定には変更なし。
- **未完了**：Cloud Shellで実監査/当月請求確認、API/Worker/Service Account/Schedulerの実稼働点検、staging再デプロイと通常ChatからのE2E readback。低コスト設定と運用開始は別の検証項目。


### 2026-11-14 JST — 通常Chat報告の完成に向けた通しテストとstaging段階的リリース準備

- **依頼**: 「完成形まですすめて」。ユーザー体験は普段の通常Chatで自然文/スクショによる抽選・購入・受取・開封・売却の報告、Workはシステム開発・不具合修正、スマホUIで資産/在庫/履歴/カレンダー閲覧、共通Google Docsでスレッドを引き継ぐ形。無断の本番移行・旧V2書込み・課金拡大はしない。
- **新規テスト**: `cloud/test/chat-intake-e2e.test.js` が、通常Chatで構造化された報告→専用Intake→durable queue→worker→Firestore state CAS/readback→Sheet最終receiptの一連の処理を、購入/抽選/要確認の3パターンで模擬検証。購入の在庫1LOTのみ増、応募だけなら在庫と実支払原価は不変、未確定情報はreviewのみ。実クラウドにテストデータは書かない。
- **新規読み取り専用事前確認**: `cloud/scripts/preflight-chat-staging.js` は認証済みstaging canonicalの存在とスキーマ・rev、専用Google SheetsのメタデータとD:G処理状態を件数のみ検証。内部データやトークンは出力しない。専用Sheet IDは環境から受け取り公開ソースへ直書きしない。テストは外部SDK不要なモックで実施。
- **段階的staging APIリリース**: `cloud/scripts/release-chat-staging.sh` は`check`（読み取り専用でプロジェクト番号・canonical/Intake/OIDC/非公開IAM確認）、`stage`（フルtest/check後にタグ付き候補を0%トラフィックで配置、既存環境変数/secret/IAMを上書きしない）、`promote`（明示的なレビューフラグとstaging読み取り専用事前確認の後、候補revだけ100%へ切替）を提供。Google Cloud Shellの認証が必要。**このチャットでは実行不可、今回Cloud Run上の新revisionは作成していない**。
- **互換性修正**: 既存Intakeの抽選結果/受取行は`businessEventIdentityJson`へ`kind`を含むことがある。受付parserは`kind`がコマンドtypeから導いたapplication/result/receiptと完全一致する場合だけ許容し、不一致ならreviewにする。既存の`new`行を勝手に修正/再投入しない。
- **セキュリティ・費用**: GitHubリポジトリは公開。Google Sheets生ID・tokenや個人の取引記録を新規コードに埋め込まない方針に修正（過去コミット履歴の書換は未実施）。Cloud Run staging UIのmin0/max1、request-based運用。Cloud Build/Artifact Registryの費用はリリース時に監査。旧売却8件と旧Queue・本番V2・Firestore正本のデータは変更なし。
- **手順正本**: `docs/CHAT_STAGING_RELEASE_RUNBOOK.md`にWork/Cloud Shell実環境リリースと最終Chat→Intake→canonical→UI E2E、失敗時の切り分け・旧V2保護のルールを記録。
- **未完了**: GCP請求と権限の実監査、Cloud Run API/UIへ今回の変更をデプロイ、OIDC/Scheduler実起動の確認、通常Chatから未登録の実報告を投入したcanonical読戻しとスマホ表示検証、Gmail実OAuth・X画像相場の実取得・バックアップ復元ドリル・旧売却未処理の安全な処理。CI成功≠実運用完成。PR #105は引き続きdraft/open。


### 2026-11-14 JST — Driveの旧JSONはV2正本ではない

- 非公開Driveフォルダ「Toreca Vault Private」内の `toreca-vault-data.json` を読み取り専用で確認。ファイル更新は2026-10-05で、トップレベル`schemaVersion=1`、内部データもV1形式。`data`の集計はlotteries 285、purchases 37、boxes 6、packs 0、cards 13、openings 2、sales 27（内容・個人情報はGitHubに転載しない）。
- **重要**：これは現在のV2 schemaVersion 2の正本を証明するものではない。2026-10-05以降の記録が欠ける可能性が高いため、これを最新canonicalとしてFirestoreにインポートしてはならない。V2正本のApps Script `TV_V2_DATA_FILE_ID` の実設定、現在のV2 JSONのschemaVersion/revision/hash/更新日を認証付き環境で照合する。
- 今回の調査ではDrive上の最新V2 JSON正本は未確定。既存canonical・旧Queue・在庫・売却は変更していない。V1→V2変換も実行しない。


### 2026-11-14 JST — Intakeの再試行・最終結果保護とキュー照合の強化

- **旧問題**：Firestoreキューへのenqueueが成功した後にGoogle Sheets D:Gのreceipt更新だけ失敗すると、同じrequestIdによる次のenqueueは`accepted=true, duplicate=true`を返し、旧Intake processorはSheet行を終端の`duplicate/request-duplicate`にしてしまう可能性があった。Queueは実際にはまだ`pending`でも、通常Chatに誤解を招き、以後のreadback運用を不安定にする。
- **修正**：`cloud/src/google-sheets-intake.js` は同じrequestIdの既存受付を`queued/accepted`のまま保持し、独立した業務事実の重複（`businessDuplicate`）だけを`duplicate/business-duplicate`と扱う。既存処理中のものを完了と誤報しない。
- **旧問題**：古いScheduler実行が後からD:Gを上書きすると、確定済の`v2-applied/canonical-readback-verified`等を`queued`へ戻せる可能性があった。
- **修正**：`cloud/src/google-sheets-intake-provider.js` がA列のsourceRequestIdに加え現在のD列statusを読み、`new → queued/review/duplicate`、`queued → v2-applied/review/duplicate`以外の状態遷移を拒否する。既に同一の最終結果が書込済みなら、D:Gを改めて読み戻して完全一致を確認した場合のみノーオペレーション成功。食い違いは改変せずエラー。
- **旧問題**：別のIntake行/Chat APIで同じrequestIdとcommand JSONが偶然使われていても、Firestore queueは単純に受理済みduplicateと返し、後から来た受付シート行に紐付くreceiptがないため永遠にqueuedになりえた。
- **修正**：`cloud/src/firestore-command-queue.js` は既存queue recordの`intakeReceipt.spreadsheetIdHash/rowNumber`が今回のIntake行と一致する場合に限り同じrequestIdをリトライ可能とする。別Sheet/別行/元APIからの受付は`collision`として停止し、どの正本/行を上書きもしない。
- **テスト**：`cloud/test/google-sheets-intake.test.js`、`google-sheets-intake-provider.test.js`、`firestore-command-queue.test.js` に再実行・最終結果保護・衝突・安全なリトライの回帰テストを追加。CI v2-ci #43559680508（test + Firestore Emulator）ともにsuccess。
- **変更範囲**：GitHub PR #105作業ブランチのみ。実staging Worker/Sheet/Firestore正本/旧V2データ/旧Queueには変更なし。Sheets APIは複数Scheduler実行間で完全なatomic CASではないので、単一定期ジョブ運用とFirestore側の冪等性も必須。
- **残り**：認証済みGoogle Cloudで費用・Cloud Run・Scheduler・IAM・staging canonicalを監査、対象stagingへ段階的デプロイ後、通常Chat→Intake→正本readback→スマホUIの1件E2Eを確認するまでは運用開始済みとしない。
