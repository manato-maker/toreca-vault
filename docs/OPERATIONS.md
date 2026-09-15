# Toreca Vault Operations / Handover

## これだけ覚える

GitHub がコードと運用知識の正本です。ユーザーデータの実体は同期構成では Google Drive JSON、メール自動取得は Google Apps Script が担当します。過去チャットは運用に必須ではありません。

## 自動化コードの正本

**`automation/Code.gs` が唯一の編集元（source of truth）です。** 新しい担当者やAIは、自動化を直すとき `Code.gs` を編集してください。

Google Apps Script プロジェクト名は `Toreca Vault 抽選自動化`。Apps Script 側は薄いランナーで、2026-09-15時点では GitHub の `automation/Code-v4.gs` URL を取得して関数を実行しています。この `Code-v4.gs` は独立したソースではなく、現行ランナーとの互換性を保つための**配布コピー**です。

### 自動化変更のリリース手順

1. `automation/Code.gs` を変更する。
2. テスト・構文確認を行う。
3. `automation/Code-v4.gs` を `Code.gs` と完全に同じ内容へ同期する。
4. 必要な場合だけ Apps Script で `install` を1回実行する。
5. 実行ログと Drive JSON の `automation.lastGmailRunAt` / `lastMarketRunAt` を確認する。

`Code-v4.gs` だけを直接編集してはいけません。将来 Apps Script ランナーの `TV_SOURCE` を `automation/Code.gs` に変更できたら、`Code-v4.gs` を削除して物理的にも完全な単一ソースへ移行します。それまでは現行GASを壊さないため v4 を残します。

## 定期処理

- `runTorecaVaultLotterySync`: JST 12:30 と 19:00。Gmailから抽選申込完了/結果を処理。
- `runTorecaVaultMarketSync`: JST 13:00。カード単品の買取相場を更新。
- `installTorecaVaultAutomation`: 上記トリガーを作り直し、直後に抽選同期を1回実行。

トリガーを壊した、または本番コード更新後に再設定が必要な場合は Apps Script で `install` を1回実行します。実行ログが `実行完了` なら基本動作は成功です。

## 抽選メールの基本動作

申込完了メールは、対応形式なら申込番号をキーに `応募済` を作成します。結果メールは申込番号を最優先で既存抽選に結びつけ、当選/落選を更新します。店舗名や商品名が曖昧な場合は自動確定せず `automation.needsReview` に残します。処理済みGmail IDは `automation.gmailMessageIds` に保存します。

## 相場更新

現在はカード単品のみ。カードラッシュ公開CSVを主に使い、完全一致が取れない場合にアルテマを補助的に確認します。BOX・パックは `unsupported` として扱います。X/Twitter画像価格表やシュリンク別価格は、実装済みと誤認しないでください。

## 障害時チェック順

1. Apps Script の実行ログにエラーがないか。
2. GitHub の `automation/Code.gs` と配布用 `Code-v4.gs` が一致しているか。
3. Drive JSON が壊れていないか、`app: toreca-vault` と `data` があるか。
4. `automation.lastGmailRunAt` / `lastMarketRunAt` が更新されているか。
5. `needsReview` / `marketNeedsReview` に保留理由がないか。
6. Webアプリだけ同期できない場合は `/exec` URL と同期設定を確認する。

データを直接修正する前にバックアップを取ります。特に `automation` を消さないでください。

## 秘密情報

DriveファイルID、同期トークン、APIキーなどの実値を README・issue・コミットへ書かないでください。Apps Script の Script Properties 等で管理します。

## 引き継ぎチェック

新しい保守担当者は README → ARCHITECTURE → OPERATIONS → `js/schema.js` → `automation/Code.gs` の順で読めば全体を追えます。仕様を変えたコミットでは、関連する文書も同時に更新してください。
