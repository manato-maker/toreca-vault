#!/usr/bin/env bash
# Guarded staging Cloud Run API release. No production/V2/queue mutations.
# Run only on the authorized Google Cloud Shell from the repository root.
set -euo pipefail
MODE=check
if [[ "$#" -gt 0 ]]; then MODE="$1"; fi
PROJECT="project-8ff0bbc4-675d-4596-a8a"
NUMBER="235108293761"
REGION="asia-northeast1"
SERVICE="toreca-vault-staging"
BRANCH="build/cloudrun-firestore-foundation-20261103"

if [[ "$MODE" != "check" && "$MODE" != "stage" && "$MODE" != "promote" ]]; then
  echo "Usage: bash cloud/scripts/release-chat-staging.sh check|stage|promote" >&2
  exit 2
fi
for prog in gcloud python3; do
  command -v "$prog" >/dev/null || { echo "BLOCKED: $prog required." >&2; exit 2; }
done
if [[ ! -f cloud/Dockerfile || ! -f cloud/src/server.js || ! -f v2/core.js ]]; then
  echo "BLOCKED: repository root required." >&2
  exit 2
fi
ACTUAL="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
[[ "$ACTUAL" == "$NUMBER" ]] || { echo "BLOCKED: project number mismatch." >&2; exit 2; }
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
chmod 700 "$WORKDIR"

gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format=json > "$WORKDIR/service.json"
python3 - "$WORKDIR/service.json" <<'PY'
import json, sys, hashlib
data = json.load(open(sys.argv[1], encoding="utf-8"))
container = data.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
if not container:
    container = data.get("template", {}).get("containers", [])
if not container:
    raise SystemExit("BLOCKED: existing service container missing")
values = {entry.get("name"): entry.get("value") for entry in container[0].get("env", [])}
if values.get("TV2_FIRESTORE_DOCUMENT") != "torecaVaultStaging/canonical":
    raise SystemExit("BLOCKED: canonical document not the dedicated staging path")
if "TV2_API_TOKEN" not in values:
    raise SystemExit("BLOCKED: API token binding missing")
sheet_id = values.get("TV2_NEW_APP_INTAKE_SPREADSHEET_ID", "")
if not isinstance(sheet_id, str) or hashlib.sha256(sheet_id.encode("utf-8")).hexdigest() != "a191bc306fcfb2898af83fd66f72808f9f1a4b553805319cbf62e80fb29565ad":
    raise SystemExit("BLOCKED: wrong intake sheet binding")
if not values.get("TV2_SCHEDULER_AUDIENCE") or not values.get("TV2_SCHEDULER_SERVICE_ACCOUNT_EMAIL"):
    raise SystemExit("BLOCKED: OIDC config not present")
print("PASS: expected staging document, isolated intake, and OIDC bindings.")
for key in ("TV2_ENABLE_WRITES", "TV2_ENABLE_COMMAND_QUEUE",
            "TV2_ENABLE_COMMAND_WORKER", "TV2_ENABLE_GOOGLE_SHEETS_INTAKE"):
    print("FLAG " + key + ": " + ("enabled" if values.get(key) == "true" else "disabled"))
print("No token or private record value printed.")
PY
gcloud run services get-iam-policy "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --format=json > "$WORKDIR/iam.json"
python3 - "$WORKDIR/iam.json" <<'PY'
import json, sys
iam = json.load(open(sys.argv[1], encoding="utf-8"))
for binding in iam.get("bindings", []):
    if binding.get("role") == "roles/run.invoker" and set(binding.get("members", [])) & {"allUsers", "allAuthenticatedUsers"}:
        raise SystemExit("BLOCKED: staging API has an overly broad invoker grant")
print("PASS: no public Cloud Run invoker grant")
PY

if [[ "$MODE" == "check" ]]; then
  echo "READ-ONLY: check complete; no changes made."
  exit 0
fi

if [[ "$MODE" == "stage" ]]; then
  for prog in node npm git; do
    command -v "$prog" >/dev/null || { echo "BLOCKED: $prog required." >&2; exit 2; }
  done
  [[ "$(git branch --show-current)" == "$BRANCH" ]] || { echo "BLOCKED: wrong branch." >&2; exit 2; }
  [[ -z "$(git status --porcelain)" ]] || { echo "BLOCKED: uncommitted changes." >&2; exit 2; }
  npm ci --prefix cloud --no-audit --no-fund
  npm run check --prefix cloud
  npm test --prefix cloud
  mkdir -p "$WORKDIR/build/cloud" "$WORKDIR/build/v2"
  cp cloud/Dockerfile "$WORKDIR/build/Dockerfile"
  cp cloud/package.json cloud/package-lock.json "$WORKDIR/build/cloud/"
  cp -a cloud/src "$WORKDIR/build/cloud/src"
  cp v2/core.js "$WORKDIR/build/v2/core.js"
  # Deliberately no --set-env-vars or --set-secrets: they could erase existing configuration.
  # --no-traffic leaves existing serving revision active; tag is for canary verification.
  gcloud run deploy "$SERVICE" --source="$WORKDIR/build" \
    --project="$PROJECT" --region="$REGION" \
    --no-traffic --tag=chat-candidate \
    --no-allow-unauthenticated \
    --min-instances=0 --max-instances=1 --cpu-throttling \
    --quiet
  echo "STAGED AT ZERO TRAFFIC; verify candidate health, IAP/OIDC, Scheduler, intake, and inventory."
  exit 0
fi

# Promotion requires a separate explicit, human-reviewed release decision.
[[ "$(printenv TV2_STAGING_RELEASE_REVIEWED || true)" == "YES" ]] || {
  echo "BLOCKED: verified canary not approved. TV2_STAGING_RELEASE_REVIEWED=YES required." >&2
  exit 2
}
command -v node >/dev/null || { echo "BLOCKED: node required." >&2; exit 2; }
# Extract the private spreadsheet binding only into this process environment.
export TV2_NEW_APP_INTAKE_SPREADSHEET_ID="$(python3 - "$WORKDIR/service.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
containers = data.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
if not containers:
    containers = data.get("template", {}).get("containers", [])
match = next((e.get("value", "") for e in containers[0].get("env", [])
              if e.get("name") == "TV2_NEW_APP_INTAKE_SPREADSHEET_ID"), "")
print(match)
PY
)"
node cloud/scripts/preflight-chat-staging.js
gcloud run services describe "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --format=json > "$WORKDIR/candidate.json"
REVISION="$(python3 - "$WORKDIR/candidate.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
traffic = data.get("status", {}).get("traffic", [])
revision = next((x.get("revisionName") for x in traffic if x.get("tag") == "chat-candidate"), "")
if not revision.startswith("toreca-vault-staging-"):
    raise SystemExit("BLOCKED: tagged canary revision not found")
print(revision)
PY
)"
gcloud run services update-traffic "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --to-revisions="$REVISION=100" --quiet
echo "STAGING CANARY PROMOTED; still requires live Chat->Sheet->Firestore->UI readback verification."
