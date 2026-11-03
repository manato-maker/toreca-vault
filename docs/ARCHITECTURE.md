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


## Cloud migration target (prototype, not production)

2026-11-03から、Apps Scriptの版数上限を避けるためCloud Run＋Firestoreへの移行基盤を別ブランチで開発中。現行のApps Script / Drive JSON / Google Sheets Queueは稼働系として残し、現段階では置換・停止・データ移動を行わない。

- `cloud/` はV2 `schemaVersion: 2` のスナップショット契約を保つCloud Run APIとFirestore compare-and-swap adapter。revision、mutationId、post-write再読込を維持する。
- Firestoreの正本は明示的なread-only exportとdry-run照合が完了するまで初期化しない。書込みAPIも既定で無効。
- 最新に取得できたデータファイルは `toreca-vault-v2-staging.json` と記載されているため、正本と確認できるまで移行対象にしない。
- 初期移行では既存Google Sheets command queueを唯一の入力queueとして扱う。専用queueは15分ごと、抽選メール本文は9:00〜23:00 JSTに1時間ごと、追加結果確認は12:30/19:00、相場更新は毎日13:30以降に実行する設計。Gmail検索とSheets queue処理は別のworkerにする。
- 本番切替は、canonical ID確認、データ件数/金額/在庫照合、重複防止、実データ外の受入試験、認証確認が通った後にのみ検討する。旧経路と新経路を同じqueueへ同時に書かせない。
- 初期adapterは互換性のため全V2 snapshotを1 Firestore documentに保持し、900,000-byteの安全上限でfail-closedする。実際のcanonical snapshotサイズを測定し、上限まで十分な余裕がなければ移行前にコレクション分割へ変更する。

- `cloud/scripts/report-snapshot.js` は正本が特定された後に使う読取専用の移行前検査。製品名や取引IDを出さず、件数・数量・revision・ファイルhash・Firestoreサイズ見積りだけを出力する。