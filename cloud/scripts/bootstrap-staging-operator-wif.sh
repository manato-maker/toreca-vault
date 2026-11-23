#!/usr/bin/env bash
# One-time, check-only GitHub OIDC -> GCP staging operator bootstrap.
# This deliberately does NOT grant cloudscheduler.jobs.run or Firestore access.
set -euo pipefail

PROJECT="project-8ff0bbc4-675d-4596-a8a"
EXPECTED_NUMBER="235108293761"
POOL="tv-staging-intake-operator"
PROVIDER="github-owner-main"
ACCOUNT="tv-staging-intake-checker"
ROLE="tvStagingIntakeReadOnly"
SA="$ACCOUNT@$PROJECT.iam.gserviceaccount.com"
REPOSITORY="manato-maker/toreca-vault"
WORKFLOW_REF="$REPOSITORY/.github/workflows/staging-intake-operator.yml@refs/heads/main"
CONDITION="assertion.repository=='$REPOSITORY' && assertion.repository_id=='1368127764' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='$WORKFLOW_REF' && assertion.actor=='manato-maker' && assertion.event_name in ['issues','workflow_dispatch']"

if [[ $# -ne 1 || "$1" != "--apply" ]]; then
  echo "DRY RUN: no IAM changes made."
  echo "This script provisions one GitHub OIDC pool/provider, one read-only service account,"
  echo "and one minimal project custom role. It does NOT allow retry, deploy, or Firestore edits."
  echo "Review this source and run again with --apply from an authorized Cloud Shell."
  exit 0
fi

command -v gcloud >/dev/null || { echo "BLOCKED: gcloud is unavailable"; exit 2; }
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
[[ "$NUMBER" == "$EXPECTED_NUMBER" ]] || { echo "BLOCKED: project-number mismatch"; exit 2; }

# Existing names must be reviewed rather than silently trusting a changed policy.
if gcloud iam workload-identity-pools describe "$POOL" --project="$PROJECT" --location=global >/dev/null 2>&1; then
  echo "BLOCKED: workload identity pool already exists; inspect its policy manually."
  exit 2
fi
if gcloud iam service-accounts describe "$SA" --project="$PROJECT" >/dev/null 2>&1; then
  echo "BLOCKED: service account already exists; inspect its policy manually."
  exit 2
fi
if gcloud iam roles describe "$ROLE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "BLOCKED: project custom role already exists; inspect it manually."
  exit 2
fi

gcloud iam workload-identity-pools create "$POOL" \
  --project="$PROJECT" --location=global \
  --display-name="TV staging Intake WIF"
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --project="$PROJECT" --location=global --workload-identity-pool="$POOL" \
  --display-name="Github Actions owner/main only" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="$CONDITION"

gcloud iam service-accounts create "$ACCOUNT" --project="$PROJECT" \
  --display-name="TV staging Intake metadata checker (no retries)"
gcloud iam roles create "$ROLE" --project="$PROJECT" \
  --title="TV staging Intake read-only metadata" \
  --description="Project, Cloud Run service/revision, and Scheduler job metadata; no job run" \
  --permissions="resourcemanager.projects.get,run.services.get,run.revisions.get,cloudscheduler.jobs.get" \
  --stage=GA
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" \
  --role="projects/$PROJECT/roles/$ROLE" >/dev/null

gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$PROJECT" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPOSITORY" >/dev/null

FULL_PROVIDER="$(gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --project="$PROJECT" --location=global --workload-identity-pool="$POOL" \
  --format='value(name)')"

echo
echo "READ-ONLY OPERATOR IAM SETUP COMPLETE."
echo "Configure GitHub repository Settings > Environments > staging-intake-operator:"
echo "  Variable TV_STAGING_OPERATOR_WIF_PROVIDER = $FULL_PROVIDER"
echo "  Variable TV_STAGING_OPERATOR_SA = $SA"
echo "  Leave TV_STAGING_OPERATOR_RETRY_ENABLED unset (retry must remain disabled)."
echo "Keep the workflow on the main branch and run the check mode first."
echo "These two variable values are identifiers, NOT tokens or service-account keys."
