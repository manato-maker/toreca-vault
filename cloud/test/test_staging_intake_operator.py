"""Offline staging operator target-guard tests; no gcloud calls."""
import importlib.util
import pathlib
import re
import unittest
from unittest import mock

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
    def test_gcp_wif_display_names_fit_provider_limit(self):
        script = (SCRIPT.parent / 'bootstrap-staging-operator-wif.sh').read_text()
        for command in (
            'gcloud iam workload-identity-pools create',
            'gcloud iam workload-identity-pools providers create-oidc',
        ):
            match = re.search(re.escape(command) + r'[\s\S]*?--display-name="([^"]+)"', script)
            self.assertIsNotNone(match, command)
            self.assertLessEqual(len(match.group(1)), 32, command)

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


    def test_service_domain_must_be_cloud_run_and_staging(self):
        altered = {'status': dict(SERVICE['status'], url='https://toreca-vault-staging-evil.example.org')}
        with self.assertRaises(mod.Blocked):
            mod.validate_target(mod.PROJECT_NUMBER, altered, JOB)

    def test_scheduler_oidc_audience_must_match(self):
        target = dict(JOB['httpTarget'], oidcToken=dict(JOB['httpTarget']['oidcToken'],
                     audience='https://other.example.run.app'))
        with self.assertRaises(mod.Blocked):
            mod.validate_target(mod.PROJECT_NUMBER, SERVICE, dict(JOB, httpTarget=target))

    def test_serving_revision_rejects_other_canonical(self):
        data = {'spec': {'containers': [{'env': [
            {'name': 'TV2_FIRESTORE_DOCUMENT', 'value': 'another/production'},
        ]}]}}
        with mock.patch.object(mod, 'gcloud_json', return_value=data):
            with self.assertRaises(mod.Blocked):
                mod.validate_serving_revision('toreca-vault-staging-123')

    def test_retry_is_disabled_before_any_gcloud_call(self):
        with mock.patch.dict(mod.os.environ, {'TV_STAGING_OPERATOR_RETRY_ENABLED': ''}), \
             mock.patch.object(mod, 'gcloud') as cloud:
            with self.assertRaises(mod.Blocked):
                mod.run('retry')
            cloud.assert_not_called()

    @staticmethod
    def _simulate(mode, enabled_flags):
        with mock.patch.dict(mod.os.environ, {'TV_STAGING_OPERATOR_RETRY_ENABLED': 'true'}), \
             mock.patch.object(mod, 'gcloud', return_value=mod.PROJECT_NUMBER) as cloud, \
             mock.patch.object(mod, 'gcloud_json', side_effect=[SERVICE, JOB]), \
             mock.patch.object(mod, 'validate_serving_revision',
                               return_value=(SERVICE['status']['url'],
                                             JOB['httpTarget']['oidcToken']['serviceAccountEmail'],
                                             enabled_flags)):
            if enabled_flags and mode == 'retry':
                with unittest.TestCase().assertRaises(mod.Blocked):
                    mod.run(mode)
            else:
                mod.run(mode)
            return cloud.call_args_list

    def test_check_never_invokes_scheduler(self):
        calls = self._simulate('check', ['TV2_ENABLE_WRITES'])
        self.assertEqual(len(calls), 1)

    def test_retry_rejects_disabled_writer_gates(self):
        calls = self._simulate('retry', ['TV2_ENABLE_WRITES'])
        self.assertEqual(len(calls), 1)

    def test_retry_invokes_exactly_one_known_job_when_enabled(self):
        calls = self._simulate('retry', [])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[-1], mock.call('scheduler', 'jobs', 'run', mod.JOB,
                         '--project', mod.PROJECT, '--location', mod.REGION, '--quiet'))


if __name__ == '__main__':
    unittest.main()
