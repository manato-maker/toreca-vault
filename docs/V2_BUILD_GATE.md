# Toreca Vault v2 — Build Gate

## 方針
v2 は現行本番を直接改造しない。旧 Vault は読み取り可能なバックアップとして残し、v2 を別系統で完成・検証してから切り替える。

## 今回の障害から固定する禁止事項
- Apps Script の Web API リクエストごとに GitHub/jsDelivr からコードを UrlFetch して eval しない。
- UI の LocalStorage と Drive JSON を双方の正本にしない。正本は1つにする。
- 購入履歴から在庫を暗黙再生成しない。
- 保存APIが返っただけで「反映済み」としない。
- 取得原価不明を 0 円として利益計算しない。
- 本番データで移行コードを最初に試さない。
- 秘密情報を GitHub に保存しない。

## v2 の不変条件
1. 取引が正本。購入・売却・開封は一意の transactionId を持つ。
2. 在庫は productKey + condition で管理する。店舗は在庫キーに含めない。
3. BOX の condition は shrink=あり/なし/対象外 を明示する。
4. 購入店舗・購入額などの来歴は取引履歴に保持する。
5. 売却は在庫不足なら全体を失敗させる。部分保存しない。
6. 原価充当順を FIFO にする場合、購入日時昇順をコードとテストで保証する。
7. acquisitionCost 不明の売却は pending とし、実現利益へ算入しない。
8. 同じ transactionId / mutationId は二重適用しない。
9. 保存は revision を使った競合検知を行う。
10. 成功判定は 保存 → 再読込 → mutationId/revision/不変条件照合 が通った時だけ。
11. 失敗時は「未反映」として扱い、直前の整合した状態を保持する。
12. Gmail の同一申込が複数既存レコードに一致する場合は重複扱い。真に曖昧なものだけ review。
13. 相場は正の在庫を productKey + condition で重複排除して取得し、取得失敗時は旧価格を消さない。
14. 外部入力は 取得 → 正規化 → 一致判定 → 検証 → 保存 の順にする。

## v2 アーキテクチャ
- Frontend: 表示と入力。LocalStorage はキャッシュのみ。
- API: Apps Script に「固定された小さい API コード」を直接配置する。リクエスト中の外部コード取得は禁止。
- Data: Drive の v2 専用 JSON を正本にする。旧本番 JSON は移行完了まで変更しない。
- Automation: Gmail/相場処理は API と分離する。外部取得回数・実行時間・最終成功時刻・失敗理由を health に記録する。
- GitHub: ソース、テスト、仕様の正本。Google 側への配置物はリリース単位で固定する。

## データモデル最低要件
- transactions: purchase / sale / opening
- inventoryLots: productKey, category, condition, quantity, unitCost, acquiredAt, sourceTransactionId
- lotteries
- marketQuotes
- automation / health
- auditLog
- schemaVersion / revision / lastMutationId

## 必須テスト
- 購入1件 → 在庫増加
- 同一 mutation 再送 → 二重増加しない
- BOX shrink あり/なし → 別在庫
- 店舗違い同一商品 → 在庫上は同じ条件として扱える
- 売却 → 数量減少 + FIFO原価 + 実現利益
- 在庫不足売却 → 取引も在庫も変更なし
- 一部数量売却 → 残数と原価が一致
- 開封 → BOX減少、履歴保持
- 原価不明売却 → pending、利益へ算入しない
- 保存後再読込 → mutationId と revision 一致
- revision競合 → 上書きせず失敗
- 壊れたJSON → 本番を書き換えない
- Gmail重複 → review ではなく duplicate
- 真の曖昧メール → review
- 相場取得失敗 → 旧価格保持
- 旧データ移行 → 件数・売上・在庫数量の照合
- 現在把握している売却済み在庫が移行後に復活しない

## 移行ゲート
1. 旧本番 JSON をバックアップ。
2. v2 専用コピーに対して dry-run migration。
3. 旧データとの照合レポートを出す。
4. purchases / sales / inventory / lotteries の件数、数量、金額差分を確認。
5. 自動テストと構文チェックを全通過。
6. v2 API の書込 → 再読込 → 照合をテストデータで確認。
7. 旧本番を変更せず、v2 をスマホで受入確認。
8. ここまで通って初めて切替。

## 完了条件
「画面が動く」では完成としない。上記テスト、移行照合、保存後検証、障害時の未反映保証、バックアップ/復旧手順が揃って初めて本番候補とする。
