# Toreca Vault Cloud API foundation

This is an isolated migration target for replacing the Apps Script V2 persistence/API bottleneck. It is not deployed and does not read or write production data.

## First slice

- Cloud Run HTTP service, using the existing V2 `schemaVersion: 2` snapshot contract.
- Firestore compare-and-swap persistence, guarded by `expectedRevision` and `mutationId`.
- Bearer token comparison, exact-origin CORS, read-after-write verification, and a public health endpoint that reveals no data.
- Empty Firestore is treated as **not initialized**. The service never creates an empty V2 dataset automatically.
- Writes default to disabled. The service rejects every non-read request before it reaches Firestore unless a later, separately reviewed migration step explicitly enables them.
- Firestore-backed, create-once command queue accepts only the existing nine command types, verifies stable `requestId`, hashes canonical payloads to recognize exact retries, and rejects same-ID/different-payload collisions.
- The authenticated `/api/v2` `enqueueCommand` action is disabled by default (`TV2_ENABLE_COMMAND_QUEUE=false`). When enabled it returns only status metadata; it does not run the command or send email.
- No Gmail reader, Apps Script/Sheets bridge, Cloud Scheduler, or production migration is enabled in this slice.

## Command execution prototype

`src/v2-command.js` contains pure state transitions for purchase, sale, pack opening, lottery application, exact lottery result, lottery receipt, and guarded bulk result updates. Purchases require the reported unit cost explicitly; a single reported as acquired by opening a box must have zero cost. Sales consume FIFO lots, require an unambiguous condition, and remove depleted lots. Pack opening keeps purchase transactions and removes sealed inventory. Lottery application/result/receipt transitions do not silently create purchase or inventory records. Bulk result updates stop if they include a purchased/received item. All successful transitions increment one revision and append one mutation ID; the module performs no network or database I/O.

`src/command-worker.js` claims one queued request, applies a pure transition, writes with revision CAS, checks the returned revision/mutation ID, and only then settles the lease. If the snapshot was saved but queue settlement was lost, retry observes the mutation ID and completes without another revision. Unknown command types and ambiguous/invalid data go to review. This worker is not attached to a scheduled runtime or the production queue. The special Pokémon Center spouse-result and receipt/sale repair handlers remain unimplemented and must stay in manual review.

`src/gmail-message-jobs.js` turns a bounded Gmail provider page into stable message-level job keys. It uses only the provider message ID, hashes that ID for the durable ledger key, deduplicates repeats within the page, and rejects an oversized page rather than silently dropping messages. The message body, subject, sender, and labels are not retained by this planner. The hourly Gmail API query, parser, OAuth scope, checkpoint, and production worker remain unimplemented.

`src/gmail-scan-planner.js` creates fixed-bound Gmail search pages: a one-time seven-day backfill, then hourly queries with a 15-minute overlap, plus result-focused queries with a six-hour overlap. It caps pages at 100, preserves the same upper bound through `nextPageToken` pagination, and only returns a new successful checkpoint after the final page has been processed. This is a query/cursor planner only; it does not call Gmail or persist checkpoints.

## Schedule plan

`src/schedule.js` is a pure, no-I/O planner for one dispatcher invoked every 15 minutes. It returns separate job kinds for the command queue, the hourly Gmail inbox scan, focused lottery-result checks, and the daily market refresh. Each job includes a deterministic key. `src/job-ledger.js` claims that key in a Firestore transaction, fences off stale workers with a per-claim token, and limits retries. `src/worker-dispatcher.js` runs each handler independently and stores only a safe error code, never Gmail content or a raw error message.

The lease ledger cannot make an external Gmail/Sheets side effect exactly-once if a process crashes after the side effect but before marking completion. Every worker must also use message/request IDs and the V2 mutation ID guard. The dispatcher and ledger are implemented but have no production Firestore connection yet.

`src/firestore-command-queue.js` persists pending command payloads so accepted commands can survive restarts and exact retries. Queue documents are hashed by request ID, bounded to 20 KB, and retain their payload for retry/audit; no TTL is configured. Production needs an explicit retention policy that preserves enough request-ID deduplication history before queue writes are enabled. Claim leases are fenced; the attempt cap moves an item to review. The queue API is not a command executor and has no legacy Apps Script handler wired to it yet.

- Command queue: each 15-minute boundary.
- Gmail lottery inbox scan: hourly from 09:00 through 23:00 JST.
- Focused lottery-result scan: 12:30 and 19:00 JST.
- Market refresh: first dispatcher tick after 13:30 JST (13:45), once per JST date after the durable ledger records completion.

At 12:30, schedule one result-focused Gmail scan. At 19:00, mark the existing hourly Gmail job as `hourly+results`; do not create a second Gmail job for that tick. The Gmail worker must use message-ID deduplication so the same message cannot create duplicate lottery records.

Completed ledger rows carry an `expireAt` timestamp for a future Firestore TTL policy. Configure and verify that policy in an isolated project before production; expiration is not automatic until the policy exists.

## Planned operations

- Keep ChatGPT's current Google Sheets command queue as the input bridge until a secure Chat ingress is confirmed. The new API queue is only a tested receiving boundary; no dual processing or production bridge is enabled. Do not point the current Sheets producer at it until an audited one-way adapter and cutover/rollback procedure exist.
- Scan Gmail lottery messages separately once per hour from 09:00 through 23:00 JST, with additional focused scans at 12:30 and 19:00 JST. Use Gmail message IDs and overlapping checkpoints for deduplication and late delivery.
- Run one Cloud Scheduler dispatcher every 15 minutes. It dispatches due queue, Gmail, result-check, and daily market jobs, so the schedule does not need separate Scheduler resources.
- Keep price quotes with source, checked time, freshness, and outcome. Failed or ambiguous lookups preserve the last confirmed quote and record a stale/review state.

## Data and safety gates

1. Confirm which Drive JSON is the actual V2 canonical file. The latest reachable snapshot recorded in the handoff was named `toreca-vault-v2-staging.json`; it must not be migrated as canonical without owner-side confirmation.
2. Export a read-only backup and produce a dry-run import report (revision, transactions, lots, lotteries, quotes, and totals).
3. Import only into a new Firestore namespace. Verify the snapshot hash and all collection totals before any writes are allowed.
4. Run mutation tests against an isolated emulator dataset: duplicate request, stale revision, concurrent sale, insufficient inventory, opening, rollback, and post-write readback.
5. Keep the current Apps Script, queue, and V2 API running during shadow comparison. Do not process the same queue in both systems.
6. Cut over only after the Cloud API can read the imported V2 state, preserve all invariants, and pass explicit owner-side acceptance. No command replays, inventory edits, or trigger changes are part of this prototype.

## Current limitation

The first prototype stores the complete V2 snapshot in one Firestore document to preserve current client compatibility. Firestore documents have a 1 MiB limit; the adapter enforces a conservative 900,000-byte ceiling and fails closed. Before production, measure the canonical snapshot and either confirm ample headroom or normalize records into collections before migration.

## Read-only migration inspection

After the owner confirms the canonical source file, run `npm run report --prefix cloud -- /path/to/v2.json`. The command validates schema and IDs, reports counts/quantities, input bytes and SHA-256, and estimates Firestore document size. It omits product names, transaction IDs, email addresses, and other record details. It never writes to Firestore or changes the input file. Do not run it against the `staging`-named file as if it were canonical.

## Local verification

```sh
npm test --prefix cloud
npm run check --prefix cloud
```

Cloud Run deployment, Firestore creation/TTL/retention configuration, OAuth consent, Gmail/Sheets access, legacy command execution, and production cutover are intentionally outside this prototype.
