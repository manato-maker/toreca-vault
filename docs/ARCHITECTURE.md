# Toreca Vault Architecture

## 目的

この文書は、過去の会話を知らない保守担当者やAIがシステム境界とデータの流れを短時間で把握するためのものです。

## 全体像

```text
[スマホ/ブラウザ]
  Toreca Vault UI
       |
       | LocalStorage = ローカルキャッシュ
       |
       +---- Google Apps Script /exec ----> [Google Drive JSON]
                                              ^
                                              |
[Gmail] ---> [Apps Script 定期実行] -----------+
                  |
                  +--> 抽選申込/結果の解析
                  +--> カード相場取得

[GitHub]
  Webアプリ + automation/Code.gs + 運用文書
                  |
                  +--> Apps Script の薄いランナーが
                       automation/Code.gs を取得して実行
```

## 責務

### Webアプリ

`index.html`, `styles.css`, `js/` がUIとローカル状態を担当します。`js/schema.js` がコレクション定義と旧データ移行、`js/inventory.js` が在庫連動、`js/calculations.js` が集計、`js/remote-sync.js` が Apps Script `/exec` との同期を担当します。

### Google Drive JSON

同期設定が有効な環境では共有状態の保存先です。トップレベルの `data` がアプリ状態、`automation` が自動処理の実行履歴・処理済みGmail ID・要確認情報を保持します。ブラウザ側同期コードは `data` を中心に扱うため、自動化メタデータを壊さないことが重要です。

### Gmail / Apps Script

Apps Script は Gmail の対応メールを検索し、抽選申込を作成、結果を更新します。申込番号を優先して一致させ、曖昧なものは review に送ります。定期実行時刻は JST 12:30 / 19:00。相場同期は JST 13:00。

Apps Script 側は薄いランナーで、GitHub の `automation/Code.gs` を取得して実行します。自動化の実装をApps Script側へ複製しません。

### GitHub

コードと運用知識の正本です。`automation/Code.gs` が自動化の唯一の本番ソースです。2026-09-15に旧 `Code-v4.gs` への依存を廃止し、単一ソースへ移行しました。

## 現在の制約

- BOX/パック相場の自動更新は未対応。
- X/Twitter の特定アカウント画像から価格表を読む処理は未実装。
- パッケージ画像による商品同定、BOX/パック判定、シュリンク有無別価格は未実装。
- Apps Script 本体の権限承認やランナー変更はGoogle側の操作が必要。
- `remote-sync.js` は `data` を送受信するため、Drive JSON のトップレベル `automation` を保持するサーバー側実装が前提。

## 安全な拡張方針

外部入力は「取得 → 正規化 → 一致判定 → confidence/review → 保存」の順に分離します。新しいメール形式や価格ソースを追加しても、既存データを推測で上書きしない設計を優先します。商品画像認識を追加する場合は商品マスターへ公式名・カテゴリ・画像参照・識別情報を蓄積し、初見/低信頼だけ人間確認へ回します。
