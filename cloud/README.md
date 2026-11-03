# Toreca Vault Cloud API foundation

This is an isolated migration target for replacing the Apps Script V2 persistence/API bottleneck. It is not deployed and does not read or write production data.

## First slice

- Cloud Run HTTP service, using the existing V2 `schemaVersion: 2` snapshot contract.
- Firestore compare-and-swap persistence, guarded by `expectedRevision` and `mutationId`.
- Bearer token comparison, exact-origin CORS, read-after-write verification, and a public health endpoint that reveals no data.
- Empty Firestore is treated as **not initialized**. The service never creates an empty V2 dataset automatically.
- Writes default to disabled. The service rejects every non-read request before it reaches Firestore unless a later, separately reviewed migration step explicitly enables them.
- No Gmail, Sheets queue, Cloud Scheduler, or production migration is enabled in this slice.

## Schedule plan

`src/schedule.js` is a pure, no-I/O planner for one dispatcher invoked every 15 minutes. It returns separate job kinds for the command queue, the hourly Gmail inbox scan, focused lottery-result checks, and the daily market refresh. Each job includes a deterministic key. `src/job-ledger.js` claims that key in a Firestore transaction, fences off stale workers with a per-claim token, and limits retries. `src/worker-dispatcher.js` runs each handler independently and stores only a safe error code, never Gmail content or a raw error message.

The lease ledger cannot make an external Gmail/Sheets side effect exactly-once if a process crashes after the side effect but before marking completion. Every worker must also use message/request IDs and the V2 mutation ID guard. The dispatcher and ledger are implemented but have no production Firestore connection yet.

- Command queue: each 15-minute boundary.
- Gmail lottery inbox scan: hourly from 09:00 through 23:00 JST.
- Focused lottery-result scan: 12:30 and 19:00 JST.
- Market refresh: first dispatcher tick after 13:30 JST (13:45), once per JST date after the durable ledger records completion.

At 12:30 and 19:00, the inbox scan and result-focus job are separate entries. The future worker must use message-ID deduplication so the same Gmail message cannot create duplicate lottery records.

Completed ledger rows carry an `expireAt` timestamp for a future Firestore TTL policy. Configure and verify that policy in an isolated project before production; expiration is not automatic until the policy exists.

## Planned operations

- Keep ChatGPT's current Google Sheets command queue as the input bridge until the ChatGPT mobile write connector is confirmed. The worker will read only the dedicated queue sheet every 15 minutes, claim request IDs, and update each row to `done`, `review`, or bounded retry state.
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

Cloud Run deployment, Firestore creation/TTL configuration, OAuth consent, Gmail/Sheets access, and production cutover are intentionally outside this prototype.
