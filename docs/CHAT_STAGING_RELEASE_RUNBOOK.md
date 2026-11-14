# Toreca Vault — 通常Chat報告のstaging実運用リリース手順

更新: 2026-11-14 JST
対象: Cloud Run `toreca-vault-staging`、閲覧専用UI `toreca-vault-ui-staging`、専用 `Toreca Vault New App Intake`。

**現状：コードとCIで通しテストを作成済み。Cloud Runへの今回のコード配備、実請求、IAP、Google Sheets→Firestore→スマホ画面の認証付き実E2Eは未完了。** この文書は運用開始済みの宣言ではない。

## 役割・重要な安全境界

- 通常Chatは自然文/スクショから事実を抽出し、公式商品デザイン/定価を照合し、既存専用Intakeへ追記して受理結果を読み戻す。WorkはCloud Run更新、バグ修正、監視、費用確認を担う。
- 非公開Google Docs `Toreca Vault Handoff (CURRENT)` をChat/Work共通の引き継ぎ正本に使う。
- staging APIは旧V2/Apps Scriptの本番ではない。旧Queue、未処理売却8件は変更・再投入しない。Firestore staging canonicalの既存データはバックアップ方針とreadbackが確認できるまで手動で削除/上書きしない。
- 公開GitHubにはAPIトークン、Google Sheetsの生ID、購入/売却明細、申込番号、Cloud認証JSONを保存しない。機密を持つGoogle SheetやDocを「リンクを知っている全員」にしない。
- 月額0円は**目標**。Cloud Build、コンテナ保存、リージョン間通信、バックアップ、X API/OCR、Scheduler追加ジョブに少額課金が生じうる。予算アラートは支出停止ではない。

## リリース順序（認証済みWork / Google Cloud Shell）

1. 最新のPR #105作業ブランチを取得。最初に `python3 cloud/scripts/audit-free-tier-staging.py` を実行し、実請求とBillingの費用・無料枠、同一BillingアカウントのSchedulerジョブ数、Artifact Registry保存量を別途確認。
2. `bash cloud/scripts/release-chat-staging.sh check` を実行。プロジェクト番号/正本パス/専用Intake/スケジューラOIDC/APIトークンbinding/Cloud Runの非公開IAMを**読み取り専用**で確認。4フラグ `TV2_ENABLE_WRITES`、`TV2_ENABLE_COMMAND_QUEUE`、`TV2_ENABLE_COMMAND_WORKER`、`TV2_ENABLE_GOOGLE_SHEETS_INTAKE` の状態を確認（トークン値は表示しない）。フラグがoffならまず正本・キュー・移行受入可否を診断してから操作する。
3. 自動テストが成功していること、作業ブランチが合っていること、未コミット変更なしを確認して、`bash cloud/scripts/release-chat-staging.sh stage`。このコマンドはNodeのテストを再実行後、既存Cloud Run環境変数/secret/IAMを保存したまま**0%トラフィック**で `chat-candidate` タグ付き改修リビジョンを作る。既存トラフィックを勝手に切り替えない。Cloud Build/Artifact Registryの利用が発生する。
4. 候補リビジョンをCloud Runのログ・認証付きURLで検証（HTTP `/health`、`canonicalInitialized=true`、OIDC拒否/許可、APIのエラー応答、既存Schedulerジョブのサービスアカウント・送信先、Intakeの`new/queued/review/v2-applied`状態を目視）。API tokenはチャットへ貼らない。最終時点の一意な対象リビジョン名、auth設定、費用/失敗ログを記録。
5. 本当にstaging canonicalが存在し、対象キューの既存未処理/同一報告・原価・在庫を確認後、ローカルからの読み取り専用正本確認を実施。専用Google Sheets IDは**実行時環境変数**でのみ渡す。 `node cloud/scripts/preflight-chat-staging.js` は本人のCloud認証（Firestore/Sheets read-only）を利用し、取引本文・個人情報なしで件数と各receipt状態を表示する。スクリプトへのアクセス権がなければ未確認のまま。
6. 候補に問題がなく、Work側が明示的に検証記録を残した場合のみ、Cloud Shellで `TV2_STAGING_RELEASE_REVIEWED=YES bash cloud/scripts/release-chat-staging.sh promote` を実施。候補タグから厳密にリビジョンを解決して100%に切替。**実行前に当月費用・正本・旧API auth・Scheduler状態の再確認が必要**。
7. 閲覧専用UIの`引継ぎ`メニューがまだ未配備なら、別の `cloud/scripts/deploy-dashboard-staging.sh` でUI専用サービスだけを更新（IAPの再認証を必ず確認）。API本体にIAPを入れて既存Scheduler OIDCを壊さない。
8. 通常Chatから**実際の未登録の報告だけ**を1件受け付け、Google Sheetsの同一requestIdを再読する。 `new`→`queued`→`v2-applied/canonical-readback-verified` を確認し、Firestore canonicalのreadbackとスマホ画面の在庫/取引/カレンダーまで照合する。2回報告した場合には同じ事実が2件登録されないことを確認する。未確認の抽選や在庫不足はreviewで停止する。**この確認が終わるまで「通常Chat報告の完成」と報告しない**。

## 失敗時の切り分け

- 認証エラー: 原APIのCloud Run Invoker権限、Scheduler service account、OIDC audience を照合。IAPは閲覧専用UIに限定。
- `new` が止まる: Scheduler受付ジョブの呼出ログ、`TV2_ENABLE_GOOGLE_SHEETS_INTAKE`、Sheets共有権限、Firestore cursorをread-onlyで確認。既存`new`を別IDで追記しない。
- `queued` が止まる: `TV2_ENABLE_COMMAND_WORKER`と`TV2_ENABLE_WRITES`、コマンドworker Scheduler、canonical initialized、queue pending/reviewを確認。無条件にworker起動・既存Queue再処理しない。
- `review`: 商品・応募識別、重複・原価・在庫不足を確認し、元requestIdと正本を照合。review行を単に`new`へ戻す操作はしない。
- 候補revision不具合: 0%トラフィックのまま止める。promote後に不具合が判明したら、Workの監査記録を元に安全な前リビジョンのトラフィックへ戻す。旧V2やFirestore正本を復元しない。

## 開発CI

- 完全な模擬E2E: `cloud/test/chat-intake-e2e.test.js`（購入/抽選/review）
- 読み取り専用実環境調査: `cloud/scripts/preflight-chat-staging.js`
- 安全な段階的リリース: `cloud/scripts/release-chat-staging.sh`
- 無料枠監査: `cloud/scripts/audit-free-tier-staging.py`
- 最新のCI結果を確認し、`test`と`firestore-emulator`がともにsuccessであることを条件とする。

**未完成の別工程:** Gmail実OAuthと本番メール分類、X投稿画像からの実相場更新、バックアップ復元ドリル、旧V2正本の移行、既存未登録売却8件の在庫照合。これらも含めた完全な運用開始は上記staging一連の成功だけで宣言しない。
