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
| Gmail lottery inbox scan | Hourly, 09:00–23:00 | Overlapping search/checkpoint for late mail; cap search range and results; deduplicate by message ID. |
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
