# Toreca Vault Cloud API foundation

This repository contains the migration target for replacing the Apps Script V2 persistence/API bottleneck. **As of 2026-11-12 JST, a private staging deployment is live; it does not read or write production V2.** The original prototype notes below are historical where marked.

## First slice

- Cloud Run HTTP service, using the existing V2 `schemaVersion: 2` snapshot contract.
- Firestore compare-and-swap persistence, guarded by `expectedRevision` and `mutationId`.
- Bearer token comparison, exact-origin CORS, read-after-write verification, and a public health endpoint that reveals no data.
- Empty Firestore is treated as **not initialized**. The service never creates an empty V2 dataset automatically.
- Writes default to disabled. The service rejects every non-read request before it reaches Firestore unless a later, separately reviewed migration step explicitly enables them.
- Firestore-backed, create-once command queue accepts only the existing nine command types, verifies stable `requestId`, hashes canonical payloads to recognize exact retries, and rejects same-ID/different-payload collisions.
- The authenticated `/api/v2` `enqueueCommand` action is disabled by default (`TV2_ENABLE_COMMAND_QUEUE=false`). When enabled it returns only status metadata; it does not run the command or send email.
- Historical first-slice note: Gmail and production migration are not enabled. A dedicated new-app Google Sheets intake bridge and 15-minute Cloud Scheduler job are now deployed in staging; see the dated staging status below.

## Command execution prototype

`src/v2-command.js` contains pure state transitions for purchase, sale, pack opening, lottery application, exact lottery result, lottery receipt, and guarded bulk result updates. Purchases require the reported unit cost explicitly; a single reported as acquired by opening a box must have zero cost. Sales consume FIFO lots, require an unambiguous condition, and remove depleted lots. Pack opening keeps purchase transactions and removes sealed inventory. Lottery application/result/receipt transitions do not silently create purchase or inventory records. Bulk result updates stop if they include a purchased/received item. All successful transitions increment one revision and append one mutation ID; the module performs no network or database I/O.

`src/command-worker.js` claims one queued request, applies a pure transition, writes with revision CAS, checks the returned revision/mutation ID, and only then settles the lease. If the snapshot was saved but queue settlement was lost, retry observes the mutation ID and completes without another revision. Unknown command types and ambiguous/invalid data go to review. This worker is not attached to a scheduled runtime or the production queue. The special Pokémon Center spouse-result and receipt/sale repair handlers remain unimplemented and must stay in manual review.

`src/gmail-message-jobs.js` turns a bounded Gmail provider page into stable message-level job keys. It uses only the provider message ID, hashes that ID for the durable ledger key, deduplicates repeats within the page, and rejects an oversized page rather than silently dropping messages. The message body, subject, sender, and labels are not retained by this planner. A read-only Gmail `users/me/messages` list adapter now requests only `gmail.readonly` through an injected token callback and returns message IDs only. The OAuth grant/token source, message parser, and production wiring remain unimplemented. The adapter and Firestore checkpoints are not connected to a live Gmail account or production runtime.

`src/gmail-scan-planner.js` creates fixed-bound Gmail search pages: a one-time seven-day backfill, then hourly queries with a 15-minute overlap, plus result-focused queries with a six-hour overlap. It caps pages at 50, preserves the same upper bound through `nextPageToken` pagination, and only returns a new successful checkpoint after the final page has been processed. The planner does not call Gmail. `src/google-gmail-api-provider.js` calls only the Gmail messages.list endpoint using an injected access-token source and returns only message IDs and page tokens; it does not fetch mail bodies, subjects, senders, or labels. Its token callback receives the single `gmail.readonly` scope. `src/quota-aware-gmail-provider.js` wraps the request, retries quota/transient responses with bounded backoff, honors capped `Retry-After`, and does not retry authentication failures. `src/firestore-gmail-checkpoints.js` stores only the bounded scan cursor and last-success timestamp, persists a fixed window before the request, uses cursor+generation compare-and-swap, and atomically completes the final page. OAuth grant, parser, live Gmail credentials, and production wiring remain unimplemented.

## Schedule plan

`src/schedule.js` is a pure, no-I/O planner for one dispatcher invoked every 15 minutes. It returns separate job kinds for the command queue, the hourly Gmail inbox scan, focused lottery-result checks, and the daily market refresh. Each job includes a deterministic key. `src/job-ledger.js` claims that key in a Firestore transaction, fences off stale workers with a per-claim token, and limits retries. `src/worker-dispatcher.js` runs each handler independently and stores only a safe error code, never Gmail content or a raw error message.

The lease ledger cannot make an external Gmail/Sheets side effect exactly-once if a process crashes after the side effect but before marking completion. Every worker must also use message/request IDs and the V2 mutation ID guard. The dispatcher and ledger are implemented but have no production Firestore connection yet.

`src/firestore-command-queue.js` persists pending command payloads so accepted commands can survive restarts and exact retries. Queue documents are hashed by request ID, bounded to 20 KB, and retain their payload for retry/audit; no TTL is configured. Production needs an explicit retention policy that preserves enough request-ID deduplication history before queue writes are enabled. Claim leases are fenced; the attempt cap moves an item to review. The queue API is not a command executor and has no legacy Apps Script handler wired to it yet.

- Command queue: each 15-minute boundary.
- Gmail lottery inbox scan: hourly from 07:00 through 24:00 JST (24:00 means 00:00 on the next calendar day).
- Focused lottery-result scan: 12:30 and 19:00 JST.
- Market refresh: first dispatcher tick after 13:30 JST (13:45), once per JST date after the durable ledger records completion.

At 12:30, schedule one result-focused Gmail scan. At 19:00, add the result-focus flag to the existing hourly Gmail job; do not create a second Gmail job for that tick. The Gmail worker must use message-ID deduplication so the same message cannot create duplicate lottery records.

Completed ledger rows carry an `expireAt` timestamp for a future Firestore TTL policy. Configure and verify that policy in an isolated project before production; expiration is not automatic until the policy exists.

## Planned operations

- Current staging path: ordinary ChatGPT reporting is intended to append to the separate `Toreca Vault New App Intake` sheet; the 15-minute Cloud Run intake worker places validated rows into the staging Firestore queue and writes a bounded receipt. It is not the legacy V2 command queue, and there is no dual processing.
- Scan Gmail lottery messages hourly from 07:00 through 24:00 JST (24:00 is next-day 00:00). Keep the focused result check at 12:30. Merge the 19:00 focus into its hourly Gmail job. Use Gmail message IDs and durable overlapping checkpoints for deduplication and late delivery.
- Run one Cloud Scheduler dispatcher every 15 minutes. It dispatches due queue, Gmail, result-check, and daily market jobs, so the schedule does not need separate Scheduler resources.
- Keep price quotes with source, checked time, freshness, and outcome. Failed or ambiguous lookups preserve the last confirmed quote and record a stale/review state.

## Data and safety gates

1. Confirm which Drive JSON is the actual V2 canonical file. The latest reachable snapshot recorded in the handoff was named `toreca-vault-v2-staging.json`; it must not be migrated as canonical without owner-side confirmation.
2. Export a read-only backup and produce a dry-run import report (revision, transactions, lots, lotteries, quotes, and totals).
3. Import only into a new Firestore namespace. Verify the snapshot hash and all collection totals before any writes are allowed.
4. Run mutation tests against an isolated emulator dataset: duplicate request, stale revision, concurrent sale, insufficient inventory, opening, rollback, and post-write readback.
5. Keep the current Apps Script, queue, and V2 API running during shadow comparison. Do not process the same queue in both systems.
6. Cut over only after the Cloud API can read the imported V2 state, preserve all invariants, and pass explicit owner-side acceptance. No command replays, inventory edits, or trigger changes are part of this prototype.

## Firestore snapshot storage

Snapshots up to the conservative 900,000-byte document budget use the original single-document layout. Larger snapshots use the `chunked-v1` layout: array fields are split into bounded documents, while a manifest and all chunks are committed in one Firestore transaction. Reads validate chunk sequence, schema, revision, size, and SHA-256 before returning the unchanged V2 snapshot contract. A transaction payload above 7,000,000 bytes, an oversized atomic field/item, or an unsafe chunk count fails closed. A first write from the legacy single-document format can transition to chunked storage atomically.

Large snapshots require more Firestore reads and writes: one root plus one read/write per chunk, including post-write verification. The 900,000-byte single-document path retains its one-document operation count. Large unqueried fields are exempted from single-field indexes in `firestore.indexes.json`. These settings are code only and have not been deployed.

An unverified staging-named export measured 1,242,326 raw file bytes and 1,009,515 bytes for the compact `{payload: ...}` estimate. That result is a capacity stress example only; it is not a canonical source or migration input. It falls above the internal single-document safety budget, so the new adapter routes snapshots of this size through chunked storage.

## Read-only migration inspection

After the owner confirms the canonical source file, run `npm run report --prefix cloud -- /path/to/v2.json`. The command validates schema and IDs, reports counts/quantities, input bytes and SHA-256, and estimates Firestore document size. It omits product names, transaction IDs, email addresses, and other record details. It never writes to Firestore or changes the input file. Do not run it against the `staging`-named file as if it were canonical.

## Local verification

```sh
npm test --prefix cloud
npm run check --prefix cloud
```

## Firestore Emulator race tests

The dedicated integration test uses a unique throwaway collection and deletes its document after the run. It covers two simultaneous cursor claims, a stale generation attempting to recreate a cleared cursor, and final checkpoint readback. The regular test suite skips this integration test when `FIRESTORE_EMULATOR_HOST` is unset.

Start an isolated emulator with Firebase CLI, then run:

```sh
firebase emulators:start --only firestore --project demo-toreca-vault --config cloud/firebase.json
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-toreca-vault npm run test:firestore-emulator --prefix cloud
```

The emulator is local-only; this does not configure or access production Firestore.

Cloud Run deployment, Firestore creation/TTL/retention configuration, OAuth consent, Gmail/Sheets access, legacy command execution, and production cutover are intentionally outside this prototype.


## 2026-11-05 design audit follow-up

- The scheduler planner now accepts the original planned timestamp separately from actual handler start time. The live Cloud Scheduler adapter must parse and pass the documented scheduled-time header; this is not wired into a deployed dispatcher yet. Durable command rows and Gmail fixed-window checkpoints provide recovery data, but a monitoring alert for stale dispatch heartbeats remains unimplemented.
- The 19:00 result focus is carried on the single hourly Gmail job; 12:30 remains a separate focused check. This prevents two scheduled Gmail executions at 19:00 without changing the confirmed 12:30 schedule.
- Added an authenticated command status route and a GPT Action OpenAPI template. It distinguishes pending, processing, done/review and canonical readback verification; it never returns command payloads. The queue and API remain disabled in production, so regular Chat end-to-end operation is not verified.
- The V2 snapshot remains one document with a 900,000-byte fail-closed limit. Because the confirmed canonical export and growth rate are unavailable, do not migrate until the read-only report confirms size and headroom. Reassess normalized collection sharding if the snapshot exceeds 630,000 bytes or 90-day measured growth projects the safety limit within 12 months; this threshold is a migration gate, not a live setting.
- Backups, restore drills, worker-status monitoring, OAuth refresh-token storage and budget alerts remain unimplemented. Firestore scheduled backups/PITR, restore, TTL, and excess Cloud usage can incur charges. Do not enable paid resources until the owner approves a concrete estimate and project.


### Gmail quota guard (2026-11-05)

A page is limited to 50 messages at both planner and provider boundaries. Google's current Gmail API quota table lists 60 quota units for a full-format messages.get and 5 for messages.list, with a 6,000 quota-unit per-user-per-project-per-minute limit. A 50-message page therefore has a 3,005-unit request budget before retries; pagination resumes from the durable cursor on the next dispatcher invocation. This limits burst size; it is not a live quota measurement. Source: https://developers.google.com/workspace/gmail/api/reference/quota

### Chat Action status and audit gates

- cloud/openapi-chat-action.yaml describes enqueue and status-only operations. Configure it only after deployment and explicit queue acceptance; the API remains disabled by default.
- The API reports accepted/pending/processing/done/review and canonical-readback verification without returning the command payload.
- The current Firestore snapshot remains one document with the 900,000-byte safety limit. Do not migrate until the confirmed canonical export has been measured. Reassess partitioning above 630,000 bytes or when measured 90-day growth projects crossing the safety limit within 12 months.
- No backup/restore workflow, live Gmail OAuth, dispatcher heartbeat alert, Cloud Monitoring alert, or budget alert is connected. No paid backup or production resources were enabled.
- Official current cost references reviewed: Firestore https://cloud.google.com/firestore/pricing ; Cloud Run https://cloud.google.com/run/pricing ; Cloud Scheduler https://cloud.google.com/scheduler/pricing ; GPT Actions https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts .


## Bounded command queue worker

The API can process accepted commands through a bounded worker endpoint:

- `POST /internal/worker/commands` is disabled unless the worker, command queue, and V2 writes are all explicitly enabled.
- The worker validates a Google-signed OIDC ID token against the configured Scheduler audience and exact Scheduler service account email. No additional shared worker secret is needed. Grant that service account `roles/run.invoker` on this Cloud Run service only; keep all worker flags disabled until the canonical migration gate is passed.
- Set `TV2_SCHEDULER_AUDIENCE` to the Cloud Run service URL used as the OIDC audience and `TV2_SCHEDULER_SERVICE_ACCOUNT_EMAIL` to the dedicated Scheduler service account. Configure Cloud Scheduler to attach an OIDC token for that account and call `POST /internal/worker/commands`; the route also checks the planned-time and Scheduler marker headers.
- Each tick queries only pending command request IDs (maximum 50; default batch 10) and uses the existing queue claim, revision-CAS, readback, and settlement logic. Concurrent ticks are fenced by queue leases.
- Configure Cloud Scheduler for every 15 minutes only after the canonical V2 snapshot has been imported and verified. This repository change does not create a Scheduler job, grant IAM permissions, or deploy the service.
- If the canonical snapshot is absent, processing leaves a bounded retry state; after the existing attempt limit, the queue moves the command to review. Do not enable the worker before the migration gate is passed.

The worker API is implementation and Emulator-tested, not live. OAuth/Gmail workers, the complete dispatcher composition, Scheduler job, ChatGPT Action registration, and monitoring remain unconnected.


## Standard Chat intake bridge candidate: dedicated Google Sheet

A disabled-by-default one-way adapter is implemented for a separate spreadsheet titled `Toreca Vault New App Intake`, with a tab named `Intake`. It is isolated from the existing V2 command queue. The worker reads only `Intake!A2:D...` (at most 50 rows, normally 20) and writes receipts only to columns D:G. It never writes to the old V2 API or canonical snapshot.

The columns are `requestId`, `commandJson`, `businessEventIdentityJson`, `status`, `resultCode`, `acceptedRequestId`, and `processedAtMs`. Add only new-app reports with status `new`. Lottery event identities must include an explicit canonical `retailerKey` and explicit `applicationId`; absent or malformed IDs go to `review`. The Firestore queue's create-once request ID and source-independent event key prevent retries and cross-source lottery duplicates.

The adapter requires all of these gates: `TV2_ENABLE_GOOGLE_SHEETS_INTAKE=true`, `TV2_ENABLE_COMMAND_QUEUE=true`, Scheduler OIDC settings, and `TV2_NEW_APP_INTAKE_SPREADSHEET_ID`. Google Sheets access uses the Cloud Run service identity, which must be granted access to this exact dedicated file. Queue intake does not require canonical writes to be enabled. All flags remain false/unset in production; this repository change creates no spreadsheet, service account grant, Scheduler job, or deployment.

The intake sheet is append-only. A Firestore cursor stores only a hashed spreadsheet ID, the next row number, a generation, and update time. Each tick reads the next contiguous page (20 rows by default) and advances only after every row in that page has a receipt; enqueue or receipt failures leave the cursor in place so stable request IDs make the retry idempotent. Do not insert, sort, delete, or edit older rows after the cursor has passed them; submit a corrected report as a new row with a new request ID.

Basic Google Drive write/read from normal Chat on Android has been smoke-tested. The complete normal Chat report-to-row flow, including text/image parsing and end-to-end user confirmation, is still unverified. Do not share tokens or use the existing V2 command queue spreadsheet.

### Intake queue completion receipts

Accepted sheet commands store only a SHA-256 of the dedicated spreadsheet ID, the source row number, and a receipt state alongside the existing queue row. The raw spreadsheet ID is not duplicated in the queue. A reconciliation pass runs with the same Scheduler intake tick. While the command is pending or claimed, the sheet remains `queued`; the reconciler writes a final `v2-applied` receipt only after the command worker has confirmed the canonical revision and mutation ID on store readback. It then rereads D:G and verifies all four receipt values before marking the queue's receipt link final. Failed sheet writes/readbacks remain retryable and never relabel a command as verified. Review commands receive a `review` receipt; previously applied duplicates remain explicitly `duplicate`.

The worker does not write a separate `processing` status to Sheets, avoiding stale concurrent status writes. The queue itself tracks `pending` and `processing`; the sheet shows `queued` until a final result is verified. The regular Chat Android smoke test verified only a harmless single-cell write/read and cleanup. Real transaction report-to-queue/worker/result E2E and screenshot input remain unverified; all production flags remain off.


## Current staging and operator boundary — 2026-11-12 JST

- Normal Chat setup guide: [`docs/STAGING_CHAT_QUICKSTART.md`](../docs/STAGING_CHAT_QUICKSTART.md). It describes the dedicated sheet row format and the requirement to report queue acceptance separately from V2 application.

- Cloud Run `toreca-vault-staging` in `asia-northeast1` is private and Ready. The Scheduler OIDC job invokes the Sheets intake every 15 minutes (Asia/Tokyo). Sheets intake and Firestore queue are enabled in staging; V2 writes and command worker are disabled.
- The intake sheet columns are: A `requestId`, B `commandJson`, C `businessEventIdentityJson` (lottery commands only), D `status`, E `resultCode`, F `acceptedRequestId`, G `processedAtMs`. Append rows only. For a valid new command, set D to `new` and leave E:G empty; the worker owns D:G receipts. For uncertain facts or duplicate/cost questions, set D to `review` and do not submit it as `new`. Never sort, edit, or resubmit old rows.
- The 2026-11-06 30th CELEBRATION purchase is accepted as `pending`; `processed=false` and `canonicalReadbackVerified=false`. The 2026-11-07 ORIGINAL ARTWORK DUEL SET remains `review/needs-review` to prevent duplicate cost accounting.
- This proves staging intake and queue-status readback only. It does not mean inventory or cost has been applied to canonical V2. Normal Chat's full text/image-to-row operation and final V2 readback are not yet verified. PR #105 remains Draft/open/unmerged. No old V2 write, legacy queue processing, pending sale replay, Gmail connection, or production migration occurred.
- GitHub Actions v2-ci #843 passed after the latest handover changes (test/check and Firestore Emulator). CI is not a live-service test.


## Staging inventory view (2026-11-12)

A separate `在庫一覧` tab can be synchronized into the private `Toreca Vault New App Intake` spreadsheet. It is a read-only view of positive Firestore inventory lots grouped by product, category, condition, and card/set identity. For phone readability, the view has four columns: product/set, quantity, type/condition, and cost total. The product column and top two rows stay fixed. A review marker replaces the cost total when any lot cost is unknown. The Intake tab and its append-only A:G rows are not modified by this view.

The sync uses the existing Cloud Run service identity and Google Sheets access. It never puts an API token in the browser or makes the spreadsheet public. To enable it in staging, set `TV2_ENABLE_INVENTORY_VIEW=true` alongside the existing Sheets intake configuration, then deploy the service. The existing 15-minute staging intake worker updates the view after processing intake/status receipts. The view refuses to overwrite the sheet if the canonical Firestore snapshot is not initialized. A failed write/readback causes that worker tick to fail so the next scheduled tick can retry.

The tab is a generated report; do not edit its cells. Open the dedicated spreadsheet in Google Sheets and choose `在庫一覧`. The timestamp and Firestore revision are shown at the top. This report is not the legacy GitHub Pages app and does not change production V2, the legacy queue, or inventory mutations.
