#!/usr/bin/env bash
# Deploy a second, read-only staging UI. Does not alter the existing API,
# the Sheets/Scheduler worker, the old V2 system, or canonical data.
set -euo pipefail

PROJECT="project-8ff0bbc4-675d-4596-a8a"
NUMBER="235108293761"
REGION="asia-northeast1"
SERVICE="toreca-vault-ui-staging"
DOCUMENT="torecaVaultStaging/canonical"
# The private handover stays in Google Docs, never bundled into the image.
HANDOVER_DOC_ID="${TV2_HANDOVER_DOC_ID:-1oXxw0pm8YoTCRMwQI16TiITDrtBBE9Gy-54kj90qlz0}"

if [[ ! -f cloud/Dockerfile.dashboard || ! -f v2/core.js || ! -f cloud/src/dashboard-server.js ]]; then
  echo "Run this script from the Toreca Vault repository root on the staging branch." >&2
  exit 1
fi
command -v gcloud >/dev/null || { echo "Google Cloud CLI is required." >&2; exit 1; }
ACTUAL_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
if [[ "$ACTUAL_NUMBER" != "$NUMBER" ]]; then
  echo "Project number mismatch: refusing to deploy." >&2
  exit 1
fi

OWNER_EMAIL="${TV2_DASHBOARD_OWNER_EMAIL:-$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' | head -n1)}"
if [[ "$OWNER_EMAIL" != *@* || "$OWNER_EMAIL" == *gserviceaccount.com ]]; then
  echo "Specify the authorized human email in TV2_DASHBOARD_OWNER_EMAIL." >&2
  exit 1
fi

SA="toreca-vault-dashboard@${PROJECT}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create toreca-vault-dashboard \
    --display-name="Toreca Vault read-only dashboard" --project="$PROJECT"
fi
gcloud projects add-iam-policy-binding "$PROJECT" --quiet \
  --member="serviceAccount:$SA" --role="roles/datastore.viewer" >/dev/null

CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT
mkdir -p "$CONTEXT/cloud" "$CONTEXT/v2"
cp cloud/Dockerfile.dashboard "$CONTEXT/Dockerfile"
cp cloud/package.json cloud/package-lock.json "$CONTEXT/cloud/"
cp -a cloud/src "$CONTEXT/cloud/src"
cp v2/core.js "$CONTEXT/v2/core.js"

gcloud run deploy "$SERVICE" --source="$CONTEXT" \
  --project="$PROJECT" --region="$REGION" \
  --service-account="$SA" --no-allow-unauthenticated \
  --min-instances=0 --max-instances=1 --cpu=1 --memory=512Mi \
  --cpu-throttling --concurrency=40 --timeout=30s \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT,TV2_FIRESTORE_DOCUMENT=$DOCUMENT,TV2_DASHBOARD_IAP_AUDIENCE=/projects/$NUMBER/locations/$REGION/services/$SERVICE,TV2_DASHBOARD_ALLOWED_EMAILS=$OWNER_EMAIL,TV2_HANDOVER_DOC_ID=$HANDOVER_DOC_ID" \
  --quiet

echo
echo "Read-only dashboard deployed as PRIVATE (not yet reachable in a mobile browser)."
echo "Next: Cloud Run > toreca-vault-ui-staging > Security > Identity-Aware Proxy (IAP)."
echo "Grant only the authorized Google account IAP-secured Web App User access."
echo "Do not alter the original toreca-vault-staging API service's IAP or IAM settings."
