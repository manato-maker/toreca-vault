#!/usr/bin/env bash
# Guarded staging Cloud Run API release. No production or legacy V2 writes.
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
TV2_RELEASE_MODE="$MODE" python3 - "$WORKDIR/service.json" <<'PY'
import json, sys, hashlib, os
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
required = ("TV2_ENABLE_WRITES", "TV2_ENABLE_COMMAND_QUEUE",
            "TV2_ENABLE_COMMAND_WORKER", "TV2_ENABLE_GOOGLE_SHEETS_INTAKE")
for key in required:
    print("FLAG " + key + ": " + ("enabled" if values.get(key) == "true" else "disabled"))
# A healthy preflight does not imply a functional Chat intake if any writer
# switch remains disabled. Do not silently release a revision that cannot
# complete Intake -> queue -> canonical -> receipt.
if os.environ.get("TV2_RELEASE_MODE") == "promote":
    disabled = [key for key in required if values.get(key) != "true"]
    if disabled:
        raise SystemExit("BLOCKED: Chat write/queue/intake worker features are disabled")
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
for prog in git; do
  command -v "$prog" >/dev/null || { echo "BLOCKED: git required." >&2; exit 2; }
done
[[ "$(git branch --show-current)" == "$BRANCH" ]] || {
  echo "BLOCKED: wrong development branch." >&2
  exit 2
}
[[ -z "$(git status --porcelain)" ]] || {
  echo "BLOCKED: local changes must be reviewed before release." >&2
  exit 2
}
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
[[ -n "$REMOTE_HEAD" && "$LOCAL_HEAD" == "$REMOTE_HEAD" ]] || {
  echo "BLOCKED: checkout is stale or remote cannot be verified." >&2
  exit 2
}
# Resolve the exact zero-traffic candidate before checking it.
gcloud run services describe "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --format=json > "$WORKDIR/candidate.json"
read -r REVISION CANDIDATE_URL < <(python3 - "$WORKDIR/candidate.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
traffic = data.get("status", {}).get("traffic", [])
candidate = next((x for x in traffic if x.get("tag") == "chat-candidate"), {})
revision = candidate.get("revisionName", "")
url = candidate.get("url", "")
if not revision.startswith("toreca-vault-staging-") or not url.startswith("https://"):
    raise SystemExit("BLOCKED: tagged canary revision or private URL not found")
print(revision, url)
PY
)"
# The user identity may not have direct Sheets/Firestore read access. Verify
# the candidate using the same Cloud Run runtime identity that will process
# Intake; this GET is private and strictly read-only. Do not impersonate an SA.
ID_TOKEN="$(gcloud auth print-identity-token)"
curl --fail --silent --show-error --max-time 30 \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  "${CANDIDATE_URL}/health/intake" > "$WORKDIR/intake-health.json"
unset ID_TOKEN
python3 - "$WORKDIR/intake-health.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
if data.get("ok") is not True or data.get("sheetsReadable") is not True \
        or data.get("cursorReadable") is not True or data.get("canonicalInitialized") is not True \
        or not isinstance(data.get("canonicalRevision"), int):
    raise SystemExit("BLOCKED: candidate runtime read-only Intake/queue/canonical probe failed")
allowed = {"would-apply", "canonical-duplicate", "queue-record-present",
           "request-id-collision", "business-duplicate", "business-collision", "review"}
previews = data.get("previews")
if not isinstance(previews, list) or any(row.get("outcome") not in allowed for row in previews):
    raise SystemExit("BLOCKED: candidate preview contains an unknown outcome")
print("PASS: candidate runtime identity read Intake, cursor, queue and canonical state.")
print("Read-only preview rows: " + str(len(previews)))
print("No row status, queue, cursor, or canonical data was changed by this check.")
PY
gcloud run services update-traffic "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --to-revisions="$REVISION=100" --quiet
echo "STAGING CANARY PROMOTED; still requires live Chat->Sheet->Firestore->UI readback verification."
