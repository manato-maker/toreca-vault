#!/usr/bin/env bash
# Android Chrome + authenticated Google Cloud Shell.
# check: read-only, safe default.
# stage: create a private Cloud Run API candidate at ZERO traffic after checks.
# Production, legacy V2, existing inventory and purchase/sale records are NEVER modified.
set -euo pipefail

MODE="${1:-check}"
BRANCH="build/cloudrun-firestore-foundation-20261103"
if [[ "$MODE" != "check" && "$MODE" != "stage" ]]; then
  echo "Usage: bash cloud/scripts/android-staging-launch.sh check|stage" >&2
  exit 2
fi
[[ -f cloud/scripts/release-chat-staging.sh && -f cloud/scripts/audit-free-tier-staging.py ]] || {
  echo "BLOCKED: run this from the repository root." >&2
  exit 2
}
for program in git gcloud python3; do
  command -v "$program" >/dev/null || { echo "BLOCKED: missing $program" >&2; exit 2; }
done
[[ "$(git branch --show-current)" == "$BRANCH" ]] || {
  echo "BLOCKED: wrong repository branch." >&2
  exit 2
}
[[ -z "$(git status --porcelain)" ]] || {
  echo "BLOCKED: local changes must be reviewed before release." >&2
  exit 2
}
# Never deploy an old commit simply because an old Cloud Shell folder existed.
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
if [[ -z "$REMOTE" || "$LOCAL" != "$REMOTE" ]]; then
  echo "BLOCKED: checkout is stale or remote cannot be verified. No deployment." >&2
  exit 2
fi
echo "PASS: latest GitHub development commit matches."
echo "Read-only cost risk audit (does NOT read actual billed charges)..."
python3 cloud/scripts/audit-free-tier-staging.py
echo "Read-only API project, private IAM, canonical document and Intake checks..."
bash cloud/scripts/release-chat-staging.sh check

if [[ "$MODE" == "check" ]]; then
  echo "PASS: preflight complete. No Cloud Run, IAM, Firestore, Sheets or V2 data changed."
  echo "NEXT (optional after reviewing cost/auth findings): bash cloud/scripts/android-staging-launch.sh stage"
  exit 0
fi
echo "Building and staging the reviewed code at ZERO percent API traffic..."
bash cloud/scripts/release-chat-staging.sh stage
echo "STAGED: current active API traffic remains untouched."
echo "NEXT: independently verify candidate auth, worker, Scheduler, canonical and mobile UI before promote."
