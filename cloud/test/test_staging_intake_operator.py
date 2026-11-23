"""Offline staging operator target-guard tests; no gcloud calls."""
import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / 'scripts' / 'staging-intake-operator.py'
spec = importlib.util.spec_from_file_location('staging_intake_operator', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

SERVICE = {'status': {'url': 'https://toreca-vault-staging-example.run.app',
                      'traffic': [{'revisionName': 'toreca-vault-staging-123', 'percent': 100}]}}
JOB = {'state': 'ENABLED', 'httpTarget': {
    'uri': 'https://toreca-vault-staging-example.run.app/internal/worker/sheets-intake',
    'httpMethod': 'POST',
    'oidcToken': {'serviceAccountEmail': 'staging-job@example.iam.gserviceaccount.com',
                  'audience': 'https://toreca-vault-staging-example.run.app'}}}


class OperatorContract(unittest.TestCase):
    def test_exact_staging_is_allowed(self):
        self.assertEqual(mod.validate_target(mod.PROJECT_NUMBER, SERVICE, JOB),
                         'toreca-vault-staging-123')

    def test_other_project_is_blocked(self):
        with self.assertRaises(mod.Blocked):
            mod.validate_target('11111', SERVICE, JOB)

    def test_other_service_is_blocked(self):
        other = dict(JOB, httpTarget=dict(JOB['httpTarget'],
                     uri='https://another-app.run.app/internal/worker/sheets-intake'))
        with self.assertRaises(mod.Blocked):
            mod.validate_target(mod.PROJECT_NUMBER, SERVICE, other)

    def test_unexpected_worker_is_blocked(self):
        other = dict(JOB, httpTarget=dict(JOB['httpTarget'],
                     uri='https://toreca-vault-staging-example.run.app/internal/worker/commands'))
        with self.assertRaises(mod.Blocked):
            mod.validate_target(mod.PROJECT_NUMBER, SERVICE, other)

    def test_wrong_http_method_is_blocked(self):
        other = dict(JOB, httpTarget=dict(JOB['httpTarget'], httpMethod='GET'))
        with self.assertRaises(mod.Blocked):
            mod.validate_target(mod.PROJECT_NUMBER, SERVICE, other)

    def test_paused_job_is_blocked(self):
        with self.assertRaises(mod.Blocked):
            mod.validate_target(mod.PROJECT_NUMBER, SERVICE, dict(JOB, state='PAUSED'))

    def test_split_traffic_is_blocked(self):
        other = {'status': dict(SERVICE['status'], traffic=[
            {'revisionName': 'toreca-vault-staging-123', 'percent': 50},
            {'revisionName': 'toreca-vault-staging-124', 'percent': 50}])}
        with self.assertRaises(mod.Blocked):
            mod.validate_target(mod.PROJECT_NUMBER, other, JOB)


if __name__ == '__main__':
    unittest.main()
