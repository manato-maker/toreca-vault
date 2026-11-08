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

## 2026-10-31 9種セット2セット売却のキュー投入（売却日10/25確定）
- 本人が実売却日=**2026-10-25**と確定。トレカショップKURO大阪日本橋店で30th CELEBRATION未開封9種セットを**2セット×15,500円＝売却総額31,000円**。売却対象はエディオン橿原購入分2セットと本人明示。現在の本人申告保有数は商品全体で**3セット**。購入先別の表示・数量管理は不要。
- Google Sheets「Toreca Vault V2 Command Queue」 Queue!A3:H3 に**sale型の未処理コマンド1件を登録し再読込検証**。requestId=`20261025-kuro-nipponbashi-30th-cardset9-edion-2sets-sale`、status=`pending`、attempts=0。以前のTCGショップ193抽選queue行は変更なし。再投入で同一売却を重複登録しない。
- productKey はV2監査で実在が確認されているエディオン購入lot名`ポケモンカードゲーム MEGA 30th CELEBRATION カードセット（9種）`と厳密一致、category=BOX、condition=未開封。現行sale関数には取得元lotを明示するフィールドがないが、この監査では同じ商品名の正数量2lotに限定される想定。不一致時は自動登録失敗（review）とし手動で別lotへ付け替えない。
- **重要・未解決の原価差額**: 元購入取引は希望小売価格10,800円×2＝21,600円、1,000円クーポン控除の実支払は20,600円。現行`runTv2ChatSale`はlot.unitCost 10,800円×2を原価として使うため、売却成立時にV2表示利益9,400円となる危険がある。正しい実売却益は追加手数料なしで**10,400円**。元購入記録とlot原価の整合を保持しながら、同じ売却取引の実原価20,600円に修正する。修正用の重複saleを作らない。
- **本番反映未確認**: Apps Script queue runnerおよびV2 canonical JSONを直接読めていないため、売却transaction・在庫減算・revision・資産/実現利益を検証できていない。キューへの投入を「V2登録完了」と表現しない。10/21の別件9種セット開封報告についてもユーザーの残数3と矛盾しないように照合（確証なく追加の1セットを減算しない）。

## 2026-11-01 KURO買取明細17,100円と4件の売却コマンド
- 本人より**2026-11-01 13:28** KURO大阪日本橋店の紙レシート提示。**買取合計17,100円、現金払い**、内訳：①未開封30th CELEBRATION カードセット9種 1点13,000円、②MEGAスターターセットex イーブイex 1点1,700円、③MEGAスターターセットex ゾロア＆ゾロアークex 1点1,200円、④MEGAスターターセットex ニャオハ＆マスカーニャex 1点1,200円。レシート内訳和17,100円一致。
- **2026-10-25 KURO 9種セット2点×15,500円=31,000円とは別取引**。9種セット今回1点を売却したので、直前の本人申告残3からは残2の算術結果（別途10/21開封報告と正本在庫の時系列が不一致であることに注意）。10/25と11/01売却の累計現金受取は48,100円。購入元ごとに在庫表示を分割しない。
- Google Sheets専用command queueに**4行をappend成功、再読込成功**（Queue!A4:H7; status=pending/attempts=0）。4件ともtype=sale, date=2026-11-01, category=BOX, quantity=1, 単価13,000/1,700/1,200/1,200。識別子4件：
  - `20261101-kuro-nipponbashi-receipt-1328-9cardset-sale`
  - `20261101-kuro-nipponbashi-receipt-1328-eevee-sale`
  - `20261101-kuro-nipponbashi-receipt-1328-zorua-zoroark-sale`
  - `20261101-kuro-nipponbashi-receipt-1328-sprigatito-meowscarada-sale`
- 10/25売却キューも**なお pending/attempts=0**。11/01の4行もpending/0。自動処理とV2正本の反映は**一切未確認**。成功と断定不可。トリガー・Apps Scriptの復旧を優先し、処理後は4件の売却取引と在庫減算を最新V2 JSON/revisionで再読込検証する。重複投入禁止。
- **安全注意**：直近取得可能な2026-10-26 revision 2205未開封BOX監査にはスターターセットex3種類の保有lotが見えない。ユーザーの以前の購入・原価記録も発見できていない。厳密productKey照合に失敗する場合は既存saleコマンドがreviewになる想定で、**別商品を誤減算したり、原価0の架空購入を発行したりしない**。入手記録の確認と差分修復が必要。9種セットも店舗別商品名の揺れや過去開封との不整合を調べ、正本で2個に整合するまで無闇に数量上書きしない。
- 追加費用・starter3種類の取得原価・今回販売した9種セットの原価はまだ未確定。売上金17,100円をそのまま利益として計上しない。レシート番号やレシート上のバーコード文字列は引き継ぎ記録に転記しない。

## 2026-11-01 スターターセットex3種の定価各1,800円（本人購入済確認）
- 本人が「11/1 KURO買取明細のスターターセットex3種類は過去に**定価で購入済み**」と確認。ポケモンカード公式 https://www.pokemon-card.com/ex/me/ および https://www.pokemon-card.com/products/index.html により**2026年7月31日発売・3種類とも税込希望小売価格1,800円**。各1セットを売却しているので、購入原価は3点合計5,400円として損益計算する。ただし既存正本で購入取引・lotの有無はまだ未照合。購入日・購入店舗は判明しておらず、勝手に補完しない。
- 11/1 KURO売却と原価の対応：①イーブイex 1,700円売却/1,800円原価/損益−100円；②ゾロア＆ゾロアークex 1,200円売却/1,800円原価/損益−600円；③ニャオハ＆マスカーニャex 1,200円売却/1,800円原価/損益−600円。**3点合計 売却4,100円、取得原価5,400円、実現損益−1,300円**（送料・手数料等なしと仮定）。
- この3件のsaleコマンドは既に Sheets Queue!A5:H7 に投入済みのため、**追加の売却コマンドは作らない**。2026-11-01時点のステータス pending/attempts=0 を再確認。現行のrunTv2ChatSaleはV2 inventoryLotsの厳密一致を要求し、欠落している場合はレビュー停止となる。既存購入を検索・照合し、存在しない場合は購入日・店舗の裏付けを取ってから1点ずつ取得原価1,800円の購入・売却を整合修復する。架空の購入日や店舗を作らない。V2正本のrevisionと原価と在庫減算を再読込できるまで登録完了とは言わない。
- レシート全体 17,100円のうち他の9種セット売却13,000円の取得原価は別途照合待ち。**17,100円全体の実現利益を−1,300円だと誤認しない**。

## 2026-11-01 アリウム売却損益20,100円の原価照合
- トレカショップアリウム11/01 13:52売却：MEGAドリームex（シュリンクあり）売上11,700円／過去本人申告の原価5,500円／利益6,200円。30th CELEBRATION 1BOX（シュリンクあり）売上19,500円／カードボックス日本橋購入原価7,200円／利益12,300円。メガシンフォニア（シュリンクなし）売上7,000円／過去本人登録の原価5,400円／利益1,600円。
- 合計：売上38,200円、原価18,100円、売却利益20,100円（追加費用なし）。メガドリームexの原価は過去のポケセンオンライン購入記録、メガシンフォニア5,400円は過去本人登録原価。最新V2正本の個別購入履歴・割引等を直接読めていないため、過去記録に基づく確定集計であり本番反映確認ではない。
- Google Sheets Queueのアリウム売却3件は全てpending/attempts=0のまま。別の売却コマンドは作らず、最新V2 canonical readbackと商品名・状態一致、在庫減算・売却損益反映を検証してから処理済みとする。

### 2026-11-02 — Command queue stuck / one-time trigger recovery attempt
- User reports November 1 sales not reflected in expenses/revenue and MEGAドリームex inventory not decreasing. Verified queue rows for 10/25 and 11/01 plus lottery all remain pending with attempts=0 on Nov 2 (no recorded queue worker claims).
- Apps Script deploy Actions run 41088210600 completed successfully Oct 30, but market refresh run 41301732709 failed Nov 1 with function_not_found; *deployment != callable API or installed triggers*. Root cause not proven solely from pending rows.
- Add `.github/workflows/tv2-recover-triggers-once.yml`: tries `tv2AutomationStatus` via existing API executable, fail-closed if missing; if executable available, run `installTv2Automation` (managed trigger schedule 15-minute queue / 30-minute Gmail), and read-back counts. This workflow leaves inventory and transactions untouched directly; user-reported sale commands in queue may be processed asynchronously once triggers run. Script API credentials are never logged.
- Safety: NO new sale commands, no manual inventory override, no deletion of purchasing/sales data. If API probe shows function_not_found/authorization, installation is NOT attempted; Work/browser access to Apps Script editor may be required. If trigger restore succeeds, V2 canonical readback still required to confirm MEGAドリームex -1, メガシンフォニア -1, sales, cost and derived profit. In-flight queue statuses must be checked to avoid duplicate submission.

### 2026-11-02 — Queue recovery attempt result (API function_not_found)
- GitHub PR #103 merged (commit 83f518796d64b5eeb0ab8a2657fa39182cf68cd3). Read-only status probe in Actions run #41388756553 **failed** with `function_not_found` (2026-11-02 13:29 JST), so **installTv2Automation was not executed**, no triggers were deleted or created by the workflow, and no V2 JSON was changed.
- On November 2, Queue row IDs for 2026-10-25/2026-11-01 **eight sales** and TCG193 lottery are still `pending` with attempts=0. Not just UI cache. The last source deployment succeeded October 30 but function execution via Apps Script API is not functioning; passing deployment does not imply executable API.
- User reports revenue and MEGAドリームex stock not reflected. Expected source-of-truth stock after 11/01 MEGAドリームex sale is 1BOX (previous audit 2 - sale 1), but **cannot claim canonical revision has that stock yet**. Same pending issue affects sale P&L including 2026-11-01 gross 55,300 yen and earlier 2026-10-25 sale 31,000 yen.
- Blocker: an Apps Script editor/cloud-browser authenticated check is required to verify API executable access, Google Cloud API/ OAuth client project alignment, and actual installable triggers. Do not submit duplicate sales to bypass this. After repair, verify queue transitions to done/review with nonzero attempts and verify each V2 canonical transaction, original cost, quantity, realized P&L, including 9-card set product alias mismatch. No manual optimistic stock decrement.


### 2026-11-02 — Apps Script editor/API/auth preflight (no sales re-submitted)
- PR #103 is merged (83f518796d64b5eeb0ab8a2657fa39182cf68cd3). Actions #41388756553 failed its read-only `tv2AutomationStatus` API probe with `function_not_found`; trigger restoration and trigger read-back were skipped. No queue or V2 data changed in that workflow.
- Signed into the Apps Script owner account. In `Toreca Vault 抽選自動化`, current source exposes `tv2AutomationStatus`; a manual editor run completed at 23:19 JST. The project has an active API executable deployment (version 204 of the selected deployment) and six active deployments total. The API function and active deployment exist in the editor, but this does not resolve why GitHub's API call returns `function_not_found`.
- Read-only trigger inventory shows exactly four managed triggers: `runTv2Automation` every 15 minutes, `runTv2LotteryGmailCheck` every 30 minutes, and result checks at 12:30/19:00 JST. Latest visible runs completed at 23:16 and 23:10 JST; Google execution history marks them completed. The trigger schedule was not modified. A completed Apps Script execution alone does not prove queue rows were processed.
- Running `tv2AuthorizeCommandQueue` from the editor failed because SpreadsheetApp requires `https://www.googleapis.com/auth/spreadsheets`. Google presented six requested scopes: spreadsheets, full Gmail (`mail.google.com`), external requests, script trigger management, user email, and OpenID. No scope was granted because this is broader than queue-sheet-only access.
- Project settings still show GCP `Default`. The editor warns that changing to a standard GCP project revokes all prior authorizations, cannot be reverted to Default, and requires enabling relevant APIs. Target project number 1072944905499 was previously identified from a read-only GitHub Actions diagnostic; Cloud Console returned “Site Unavailable” in this browser, so ownership/IAM and API enablement were not verified. No project switch was made.
- Read-only Drive fetch of the JSON file configured in the automation project's `TV_V2_DATA_FILE_ID` property returned a file named `toreca-vault-v2-staging.json`, revision 2410, 97 transactions, and 32 lots. It has no 2026-11-01 sale transactions; the MEGAドリームex lot remains quantity 2 at unit cost ¥5,500. Because the configured filename says “staging”, confirm canonical-file identity before treating this as canonical verification. Neither stock nor sales were manually changed.
- Queue readback still shows eight sales pending with attempts=0 (plus the TCG193 lottery row). No sale records were re-submitted. Expected 11/1 gross ¥55,300 and profit ¥21,000 are not yet reflected in the read-back data.
- Blockers before processing: determine why the Actions credential/target project resolves to a script without the callable function, verify Standard GCP project/API settings, and resolve the required OAuth scopes. Do not re-submit sales or grant the broad scopes without user approval. After the blocker is cleared, process only existing queue rows once and verify canonical revision, lots, transactions, and realized P&L.


### 2026-11-02 — Actions target classification follow-up
- PR #104 merged (3b01168f66466adbf97234bb2ce0d66764c9ab1e). Its diagnostic hashes `TV2_SCRIPT_ID` and prints only a label. Actions #41462078443 classified it as the `Toreca Vault 抽選自動化` project (ID itself withheld); it did not target the separate V2 API project.
- The follow-up read-only API probe still failed `function_not_found`; trigger restoration/read-back were skipped. The editor source contains `tv2AutomationStatus`, and an active API executable deployment exists (selected version 204), so target-ID mismatch is ruled out. GCP is still `Default`; project alignment/deployment configuration remains unresolved.
- No triggers, sales queue rows, inventory, or V2 transactions were modified by the follow-up Action.


### 2026-11-03 — Cloud Run / Firestore migration foundation (prototype)
- Created branch `build/cloudrun-firestore-foundation-20261103` from main. Added an isolated Cloud Run V2 API adapter in `cloud/`, preserving schemaVersion 2, revision compare-and-swap, mutationId deduplication, bearer auth, strict CORS, and post-write canonical readback.
- Writes default to disabled, empty Firestore is not auto-initialized, and a 900,000-byte document ceiling fails closed. The adapter is not deployed and contains no production credentials.
- Added a pure JST schedule planner, Firestore lease/idempotency ledger, and independent worker dispatcher. Leases use hashed job IDs, per-claim fencing tokens, bounded retries, and safe error codes; the ledger stores no mail/command content. At 19:00 the hourly Gmail scan carries the focused-results flag to avoid a second Gmail job. Added CI syntax checks and 25 unit tests covering the API, Firestore adapter, migration report, schedules, leases, and dispatch. Local verification: `npm test --prefix cloud` (25 passed), `npm run check --prefix cloud` (passed).
- GitHub Actions `v2-ci` run #41551268809 for the 13-test migration-report commit and run #41556556602 after schedule planning and #41556918790 after ledger/dispatcher implementation completed successfully.
- No Cloud resources, Firestore documents, OAuth settings, Apps Script triggers, Sheets queue rows, Drive JSON, sales, or inventory were changed. The eight pending sales were not re-submitted or processed.
- Next gates: verify the actual canonical data file (the latest read is explicitly named `toreca-vault-v2-staging.json`); add isolated Google Sheets/Gmail worker adapters; test Firestore transactions/lease races in the emulator; verify a 90-day TTL policy for `expireAt`; and obtain Google auth/project access before cutover. The dispatcher has no Google API handlers and no GCP integration or live-price runtime test has been performed. External side effects still require message/request IDs and V2 mutationId protection.
- Planned schedule only (not live): command queue every 15 minutes; Gmail lottery scan hourly 09:00–23:00 JST; focus checks at 12:30 and 19:00, with 19:00 combined into the hourly Gmail job to avoid a second scan; market refresh once daily at 13:45 JST (first 15-minute tick after 13:30).
- Continuity rule: after every work turn, update the Google Docs handoff, this `docs/HANDOVER.md`, and a dated portable Markdown handoff with completed work, verification, next steps, and blockers. Keep pending sales/lottery queue rows untouched during this prototype.
- New architecture handoff: [`docs/NEW_DESIGN_HANDOVER.md`](./NEW_DESIGN_HANDOVER.md) captures the Chat-first design, component boundaries, planned JST schedule, migration gates, and current limitations. Treat this as a plan; no new workers or schedules are live.



### 2026-11-03 — Idempotent Firestore command intake prototype

- Audited the existing Apps Script queue contract: eight columns (requestId, payloadJson, status, attempts, createdAt, processedAt, result, error), nine allowed command types, duplicate ID/collision checks, and bounded processing.
- Added an authenticated /api/v2 enqueueCommand action plus Firestore create-once queue storage. Exact request retries return the existing status; same ID with a different payload returns HTTP 409. Queue is disabled by default with TV2_ENABLE_COMMAND_QUEUE=false; accepting a command does not execute it.
- Added fenced claim leases, a three-attempt default limit, review on exhausted attempts, and tests for resends, collisions, lease expiry, stale workers, API auth, and disabled-by-default behavior. Command payload is retained for retry/audit; no queue TTL/retention policy is configured.
- Verification: npm test --prefix cloud — 31 passed; npm run check --prefix cloud — passed. This is local/unit-test verification only; no Firestore emulator or live cloud resources were used.
- Production state: no deployment, trigger change, Sheets/Gmail connection, command execution, V2 mutation, or queue replay. Existing 8 pending sales and TCG193 remain untouched. PR #105 remains draft.
- Next: run Firestore emulator tests, define payload retention and dead-letter review, implement command-to-V2 domain mutation with the existing invariants, build a one-way shadow adapter without dual execution, then test imported production snapshot in an isolated project before requesting cutover acceptance.


### 2026-11-03 — Queue retry review verification

- Follow-up safety refinement: result metadata is restricted to short alphanumeric codes; arbitrary worker text is replaced with a generic code. Exhausting the configured attempt count transitions the command to `review`.
- Verification now: `npm test --prefix cloud` — 32 passed; `npm run check --prefix cloud` — passed. Latest GitHub Actions check pending for this refinement.
- No deployment, queue processing, trigger changes, or V2 writes.


CI correction (2026-11-03): code commit 588f01b passed GitHub Actions v2-ci run #41578881857 (32 tests). Branch commits after it only changed handoff docs.


Environment blocker (2026-11-03): this local workspace has no gcloud or Firebase CLI, so Cloud Run/Firestore provisioning and Emulator startup could not be performed here. GitHub CI success covers code tests only, not deployed API auth/execution or canonical V2 readback.


### 2026-11-03 — Initial V2 command transitions and worker prototype

- Added pure V2 transitions for purchase, sale, pack opening, and lottery application. Requires explicit unit cost; opened-box singles are zero-cost; sales remove consumed stock using FIFO; ambiguous inventory matches stop for review.
- Added queue worker orchestration: claim → transition → revision-CAS snapshot save/readback → queue settlement. The save-before-settlement retry path detects the prior mutation ID and does not duplicate the transaction.
- Unsupported result/receipt/bulk/spouse/repair variants go to review. Worker is not connected to the runtime/API or existing Apps Script/Sheets queue.
- Local verification: 44 tests and syntax checks pass. GitHub Actions for this latest code is pending. No Emulator/deployment/production data verification.
- Existing system and pending sales/lottery rows remain unchanged.


CI follow-up (2026-11-03): GitHub Actions v2-ci #41631701365 succeeded for the new V2 transition and command-worker code. The test and syntax-check steps passed. Later branch commits only updated handoff documentation. Emulator, deployed service, and production-state verification remain pending.


### 2026-11-03 — Lottery transition extension

- Added exact lottery result, receipt status, and guarded bulk result transitions. Matching must be unique; bulk fails closed if no target or any target is purchased/received. These updates do not create purchase/inventory rows.
- Supported pure transitions now cover seven types: purchase, sale, open-packs, lottery application, exact result, receipt, and bulk result. Pokémon Center spouse-specific result and receipt-sale repair remain review-only.
- Local verification: 47 tests and syntax check pass. CI for this extension was pending at the time of this handoff update. No Emulator/production data tests.


CI follow-up (2026-11-03): GitHub Actions v2-ci #41632052953 succeeded for the lottery result/receipt/bulk extension. Test and syntax-check steps passed; subsequent branch commits only update handoff docs. Emulator and production checks remain unverified.


Queue identity guard (2026-11-03): the worker now checks that the claimed document requestId matches the payload requestId immediately before reading or mutating V2. A mismatch enters review before any canonical write. Local verification is 48 tests plus syntax check; CI for this addition was pending at handoff time.


CI follow-up (2026-11-03): GitHub Actions v2-ci #41632298133 passed for the requestId cross-check. Test and syntax-check steps succeeded; later commits are documentation-only. Emulator/production verification remains outstanding.


### 2026-11-03 — Progress estimate and Gmail message dedupe planning

- Whole project is estimated at ~25% through production cutover (stage-weighted, approximate). Architecture/schedule design is complete; API/queue and seven command transitions are prototype-tested but not runtime-connected. Gmail API/parser, market worker, cloud provisioning, canonical migration, E2E verification, and cutover have not started.
- Added bounded-page Gmail message planning using only provider IDs, stable SHA-256 job keys, per-page duplicate removal, and fail-closed oversized-page handling. Planner retains no body, subject, sender, or labels; Gmail API is not connected.
- Local verification: 51 tests and syntax check pass. GitHub Actions v2-ci #41634692957 succeeded. No Firestore Emulator or production check.


### 2026-11-03 — Bounded Gmail scan windows and pagination

- Added a pure Gmail query/cursor planner: seven-day initial backfill, 15-minute overlap for hourly scanning, six-hour overlap for result-focused scanning, maximum 100 messages per page.
- The query upper bound stays fixed across `nextPageToken` pages. A successful timestamp advances only after the final page is durably processed; invalid/oversized inputs fail closed. Combined with the message-ID ledger key planner, repeated messages are not applied again.
- Local verification: 55 tests and syntax check pass. GitHub Actions v2-ci #41635098677 succeeded. Gmail API, OAuth, parsing, and persisted checkpoints remain unconnected.
- Project progress estimate: about 25% to production cutover; breakdown in the portable handoff.


## 2026-11-04 — Gmail classifier port

- Ported the current Apps Script lottery Gmail eligibility rules (result/application/card keyword filters) into a pure Node classifier. It emits only a classification/reason and does not persist mail fields or mutate V2.
- Added tests for results, applications, focused result scans, and non-matching mail; registered the test and syntax check.
- Local verification: cloud test suite 58 passed; syntax check passed. Latest PR head `0eabd4071ba23dc169ebb0ad118d8e612369106f`: Actions v2-ci #41721123698 succeeded; both `npm test` and `npm run check` steps passed.
- No Gmail provider/OAuth, runtime connection, production trigger, Apps Script deployment, or V2 mutation. Existing production data and triggers were left untouched; no queued sales were replayed.
- Next: verify CI, implement a read-only Gmail adapter with least-privilege OAuth and durable bounded checkpoints, add quota/retry recovery coverage, and continue market adapter work. Canonical V2 identity and cloud permissions remain prerequisites to migration/runtime.


## 2026-11-04 — Gmail page worker

- Added a provider-agnostic Gmail scan worker connecting the bounded query planner, provider message IDs, durable message-job ledger, and injected processor. No message subject/body/from is persisted by this layer.
- Checkpoint advances only after every returned message job is complete or already complete. Failed/busy/exhausted jobs leave the cursor unchanged; successful final page alone updates lastSuccessfulAt.
- Added failure/pagination/final-page tests. Local verification: 61 tests passed; syntax check passed. Latest PR head `c092911bf612d5cf4234385bffd0329a611bc665`: Actions v2-ci #41721641270 succeeded; both `npm test` and `npm run check` passed.
- Gmail OAuth/provider, durable checkpoint implementation, production wiring, Apps Script deployment, and V2 changes remain unimplemented. Existing production data/triggers unchanged.
- Next: verify Actions, implement Firestore cursor persistence + quota-aware provider contract, then the least-privilege Gmail adapter when Google Cloud credentials/permissions are available.


Latest handover commit `9933e4238c769cd3d9794ebc13a206e4e00fd7cc`: Actions v2-ci #41721758957 succeeded, including `npm test` and `npm run check`.


### 2026-11-04 — Firestore Gmail checkpoints and quota-aware provider
- Added `cloud/src/firestore-gmail-checkpoints.js`: Firestore stores only the scan type, fixed-window page cursor, last-success timestamp, schema version, and update time. The worker writes the initial window before requesting Gmail, resumes that window after failure, uses expected-cursor compare-and-swap against stale workers, and atomically clears the cursor/updates last-success after the final page.
- Added `cloud/src/quota-aware-gmail-provider.js`: injected Gmail list requests retry 429/5xx and recognized 403 quota responses with bounded exponential backoff, capped Retry-After, and attempt limits. Authentication errors are not retried. No message content is persisted by these modules.
- Registered focused tests for checkpoint validation/CAS/atomic completion, scan-window resume, quota retries, Retry-After caps, non-retryable auth failures, and retry exhaustion. GitHub Actions v2-ci #41830898928 succeeded; both `npm test` and `npm run check` passed.
- Runtime boundary: no Gmail API client, OAuth grant, Firestore Emulator, Cloud Run deployment, production checkpoint, or live message processing was added. Existing Apps Script, triggers, V2 data, and pending queue rows remain unchanged; no pending sales or lottery row was replayed.
- Next: add isolated Firestore Emulator concurrency/race tests; implement the Gmail API adapter with least-privilege read-only scopes when the authorized Cloud project/credentials are available; then wire the adapter and checkpoint store only in staging. Canonical V2 identity is still unresolved, so no import/cutover.


### 2026-11-04 — Gmail checkpoint generation fencing follow-up
- Tightened checkpoint compare-and-swap to include the previous `lastSuccessfulAtMs` as well as the cursor. This prevents a stale invocation from recreating an old cursor after a newer scan has completed and cleared it.
- Added a regression test for stale-generation restart. Focused local verification: 10 tests passed; GitHub Actions v2-ci #41831501955 passed the full `npm test` and `npm run check` steps.
- Still no emulator or live Firestore/Gmail validation; production and queue state unchanged.


### 2026-11-04 — Firestore Emulator race-test scaffold
- Added an opt-in Admin SDK integration test for concurrent checkpoint advances, stale-generation rejection, and final readback. It uses a unique demo-project namespace and cleans up its document. Added `cloud/firebase.json` and `npm run test:firestore-emulator --prefix cloud` instructions.
- Local focused run: 10 passed, 1 Emulator integration test skipped because `FIRESTORE_EMULATOR_HOST` is unset. This workspace has Java but no Firebase CLI or gcloud, so no actual emulator transaction race was executed.
- GitHub Actions v2-ci #41832445196 passed the full `npm test` and `npm run check` steps. The emulator-specific test remains opt-in and was not run against a live emulator.
- No production credentials, Gmail, Firestore, Apps Script, triggers, queue rows, or V2 data were accessed or changed.
- Next: execute the opt-in test against an isolated Firestore Emulator when Firebase CLI/emulator runtime is available; then implement/wire the least-privilege Gmail adapter only after authorized Cloud credentials are available.


### 2026-11-04 — Firestore Emulator race tests verified in CI
- Added a dedicated GitHub Actions job that installs Firebase CLI 15.34.2 and runs the opt-in Firestore test inside `firebase emulators:exec` using the `demo-toreca-vault` project. The emulator config loads deny-all client rules; test writes use the Admin SDK only against the local emulator.
- First emulator run exposed a test teardown typo (`db.close`); changed cleanup to the Admin SDK's `db.terminate()` and reran.
- GitHub Actions v2-ci #41833501945 succeeded: both normal `npm test`/`npm run check` and the separate Emulator job passed. Emulator log shows 1/1 race test passed, 0 failures, 0 skipped. It verified competing cursor CAS updates, rejection of a stale generation after completion, and final checkpoint readback.
- This is isolated Emulator validation only. No production Firestore, Gmail, Apps Script, triggers, canonical V2, or pending queue rows were accessed or changed.
- Next: implement the read-only Gmail API adapter using least-privilege OAuth only after authorized credentials/project are available; keep it staged until canonical V2 identity and migration readback gates are satisfied.


### 2026-11-04 — Read-only Gmail API list adapter
- Added `cloud/src/google-gmail-api-provider.js`. It calls only `users/me/messages` list, asks the injected access-token callback for the single `https://www.googleapis.com/auth/gmail.readonly` scope, and returns only message IDs/page tokens. It does not fetch bodies, subjects, senders, or labels; API error bodies are reduced to safe status/reason fields.
- The adapter uses the bounded quota retry wrapper, refreshes the injected token for each attempt, caps request duration and pagination values, and fails closed on malformed IDs. No OAuth grant or refresh-token storage was added.
- Added four mock transport tests for request shape/scope/ID-only output, quota retry/token refresh, auth failure sanitization, and malformed IDs. Local targeted tests: 4 passed. GitHub Actions v2-ci #41834363103 succeeded; standard test/check and Firestore Emulator jobs both passed.
- No user Gmail account or credentials were used; no live mail, Firestore, production data, Apps Script, triggers, or pending queue rows were touched.
- Next: implement/configure the least-privilege OAuth token source only when the authorized Cloud project and credentials are available; then test in staging. Canonical V2 identity is still a migration gate.


### 2026-11-04 — Bounded Gmail detail reader and transient classification
- Extended `cloud/src/google-gmail-api-provider.js` with read-only per-message detail retrieval using the existing injected `gmail.readonly` token source. It requests the subject header and bounded MIME text parts, returns only subject plus decoded `text/plain`, and rejects message content over 512 KiB, more than 128 MIME parts, or nesting deeper than 8. No sender/recipient fields are returned.
- Added bounded quota retry for detail requests and a pure `createGmailClassifierProcessor` that returns only classification kind/reason. No subject/body or classification is persisted by this change.
- Added mock tests for detail URL/field mask, content bounds, transient fields, and processor output. GitHub Actions v2-ci #41837018173 succeeded: full npm test, npm run check, and the Firestore Emulator job all passed. The task workspace had no local repository checkout, so tests ran in CI.
- Important wiring gap found during review: `dispatchJobs` discards handler return values and marks a job completed. Do not wire this classifier processor into the scanner until a durable result-code consumer exists, or a successful classification could be lost while its message ID is deduplicated.
- No OAuth grant/token source, live Gmail, Cloud Run/production Firestore, Apps Script, trigger, canonical V2, or pending queue row was accessed or changed. The eight pending sales and TCG193 remain untouched.
- Next: verify CI, add a durable classification outcome path that stores only hashed message ID and classification code/reason, and test unique/ambiguous matching before any V2 transition. Verify Google Cloud project and restricted-scope approval before staging. Canonical V2 identity remains unresolved.


### 2026-11-04 — Redacted Gmail classification outcome store

- Added a Firestore collection for compact classifier outcomes. Each document ID is SHA-256(messageId); stored fields are the hash, schema version, classification kind, optional allowlisted ignore reason, and timestamp. No raw message ID, headers, subject, or body is stored.
- The classifier processor now writes its outcome before returning. If the durable write fails, the handler fails and the scan worker will not advance the cursor. If ledger completion later fails, retry sees the same classification record and returns an idempotent duplicate; a conflicting reclassification fails closed.
- Added tests for write-once outcomes, hashed IDs, privacy bounds, conflict rejection, and processor ordering. GitHub Actions v2-ci #41838849830 succeeded: full npm test, npm run check, and isolated Firestore Emulator jobs passed.
- The processor is still not wired into a live scanner/runtime. No OAuth grant, live Gmail, Cloud Run/production Firestore, Apps Script, triggers, V2 writes, or queue replay. Existing data and the eight pending sales plus TCG193 remain untouched.
- Next: verify CI, compose the existing scan worker with the detail provider, Firestore checkpoint, message ledger, and classifier processor in isolated tests; then test unique/ambiguous V2 matching without writes. Cloud project/token source and canonical V2 identity remain staging/cutover gates.


### 2026-11-04 — Gmail scan/classifier composition tests

- Added isolated composition tests for the read-only detail provider contract, the bounded scanner, message job ledger, classifier processor, and Firestore classification result store.
- Verified ordering: persist hashed-ID classification outcome → complete message job → advance the scan checkpoint. If the outcome write fails, the job remains incomplete and the cursor stays at its saved window.
- GitHub Actions v2-ci #41838849830 passed npm test, npm run check, and the Firestore Emulator job. The scan composition is still mock-only; no Gmail/OAuth or production runtime is connected.
- Next: confirm canonical V2 source identity and target Cloud project/token source, then add privacy-preserving unique/ambiguous match rules before any staging V2 transition. Production cutover and Apps Script changes remain gated.


### 2026-11-04 — Canonical V2 source identity check

- Performed read-only Google Drive searches for `toreca-vault-v2`, the exact `toreca-vault-v2-staging.json` name, and JSON files matching the project name. Results exposed the handoff document and command queue only; no V2 JSON candidate was discoverable in Drive search.
- The Apps Script configured source ID/ScriptProperties cannot be inspected with the connected tools available in this session. Therefore canonical identity remains unverified; no candidate was read as canonical, imported, or changed.
- No queue rows, Apps Script triggers, V2 data, or Gmail messages were read or mutated by this check. Eight pending sales and TCG193 remain untouched.
- Next: obtain a read-only export/source ID from the configured Apps Script project (or an explicitly confirmed canonical Drive file), then compare revision/hash/counts before any staging import. Keep production cutover disabled.


### 2026-11-04 — Canonical source search follow-up

- Expanded read-only Drive searches to the configured source-key name, project-name variants, V2Automation.gs, and the Apps Script project MIME type. No Apps Script project or V2 JSON was returned; search exposed only the handoff and command queue.
- Checked diagnostic Actions run #40676318499 for artifacts; none were attached. The Apps Script workflow uses the configured source ID for push/deploy and is not a safe read-only lookup path.
- Canonical V2 identity remains unverified. No Apps Script settings/source, V2 data, Gmail messages, triggers, or queue rows were accessed or changed. Eight pending sales and TCG193 remain untouched.
- No further implementation can safely depend on live V2 identity here. Resume after a read-only configured source ID/export or explicitly confirmed canonical Drive file is available; record revision/hash/counts before isolated import and matching checks. Keep production cutover disabled.
- Latest code CI #41839376404 was reported successful for npm test, npm run check, and the Firestore Emulator job; it does not verify live Google access or canonical V2 data.


## 2026-11-05 — Confirmed requirements from regular Chat

Status: user-approved requirements; implementation and production wiring remain incomplete. Earlier dated history is retained; this section is the active specification.

- Build the replacement app, not a repair of the old V2 Apps Script. Reuse the existing Cloud Run/Firestore prototype and tests. Avoid Apps Script version quotas and prefer non-Apps-Script APIs, scheduled work, and Gmail integration.
- Gmail: poll hourly at 07:00, 08:00, …, 23:00, and 24:00 JST (midnight at the start of the following day). This is independent from the Chat command queue. Change recorded 2026-11-05: the prior Work note's 30-minute interval was a temporary direction; the user reconfirmed hourly and said 30 minutes is unnecessary.
- Chat command queue: process every 15 minutes. Completion requires ordinary Chat text and screenshot reports to be able to submit lottery, purchase/receipt, opening, and sale commands; Work-only entry is insufficient.
- Market refresh: once daily after 13:30 JST for BOX, packs, and singles. Store source and checked time; preserve the prior quote and mark unavailable/stale on failure; never guess. Keep market refresh independent of Gmail failures.
- Migration: preserve lottery, purchase, sale, opening, inventory, and cost-basis history; prevent duplicate entries and double-counted cost. Exclude the user's schemaVersion 1 file and the unconfirmed staging JSON. Never replay pending sales. No writes to old V2 before data validation; production cutover and retirement of the old system require user acceptance.
- Persistence path discovery: current GitHub V2 automation sends action=load to the Apps Script Web App URL in TV2_SYNC_URL and validates schemaVersion 2. In the authenticated Apps Script list, the Toreca Vault V2 API project and V2Api.gs were found; its settings contain TV_V2_DATA_FILE_ID, described in code as a dedicated V2 JSON file separate from V1. The old app's backup action failed because this browser app had no V2 connection URL configured.
- Data read status: the storage route is identified, but the JSON contents have not been retrieved. Schema/revision/timestamp/counts/quantities/cost/asset totals/hash remain unverified, and no backup exists. Exclude toreca-vault-data.json (schemaVersion 1, last modified 2026-10-05) and unconfirmed toreca-vault-v2-staging.json. Never record tokens or secrets in handoff files.
- Verification and cost: reuse the existing PR #105 prototype. Latest recorded code CI #41839376404 passed tests/checks/Firestore Emulator. Live Google API/OAuth, canonical data, Cloud resources, real Chat intake, and free-tier usage are unverified. Cloud Run + Firestore remains the baseline candidate; verify quotas and cost.
- Next: read the dedicated V2 file without mutation, validate revision/content/totals/hash, and save a backup. Continue independent new-app work even if V2 data retrieval remains blocked. Align Gmail scheduling with the hourly 07:00–24:00 requirement.



## 2026-11-05 — V2 storage-target follow-up

- The configured TV_V2_DATA_FILE_ID in the authenticated Toreca Vault V2 API project resolved by Drive URL to a file named toreca-vault-v2-staging.json. It remains unconfirmed staging, so no record aggregation, migration, backup, or hash was performed on it.
- The Drive folder “Toreca Vault Private” lists the handoff Doc and the user's schemaVersion 1 toreca-vault-data.json only; no separate V2 JSON candidate was visible there.
- The old V2 app backup action failed because the Work browser app has no Apps Script connection URL configured. Production V2 contents remain unverified; no backup/hash exists.
- Needed to resume canonical data validation: attach a read-only JSON export produced by the already-connected regular browser/app, or provide the confirmed production Drive file link. No token/Secret is needed. Do not alter old V2 settings or redeploy.



## 2026-11-05 — 通常ChatとWorkの決定事項引き継ぎ手順（確定）

- 適用範囲: Google Docs「Toreca Vault Handoff (CURRENT)」、このファイル、`docs/NEW_DESIGN_HANDOVER.md`。新アプリ専用のLibrary引き継ぎ資料にも同じ状態を反映する。会話間の自動共有は前提にしない。
- 作業開始時: 最新版のGoogle DocsとGitHubの両引き継ぎ、新アプリ専用資料を読み、相互の差分と直近の変更履歴を確認する。
- 新しい仕様・設定・運用方針が通常Chatで決まった場合: Workで開発に着手する前に、ユーザーが共有した決定内容を各引き継ぎ先へ記録する。通常Chatの会話をWorkから取得できない場合は自動共有済みと扱わず、共有された内容だけを記録する。
- 既定事項を変更する場合: 過去の記録を削除・上書きせず、追記で旧仕様、新仕様、変更日、変更理由を残す。ユーザー承認なしに確定仕様を変えない。
- 状態表示: 各項目を「決定済み」「検討中」「実装済み」「未実装」「検証済み」の該当状態で明記する。実装済みと検証済みは別々に扱い、未検証を完了と表現しない。
- 保存後: Google Docs、GitHub各ファイル、Library資料を再読込し、追記内容が保存されたことを確認する。確認できない場合は未確認と報告する。
- 秘密情報: 認証トークン、Secret、同期キーなどを引き継ぎに記載しない。

### 現在の確定仕様（2026-11-05）

- 旧V2を修復せず、新アプリを開発する。Cloud Run + Firestoreを基本候補とし、Apps Scriptの保存版上限に依存しない。
- Gmail抽選メール確認: 毎日07:00〜24:00 JST、1時間ごと。24:00は翌暦日の00:00。通常Chat登録キュー処理: 15分ごと。両スケジュールは独立。
- 買取相場: 毎日13:30以降に1回。Gmail障害と独立し、未取得時に前回価格と未更新状態を区別し、推測価格を登録しない。
- 通常Chatからテキスト・スクリーンショットで報告して自動登録することを最終要件とする。
- 旧V2の購入・売却・在庫・原価・抽選履歴を安全に移行する。未確認のstaging JSONは移行元にしない。正本検証前の書込みや切替は行わない。
- 無料枠、API上限、長期保守性を考慮する。確定仕様の変更と本番切替はユーザー承認後。


## 2026-11-05 — Gmail確認時刻の実装・検証状況

- 決定済み: Gmail抽選メール確認は毎日07:00、08:00、…、23:00、24:00（翌暦日の00:00）の1時間ごと。通常Chat登録キューの15分間隔とは独立。
- 実装済み: `cloud/src/schedule.js` のGmail due判定を上記時間に合わせ、`cloud/test/schedule.test.js` に07:00・各時刻・翌日00:00、01:00〜06:00の時間外、07:30の非実行境界を確認するテストを追加。関連コミット: `3d843c2`、`9bbd7d0`。
- 検証済み: ローカルのscheduleテスト5件成功。GitHub Actions `v2-ci #42022058028` がcommit `9bbd7d050f8448263d00dbb9db8a3f636d6740cd` で成功。
- 未実装/未検証: Cloud Scheduler等への本番設定、Gmail worker/OAuthの接続、実Gmailでの時刻・API利用量の運用確認は未完了。今回、旧V2やトリガーへの変更は行っていない。


## 2026-11-05 — 新アプリ設計監査と予防的改善

### 発見と判断

- **A Firestore容量** — 現行adapterはV2全体を1ドキュメントに保持し、900,000 bytesで書込みをfail-closedする。Firestore Nativeの文書上限は1 MiB-4 bytes。V2正本のサイズと成長率をまだ取得できず、今コレクション分割すると複数文書の整合性・トランザクション・追加read/writeを増やすため、移行前の分割は保留。正本をread-only検査し、630,000 bytes超または90日実測成長から12か月以内に安全上限到達が見込まれる場合は移行を止め、分割案を再設計する。現状のfail-closedは維持。
- **B 定期処理** — plannerが実起動時刻を予定時刻として使い、19:00の重点確認を別Gmail jobとして出していた。plannerに予定時刻入力を追加し、遅延起動でもjob keyを予定slotに固定。19:00は毎時Gmail job一つに重点フラグを付け、12:30重点確認は維持。保留コマンドとGmail固定window/checkpointは再開可能な状態を保持する。一方、Cloud Schedulerの予定時刻headerをruntimeで渡す接続、永続heartbeat、実行漏れアラートは未実装。
- **C Gmail** — 各ページの上限を100件から50件へ下げ、plannerとproviderの両方で強制。Googleの現在の表ではmessages.listは5 units、完全形式messages.getは60 units、ユーザーごとの上限は6,000 units/分。50件の1ページは最大3,005 units（list 1回+full get 50回）で、短時間の上限到達余地を減らす。ページング/checkpointは継続する。19:00の二重実行は解消、12:30は保持。OAuth grant/token source、refresh失敗通知、実Gmail接続は未実装。認証エラーは自動再試行しない。
- **D 通常Chat登録** — 認証済みAPIにPOST queue受付とstatus-only GETを追加し、pending/processing/done/reviewと正本readback確認を区別。status APIはコマンド本文を返さない。`cloud/openapi-chat-action.yaml` を追加した。API/queueは既定無効で、Cloud Run未配備のため通常Chatからのend-to-end投入は未検証。queueのrequestId+payload hashは完全再送を防ぐが、ChatとGmailの異なるIDを同じ抽選イベントとして認識する業務キーは未実装。Gmailはまだ分類のみでV2履歴を書かない。この照合ができるまではGmail結果をV2へ適用しない。
- **E バックアップ/復旧** — 定期backup、restore drill、破損時の復元手順は未実装。Firestore backup/PITR/restoreとTTL削除に無料枠外の費用があり得るため、費用見積りとユーザー承認の前に有効化しない。隔離環境で復元検証と保存期間を設計する。
- **F 監視** — 現在の`/health`は初期化と書込み設定のみ。Gmail最終成功、queue未処理・失敗、相場、backup、auth error、budgetの運用監視と通知は未実装。
- **G 費用** — Cloud本番資源は未作成、利用量も実測なし。公式料金の確認ではCloud Schedulerはbilling account単位で3 jobs/月が無料、Firestore標準無料枠は1日50,000 read/20,000 write/20,000 deleteと1 GiB、Cloud Run request-basedは月200万requestなどの無料枠がある。一つの15分dispatcherはScheduler無料枠内に収まる見込みだが、既存billing accountの利用分とFirestore/Cloud Run/ネットワーク/backup/TTLを含む全体無料は未検証。Gmail quotaはusage limitであってCloud費用の保証ではない。課金設定は未変更。

### 実装・検証結果

- 実装済み: `cloud/src/schedule.js`予定時刻入力、19:00 Gmail job統合、Gmailページ上限50、command status API、`cloud/openapi-chat-action.yaml`。
- テスト済み: schedule・API status・Gmail page/checkpoint・quota retry/providerの関連ローカルテスト29件成功、0失敗。OpenAPI YAML parseとserver/schedule構文確認も成功。GitHub Actions全体CIは今回の新commitについて確認待ち。
- 関連commit: schedule/status/API/schema `ef7bf9c` / `ebec886` / `d7d4159`; Gmailページ上限 `7479b33`; quota/page tests `5671b68`。
- 本番影響: Cloud Run/Firestore、Gmail、Apps Script、既存queue、V2正本は未変更。未処理売却queueの再投入なし。確定した時刻仕様の変更なし。

### 次工程

- GitHub CI全体結果を確認し、Schedule header接続・scheduler heartbeat/alertの実装範囲を決める。
- V2正本取得後にsize/growth reportでsingle-documentか分割か判断し、バックアップとrestore drillを課金見積り付きで提案する。
- requestIdとは別の業務event keyでChat/Gmail抽選を照合する設計を実装前にテストする。通常Chat Actionの実接続は認証・Cloud配備後に検証する。


## 2026-11-05 — 設計監査後のCI確認

- GitHub Actions `v2-ci #42027010332` は成功。`test` job（`npm test` と `npm run check`）および `firestore-emulator` jobの両方が完了成功。
- 変更したSchedule/API/Gmail quota guardの関連ローカルテスト29件は成功、失敗0件。OpenAPI YAML parseとserver/schedule構文確認も成功。
- 変更はPR #105のdraft branchにあり、未マージ・未配備。CI/emulator成功は本番Cloud、OAuth、通常Chat Action、V2正本接続の検証ではない。


## 2026-11-05 — 定期実行の取りこぼし範囲を再確認

- 状態: 予定時刻固定と同一jobKeyの重複防止は実装済み・CI検証済み（v2-ci #42027010332成功）。ただし、遅延起動テストが確認するのはSchedulerが予定時刻を渡した場合で、Scheduler起動自体が丸ごと抜けたケースのheartbeat検知やcatch-up実行を検証したものではない。
- 既存の保留Chat queueは次回dispatcherが保留行を処理でき、Gmailは保存済みwindow/cursorと最終成功時刻から再開し、marketは当日安定jobKeyで13:45以降のtickから起動できる設計。ページ失敗時にGmail cursorを進めないcheckpointテストも通過済み。これは次の起動後にサービス単位の保留データを再開する仕組みであり、実行漏れそのものを監視・通知するheartbeatではない。
- 未実装: scheduler runtimeで予定時刻headerを渡す接続、最後の成功tick/経過時間の保存、未実行アラート、長時間停止の運用通知。したがって「数日停止を検知する」は未達成。今回、heartbeatだけ追加して自動復旧済みと扱う変更はしていない。
- 改善判断: catch-upはサービスごとの耐久cursor/queueを使って分離実装し、Gmail失敗でChat/marketを止めない。runtimeを接続する工程で、欠落slot数の検知と閾値アラートを追加し、長時間の重複scanや一括再実行を避ける。実装・統合テストとCloud設定は次工程。
- 本番状態・制約: Cloud Scheduler/Run、OAuth、queue、旧V2正本は未変更。未処理売却queueの再投入なし。PR #105はdraft・未マージ・未配備。


## 2026-11-05 — V2 JSON候補の読み取り専用取得

- ユーザーの今回の指示により、Apps Script設定が参照する `toreca-vault-v2-staging.json` を未確認候補として読み取り専用で取得。JSON解析に成功し、schemaVersion 2、revision 2563を確認。Drive上の更新日時は2026-11-05 12:41:09 UTC。
- 正本と確認されていないため、移行データ・本番バックアップ・canonical snapshotとして扱わない。V1 JSONも使用しない。取得した候補JSONとSHA-256 sidecarは個人用Libraryに保存。ハッシュ値自体やファイルID、認証情報はこの公開リポジトリへ記録しない。
- 取得は読み取り専用。Apps Script、Drive原本、V2、queue、トリガー、Cloud資源への書き込み・設定変更は行っていない。未処理売却queueの再投入なし。
- 次: 本番正本として確認できるソースが判明したら別途取得し、候補と混同せず検証する。現在の候補を移行に使う判断は未確定。


## 2026-11-05 — Firestore容量監査と分割保存の予防実装

### 決定変更と理由

- 旧設計の「900,000 bytesを超えたら保存を停止し、移行前に別途分割を再設計する」から、「900,000 bytes以下は従来どおり単一ドキュメント、超過時はFirestore内のchunked-v1へ切り替える」に変更。候補JSONのcompact payload-envelope見積りが1,009,515 bytesとなり、単一ドキュメントの内部安全予算を超えたため。変更日は2026-11-05。これは本番保存先・正本・移行元を変更するものではない。
- 先の説明にあった「raw JSON 1.24 MBだからFirestoreの1 MiB上限を超える」という断定は誤りとして訂正する。raw JSONは1,242,326 bytes、JSON compact payload-envelope見積りは1,009,515 bytesで、Firestoreの公称1 MiB-4 bytesを下回る。Firestoreの実際の符号化サイズは未計測なので、上限超過とは断定できない。一方、900,000-byte内部安全予算は超える。
- staging名の候補は未確認データであり、現行V2 validatorがBOX conditionを拒否する。正本・有効な移行スナップショットとして扱わず、件数・在庫・原価・資産集計も検証済みとは扱わない。

### 実装

- PR #105の cloud/src/firestore-store.js にlegacy単一ドキュメント読込互換を残し、保存時は900,000 bytes以下ならsingle、超過時はchunked-v1を使う。
- chunked-v1は配列フィールドを最大650,000 bytesのsegmentへ分割し、revision・順序・件数・payload SHA-256をmanifestで照合する。rootとsegmentsを1トランザクションで保存し、余剰segmentの削除・保存後readbackも行う。7,000,000-byte payload等の安全上限を超えたらfail-closed。
- API body上限を7,500,000 bytesへ整合。Firestore index設定に保存payload/manifest配列のindex exemptionを追加したが、本番へ適用していない。
- migration reportはsingle/chunked/blockedを区別する。candidateの実移行・本番V2書込み・Firestore配備は行っていない。

### 検証・状態

- 保存方式とmigration reportのローカルテストは12件成功、0件失敗。
- GitHub Actions v2-ci #42033589572 はtest/checkとFirestore Emulatorを含め成功。Emulatorでは合成データでchunked save・readback・manifest・segmentサイズを確認した。これは本番データ、OAuth、通常Chat接続の検証ではない。
- PR #105はdraft・未merge・未配備。Cloud請求設定、旧Apps Script、queue、trigger、V2正本に変更なし。未処理売却queueの再投入なし。
- 全体進捗は約25%のまま。コアコードの範囲は広がったが、正本確認、通常Chat実接続、Cloud実運用、バックアップ復元、監視と本番切替は未完了。無料枠内の継続運用も実測前で未保証。

### 次工程

- V2正本の保存経路を特定し、有効な読み取り専用exportを得た後にだけvalidator・保存サイズ・件数・在庫/原価/資産集計を再検査する。候補JSONは使用しない。
- chunked-v1の障害ケース、複数更新、segment cleanupと費用/読み書き数を検証し、Firestore実サイズの見積りに余裕を持たせる。
- 通常Chat Actionからの受付実接続、業務event keyによるChat/Gmail重複防止、Scheduler欠落監視、バックアップ/復元、Cloud利用量を引き続き未解決事項として扱う。


## 2026-11-06 — Firestore分割保存の整合性テスト

- 分割保存の失敗時に破損状態を受け入れないことを確認する単体テストを追加: segment欠落、segment内容改変によるpayload hash不一致、異なるrevisionのsegmentを検出する。
- 大きなスナップショットをrevision 1から2へ更新し、readback payloadと全segmentのrevisionが一致することを確認する。
- 関連ローカルテスト16件が成功、失敗0件。GitHub Actions v2-ci #42110925076はtest、check、Firestore Emulatorを含め成功。新しい不整合テストはfake Firestore transactionで検証し、Emulatorは合成データのchunked save/readbackを検証した。
- これは新アプリのコード検証であり、本番FirestormやV2データの検証ではない。PR #105はdraft・未merge・未配備。本番V2、Apps Script、trigger、queue、課金設定は変更なし。売却queue再投入なし。
- 次工程: scheduler実行欠落のheartbeat/catch-up、読み書きコスト評価、backup/restore設計、通常Chatからの実接続を独立した安全な段階で進める。正本取得は依然として移行のblocker。全体進捗は約25%のまま。


## 2026-11-06 — Firestore Emulator連続更新・破損検知

- Emulator統合テストを拡張し、chunked-v1を2 revision連続で保存した際のroot/segment revision一致とreadbackを検証。segmentの内容を改変した後にhash不一致で読み込みが拒否されることも確認した。
- GitHub Actions v2-ci #42111400132（run #685）は通常test、check、Firestore Emulatorの全jobが成功。前回追加のsegment欠落・改変・revision mismatch・連続更新単体テスト16件も成功済み。
- すべて合成データを使った隔離検証。本番Firestore、V2正本、Apps Script、Gmail、queue、課金設定へのアクセスや変更なし。PR #105はdraftのまま。


## 2026-11-06 — Firestore操作数の基準見積り

- migration reportへ成功更新あたりのFirestore document read/write基準見積りを追加。single保存は3 reads・1 write。chunked保存は segment count=N のとき 3+2N reads・1+N writes。
- 根拠は現行adapterのduplicate確認read、revision-CAS root read、保存後readback。chunkedの初回readとreadbackは全segmentを含む。SDK transaction retryおよび旧segment削除writes/deletesは見積りに含めない。これは基準値であり実測や課金額ではない。
- 操作数見積りを含む保存方式/migration reportのローカル16件は成功。記録時点ではCI未確認だったが、その後のGitHub Actions v2-ci #42112277167（run #688）がbranch head 8ae3436でtest/check/Firestore Emulator全job成功。このheadはoperation estimate変更を含む。
- 無料枠への適合は実際の保存回数、segment数、既存プロジェクトの他利用量を測るまで未保証。Cloud請求設定は変更していない。


## 2026-11-06 — Draft new-app schedule recovery

PR #105 adds a stable daily 12:30 lottery-result focus job that is retried on 15-minute slots through 18:45 after a missed Scheduler tick. Retries retain the 12:30 `scheduledAt`, record `triggeredAt`, and stop when the durable ledger reports completion. The 19:00 focus remains merged into the regular hourly Gmail job. v2-ci #42114904105 (run #690) passed test, check, and Firestore Emulator. Live Scheduler wiring, heartbeat/alerts, Cloud deployment, and V2 source confirmation remain pending; no production or legacy queue changes were made.


## 2026-11-06 — New-app scheduler heartbeat monitoring

PR #105 adds a bounded Firestore heartbeat record and `GET /health/scheduler`. It reports scheduler tick age, missed 15-minute slots, and failed job count without storing command, email, or raw error content. CI #693 detected a response bug and the fix was verified by #694–#697; test, check, and Firestore Emulator succeeded, including heartbeat persistence/recovery. Scheduler runtime wiring and notifications remain pending; the endpoint will report unhealthy until the dispatcher records ticks. No production, legacy V2, Apps Script, Gmail, pending queue, or billing changes were made.


## 2026-11-07 — Scheduled dispatcher orchestration

PR #105 adds a runtime coordinator that parses Cloud Scheduler's planned time, checks durable completion for daily jobs, dispatches due work under leases, and records heartbeat/failure metadata. Existing pending queue and Gmail checkpoints are reused for catch-up; no bulk replay occurs. v2-ci #699 passed tests, checks, and Firestore Emulator. Runtime is not yet mounted behind an authenticated Cloud Run Scheduler route; production handlers and monitoring are pending. No legacy or production data was changed.


### 2026-11-07 JST — 新アプリ引き継ぎとV2読取の現状

- WorkクラウドブラウザでApps Script dashboardを読み取り専用で開こうとしたが、公開Apps Scriptドキュメントへリダイレクトされ、プロジェクト一覧/エディタやScript Propertiesは確認できなかった。canonical V2保存先とTV_V2_DATA_FILE_IDの値は未確認。
- 旧V2、Drive、Gmail、Apps Scriptへの書込、secret/token入力、pending sale queue再処理はなし。V1/staging JSONは移行に使わない。正本export/hash/revision/資産集計も未取得。
- 新アプリPR #105はdraft/未配備、進捗約25%。関連ローカルテスト28 passed、1 emulator test skipped。GitHub Actions v2-ci #701成功（head 72c714eb750e7ea7c4d1e5e1c5e38868218c95dd）。Scheduler routeと本番handler接続、通常Chat実接続、バックアップ復元、実課金計測は未完了。


### 2026-11-07 JST — Scheduler HTTP入口の安全な土台

- `/internal/scheduler/tick` を追加。認証関数とtick handlerが明示的に未設定なら無効のままにし、Cloud Scheduler markerと予定時刻を検査してから実行。失敗時は情報を漏らさず503を返して再試行可能にした。
- ローカル関連test 9件とaudit-tests 25件が成功。GitHub Actions v2-ci #703はtest/check、Firestore Emulator成功。PR head `de8e2fa560884bce60658da0cca89e3b648cbfc2`。
- 実行routeはまだCloud Run runtime・IAM/OIDC・Schedulerと接続していない。PR #105 draft/未配備、V2・Apps Script・queue・課金変更なし。


### 2026-11-07 JST — Scheduled job handler失敗の分離

- 全jobのhandlerを事前検証する実装では、Gmail handler未設定が同一tickのqueue処理まで止め得ることを発見。job単位でdispatchし、未設定jobは安全な失敗状態/heartbeatに記録しつつ、他jobを継続するよう修正。
- 関連test12件、全cloud test30件成功。ローカルではEmulator統合1件をskip。GitHub Actions v2-ci #706のtest/checkとFirestore Emulatorは成功。
- PR #105 head `8f4d0f61faffa52af9775fa156d2657510da1f55`、draft/未配備。実handler接続、V2正本取得、通常Chatの実接続は未完了。実システムへの変更なし。


### 2026-11-07 JST — Offline backup integrity and restore-preview foundation

- Added a versioned V2 backup artifact with canonical JSON SHA-256, a separate metadata hash, schema/revision checks, inventory cost/quantity validation, and a 7.5 MB fail-closed limit. Added a local-only CLI for create, verify, and restore preview. Creation refuses to overwrite an existing output and writes with owner-only permissions; input snapshots remain unchanged.
- Restore preview requires the observed current revision and returns only aggregate counts, total quantity, known acquisition cost, and unknown-cost lot count. It never applies a restore or exposes product names, transaction IDs, or lottery IDs.
- Focused backup and migration-report tests: 10 passed locally. GitHub Actions v2-ci #716 passed test/check and Firestore Emulator. Code head: `0bf32262cdd425cf559f9492d7567a857d49fd21`.
- This is an offline backup-file foundation, not automated/retained cloud backup or a restore drill. No canonical V2 export, Cloud storage, retention, automatic restore, production data, Apps Script, queue, or billing configuration was touched. Existing V1/staging candidates remain excluded; pending sale work was not replayed.
- Overall development estimate: about 30% (previously about 25%). The backup artifact and dry-run path are now implemented; authenticated regular-Chat integration, canonical V2 confirmation, live runtime/OAuth, scheduled backup retention and actual restore drill, monitoring, and cost measurement remain open. The requested 35% milestone is not yet reached.


### 2026-11-07 JST — Backup export path and isolated restore drill

- Added a create-once backup export task over the read-only canonical store contract. It checks snapshot/revision agreement, writes a deterministic date/revision/payload-hash key through an injected repository, reloads the object, and verifies its artifact hash and payload hash. Retry of the same daily snapshot is idempotent; storage mismatch fails closed.
- Added a local file repository and `backup-snapshot.js export` CLI path. Files use exclusive creation and mode 0600; newly created directories use mode 0700; unsafe keys and overwrite attempts are rejected. No Cloud storage provider is connected.
- Added an isolated Firestore Emulator drill that restores a synthetic chunked backup into a fresh test document and confirms revision, complete payload readback, and matching SHA-256. GitHub Actions v2-ci #729 passed test/check and Firestore Emulator. Backup-focused local tests: 8 passed. Code head: `129911336026aac176a5094e67252791488195de`.
- Overall development estimate updated from about 30% to about 35% because the backup path now has an executable export, create-once persistence contract, readback integrity checks, and an Emulator restore drill. This is not production operation. Cloud backup schedule/provider/retention, live canonical export, automated restore, regular Chat integration, OAuth/runtime wiring, monitoring, and cost measurement remain open. Production V2, Apps Script, existing queues, and billing were not changed; no pending sale work was replayed.


### 2026-11-07 JST — Market, Gmail scheduler binding, and queue health foundation

- Added a scheduled market-refresh worker using one injected batch lookup over positive inventory targets. It accepts only a nonnegative integer JPY price with a nonempty source; missing, duplicate, invalid, or failed results preserve the last confirmed price/source/time and mark the quote stale. Stable daily job keys prevent repeat provider calls after a committed mutation; V2 CAS save/readback is required. Bounded aggregate health metadata is written under `automation.health.marketRefresh`. No market source is configured and no live prices were requested.
- Bound the existing Gmail scanner to the scheduled hourly and result-focus job contracts. Hourly jobs use their planned time; the 12:30 result catch-up uses the actual trigger time as the query upper bound while keeping the stable daily ledger key. At 19:00 the hourly job remains one scan with result terms included. Gmail uses separate hourly/results checkpoints and a 50-message cap.
- Added a queue summary using two Firestore aggregate queries for pending/processing and review counts; it returns counts only. Unit tests and a real Firestore Emulator aggregate test cover the result.
- Local focused tests: market worker 5 passed, scheduled Gmail handlers 3 passed, queue summary 2 passed. GitHub Actions v2-ci #747 passed full test/check and Firestore Emulator. Code head: `a0d1575db56c0c54c7c02d58505c956a4eee2927`.
- Overall estimate updated from about 35% to about 50%: backup export/restore foundation, daily market transition, Gmail scheduled binding, and queue health aggregation now have executable tested paths. This remains pre-production code. Live Gmail OAuth, a confirmed market provider, Cloud Scheduler/runtime composition, regular Chat end-to-end, canonical V2 export/migration, complete alerting, backup retention/provider, and real cost measurement remain open. No production data, old V2, Apps Script, pending queue, or billing configuration was changed.


### 2026-11-07 JST — Cross-source business event deduplication foundation

- Problem: queue idempotency based only on requestId did not prevent the same lottery application from being submitted by Chat and Gmail under different request IDs.
- Added optional top-level businessEventKey to the command API. When supplied, the queue hashes the key and normalized command payload (excluding only requestId), then atomically creates a hash-only business-event index with the queue entry. A matching event returns accepted=false, duplicate=true, and the existing request ID; a key reused with different business data fails closed as business-event-collision (HTTP 409). Raw event keys are not persisted.
- Updated the Chat Action OpenAPI contract and server response to distinguish cross-source duplicates from newly accepted commands and requestId replays. Requests without a reliable key continue to use requestId idempotency only; no key is inferred from ambiguous evidence.
- Local targeted run: 13 passed, 1 Firestore Emulator test skipped because no local emulator was running. GitHub Actions v2-ci #749 passed test/check and Firestore Emulator, including the concurrent two-source enqueue test. Code commit: 2c5faf7d7c0cf5e6cbfcb4893384da1680481c2f.
- Overall estimate: about 52% (rough implementation/tested-path estimate), not production readiness. The Gmail classifier and Chat normalizer do not yet derive/share a common key; no live end-to-end run was done. Business-key retention/cost are unmeasured. PR #105 remains draft/unmerged/undeployed. No production V2, old Apps Script, existing queue, pending sale item, or billing configuration changed.


### 2026-11-07 JST — Lottery identity resolution and scheduled backup foundation

- Added a shared lottery business-key builder from event kind, canonical retailer key, and an explicit external application ID. It NFKC-normalizes stable retailer spelling, hashes the complete identity, and returns only the hash key. Missing/invalid identity yields a review result with no key. The API maps lottery application/result/receipt command types to the event kind, derives the same key server-side, and rejects identity fields on unsupported command types. No raw external ID is written into the queue index.
- Added a proposed, not deployed, daily canonical-backup job at 02:00 JST. A later 15-minute tick retries the same date key until the durable ledger records completion; successful daily keys are suppressed. Added a backup handler that validates the scheduled slot and integrity receipt from the existing create-once export task. It still requires a persistent repository/provider and runtime handler wiring before deployment.
- Focused local verification: 33 tests passed, including Chat API identity derivation, missing-ID review, normalization, daily schedule recovery, ledger suppression, and backup receipt validation. GitHub Actions v2-ci #751 passed the full test/check and Firestore Emulator jobs. Code commit: 99ef62c699b21a00ff076eae83a2ca0a17df63c7.
- Overall estimate updated from about 52% to about 60%, based on tested code paths; this is not production readiness. Gmail does not yet extract a confirmed application ID or provide the same retailer key, so cross-source deduplication remains unverified end to end. Backup storage, retention, and recovery against production data are unconfigured. Regular Chat end-to-end, canonical V2 export/migration, OAuth, deployed Scheduler/runtime wiring, complete alerting, and real cost measurement remain open. PR #105 stays draft/unmerged/undeployed; no production data, Apps Script, existing queue, pending sale item, or billing configuration changed.

## 2026-11-07 — Conservative cross-source lottery ID extraction (CI #755)

- Reused draft PR #105 and added `cloud/src/lottery-source-identity.js`: pure Gmail identity resolver for explicit externally issued lottery application IDs plus retailer names marked by labels. Retailer aliases must be allowlisted and mapped to a canonical retailer key; no guessing from product, sender, date, or unlabelled numbers. NFKC/whitespace normalization feeds the existing shared hashed business-event key builder.
- Missing/unknown/conflicting retailer aliases or application IDs return review-only results without any event key. No raw Gmail body/application ID appears in the resolver output. The parser is intentionally not connected to the production Gmail scanner/queue.
- Added `cloud/test/lottery-source-identity.test.js` (9 tests): Chat screenshot-confirmed key equals Gmail extracted key, event kind separation, repeated labels, missing/unknown/conflicting identity, invalid/oversized mail, privacy, synthetic shared-key queue duplicate suppression, and conflicting business payload fail-closed. `cloud/package.json` now runs the new test and syntax-check.
- Local extraction-only tests: 7 passed before adding the two queue-integration cases. GitHub Actions v2-ci #755 (head `d5041a025657a7617f7127c865e7ef0fed5134a8`) passed `test` (npm test and check) and Firestore Emulator jobs, including the new queue-integration tests. This is mock/Emulator verification, not live Gmail or Chat E2E.
- Progress stays approximately 60% as a rough implementation/test estimate, not production readiness. Gmail identity resolver is not attached to the live classification-to-command path. Retailer aliases for real stores and the durable enqueue/settlement handoff must be reviewed before activating; different business command payloads sharing one event key correctly produce review/collision, not silent merge.
- Still missing: normal Chat action live integration, Gmail OAuth/live inbox, Cloud Scheduler/Cloud Run runtime handlers, confirmed market provider, canonical V2 read-only export and migration audit, persistent cloud backup/retention/restore drill, monitoring and measured free-tier usage. V2 canonical identity still unknown; V1/staging is not an import source.
- No live Cloud Run/Firestore, Gmail, old V2, Apps Script, existing queue/pending sales, billing, deletion, merge, or production cutover changes. PR #105 remains draft/unmerged/undeployed. Next: documented real retailer alias fixtures (sanitized), review-safe durable Gmail-to-command outbox, mocked E2E including crash/retry, then disabled-by-default runtime/OAuth wiring.


## 2026-11-08 JST — Durable backup storage adapter and retention proposal; about 70%

- Added a Cloud Storage repository adapter for the existing verified create-once backup export contract. Keys are limited to the generated `v2/YYYY-MM-DD/revision-<n>-<sha256>.json` namespace; uploads use the generation-match-zero precondition so an existing live object is never overwritten. A precondition conflict is treated as an idempotent duplicate. Uploads carry content type, schema marker, and SHA-256 metadata; reads enforce the 7.5 MB artifact bound. Cloud Storage SDK/runtime wiring is intentionally not included.
- Added `cloud/backup-lifecycle-proposed.json`, a reviewable 90-day delete rule limited to the `v2/` prefix. It is a proposal only and has not been applied to any bucket. Daily backup remains unconnected to a persistent destination and has not run against canonical production data.
- Tests cover create-once/precondition behavior, SHA-256 metadata, readback, key/size rejection, and the limited lifecycle scope. Local full suite on the working tree: 138 passed, 0 failed, 1 Firestore Emulator test skipped because no local emulator was configured; `npm run check --prefix cloud` passed. GitHub Actions v2-ci #758 passed on PR head `10f38a2cf2e21edf03913af02799f3ed115d7975`.
- Overall development estimate updated from about 60% to about 70%, reflecting the additional tested backup storage/retention path foundation. This remains a rough implementation estimate, not production readiness or a percentage of live operation.
- Cost/free-tier: Cloud Run published free usage is shared by project and requires an active billing account for use; overages are billable. Cloud Storage's published always-free Standard allowance is restricted to three US regions, so a Japan-region bucket would not receive that storage allowance. Standard storage is the proposed class because daily backups need straightforward verification/recovery; actual bytes, request volume, network costs, region-specific estimate, and project-wide free-tier fit remain unmeasured. No billing setting was enabled. Sources: [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Storage pricing](https://cloud.google.com/storage/pricing).
- V2 canonical JSON: still unavailable/unverified. No Drive V1 or staging JSON was used. No production data, Apps Script, queue, pending sale, Cloud resource, or billing setting was changed; no deploy, merge, cutover, or old-system shutdown occurred. PR #105 remains open, draft, unmerged, and undeployed.
- Still open: normal Chat-to-command live path and screenshot E2E; real Gmail/Chat common-key E2E and durable review-safe outbox; live Gmail OAuth; Scheduler/runtime production composition; confirmed market source; canonical V2 read-only export and migration reconciliation; persistent backup configuration/retention decision and production-data restore drill; monitoring/alerts and measured costs.
- Next: build a mocked crash/retry-safe Gmail classification-to-command outbox and connect the regular Chat Action path end to end in isolated tests; then propose disabled-by-default authenticated Cloud Run composition. Keep the GCS lifecycle unapplied pending explicit retention/location/cost review.


## 2026-11-08 JST — Gmail command outbox and cross-source retry safety; about 80%

### Implemented

- Reused PR #105. Added a Firestore-backed Gmail command outbox and optional composition point in the classifier processor. For explicitly complete commands, it writes a durable outbox record before queue submission. The requestId is stable and derived from the SHA-256 of the Gmail message ID; raw message IDs and mail text are not persisted by the outbox.
- The outbox derives the same business-event key from explicit retailer key/application ID as the Chat API. If required command fields or identity are missing, it records a compact review state and does not queue. Queue payload conflict also routes to review.
- Queue delivery happens after the durable outbox write. If the process fails after queue acceptance but before marking the outbox submitted, retry resends the same requestId and business key; the queue’s existing idempotency/business-event index suppresses a second mutation.
- buildCommandDraft is an optional injected pure composition point. This change does not add real Gmail field extraction for title/date/target lottery, retailer alias deployment, Gmail OAuth, or production runtime wiring; without a complete explicitly constructed draft, the item remains review-only.

### Verified

- Added tests for crash after queue acceptance and retry, missing identity/fields to review, processor-to-outbox ordering, no persistence of raw message ID or email body, queue collision, and Chat/Gmail same business key under different request IDs.
- Focused local tests: 5 passed. Working-tree full suite: 143 passed, 0 failed, 1 skipped because local Firestore Emulator was not configured. npm run check --prefix cloud passed.
- GitHub Actions v2-ci #762 passed on code head f4985cf20c77f30305a0f474e9ebaecc08add436.

### Not yet verified / next

- This is mocked/Firestore-adapter test coverage, not live Gmail, Chat Action, or Cloud Run E2E. The classifier’s real-to-command builder, reviewed retailer alias configuration, and review inbox/monitoring are not connected. Regular Chat Action API/schema already exists but no deployed endpoint or screenshot report E2E is available.
- Remaining: live Gmail OAuth, authenticated and deployed Cloud Run/Scheduler composition, confirmed market provider, canonical V2 read-only export and migration reconciliation, persistent backup bucket/location/retention decision and production restore drill, operational alerts, and measured project-wide cost/free-tier fit.
- V2 canonical JSON is still unavailable; V1/staging is excluded. No production V2, Apps Script, existing queue, pending sale, billing setting, cloud resource, or deployment changed. PR #105 remains open, draft, unmerged, and undeployed.
- Overall progress estimate updated from about 70% to about 80%; this is a rough implementation/test estimate, not production readiness. Confirmed Gmail schedule (07:00–24:00 JST hourly, 12:30 focus, 19:00 merged), independent 15-minute Chat queue, and daily 13:30+ market schedule are unchanged. The 90-day GCS lifecycle remains an unapplied proposal.
- Next: add a conservative, tested Gmail command-draft builder for only explicitly labelled fields; missing/ambiguous evidence must stay in review. Then compose and test the disabled-by-default Chat Action + Gmail + queue path. Do not enable OAuth, billing, production queues, or lifecycle policy in this phase.



## 2026-11-08 JST — Gmail outbox privacy and ambiguity guard follow-up

- Tightened the optional Gmail command builder boundary after code review: the outbox now reconstructs commands from a type-specific allowlist. Unknown properties (including body/raw mail fields or caller-supplied requestId), conflicting title/product values, control characters, oversized strings, and malformed optional dates send the item to review without queue submission or persistence of the rejected fields.
- Focused outbox tests: 7 passed. Working-tree full suite: 145 passed, 0 failed, 1 skipped without local Firestore Emulator. Syntax check passed. GitHub Actions v2-ci #765 passed on code head b73951fc0a5fd99f8da5143eaf5a4573110ddbb7.
- Remaining functional gap: review states are safely retained, but a review inbox and explicit user-confirmation-to-command flow are not implemented or connected. This and the live Chat/Gmail/Cloud Run path remain product-completion work. Progress estimate stays about 80%; the estimate is not a production readiness claim.



## 2026-11-08 JST — Labelled Gmail command builder and Chat/Gmail mock E2E; about 90%

### Implemented

- Added a conservative Gmail lottery command builder for only explicit labelled fields: external application ID, allowlisted retailer name, product, and ISO date; result status/date are also required for results. It does not infer from sender, product codes, unlabelled numbers, message timestamps, or surrounding prose. Conflicting/missing labels, unknown store aliases, malformed/oversized data return no draft and stay in review. The builder emits only the command fields needed by V2; outbox applies its own command allowlist.
- Added a mocked end-to-end test: a regular Chat Action HTTP request submits a lottery application, then the Gmail classifier/parser/outbox sees the same explicit event under a different Gmail ID and is suppressed by the same business-event key. This is isolated HTTP/mock coverage, not an actual ChatGPT screenshot or live network connection.
- Added an opt-in Firestore Emulator test for concurrent outbox create-once calls, readback, hashed message ID, and submitted-state update.

### Verified

- Focused builder/outbox tests: 12 passed. Working-tree full suite: 150 passed, 0 failed, 2 skipped locally because no Firestore Emulator was configured. Syntax check passed.
- GitHub Actions v2-ci #769 passed, including full test/check and Firestore Emulator jobs. Code head: `63f34b818a4671040b873b7f2a872a4febe86364`.

### Remaining / completion gates

- Overall progress estimate updated from about 80% to about 90%; this remains implementation/test coverage, not production readiness. Real store aliases and Gmail templates have not been reviewed against actual messages. Result commands still depend on the V2 worker finding exactly one matching lottery row; otherwise the existing worker must leave them in review.
- Normal ChatGPT Action is not deployed or configured. Screenshot interpretation, actual endpoint/auth, live Gmail OAuth, Cloud Scheduler/runtime composition, review inbox and explicit review-resolution flow are unverified/unimplemented. No command is being registered automatically from this ordinary Chat session.
- Canonical V2 JSON remains unavailable; no V1/staging source is used. Migration reconciliation, persistent Cloud backup connection/retention application/restore drill, confirmed market provider, operational alerts, and project-wide cost measurement remain open. GCS lifecycle remains unapplied. No production data, Apps Script, pending queue, Cloud resource, billing setting, deployment, or cutover changed.
- Reaching production completion requires owner-side access to export the configured canonical V2 JSON read-only, reviewed store aliases and representative sanitized Gmail templates, plus approval before any billing/project activation. Do not send tokens or secrets in chat.
- Next safe step: test the strict builder against sanitized, real retailer mail formats and add an explicit review resolution path. Then prepare disabled-by-default Cloud Run composition and a reviewable setup/cost plan before any external activation.


## 2026-11-08 explicit Gmail review approval path (~92% implementation/test estimate)

- Added a code-only outbox review resolution method. It requires an explicit `confirmed: true`, a current review payload hash (optimistic concurrency), complete validated command fields, and explicit retailer/application identity. Firestore atomically transitions only the unchanged `review` row to `ready`; delivery uses the original stable Gmail request ID and shared lottery event key. Missing, stale, already-submitted, malformed, or conflicting states fail closed.
- The path is not exposed as an HTTP endpoint and has no review UI or owner authentication integration. It is a library method exercised with a fake Firestore store. It is not safe to present as a user-facing approval flow yet.
- Focused Gmail outbox tests: 9 passed. Full local cloud suite: 151 passed, 0 failed, 2 Firestore Emulator tests skipped without local Emulator; `npm run check --prefix cloud` passed.
- Gmail OAuth/live retailer templates, Chat Action deployment, Cloud Run auth/runtime, review UI and authorization, canonical V2 export, deployed backup storage/restore, and measured operating cost remain unverified. No V2 data was read or changed; billing, production deployment, and cutover remain untouched. PR stays Draft, unmerged, undeployed.


### CI follow-up
- Hashed-reference version of the review resolver passed GitHub Actions v2-ci #774 on commit `43d40d3a5acacfc813e3a1a5318fff444b11e5b2`, including the Firestore Emulator job. This remains code/CI validation only; no live review authorization or runtime connection.


### Free-tier review (2026-11-08; official pricing pages)
- A single default Firestore Standard database has a free allowance of 1 GiB stored, 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day, and 10 GiB outbound/month. Firestore managed deletes/TTL, PITR, backups, and restores are billed features and require billing.
- Cloud Run request-based allowance includes 2 million requests/month plus CPU/RAM allowances; it is a billing-account-level allowance, not a guarantee of zero cost. Cloud Scheduler provides 3 free jobs/account/month; one dispatcher job fits the job count.
- Cloud Storage Always Free storage applies only in US-WEST1, US-CENTRAL1, US-EAST1, so a Japan-region backup bucket is outside that free storage allowance.
- This is quota fit, not a cost forecast. Actual Firestore operations, dataset size, logging/egress, and backup/restore cost are unmeasured; no billing setting or resource was enabled. Sources: https://cloud.google.com/firestore/quotas ; https://cloud.google.com/run/pricing ; https://cloud.google.com/scheduler/pricing ; https://cloud.google.com/storage/pricing


## 2026-11-08 bounded command worker and verification (~94% implementation/test estimate)

- Added a bounded Firestore pending-command page and Cloud Run `POST /internal/worker/commands` route. Each tick processes up to 10 commands by default (hard cap 50), using existing lease claims, V2 revision CAS, readback verification, and queue settlement. The route requires separate worker authorization, Cloud Scheduler headers, and explicit V2 writes + command queue enablement. Production startup rejects worker enablement unless both write and queue flags are explicitly true; all flags default off.
- Added unit/API coverage and a Firestore Emulator queue-page test. Focused local tests: 20 passed. Full local cloud suite: 155 passed, 0 failed, 4 skipped without Emulator; `npm run check` passed. GitHub Actions v2-ci #782 passed on code commit `ac805f49ba964e7f770f26091627e970f7229e4c`: 415 tests, 407 passed, 0 failed, 8 skipped; Firestore Emulator job succeeded.
- Added setup notes to `cloud/README.md`. This is not an active 15-minute schedule: Cloud Scheduler job, Cloud Run deployment, Secret Manager binding, regular ChatGPT Action registration, live Gmail OAuth/runtime, and complete dispatcher wiring remain unconnected. Do not enable the worker before canonical V2 import and verification.
- No V2 source was retrieved or changed, no pending sale queue was replayed, and no billing, production resource, deployment, or cutover was enabled. PR #105 remains Draft, unmerged, undeployed. Progress remains an implementation/test estimate, not production readiness.


### ChatGPT conversation integration gate (2026-11-08)
- The current OpenAI connection is only a backend API and a GPT Action OpenAPI template; ordinary Chat does not call that endpoint automatically.
- OpenAI’s current Help Center says personal Free/Go/Plus/Pro accounts cannot create or publish new GPTs. Existing GPTs may remain usable/editable if they already exist and account permissions allow, but none has been connected or tested here. Custom MCP write/modify support is currently documented for Business/Enterprise/Edu; Pro custom MCP is read/fetch only. Therefore a Plus account has no documented self-serve custom write MCP route at this time.
- The Apps SDK public directory route is a separate possibility, but it requires building and submitting an app for review, public hosting, privacy/auth design, and user installation. No public app submission or publication is authorized or performed.
- This is a product/connection blocker, not a backend test failure. Before the user goal can be called complete, there must be a supported ChatGPT integration installed and an end-to-end test from a normal conversation with text and screenshot reports. Official references: https://help.openai.com/en/articles/8554397-creating-and-editing-gpts ; https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt ; https://help.openai.com/en/articles/12515353-building-with-the-apps-sdk


### Final verification checkpoint (2026-11-08)
- Latest worker code commit `2e4c32a7f3e9102a71d4a42c9a2ef6a26b350dcf` passed v2-ci #785: 416 tests, 408 passed, 0 failed, 8 skipped; Firestore Emulator job passed. Local cloud suite: 156 passed, 0 failed, 4 skipped without local Emulator; `npm run check` passed.
- Latest handoff/document commit `a658c17ca52e24e56698edef187e111a524f77d3` passed v2-ci #786. This is documentation validation only.
- Current estimate remains ~94% of implementation/test work, not production readiness. Normal ChatGPT write integration, V2 canonical export, billing approval, deployment/runtime connections, backup restore drill, and measured spend remain gates.

### 2026-11-08 JST — Command worker Scheduler認証をOIDC化

- `TV2_WORKER_TOKEN` の共有Secret方式を取り除き、Google `OAuth2Client.verifyIdToken` で署名済みID tokenのaudienceを検証し、設定済みScheduler service account emailとemail_verifiedも照合する認証middlewareを追加。token欠落・署名不正・audience/identity不一致は拒否する。Cloud RunサービスURLと専用Scheduler service accountは識別情報で、Secretではない。
- workerは引き続き既定無効。worker/queue/writeの3 flag、Scheduler marker/予定時刻、既存canonical stateと各IAM設定の確認が必要。`roles/run.invoker`付与、Scheduler作成、deploy、課金設定は実施していない。
- 検証: ローカル `npm test --prefix cloud` 160 passed、0 failed、4 skipped（local Firestore Emulator未起動）。`npm run check --prefix cloud`成功。PR #105への反映後、v2-ci #791のtest/checkとFirestore Emulator jobがsuccess。
- 進捗概算は約94%の実装・テスト作業で据置。これは本番readinessではない。通常Chat書込統合、V2正本export/migration、Gmail OAuth/実接続、Cloud Run/Scheduler本番配備、backup保持/production restore、障害通知、利用量と費用の実測、ユーザー承認が必要な本番移行は未完了。V2正本JSONは未取得。無料枠適合と実費は未測定。既存V2/Apps Script/queue/売却保留/課金設定に変更なし。

### 2026-11-08 JST — Gmail identity一致ゲートとFirestore Emulator cross-source E2E

- Gmail classifier processorは、共有identity resolverとfield-to-command builderの `retailerKey` / `applicationId` が両方一致した場合だけoutboxへ送る。片側の別名設定や抽出結果が食い違う場合はcommandをnullにしてreviewへ送る。
- 合成データのFirestore Emulator testでChat HTTP endpointが先に応募を受け付け、その後Gmail classifier→builder→outboxから異なるrequestIdで同一応募を送ったとき、Firestore上のcommand本体とbusiness-event indexが各1件であることを確認。ID欠落と同一キー・異なるcommand内容もreview/collision扱いで検証した。
- 検証: ローカル cloud suite 161 passed / 0 failed / 5 skipped（local Emulatorなし）、check成功。GitHub Actions v2-ci #796のtest/checkとFirestore Emulatorがsuccess。Emulator内の該当統合testはpass、0 skipped。
- Live Gmail/OAuthからの呼出、通常Chatとの実接続、production Cloud Run/Scheduler、V2正本export/migration、backup保持とproduction復元、監視/費用実測は未完了。V2正本未取得。進捗約94%は実装・テストの概算で本番readinessではない。既存V2、Apps Script、現行queue、売却保留、課金設定に変更なし。

### 2026-11-08 JST — Google Cloud無料枠/backup費用の公式確認

- 現行Google公式料金表: Firestore Standard無料枠は1 GiB、50,000 reads/day、20,000 writes/day、20,000 deletes/dayだが、Backup/Restore/PITR/TTLは無料利用対象外で課金有効化が必要。Cloud Runの公表無料枠は月2M requests等、Cloud Schedulerはbilling accountごと3 jobs/month。1件のdispatcher jobはjob数の無料枠内だが、全体無料を保証しない。
- Cloud Storage Always Freeは標準storage 5 GB-months等だがUS-WEST1/US-CENTRAL1/US-EAST1限定。Tokyo/Osaka bucketはこの無料保存枠対象外。したがって日本リージョンの永続backupは無料前提にできず、Firestore managed backup/restoreも課金なしでは使えない。
- 実データ容量・実API利用量・既存billing accountの使用量が未確認で、実月額は未算出。billingは有効化しておらず、backup保存先・保持日数・削除lifecycleも確定/適用していない。90日削除ポリシー等は承認前に適用しない。
- Official sources: https://cloud.google.com/firestore/pricing ; https://cloud.google.com/run/pricing ; https://cloud.google.com/scheduler/pricing ; https://cloud.google.com/storage/pricing

### 2026-11-08 JST — Gmail頻度とGoogle Drive backup費用の評価（検討中）

- 確定済みGmail予定（07:00〜24:00 hourly、12:30重点確認、19:00は毎時scanへ統合）は変更していない。実装上の15分dispatcherはGmail以外にcommand queueも扱うため、Gmail scanを減らしてもdispatcherのCloud Run起動回数は減らない。Gmail API標準利用は追加料金なしで、現行新quotaのdaily threshold 80,000,000 units/day未満は追加料金なし。仮に19 scan/day、各scanがlist 1件 + 最大50件の`messages.get`をfull相当60 unitsで取得しても約57,095 units/day。これは概算で実測ではなく、projectの作成年/2025-11〜2026-04 API利用有無で適用quotaが変わる。Hourly設定を落としてもCloud請求アカウント要件は解消しない。
- Google Driveの既存ユーザー領域は最大15 GBでGmail/Drive/Photos共有。標準Drive API利用は通常追加料金なしのため、空きがありユーザーOAuthで書ける場合、既存Drive folderをbackup先にする案はCloud Storage Japan regionより保存料を抑えられる候補。OAuth scopes/Drive API quota/利用可能容量は未確認。
- Driveのcreate-onceを維持する候補設計: `files.generateIds`のIDをFirestoreのstable backup-key registryへtransactionalに保存し、そのIDでDrive fileを作成。競合/再試行は同じIDの409とSHA-256 readbackで照合。Firestore registryは引き続きGoogle Cloudサービスなのでactive billing account要件が残る。Firestore managed Backup/Restore機能は利用せず、application-generated JSON backupをDriveへ保存する案。
- Google Cloud projectはactive Cloud Billing accountへリンクしないと、free tier範囲だけの利用でもGoogle Cloud resourceを使えない。従って「利用料0円の可能性」と「課金を有効にしなくても動作」は別。現在billingは未有効化。GCS Japan保存、retention period、自動削除lifecycle、Drive接続はいずれも未設定。
- Status: Drive案は検討中、仕様変更/実装/接続/削除なし。保持容量を超えた場合の扱いと保持期間は未決定。Sources: https://developers.google.com/workspace/gmail/api/reference/quota ; https://developers.google.com/workspace/drive/api/guides/limits ; https://developers.google.com/workspace/drive/api/guides/create-file ; https://support.google.com/drive/answer/9312312 ; https://docs.cloud.google.com/billing/docs/how-to/manage-billing-account


### 2026-11-08 JST — Drive backup adapter prototype (unconnected)

- Added an optional Google Drive backup repository candidate plus a Firestore transactional stable-key → generated Drive file ID registry. Retries reuse the reserved ID; an existing file is accepted only when the key hash and payload SHA-256 match. Readback verifies payload bytes/hash, and payload size is bounded at 7.5 MB.
- Verification: local cloud suite 166 passed, 0 failed, 5 skipped (local Firestore Emulator is unavailable); `npm run check --prefix cloud` passed. PR #105 v2-ci #803 passed both the full test/check job and the Firestore Emulator job, including the concurrent registry reservation test.
- This is an unconnected candidate implementation. It is not wired to backup export or runtime, and has not been tested against Google Drive API/OAuth. No Drive folder, OAuth grant, retention, or deletion lifecycle was configured; no backup data was written. Existing backup location and Gmail schedule are unchanged.
- Progress remains about 94% implementation/test work, not production readiness. The V2 canonical export remains unavailable/unverified. Production authentication/runtime, normal ChatGPT intake, live Gmail/OAuth, recovery drill, monitoring, cost measurements, billing approval, and migration validation remain outstanding.
- Cost note: Drive may use available user storage quota, but Cloud Run/Firestore still require an active billing account linked to the project. No billing configuration was enabled and actual free-tier fit remains unmeasured.


### 2026-11-08 JST — scheduler health route and regular ChatGPT integration gate

- Wired `GET /health/scheduler` to the Firestore scheduler-heartbeat store in the Cloud Run startup path. It returns only bounded timestamps/counts; it returns 200 only for a fresh heartbeat with zero missed slots and zero failed jobs, and 503 for missing/stale/inconsistent/unavailable health. It does not expose command, email, or raw error data.
- Local verification: API tests 14 passed; full cloud suite 167 passed, 0 failed, 5 skipped without local Emulator; `npm run check --prefix cloud` passed. PR #105 v2-ci #806 passed both test/check and Firestore Emulator jobs. The route is implemented, but the live dispatcher/Scheduler is not configured, so no operational heartbeat exists and the health route should remain 503 until a real dispatcher is connected.
- Read-only Drive search for a current V2 JSON/export found only the handoff document. The canonical V2 JSON remains unavailable/unverified. No old schemaVersion 1 or unverified staging JSON was opened or used.
- Current OpenAI product documentation changes the feasible regular-Chat connection path: personal ChatGPT Plus accounts cannot create/publish new GPTs; existing GPTs may remain usable under account rules. Custom MCP write connections are documented for Business/Enterprise/Edu workspaces. The public plugin directory accepts remote MCP apps, but requires a stable public HTTPS endpoint, verified developer identity, and review. No app was submitted, published, or connected. This is a feasibility update, not a change to the requirement that ordinary ChatGPT must support text/screenshot reporting.
- Operational blockers remain: confirmed V2 canonical export, Cloud billing approval and deployment, live OAuth/provider connections, public ChatGPT integration publication/installation, scheduled handler composition, backup retention and restore verification, alerts, and measured usage/cost. No billing, production data, V2, Apps Script, Scheduler, or Drive destination was changed.
- Official product references: https://help.openai.com/en/articles/8554407-what-are-gpts ; https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt ; https://developers.openai.com/plugins/deploy/submission ; https://help.openai.com/en/articles/12515353-building-with-the-apps-sdk


### 2026-11-08 JST — ChatGPT MCP authentication requirement clarified

- Current OpenAI authenticated MCP guidance requires an OAuth 2.1 authorization flow for write-capable/customer-specific tools and states ChatGPT cannot present custom API keys. The existing Cloud Run REST bearer token therefore cannot be reused as the ChatGPT app connector credential. No OAuth authorization server/provider has been selected or implemented.
- The public plugin directory remains a possible regular-Chat path, but it requires the remote MCP endpoint, OAuth flow, verified developer identity, and submission review. This is not a change to the user requirement; it is a newly confirmed product authentication gate. Do not publish or enable write access until the OAuth design, deployment, canonical data, and reviewable permission scope are ready.
- Official reference: https://developers.openai.com/plugins/build/auth


### 2026-11-08 JST — 通常Chat未登録2件の読み取り専用照合

- 通常Chatの報告内容を確認したが、Chat→新アプリqueueには送信されていない。V2にも反映されていない。①11/6 30th CELEBRATION 1BOX、イトーヨーカドー アリオ八尾店、シュリンク付き、原価7,200円（支払7,205円から袋代5円除外）。②11/7 ORIGINAL ARTWORK DUEL SET 3種類各1個・合計1セット、過去支払済みで新規原価なし。
- ユーザーがV2アプリ画面の「V2正本を書き出す」から出力したsnapshotをread-only確認。schemaVersion 2、revision 2708、exportedAt 2026-11-08 17:39 JST、SHA-256 `930bb73fca5c9d8145cf78008dc7595b01985565d4bccc646cad930d2ec70b88`。画面表示はrevision 2709のため、snapshotは画面より1 revision古い。
- revision 2708のtransactions/inventoryLotsに2件と一致する記録なし。類似名称「オリジナルアートワークコレクション 1BOX」の抽選応募3件は別記録として扱い、DUEL SETと自動同一視しない。
- 既存Google Sheets Command Queueを読み取り専用で確認し、9行中8行が保留売却、1行が抽選。今回の2件に一致する行なし。Queueは一切変更せず、保留売却を再投入していない。
- 現行migration validatorはBOX condition「シュリンクなし」で失敗。canonical exportの誤りではなく、新アプリ側の値互換性不足。原本JSONは変更していない。原価不明の在庫4ロットは推測補完しない。
- 状態: 報告内容確認済み / queue送信なし / V2反映なし / 登録後の正本再読込検証なし。read-only exportのみ検査済み。Cloud Run queue実接続は未完了であり、旧V2直接書込みは禁止。
- 登録案: 30thはpurchase commandにできるが、live queueがないため未送信。DUEL SETは汎用のreceipt-only/no-new-cost commandが未実装。0円purchaseで代用せず、原価二重計上を防ぐ受取専用処理を設計する。revision 2709以降の再export・二重登録確認・登録内容提示とユーザー承認を経るまで登録しない。
- Overall estimate remains approximately 94% implementation/test work, not production readiness. No production, Apps Script, V2, queue, billing, deployment, or cutover changes.


### 2026-11-08 JST — V2エクスポート形式の検証と互換性修正

- `v2/core.js` が既存BOX状態「シュリンクなし」を有効値として許容するよう修正。値の書換えや正規化はせず、元データ表記を維持する。
- `inspectV2Snapshot` がV2アプリのエクスポート外枠（app/schemaVersion/exportedAt/revision/data）を読み取れるよう修正。外枠とpayloadのrevision不一致は拒否し、SHA-256はJSON出力ファイル全体を対象に計算する。エクスポート形式、原本ハッシュ、revision不一致、既存BOX状態をテスト。
- GitHub Actions v2-ci #810 は npm test、npm run check、Firestore Emulator jobがすべて成功。code head: `57463dcb7f39c19f0491cabe7744feb9fd14468b`。
- 適用結果: ユーザーのV2アプリ画面から出力されたschemaVersion 2 / revision 2708 JSONをread-only検証。SHA-256 `930bb73fca5c9d8145cf78008dc7595b01985565d4bccc646cad930d2ec70b88`、sourceBytes 1,341,567、取引97（購入56/売却34/開封7）、在庫32ロット・数量37、抽選517、相場25、監査2,728。画面表示はrevision 2709で、JSONは1 revision古い。
- Firestore保存見積りはpayload 1,036,003 bytes。単一document安全上限900,000 bytesを超えるためchunked-v1 5 segment（基準13 reads/6 writes per successful mutation）を選択。payload size/segment limits内で安全計画可能。これは設計見積りで実測費用ではない。原価不明lot 4件は推測補完しない。
- 既存Sheets queueは9行（未処理売却8、抽選1）、今回2件と一致なし。似た名称の「オリジナルアートワークコレクション 1BOX」抽選応募3件はDUEL SET受取と別扱い。
- 通常Chat報告は確認済みだが、新アプリqueue送信なし、V2反映なし、登録後readbackなし。新アプリAPI/Cloud Runは未配備、旧V2書込みと未処理売却再投入なし。受取専用（原価を二重計上しない）一般commandは未実装。通常Chat連携とreceipt-only設計が次工程。PR #105はDraft・未merge・未deploy。


### 2026-11-08 JST — 通常Chat接続の公開Plugin経路（検討中）

- 新規GPT作成や個人用の直接MCP接続を前提にせず、ChatGPTの公開Plugin／アプリディレクトリから通常Chatへ接続する経路を候補として調査した。公開PluginはChatGPTのモバイルでも利用できる設計だが、個々のPluginの提供プラン・画面は異なるため、PlusのAndroidでの利用可否は公開候補の実機テストで確認する。
- 公開には安定した公開HTTPS MCP endpoint、OAuth 2.1 user authentication、開発者本人確認、公開レビュー、モバイルを含む動作テストが必要。既存RESTのBearer API tokenはChatGPTの公開MCP認証として流用しない。OAuth providerは未選定。
- 現時点は「候補・未実装・未検証」。公開申請、公開、配備、本番データ接続、課金設定の有効化は行っていない。API queue/worker/write flagsも有効化しない。
- 次工程: 既存Cloud Run APIに対する独立したMCP/OAuth adapter案、ローカル/CI mock E2E、公開審査要件一覧を作る。安全なステージング接続と費用・billing案をレビュー可能にしてから、必要な承認を得る。
- 旧V2書込み、売却queue再投入、本番切替は禁止。通常Chat未登録の2件は確認済みだがqueue送信なし/V2反映なし。JSONはrevision 2708で画面revision 2709より古く、移行には2709以降の正本再出力が必要。
- Official refs: https://help.openai.com/en/articles/20001256-plugins-in-chatgpt ; https://developers.openai.com/plugins/build/auth ; https://developers.openai.com/plugins/deploy/app-review ; https://developers.openai.com/plugins/plugin-guidelines


### 2026-11-08 JST — 通常Chat入力の短期ブリッジ候補（Google Driveアプリ＋専用受付シート）

- 公開Pluginの審査/OAuth準備とは別に、ChatGPT標準のGoogle Driveアプリが通常会話でGoogle Sheetsの更新を許可する場合、専用受付シートを新アプリのinput bridgeにする候補を評価する。OpenAIの現行ヘルプはGoogle Sheets/Docs/Slidesのソース更新を説明しているが、個々のactionはプラン・権限・surfaceに依存する。
- 使用する場合も既存V2 Command Queue、V2 JSON、Apps Scriptには書き込まない。新アプリ専用sheetに未処理報告を置き、Cloud Runのread-only readerが検証・idempotent Firestore enqueueを行い、処理結果を専用sheetへ記録する設計候補。
- Plus AndroidでGoogle Sheets更新actionが利用可能か、行追加と読み戻しまでの通常Chat E2Eは未確認。サービスアカウント共有、Cloud Run課金、表の書込範囲、保持・削除方針も未決定。この方式を確定仕様とはしない。
- 次: row parserとpoll result→Firestore queue importerを副作用のないpure function/adapterとしてテストする。受取専用・原価なしはpurchaseに変換しない。OAuth / public MCP案は審査準備を要する代替候補として保持。
- No production sheet/resource was created or modified. Billing, old V2, old queue, cutover remain unchanged.
- Official reference: https://help.openai.com/en/articles/10929079-google-drive-app-and-setup-in-chatgpt ; https://help.openai.com/en/articles/20001256-plugins-in-chatgpt


### 2026-11-08 JST — Google Sheets専用受付worker実装

- 専用sheet `Toreca Vault New App Intake` のstatus=`new` 行を最大20件読み、Firestore create-once queueへ渡すprocessor/providerと、Scheduler OIDC認証付きworker routeを実装。受付内容A:Cは変更せず、結果のみD:Gへ記録する。抽選イベントの応募IDまたは店舗キー不足・不確実時は`review`。Chat/Gmailで異なるrequestIdでも明示情報から同じbusinessEventKeyを作る。
- テスト: `npm run check --prefix cloud`成功、cloud suite 180成功/0失敗/5件Emulator未実行（local Emulator未設定）。live Sheets/ChatGPT Android/Cloud Run/Scheduler/OAuthは未接続。
- Runtime flagsはすべて初期無効。production sheetやservice account grant、billing、deploymentは作成・変更なし。通常Chatの書込・結果確認E2Eが未検証なので、報告内容はqueue送信済みとして扱わない。
- 進捗概算はコード/ローカルテスト範囲で約95%。運用可能率ではない。V2正本JSONはrev2708のまま画面rev2709より古く、2報告は内容確認済み/queue未送信/V2未反映/事後readbackなし。旧queueは未変更、売却行の再投入なし。
- 次工程はPlus Android通常ChatからのGoogle Sheets更新可否とreadback確認。可能な場合に限り、専用sheet作成と接続設計へ進む。課金・production接続・migration・cutoverは未実施。


### 2026-11-08 JST — 専用受付シート準備・CI確認

- Google Driveに専用Spreadsheet「Toreca Vault New App Intake」を作成し、`Intake` tabとA1:G1のheaderを設定。A2:G2以降は空であることを再読込確認。既存V2 Queueとは別ファイルで、取引報告は投入していない。
- GitHub Actions v2-ci #814 passed on head `82b8230705d4a3a3534d2fb1fcf968fd22a825c7`; testとFirestore Emulatorの両方成功。PR #105はopen/Draft/unmerged/undeployed。
- WorkセッションのGoogle Sheets接続は通常ChatGPT Androidでの書込可否を保証しない。service-account権限、Cloud Run、Scheduler、OAuth、production flags、billingは未設定。queue受付済みやV2反映済みとは扱わない。
- 次は通常ChatGPT Androidから安全なテスト行を追加/読み戻しできるか確認し、成功後にだけCloud Run identityを接続する。実取引報告はqueue receipt/statusと再試行動作のE2E確認まで投入しない。

### 2026-11-08 JST — 通常Chat AndroidからSheetsへの基本書込確認

- ユーザーが通常Chatから専用受付シート`Intake!A2`へ`normal-chat-smoke-test`を書き込み、読み戻しに成功したと報告。Work側で同値を再確認し、A2だけ空に戻した。再読込でheader保持とA2:G3の空状態を確認。
- 通常Chat AndroidのGoogle Driveアプリを使った基本write/readは確認済み。取引報告→command JSON生成→Firestore queue→worker→結果readbackの実運用E2Eと画像報告は未確認。smoke testはqueueに投入していない。
- Chat-only登録の完成条件は未達。今後はCloud Run identity/Scheduler OIDC/Firestore接続案と費用見積りを固める。billing有効化、deployment、service-account共有は承認前に行わない。受取のみで原価を計上しないcommandも未実装。

### 2026-11-08 JST — 受付シートの再開カーソル

- 通常Chatの基本write/readは確認済み。運用時に古い行が先頭20件を占有し、新しい報告が処理されなくなる問題を防ぐため、sheet ID hashとnextRowのみを持つFirestore CAS cursorを追加。20行ごとの連続pageを読み、各行のreceiptが完了してからカーソルを進める。queue/receipt失敗なら同じpageを再試行し、queueのstable requestIdで重複を防ぐ。
- シートはappend-only前提。過去行の並べ替え・削除・カーソル通過後の編集はしない。訂正は新しいrequestIdの新規行として送る。
- `npm run check --prefix cloud` passed。Full local cloud suite: 183 passed, 0 failed, 6 skipped because `FIRESTORE_EMULATOR_HOST` is not configured. GitHub Actions v2-ci #817 passed both test/check and Firestore Emulator, including concurrent cursor CAS/resume.
- Normal Chat→Sheets smoke testは成功済みだが、report-to-command JSON、Firestore queue、15分worker、Chatでの結果提示のE2Eは未検証。通常Chatだけでの登録完成条件は未達。Cloud billing、deployment、service-account共有は未実施。V2 revision 2708 exportはscreen 2709より古いまま。2報告は未キュー/未反映。

### 2026-11-08 JST — 受付receiptの読戻し確認

- Sheets intake providerは、D:Gへの受付結果書込み後に同じセル範囲を再読込し、status/resultCode/acceptedRequestId/processedAtMsの4値が一致した場合だけreceipt成功を返す。
- 書込み応答または読戻しが欠落/不一致ならworkerはページcursorを進めず、同じrequestIdで再試行する。queue create-onceにより再送は冪等。
- Added tests for receipt readback success, missing readback, and mismatched readback. Local verification and CI are recorded after completion; no live sheet worker or Cloud Run was invoked.
