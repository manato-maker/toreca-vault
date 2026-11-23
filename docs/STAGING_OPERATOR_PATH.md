# Staging intake operator (Chat → GitHub Actions → Cloud Scheduler)

This is a *staging-only, fail-closed* remote retry entry point. It is **not yet operational** until an authorized Google Cloud administrator configures the separate OIDC trust, narrow IAM permissions, and the GitHub Actions environment. It does not authorize production or legacy V2 writes.

## Authorized operation

- Read the actual serving Cloud Run revision and verify the exact staging project number, canonical Firestore document, hashed private Intake Sheet binding, Scheduler endpoint/method, OIDC identity/audience, and enabled writer gates.
- In `check` mode: read-only. In `retry` mode: invoke only the existing `toreca-vault-staging-intake` Cloud Scheduler job once.
- Never change Firestore directly, reset the intake cursor, edit Sheet cells, create duplicate commands, or mark transactions done.
- A Scheduler invocation only proves that a retry was requested. Read Intake receipts, Firestore canonical state, and the UI before claiming actual application.

## One-time operator setup (not performed by this PR)

1. Create a dedicated Google Cloud operator service account with narrowly scoped `resourcemanager.projects.get`, `run.services.get`, `run.revisions.get`, `cloudscheduler.jobs.get`, and `cloudscheduler.jobs.run` permissions. Restrict job execution to this single staging job when possible. Do **not** grant Firestore writer, run deployer, IAM admin, or production rights.
2. Configure GitHub Actions Workload Identity Federation with no exported JSON key. Restrict assertions to repository `manato-maker/toreca-vault`, ref `refs/heads/main`, and this workflow identity. Verify the trust policy and GitHub actor authorization independently.
3. Configure GitHub Actions environment `staging-intake-operator` with environment variables `TV_STAGING_OPERATOR_WIF_PROVIDER` and `TV_STAGING_OPERATOR_SA`. Do not paste tokens into Chat, GitHub Issues, or code.
4. Merge the reviewed operator PR into the default branch `main` **only after reviewing** these controls. This does not merge the unfinished Cloud Run migration or authorize production migration.
5. Run `Actions → Toreca Vault staging intake operator → Run workflow → check` first; read the sanitized output. Only then test `retry` with the known staging job and verify actual private state separately.

## Later normal-Chat usage

A connected GitHub account can open an Issue on `manato-maker/toreca-vault` with exact title:

`[Toreca Vault] Staging intake retry`

Issue body should be empty or fixed generic text. **No product names, dates, prices, quantities, emails, request IDs, Sheet ID, or secrets in the public Issue**.

The workflow accepts this path only when the event actor and author are the expected repository owner. If a connected app posts as a bot instead of owner, the action deliberately does not run. Fall back to the `workflow_dispatch` control; do not loosen the authorization check.

After a retry, the assistant should read existing Intake statuses and canonical V2 readback and only report completion on matching data. Do not submit a fresh request ID for an already queued business event.

## Separate future scope

If the existing worker is broken, retrying will not repair it. A *separate* strongly authorized repair API/worker may be built after diagnosis. Any such repair must require exact request/lot IDs, before-state revision, expected quantity, compare-and-swap, stable mutation ID, audit trail, and read-after-write verification. It should never offer an unrestricted inventory rewrite or expose public Firestore write credentials.
