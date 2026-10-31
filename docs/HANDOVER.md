# Toreca Vault 引き継ぎ

更新日: 2026-10-24 (JST)

## 最初に確認すること

- コードの正本: [GitHub `manato-maker/toreca-vault`](https://github.com/manato-maker/toreca-vault)。`main` と未完了PRの差分を確認する。
- 自動化: `automation/Code.gs` (既存のメール解析とカードCSV取得) と `automation/V2Automation.gs` (V2への定期反映)。定期トリガーは Apps Script 側で動く。
- V2のAPIとDrive JSONは認証付きの別経路。同期トークンやDriveファイルIDはこのファイルに書かない。
- スマホ主体で、チャットからの代行を希望。ブラウザ内の同期キーをチャットへ送らせない。
- このファイルを渡しても権限は移らない。次の担当者は接続済みGitHub権限、Apps Scriptのデプロイ権限、対象データへのアクセス権をその都度確認する。

## リモート変更の手順

1. `main` の最新状態を取得し、別ブランチで変更。既存の未コミット変更を消さない。
2. コードと必要なテストを変更し、**同じ変更でこのファイルに目的・差分・検証・本番状態を追記**する。
3. `npm test` と `npm run check`、必要な実データを使わない安全な受入テストを実行する。
4. 接続済みのGitHub経路でブランチとPRを作り、CI後にマージ。`automation/**` のmain更新は `.github/workflows/apps-script-deploy.yml` から Apps Script へ反映される。既存APIとmanifestを保持し、remoteで一致を検証する。
5. GitHub Actions の成功と Apps Script の実行ログ、V2 JSON の `automation.health` と revision を確認する。CI成功だけで実データ更新完了とは判断しない。

## 現在の動作と制約

- Gmail抽選: JST 12:30と19:00のトリガー。直近2日を重ねて検索し、IDで重複防止。曖昧な結果・競合は要確認。
- カード相場: カードラッシュCSVで商品名・型番・状態を照合できたカードのみ更新。
- BOX/パック: 大阪日本橋の買取ミミ・AMTAF・アリウムのX投稿への直接出典URLを持つ、当日掲載の同一商品・同一状態の最高価格を対象。対象外・不一致・古い掲載は価格を維持する。
- ホームページの集計価格を商品周辺の文字だけで推定しない。画像からの商品同定が必要で公式情報と照合できないものは要確認。

## 変更記録

### 2026-10-24 — Apps Script Gmail quota failure and scoped Cardbox audit recovery

- 発見: Apps Script の `runTv2Automation` が 15分ごとに失敗し、`Exception: Service invoked too many times for one day: gmail`。実行ログでは、完了済みのエディオン橿原alias repairが毎回Gmail下書きを削除・再作成していた。
- 変更: canonical V2にrepair markerと期待状態が既にある場合は、1回のreadで確認してrepairをskipし、毎回のGmail呼び出しを避ける。未処理の `[Toreca Vault Command]` のうち資産監査だけを1件処理する、他コマンドに触れない `runTv2AssetAuditOnce()` を追加。
- 検証: repair済みの再実行で mutation/Gmail draft access が発生しないテスト、監査の単独処理・複数件時停止テストを追加。`npm test` 221件、`npm run check`、Apps Script構文検査、`git diff --check` 成功。
- 本番状態: PR・デプロイ・監査command実行・V2再読込は未確認。ユーザーからのCardbox応募スクリーンショットを申込の根拠として扱い、Gmail応募メールを前提にしない。Gmail command draftは送信せず、成功後も結果draftとして保持する。

### 2026-10-24 — Cardbox抽選3件をV2へ登録

- ユーザー提供スクリーンショットを応募証拠として、カードボックス オーサカ店「ハドウシーカー」1BOX、カードボックス日本橋店「ハドウシーカー」1BOX、「神の支配」OP-18 1BOXの3応募を登録対象とする。予約前なので購入履歴・在庫には加算しない。前払い額は当選時のメモにのみ記録。
- Apps Script `runTv2AssetAuditOnce()` 実行後のcanonical監査はrevision 2178。3対象について抽選・購入履歴・在庫が0件で、既存登録・原価重複なし。
- 3件だけ登録し再読込検証する `runTv2CardboxLotteryApplications20261024()` を追加。重複が1件でも検出された場合は全件書き込み前に停止する。Apps Scriptの関数一覧から手動実行できる名前にした。テストは3件登録・前払い額メモ・部分重複時停止を確認。
- 2026-10-24時点の本番登録は未完了。コードの追加デプロイ後に一度だけ実行し、正本revisionと3件を再読込確認する。Gmail commandは送信しない。

### 2026-10-24 — カードボックス オーサカ店「神の支配」応募を追加

- ユーザーの応募画面スクリーンショットを確認。対象は `ONE PIECEカードゲーム ブースターパック「神の支配」OP-18 1BOX`、カードボックス オーサカ店、応募日10/24、応募締切11/3、結果発表予定11/4、当選後の店頭予約期間11/4 11:00〜11/13 22:00。
- 先に既存V2抽選を照合し、同一店舗・商品・応募日（または締切と結果日）候補を一意確認する。購入・受取前のため購入履歴・在庫には加算しない。スクリーンショットにない購入価格は登録しない。
- 既存3応募バッチの再実行とは分離した `runTv2CardboxOsakaKaminoshihaiApplication20261024()` を追加。既存の同一イベントが一意なら重複作成せず、内容が不一致または複数候補なら停止する。
- テストは新規1件登録・日付/予約期間記録・同日意味一致record検出時の重複防止を確認する。
- 本番: GitHub PR/Apps Script deploy/実行とV2再読込は未完了。Gmail command draftは送信しない。

### 2026-10-19 — 30th CELEBRATION開封シングルの相場照合を修正

- 目的: 開封で取得したジラーチex SAR (M6a 132/103) とゲンガー (M6a 150/103) の買取相場をV2へ記録する。取得原価0円は市場価格の照合対象から除外する理由にしない。
- 原因: シングル自動取得は数量が正のカードlotを対象にするが、商品名も価格表と完全一致させる。開封記録の商品名「ジラーチex SAR」「ゲンガー（金色・30th仕様）」と買取表の名称「ジラーチex」「ゲンガー」が一致せず、型番が合っていても取得を落としていた。
- 変更: `M6a 132/103` のジラーチex、`M6a 150/103` のゲンガーだけ、検索名を各カードの基準名に正規化する。商品名に加えカード番号も必須のままにして、同名の別収録・別版を誤照合しない。原価・購入履歴・在庫数量は変更しない。
- 検証: 原価0円の2 lotについて名称・型番の照合と引用のlotId/価格反映をテスト。`npm test` 218件、`npm run check`、`git diff --check` 成功。実V2の相場再取得と再読込はデプロイ後に確認する。
- 本番状態: 未デプロイ。

### 2026-10-19 — 対象限定のシングル相場再取得

- 目的: ジラーチex SARとゲンガーだけをすぐ再取得し、古いGmailコマンドdraftを巻き込まない。
- 変更: `market-refresh-cards` が `targets` を受け取ると、lotId・商品名・型番をV2正本に照合してからそのlotだけを価格対象にする。キューに相場更新draftが1件あればそれだけを処理し、他のコマンドdraftは保持する。複数の相場更新draftがある場合は安全停止する。
- 検証: 対象外lotを変更しない回帰テスト、古い別コマンドdraftを処理しないqueueテストを追加。`npm test` 219件、`npm run check`、Apps Script構文検査、`git diff --check` 成功。
- 本番状態: 未デプロイ。

### 2026-10-18 — パック開封シングル原価を0に訂正

- 目的: パック購入費は購入履歴に保持し、開封で得たシングルへ原価を二重計上しない。
- 変更: 限定対象ID・期待値・revisionを照合する `asset-cost-adjustment` コマンドを追加。開封取引の取得原価と派生シングルlotの原価を0にし、購入履歴を変更しない。修正コマンドがキューにある実行では、その1件だけを処理し、他のcommand draftを残す。
- 検証: 原価0の反映、購入行の維持、二重実行時のrevision据置、古いrevision拒否、他のキューdraft非処理を自動テスト。`npm test` 218件、`npm run check`、Apps Script構文検査、`git diff --check` 成功。
- 本番状態: PR #73 をマージし、Apps Script配布 #273 のpushとremote source verifyが成功。15分runnerがcommandを処理し、結果draftとV2再読込で正本revision 1844、購入記録維持、開封取引とシングルlotの原価0を確認。command draftは処理後に削除され、非送信の結果draftが残る。
- 残件: `clasp run` による直接実行はApps Script API権限エラーで使用不可。今回の実データ変更は既存の定期runner経由で完了。

### 2026-09-25 — PR #55 Gmailとカード相場のV2定期処理

- 目的: Gmailの配信遅延による見落としを減らし、確認できるカード相場を自動更新する。
- 変更: Gmail検索を2日重複させてページング、IDで重複防止。型番・商品名・状態が一致するカードの買取価格を更新。Apps Scriptデプロイ時に既存APIとmanifestを保持して検証する。
- 検証: 162テスト通過、`npm run check` 通過。[PR #55](https://github.com/manato-maker/toreca-vault/pull/55) をマージし、[デプロイ実行 #13](https://github.com/manato-maker/toreca-vault/actions/runs/36095713531) 成功。
- 残件: Gmail/相場の次回トリガーによる実データ更新は未検証。BOX/パックは当時要確認のみ。

### 2026-09-25 — BOX優先・バラパックの価格自動照合

- 目的: 大阪日本橋の3店舗で確認できる同一商品・同一状態の最高買取価格を、毎日安全にV2へ反映する。
- 変更: `automation/V2Automation.gs` で当日掲載の比較ページを取得し、商品名称、シュリンク有/無またはバラパック、3店舗のX投稿への直接リンクを一緒に照合する。公式で確認済みの商品名を例に、画像の周辺文字や別商品・別状態の価格を流用しない。更新には店舗名・日付・X出典を記録し、前回から50%を超える価格変動は要確認とする。価格サイトの当日更新時刻を考慮し、相場トリガーをJST 15:00に移す。`AGENTS.md` を追加し、変更のたびにこのファイルを更新する。
- 検証: 2026-09-25の公開HTMLで93商品の構造を解析し、30th CELEBRATION・MEGAドリームex・インフェルノXの3状態とX出典を照合。商品名はポケモンカードゲーム公式の商品情報と照合。163テストと `npm run check` 通過。テストでは高額な別店舗や別商品からの混入、状態違い、古い日付、大幅な価格変動を拒否。
- 本番状態: [PR #56](https://github.com/manato-maker/toreca-vault/pull/56) をマージし、[Apps Scriptデプロイ実行 #14](https://github.com/manato-maker/toreca-vault/actions/runs/36097032307) のtest/deploy両ジョブ成功。これによりスクリプトのHEADへ反映済み。実際の当日相場反映、V2 revision、トリガーの15:00移行は次回実行まで未検証。
- 残件: 価格サイトの仕様変更、X投稿からのOCR誤り、画像だけの商品判定は自動で確定できない。初回の実データ反映と15:00トリガー移行を確認する。

### 2026-09-25 — 本番反映後の記録更新

- 目的: 次の担当者がコード配布の成功と実データ反映の未確認を区別できるようにする。
- 変更: このファイルのPR #56本番状態にデプロイ実行 #14の結果と、翌日のトリガー確認項目を追記した。実行コードや認証情報は変更しない。
- 検証: GitHub Actions上でtest/deploy両ジョブのSuccessを確認。相場データ自体はまだ未確認。

### 2026-09-25 — BOX店舗別の最終確認価格を比較

- 目的: 当日投稿の有無に依存せず、買取ミミ・AMTAF・アリウムの各店舗で最後に確認できた同一商品・同一状態の価格から最高値を選ぶ。
- 変更: `automation/V2Automation.gs` で店舗別X出典URL・掲載日・価格を `marketQuotes[].shopOffers` に保持し、新しい掲載時だけ店舗単位で置き換える。最高値の店舗が古い掲載なら `fresh=false` とし、出典に元の日付を残す。未来日や掲載日とスナップショット日の不一致は拒否。READMEと運用説明を修正。
- 検証: 店舗の掲載が途絶えた翌日も最後の価格を比較し、同一店舗の新しい価格があれば置き換え、状態不一致を拒む自動テストを追加。`npm test` 163件と `npm run check` 通過。実データのV2更新は未検証。
- 本番状態: [PR #57](https://github.com/manato-maker/toreca-vault/pull/57) をマージし、[Apps Scriptデプロイ実行 #15](https://github.com/manato-maker/toreca-vault/actions/runs/36123921574) のtest/deploy両ジョブ成功。Apps ScriptのHEADへ配布済み。V2正本の価格が次回実行で変わったかは未検証。
- 残件: 掲載元は店舗の当日初回投稿であり、Xの日中更新や買取終了は自動把握できない。初回導入時は以前の最高値しか保存されておらず、未記録店舗の過去分は遡及できない。店舗の本当の最新相場として表示するには、Xの新投稿を直接取得・確認できる取得経路が必要。

### 2026-09-25 — X追加投稿・画像価格の追跡

- 目的: 大阪日本橋の３店が同じ日に出す追加投稿での買取増額・減額を、店舗別の最終価格に反映する。
- 変更: X APIで投稿時刻・投稿ID・画像URLを確認し、Cloud Visionで画像文字を読み、在庫商品・シュリンク状態・１価格を同じ行で照合できる場合だけ上書きする。後の投稿による減額も優先し、その後３店舗の最高値を選ぶ。画像に不確実性がある店舗は保留して要確認に残す。19:00/22:00の追加実行は両資格情報が設定された場合のみ作成する。`AGENTS.md` に引き継ぎ後も毎変更を自動記録する継続ルールを明示した。資格情報は記載しない。
- 検証: X APIとOCRの模擬応答で投稿順、値下げ、店舗間の最高値、再実行の重複防止、読めない画像の保留を試験。`npm test` 164件と `npm run check` が通過。
- 本番状態: [PR #58](https://github.com/manato-maker/toreca-vault/pull/58) をマージし、[Apps Scriptデプロイ実行 #16](https://github.com/manato-maker/toreca-vault/actions/runs/36126004394) のtest/deploy両ジョブ成功。スクリプトHEADへ配布済み。X APIとVisionの資格情報設定・定期トリガー・実データ反映は未確認。
- 残件: X APIとCloud Visionの有効な認証情報と利用枠がなければ追加投稿の自動反映は起動しない。OCRで商品・状態・価格を確定できない表は手動照合が必要。投稿削除と受付終了の暗黙の変更は検出できない。

### 2026-09-25 — 追加料金のない昼の相場確認タスクへ更新

- 目的: 有料X APIを使わずにBOXの当日追加投稿とシングル相場の見落としを減らす。
- 変更: 既存のChatGPT定期タスク「Toreca Vault相場更新」を「Toreca BOX・シングル相場確認」に更新。JST 13:00の日次設定を維持し、３店舗の最新X投稿・画像・値下げ、カードラッシュの完全一致を確認して出典つきで報告する。以前の私有Drive JSONへの直接上書き指示を外し、V2正本への権限・対象を検証できない場合は報告のみとした。新しいタスクと有料API設定は追加しない。
- 検証: 自動化更新APIの成功応答でタスクが有効、従来のJST 13:00日次時刻を保持していることを確認。次回実行で公開投稿の可視性と結果を確認する。
- 本番状態: ChatGPT定期タスクの設定更新済み。V2正本への自動書き込みは未実装・未検証。
- 残件: Xの画像が定期実行で読めない場合は要確認。日中13時以降の追加投稿は次回確認または手動指示を要する。

### 2026-09-25 — エーフィ・ブラッキーの未開封デッキ相場とカード番号

- 目的: 在庫上BOXに分類されたプレミアムデッキセットの相場漏れを解消し、シングルの収録・番号を在庫画面で確認できるようにする。
- 変更: 公開比較表の `sealed_other` を対象商品の完全一致に限定して読み取り、在庫状態が未指定・対象外・未開封の当該デッキのみ比較表の未開封価格へ照合する。大阪日本橋のアリウム、AMTAF、買取ミミに限定し、X出典と日付を保持する。V2購入・旧データ移行時にカードの `set` を保ち、在庫名の後ろに表示。V2在庫の「番号を登録／修正」から入力すると保存後照合、監査記録、旧相場の要再確認化を実施し、書込ゲートを閉じる。
- 検証: 公開比較表の2026-09-25掲載で対象商品にアリウム16,000円、AMTAF17,500円、買取ミミ15,600円を確認。対象外の商品・店舗は従来どおり除外。デッキ・番号の回帰試験と `npm test`、`npm run check` を実行。
- 本番状態: [PR #59](https://github.com/manato-maker/toreca-vault/pull/59) をマージ。[CI #472](https://github.com/manato-maker/toreca-vault/actions/runs/36133252631)、[Apps Script配布 #17](https://github.com/manato-maker/toreca-vault/actions/runs/36133371201)、[GitHub Pages配布 #63](https://github.com/manato-maker/toreca-vault/actions/runs/36133371252) の成功を確認。実際のV2価格反映と既存カード番号登録は未確認。
- 残件: 価格表は各店の当日初回投稿を掲載し、日中の追加投稿は別の取得手段が必要。既存カードで番号が未記録のものはカード本体・収録番号の照合が必要であり価格だけから推定しない。実在庫の自動反映を未確認。

### 2026-09-25 — 旧在庫のカード番号を安全に復元

- 目的: 旧データからV2へ移行する際に落ちたカード番号を、スマホで1件ずつ入力せず既存V2在庫へ戻す。
- 変更: `v2/ui-write.js` に旧在庫ID・商品名の一致を全件検証してから単一revisionで番号だけを復元する一括操作を追加。既に別番号がある場合、同じ旧IDが重複する場合、対象がない場合は保存前に停止し、旧相場を要確認とする。設定画面にJSONファイルの選択欄を追加。プロモ番号にも対応。ユーザーが提供した一覧から、旧在庫で一意に照合できた10件の復元JSONはリポジトリに含めず別途本人へ渡す。
- 検証: 番号の形式・旧在庫照合と既存V2データの不変条件を自動テストし、`npm test` と `npm run check` を実行。実データの現在revisionへの書き込みは未実行。
- 本番状態: [PR #60](https://github.com/manato-maker/toreca-vault/pull/60) をマージ。[CI #473](https://github.com/manato-maker/toreca-vault/actions/runs/36135703768) と [GitHub Pages配布 #65](https://github.com/manato-maker/toreca-vault/actions/runs/36135758122) 成功。公開HTMLに復元欄があることを確認。ユーザー端末上のV2書込ゲートとファイル選択による正本更新は未実行。
- 残件: 同名ピカチュウ3件は元記録上の対応を特定できず復元ファイルに含めない。既に商品名に番号がある新しい3件は変更不要。元のV1バックアップか現物・取得履歴で3件を照合する。公開買取表で状態・版違いが区別できない場合は相場更新を保留する。

### 2026-09-25 — 同名ピカチュウの相場による仮対応

- 目的: ユーザー提供の16件の番号を既存在庫に近い評価額で照合しつつ、同名３件の誤った自動相場更新を防ぐ。
- 変更: 個人の在庫IDを公開リポジトリへ入れず、前回の本人専用復元JSONを13件へ更新。旧評価500円の１件をMC 225/742に、旧評価1,500円の２件を取得原価も補助としてPROMO 001/SV-PとSV2a 025/165に仮対応。取引記録がないため３件には `inferred=true` を付ける。一括復元時に在庫へ「要確認」を保存し、現物確認までカードラッシュ自動更新を停止する。手動で番号を確定登録するとフラグを解除する。番号が異なる同名カードはlot IDごとに相場を処理し、別lotの相場を共有しないように修正。画面に推定・要確認を表示。
- 検証: 公開買取表でMC 225/742、001/SV-P、SV2a 025/165の版による違いを確認。模擬同名３lotで別々に処理し、推定lotは旧価格を保持する試験、既存テスト、`npm run check` を実行。
- 本番状態: [PR #61](https://github.com/manato-maker/toreca-vault/pull/61) をマージ。[CI #474](https://github.com/manato-maker/toreca-vault/actions/runs/36137260263)、[Apps Script配布 #18](https://github.com/manato-maker/toreca-vault/actions/runs/36137319592)、[GitHub Pages配布 #67](https://github.com/manato-maker/toreca-vault/actions/runs/36137319555) の成功を確認。本人専用復元ファイルは13件へ更新済み。V2正本への反映は本人端末でファイル選択後まで未実行。
- 残件: 旧評価が1,500円で一致する２件の対応と、SV2a 025/165のミラー仕様は価格から一意に確定できない。推定３件の現物・旧バックアップ照合が必要。相場は確認後に再評価する。

### 2026-09-25 — ピカチュウの仕様違いを確定

- 目的: ユーザー提供の買取表画像を根拠に、同名ピカチュウの番号だけで異なる仕様の買取相場を混同しない。ユーザーは現在の旧在庫３件への割り当てを確定するよう指示。
- 変更: 本人専用の13件復元JSONで３件の `inferred` を外し、MC 225/742に「ミラー」、SV2a 025/165に「モンスターボールミラー」を追加。V2一括復元は仕様違いを保存し、前回ファイルによる仮登録を済ませていた場合も番号一致なら仕様違いと要確認フラグを安全に更新する。画面にも仕様を表示する。カードラッシュCSVの自動照合は225/742と025/165で仕様未指定なら保留し、ミラー・モンスターボールミラー・マスターボールミラーを別行として扱う。ユーザー画像では225/742ミラー500円/通常300円、001/SV-P 2,000円、025/165モンスターボールミラー800円/通常30円/マスターボールミラー45,000円。CSVの現行金額とは別の画面証拠であり、実在庫の価格は自動実行まで維持する。
- 検証: ３仕様を含む模擬買取行で期待価格のみ採用し、番号だけでは保留する試験。`npm test` 168件、`npm run check` 通過。
- 本番状態: [PR #62](https://github.com/manato-maker/toreca-vault/pull/62) をマージ。[CI #475](https://github.com/manato-maker/toreca-vault/actions/runs/36138224575)、[Apps Script配布 #19](https://github.com/manato-maker/toreca-vault/actions/workflows/apps-script-deploy.yml)、[GitHub Pages配布 #69](https://github.com/manato-maker/toreca-vault/actions/workflows/pages.yml) の成功を確認。本人専用の確定版復元ファイルを保存済み。V2正本への一括反映は本人端末でファイル選択するまで未実行。

### 2026-09-26 — チャットを跨ぐGitHub経由のApps Script配布を修復

- 目的: 新しいチャットでもGitHub接続でコード変更からApps Script配布まで代行し、カードラッシュの仕様違い照合を実際のスクリプトへ届ける。
- 発見: PR #62 のCIとApps Script配布 #19は成功したが、既存デプロイは `automation/V2Automation.gs` のみを置換し、`automation/Code.gs` 内の `findCardrushBuyback_` の変更を既存の `Code.js` に適用していなかった。GitHubの成功だけで本番の仕様違い照合が更新済みと判断できない。
- 変更: `scripts/patch-cardrush-buyback.mjs` で既存Apps ScriptのAPIとmanifestを維持しつつ、カードラッシュ照合関数だけをリポジトリ正本に差し替える。配布後にリモートから再取得してパッチ済みファイルと比較する。workflowとパッチャーの変更でも配布が起動するようにする。新チャットは接続済みGitHubプラグインから同じmain/Actionsを使い、認証情報は受け渡さない。
- 検証: リモートAPI模擬ファイルの前後を比較し、関数以外の不変と再実行の同一性を確認。`npm test` 169件、`npm run check` 通過。
- 本番状態: [PR #63](https://github.com/manato-maker/toreca-vault/pull/63) をマージ。[CI #476](https://github.com/manato-maker/toreca-vault/actions/runs/36152815173) と [Apps Script配布 #20](https://github.com/manato-maker/toreca-vault/actions/runs/36152868555) 成功。配布ジョブで既存API・manifestの保全と関数のリモート再取得一致を確認。GitHub接続は現在のチャットで動作確認済み。新チャットのプラグイン利用可否は、そのチャットで確認する。本人端末のV2復元JSON取り込みと実相場更新は未確認。


### 2026-09-26 — V2正本を端末の永続表示元に固定

- 目的: V2接続済み端末の再読み込み後にローカル在庫へ戻り、旧ローカル在庫の重複（ユーザー実機ではコイキングが2件）を正本のように表示する事故を防ぐ。
- 変更: V2接続成功時に端末へ「V2正本を使用する」永続マーカーを保存し、保存済みV2 URL/キーがある限り起動時に自動再接続する。V2利用端末で設定が欠けた場合もローカル在庫へフォールバックせず「V2再接続が必要」として在庫表示をfail closedする。明示的な「接続解除」のみマーカーを削除する。
- 検証: V2ブラウザ同期テストに、セッションを跨いだURL/キーと永続マーカーの保持、明示解除時の削除を追加。CIで npm test / npm run check を確認する。
- 本番状態: [PR #64](https://github.com/manato-maker/toreca-vault/pull/64) をマージ。GitHub Pages配布 #70（run 36220841201）成功。本人端末での再読み込み後表示は未確認。
- 残件: 端末側でブラウザサイトデータ自体を消去した場合は同期キーを復元できないため再接続が必要。ローカル側の重複データは正本ではないので、この変更ではV2へ取り込まず削除もしない。


### 2026-09-26 — チャット申告の売却をV2正本へ直接記録する経路

- 目的: ユーザーがチャットで「商品・数量・売却額・売却先」を申告した後、スマホで同じ売却を再入力せずV2正本へ反映できるようにする。
- 変更: `automation/V2Automation.gs` に `runTv2ChatSale(command)` を追加。Apps Script側に既に保存されたV2同期URL/トークンを使い、商品・カテゴリ・状態をV2在庫に厳密照合してFIFOで数量を減らし、sale取引・売却先・取得原価・監査revisionを正本へ保存する。requestIdから取引IDを固定し、同じ申告の再実行を重複登録しない。対象在庫不足や曖昧な条件では書き込まず停止する。秘密情報をGitHubやチャットへ出さない。
- 検証: ソース契約テストにチャット売却関数、冪等ID、在庫不足停止、chat出典を追加。CIで `npm test` / `npm run check` を確認する。
- 本番状態: [PR #65](https://github.com/manato-maker/toreca-vault/pull/65) をマージ。CI成功後、Apps Script配布 #21（run 36221038115）も成功し、`runTv2ChatSale` は本番Apps Scriptへ配布済み。最初の実データ「30th CELEBRATION COLLECTION 1BOX / 24,100円 / 買取ミミ / 2026-09-26」は、ChatGPTからApps Script関数を直接実行する認証済み接続口が現在ないため未反映。反映済みと誤認しないこと。
- 残件: ChatGPTからApps Script関数を直接実行する接続口は別途必要。接続口が利用できないチャットでは、GitHubへのコード配布だけで実データ書き込み完了とは扱わない。商品名・状態が一意でない申告は自動確定しない。


### 2026-09-26 — 次チャットへの未完了売却と自動化状態の確定引き継ぎ

- 現在の最優先: 「30th CELEBRATION COLLECTION」を2026-09-26に1BOX、24,100円で買取ミミへ売却した申告をV2正本へ反映する。ユーザーはこの売却内容を確定済みで、再確認は不要。
- 現状: 売却用の `runTv2ChatSale(command)` はPR #65でmainへ入り、Apps Script配布 #21（run 36221038115）成功。だが現在のChatGPT接続にはApps Script関数を直接実行する認証済みコネクタがなく、V2実データは未反映。GitHubへのコード配布を売却反映と扱わない。
- 次チャットの進め方: まず `AGENTS.md`、このHANDOVER、main、最新Actionsを確認する。上記売却を二重登録防止requestId付きで一度だけ実行できる安全な接続口が利用可能か確認し、可能ならV2 revision・在庫1BOX減算・sale取引を実データで検証する。同期キーやV2トークンをユーザーにチャット送信させない。
- 自動化目標: 一度だけ必要な認証・接続が成立した後は、ユーザーがチャットで売買内容を申告するだけでV2正本まで反映し、スマホでの二重入力を不要にする。


### 2026-09-26 — チャット売買入力を購入にも拡張

- 目的: チャットから売却だけでなく購入もV2正本へ登録できる経路を準備する。
- 変更: `runTv2ChatPurchase(command)` を追加し、購入取引と在庫lotをrequestIdで冪等登録する。売却は状態未指定で複数状態lotがある場合に停止し、重複requestIdはrevisionを増やさない。
- 検証: 購入関数、購入lot、状態曖昧停止、no-op revisionの契約テストを追加。Actionsで結果確認する。
- 本番状態: mainへ実装済み。Apps Script配布 #22（run 36221401223）成功。売却・購入関数とも本番Apps Scriptへ配布済み。
- 残件: ChatGPTからApps Script関数を直接実行する認証済み接続口が必要。秘密情報や売買データを公開GitHub履歴へ流す方式は採用しない。


### 2026-09-26 — チャット売買の下書き連携

- 目的: チャットで申告した売買をスマホで再入力せずV2へ渡す。
- 変更: 専用件名のGmail下書きを定期ジョブ開始時に読み、sale/purchaseを既存の冪等処理へ渡し、成功後に下書きを削除する。購入日付の検証も修正。
- 検証: 下書き取得・種別確認・成功後削除の契約テストを追加。Actionsで配布結果を確認する。
- 本番状態: mainへ実装済み。Apps Script配布結果の確認待ち。
- 残件: 最初の実データ処理とV2 revision・在庫減算を確認する。


## 2026-09-26 — market parser repair
- BOX/pack market feed now uses structured product + condition + shop + X-source matching instead of proximity text parsing.
- Full tests passed; Apps Script deploy 36228092071 succeeded with remote-source verification.
- Active legacy lottery/market functions now invoke the V2 chat-trade draft queue; deploy 36228126252 succeeded with remote-source verification.
- Sale command remains pending until a time trigger consumes it; verify canonical state before reporting completion.


## 2026-10-18 — V2資産照合の読取監査経路
- 発見: Apps Scriptの汎用コマンドキューには purchase（新規取引/lot作成）はあるが、受取済み抽選・既存注文への安全な購入履歴/在庫lot紐付け、パック開封・獲得カード/残存プロモパックの照合経路がない。接続済みApps Script直接実行コネクタもない。
- 変更: `asset-audit` を専用allowlistに追加。対象フィルターは非公開のGmailコマンドから受け取り、V2正本の抽選・取引・lot・開封・シングル・パック候補、revision、件数を専用のGmail監査結果draftへ出す。監査関数はread-onlyであり、既存・新規データを変更しない。Gmailコマンドdraftは送信しない。
- テスト: 対象レコードの絞り込み、無関係レコードの除外、revision/read-only契約を検証する `test/v2-asset-audit.test.js` を追加。`npm test` と `npm run check` を実行する。
- 本番状態: PR #67 をmerge commit `b7eedabfa248e76d5a8a12247d6676e5786bd59f` でmainへ反映。V2 CI #480 success（211 tests）、Apps Script deploy #269 / run `39121318741` はtest・push・remote verify success。read-only監査command `asset-audit-20261018-01` を2026-10-18 19:58 JST頃に非公開Gmail queueへ投入。queue処理結果draftと正本revisionは確認待ち。
- 制限: 受取・開封・在庫の実更新は監査の一意候補と申告値が一致する場合のみ行う。複数候補・候補欠落・revision drift・同一requestIdの監査結果draft既存はfail-closedとし、結果draftを削除しない。更新成功後はV2正本を再読込する。

### 2026-10-18 Command queue diagnostics
- 発見: read-only asset-audit command draftが定期処理後も残ったが、キュー処理は例外を戻り値だけに保持して結果を出さないため、停止理由が確認できない。
- 変更: command失敗時、元command draftを保持したまま、非公開GmailへrequestId単位で重複しない `[Toreca Vault Command Error]` draftを作る。成功時のみcommand draftを削除する。正本データは変更しない。
- テスト: `test/v2-asset-audit.test.js` に失敗時のqueue保持とdiagnostic draftの一意性を追加。`npm test`（212 tests）、`npm run check`、Apps Script syntax check、`git diff --check` success。
- 本番状態: PRとデプロイ待ち。asset-audit requestは処理失敗理由を確認後に再試行し、V2正本の再読込を行う。

### 2026-10-18 Atomic asset reconciliation
- 変更: `asset-reconcile` は監査revision以上の正本のみ対象にし、同日/同店/同商品購入候補、購入ID、lot ID、開封元ID、抽選IDと期待状態を検査する。購入・既存抽選の受取更新・開封・派生lot作成を一度に保存し、開封原価と派生lot原価合計の一致を強制する。成功後はrevision、取引、抽選、在庫を再読込検証する。
- 仕訳方針: シュリンク袋代等の付帯費用は商品単価に含めない。定価を購入単価/在庫原価、割引後決済額を `actualPaidTotal` に記録する。開封packは数量0で消去し、シングル/付属パックへ同じ原価を配分して二重計上を防ぐ。
- テスト: 購入・開封・原価配分、再実行時の冪等性、古いrevision停止、command失敗診断を検証。
- 本番状態: 妻分9種セットは本人確認により2026-09-05当選分を特定。反映commandと保存後revision/在庫の確認待ち。

### 2026-10-18 Scoped asset reconciliation runner
- 発見: 汎用runnerを即時実行すると、今回対象外の古い売却commandも処理される可能性がある。また、同じ受取日に同一店舗・同一商品となる別当選分を同一commandへまとめるケースがある。
- 変更: 正本照合の重複検査は実行開始時点の既存取引だけを対象にし、同一command内の別lottery参照購入を誤検知しない。デプロイ成功後のGitHub Actionsから `runTv2AssetReconcileOnce` だけを呼び、他種別のcommandは未処理のまま残す。Actionsへ返す値は処理件数とrevisionだけに限定し、購入明細は非公開のGmail結果draftに保持する。
- テスト: 同一command内の同日・同店・同商品二件、売却draftを残す専用runner、複数資産command時のfail-closed、デプロイ成功依存のworkflowを検証する。
- 本番状態: PR・CI・Apps Script配布後に対象commandのみを実行し、正本を再読込してrevision・履歴・在庫数量を確認する。

### 2026-10-18 Post-deploy execution follow-up
- PR #70 はmainへmerge済み。CI #484 success、Apps Script deploy #272 はpushおよびremote source verify success。
- デプロイ後の専用Apps Script実行はGoogle側から実行権限エラーで拒否された。関数は起動せず、asset-reconcile結果draftも作成されていないため、今回の資産照合commandは未処理のまま維持する。
- 公式 `scripts.run` 要件に照らし、API executable deployment、script/callerの共通standard Cloud project、Apps Script API有効化、およびscript scopeを含むOAuth承認の構成確認が必要。認証またはGoogle Cloud権限を変更せずに停止する。
- 次の一手: 上記Google側設定の確認・承認後に専用runnerを再実行し、正本revision・購入履歴・在庫を保存後に再読込する。Gmail command draftは送信しない。

### 2026-10-18 Runner failure reporting
- 発見: `clasp run` はGoogle側の「Unable to run script function」応答があってもexit code 0を返し、GitHub Actionsが誤ってsuccess表示になった。公開ログにAPI応答をそのまま出す設計も避ける必要がある。
- 変更: 専用runner workflowはAPI拒否、例外、または `ok:false` を検出して失敗終了し、詳細レスポンスをGitHubログへ出さない。`workflow_dispatch` も追加し、権限設定後にデプロイを再実行せず手動再試行できるようにする。
- 本番状態: PR・CI後に更新runnerを確認する。Google側API executable / 共通Cloud project / OAuth承認の確認が済むまでは資産commandを再試行しない。

### 2026-10-25 — 0円譲受をV2資産照合へ追加
- 目的: 「MEGA スタートデッキ100 バトルコレクションを親から1個譲受、原価0円」という申告を既存購入と混ぜず、重複なくV2へ記録する。
- 発見: 購入照合の読み取り監査 (revision 2183) はAMTAFの4個分の売却取引を検出したが、当該フィルターではlotが0件。別途全商品一致で在庫・取引を再監査中。通常購入経路はBOX商品の価格を定価へ補正するため、giftは別処理が必要。
- 変更: asset-reconcile にgift-onlyと0円gift lotを追加。購入費0円/source=giftの取得履歴と、BOX×1/unitCost=0円の在庫を保存し、同商品在庫や同日履歴があればfail-closed。保存後の正本再読込検証、同一requestId再実行、再処理時の二重計上防止を実装。
- 検証: npm test 229件成功、npm run checkとgit diff --check成功。Apps Script配布・V2反映は未確認。
- 価格表示: 2026-10-25提示画面のスタートデッキ100には「相場取得日 2026-10-21」が表示されていた一方、別の相場あり商品で日付表示が欠ける状態を確認。V2 quoteの `checkedAt` が空でも履歴に日付が残る場合は最新日を表示し、日付情報自体が無い場合はBOX/パック欄で「相場取得日 不明」と明示する。
- 重複防止: スタートデッキ100は画面上の商品名ゆれを考慮し、同商品名を含む既存在庫があれば譲受処理を停止する。
- 実行経路: Apps Script配布成功後の専用workflowは、まず単独のread-only監査コマンドを処理し、その後、譲受を含むasset-reconcileだけを処理する。Gmail下書きの送信は不要。
- 残件: PR/CI/Apps Script配布後、監査結果と譲受結果draftを確認し、V2 revision・0円取得履歴・在庫数量1を正本再読込で検証する。

### 2026-10-25 — 初回配布後の監査範囲修正
- PR #84をsquash mergeし、main `d17f22cf`。Apps Script Automation DeployとGitHub Pagesの両方がsuccess。
- 専用runnerは全店舗監査の範囲指定が必須であることを検出し、read-only監査で停止。V2正本への書込み前に停止したため、revisionは2183のまま。譲受コマンドは未送信キューに残存。
- 変更: asset auditへ明示的な `allStores:true` を追加し、商品指定で全店舗から照合できるようにする。前回失敗した監査draftを更新し、再配布後に監査→譲受を再試行する。
- 検証/残件: 監査全店舗テストを追加し、再配布・再実行後に正本revision、0円取得履歴、在庫1点を再読込確認する。

### 2026-10-25 — 実行結果
- PR #85をmergeし、main `e54ff3ed`。GitHub PagesとApps Script Automation Deployがsuccess。PR #85 CIはsuccess。
- Apps Script専用workflow run `40142588205` はrunner実行でfailure。監査結果draftが生成されず、両コマンドdraftは未送信・未処理のまま。V2へ今回の書込みが無かったことを確認。
- 最後に確認できた正本revisionはread-only auditの `2183` (2026-10-24)。デプロイとrunner失敗以降に正本を直接再読込できる経路は未確立。
- 既知の制約: 過去の記録どおり `clasp run` / Apps Script `scripts.run` がGoogle側権限で拒否される場合がある。API executable / caller共通Cloud project / Apps Script API / OAuth scopesの認証・権限確認が必要。今回はそれらを変更していない。
- UIの日付fallback修正はPagesへ配布済み。`checkedAt`が空なら相場履歴の最新日を表示し、日付自体が無ければ「相場取得日 不明」とする。元データのquoteに日付があるかどうかは正本読込が再開するまで未確認。

### 2026-10-25 — 既存購入在庫と譲受giftの分離
- 最新read-only audit draftでV2 revision 2186を確認。既存のスタートデッキ100購入lotはGEO香芝店の1点（取得原価891円）。今回の親からの譲受とは別物で、購入履歴/lotとも重複していない。
- 修正: 同一商品の有料在庫があるだけではgiftを拒否しない。商品名ゆれは照合しつつ、同日・同一譲受元の既存giftのみを重複候補として止める。既存requestIdの再実行検証は継続。
- LivePocket申込番号 `1061274659` のGmail確認メールは2026-10-25 10:49 JST。スクショの商品・イベント・店舗（イエローサブマリンの「30th CELEBRATION」購入権、希望店舗なんば本店）と一致。正本の同一申込監査は別のread-only commandで照合中。
- 注意: `clasp run`専用runnerはGoogle側権限で失敗したまま。通常のApps Script定期triggerで監査draftが作られたため、結果draftとV2 revisionを使い、各操作の成功を個別に検証する。

### 2026-10-26 — BOX/パック相場の読取監査
- 依頼: 日付表示が見えず、BOX相場が毎日更新されているか確認したい。
- 既存対応: `d17f22c` でPagesへ日付fallbackは配布済み。quoteの`checkedAt`が空なら相場historyの最新日、履歴にも日付がなければ「相場取得日 不明」を表示する。ただしcanonicalの実際のBOX quote日付・日次更新healthは正本を再読込できておらず未確認。
- 変更: read-only `market-audit` commandを追加。正本revision、最終/日次market run health、active BOX・パックの価格/取得日/取得元/freshness/history末尾を非公開の結果draftに出し、既存Gmail command queueから処理可能にする。Gmail command draftは送信しない。
- テスト: active lotのみの抽出、lot/商品一致quote、日次health、履歴、private result draftを検証する。
- 本番状態: 未deploy。PR・CI・Pages/Apps Script配布後に監査commandをキュー処理し、結果draftとV2の実測revisionを確認する。
- 制限: auditはread-onlyで、取得日・価格・freshnessを補完・推定しない。

### 2026-10-28 — Apps Script 200バージョン障害の安全な診断（通常Chat）
- 原因確認: 10/26 GitHub Actionsの deploy ジョブは source push/remote一致まで成功、API executable の配布で Apps Script保存版の200個上限（Cannot create more versions）により失敗。GitHubコミット・在庫データ数の上限ではない。
- 10/27・10/28の market refresh GitHub Actions も失敗。10/27の報告分類は function_not_found。V2正本への直接反映は未検証であり成功扱いしない。
- 変更: `.github/workflows/tv2-script-diagnostic.yml` に**読取専用**の診断ジョブを追加。既存の v2-apps-script 環境の認証を使い、Apps Scriptの保存版数、配布数、専用API配布の存在を数値のみ表示し、`tv2AutomationStatus()` を非変更の状態確認として試行する。Script ID、deployment ID、credentialsはログに出さない。
- 検証予定: pushで診断jobを実行し、結果を読み、API有無・認証・関数参照を切り分ける。GitHub workflow の成功は Apps ScriptのV2正本更新成功を意味しない。
- 安全: バージョン、デプロイ、trigger、V2データの削除・更新はこの診断では行わない。Google UI上でアクティブ配布に未使用の版だけを整理するには、使用中の版を確認してから別途実行する。Googleの200版制限を回避できたと誤報しない。

#### 2026-10-28 — 診断PR #94を本番実行した実測結果
- PR #94をmainへsquash merge（`aa989327d43c38173db0c15526feb05ee560fe8f`）、[read-only実行 #40676318499](https://github.com/manato-maker/toreca-vault/actions/runs/40676318499) を確認。
- `clasp list-versions`: 200/200。`clasp list-deployments`: アクティブ6件、その利用版は5種類。説明が `Toreca Vault V2 Automation API Executable` と一致するデプロイは0件。名称以外のAPI executableの存在や種別は未確認。
- `clasp run tv2AutomationStatus` は終了コード0だが、`ok:true`を検出できず未確認に分類。この診断はreadonlyで、trigger・在庫・version・deploymentに変更なし。APIとV2の復旧は未完了。
- 対処: Google Apps Scriptエディタで現在の6配布の使用版を保護し、未使用の古い保存版を少数整理する必要がある（チャットの接続先にバージョン削除手段がない）。その後、既存`Apps Script Automation Deploy`を手動実行しprivate API executable配布・機能試験・V2 canonical再読込まで確認。手動整理までは「復旧完了」としない。


### 2026-10-28 — Gmail quota対策と処理間隔分離（PR #95・CI修正中）
- PR #95 / branch fix/tv2-gmail-queue-separation-20261028 で、15分のV2 command登録、30分のGmail抽選確認、JST 12:30/19:00の結果確認、13:30以降の日次相場更新へ分離する変更を準備中。
- 通常の応募/結果Gmail走査は範囲付きカーソルで一度101件まで取得し、次回に残りを継続。parser upgrade時も処理済みIDを保持し、Gmail API quotaを超える全件再走査を避ける。結果確認は独立カーソルを使う。V2反映後にのみ処理位置を進める。
- Gmail下書き一覧は1回の実行で共有し、同じ実行内の複数ポリシーが繰返し getDrafts() しないようにする。コマンドdraftは送信せず、成功時のみ削除する。
- 最新CIでhealth/timer/parser関連テストを通過したが、draft mockがApps Scriptの返却値を模擬できず2件失敗。テストmockを修正してPR headに追加。今回の修正後CIは未完了のため、PR merge・本番配布へ進んでいない。
- Google Docs handoffへ今回の状態、保護対象版、削除候補、認証待ちを記録。Google認証は manato.pt@gmail.com 選択後、安全なログイン選択フォームがタイムアウトし、成功状態は不明。ログイン回避は行っていない。
- Apps Script状態の最後の実測は診断PR #94/Actions #40676318499: 200/200保存版、active deployment6件、利用版5種類、専用API deployment0件。v199/v95/v4/v3/v2を保護。v1/v5/v6を未使用候補とするが、削除確認待ちで未削除。trigger/Script Properties/deployments/V2 dataはこの作業では変更なし。
- V2本番コマンド、相場更新、Gmail処理はこの変更作業では実行していない。V2 revision/購入原価/在庫/抽選履歴/資産集計、Apps Script成功ログ、API実行権限、Gmail quota回復、Google側ソース一致は未確認。
- 次: PRの全CIを成功させてからmainへ反映。Google認証完了後、Apps Scriptで6 deployments/版参照とtrigger/プロパティを再読込し、v1/v5/v6候補の安全性を再確認。削除直前には明示確認を取る。確認後のみ候補版を削除しActionsを再実行、専用API/関数権限/15分・30分・結果時刻・相場runを成功ログとread-only V2再読込で検証する。
- 通常Chat運用は、購入・受取・開封・売却・抽選応募/当落を文章またはスクリーンショットで報告し、安全な既存連携が作る [Toreca Vault Command] draft queueを15分triggerが処理する想定。実運用はまだ未確認。購入原価二重計上、在庫/履歴削除、開封pack残存を検証し、0円で取得した開封シングルと購入履歴を保持する。


### 2026-10-28 — Apps Script再認証・削除候補確認・PR CI（確認待ち）
- Apps Scriptブラウザ認証を完了し、対象プロジェクト「Toreca Vault 抽選自動化」を読み取り確認。履歴は200/200、現在版は2026-10-26 17:42。
- 管理画面のアクティブ配布一覧は5件を表示（PR #94診断の6件と1件差があるため、GUI観測値として記録）。使用版は v199 / v95（Toreca Vault Market Refresh API）、v4（Toreca Vault V2 secure read）、v3（Toreca Vault V2）、v2（Restored version 2）。この5版は保護。
- 版の一括削除画面では、アクティブ配布版は選択候補から除外される。未使用候補 v1（2026-09-19 14:30）、v5（2026-09-24 20:16）、v6（2026-09-24 21:31）の3件だけを選択。まだ削除していない。削除は版履歴の不可逆削除であり、実行直前に本人承認が必要。トリガー・スクリプトプロパティ・認証情報・V2データに変更なし。
- PR #95 のhead 4623c4705d733c28a4ffed233db00d9db6a0ffb7 に対するCI run 40708710877 / 40708701790 は両方success。PRはopen、main未反映、本番未配布。
- Gmail quota対策と15分command・30分Gmail・12:30/19:00結果確認・13:30以降日次相場のコード変更はまだ本番未反映。Apps Script成功ログ、専用API、実行権限、Gmail重複処理、相場更新、V2最新revision/JSONは未検証。
- 削除確認が得られた場合のみ選択したv1/v5/v6を削除し、Actions配布と本番検証に進む。削除前の確認を飛ばさない。


### 2026-10-30 — 承認済み旧版整理・PR #95 main反映
- Apps Scriptの一括削除確認画面で本人承認を受け、非稼働スナップショット v1（2026-09-19）、v5（2026-09-24）、v6（2026-09-24）だけを削除。UIは「3個のバージョンを削除しました」と確認。稼働デプロイ使用版 v199/v95/v4/v3/v2 は削除対象外。版数の再読込は未確認。
- PR #95 の最終head f55cbe822df924200f25a01ca9525afdfc45ef1c に対するCI #40712168384 success。PRをsquash mergeし、main merge SHAは 9d5a317eca88b418c73b000b867596c85af281b3。
- 10/30 19:58 JSTのmarket refreshはfunction_not_foundと報告あり。mainのworkflowは定時/デプロイ後に runTv2MarketRefreshNowOnce、手動起動時に runTv2MarketScheduledOnce を選択し、どちらもmainソース内に定義がある。該当run IDと失敗jobログは未取得のため原因は確定していない。Actions/Apps Scriptへの再配布・V2相場更新・canonical再読込も未確認。
- 次: main merge後のApps Script deploy workflowと10/30 market refresh runをGitHub Actions画面/APIで特定。remote source一致、専用API deploy、tv2AutomationStatus、トリガー、Gmail quotaと重複防止、market結果、V2 canonical revisionを個別に確認し、Google Docsと本ファイルを再更新する。


### 2026-10-30 — Apps Script配布成功・相場更新function_not_found追跡中
- main merge `9d5a317eca88b418c73b000b867596c85af281b3` のApps Script Automation Deploy run `41055517447` はtest/deploy両job success。
- 相場更新run `41055622315`（21:28 JST、workflow_run trigger）のjob `refresh` は失敗。workflow実行はmain commit `849eaa6...` をcheckoutし、Apps Script呼び出しstepで `category=function_not_found`。実行レスポンス自体はprivate情報保護で抑制されている。workflowは `runTv2MarketRefreshNowOnce` を指定。コード上の関数存在だけではGoogle側デプロイ版への反映を証明できない。runを一度再実行したが、再実行結果は確認待ち。
- 同日のScheduled run `41044554229` も失敗表示を確認。job log未取得。初回の18:58 JST頃のrun IDとして報告されていた対象は `41044554229` の可能性があるが時刻と番号を画面で再確認する。
- API source push/remote verify/test/deploy jobのsuccessは確認できた一方、専用API実行可能性・market handler実行・canonical V2更新は未証明。Apps Script UI履歴版数の削除後再読込、API deployment一覧、successful execution log、trigger execution、V2 JSON/revision/quotesの照合を続ける。

### 2026-10-30 — API実行結果の再診断（認証画面の再ログイン待ち）
- PR #96でGitHub ActionsのApps Script API呼出しを `clasp --nondev --json` に変更。配布済みAPI executableを対象にする。CI run `41057399519` はsuccess。merge SHA `ba154037655fb069f46ee5730225c9025d58296e`。
- 変更したのはmarket refresh / 読取diagnostic / scoped asset reconcile workflow。ActionsログにはV2内容や下書き本文を出さず、API応答の有無とエラー分類だけを出す。
- 10/30の再実行でApps Script saved versionsは199/200、active deploymentは7件、異なる利用版6種類、名前が一致するprivate API deploymentは1件・version参照あり。版整理後も版数に余裕は1件のみ。
- market refresh run `41057199273` は失敗。read-only `tv2AutomationStatus` run `41057438708` も失敗し、Actionsの標準化ログではAPI error/Apps Script exceptionもresponse.resultもない空の応答（`{}`相当）だった。以前の `function_not_found` 分類だけでは本当の原因を確定できない。Gmail triggerやV2正本の読み取り成功を確認できていない。
- 読取diagnostic PR #96を追加。empty responseを成功とせず、API code / エラー分類 / result有無だけを出す。最新Actionsで分類は `apiErrorCode=null, apiErrorClass=none, executionErrorClass=none, hasResponse=false, resultType=undefined`。APIが成功完了した証拠ではない。
- Apps Script Web UIでは現セッションがログアウト状態で、Apps Script実行履歴/trigger状態/Google側のdeployment versionを確認できなかった。次はGoogleアカウントでブラウザへ再ログイン後、Apps Scriptの実行履歴を確認し、当該APIのexecution状態・失敗理由を特定する。Apps Scriptソースの追加変更・新規deploymentは未実施（version上限まで残り1件）。既存trigger/Script Properties/V2データは意図的に変更していない。
- market更新workflowが実行されたため、canonical quote更新の有無はV2 JSON再読込が必要。revision/購入原価/数量/資産合計はまだ未検証。認証またはscope承認が必要と判明するまでは安全な診断を続ける。
- 通常Chatの購入・受取・開封・売却・抽選報告の自動登録も未確認。15分command queue、30分Gmail確認、JST 12:30/19:00重点確認、日次13:30以降相場更新を成功ログとV2正本再読込で確認すること。
### 2026-10-30 — Apps Script API 403の特定（Cloud project照合待ち）
- PR #97で読取専用 tv2AutomationStatus 呼出しをGoogle Apps Script APIへ直接行い、Apps Script APIの done と応答有無を標準化ログへ出す処理を追加。CI #41058168642 success、PR squash merge SHA 5b680137d29e5fe5a40659192028c829109f936e。
- Apps Script診断run 41058211573では scripts.run がHTTP 403 authorization。API error classはauthorization、response無し。claspの空応答が隠していた実行状態とは別に、Google側がAPI呼出しを拒否したことを確認。
- Google公式 scripts.run の説明では403 PERMISSION_DENIEDは、呼び出しOAuthクライアントのCloud projectとApps Script projectのCloud project不一致を指す。推定原因は共通のstandard Cloud project設定不一致。正確なproject ID・必要scopeは未確認。
- Actionsのlist-versions/list-deploymentsは成功する一方、scripts.runだけが403。専用API executable 1件・deployment version有り。版数199/200。アプリコードの関数不存在と断定しない。
- 次: Apps Script Project Settingsで現在関連付けられたstandard Cloud projectを読み取り確認し、GitHub OAuth clientが所属するCloud projectと照合する。変更は既存GCP project関連付け・OAuth client/secret・API設定への影響を調査後に行う。現在のクラウドブラウザはGoogleログアウト状態で、UI確認にはGoogleアカウントの再ログインが必要。アカウント認証・project選択はユーザー対応待ち。
- 403が出たため、Actions経由のmarket更新・asset runnerはAPI呼出しが拒否される。V2 quote/revision/原価/在庫は正本再読込で確認する。既存trigger/Script Properties/V2データは意図的に変更していない。

### 2026-10-30 — OAuth project照合・Gmail quota再診断
- PR #98をCI成功後にmerge（SHA `b9b203ff41d1e9047f64691e4a94a9d76d8d955b`）。read-only Actions #41060523449がGitHub Actions OAuth client Cloud Project number `1072944905499` を取得。client ID・secret・access token・refresh tokenはログに出していない。
- Apps Script UI「プロジェクトの設定」はGCP Default。read-only scripts.runは403。Google公式要件は呼出側とスクリプト側が同じstandard Cloud projectを共有すること。Cloud ConsoleはブラウザでSite Unavailableとなり、OAuth projectのIAM・Apps Script API・Drive API有効状態をまだ検証できない。
- Apps Scriptのプロジェクト切替フォームは、DefaultからStandardへの変更で旧プロジェクトの全ユーザー認証を取り消し、Defaultへ戻せず、Advanced Services API再有効化が必要と警告。Project number `1072944905499` の所有・編集権限と必要APIを確認してから変更する。切替は不可逆設定のため、実行直前に利用者確認を取る。現時点でフォームへ入力・Set projectは未実行。
- 2026-10-30 22:08 JSTにUIからread-only `tv2AutomationStatus()` を手動実行し、Apps Script実行ログ「実行完了」を確認。V2読み書きなし。直近の15分runnerは22:01 JST、30分Gmail pollは21:40 JSTに `Service invoked too many times for one day: gmail` で失敗。各トリガーは1件で重複なし：15分command queue、30分Gmail、12:30/19:00 JST結果check。両稼働runnerの直近表示エラー率100%。
- PR #99: Gmail draft message/subject/bodyの実行内キャッシュ、Gmail日次quota時の6時間CacheService backoff、backoff中にGmail処理をskipして独立market処理を継続する修正とテスト。Gmail cursorはquota失敗時に進めない。draft送信・削除・再作成、既存Script Propertiesやtrigger変更なし。PR/CI/配布/本番再検証は未完了。
- V2正本JSON/revision/購入原価/在庫/抽選履歴/資産集計、相場quotes、Gmail重複防止の実データ確認は未完了。テスト用V2レコードやコマンドは投入していない。PR #99配布後にApps Script実行ログとcanonical readbackで検証する。


## 2026-10-30 — PR #99 CI修正・Apps Script配布前確認

PR #99「Prevent Gmail quota failures from stopping V2 automation」はCI #41061993707（npm test / npm run check）success後、mainへsquash merge（merge SHA fa0d798cd6ee18afd825af90c9e34bc1be61b086）。バックオフ日時のテスト比較をISO日時として正しく検証する修正を含む。

Apps Script実行履歴の再確認では、15分処理と30分Gmail処理がGmail日次上限で失敗。PR #99の変更はまだ本番適用・実行確認できていない。既存4トリガー（15分queue、30分Gmail、12:30/19:00当落）は画面上で重複なし。

Apps Script保存履歴は上限200/200。デプロイ管理で確認したアクティブdeployment使用版はAPI executable v202、Market Refresh v199/v95、secure read v4、V2 web app v3、Restored v2 deployment v2。一括削除画面は「200件中6件がアクティブdeploymentで使用」と表示する一方、候補一覧にv202も表示する不整合を確認したため、削除は未実施。アクティブ一覧にないv201（10/30 21:28）とv200（9/29 6:29）は非稼働候補。本人確認後に限り削除する。

専用API deployment v202は存在するがscripts.runの403は未解消。Apps Script GCPはDefaultで、OAuth client Cloud Projectとの共通standard project切替が必要と見込まれる。Google UIはDefaultに戻せないこと、既存ユーザー認証の取消し、新projectのAPI再有効化が必要と警告。Cloud Console権限/API設定の事前確認は未完了で、project変更は未実施。

本番Apps Scriptへのquota対策配布、API呼出し成功、Gmail実行成功、Chat queue実登録、market更新、Gmail重複防止、canonical V2 JSON/revision/購入原価/在庫/資産集計の再読込は未確認。既存在庫・購入原価・抽選履歴・トリガー・Script Propertiesに意図した変更なし。


## 2026-10-30 — PR #99 配布とAPI再検証

利用者了承後、アクティブdeployment一覧にない旧版v200（2026-09-29 06:29）のみApps Script履歴から削除。Google UIの完了表示は「1個のバージョンを削除しました」。保存版199/200、アクティブdeployment 6件。稼働中のv203/v199/v95/v4/v3/v2、トリガー、Script Propertiesには変更なし。

PR #99のApps Script deployment Action #41062078786はtest/deploy success。canonical source push、remote source verification、private Apps Script API executable updateの各stepが成功。Google UIでも専用API executable deployment v203（2026-10-30 22:18）、保存版199/200、アクセス範囲「自分のみ」を確認。

Apps Script UIでread-only `tv2AutomationStatus()` を22:37:07 JSTに実行し、実行ログ「実行開始」「実行完了」を確認。22:31:12 JSTの15分runnerは68.583秒で「完了」だが、詳細ログ/返却内容/canonical readbackは未確認。トリガー画面は合計4件：queue 15m、Gmail 30m、結果check 12:30/19:00。Gmail pollの前回実行は配布前の22:10:56、エラー率100%で、配布後の30分処理成功は未確認。

API診断Action #41060523449のfailed jobを配布後に再実行したが、scripts.runはなおHTTP 403 authorization（hasResponse=false）。API deployment作成・更新だけでは実行復旧と扱わない。Apps Script GCPはDefault。OAuth client projectをApps Scriptに関連付けると、旧ユーザー認証取消し、Defaultへ戻せないこと、新projectでAPI再有効化が必要とのGoogle UI警告がある。Google Cloud ConsoleはSite Unavailableとなり、project IAMとAPI有効状態を確認できていないため、切替は未実施。切替は具体的な利用者承認を得てから行う。

V2 canonical JSON/revision、購入原価、在庫数量、資産集計、抽選履歴、相場quote/source/date、Gmail重複防止は正本を再読込していないため未検証。PR #99配布後のquota backoff動作もGmail 30分pollログで未確認。売買テストやコマンド送信、重複テスト記録は投入していない。


### 2026-10-30 — 配布後トリガーとAPI 403影響範囲の再整理

GitHub mainの `automation/V2Automation.gs` を確認。GitHub Actionsの `scripts.run` API呼び出し（read-only診断など）の403は、Apps Scriptの時間トリガーが内部でV2を書き込む経路とは別。通常のV2 read/writeはApps Scriptから `TV2_SYNC_URL` とスクリプトプロパティ内tokenを使う同期Webアプリへ送信し、`tv2Mutate_` はexpectedRevision付き保存後に正本を再読込してrevision/lastMutationIdを照合する。値は記録しない。この既存同期経路が現在も正常かは未検証のため、403を無関係とは断定しない。

Apps Scriptの実行履歴を再確認：22:40:56 JSTの `runTv2LotteryGmailCheck` は1.256秒で「完了」だが、Cloudログは空。バックオフによる早期skipか検索成功かを区別できず、Gmail新着・当落処理成功とは扱わない。22:46:12 JSTの `runTv2Automation` は63.674秒後に「不明」（成功/失敗の判定不可）、Cloudログなし。従って15分コマンド登録、V2 revision更新、相場更新の成功は未確認。PR #99はGmail quota発生時に6時間backoffし、backoff中はGmail依存の価格方針/コマンド下書き/Gmail pollをskipして、保留下書きは残し、独立market runnerを継続する実装。

Google Cloud projectの切替は未実施。先に対象projectの権限・必要APIを確認し、既存ユーザー再認証等の影響を評価する。既存V2データを変更する手動/テストコマンドは投入していない。


追記：通常のV2同期経路を読み取りだけで確認するためDriveコネクタから正本ファイルを取得したが404となり、canonical JSON再読込はできなかった（別アカウント/共有権限/ID照合のいずれかは未特定）。ファイルへの書込み・変更はなし。

## 2026-10-30 — 未使用コード整理の安全性監査

- PR #100で市場価格取得の旧パーサー（fetchCardValueBuyback_ / fetchGamepediaBuyback_ / fetchToresiaBuyback_）削除を提案したが、CI #41068648592 が test/v2-market-card-auto.test.js の直接参照で失敗。テスト契約が残るため削除しない。
- PR #100は未マージでクローズ。作業ブランチの automation/Code.gs は main と同一blob SHA 914e4950ccc3d97e36e4bf9177cc0eb033e83c8e に復元済み。Apps Scriptへのコード配布・本番変更はなし。
- 他の未参照候補にも手動実行/API入口・移行/修復処理が含まれ、影響ゼロを証明できないため削除せず。コード整理は今回未実施。

## 2026-10-31 — PR #101分離配布・API再診断（Google認可待ち）

- PR #101をsquash merge。main SHA `f3f81c9850badfa189086ac83f16269e3f931b1f`。ローカル `npm test` は241件成功。Apps Script Deploy Action `41088210600` はtest/deploy success。`clasp push` 後の Google 側 source pull/比較も成功し、専用 private API deployment を更新した。
- 実装: 15分 `runTv2Automation` はSheets command queueのみを処理し、Gmail pollやGmail依存処理から分離。Gmail確認は30分、結果重点確認は12:30/19:00 JST、相場は13:30以降1日1回。既存4トリガーを配布時点では手作業で変更していない。15分・30分はApps Script実行履歴の次回成功ログで確認する。
- Google Sheets queue (`Toreca Vault V2 Command Queue`) はID/tab/headersを確認し、データ行なし（空）を読み取り確認。本番コマンドやテスト記録は投入していない。パック開封原価は元inventory lotのunitCostを使い、希望小売価格で原価を上書きしない。
- 15分runnerの手動実行時、Googleは `Toreca Vault 抽選自動化` を「Googleで確認されていないアプリ」と警告。許可/スコープ画面へ進まず停止した。したがってSpreadsheet認可と本番queue readerの実行成功は未確認。認可がなければqueue処理はまだ有効化されたと扱わない。
- 配布後のmarket workflow run `41088349811` は `runTv2MarketRefreshNowOnce` 呼出しで再び `function_not_found`。Google側source比較とdeployment更新成功では解決しなかった。既知のscripts.run HTTP 403 authorization / Apps Script GCP `Default` と整合する疑いがあるが、今回runの生レスポンスは伏せられており原因は未確定。API再実行・相場更新・canonical read-backは未成功。
- Apps Script UIでのread-only `tv2AutomationStatus()` 成功ログは配布前の2026-10-31 01:11 JST。配布後の15分/30分実行履歴、Gmailの quota backoff/メール重複防止、相場の成功・失敗内訳、V2 JSON/revision/原価/在庫/資産は未確認。直前に表示された既存15分runner（01:01）とGmail runner（01:10）は「完了」だが、新sourceの実行ではない。
- 旧Apps Script保存版は配布前199/200、稼働deployment参照版は保護対象。今回の配布後版数と参照版はUI再読込未確認。版削除は実施していない。trigger以外のScript Properties/認証情報、抽選履歴、購入履歴、在庫は意図的に変更していない。
- 通常Chatの運用設計は、報告を既存の安全なコマンド経路でSheets queueへ登録し、15分Apps Scriptが処理する方式。今回の配布だけで通常Chatからqueueへの投入・本番登録が確認できたわけではない。ユーザーのチャット報告から実際のqueue投入が可能な接続/認可を確立し、受取の購入履歴反映も重複なしで確認するまで運用完成とはしない。コマンド下書きは送信しない。
- 次: Google未確認アプリ警告をユーザーがどう扱うか確認後、必要ならスコープを確認して認可し、空queueの `runTv2Automation` を実行して成功ログを確認。既存default Cloud projectからstandardへの切替は不可逆警告があり、IAM/API設定を照合するまで変更しない。V2 JSONを正本から再読込しrevision・購入原価・在庫数量・資産集計をread-only照合し、market APIの実行可否を再診断する。


### 2026-10-31 — PR #101配布後の実行確認（追加）

- Apps Script実行履歴を再読込し、PR #101配布後の runTv2Automation は01:16、01:31、01:46 JSTに「完了」、runTv2LotteryGmailCheck は01:10、01:40 JSTに「完了」を確認。01:22のread-only tv2AutomationStatus() も「完了」。ただし最新実行のCloud Logging詳細はUIで取得できず、完了状態以上の処理結果は未確認。
- Queue Sheet「Toreca Vault V2 Command Queue」はQueueタブのヘッダー行のみでデータ行なし。実データ/テストコマンドは投入していないため、queue消費・V2登録は未検証。
- Gmail runnerが完了状態になったことは確認したが、今回処理したメール件数や重複防止の実行結果はログから確認できず。Gmail quota backoffの実測も未確認。
- 相場更新Action #41088349811は失敗（refresh jobの失敗）。既知の function_not_found と整合するが、GitHub上のjob stepは失敗表示のみで生レスポンスは取得できない。相場更新とAPI復旧は未確認。
- Apps ScriptのEditor UIから追加権限を確認しようとしたが、Google UIが「ページを再読み込みして、もう一度お試しください」のエラー状態となり、OAuth scope画面には到達せず。デプロイ済みmanifestにoauthScopesの明示指定はない。シート限定のscopeであることを確認・承認していない。
- GitHub docs/HANDOVER.md / Google Docにもこの実行結果と認可/UI障害を記録。既存在庫、購入原価、抽選履歴、trigger、Script Properties、デプロイ、Google認証情報の変更・削除なし。
- 未解決: Apps Script API scripts.run / market refreshの function_not_found。15分/30分処理の完了状態は見えたが、V2正本JSONの再読込、revision、在庫数量、購入原価、資産集計、quotesのfreshnessは未検証。Google Cloud project変更はDefaultからStandardへの不可逆変更と既存認証失効の可能性があるため未実施。

## 2026-10-31 V2在庫相違の読取監査（Issue #102）
ユーザーから「現在の在庫が違う」と報告あり。GitHub issue: https://github.com/manato-maker/toreca-vault/issues/102 。最新のV2 canonical JSONと画面表示のrevisionは、現在の接続権限では取得できていない。Google Drive上の旧schemaVersion=1 JSON（10/5更新）をV2正本と取り違えない。
- 最後のprivate market audit（10/26, V2 revision 2205）では30th CELEBRATION 9種セット未開封5個：ジョーシン上牧1、エディオン橿原2、ポケセンオンライン本人1、妻1。新しい在庫の確定値ではない。
- 2026/10/21のユーザー報告「9種セットを1セット開封」およびミュウツーex FUR M6a 134/103、ゲッコウガex SAR M6a 125/103、ホゲータex SAR M6a 124/103、カスミ M6a 138/103の4枚は、現存V2の開封取引・派生カード在庫を未照合。もし5個のうち1個を開封したなら未開封4個となるが、開封元lot不明につき無断減算しない。
- 2026/10/16に購入報告のカードボックス日本橋30th拡張パック1BOX(7,200円)は、10/26の未開封lot14件の一覧に見えない。開封/売却/購入未登録の可能性を切り分けるまで新規追加しない。
- 10/18ジョーシン大和高田のバラパック10は全開封済み。パック購入履歴維持、獲得シングルの原価0（ジラーチex M6a132/103・ゲンガー M6a150/103）、トイザらスの開封済みランダムセットは未開封として戻さない。193の10/31抽選応募は購入ではなく在庫加算しない。
- 対応: まず最新V2 JSONのrevision、inventoryLots、transactions、openings、salesをread-onlyで取得。現物・画面表示と照合し、欠落や重複を特定。修正するならexpectedRevision/冪等キーで最小変更し保存後canonical再読込と数量・原価・資産・購入履歴不変を検証。確認できない限り在庫修正完了と報告しない。

## 2026-10-31 9種セット売却2セット・残3セット / 30th BOX保有（本人再申告）
- 本人が30th CELEBRATION **9種セットを2セット売却済み、現在残3セット**と申告。過去の会話/Gmail/10月の私的V2監査では以前の売却報告が見つからない。価格、売却日、売却先、売却元の購入lotは未取得。推測の売却単価ゼロ等で登録しない。
- **カードボックス日本橋店で2026-10-16に購入した30th CELEBRATION 1BOX、7,200円を現在保有**と明示。未開封・シュリンクの状態は明示されていないため断定しない。10/26 audit revision 2205 active sealed lotに見当たらないので、最新V2で履歴/在庫を照合。
- 旧9種セット保有5と以前の1セット開封報告、今回の売却2・現在保有3には差1がある。開封元lot、売却元lot、購入追加の有無、数量の時系列を同時に照合する。手元在庫3は確定申告だがV2の該当lot修正は未検証。
- GitHub Issue #102で追跡。最新V2 JSON/revisionが直接読めておらず書込は未実施。新規sale処理は購入原価、利益、資産を変えるため、売却額・日時・店舗・対象lotとV2重複の検証後にのみ冪等登録。登録後は正本再読込で在庫と販売履歴を検証。

## 2026-10-31 9種セット原価補正・購入先集計不要（本人指示）
- 2セット売却分は「エディオン橿原店購入分」と本人が補足。ただし**在庫の購入先ごとの集計や表示は不要**。商品単位で合計3セットの保有数を管理し、内部照合のための元購入取引だけ維持する。
- 売却先=トレカショップKURO大阪日本橋店、単価15,500円×2=31,000円。提示された買取告知画像の「10/25」は**買取価格の有効日であり実売却日とは限らない**。実際の売却日は未確定。
- 2026-10-18購入のエディオン2セットの元購入履歴は、定価10,800円×2=21,600円、クーポン差引後の**商品実支払額20,600円**（袋代除外）を記録。手数料なしの場合の実売却益は**31,000−20,600=10,400円**。V2 inventoryLot の unitCost=10,800円×2 による標準の FIFO 売却では、原価21,600円・利益9,400円と誤計上される恐れ。既存の purchase/lot/売却履歴を破壊せず、クーポン1,000円が利益に適切に反映されるよう正本で照合・是正する。
- runTv2ChatSale は売却日が未入力なら実行日に自動設定し、内部lotの原価をそのまま合算するため**日付不明のままsaleコマンドを15分Queueへ投入しない**。売却実日と最新V2正本revision、同一取引の既存有無が確認できてから安全な登録・補正へ進む。記録時は同一売却を一意のrequestIdで管理し、再投入で二重売上にしない。
- 過去の「9種セット1セット開封」報告と現保有3の数量差1は引き続き要照合。ユーザーは購入店別の棚卸しを求めていないので、その点の不要な確認は省く。カードボックス日本橋の30th 1BOX保有は継続確認対象。
