import contextlib
import importlib.util
import io
import pathlib
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "diagnose-intake-staging.py"
SPEC = importlib.util.spec_from_file_location("safe_intake_diagnostics", SOURCE)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)

SERVICE_ACCOUNT = "worker@project-8ff0bbc4-675d-4596-a8a.iam.gserviceaccount.com"
AUDIENCE = "https://toreca-vault-staging-xyz.a.run.app"
SHEET_ID = "1abcdefghijklmnopqrstuvwxyz0123456789"


class TestIntakeDiagnosis(unittest.TestCase):
    def test_cloud_run_config_exact_project_service_identity_and_flags(self):
        response = {
            "spec": {"template": {"spec": {
                "serviceAccountName": SERVICE_ACCOUNT,
                "containers": [{"env": [
                    {"name": "TV2_FIRESTORE_DOCUMENT", "value": probe.CANONICAL},
                    {"name": "TV2_NEW_APP_INTAKE_SPREADSHEET_ID", "value": SHEET_ID},
                    {"name": "TV2_SCHEDULER_AUDIENCE", "value": AUDIENCE},
                    {"name": "TV2_SCHEDULER_SERVICE_ACCOUNT_EMAIL", "value": SERVICE_ACCOUNT},
                    *[{"name": key, "value": "true"} for key in (
                        "TV2_ENABLE_WRITES", "TV2_ENABLE_COMMAND_QUEUE",
                        "TV2_ENABLE_COMMAND_WORKER", "TV2_ENABLE_GOOGLE_SHEETS_INTAKE")]
                ]}]
            }}},
            "status": {"url": AUDIENCE}
        }
        with patch.object(probe, "cli", return_value=probe.NUMBER), patch.object(
            probe, "cli_json", return_value=response
        ):
            result = probe.service_config()
            self.assertEqual(result, (SERVICE_ACCOUNT, SHEET_ID, AUDIENCE, SERVICE_ACCOUNT, AUDIENCE))
            response["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = "torecaVaultV2/canonical"
            with self.assertRaises(probe.Blocked):
                probe.service_config()

    def test_wrong_scheduler_audience_or_target_is_rejected_without_mutation(self):
        job = {"state": "ENABLED", "httpTarget": {
            "uri": AUDIENCE + "/internal/worker/sheets-intake",
            "httpMethod": "POST", "oidcToken": {
                "serviceAccountEmail": SERVICE_ACCOUNT, "audience": AUDIENCE
            }
        }}
        output = io.StringIO()
        with patch.object(probe, "cli_json", return_value=job), contextlib.redirect_stdout(output):
            probe.scheduler_check(AUDIENCE, SERVICE_ACCOUNT, AUDIENCE)
        self.assertIn("PASS", output.getvalue())
        self.assertNotIn(SERVICE_ACCOUNT, output.getvalue())
        job["httpTarget"]["uri"] = AUDIENCE + "/internal/worker/commands"
        with patch.object(probe, "cli_json", return_value=job):
            with self.assertRaises(probe.Blocked):
                probe.scheduler_check(AUDIENCE, SERVICE_ACCOUNT, AUDIENCE)
        job["httpTarget"]["uri"] = AUDIENCE + "/internal/worker/sheets-intake"
        job["httpTarget"]["oidcToken"]["audience"] = "https://incorrect.example.com"
        with patch.object(probe, "cli_json", return_value=job):
            with self.assertRaises(probe.Blocked):
                probe.scheduler_check(AUDIENCE, SERVICE_ACCOUNT, AUDIENCE)

    def test_impersonation_failure_fails_closed_and_never_outputs_user_token(self):
        token = "synthetic-super-secret-operator-token-123456789"
        output = io.StringIO()
        with patch.object(probe, "cli", return_value=token), patch.object(
            probe, "api_request", return_value=(403, None)
        ) as request, contextlib.redirect_stdout(output):
            self.assertIsNone(probe.read_only_service_token(SERVICE_ACCOUNT))
        self.assertNotIn(token, output.getvalue())
        self.assertNotIn(SERVICE_ACCOUNT, output.getvalue())
        self.assertEqual(request.call_count, 1)
        args, kwargs = request.call_args
        self.assertTrue(args[0].endswith(":generateAccessToken"))
        self.assertEqual(kwargs["body"]["scope"],
                         [probe.SHEETS_SCOPE, probe.FIRESTORE_SCOPE])
        self.assertEqual(kwargs["body"]["lifetime"], "600s")

    def test_read_only_apis_check_status_without_leaking_sheet_values(self):
        opaque = "secret-user@example.com password=abc123"
        responses = [
            (200, {"properties": {"title": probe.EXPECTED_SHEET_TITLE},
                   "sheets": [{"properties": {"title": probe.SHEET_TAB}}]}),
            (200, {"values": [["queued", opaque], ["review", opaque],
                              ["new", opaque], ["v2-applied", opaque]]}),
            (200, {"name": "private-document-name"}),
            (404, None)
        ]
        output = io.StringIO()
        with patch.object(probe, "api_request", side_effect=responses) as api, contextlib.redirect_stdout(output):
            self.assertTrue(probe.check_reads("sample-token", SHEET_ID))
        self.assertEqual(api.call_count, 4)
        self.assertEqual(api.call_args_list[0][0][1], "sample-token")
        self.assertTrue(all(call.kwargs.get("body") is None for call in api.call_args_list))
        self.assertNotIn(opaque, output.getvalue())
        self.assertNotIn(SHEET_ID, output.getvalue())
        self.assertNotIn("sample-token", output.getvalue())
        self.assertIn("queued: 1", output.getvalue())
        self.assertIn("REVIEW: cursor does not exist", output.getvalue())

    def test_insufficient_sheets_permission_stops_before_firestore(self):
        output = io.StringIO()
        with patch.object(probe, "api_request", return_value=(403, None)) as api, contextlib.redirect_stdout(output):
            self.assertFalse(probe.check_reads("opaque-token", SHEET_ID))
        self.assertEqual(api.call_count, 1)
        self.assertIn("HTTP 403", output.getvalue())
        self.assertNotIn("opaque-token", output.getvalue())
        self.assertNotIn(SHEET_ID, output.getvalue())

    def test_source_uses_only_get_for_data_reads_and_never_calls_worker_endpoint(self):
        source = SOURCE.read_text(encoding="utf-8")
        self.assertIn('method="POST" if body is not None else "GET"', source)
        self.assertIn('"https://www.googleapis.com/auth/spreadsheets.readonly"', source)
        self.assertNotIn("jobs run", source)
        self.assertNotIn("update-traffic", source)
        self.assertNotIn("services update", source)
        self.assertNotIn("iam-policy-binding", source)
        self.assertNotIn("accessToken" + "):", source)  # no token logging
        self.assertNotIn("print(operator_token)", source)
        self.assertNotIn("print(token)", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
