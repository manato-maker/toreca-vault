# Toreca Vault V2 — Portable Handoff
Date: 2026-11-04 (JST)
Branch: `build/cloudrun-firestore-foundation-20261103`
PR: [#105 — Start Cloud Run and Firestore migration foundation](https://github.com/manato-maker/toreca-vault/pull/105) (draft)

## Completed this turn
- Added a Firestore Gmail checkpoint store. It saves the fixed scan window before the provider request, resumes after failures, uses expected-cursor compare-and-swap to reject stale page updates, and atomically clears the cursor and advances the last-success timestamp after the final page.
- Added an injected Gmail provider wrapper with bounded retries for HTTP 429/5xx and recognized rate/quota 403 responses. It honors capped Retry-After values and does not retry auth failures.
- Added checkpoint, resume, CAS, atomic-completion, and quota-retry tests.
- Updated the cloud README and handoff records.

## Verification
- GitHub Actions v2-ci run [#41830898928](https://github.com/manato-maker/toreca-vault/actions/runs/41830898928): success.
- `npm test` and `npm run check`: both succeeded in CI.
- No local repository was mounted; no claim of a separate local run.

## Current limits / production state
- Gmail API client, OAuth scopes/grant, Firestore Emulator, Cloud Run deployment, and live wiring are not implemented or verified.
- No production Gmail messages/checkpoints were read or written. Existing Apps Script, triggers, canonical V2 data, and command queue are unchanged. Pending sales and the TCG193 row remain unprocessed; nothing was re-submitted.
- Canonical V2 source identity remains unconfirmed; do not migrate the staging-named JSON as canonical.

## Next
1. Add isolated Firestore Emulator tests for concurrent cursor claims, stale writes, and retries.
2. Implement the Gmail API adapter with least-privilege read-only scopes once authorized Cloud project credentials are available.
3. Wire only in staging; verify bounded checkpoint recovery and message-ID idempotency.
4. Confirm canonical V2 identity and produce a read-only backup/hash/count report before any migration planning.
5. Keep existing triggers and workers unchanged until shadow comparison and explicit cutover acceptance.


## Follow-up verification
- Added previous-success generation to the cursor CAS guard and a stale-scan regression case.
- Focused local tests: 10 passed. GitHub Actions v2-ci #41831501955 passed the full test/check workflow.


## Firestore Emulator test scaffold
- Added an opt-in emulator integration test for concurrent cursor updates, stale-generation writes, and final checkpoint readback, plus an isolated demo-project config and dedicated npm command.
- Local run: 10 passed; the integration test was skipped because this workspace has no Firebase CLI and no `FIRESTORE_EMULATOR_HOST`. No live emulator race test was executed.
- GitHub Actions v2-ci #41832445196 passed full test/check steps; the opt-in integration remained skipped.
- Next: run the test against an isolated emulator when available, then continue with least-privilege Gmail API wiring once Cloud credentials are authorized.


## Firestore Emulator race verification
- Added a dedicated CI job using `firebase emulators:exec` and a demo project. Emulator client rules deny access; the test uses Admin SDK only against the local emulator.
- First run caught `db.close()` in cleanup; fixed to `db.terminate()`.
- GitHub Actions v2-ci #41833501945 passed both normal tests/checks and the Emulator job. Emulator result: 1 test passed, 0 failed, 0 skipped. Concurrent CAS winner, stale-generation rejection, and final readback all verified.
- Production Firestore/Gmail/OAuth/V2/queue/triggers remain untouched.
- Next: implement a least-privilege Gmail read-only API adapter when authorized Cloud project credentials are available; then wire only in staging.
