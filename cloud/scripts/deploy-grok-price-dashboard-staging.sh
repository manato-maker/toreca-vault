#!/usr/bin/env bash
# Roll out Grok quote display to existing private STAGING dashboard only.
# Requires existing service/IAP configuration; never grants IAM roles or
# creates services. No production, queue, Scheduler, old V2, canonical writes.
set -euo pipefail
PROJECT="project-8ff0bbc4-675d-4596-a8a"
NUMBER="235108293761"
REGION="asia-northeast1"
SERVICE="toreca-vault-ui-staging"
DOCUMENT="torecaVaultStaging/canonical"
BRANCH="build/cloudrun-firestore-foundation-20261103"
for p in gcloud git python3 node; do command -v "$p" >/dev/null || { echo "BLOCKED: $p unavailable" >&2; exit 2; }; done
[[ -f cloud/Dockerfile.dashboard && -f cloud/src/dashboard-view.js && -f cloud/src/grok-buyback-reported.js ]] || {
  echo "BLOCKED: run from checked-out staging repository root" >&2; exit 2; }
[[ "$(git branch --show-current)" == "$BRANCH" && -z "$(git status --porcelain)" ]] || {
  echo "BLOCKED: expected clean staging branch" >&2; exit 2; }
HEAD="$(git rev-parse HEAD)"
REMOTE="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
[[ -n "$REMOTE" && "$HEAD" == "$REMOTE" ]] || { echo "BLOCKED: stale checkout" >&2; exit 2; }
ACTUAL="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
[[ "$ACTUAL" == "$NUMBER" ]] || { echo "BLOCKED: wrong Cloud project" >&2; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json > "$WORK/service.json"
gcloud run services get-iam-policy "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json > "$WORK/iam.json"
python3 - "$WORK/service.json" "$WORK/iam.json" <<'PY'
import json,sys
service=json.load(open(sys.argv[1]))
iam=json.load(open(sys.argv[2]))
template=service.get("spec",{}).get("template",{}).get("spec",{})
if not template:
    template=service.get("template",{})
containers=template.get("containers",[])
if len(containers)!=1:
    raise SystemExit("BLOCKED: expected one existing dashboard container")
env={x.get("name"):x.get("value") for x in containers[0].get("env",[])}
expected={
    "GOOGLE_CLOUD_PROJECT":"project-8ff0bbc4-675d-4596-a8a",
    "TV2_FIRESTORE_DOCUMENT":"torecaVaultStaging/canonical",
    "TV2_DASHBOARD_IAP_AUDIENCE":"/projects/235108293761/locations/asia-northeast1/services/toreca-vault-ui-staging"
}
for k,v in expected.items():
    if env.get(k)!=v:
        raise SystemExit("BLOCKED: existing dashboard "+k+" mismatched")
if not env.get("TV2_DASHBOARD_ALLOWED_EMAILS"):
    raise SystemExit("BLOCKED: existing IAP allowed emails missing")
service_account=template.get("serviceAccountName") or template.get("serviceAccount")
if service_account!="toreca-vault-dashboard@project-8ff0bbc4-675d-4596-a8a.iam.gserviceaccount.com":
    raise SystemExit("BLOCKED: dashboard runtime identity changed")
for binding in iam.get("bindings",[]):
    if binding.get("role")=="roles/run.invoker" and set(binding.get("members",[])) & {"allUsers","allAuthenticatedUsers"}:
        raise SystemExit("BLOCKED: dashboard has public invoker permission")
print("PASS: existing private dashboard environment, identity and restricted IAM verified")
PY
mkdir -p "$WORK/build/cloud" "$WORK/build/v2"
cp cloud/Dockerfile.dashboard "$WORK/build/Dockerfile"
cp cloud/package.json cloud/package-lock.json "$WORK/build/cloud/"
cp -a cloud/src "$WORK/build/cloud/src"
cp v2/core.js "$WORK/build/v2/core.js"
# Omit --set-env-vars and IAM commands: existing access, secrets and IAP
# allowlist remain untouched. Only staged dashboard source changes.
gcloud run deploy "$SERVICE" --source="$WORK/build" \
  --project="$PROJECT" --region="$REGION" \
  --service-account="toreca-vault-dashboard@project-8ff0bbc4-675d-4596-a8a.iam.gserviceaccount.com" \
  --min-instances=0 --max-instances=1 --cpu=1 --memory=512Mi \
  --cpu-throttling --concurrency=40 --timeout=30s --quiet
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format=json > "$WORK/after.json"
python3 - "$WORK/after.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
conditions=x.get("status",{}).get("conditions",[])
if not any(c.get("type")=="Ready" and c.get("status")=="True" for c in conditions):
    raise SystemExit("BLOCKED: UI deploy completed but dashboard Ready has not been confirmed")
print("PASS: existing private staging dashboard deployed and Ready")
print("Grok report values show as unverified; audited reference valuation unchanged")
PY
