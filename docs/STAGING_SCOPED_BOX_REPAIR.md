# Staging-only scoped BOX opening repair

**Status:** development branch PR #105; not deployed or executed on live Firestore. The existing PR #108 WIF `check` confirms staging operator metadata access only. The PR #108 `retry` gate remains disabled.

## Purpose

Repair an already-reported BOX opening **without adding another Intake row or changing purchase data**. All product names, shops, transaction details, request IDs and stock records are read at runtime from the private existing Intake rows and Firestore, not copied into this public repository.

The current one-shot operator reads the existing opening row 64, the two already verified purchase rows 56–57, a separately sold purchase row 58 and sale row 61. Other Intake rows, including 62–63, are not changed.

## Fail-closed behavior

- Read the exact active staging Cloud Run revision and its Firestore/Intake binding; verify project number and existing Scheduler target.
- Reject a non-staging project/document/Sheet, different store/product/date/cost, duplicate or ambiguous purchase, unexpected Intake status, altered queue payload or wrong canonical revision.
- If one target lot is missing while the independently reported Mint-sale purchase lot still appears in stock, a historical same-day FIFO misallocation is suspected. Only when both original purchases, the sold Mint purchase, and its one matching sale unambiguously match the canonical records may a **single-CAS provenance correction** be included in the opening. The correction is recorded in the sale/opening/audit metadata and requires a separate authorization variable. Any other inventory pattern fails closed.
- Select only the exact two current inventory lot IDs belonging to the verified original purchases. No FIFO across other lots.
- Maintain original purchase transactions and acquisition costs, create one opening transaction using the original opening requestId, record the two source purchase/lot IDs. Create no packs or individual cards.
- First run `--inspect`: read-only. No queue/Sheet/Firestore writes.
- Before `--apply`: require explicit revision, `TV_STAGING_REPAIR_APPROVED=true`, and the **existing staging Intake Scheduler and the single staging command-worker Scheduler both PAUSED**. The script enumerates command-worker jobs and refuses any enabled or ambiguous target. This prevents a worker from applying the unsourced original Intake command while the operator is claiming it. A local private snapshot backup is written to `$HOME/.toreca-vault-staging-private-backups/` (mode 0600) before any mutation.
- Enqueue only the **original** Intake command with the **original** request ID, claim its queue lease, apply one revision-CAS mutation, reread canonical, settle the queue as applied, update only its original receipt cells and verify them. No replacement/synthetic request ID.
- If a claim, comparison, save, receipt or verification fails, report a blocker rather than success. If the canonical save succeeded but a later receipt fails, **do not blindly retry the whole script**. The existing mutation ID guarantees no duplicate opening; first reconcile the partial state.

## Operator procedure (Android Cloud Shell)

1. Use the already authenticated GCP project `project-8ff0bbc4-675d-4596-a8a`. Keep the old V2 and production untouched.
2. Clone the branch and install existing pinned Cloud dependencies:

   ```bash
   git clone --branch build/cloudrun-firestore-foundation-20261103 https://github.com/manato-maker/toreca-vault.git ~/toreca-vault-scoped-repair
   cd ~/toreca-vault-scoped-repair
   npm ci --prefix cloud
   node cloud/scripts/staging-scoped-opening-once.js --inspect
   ```

3. The read-only command prints the current revision, quantity and expected acquisition cost only. **Stop if any check is blocked or the revision/quantity/cost differs from the intended report.**
4. Before any write, independently verify the read-only result against the staging dashboard and ensure there is no conflicting active worker. Pause only the known staging Intake job, not any production job, then inspect the exact staging commands Scheduler job name and pause it as well:

   ```bash
   gcloud scheduler jobs pause toreca-vault-staging-intake --project=project-8ff0bbc4-675d-4596-a8a --location=asia-northeast1
   gcloud scheduler jobs list --project=project-8ff0bbc4-675d-4596-a8a --location=asia-northeast1 --format='table(name,state,httpTarget.uri)'
   ```

   Only the staging command job that targets the exact `toreca-vault-staging` service `/internal/worker/commands` may be paused. Do not pause unrelated jobs. If the job cannot be uniquely verified, stop. Never enable the PR #108 `retry` mode.

5. Only after a reviewed inspection, the target-specific command worker is paused, and the canonical readback is consistent, enter the exact current revision `R` reported by `--inspect` (never substitute the previous UI revision):

   ```bash
   TV_STAGING_REPAIR_APPROVED=true node cloud/scripts/staging-scoped-opening-once.js --apply --expected-revision R
   ```

   If `--inspect` states `Historical sale provenance correction planned: true`, STOP until that plan and original Mint-sale evidence have been reviewed. The special repair additionally requires `TV_STAGING_PROVENANCE_REPAIR_APPROVED=true` as a one-command environment variable; do not enable it automatically.

6. Verify the canonical opening, its exact source IDs and quantity, existing purchase costs, queue receipt and Android inventory/history UI. Restore the staging Intake Scheduler only after its existing 500/503 failures and remaining pending command compatibility have been assessed. Never enable PR #108's broad `retry` gate as a shortcut.

## Limits

This is an explicitly staged **operator** path requiring Google Cloud permissions. It is not an already authenticated normal-Chat-to-Firestore bridge. Nothing in this code authorizes old V2 or production writes, grants extra IAM roles, deploys Cloud Run, or guarantees completion without real canonical and UI readback.
