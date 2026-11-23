#!/usr/bin/env python3
"""Fail-closed operator for ONE existing Toreca Vault staging Intake Scheduler job.

No issue body, CLI option or environment variable can select a project, service,
job, URL or command payload. This does not directly edit Sheets or Firestore.
"""
import hashlib
import json
import subprocess
import sys
from urllib.parse import urlsplit

PROJECT = 'project-8ff0bbc4-675d-4596-a8a'
PROJECT_NUMBER = '235108293761'
REGION = 'asia-northeast1'
SERVICE = 'toreca-vault-staging'
JOB = 'toreca-vault-staging-intake'
CANONICAL = 'torecaVaultStaging/canonical'
SHEET_SHA256 = 'a191bc306fcfb2898af83fd66f72808f9f1a4b553805319cbf62e80fb29565ad'
ENDPOINT = '/internal/worker/sheets-intake'
REQUIRED_FLAGS = ('TV2_ENABLE_WRITES', 'TV2_ENABLE_COMMAND_QUEUE',
                  'TV2_ENABLE_COMMAND_WORKER', 'TV2_ENABLE_GOOGLE_SHEETS_INTAKE')


class Blocked(Exception):
    pass


def gcloud(*args):
    try:
        result = subprocess.run(['gcloud', *args], capture_output=True, text=True,
                                timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked('gcloud unavailable or timed out')
    if result.returncode:
        raise Blocked('gcloud command failed (permissions or project configuration)')
    return result.stdout.strip()


def gcloud_json(*args):
    try:
        value = json.loads(gcloud(*args))
    except (TypeError, ValueError):
        raise Blocked('unreadable gcloud metadata')
    if not isinstance(value, dict):
        raise Blocked('unexpected gcloud metadata')
    return value


def validate_target(project_number, service, job):
    if str(project_number) != PROJECT_NUMBER:
        raise Blocked('staging project number mismatch')
    url = (service.get('status') or {}).get('url', '')
    if not isinstance(url, str) or not url.startswith('https://'):
        raise Blocked('staging service URL is missing')
    url_parts = urlsplit(url)
    if url_parts.path not in ('', '/') or url_parts.query or url_parts.fragment:
        raise Blocked('staging service URL is invalid')
    traffic = (service.get('status') or {}).get('traffic') or []
    active = [v for v in traffic if isinstance(v, dict) and v.get('percent', 0) > 0]
    if len(active) != 1 or active[0].get('percent') != 100:
        raise Blocked('staging traffic is split or unverified')
    revision = active[0].get('revisionName', '')
    if not isinstance(revision, str) or not revision.startswith(SERVICE + '-'):
        raise Blocked('serving revision does not match staging service')

    target = job.get('httpTarget') or {}
    target_uri = target.get('uri', '')
    target_parts = urlsplit(target_uri) if isinstance(target_uri, str) else None
    if (not target_parts or target_parts.scheme != 'https'
        or target_parts.netloc != url_parts.netloc or target_parts.path != ENDPOINT
        or target_parts.query or target_parts.fragment):
        raise Blocked('Scheduler target is not the exact staging intake endpoint')
    if target.get('httpMethod') != 'POST':
        raise Blocked('Scheduler target method is not POST')
    if job.get('state') != 'ENABLED':
        raise Blocked('staging intake Scheduler job is not enabled')
    oidc = target.get('oidcToken') or {}
    if not (isinstance(oidc.get('serviceAccountEmail'), str)
            and oidc['serviceAccountEmail'].endswith('.gserviceaccount.com')):
        raise Blocked('Scheduler OIDC identity is missing')
    if oidc.get('audience', url).rstrip('/') != url.rstrip('/'):
        raise Blocked('Scheduler OIDC audience mismatch')
    return revision


def validate_serving_revision(revision):
    data = gcloud_json('run', 'revisions', 'describe', revision,
                       '--project', PROJECT, '--region', REGION, '--format=json')
    spec = data.get('spec') or {}
    containers = spec.get('containers') or []
    if not containers or not isinstance(containers[0], dict):
        raise Blocked('serving revision container is missing')
    env = {x.get('name'): x.get('value') for x in containers[0].get('env', [])
           if isinstance(x, dict)}
    if env.get('TV2_FIRESTORE_DOCUMENT') != CANONICAL:
        raise Blocked('serving revision points outside staging canonical')
    sheet = env.get('TV2_NEW_APP_INTAKE_SPREADSHEET_ID')
    if not isinstance(sheet, str) or hashlib.sha256(sheet.encode()).hexdigest() != SHEET_SHA256:
        raise Blocked('serving revision points to another intake sheet')
    audience = env.get('TV2_SCHEDULER_AUDIENCE', '')
    identity = env.get('TV2_SCHEDULER_SERVICE_ACCOUNT_EMAIL', '')
    if not (isinstance(audience, str) and audience.startswith('https://')
            and isinstance(identity, str) and identity.endswith('.gserviceaccount.com')):
        raise Blocked('serving revision Scheduler auth settings missing')
    disabled = [flag for flag in REQUIRED_FLAGS if env.get(flag) != 'true']
    return audience, identity, disabled


def run(mode):
    number = gcloud('projects', 'describe', PROJECT, '--format=value(projectNumber)')
    service = gcloud_json('run', 'services', 'describe', SERVICE,
                          '--project', PROJECT, '--region', REGION, '--format=json')
    job = gcloud_json('scheduler', 'jobs', 'describe', JOB,
                      '--project', PROJECT, '--location', REGION, '--format=json')
    revision = validate_target(number, service, job)
    audience, identity, disabled = validate_serving_revision(revision)
    if (job['httpTarget']['oidcToken'].get('audience', service['status']['url']).rstrip('/')
            != audience.rstrip('/')):
        raise Blocked('Scheduler audience does not match serving revision')
    if job['httpTarget']['oidcToken']['serviceAccountEmail'] != identity:
        raise Blocked('Scheduler service account does not match serving revision')
    print('PASS: correct staging project, active revision, isolated Firestore and Intake Sheet')
    print('PASS: existing Scheduler job targets the authenticated staging Intake endpoint')
    print('Writer gates: ' + ('all enabled' if not disabled else 'not all enabled'))
    if mode == 'check':
        print('READ ONLY: no queue, Scheduler, Sheet or canonical writes attempted')
        return
    if disabled:
        raise Blocked('writer gates not all enabled; refusing to retry')
    gcloud('scheduler', 'jobs', 'run', JOB, '--project', PROJECT,
           '--location', REGION, '--quiet')
    print('REQUESTED: one existing staging Intake Scheduler invocation')
    print('NOT VERIFIED: queue processing, canonical mutation, receipts and UI still require readback')


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('check', 'retry'):
        raise Blocked('usage: staging-intake-operator.py check|retry')
    run(sys.argv[1])


if __name__ == '__main__':
    try:
        main()
    except Blocked as error:
        print('BLOCKED: ' + str(error))
        sys.exit(2)
    except Exception:
        print('BLOCKED: unexpected operator error (details withheld)')
        sys.exit(2)
