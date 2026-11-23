# BOX在庫をGrokの買取価格調査へ渡す（ステージング・読取専用）

## 目的
GrokはGoogle認証が必要なToreca Vaultの在庫を直接読み込めない。ユーザーが自分のCloud Shellで、Firestoreの**最新の在庫ロット**からBOXだけを取り出す。

出力は商品名・数量・封印状態のみで、購入原価・売却価格・店舗・リクエストID・個人情報は含めない。Firestore、Intake、Scheduler、旧V2、本番には一切書込まない。

## Android Cloud Shellでの使い方

以前認証済みのCloud Shellターミナルに一度だけ貼り付ける。

```bash
cd ~/tv-scoped-op18 && git pull --ff-only origin build/cloudrun-firestore-foundation-20261103 && node cloud/scripts/export-box-buyback-staging.js --export
```

成功すると `PASS: staging canonical BOX snapshot exported`、取得した正本revision、一覧と、Cloud Shellの `~/toreca-boxes-for-grok.txt` にテキストが保存される。ユーザーがテキストをGrokへ貼るか、Cloud Shellのファイルエクスプローラーから .txt をダウンロードしてGrokへ添付する。ファイルは所有者のみアクセス可能なローカル権限で生成する。**公開URLは作らない。**

## 出力仕様

- `inventoryLots` の `category=BOX` かつ `quantity>0` だけを使用。取引履歴からBOXを二重計上しない。
- 同じ商品・封印状態ごとに数量を合計。シュリンクありとなしは分離する。
- **調査対象**: 記録済みのシュリンクあり／なし、明記されたテープ未カット。
- **要確認**: 封印状態が空欄、単に「未開封」、単に「テープ付き」（カット状態未確認）、テープなし、矛盾する状態。Grokには**商品名ベースで状態別の参考価格調査**を依頼できるが、保有品の確定査定額として扱わない。
- **除外**: 開封済み・開封用・テープカット・バラパック等。残パックはBOXとして数えない。
- Grok側は調査対象に載った商品・数量・状態を照合し、**要確認BOXも名前による参考相場検索のみ可能**とする。名称が似た2行があっても勝手に結合しない。要確認と除外は別欄として扱う。価格は買取ミミ、カードショップアリウム、AMTAF日本橋のX投稿の文章と画像の両方で判定し、投稿日時・URLを出典とする。情報がない価格は未確認とする。

**重要:** この出力は実行時点の在庫スナップショットで、Grokへの毎日自動同期ではない。商品が増減したときに同じコマンドで再出力して最新の一覧を渡す。直接同期を実現する場合は、共有方法・認可・Grokが受け取れるAPIを別途設計する必要がある。
