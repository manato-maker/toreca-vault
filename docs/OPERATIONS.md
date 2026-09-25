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

現在はカード単品のみ。カードラッシュ公開CSVを主に使い、完全一致が取れない場合にアルテマを補助的に確認します。BOX・パックは `unsupported` として扱います。X/Twitter画像価格表やシュリンク別価格は、実装済みと誤認しないでください。

V2の `runTv2MarketAuto` はカードラッシュCSVから商品名・型番が一意に一致し、状態が良品または未指定のカードだけ価格を更新します。CSVの取得失敗、型番なし、その他の状態は価格を維持して `automation.health.marketNeedsReview` に記録します。Gmail同期は2日重ねて再検索し、検索が2000スレッドを超えた場合は保存せず失敗します。定期処理の設定はV2プロジェクトの `installTv2Automation` で行い、実行ログに加えてV2 JSONの `automation.health` と revision を確認します。

BOXとバラパックのV2更新は、トレ価格ナビの当日スナップショットに掲載された商品名・公式名称と在庫名が厳密一致し、シュリンク有/無またはバラパックの状態が一致する場合のみ行います。価格は買取ミミ・AMTAF・アリウムの大阪日本橋店のX投稿へ直接リンクするものだけを候補にし、その最高値と出典URL・日付を保存します。画像だけでは商品判別できないもの、未開封という曖昧なBOX状態、X出典がないもの、前日以前のスナップショットは価格を更新しません。相場トリガーはJST 15:00に移行します。既存の13:00トリガーは次回正常実行時に置き換えます。

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
