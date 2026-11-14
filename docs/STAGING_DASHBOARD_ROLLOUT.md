# Toreca Vault staging UI — separate read-only Cloud Run service

Updated: 2026-11-13 JST. Status: **code prepared on PR #105 branch; not deployed or IAP-enabled yet.**

## Why separate the UI

The existing private Cloud Run service, `toreca-vault-staging`, is an API and its `/` URL intentionally returns HTTP 404. It is used by Cloud Scheduler with OIDC for Sheets intake and the command worker. Turning on IAP for that existing service can interrupt its scheduled requests. **Do not modify its IAP or IAM settings just to add the browser view.**

The new `toreca-vault-ui-staging` service runs `cloud/src/dashboard-server.js`, has **GET/HEAD only**, reads the isolated Firestore staging canonical document, and does not expose command creation, sale processing, or write routes. It renders summary assets, inventory, calendar and recent transactions as responsive server-side HTML.

The UI accepts **only a Google-signed IAP JWT** for its own Cloud Run audience, then requires the verified email to be on an explicit allowlist. It does not use the unsigned identity headers and never puts an API token in JavaScript. Rendering escapes product and other user data; responses are non-cacheable with a restrictive CSP. If IAP is disabled, no signed JWT reaches the app and access is refused.

Staging data is distinct from the old V2. The purchase that was applied in staging on November 12 is not evidence of live old-V2 migration or operational Chat/Gmail integration.

## Safeguards

- Existing API/worker service is unchanged by the deployment script.
- The dashboard service must use project `project-8ff0bbc4-675d-4596-a8a` (number `235108293761`), region `asia-northeast1`, canonical document `torecaVaultStaging/canonical`.
- A dedicated `toreca-vault-dashboard` service account receives `roles/datastore.viewer`, **not Editor**.
- Cloud Run UI starts private with `--no-allow-unauthenticated`; no public website flag.
- Only a named user's email may pass the application-level allowlist (configured in Cloud Shell from the active Google account, or explicitly via `TV2_DASHBOARD_OWNER_EMAIL`).
- No writes, imports, billing plan changes, queues, cron jobs, old V2 trigger, or sales replay are performed by the UI.

## Deployment from Cloud Shell (after reviewing the script)

Use a new Cloud Shell tab on a trusted Google Cloud Console session:

~~~bash
git clone --depth 1 --branch build/cloudrun-firestore-foundation-20261103 \
  https://github.com/manato-maker/toreca-vault.git
cd toreca-vault
cat cloud/scripts/deploy-dashboard-staging.sh
bash cloud/scripts/deploy-dashboard-staging.sh
~~~

The script creates a separate service account and Cloud Run UI service and may incur additional low-volume Google Cloud costs. It **does not** turn on IAP. If `git clone` already exists, switch to the project directory and `git pull` instead of overwriting files. Check the Cloud project and active identity before executing.

## Finish login in Console

1. In Cloud Run, select **toreca-vault-ui-staging**, not **toreca-vault-staging**.
2. Security: choose **Require authentication → Identity-Aware Proxy (IAP)**, then save/redeploy the UI service. Google Console may ask to complete/choose OAuth client settings. **Do not share the OAuth client secret or JSON.**
3. In the UI service's IAP policy, grant only the authorized Google account the `IAP-secured Web App User` role. If IAP cannot invoke the private service, grant the IAP service agent `roles/run.invoker` on the UI service only.
4. Open the newly reported **UI** run.app URL in a normal mobile browser with the authorized Google account. Verify: sign-in, summary tiles, calendar events, inventory, recent transactions, no write buttons.
5. Verify the original API's `/health`, command status, and scheduled intake job separately to ensure no regressions.

Do not enable IAP on the original API as part of this rollout. If the new service returns 403, validate the signed JWT audience, IAP role, and application allowlist. If it returns 503, confirm read-only service account access to the staging canonical document. Never work around these errors by allowing public access.

## Verification status

The view, IAP verifier, server and unit tests are in `cloud/src/dashboard-*.js` and `cloud/test/dashboard.test.js`. Tests are included in `npm test --prefix cloud` and syntax checks in `npm run check --prefix cloud`. No successful real-Cloud UI deployment, IAP login, or mobile-device E2E has been verified yet.


## Shared Chat/Work handover: latest document link and on-demand download (2026-11-14 design/code)

- **Goal:** Regular Chat handles lottery/purchase/receipt/opening/sales reports; Work handles engineering, repairs and deployments. Both consult and append relevant decisions/verification to the same private Google Doc, **Toreca Vault Handoff (CURRENT)**. Keeping development code and daily reports separate avoids thread-limit handoff friction.
- **One source of truth for the handover:** the private Google Doc. Do not duplicate its personal business data into a public GitHub markdown file. GitHub `docs/NEW_DESIGN_HANDOVER.md`, `docs/HANDOVER.md` and `docs/X_BUYBACK_QUOTES_SPEC.md` remain technical/operational references with privacy-safe details, **not a second automatically synchronized user-data canonical**.
- **Implemented in code, not deployed:** The authenticated read-only dashboard gets a fifth navigation item **引継ぎ** and a card with **最新版を開く** (Google Docs link) and **引き継ぎをダウンロード (.txt)** (Google Docs export URL). The `TV2_HANDOVER_DOC_ID` environment variable supplies the document identifier. The staging deployment script defaults to the documented existing handover ID; it may be overridden for a different document. No backend credential, Docs API call, new data store, polling job, Cloud Scheduler, or write permission is needed; the export action fetches the Google Doc as it exists **when clicked**, under the browser user's Google Doc access rights. The UI remains IAP-signed-JWT protected, GET/HEAD only, and Firestore read-only.
- **Security:** The app contains document reference links but **not handover contents**. Google Docs access settings still decide who can read/export it, independently of IAP; never change the Doc to "anyone with the link" merely for downloads. Downloads may contain private details and must be treated as sensitive. External links use `noopener noreferrer`; document IDs are validated before being placed in HTML.
- **Limits:** This phase does **not** show the text or edited timestamp inside the app; opening the document or clicking download gets the latest content. Chat/Work updates must **actually be written to the Google Doc**; saving a chat message or changing a local .md does not automatically update that document. No new Chat session automatically reads the Doc without being directed to its URL/file. App deployment and actual mobile download flow are **not yet verified**.
- **Release:** Run unit tests and syntax checks in CI. Redeploy only `toreca-vault-ui-staging` from the branch via the existing `cloud/scripts/deploy-dashboard-staging.sh` under the authorized Cloud Shell environment. Verify Google IAP login, the bottom navigation, opening the Doc, downloading a .txt after editing, and the existing inventory/history/calendar. Do **not** modify the original API/worker's IAP or IAM, nor production data. Later enhancements may show a last-updated timestamp or an authorized in-app view if Google Docs API access is safely designed and granted.
