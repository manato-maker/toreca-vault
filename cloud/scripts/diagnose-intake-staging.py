#!/usr/bin/env python3
"""Sanitized, read-only staging intake diagnosis from authenticated Cloud Shell.

Checks the CURRENT serving Cloud Run identity (not a guessed user identity),
Cloud Scheduler audience and destination, that identity's ability to GET the
private Intake Sheet and Firestore canonical/cursor, and counts of recent HTTP
errors. Does not call worker endpoints, enqueue, mutate Sheets, or log tokens.

Token creation uses IAM Credentials generateAccessToken with read-only Sheets
and Firestore API scopes; requires the signed-in operator to have permission
to impersonate the *existing* Cloud Run service account. If not authorized,
STOP without altering IAM. Runs using only the Python standard library.
"""
import hashlib
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

PROJECT = "project-8ff0bbc4-675d-4596-a8a"
NUMBER = "235108293761"
REGION = "asia-northeast1"
SERVICE = "toreca-vault-staging"
JOB = "toreca-vault-staging-intake"
CANONICAL = "torecaVaultStaging/canonical"
EXPECTED_SHEET_TITLE = "Toreca Vault New App Intake"
SHEET_TAB = "Intake"
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"
FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore"


class Blocked(Exception):
    """A sanitized operational failure. Never embed raw provider exceptions."""


def cli(*args):
    try:
        response = subprocess.run(["gcloud", *args], capture_output=True,
                                  text=True, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("gcloud unavailable or operation timed out")
    if response.returncode != 0:
        raise Blocked("gcloud read or authentication failed")
    return response.stdout.strip()


def cli_json(*args):
    try:
        result = json.loads(cli(*args))
    except (ValueError, TypeError):
        raise Blocked("gcloud returned unreadable metadata")
    if not isinstance(result, dict):
        raise Blocked("gcloud metadata is not an object")
    return result


def api_request(url, token, *, body=None, user_project=None):
    headers = {"authorization": "Bearer " + token,
               "accept": "application/json"}
    if body is not None:
        headers["content-type"] = "application/json"
    if user_project:
        headers["x-goog-user-project"] = user_project
    request = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers=headers, method="POST" if body is not None else "GET"
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            payload = response.read(100_001)
    except urllib.error.HTTPError as error:
        # HTTP status only. Do not emit Google API's response body, URL, or IDs.
        return error.code, None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return 0, None
    try:
        return 200, json.loads(payload)
    except (ValueError, UnicodeError):
        return 0, None


def service_config():
    actual_number = cli("projects", "describe", PROJECT,
                        "--format=value(projectNumber)")
    if actual_number != NUMBER:
        raise Blocked("GCP project number mismatch")
    data = cli_json("run", "services", "describe", SERVICE, "--project", PROJECT,
                    "--region", REGION, "--format=json")
    spec = data.get("spec", {}).get("template", {}).get("spec", {})
    containers = spec.get("containers", [])
    if not containers or not isinstance(containers[0], dict):
        raise Blocked("Cloud Run serving service configuration missing")
    env = {row.get("name"): row.get("value") for row in containers[0].get("env", [])}
    identity = spec.get("serviceAccountName")
    if not isinstance(identity, str) or not identity.endswith(".gserviceaccount.com"):
        raise Blocked("Cloud Run service account is not explicit; cannot safely test identity")
    if env.get("TV2_FIRESTORE_DOCUMENT") != CANONICAL:
        raise Blocked("Cloud Run canonical is not the dedicated staging document")
    sheet = env.get("TV2_NEW_APP_INTAKE_SPREADSHEET_ID")
    if not isinstance(sheet, str) or not 20 <= len(sheet) <= 200:
        raise Blocked("private Intake spreadsheet binding is missing")
    if any(env.get(key) != "true" for key in
           ("TV2_ENABLE_WRITES", "TV2_ENABLE_COMMAND_QUEUE",
            "TV2_ENABLE_COMMAND_WORKER", "TV2_ENABLE_GOOGLE_SHEETS_INTAKE")):
        raise Blocked("Cloud Run intake/worker write gates are not all enabled")
    audience = env.get("TV2_SCHEDULER_AUDIENCE")
    oidc_identity = env.get("TV2_SCHEDULER_SERVICE_ACCOUNT_EMAIL")
    base_url = data.get("status", {}).get("url")
    if (not isinstance(audience, str) or not audience.startswith("https://")
        or not isinstance(oidc_identity, str) or not oidc_identity.endswith(".gserviceaccount.com")
        or not isinstance(base_url, str) or not base_url.startswith("https://")):
        raise Blocked("Cloud Run Scheduler OIDC settings incomplete")
    return identity, sheet, audience, oidc_identity, base_url


def scheduler_check(audience, oidc_identity, base_url):
    job = cli_json("scheduler", "jobs", "describe", JOB, "--location", REGION,
                   "--project", PROJECT, "--format=json")
    if job.get("state") != "ENABLED":
        raise Blocked("Scheduler Intake job is not enabled")
    target = job.get("httpTarget") or {}
    oidc = target.get("oidcToken") or {}
    if oidc.get("serviceAccountEmail") != oidc_identity:
        raise Blocked("Scheduler identity differs from the identity expected by the API")
    target_audience = oidc.get("audience") or base_url
    if target_audience.rstrip("/") != audience.rstrip("/"):
        raise Blocked("Scheduler OIDC audience differs from the API configuration")
    uri = target.get("uri") or ""
    parsed = urllib.parse.urlsplit(uri)
    base = urllib.parse.urlsplit(base_url)
    if (parsed.scheme != "https" or parsed.netloc != base.netloc
        or parsed.path != "/internal/worker/sheets-intake"):
        raise Blocked("Scheduler Intake job is targeting a different Cloud Run endpoint")
    if target.get("httpMethod") != "POST":
        raise Blocked("Scheduler Intake job must use HTTP POST")
    print("PASS: intake Scheduler OIDC, endpoint and method match service")
    # This proves configuration, NOT a successful live Scheduler invocation.


def read_only_service_token(identity):
    operator_token = cli("auth", "print-access-token")
    if len(operator_token) < 32 or any(ch.isspace() for ch in operator_token):
        raise Blocked("Cloud Shell operator authentication unavailable")
    escaped_identity = urllib.parse.quote(identity, safe="@")
    iam_url = (
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/"
        + escaped_identity + ":generateAccessToken"
    )
    status, result = api_request(iam_url, operator_token, body={
        "scope": [SHEETS_SCOPE, FIRESTORE_SCOPE], "lifetime": "600s"
    })
    if status != 200 or not isinstance(result, dict):
        print("BLOCKED: could not impersonate Cloud Run service identity for read-only checks")
        print("No IAM changes made. Do not grant public access or post any token.")
        return None
    token = result.get("accessToken", "")
    if not isinstance(token, str) or len(token) < 32 or any(x.isspace() for x in token):
        return None
    return token


def check_reads(token, sheet):
    meta = ("https://sheets.googleapis.com/v4/spreadsheets/"
            + urllib.parse.quote(sheet, safe="")
            + "?fields=properties.title,sheets.properties.title")
    status, body = api_request(meta, token, user_project=PROJECT)
    if status != 200 or not isinstance(body, dict):
        print("BLOCKED: Cloud Run identity cannot read Intake metadata; HTTP " + str(status))
        return False
    titles = [x.get("properties", {}).get("title") for x in body.get("sheets", [])]
    if body.get("properties", {}).get("title") != EXPECTED_SHEET_TITLE or SHEET_TAB not in titles:
        print("BLOCKED: service identity sees a different sheet or tab")
        return False
    print("PASS: Cloud Run identity can read exact private Intake Sheet metadata")

    # No row bodies are printed, stored or copied into GitHub.
    page = urllib.parse.quote("Intake!D2:G21", safe="")
    uri = ("https://sheets.googleapis.com/v4/spreadsheets/"
           + urllib.parse.quote(sheet, safe="") + "/values/" + page
           + "?valueRenderOption=UNFORMATTED_VALUE")
    status, result = api_request(uri, token, user_project=PROJECT)
    if status != 200 or not isinstance(result, dict):
        print("BLOCKED: Cloud Run identity cannot read Intake receipt rows; HTTP " + str(status))
        return False
    counts = {}
    for values in result.get("values", []):
        status_value = str(values[0] if values else "").strip()
        if status_value in ("new", "queued", "review", "v2-applied", "duplicate"):
            counts[status_value] = counts.get(status_value, 0) + 1
    print("PASS: Intake receipt read is authorized (20-row sample; status counts only)")
    for key in ("new", "queued", "review", "v2-applied", "duplicate"):
        print("  " + key + ": " + str(counts.get(key, 0)))

    base = ("https://firestore.googleapis.com/v1/projects/" + PROJECT
            + "/databases/(default)/documents/")
    canonical_uri = base + urllib.parse.quote(CANONICAL, safe="/") + "?fields=name"
    status, _ = api_request(canonical_uri, token, user_project=PROJECT)
    if status != 200:
        print("BLOCKED: Cloud Run identity cannot read staging canonical; HTTP " + str(status))
        return False
    print("PASS: Cloud Run identity can read Firestore staging canonical")

    cursor_id = hashlib.sha256(sheet.encode("utf-8")).hexdigest()
    cursor_uri = (base + "torecaVaultNewAppIntakeCursors/"
                  + cursor_id + "?fields=name")
    status, _ = api_request(cursor_uri, token, user_project=PROJECT)
    if status not in (200, 404):
        print("BLOCKED: Cloud Run identity cannot read Firestore intake cursor; HTTP " + str(status))
        return False
    print("PASS: Firestore Intake cursor is readable" if status == 200
          else "REVIEW: cursor does not exist; verify initialization (404)")
    return True


def current_error_count():
    try:
        query = (
            'resource.type="cloud_run_revision" AND '
            'resource.labels.service_name="toreca-vault-staging" AND '
            'httpRequest.status>=500'
        )
        out = cli("logging", "read", query, "--project", PROJECT,
                  "--freshness=24h", "--limit=30", "--format=json")
        errors = json.loads(out or "[]")
        if isinstance(errors, list):
            totals = {}
            for entry in errors:
                code = (entry.get("httpRequest") or {}).get("status")
                if code in (500, 502, 503, 504):
                    totals[code] = totals.get(code, 0) + 1
            print("INFO: last 24h HTTP 5xx (up to 30 entries): "
                  + ", ".join(str(k) + "=" + str(v) for k, v in sorted(totals.items())))
    except (Blocked, ValueError, TypeError):
        print("REVIEW: Cloud Run error count unavailable (no secrets displayed)")


def main():
    if len(sys.argv) != 1:
        raise Blocked("no command-line arguments are accepted")
    identity, sheet, audience, oidc_identity, base_url = service_config()
    print("PASS: exact staging project, Cloud Run identity and required gates")
    scheduler_check(audience, oidc_identity, base_url)
    current_error_count()
    token = read_only_service_token(identity)
    if not token:
        return 2
    if not check_reads(token, sheet):
        return 2
    print("PASS: read-only dependency probe passed. Does NOT validate write permission or worker operation.")
    print("DO NOT promote before independent authenticated worker and canonical-readback verification.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Blocked as error:
        print("BLOCKED: " + str(error))
        sys.exit(2)
    except Exception:
        print("BLOCKED: unexpected read-only diagnostic failure (details hidden)")
        sys.exit(2)
