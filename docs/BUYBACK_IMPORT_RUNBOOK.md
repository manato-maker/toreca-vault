# Toreca Vault — 参考買取相場の更新手順（2026-11-14 JST）

## 目的と完成状態

新アプリの参考価格は**店舗の買取提示額**であり、購入原価・公式税込定価・希望販売価格・実際の買取成立額とは別の数値とする。店舗は当初「買取ミミ」「カードショップアリウム」「トレカショップKURO」。画像・商品名・状態・BOX/セット/カートン単位・元X投稿の日時を照合してから、現在有効な提示だけを買い取り評価に入れる。

**現在：コード実装と模擬テストまで。Cloud Run UI・Firestore staging canonicalへの最新コード配備、店舗公式Xの当日投稿の実照合、実買取額の取り込みは未完了。旧11/13表を11/14最新価格として登録しない。**

### 価格の証拠ゲート

1. 店舗本人のXプロフィール・対象**個別投稿URL**（`https://x.com/ACCOUNT/status/NUMERIC_ID`）であることを確認。公式な本人性、投稿本文、画像内の価格と商品名・単位を独立に検証。ページタイトルや第三者の比較表だけで`verified`としない。
2. 商品は正式名称と公式パッケージ・ロゴ・カラー・キャラクターを照合。30th CELEBRATION拡張BOX、9種カードセット、デッキセットは**別商品**。状態（シュリンク有無、テープ、段ボール未開封）と数量単位（BOX/pack/case）を正確に指定。
3. **買取ミミ** ポケカ画像は上段赤＝シュリンク有、下段青＝シュリンク無。ONE PIECEは赤＝1BOX、青＝1ケース。**アリウム** ポケカ画像は上段水色＝シュリンク有、下段黒＝シュリンク無。**KURO** ポケカ画像は上段黒＝シュリンク有、下段白＝シュリンク無。凡例、テキスト、画像位置が矛盾する場合は`review`。
4. 価格表の掲載日・投稿日時・利用期限・限定数量を確認。ピックアップ限定が終了したら`superseded`/無効、最新の低い提示額を採用。最新の有効提示額が不明な場合は「未取得」、信頼できる過去の提示は「旧価格」と表示して**現在の評価合計へ含めない**。
5. 税込定価を根拠に買取価格を創作しない。過去の買取表の数字も現在の価格として使わない。

## 実装した構成

- `cloud/src/buyback-quotes.js`: 公式元投稿のURL/日時/有効期限、shop、商品・状態・単位、verified状態の判定。店舗内では**最新の投稿のみ**を比較し、別店舗の現行提示額のうち最高額を取得。タイムスタンプ矛盾のある店舗は除外。
- `cloud/src/dashboard-view.js`: 参考買取評価額に原価代用なし。有効買取相場のある在庫の部分合計のみ。店舗別の金額と元投稿リンクを表示し、旧価格/未取得を明確に分離。
- `cloud/src/market-refresh-worker.js`: 定価/出典不明の値を拒否、店舗ごとの保存枠を分離。ただしX API/OCRの実providerは未接続。
- `cloud/src/verified-buyback-import.js`: 操作者が一次投稿の実内容を確認済みの非公開ローカルJSONを事前評価し、店舗別履歴を残しながらCAS更新・Firestore readback検証。事実が不一致なら適用停止。
- `cloud/scripts/import-verified-buyback.js`: ステージング限定の**preview**と明示承認後の**apply**。Google Cloudの認証済み環境が必要。実請求/バックアップを別に確認。GitHubへ個人保有商品の一覧やX画像・非公開JSONファイルをコミットしない。

### 非公開JSON入力の構造（架空テスト用・実相場として使用禁止）

```json
{
  "schemaVersion": 1,
  "mutationId": "verified-buyback:2026-11-14:manual-example-001",
  "quotes": [
    {
      "productKey": "example-box-a",
      "category": "BOX",
      "condition": "あり",
      "unit": "box",
      "price": 1000,
      "sourceStore": "買取ミミ",
      "postUrl": "https://x.com/mimi_kaitori/status/1234567890123456789",
      "postedAt": "2026-11-14T03:00:00+09:00",
      "validUntil": "2026-11-14",
      "status": "verified"
    }
  ]
}
```

上記はAPI契約だけを示すダミーデータ。**実在ポスト・確認済み商品・実額の証拠ではなく、絶対に実canonicalへ投入しない。** 実データで適用するには、本人の店舗投稿で価格/条件/有効性を照合したうえで、実際の`productKey`がFirestore inventory lotに正確に存在する必要がある。

### 認証済みCloud Shellでの安全な作業例

前提：`docs/CHAT_STAGING_RELEASE_RUNBOOK.md`に基づき既存GCPプロジェクト番号・バックアップの有効性・IAM・最新revを確認。cloud依存関係をインストールし、開発ブランチの作業コピーを取得する。

```bash
export GOOGLE_CLOUD_PROJECT=project-8ff0bbc4-675d-4596-a8a
export TV2_FIRESTORE_DOCUMENT=torecaVaultStaging/canonical

# 対象正本の既知revisionと、非公開の確認済み買取証拠JSONを指定
node cloud/scripts/import-verified-buyback.js preview /private/verified-quotes.json EXPECTED_REVISION

# 事前previewとバックアップ確認後だけ、明示承認して適用
TV2_VERIFIED_BUYBACK_IMPORT=YES TV2_BACKUP_VERIFIED=YES \
  node cloud/scripts/import-verified-buyback.js apply /private/verified-quotes.json EXPECTED_REVISION
```

`EXPECTED_REVISION`はCloud Shellで**現在のFirestore canonicalから読み取った整数**へ置き換える。プレビューは書込み0。反映は同一revisionのみ受理し、投稿・条件の同一性、重複、古い投稿の新規採用防止、異なる金額で同じ投稿URLを再使用する衝突防止を実施。成功時はrevision/readbackと追加/旧扱い件数だけ出力。商品の詳細や取引・認証情報は出力しない。

- 連続した投稿でも、店舗内は**より新しい投稿が先**。旧投稿は残すが`superseded`として現在価格に採用しない。
- 他店舗の証拠は上書きせず保持する。
- 既存の取引・在庫・抽選・購入原価は不変。
- `preview`/静的構造チェックだけでは**実在X投稿の確認はできない**。人が投稿と表を照合したことを別に記録すること。
- Firestore保存時のトランザクションCAS・保存後readback・バックアップを省略しない。実環境の権限不足であれば無理に公開化しない。
- 本番移行は別途承認。旧V2キューや未登録売却を価格調査のために再送しない。

## 残工程

- [x] 定価代用廃止、参考買取価格の表示、店舗内最新投稿優先、出典元投稿リンク
- [x] 店舗別quoteを残す構造、手動verifiedインポートのプレビュー・適用ゲート・回帰テスト
- [ ] 11/14以降の**店舗本人の一次X投稿**と画像内価格を照合し、実商品の価格証拠を確定
- [ ] Cloud Run/Firestoreの接続権限・費用・バックアップを点検
- [ ] ステージングにUIを配備、確認済みquoteだけをFirestoreへ保存・readback
- [ ] スマホで公式定価・購入原価と参考買取価格が別々に表示され、古い値が「最新」にならないと実機確認
- [ ] 完全自動X更新は正規API/OCR利用条件・料金・本人確認を検証後に別工程で導入

この文書が完了しても**実データが更新済みとは主張しない**。
