# Toreca Vault — staging無料枠優先の費用ガード（2026-11-14 JST）

## 目標

通常Chatでの報告（購入/売却/抽選） → 既存Google Sheets Intake → Cloud Run Worker → Firestore staging正本 → スマホUIを、**月額0円を目標**に保つ。無料枠を超えた請求が絶対に発生しない保証ではない。請求有効化や本番移行を無条件に進めない。

**実際のクラウド費用・請求明細・有効なSchedulerジョブ数・現在デプロイ中のAPI設定はこのチャットから直接取得できていない。** 原則としてユーザーが認証したCloud Shell/Workで読み取り専用監査後、設定と費用を点検する。

## 公式料金・仕様の確認先

- Cloud Run request-based: https://cloud.google.com/run/pricing
- Cloud Run request-/instance-based billing: https://cloud.google.com/run/docs/configuring/billing-settings
- Cloud Scheduler: https://cloud.google.com/scheduler/pricing （**無料3ジョブはbilling account全体、停止中も課金対象ジョブ数**）
- Firestore: https://cloud.google.com/firestore/pricing （**無料枠は条件を満たすデータベース1個。名前付きDBは無償枠対象外**）
- Artifact Registry: https://cloud.google.com/artifact-registry/pricing （**0.5GiB storage無料はbilling account全体**）
- Budgets/alerts: https://docs.cloud.google.com/billing/docs/how-to/budgets （**alert-only budgetはハードな支出上限ではない**）

## 既存コードの変更状況

- スマホ閲覧専用UIの `cloud/scripts/deploy-dashboard-staging.sh` はCloud Run最小0/最大1インスタンス、1vCPU、512MiBに加え `--cpu-throttling`（リクエストベース課金）、concurrency=40、timeout=30sを明示。**この変更はコードだけ。既存デプロイ中UIに適用されていない可能性がある**。
- API/worker `toreca-vault-staging` は旧Scheduler/Gmail接続があるため、コスト対策を理由とする一括IAM/IAP変更やサービス停止を実施しない。実稼働のmin/max/billing設定の読み取り後に個別判断。
- 新規 `cloud/scripts/audit-free-tier-staging.py` は**読み取り専用**。既定のstagingプロジェクト番号を検証したうえで、対象Cloud Runサービス、Firestoreデータベース、Tokyo Schedulerジョブ数、課金の有効状態を表示。接続失敗や値不明はUNVERIFIED/警告として返す。**機密の請求先ID・アカウントメール・トークン・Cloud Run環境変数を表示しない**。変更操作、予算設定、権限付与、デプロイは行わない。

Cloud ShellでGitHubの対象ブランチを取得し、以下を実行（Google Cloudに認証済み、リポジトリのルートから）:

```bash
python3 cloud/scripts/audit-free-tier-staging.py
```

監査結果の `WARNING` / `UNVERIFIED` を全て確認してからデプロイを検討。**このスクリプトは月額課金額を照合しない**。請求実額と無料枠消費はGoogle Cloud ConsoleのBilling / Reportsで別途確認すること。

## 月額0円に近づける運用ルール

1. Google Sheetsの既存受付・既存Firestore正本を再利用し、もう1セットのAPI/Queueや常時稼働サーバーを増やさない。Chat受付の15分Schedulerは1日96回、30日で2,880回程度。これはHTTP回数の概算でありCPU/メモリ/他サービス料金を含まない。
2. UIはリクエストベース課金+min=0/max=1。APIも現行設定を監査後、セキュリティ/処理成功を損なわない範囲で最小0/最大少数・リクエストベースを目指す。
3. Schedulerの**3ジョブ無料は請求先全体**。このプロジェクト以外の他プロジェクト/リージョン、停止中のジョブも数える。無闇にジョブを増やさず、既存の15分tickを共用する案を優先する。
4. Firestoreはfree-eligibleな`(default)`DBを優先。既存の正本・キューの場所と整合性が取れることを確認し、費用削減目的で既存DBを移動/削除しない。50,000 reads / 20,000 writes / 20,000 deletes per day、1GiBは無料枠の目安（DB条件を確認）。
5. Cloud Build、Artifact Registry、Cloud Storageバックアップ、ログ、ネットワーク転送なども実請求を確認。頻繁なテストデプロイで古いコンテナ画像を蓄積しないが、**稼働中の参照イメージを自動削除しない**。
6. 買取X API/OCR/高度な画像認識は通常Chat報告の必須経路から切り離し、費用が判明するまで新たな有料APIや定期ジョブを有効化しない。商品デザイン/公式定価の照合はChatで公式Web情報を利用し、保存先には出典・確認日を残す。
7. **Google Cloud Billing予算を小額に設定して通知を受ける**ことを推奨するが、通知は請求停止しない。厳格な支出上限が必要なら対応サービスのspend cap等を個別確認する。金額の入力やBillingアカウント操作は接続済み権限で明示的に確認してから実行。
8. 初回E2Eは既存stagingに対し、**本当にユーザーが報告した未登録の事実だけ**を使う。架空データはEmulatorで検証し、旧売却8件を別IDで再送しない。

## 運用開始のゲート

- [x] 新しいChat受付向けコードとFirestore Emulatorテスト成功（2026-11-14）
- [x] UIの低コストなデプロイ設定をコード上に明示（この作業）
- [x] 読み取り専用監査スクリプトを追加（この作業）
- [ ] 実請求の現況・Scheduler請求先全体のジョブ数・Firestore無償DB・現行Cloud Runサービス設定を確認
- [ ] staging API/UIを既存権限を維持して安全に再デプロイ、IAPログイン/旧API Scheduler/OIDCを検証
- [ ] Chat→Intake→Queue→Firestore正本→スマホUIの実E2Eを独立した報告で確認
- [ ] 既存queued/new報告・売却8件の重複解消と原価/在庫照合（別の未完了タスク）

「無料枠内を目指す設計」≠「無料枠内に収まった請求実績」≠「一般運用可能」。この区別を守る。
