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

A connected GitHub account can open an Issue on `manato-maker/toreca-vault` with one of these exact titles:

- `[Toreca Vault] Staging intake check` (read-only diagnostics)
- `[Toreca Vault] Staging intake retry` (re-invoke the existing staging Intake Scheduler job)

Issue body should be empty or fixed generic text. **No product names, dates, prices, quantities, emails, request IDs, Sheet ID, or secrets in the public Issue**.

The workflow accepts this path only when the event actor and author are the expected repository owner. If a connected app posts as a bot instead of owner, the action deliberately does not run. Fall back to the `workflow_dispatch` control; do not loosen the authorization check.

After a retry, the assistant should read existing Intake statuses and canonical V2 readback and only report completion on matching data. Do not submit a fresh request ID for an already queued business event.

## Separate future scope

If the existing worker is broken, retrying will not repair it. A *separate* strongly authorized repair API/worker may be built after diagnosis. Any such repair must require exact request/lot IDs, before-state revision, expected quantity, compare-and-swap, stable mutation ID, audit trail, and read-after-write verification. It should never offer an unrestricted inventory rewrite or expose public Firestore write credentials.


## Security review / staged rollout (2026-11-23)

Status: PR #108 is a diagnostic / bounded retry gateway; it is not a general
inventory repair API or production deployment. The updated CI now runs
Python operator tests and syntax/dry-run checks of the WIF bootstrap.

### Retry defaults to OFF

- The workflow accepts only the repository owner on main.
- The operator verifies actual project number, active Cloud Run revision,
  Firestore staging canonical, hashed Intake spreadsheet binding, existing
  Scheduler job method/endpoint, Scheduler OIDC identity/audience and write
  feature flags.
- The GitHub environment variable TV_STAGING_OPERATOR_RETRY_ENABLED must
  explicitly equal true before retry can call gcloud. It defaults to OFF.
- Never treat Scheduler invocation as receipt, canonical or UI success.

**Security limitation:** Cloud Scheduler does NOT provide job-level IAM
policies or resource-level IAM Conditions for individual jobs. A project-wide
role with cloudscheduler.jobs.run could run other Scheduler jobs in that
project. The bootstrap script therefore grants ONLY read-only metadata
permissions; it deliberately grants no job-run capability. Do not grant
roles/cloudscheduler.jobRunner or an equivalent custom role until an
administrator has audited all jobs and accepted the scope. A safer future
alternative is a staging-only project or a tightly scoped Cloud Run service
with service-level invoker IAM, a narrow repair API, mandatory expected
revision, event ID, audit trail, and canonical readback. The existing
Sheets Intake HTTP endpoint cannot simply be invoked using a different
identity: it authenticates the exact Scheduler service account and headers.

### Authenticated one-time read-only WIF bootstrap (Android Cloud Shell)

Use the Google Cloud Console, select project
project-8ff0bbc4-675d-4596-a8a and open Cloud Shell.
In Android Chrome, use Desktop site if necessary.

    git clone --depth=1 --branch feat/staging-intake-operator-20261123 https://github.com/manato-maker/toreca-vault.git tv-pr108
    cd tv-pr108
    bash cloud/scripts/bootstrap-staging-operator-wif.sh
    # Inspect the script, selected Google account and project carefully.
    # Only the authorized project administrator runs:
    bash cloud/scripts/bootstrap-staging-operator-wif.sh --apply

This creates a separate OIDC pool/provider (Google keyless WIF), a dedicated
service account and a custom **read-only** role. The trust condition requires
GitHub repository ID 1368127764, ref refs/heads/main, the exact operator
workflow_ref, actor manato-maker, and issues/workflow_dispatch event type.
The role contains only these permissions:
resourcemanager.projects.get, run.services.get, run.revisions.get,
cloudscheduler.jobs.get. The script does not enable billing/services,
deploy, grant Firestore access, or run Scheduler. Pre-existing resources
fail closed rather than being silently reused with unverified policies.

Output contains two NON-SECRET identifiers. Configure at GitHub repository
Settings -> Environments -> staging-intake-operator:

- TV_STAGING_OPERATOR_WIF_PROVIDER = printed provider path
- TV_STAGING_OPERATOR_SA = printed service-account email
- TV_STAGING_OPERATOR_RETRY_ENABLED = leave unset / false

Review and merge ONLY PR #108 to main when authorized, not the pending
Cloud Run migration PR. For the first connection test select GitHub Actions
-> Toreca Vault staging intake operator -> Run workflow -> check. Inspect the
sanitised step logs. Without authorized GCP IAM and these GitHub environment
variables, the workflow must fail closed.

### Bounded repair contract — private transaction facts stay private

Do not include real transaction details, product names, store names, quantities,
costs, request IDs or Intake row numbers in public GitHub Issues, PRs,
documentation, commits or workflow logs. Refer to the private Toreca Vault
common handoff in Google Drive for current case-specific context.

The separate PR #105 development branch implements open-box and sale-aggregate
commands, but their deployment to the currently serving staging revision is
unverified. A generic open-box implementation that consumes matching BOX
inventory FIFO may choose the wrong purchase lot when several stock lots exist.
Therefore, before invoking any queued transaction or repair:

1. Privately inspect the existing request IDs, command/worker receipts, source
   purchase lot IDs, exact acquisition store and quantity, canonical revision
   and audit history; do not append, edit or replay existing Intake rows.
2. Require an exactly targeted, idempotent mutation with expected revision
   compare-and-swap. Preserve original purchase costs and unrelated lot history.
3. If the existing command lacks adequate lot-level targeting, STOP and
   implement/test a constrained exact-lot command rather than enabling retry.
4. Verify the canonical readback, sale/opening histories, inventory changes,
   financial results and Android UI before reporting completion.
5. Never modify legacy V2, production data, old queues, or unrelated sales.

The GitHub operator can only check metadata and potentially request a bounded
staging Scheduler invocation after explicit authorization. It is not a
general-purpose Firestore editor or inventory correction endpoint.
