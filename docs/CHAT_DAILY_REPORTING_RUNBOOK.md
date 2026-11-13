# Toreca Vault — 通常Chatからの安全な日常報告受付（開発／運用手順）

更新: 2026-11-14 JST
状態: **Google Sheetsの受付基盤は稼働実績あり。ChatGPT通常Chatからの自然文/画像 → Intakeの自動追記は会話ごとのコネクタ実行に依存し、全自動E2E/本番は未検証**。

## 目的と責任分担

- 通常Chat: ユーザーが自然文・スクリーンショットで抽選、当落、購入、受取、開封、売却を報告。根拠確認 → 同定 → 重複調査 → 安全な報告の受付を行う。
- Work: コード変更、テスト、Cloud Run / Scheduler / Firestore運用、障害対応、デプロイ。
- 共有正本: 非公開 Google Docs `Toreca Vault Handoff (CURRENT)`。ユーザーに関する取引・申込情報は、公開GitHubの文書には記載しない。
- 受付経路: **既存** `Toreca Vault New App Intake` の `Intake` tab → Sheets intake worker → Firestore durable command queue → command worker → staging canonical readback → status receipt。新しいキューや第二の受付先を増やさない。

## 通常Chat側の手順

1. **当日の報告を読む前に**共通Google Docsを読んで運用規則・未処理レコードを把握する。接続済みGoogle Drive/Sheetsコネクタが利用可能なら使う。公式販売元のパッケージデザイン、正しい商品・セット・単位、メーカー税込定価を公式ページにて確認する。確認不可は `review`。
2. スクリーンショットが「応募完了」を示しているのか「応募画面」なのかを区別。閲覧だけなら `応募済` としない。応募・当選では購入、支払い、在庫を増やさない。購入は実支払原価を優先し、税込定価を勝手に実原価にしない。
3. **受付シートのIDと`Intake`のタブID・ヘッダーを毎回metadataで照合**する。列A:Gは `requestId,commandJson,businessEventIdentityJson,status,resultCode,acceptedRequestId,processedAtMs`。行A:Cは入力原本、D:Gは処理ワーカーのreceipt欄なので**ユーザー/Chatが書くのは新規行のA:Dのみ**。既存行A:Cや旧Queueには触らない。
4. Intakeの既存requestIdと同一業務事実（店舗、商品、注文/応募ID、所有区分、日付、数量、状態）を先に調べ、**重複・既存売却8件・すでに処理済み取引を再送しない**。IDは安全な英数字/点/アンダースコア/コロン/ハイフン120字以下、業務事実ごとに安定させ、再送時は同じIDを再利用。疑わしい時は新IDを発行しない。
5. `commandJson` はJSONオブジェクトとし、その `requestId` はA列の値と完全一致。対応可能なtypeは現在の `v2-command.js` に厳密準拠（`purchase`, `sale`, `open-packs`, `lottery`, `lottery-result-exact`, `lottery-receipt`）。予約や抽選だけでtype `purchase` を使わない。
6. 抽選の `businessEventIdentityJson` は公式・店舗発行の明示的な応募IDと店舗キーが分かる場合だけ `{"retailerKey":"...","applicationId":"..."}` とする。**商品コード、推測の申込番号、Chat独自のハッシュを公式応募IDとして捏造しない**。この列が空欄の `lottery` / `lottery-result-exact` / `lottery-receipt` は現行workerで`review`になり、アプリ自動反映されない。その場合も事実を失わず要確認として案内する。
7. **実際にアプリへ送る明確な報告だけ**、接続済みGoogle Sheetsの `batchUpdate` `appendCells` を使い、`sheetId`をmetaで検証したうえで `rows=[{values:[A,B,C,D]}]`、`fields:"userEnteredValue"` で新規行へ追記する。セルの文字列は `userEnteredValue.stringValue` に指定し、先頭文字が `=` でも数式として評価されないようにする。D列は `new`、E:Gは空のまま。取り込み不能な入力は正本ドキュメントへ review 事項を記録し、`new` の偽commandを流さない。
8. シートを再読込し、新規行のA:Dが完全一致であることを確認して初めて `受付シートに記録済み` と報告。**`new`、`queued` はFirestore反映完了ではない**。`v2-applied` と `canonical-readback-verified` の組み合わせを読み戻して初めて `新アプリ反映済み` と報告する。`review`、エラー、タイムアウト時には再送しないで同じIDを調査する。
9. コネクタの編集アクションがない、認可不可、Cloud Run未配備なら、登録完了と偽らない。共通正本に未処理事項を追記し、Workに接続/デプロイ・readback検証を依頼する。

## 記録スキーマの実例（架空の値、実データへ投入禁止）

**購入**: `{"requestId":"chat:purchase:example-1","type":"purchase","product":"商品A","category":"BOX","condition":"あり","quantity":1,"unitCost":7200,"date":"2026-11-14","store":"店舗A"}`

**抽選応募**: `{"requestId":"chat:lottery:example-1","type":"lottery","product":"商品A","title":"商品A 抽選","store":"店舗A","status":"応募済","applicationDate":"2026-11-14","owner":"本人","quantity":2,"category":"BOX","evidenceType":"screenshot","officialMsrpYen":6000,"officialProductUrl":"https://example.com/products/1","officialMsrpCheckedAt":"2026-11-14","paymentStatus":"未購入・未支出"}`
この例は外部応募番号がなく、**そのまま投入するとreview**になる。架空の応募番号を補わない。

**当落結果**: 現行 `lottery-result-exact` は対象の店舗・title・owner・結果日が既存申込と一意に一致する必要がある。

## 既知の制限・確認必須

- 最新の接続済みIntakeには `new` の抽選行が存在。現行プロセッサは応募番号なしをreviewに振り分ける。別IDで再投入せず、受付シートの残statusとCloud Run/Scheduler実稼働をWorkで照合する。
- Sheets intake書込の古いバグは `review`時の空`acceptedRequestId`や業務重複時の**別requestId**を誤って原本A列と比較する点。2026-11-14に修正コード・検証テストを追加（原本の`sourceRequestId`を別引数で照合）。
- `v2-command.js`の抽選申込に数量/単位/条件/公式参考額・出典を保持するフィールドを追加。**応募段階で購入・在庫を変更しない**。
- このコードは**GitHub作業ブランチ段階**であり、既存Cloud Runサービスにデプロイされたと証明していない。旧V2の売却8件の未処理問題とは分離し、勝手に完了/再送しない。

## 完了条件

- 新しい通常Chatでスクリーンショットの明瞭な購入1件と、外部応募IDを持つ抽選1件を**ステージング環境に限定して**受付。
- Intake受付確認 → worker処理 → queue結果 → Firestore canonical readback → 在庫/抽選カレンダー反映を確認。
- 同じ報告の再送が重複しない。別番号の同じ抽選・申込番号なし・商品曖昧・在庫不足の報告は無理に登録せず review。
- Gmail、旧Queue、現行在庫、売却8件を破壊しない。
