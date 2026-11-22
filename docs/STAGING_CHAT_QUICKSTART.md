# Toreca Vault — 通常Chatからのstaging受付

更新: 2026-11-12 JST

## 目的と現在の境界

この手順はAndroidの通常Chatで文章・画像報告を受け、専用Google Sheetへ記録し、Cloud Run/Firestoreのstaging queueへ送るためのものです。受理状態をV2在庫登録済みと表現してはいけません。現在、stagingのcommand workerとV2 writesは停止しています。通常Chatから完全に自動化された報告-to-row E2Eもまだ検証中です。

## 通常Chatに最初に貼る指示

```text
Toreca Vault報告の受付を手伝ってください。報告文・画像から購入、受取、開封、売却、抽選の事実だけを読み取ってください。
記録先はGoogle Driveの専用「Toreca Vault New App Intake」スプレッドシートのIntakeタブだけです。旧V2 Command Queue、旧V2、他のシートには書かないでください。
書く前にIntakeのA:Gを読み、同じ報告/requestIdが既にないか確認してください。既存行は変更・並替え・削除・再送しないでください。
完全で曖昧さのない報告だけ、末尾に1行追加します。A=requestId（normalchat:日付:イベントslug）、B=報告事実だけのJSON command、C=抽選commandのbusinessEventIdentity JSON（抽選以外は空欄）、D=new、E:Gは空欄。書込み後、その行を読み戻して値を照合してください。
金額、商品名、数量、日付、店舗、状態、抽選識別情報など必須項目が不明・画像で判別不能・重複の疑いがある場合は推測しないでください。先に質問するか、明確な理由を付けてD=reviewにしてください。過去支払い済みの受取は原価を再計上しないでください。抽選応募・当選・受取を購入として扱わないでください。
返答では受付行のrequestIdとstatusを示してください。status=queued/pendingはstaging queueの受付だけで、V2反映済みではありません。V2反映を主張できるのはstatus=doneかつcanonicalReadbackVerified=trueが読み戻せた場合だけです。APIトークンやSecretを表示・要求しないでください。
```

## Sheet列

| 列 | 内容 |
| --- | --- |
| A | 一意で安定した requestId |
| B | JSON command |
| C | 抽選の businessEventIdentity JSON。抽選以外は空欄 |
| D | `new`（受付対象）または `review`（要確認） |
| E:G | 受付後のworker receipt。ユーザーは空欄のままにする |

Intakeはappend-onlyです。既存行の再送・修正・ソートは禁止。受付後の再試行は同じ行と同じrequestIdで行い、accepted/queued行を新しいrequestIdで複製しません。

## 受付済み状態

- 2026-11-06 30th CELEBRATION purchase: queue `pending`; `processed=false`; `canonicalReadbackVerified=false`.
- 2026-11-07 ORIGINAL ARTWORK DUEL SET receipt-only: `review/needs-review`; 過去支払い済みのため原価二重計上を避ける。
- staging queue status GET、Sheets receipt readback、staging Cloud Run healthは検証済み。
- 通常Chat Androidの単一セルwrite/read smoke testは成功。通常Chatからの完全な文章/画像報告→row生成→queue登録は未検証。
- 本番V2、旧queue、未処理売却8件は変更しない。V2 writes、worker、canonical import、本番移行は別途承認まで行わない。
