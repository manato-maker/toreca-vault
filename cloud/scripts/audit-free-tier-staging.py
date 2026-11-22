#!/usr/bin/env python3
"""READ-ONLY cost-risk audit for Toreca Vault staging.

Usage, in authenticated Google Cloud Shell from repository root:
    python3 cloud/scripts/audit-free-tier-staging.py

No resource mutation, IAM change, secret read, billing-budget creation or
actual billed-usage query is performed. This is a configuration audit, NOT
a zero-cost guarantee. Requires gcloud access to the selected project.
"""
import json
import shutil
import subprocess
import sys

PROJECT = "project-8ff0bbc4-675d-4596-a8a"
PROJECT_NUMBER = "235108293761"
REGION = "asia-northeast1"
SERVICES = ("toreca-vault-staging", "toreca-vault-ui-staging")

WARNINGS = []
UNVERIFIED = []


def run(*args):
    """Call only explicitly whitelisted gcloud read commands."""
    result = subprocess.run(
        ["gcloud", *args, "--project=" + PROJECT, "--format=json"],
        capture_output=True, text=True, timeout=35, check=False
    )
    if result.returncode != 0:
        # Deliberately do not print raw stderr: provider details may be private.
        return None
    try:
        return json.loads(result.stdout or "{}")
    except (ValueError, TypeError):
        return None


def check_project():
    data = run("projects", "describe", PROJECT)
    if not isinstance(data, dict) or str(data.get("projectNumber", "")) != PROJECT_NUMBER:
        print("BLOCKED: Project number mismatch or missing permission.")
        return False
    print("PASS: expected staging project and project number verified.")
    return True


def variants(d, *paths):
    for keys in paths:
        cur = d
        for key in keys:
            cur = cur.get(key) if isinstance(cur, dict) else None
        if cur is not None:
            return cur
    return None


def integer_or_none(value):
    try:
        return int(value) if value is not None and str(value).strip() else None
    except (ValueError, TypeError):
        return None


def check_service(service):
    data = run("run", "services", "describe", service, "--region=" + REGION)
    if not isinstance(data, dict) or not data:
        UNVERIFIED.append("Cloud Run " + service + " (not found or no read permission)")
        return
    annotations = data.get("metadata", {}).get("annotations", {}) or {}
    template = variants(data, ("spec", "template"), ("template",)) or {}
    tmeta = template.get("metadata", {}) or {}
    tann = tmeta.get("annotations", {}) or {}
    scaling = data.get("scaling", {}) or {}
    max_num = integer_or_none(variants(
        data, ("scaling", "maxInstanceCount"), ("spec", "template", "metadata", "annotations", "autoscaling.knative.dev/maxScale"),
        ("template", "scaling", "maxInstanceCount")
    ))
    if max_num is None:
        max_num = integer_or_none(annotations.get("run.googleapis.com/maxScale") or tann.get("autoscaling.knative.dev/maxScale"))
    min_num = integer_or_none(variants(data, ("scaling", "minInstanceCount"), ("template", "scaling", "minInstanceCount")))
    if min_num is None:
        min_num = integer_or_none(annotations.get("run.googleapis.com/minScale") or
                                  tann.get("autoscaling.knative.dev/minScale") or
                                  tann.get("autoscaling.knative.dev/minScale"))
    if min_num is None:
        min_num = 0  # Cloud Run default when neither minimum is specified.

    cpu_throttling = tann.get("run.googleapis.com/cpu-throttling")
    if cpu_throttling is None:
        cpu_throttling = annotations.get("run.googleapis.com/cpu-throttling")
    # Cloud Run default (no annotation) is request-based billing.
    is_request_based = cpu_throttling is None or str(cpu_throttling).lower() == "true"

    print(f"Cloud Run {service}: min={min_num}, max={max_num if max_num is not None else 'unknown'}, "
          f"billing={'request-based/default' if is_request_based else 'instance-based'}")
    if min_num > 0:
        WARNINGS.append(service + ": min instances > 0 may incur idle charges")
    if not is_request_based:
        WARNINGS.append(service + ": instance-based billing configured")
    if max_num is None:
        UNVERIFIED.append(service + ": unable to verify configured maximum instances")
    elif max_num > 2:
        WARNINGS.append(service + f": maximum instances {max_num} exceeds conservative staging target 2")


def check_firestore():
    dbs = run("firestore", "databases", "list")
    if not isinstance(dbs, list):
        UNVERIFIED.append("Firestore database list/edition/free-quota eligibility")
        return
    names = [str(db.get("name", "")).split("/")[-1] for db in dbs if isinstance(db, dict)]
    if "(default)" in names:
        print("PASS: Firestore (default) database exists (free eligibility still needs usage review).")
    else:
        WARNINGS.append("Firestore (default) not found; named databases may not get free quota")
    other = [name for name in names if name and name != "(default)"]
    if other:
        WARNINGS.append(f"{len(other)} additional named Firestore database(s): free quota not guaranteed")


def check_scheduler():
    jobs = run("scheduler", "jobs", "list", "--location=" + REGION)
    if not isinstance(jobs, list):
        UNVERIFIED.append("Scheduler jobs in " + REGION)
        return
    count = len(jobs)
    print(f"Cloud Scheduler: {count} job(s) in {REGION} (paused jobs count).")
    if count > 3:
        WARNINGS.append("More than 3 Scheduler jobs in the inspected region.")
    # Free quota is across the BILLING ACCOUNT, not the project/region.
    UNVERIFIED.append("Scheduler jobs in other projects/regions linked to the same billing account")


def check_billing():
    data = run("billing", "projects", "describe", PROJECT)
    if not isinstance(data, dict):
        UNVERIFIED.append("Cloud Billing status, actual charges, and budgets")
        return
    print("Cloud Billing linked/enabled: " + ("yes" if data.get("billingEnabled") else "no/unknown"))
    if not data.get("billingEnabled"):
        WARNINGS.append("Cloud Billing is not enabled or could not be verified")
    UNVERIFIED.append("Actual current-month charges and billing-account-wide free-tier usage")
    UNVERIFIED.append("Budget alert/spend cap configuration (alerts alone do not stop billing)")


def main():
    if shutil.which("gcloud") is None:
        print("BLOCKED: Run in Google Cloud Shell; gcloud is not installed.")
        return 2
    if not check_project():
        return 2

    check_billing()
    for service in SERVICES:
        check_service(service)
    check_firestore()
    check_scheduler()

    print("\nRead-only audit complete. No resources or permissions changed.")
    print("Note: Cloud Build, Artifact Registry, backups, egress, AI/OCR and X API use")
    print("must be checked against actual monthly usage and separate provider pricing.")
    for item in WARNINGS:
        print("WARNING: " + item)
    for item in UNVERIFIED:
        print("UNVERIFIED: " + item)
    print("\nThis check cannot certify a ¥0 bill or enforce a spending cap.")
    if WARNINGS:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
