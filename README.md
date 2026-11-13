# shooting-iraira

世界一むずかしいゲームを作ろうとしたら理不尽なゲームができた（html / css / js）。ランキング用サーバーは `server.js`。

## フォルダ構成

```
shooting-iraira/
├─ public/            ブラウザに配信するゲーム本体
│  ├─ index.html  style.css
│  ├─ script.js  config.js  scoring.js  rl.js  rl-pretrained.js  ai.js  net.js  audio.js
│  └─ audio/          BGM・効果音（bgm/ se/）
├─ site/              紹介ページ(Bootstrap)  /  で表示。css/ js/ img/(スクリーンショット)
├─ server/            ランキング・RL共有・観戦のサーバー（Node.js）
│  └─ server.js  realtime.js  rlmodel.js
├─ data/              サーバーのローカル保存（DATABASE_URL なしのとき）
│  └─ rl-model.json   （scores.json はここに作られる。Git管理外）
├─ tools/             検証・訓練ツール（smoke-test / train-rl / pull-rl）
├─ package.json  render.yaml
└─ README.md
```

**URL**: `/` が紹介ページ、`/play` がゲーム本体です。

`scoring.js` はブラウザとサーバーの両方が使います（サーバーは `../public/scoring.js` を読む）。

## モード

| モード | 内容 | ランキング |
| --- | --- | --- |
| 理不尽モード | 全7形態・固定の攻撃順 | あり |
| 通常モード | 全4形態 | あり |
| **RLモード** | 理不尽モードと同じ7形態・HP・玉の効果。**ボスAIが強化学習で動きと攻撃を決める** | なし（ボスが人ごとに違うため） |
| 練習モード | モードと形態を選んで練習 | なし |

## ポーズ（一時停止）

戦闘中・玉の選択中に `Esc` か `Space` で止まります（画面上のボタンはありません。オレンジ玉の「操作反転」カウントダウンと重なるため）。

- 再開: `Esc` / `Enter` / `Space`、または「再開」ボタン
- やめる: `Q`、または下のボタン（通常は挑戦を捨ててタイトルへ、練習モードは形態選択へ）
- 止まっている間は弾もボスもタイムも進まず、BGMも止まります。ほかのキーは無視されるので、秘密のキーを誤って押すこともありません
- ブラウザの別タブに移ると自動でポーズします
- 観戦中の人には止まった画面が見え続けます（長く止めても一覧から消えません）
- AIプレイ中はポーズなし（`Space` / `Enter` で再生速度の変更、`Esc` で終了）

### 理不尽モードのオレンジの壁

大きいオレンジの弾（壁）は、出るたびに動き方が変わります（1回のプレイの中で数えます）。

1. **1回目**: 段ごとに「流れる → 全段いっせいに止まる → いっせいに速く落ちる」（従来の理不尽モード）
2. **2回目**: 通常モードと同じ動き（壁ぜんたいが一緒に速くなったり遅くなったりする）
3. **3回目以降**: 毎回ランダムで、どちらかになる

通常モードとRLモードは変わりません。設定は `config.js` の `wallVariety`（理不尽モード）と、`wallPickStyle()` で決めています。

## RLモードのしくみ（`rl.js`）

ボスの頭脳は表形式のQ学習（ε-greedy）です。

- **動き**: ゆらゆら / プレイヤーを追う / 反対側へ逃げる / プレイヤーのショットをよける、の4つから選ぶ
- **攻撃**: 次の2種類から、固定順ではなく**毎回AIが選ぶ**
  - micro … このAI専用の短い技（狙い扇・リング・連続狙撃・弾の雨・追尾玉・十字砲火・渦巻き・ばらまき）
  - macro … 理不尽モードの攻撃パターン（`SEQUENCES_HARD` の各ステップ。作者が避けられると確認済みの技）
- **状態**: プレイヤーの位置（ボスからの相対x・y）・動いている向き・画面内の弾数・形態
- **報酬**: かすり＋被弾＋プレイヤーを動かせた量 − ボスが受けたダメージ（→ショットをよけるようになる）
- **成長**: 学習結果はブラウザの `localStorage` に保存され、遊ぶほど続きから成長する。
  `rl-pretrained.js`（Botを相手に事前訓練した初期状態）が土台として入っている。
  管理画面（Shift+@）の「ボスAI(RLモード)の学習をリセット」で、初期状態に戻せる。

### 無理ゲーにならない安全装置（学習結果に関係なくいつも効く）

1. 攻撃は同時に1つだけ（重ねるのは作者が確認した組み合わせだけ）
2. 画面内の弾数に形態ごとの上限。超えそうな技は選べない
3. 弾はまず薄く止まって見えて、少ししてから動き出す
4. プレイヤーの近く（70px以内）には弾を出さない
5. 同じ技を連続で出さない。大技にはクールダウン
6. 5秒以内に3回当たったら、AIが攻撃を止めて休憩。残りHPが少ないと大技を封印
7. 当たりすぎている時は、当てても報酬が減る（避けやすい方向に学習が寄る）
8. ボスの移動速度に上限。12秒ダメージを受けないとボスは疲れて動きが止まる

## ツール（`tools/`）

ブラウザなしで、ゲーム本体をそのまま動かして検証・訓練できる（プレイヤー役は弾を避けるBot）。

```
node tools/smoke-test.js            # 画面遷移を一通り動かして例外が出ないか確認（/beta は --beta）
node tools/ultra-test.js --oracle   # 超理不尽モード(/beta)の全1000技を作って動かし、予告を見るボットに避けさせる
node tools/train-rl.js base  5      # 比較用: 理不尽モード(固定順)のボスで被弾率を測る
node tools/train-rl.js fresh 5      # 学習前のボス(ランダム)で測る
node tools/train-rl.js eval  5      # rl-pretrained.js の状態で測る（学習はしない）
node tools/train-rl.js train 60     # 60周訓練して rl-pretrained.js を書き出す
```

`rl.js` の行動（`MICRO`）や報酬を変えたら、`rl-pretrained.js` は技の一覧が変わると自動で無効になる
（`sig` が合わないと読み込まない）ので、`train` で作り直すこと。

## AIプレイ観戦（`ai.js`）

AIが自機を操作して遊び、その様子を画面で見られます。タイトル画面の「🤖 AIプレイ」（`P` キー）→ モードを選ぶと始まります。

- **避け方**: ボスの弾・レーザー・落ちてくる玉を、ゲーム本体と同じ動きで約0.4秒先までシミュレーションし、いちばん安全な動き（8方向＋ゆっくり移動）を選びます。ボスの真下に居続けてショットも当てます。
- **玉の選択画面**: いちばん得な玉（赤 > 紫 > 青 > 橙 > 緑）を、ほかの玉に触れずにとりにいきます。ギャグ画面もボタンを押して進めます。
- **自動でやり直し**: ゲームオーバー / クリアの3秒後に、同じモードで最初から始めます。画面下に回数・クリア数・最高到達形態が出ます。
- **操作**: `Esc` で終了 / `Space`・`Enter`・タップで再生速度（×1 → ×2 → ×4 → ×8 → ×16）。
- ランキングには登録されず、観戦の一覧にも出ません。人間のキー入力（ランダムキーの回復を含む）は効きません。AIは操作反転の影響を受けません。
- **RLモードもAIが遊べます**。ボスは人が遊んだ時と同じように、AIの動きから学習します（学習結果はブラウザに保存され、サーバーがあれば「みんなのボス」にも送られます）。再生速度は ×8 / ×16 まで上げられるので、ボスを早く育てたい時に使えます。ただしAIはとても避けるのが上手いので、AIだけで育てると、ボスが人間には厳しすぎる方向に寄ることがあります。学習させたくない時は `ai.js` の `AI_BOSS_LEARNS` を `false` にします（その間ボスは普段どおり動くだけで、学習・保存・送信は止まります）。管理画面の「学習をリセット」で初期状態に戻せます。
- 先読みの長さや慎重さは `ai.js` 先頭付近の `AI_SEG` / `AI_DEPTH` / `AI_MARGIN` で調整できます。

## 音声（BGM・効果音）

音声は `audio/` フォルダにファイルを置くだけで鳴ります（設定は `audio.js` の先頭）。**ファイルが無い音は無音のまま**で、エラーにはなりません。1つずつ追加できます。

```
audio/
├─ bgm/   title.mp3  select.mp3  play.mp3  form1.mp3 〜 form7.mp3  over.mp3  win.mp3
└─ se/    shot  bossHit  hurt  orb  heal  bossDefeat  gameover  clear  fclear  fake  decide  cursor （どれも .mp3）
```

| BGM | 流れる場面 |
| --- | --- |
| title | タイトル・モード選択・練習の選択画面 |
| select | 玉の選択画面（無ければ play） |
| play | 戦闘中。`form1`〜`form7` があればその形態ではそちらが優先 |
| over / win | ゲームオーバー / クリア（ループしない）。win は偽のCLEARでも流れる |

偽のゲームオーバー（紫の玉）の間は無音です（`script.js` の `sceneBgm()` で変更可）。

- 拡張子を変える（wav / ogg）→ `audio.js` の `ext`
- 1つだけ別名にする → その音に `file: "xxx/yyy.ogg"`
- 音量・連打間隔 → `vol`（0〜1）/ `cooldown`（ms）
- 新しい効果音 → `AUDIO.se` に名前を足し、鳴らしたい所で `Sound.se("名前")`
- **設定画面**: タイトル画面の「⚙ 設定」ボタン（または `O` キー）で、BGM・効果音の音量とミュートを遊ぶ人自身が変えられます（スライダーはドラッグ / A・D・矢印キー。設定はブラウザに保存されます）。
- `-` キーでもミュートできます。初期の音量は `audio.js` の `bgmVolume` / `seVolume`

## デプロイ

Render の Web Service（`render.yaml`）。Build は `npm install`、Start は `npm start`（= `node server/server.js`）。

## 超理不尽モードの購入（買い切り・/beta）

超理不尽モードは、買った人にだけ遊べる（Stripe Checkout の買い切り）。**鍵はサーバーが持つ**: 買っていない人には `ultra.js` / `ultra-data.js` が 403 で届かず、メニューには「🔒 超理不尽モード」が出て、押すと購入画面(`shop.js`)が開く。

```
アカウント(server/payments.js) -> 購入する -> Stripe の決済画面 -> Stripe が Webhook で通知 -> 署名を検証して付与 -> ultra.js が届く
```

- アイテムを付与するのは **署名を検証した Webhook だけ**。ブラウザに戻ってきた(`?purchase=success`)だけでは付与しない。
- 金額はサーバーのDB(`game_items`)で決まる。ブラウザが送った金額は使わない。
- Stripeの商品税コードは `STRIPE_PRODUCT_TAX_CODE` で指定できる（既定 `txcd_10201004`: ストリーミング形式のビデオゲーム・条件付きアクセス）。Stripe Price を使う商品は、Stripe ダッシュボード側の商品にも税コードを設定する。
- 購入履歴(`game_purchases`)は消さない。返金・チャージバックは状態を変えるだけ（アイテムは取り上げる）。
- Stripe の設定や DB が欠けているときは、課金だけが止まる（超理不尽は鍵つきのまま）。ゲーム本体は動き続ける。

### 環境変数（Render の Environment に設定する。`.env` やリポジトリに書かない）

| 名前 | 内容 |
|---|---|
| `DATABASE_URL` | PostgreSQL（課金には必須。無いと課金は無効） |
| `STRIPE_SECRET_KEY` | `sk_test_...`（テスト）/ `sk_live_...`（本番）。**テストと本番で分ける** |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...`（Stripe の Webhook エンドポイントごとに違う） |
| `PUBLIC_BASE_URL` | 公開URL 例 `https://xxxx.onrender.com`（決済後の戻り先。末尾の `/` なし） |
| `ADMIN_PASSWORD` | 課金管理API用。`shooting-iraira-admin-mode` を設定すると、上位管理画面から課金アイテムを付与できる |
| `ULTRA_PRICE_JPY` | 価格（円）。商品テーブルを**最初に作るときだけ**使う。既定 500。あとの変更は下の管理API |
| `ULTRA_FREE_FOR_TESTING=1` | 誰でも遊べる（開発用）。**本番に付けない** |
| `PAYMENTS_DISABLED=1` | Stripe決済を停止し、超理不尽モードを全員に開放（デバッグ用）。Renderでは一時的に有効。課金を戻すときは削除または `0` にする |
| `PAYMENTS_MEMORY=1` | DBなしで課金を試す（開発用。再起動で消える） |

### 登録しようとすると「ただいまアカウントの登録・ログインを受け付けていません」と出るとき
サーバーに、アカウントを保存する場所が無い（= 課金用のDBが用意できていない）。サーバーの起動ログの `[payments]` の行で、原因が分かる。

| ログの内容 | 原因と対処 |
|---|---|
| `no PostgreSQL: the shop is off ...` | `DATABASE_URL` が無い（ローカル起動など）。本番は Render の PostgreSQL の接続URLを `DATABASE_URL` に設定する。**ローカルで試すだけなら** `PAYMENTS_MEMORY=1 npm start`（再起動で消える） |
| `could not prepare the shop tables, the shop is OFF: ...` | DBには繋がったが、表を作れなかった。`...` のメッセージ（権限など）を見る |
| `PAYMENTS_MEMORY=1 ...` と出ているのに出る | 古いコードが動いている。デプロイ・再起動を確認する |

登録・ログインだけなら Stripe の設定は要らない。**買えるようになる**には、さらに下の Stripe の環境変数が全部要る（足りないときは「ただいま購入を受け付けていません」と出る）。
`PAYMENTS_MEMORY=1` に本番の Stripe キー(`sk_live_...`)を組み合わせても、課金は有効にならない（再起動で購入記録が消えるため）。

### Stripe の設定
1. Stripe のダッシュボードで **テストモード**にして、API キー(`sk_test_...`)を取る。
2. Webhook エンドポイントを追加: URL は `https://（公開URL）/api/stripe/webhook`。送るイベントは
   `checkout.session.completed` `checkout.session.async_payment_succeeded` `checkout.session.async_payment_failed`
   `checkout.session.expired` `charge.refunded` `charge.dispute.created`。表示される `whsec_...` を `STRIPE_WEBHOOK_SECRET` に。
3. テストカード `4242 4242 4242 4242`（有効期限は未来、CVCは任意）で、購入→遊べる、を確認する。
4. ダッシュボードで返金して、アイテムが取り上げられるのも確認する。
5. 本番キーに替えるときは、キーと Webhook の `whsec_` の**両方**を本番のものにする。

### 管理画面
`Shift+@` で開きます。`mint` は無敵・攻撃倍率のみ、`shooting-iraira-admin-mode` はそれに加えて体力調整、スコアボード、AI学習、課金アイテム付与（beta）を使えます。課金アイテム付与にはサーバーの `ADMIN_PASSWORD` を `shooting-iraira-admin-mode` に設定してください。

### 管理API（課金管理は `ADMIN_PASSWORD` を設定したときだけ。パスワードはリクエストの本文に入れる）
価格は100円以上にしてください。Stripeアカウントの決済通貨がUSDの場合、50円では換算後にStripeの最低額を下回ることがあります。
```
POST /api/admin/grant  { "password": "...", "username": "player1", "itemId": "ultra_mode" }   決済なしで付与（動作確認・プレゼント）
POST /api/admin/item   { "password": "...", "itemId": "ultra_mode", "priceJpy": 800 }         価格の変更（100円以上）
POST /api/admin/item   { "password": "...", "itemId": "ultra_mode", "active": false }         販売停止
```

### 本番に出す前に（お金が動くので、飛ばさない）
- [ ] **DBのバックアップ**（Render の PostgreSQL）。起動時に `game_users` `game_sessions` `game_items` `game_purchases` `game_entitlements` `stripe_events` を作る（既存の表には触らない）
- [ ] PostgreSQL 用のSQLは、このリポジトリのテストでは動かせていない。**テスト用のDBで一度起動して**、購入→付与→返金まで通すこと
- [ ] 利用規約・プライバシーポリシー・**特定商取引法に基づく表示**を用意して、`shop.js` の `LEGAL_LINKS` にリンクを書く（販売者の名称・所在地・連絡先は本人でないと書けない）
- [ ] リポジトリを **非公開**にする（GitHub が公開だと `ultra.js` のソースが誰でも読める。サーバーの鍵はファイルの配信を止めるだけ）
- [ ] 価格を決める（今は仮の500円）
- [ ] Stripe の本番アカウントの審査・利用条件の確認

### 作りの制約（変えるときの注意）
- アカウントは「ユーザー名 + パスワード」だけ（メールなし）。パスワードを忘れると復旧できない。メールを取るなら、パスワード再設定を作る必要がある。
- 付与する処理は `server/payments.js` の `completeCheckout`（DBトランザクション）だけ。ほかの場所で付与を足さない。
- 確認するコマンド: `node tools/payments-test.js`（サーバー側）/ `node tools/smoke-test.js --beta` / `--locked`（未購入のメニュー）
