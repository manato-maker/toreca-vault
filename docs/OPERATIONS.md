# Toreca Vault Operations / Handover

## これだけ覚える

GitHub がコードと運用知識の正本です。ユーザーデータの実体は同期構成では Google Drive JSON、メール自動取得は Google Apps Script が担当します。過去チャットは運用に必須ではありません。

## 自動化コードの正本

**`automation/Code.gs` が唯一の本番ソース（source of truth）です。** 新しい担当者やAIは、自動化を直すときこのファイルだけを編集してください。

Google Apps Script プロジェクト名は `Toreca Vault 抽選自動化`。Apps Script 側は薄いランナーで、2026-09-15から GitHub の `automation/Code.gs` URL を直接取得して関数を実行しています。旧 `Code-v4.gs` は廃止済みです。

### 自動化変更の手順

1. `automation/Code.gs` を変更する。
2. テスト・構文確認を行う。
3. 必要な場合だけ Apps Script で `install` を1回実行する。
4. 実行ログと Drive JSON の `automation.lastGmailRunAt` / `lastMarketRunAt` を確認する。

## 定期処理

- `runTorecaVaultLotterySync`: JST 12:30 と 19:00。Gmailから抽選申込完了/結果を処理。
- `runTorecaVaultMarketSync`: JST 13:00。カード単品の買取相場を更新。
- `installTorecaVaultAutomation`: 上記トリガーを作り直し、直後に抽選同期を1回実行。

トリガーを壊した、または再設定が必要な場合は Apps Script で `install` を1回実行します。実行ログが `実行完了` なら基本動作は成功です。

## 抽選メールの基本動作

申込完了メールは、対応形式なら申込番号をキーに `応募済` を作成します。結果メールは申込番号を最優先で既存抽選に結びつけ、当選/落選を更新します。店舗名や商品名が曖昧な場合は自動確定せず `automation.needsReview` に残します。処理済みGmail IDは `automation.gmailMessageIds` に保存します。

## 相場更新

V2の `runTv2MarketAuto` は在庫があるシングル、BOX、バラパックの相場を更新します。シングルはカードラッシュを優先し、照合条件を満たすトレトク買取を補助元にします。BOXとバラパックはトレ価格ナビの掲載日・スナップショット日と商品名を照合し、シュリンク有/無またはパック状態が一致する場合だけ更新します。買取ミミ・AMTAF・アリウムの店舗別価格も最後の確認日とともに保存し、条件に一致する最新価格を採用します。完全一致できない価格は推測で埋めず、前回値を維持して `automation.health.marketNeedsReview` に理由を残します。

通常のV2 Apps Script runnerは15分ごとに動き、JST 13:30以降に1日1回相場を更新します。加えて GitHub Actions の `V2 market quote refresh` が毎日JST 13:30に相場専用関数を実行します。GitHub側は Gmail の一般コマンドキューを処理しないため、抽選・購入コマンドへ影響しません。Apps Script Automation Deploy成功後にも初回相場更新を走らせます。実行後はV2を読み直し、revision、最終実行時刻、当日取得数、要確認数を検証します。価格の詳細監査はGmailの `[Toreca Vault Market Audit]` 結果draftを確認します。下書きは送信しません。

## 障害時チェック順

1. Apps Script の実行ログにエラーがないか。
2. GitHub の `automation/Code.gs` が取得できるか。
3. Drive JSON が壊れていないか、`app: toreca-vault` と `data` があるか。
4. `automation.lastGmailRunAt` / `lastMarketRunAt` が更新されているか。
5. `needsReview` / `marketNeedsReview` に保留理由がないか。
6. Webアプリだけ同期できない場合は `/exec` URL と同期設定を確認する。

データを直接修正する前にバックアップを取ります。特に `automation` を消さないでください。

## Apps Script 側の注意

ランナーには権限確認用の古い補助関数が残っている場合があります。**`requiredPermissions_` は実行しないでください。** 既存データを書き換える処理を含む版が確認されています。通常運用で使うのは `install`、`runTorecaVaultLotterySync`、`runTorecaVaultMarketSync` だけです。

## 秘密情報

DriveファイルID、同期トークン、APIキーなどの実値を README・issue・コミットへ書かないでください。Apps Script の Script Properties 等で管理します。

## 引き継ぎチェック

新しい保守担当者は README → ARCHITECTURE → OPERATIONS → `js/schema.js` → `automation/Code.gs` の順で読めば全体を追えます。仕様を変えたコミットでは、関連する文書も同時に更新してください。

## X追加投稿と画像価格の同期

Apps Scriptのスクリプトプロパティ `TV2_X_BEARER_TOKEN` と `TV2_VISION_API_KEY` を設定し、X APIの利用枠とCloud Vision APIを用意した場合、`installTv2Automation()` を一度実行する。既存のJST 15:00に加え19:00と22:00に３店舗の新着投稿を確認する。X APIは取得量に応じて課金される。資格情報はGitHub、引き継ぎファイル、チャットに貼らない。プロパティが未設定なら追加投稿の定期ジョブは作られず、従来の比較サイトによる更新だけが続く。

本文または画像OCRで商品・状態・金額を同じ行から明確に特定できた場合に限り、店舗の投稿IDで新旧を判断して価格を上書きする。新しい投稿による値下げも反映する。画像だけで特定できない投稿、OCR/APIエラー、同じ投稿の矛盾は `automation.health.marketNeedsReview` と `xUncertainShops` に記録し、その店舗の新しい価格は保留する。OCRだけで画像の商品そのものを判定できない場合は公式や検索情報を人が確認する。X投稿の削除や告知なしの受付終了は検出できない。未読が50件を超える場合は安全停止して要確認。
