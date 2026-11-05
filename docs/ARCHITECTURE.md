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

- `cloud/` はV2 `schemaVersion: 2` のスナップショット契約を保つCloud Run APIとFirestore compare-and-swap adapter。revision、mutationId、post-write再読込を維持する。JST schedule planner、stable job keyをclaimするFirestore lease ledger、期限切れclaimをfenceするdispatcherも実装済み。workerは独立処理され、エラー本文やメール内容をledgerへ保存しない。
- Firestoreの正本は明示的なread-only exportとdry-run照合が完了するまで初期化しない。書込みAPIも既定で無効。
- 最新に取得できたデータファイルは `toreca-vault-v2-staging.json` と記載されているため、正本と確認できるまで移行対象にしない。
- 初期移行では既存Google Sheets command queueを唯一の入力queueとして扱う。単一dispatcherを15分ごとに起動し、JSTのqueue処理は各15分境界、Gmail受信箱確認は07:00〜24:00の毎時（24:00は翌暦日の00:00）、抽選重点確認は12:30/19:00、相場更新は13:30より後の最初の15分境界（13:45）に分離する設計。19:00の重点確認は毎時Gmail jobへ統合し、二重のGmail jobを作らない。純粋なschedule plannerは予定時刻を受け取り、遅れて起動しても予定slot由来のjob keyを作る。Firestore job ledger/dispatcherは各ジョブに安定job keyを付与して原子的にclaimする。lease tokenが期限切れ後の古いworkerをfenceし、retryを制限する。外部副作用後のクラッシュはledgerだけではexactly-onceにできないため、Gmail message ID、Sheet request ID、V2 mutationIdも必須。Gmail検索とSheets queue処理は別workerにし、planner自体は外部APIを呼ばない。Scheduler時刻headerのruntime接続と実行漏れアラートは未実装。
- 本番切替は、canonical ID確認、データ件数/金額/在庫照合、重複防止、実データ外の受入試験、認証確認が通った後にのみ検討する。旧経路と新経路を同じqueueへ同時に書かせない。
- 初期adapterは互換性のため全V2 snapshotを1 Firestore documentに保持し、900,000-byteの安全上限でfail-closedする。実際のcanonical snapshotサイズを測定し、上限まで十分な余裕がなければ移行前にコレクション分割へ変更する。

- Job ledgerは将来Firestore TTLを使えるよう`expireAt`を持つが、TTL policyは未作成。隔離projectで保持期間と削除動作を検証するまでFirestore job collectionへ接続しない。\n\n`cloud/scripts/report-snapshot.js` は正本が特定された後に使う読取専用の移行前検査。製品名や取引IDを出さず、件数・数量・revision・ファイルhash・Firestoreサイズ見積りだけを出力する。

## Design audit follow-up (2026-11-05)

The command API now provides a status-only read route and an OpenAPI template intended for a ChatGPT GPT Action. It reports queue state and whether the worker verified canonical readback without returning the queued command. This remains a disconnected prototype. The canonical V2 export, production Gmail OAuth, Cloud resources, normal-Chat action setup, backups, restore drill, dispatch heartbeat alerting, and budget alerts are unverified or unimplemented.

The single-snapshot Firestore adapter continues to fail closed above 900,000 bytes. Keep it until a confirmed read-only canonical export provides size and growth measurements; do not migrate if the report indicates inadequate headroom. Evaluate domain-partitioned storage before migration if size exceeds 630,000 bytes or 90-day measured growth projects crossing the safety limit within 12 months. This is a proposed migration gate only. A storage split must retain snapshot compatibility and prove transactional readback before adoption.
