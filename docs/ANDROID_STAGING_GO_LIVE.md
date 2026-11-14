# Toreca Vault — Androidのみでステージング最終配備

**対象：既存PR #105・Cloud Run＋Firestore・Google Sheets Intake。FirebaseプラグインもPCも不要。**

## 現在の状態

- GitHub CI（通常テスト・Firestore Emulator）は成功。
- **稼働中のCloud Runへ最新コードは未配備**。Intakeの`new/queued`もあり、通常Chatからの自動反映は実機で未検証。
- このWorkスレッドからはGoogle Cloudの認証付きAPI操作ができない。Google Cloudの権限を持つ本人が、Android ChromeのCloud Shellで一度だけ認証済み操作を開始する必要がある。
- 旧V2本番と過去の売却在庫・正本は触らない。本番移行は別途承認。

## Androidの操作（スマホのChromeのみ）

1. Chromeで **https://shell.cloud.google.com/** を開き、対象GCPプロジェクトを操作できるGoogleアカウントでログインする。Google公式のCloud Shellはブラウザから動作し、CLI/認証が用意されている。Firebaseの接続は使わない。
2. 以下をターミナルへ**一括でコピーして貼り付ける**。既存フォルダと競合しないよう一時フォルダへ最新作業ブランチを取得。外部から取得したコードはGitHubの当該ブランチと一致するかシェル内でも検証する。

```bash
TV_TMP="$(mktemp -d)" && git clone --quiet --single-branch --branch build/cloudrun-firestore-foundation-20261103 https://github.com/manato-maker/toreca-vault.git "$TV_TMP/toreca-vault" && cd "$TV_TMP/toreca-vault" && bash cloud/scripts/android-staging-launch.sh stage
```

3. 画面に `BLOCKED:` や `WARNING:` が表示されたら**停止**。何度もコピー・再デプロイしない。出力のエラー文のみWorkに知らせ、秘密鍵・トークン・請求先ID・アカウントメールは共有しない。
4. `STAGED AT ZERO TRAFFIC` が出た場合、**利用中のAPIを切り替えたわけではない**。候補リビジョンの認証/OIDC、worker/Scheduler、Firestore canonical、Intake受付、スマホ画面が正しいか確認する。
5. 候補が問題なく、当該コード・費用・正本バックアップ・認証を独立にレビューできたときに限り、同じCloud Shellから `TV2_STAGING_RELEASE_REVIEWED=YES bash cloud/scripts/release-chat-staging.sh promote` を実行する。**確認前に実行しない。**
6. UIも同じブランチの `cloud/scripts/deploy-dashboard-staging.sh` で別途反映する必要がある。これはサービスアカウント/IAMとIAPに関わるため、権限と公開範囲を確認してから実施し、UIのIAP認証が機能することを検証する。

## コマンドの安全境界

`android-staging-launch.sh stage`は以下を順に実施する。

- Gitの作業ブランチ/ローカル変更なし/remote SHAが最新であることを確認
- `audit-free-tier-staging.py`：**読み取り専用**のGoogle Cloud無料枠リスク監査（当月の正確な請求額は取得しない）
- `release-chat-staging.sh check`：**読み取り専用**でプロジェクト番号、非公開Cloud Run Invoker IAM、専用staging canonical、Intakeのバインドを照合
- `release-chat-staging.sh stage`：Nodeテスト・構文チェックを再実行後、既存APIのenv/secretとIAMを維持して、**タグ付きの新候補リビジョンをトラフィック0%で作る**。これはCloud Build/Artifact Registry等の料金が生じ得る
- `promote`は手動の別モードで、必要な4フラグが`true`か確認し、Firestore/Sheets preflightが成功しなければ停止

**このコマンドが成功しても日常Chatの運用完了ではない。** 実際のChat報告1件→Intake `v2-applied/canonical-readback-verified`→Firestore canonical→スマホの在庫/カレンダーで一致し、再送が二重登録されないことを確認してからのみ運用開始可とする。

> 注：Google Cloud公式の「Open in Cloud ShellでGitHubリポジトリを開く」リンクは、Google所有以外のリポジトリで認証資格情報を利用できない一時環境になる場合がある。したがって、ここでは**通常の認証済みCloud Shellを開き、そこでGit cloneする**方式を採用する。

## 関連資料

- `docs/CHAT_STAGING_RELEASE_RUNBOOK.md` — APIの段階的配備、未処理Intake、readback、障害時の切り分け
- `docs/BUYBACK_IMPORT_RUNBOOK.md` — 正式なX一次投稿だけを買取価格として取り込む手順
- `docs/FREE_TIER_STAGING_COST_PLAN.md` — 無料枠の想定、費用監査、課金通知の制約
- `docs/NEW_DESIGN_HANDOVER.md` と非公開Google Doc `Toreca Vault Handoff (CURRENT)` — 開発とChatの共通正本


## 2026-11-14 — Intake 503の安全な一括診断（既存候補は0%のまま）

2026-11-14にAndroid Cloud Shellで確認した内容：
- Cloud Schedulerの`toreca-vault-staging-intake`は15分間隔、`ENABLED`だが直近はCODE 14。Cloud Runの旧revision `toreca-vault-staging-00004-nfr`が15分ごとに`/internal/worker/sheets-intake`でHTTP 500/503を返している。
- APIは起動し、writes/command queue/command worker/Sheets intakeの4フラグは全て`true`。したがって有効/無効だけでは原因を断定できない。
- 新候補revision `00005`は0%トラフィックでデプロイ成功。**まだpromoteやScheduler手動実行をしていない**。

今回`cloud/scripts/diagnose-intake-staging.py`を追加。既存Cloud Runのサービスアカウントで読み取り権限を一括検査し、Scheduler送信先・OIDC audienceと主体、Google Sheetsの専用Intakeメタデータと読み取り、Firestore staging canonicalとcursor、および直近HTTP5xx件数を**要約だけ**出力。Cloud IAMを変更しない。workerは呼び出さず、受付データ、原価、在庫、売却、正本に書き込まない。ログ・機密トークン・個人取引内容は出力しない。既存Cloud Runと同様のGoogle Sheets / Firestoreスコープで最長10分の一時トークンを作るため、認証済みCloud Shellの利用者に既存Cloud Run service accountへのimpersonation権限が必要。権限不足時は`BLOCKED`で停止し、**IAM権限を勝手に付与してはならない**。

既にGitHub作業ブランチのディレクトリにいる場合は、最新の安全な診断だけを実施：

```bash
git pull --ff-only && python3 cloud/scripts/diagnose-intake-staging.py
```

`PASS`は依存先の**読み取り権限**しか保証せず、受付処理のPOSTやFirestore書込み権限を保証しない。表示された`BLOCKED`の種類だけをWorkに報告し、SAメール・トークン等は貼らない。原因がわかるまでは`promote`や`gcloud scheduler jobs run`を行わない。CIには`cloud/test/test_diagnose_intake_staging.py`を追加した。
