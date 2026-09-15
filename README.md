# Toreca Vault

スマートフォン優先のトレーディングカード資産・予定管理Webアプリです。

> 設計テーマ: **引き継ぎしやすく、サステナブル。特定の人・AI・会話履歴に依存しない。**

## まず読む場所

- 運用・復旧・本番の見分け方: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- システム構成とデータの流れ: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- ブラウザ側のデータ定義: [`js/schema.js`](js/schema.js)
- Google Apps Script が現在読み込む自動化本番ソース: [`automation/Code-v4.gs`](automation/Code-v4.gs)

## できること

抽選予定、購入・支出、未開封BOX、バラパック、カード、開封、売却を管理し、資産集計・店舗別実績・商品マスター・JSONバックアップ/復元・旧データ移行・オフライン利用に対応します。購入/売却/開封は在庫と連動します。

ブラウザは LocalStorage をローカルキャッシュとして使い、同期設定がある場合は Google Apps Script の `/exec` を通じてリモートデータと同期します。したがって「LocalStorageだけに保存」という旧説明は現在の構成には当てはまりません。

## 自動化

Google Apps Script が Gmail と Google Drive を使って動きます。現在の定期処理は JST で抽選メール同期 12:30 / 19:00、カード相場同期 13:00 です。抽選同期は対応メールの申込完了を `応募済` として登録し、結果メールで既存レコードを更新します。曖昧なものは自動確定せず要確認へ送ります。

相場同期は現在カード単品が対象で、カードラッシュを主ソース、アルテマを補助ソースとして使います。BOX・パック、X/Twitter画像からの商品判定、シュリンク有無別価格は今後の拡張領域です。

## 開発確認

```sh
npm test
npm run check
python3 -m http.server 4173
```

ローカル確認は `http://localhost:4173`。秘密情報、同期トークン、DriveファイルIDなどの実値はGitHubへコミットしないでください。

## 変更するときの原則

1. まずテストと `npm run check` を通す。
2. データ形式を変える場合は `schemaVersion` と移行方針を確認する。
3. 自動化変更は `automation/Code-v4.gs` を実行中ソースとして扱う。
4. 本番仕様や運用手順が変わったら docs も同じ変更で更新する。
5. メール解析・相場判定は、曖昧な入力を推測で確定せず review に残す。

このREADMEと `docs/` を読めば、過去のチャットを参照しなくても現在の構成・制約・復旧方法を追える状態を維持してください。
