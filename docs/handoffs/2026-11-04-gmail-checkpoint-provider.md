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
