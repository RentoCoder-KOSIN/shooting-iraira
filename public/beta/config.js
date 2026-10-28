/* ============================================================================
 *  config.js - 世界一むずかしいゲームを作ろうとしたら理不尽なゲームができた  (game values / bullets / patterns)
 *
 *  Edit THIS file to change how the game feels. script.js (the engine) reads it.
 *  This file must be loaded BEFORE script.js (see index.html).
 *
 *   1. SETTINGS        numbers you can tweak (HP, speeds, chances, intervals ...)
 *   2. TEXTS           taunts, gag texts ...
 *   3. ORBS            colored orbs and what they do
 *   4. BULLET TYPES    the look and behavior presets of bullets
 *   5. PACE (緩急)     how a bullet speeds up / slows down / stops
 *   6. PATHS (軌道)    how a bullet curves or homes
 *   7. ATTACK PATTERNS what the boss fires, and in what order (SEQUENCES / SEQUENCES_HARD)
 *
 *  QUICK RECIPES
 *  -------------
 *  - New bullet look      -> add a line to BULLET_TYPES (section 4)
 *  - New speed behavior   -> add a function to PACES (section 5)
 *  - New trajectory       -> add a function to PATHS (section 6)
 *  - New attack pattern   -> add an entry to PATTERNS (section 7),
 *                            then put its name into SEQUENCES
 *  - New orb              -> add an entry to ORBS (section 3)
 *  - Make it harder/easier-> change numbers in SETTINGS (section 1)
 *
 *  Every recipe has an example comment right next to the table it belongs to.
 *  Patterns and orbs call helpers that live in script.js (shoot, bossRing, beam ...).
 * ========================================================================== */

/* ============================================================================
 *  1. SETTINGS
 * ========================================================================== */
const H = 640; // logical height (never changes)
const MIN_W = 480; // logical width is between MIN_W and MAX_W,
const MAX_W = 1280; // and follows the window's aspect ratio
const PI = Math.PI;
const STEP_MS = 16.67; // fixed time step (about 60 updates per second)

// ---- player ----
const PLAYER_MAX_HP = 10; // starting HP (= max HP). scoring.js MAX_HP must match

// ---- effects (small particles, rings, screen shake). Kept light on purpose. ----
const FX_ENABLED = true; // false = no effects at all (if the game ever lags)
const FX_MAX = 150; // maximum number of particles / rings alive at once (new ones are skipped when full)
const FX_SHAKE_HURT = 8; // screen shake (frames) when the player is hit
const FX_SHAKE_DEFEAT = 14; // screen shake (frames) when a form is defeated
const PLAYER_SPEED = 4; // pixels per frame
const PLAYER_SLOW_SPEED = 2; // while holding Shift
const PLAYER_HIT_R = 3; // the real hit box is tiny
const HURT_INVINCIBLE_FRAMES = 60; // invincibility after being hit

// ---- boss ----
const BOSS_HP = [170, 220, 260, 220]; // HP of each form (通常モード: 4 forms, 第4形態: 340 -> 220 体力を減らして攻撃力UP)
const BOSS_HP_HARD = [170, 220, 260, 340, 380, 440, 560]; // 理不尽モード: 7 forms (第4形態: 340 -> 220)
// 理不尽モード actually uses this one: forms 1-3 are unchanged, forms 4-7 are a bit shorter than BOSS_HP_HARD
// (scoring.js parMs = HP x 200 ms). Forms 4-7 were eased once and then raised again about half way back (2026-10-22).
// BOSS_HP_HARD above stays as it was for the RLモード (its learned data depends on it).
const BOSS_HP_HARD_EASED = [170, 220, 260, 340, 355, 410, 520]; // form 4: 300 -> 200 (体力を減らして攻撃力UP)
// Subtitle shown in the HUD for the 理不尽 forms (null = no subtitle)
const FORM_TITLES_HARD = [
    null,
    null,
    null,
    null,
    "覚えた奴ほど死ぬ",
    "プレイヤー対策",
    "最終理不尽",
];
const FORM_NAMES = "一二三四五六七"; // used in "第◯形態" (the 理不尽 mode has 7 forms)
const START_SPEED_MUL = 1.1; // every bullet speed is multiplied by this (grows with some orbs)
const BOSS_START_Y = 90; // boss y position
const BOSS_MUZZLE_Y = 20; // bullets / beams come out this many pixels below the boss
const BOSS_MOVE_AMP = 100; // boss sways left and right by this many pixels (at W = 480)
const BOSS_MOVE_PERIOD = 120; // boss sway speed: bigger = slower (frames / radian)
const BOSS_HIT_HALF_W = 42; // boss hit box (half width / half height) for the player's shots
const BOSS_HIT_HALF_H = 24;

// ---- player shots (auto fire) ----
const PLAYER_SHOT_INTERVAL = 8; // fire every N frames (smaller = more damage per second)
const PLAYER_SHOT_SPEED = 10; // pixels per frame
const PLAYER_SHOT_SPACING = 8; // the two shots are this far left / right of the player
const PLAYER_SHOT_OFFSET_Y = 10; // and this far above the player
const HISTORY_FRAMES = 60; // how long the player's position is remembered ("fake" homing aims at the oldest)

// ---- form flow ----
const FCLEAR_FRAMES = 200; // the fake CLEAR screen lasts this long

// ---- falling orbs ----
const ORB_DROP_FROM_FORM = 1; // orbs start falling from this form (0 = form 1)
const ORB_DROP_INTERVAL = 270; // an orb falls every N frames ...
const ORB_DROP_OFFSET = 135; // ... at this frame inside each interval
const ORB_FALL_SPEED = 1.8; // pixels per frame
const ORB_MIN_GAP = 150; // a new orb does not fall within this many frames after the last one (no bursts of orbs)
const ORB_MAX_ON_SCREEN = 2; // ... and never when this many orbs are already on the screen
const ORB_PICK_R = 16; // how close the player must be to take it
const ORB_MARGIN_X = 70; // orbs do not fall closer than this to the left / right edge

// ---- red orb (heals the boss and you; in 通常モード the boss also gets stronger: you take more damage) ----
// The boss heal ratio and the damage multiplier depend on the mode (see MODES below).
// 理不尽 / RLモード: redDmgMul = 1 (the red orb no longer raises the damage you take)
const RED_PLAYER_HEAL = 2; // the player recovers this many hearts

const DETOUR_MAX_FORM = 3; // yellow orb: last form (0 = form 1) where it works in 通常モード

// ---- game modes (chosen on the mode select screen after the title) ----
//  startSpeedMul : bullet speed multiplier at the start of the run
//  bossHealRatio : share of the boss max HP that the red orb gives back to the boss
//  redDmgMul     : damage multiplier after taking the red orb (boss attack power up).
//                  It only rises if it is not already that high (never lowers a bigger one).
//  ranked        : true -> the run can be sent to the ranking
//  bossHp        : HP of each form. Its length = the number of forms of the mode
//  formTitles    : subtitle of each form shown in the HUD (optional)
//  detourMaxForm : last form where the yellow orb works
//  sequences     : attack lists of the mode (set at the bottom of this file)
const MODES = [
    {
        id: "hard",
        label: "理不尽モード",
        desc: "本命。全7形態",
        bossHp: BOSS_HP_HARD_EASED, // one entry per form = the number of forms
        formTitles: FORM_TITLES_HARD,
        detourMaxForm: 5, // yellow orb works up to this form (0 = form 1)
        // sequences: attached at the bottom of this file (SEQUENCES_HARD)
        color: "#f55",
        startSpeedMul: 1.1,
        bossHealRatio: 0.15, // halved (was 0.3)
        redDmgMul: 1, // no damage multiplier any more (was 3)
        ranked: true,
        rowWave: true, // the orange wall: flow -> all rows stop -> all rows drop fast (see WALL_STOP_FRAMES)
        // the orange wall changes how it moves from one appearance to the next (see wallIsWave):
        // 1st = rowWave (as above), 2nd = the 通常モード way, 3rd and later = random every time
        wallVariety: true,
    },
    {
        id: "normal",
        label: "通常モード",
        desc: "イライラするけど、覚えれば勝てる（全4形態）",
        bossHp: BOSS_HP,
        formTitles: [],
        detourMaxForm: DETOUR_MAX_FORM,
        // sequences: attached at the bottom of this file (SEQUENCES)
        color: "#6af",
        startSpeedMul: 1.0,
        bossHealRatio: 0.1, // halved (was 0.2)
        redDmgMul: 2,
        ranked: true, // 通常モードもランキングに登録される（モードごとに別のボード）
        rowWave: false, // the orange wall: the old behaviour (the whole wall speeds up / slows down together)
    },
    {
        // RLモード: 理不尽モードと同じ7形態・同じHP・同じ玉の効果。違うのはボスの中身だけ。
        // ボスAI(rl.js)が強化学習で「動き」と「何をどの順番で撃つか」を決める。
        id: "rl",
        label: "RLモード",
        desc: "ボスAIが強化学習で成長する（全7形態）",
        bossHp: BOSS_HP_HARD,
        formTitles: FORM_TITLES_HARD,
        detourMaxForm: 5,
        // sequences: attached at the bottom of this file (only used to build the AI's attack list)
        color: "#4d4",
        startSpeedMul: 1.1,
        bossHealRatio: 0.15, // halved (was 0.3)
        redDmgMul: 1, // no damage multiplier any more (was 3)
        ranked: false, // the boss is different for every player, so the scores cannot be compared
        rowWave: true, // the orange wall: flow -> stop -> drop fast (same as 理不尽モード)
        rl: true, // the boss is controlled by RL (rl.js)
    },
];

// ---- yellow orb (sends the boss back to form 1) ----
// Taking it fights the form 1 boss (full HP, form 1 attacks). When that boss is beaten you
// return to the form you were in, with the boss HP it had when you took the orb.
// Example: take it in form 3 -> fight form 1 -> beat it -> back to form 3.
// The orb only works in forms DETOUR_MIN_FORM..DETOUR_MAX_FORM (0 = form 1, 1 = form 2 ...).
const DETOUR_MIN_FORM = 1;
// (DETOUR_MAX_FORM is defined above MODES; the 理不尽 mode overrides it with detourMaxForm)

// ---- other orbs ----
const INVERT_FRAMES = 600; // orange: reversed controls for 10 seconds
// purple: the fake game over screen lasts longer every time you take one in the same run
const FAKE_WAIT_FRAMES = 300; // 1st purple orb: 5 seconds
const FAKE_WAIT_ADD_FRAMES = 120; // each further purple orb adds this much (2 seconds)
const FAKE_WAIT_MAX_FRAMES = 1800; // the wait never gets longer than this (30 seconds)
const FAKE_INV_FRAMES = 180; // purple: 3 seconds of invincibility afterwards (was 5)

// ---- the "press the right random key" heal ----
const KEY_HEAL = 3;
const KEY_BOSS_BUFF = 0.1; // added to the boss speed multiplier
const KEY_DEBUG_FRAMES = 180; // how long the "pressed key" text stays
const SECRET_KEY_CANDIDATES = "bceghijklmnopqrtuvxyz0123456789"; // no WASD / F

// ---- bullet pace (緩急) ----
// Smooth speed wave: every bullet slowly speeds up and slows down.
const WAVE_AMP = 0.35; // +-35% around the base speed
const WAVE_PERIOD = 120; // frames per cycle
// Random extra tempo: when a bullet is created it may get one of these.
// pace   : a name from PACES (section 5)
// chance : probability (0.12 = 12%). The sum must stay below 1.
// at     : [min, max] frames after spawning when the change happens
// len    : [min, max] frames the effect lasts (used by "stopGo")
const RANDOM_TEMPO = [
    { pace: "stopGo", chance: 0.12, at: [20, 50], len: [25, 55] },
    { pace: "dash", chance: 0.12, at: [35, 70], len: [0, 0] },
];

// ---- orb selection screen ----
const SEL_COLS = 5; // orbs per row
const SEL_GAP = 80; // distance between orbs
const SEL_R = 20; // orb radius
const SEL_PICK = 24; // how close the player must be to pick one

// ---- admin mode (Shift+@) ----
// NOTE: this password is visible to anyone who opens the source. It is a toy lock, not security.
const ADMIN_PASSWORD = "mint";

// ---- scoreboard (needs server.js; the ranking is shared by everyone) ----
// A run is recorded when it ends: the form reached + the time spent in that form,
// and the total survival time (for a real CLEAR: the clear time).
// Ranking: CLEAR runs first (shortest time wins), then the highest form reached,
// then the longest time inside that form.
const SCORE_ENABLED = true; // false -> no ranking, no name entry
const SCORE_API = ""; // "" = the server that serves this page. Or a full URL: "https://xxx.onrender.com"
const SCORE_TOP_N = 10; // how many rows are shown on the title screen
const SCORE_NAME_MAX = 12; // name length limit
const SCORE_NA_TEXT = "NA"; // shown for a form that was not defeated in that run
const SCORE_PROMPT_DELAY_MS = 900; // name entry opens this long after the run ends (avoids typing while still playing)
const SCORE_REFETCH_MIN_MS = 5000; // do not reload the ranking more often than this
const SCORE_NAME_KEY = "irritating-game:name"; // where the last used name is remembered (localStorage)

/* ============================================================================
 *  2. TEXTS
 * ========================================================================== */
// Extra confirmations after the "done" button of the gag time (blue orb)
const GAG_CONFIRMS = [
    "本当に終わりましたか？",
    "ちゃんと全力でやりましたか？",
    "最終確認：もう思い残すことはありませんか？",
];
const GAG_LOCK_FRAMES = 30; // ignore presses right after a press (prevents double-click skipping)
// The confirmations have a "はい" and an "いいえ" button. Each confirmation, the two buttons swap places
// with this chance (so mashing the same spot does not work). "いいえ" goes back to the gag.
const GAG_SWAP_CHANCE = 0.4;

const GAG_TEXTS = [
    "全力で変な顔をしてください",
    "3秒間、最高にカッコいいポーズ",
    "自分を褒めるセリフを言ってください",
    "急にアイドルになってください",
    "必殺技名を考えて叫んでください",
    "自分の名前をめちゃくちゃカッコよく言って！",
    "え〜♡ そんなこともできないの〜？",
    "ねぇねぇ♡ がんばってぇ〜♡",
    "えへへ♡ かわいいでしょ〜♡",
    "お願い♡ 一回だけやってぇ〜♡",
    "恥ずかしがらなくていいよ♡",
];

// "◯" is replaced with the current form number (一, 二, ...)
const TAUNTS = [
    "こんなんで負けちゃうんだ",
    "ザッコ",
    "よっわ",
    "切り抜きよろしく〜",
    "また勝っちゃった",
    "なんで負けたか自分の悪かった点をどうぞ！",
    "よわよわのいわし",
    "うえええええええええええい勝ったあああああああ",
    "今のは避けれたよね",
    "なんで球に当たるのかな",
    "まだ第◯形態だけど大丈夫？",
    "うぉ",
    "ど、どわー",
    "今の攻撃きつかった？",
    "え、よわ",
    "笑",
];

/* ----------------------------------------------------------------------------
 *  GAMEOVER_TAUNTS - the boss's lines on the GAME OVER screen (/beta only)
 *
 *  Each entry is [ "line", "tags" ].  When the player dies, script.js looks at how the run went
 *  and gives every line a weight; one line is then picked at random by that weight.
 *    - a line without tags can always appear (weight 1)
 *    - a plain tag raises the weight while that situation is true  (e.g. "instant")
 *    - a tag with "!" in front is a CONDITION: the line can only appear while it is true  (e.g. "!f1")
 *
 *  Situation tags (decided in chooseGameOverTaunt() in script.js):
 *    f1        died in form 1                       instant   died within 20 seconds of the start
 *    deep      reached form 3 or later              last      died in the last form
 *    long      survived 2 minutes or more           fake      took the purple orb (fake game over) in this run
 *    bossHigh  the boss still has > 85% HP          close     the boss has < 25% HP left
 *    still     hardly moved                         busy      kept moving, and still got hit a lot
 *    burst     lost HP in a short burst             inverted  controls were reversed when it ended
 *    rl        RL mode (the boss AI learns)
 *    again     2nd or later loss in a row           retry     4th or later loss in a row
 *    n2 n3 n5 n10   exactly the 2nd / 3rd / 5th / 10th loss in a row
 *    improved  survived longer than the last run    worse     died much sooner than the last run
 * -------------------------------------------------------------------------- */
const GAMEOVER_TAUNTS = [
    // ① 煽り性能MAX
    ["えっ、負けたの！？！？ うそ！？ ……うそじゃないのかｗｗｗ", "fake"],
    [
        "よっわｗｗｗ いや待って、今のは君が弱いんじゃなくて……いや、君が弱いわｗ",
        "",
    ],
    ["え、これクリアできない人いるんだ……あっ、ごめん目の前にいたｗｗｗ", "f1"],
    ["君の実力、体験版で終わってない？ｗ", "f1 instant"],
    ["うわぁぁぁ！ 強すぎる！！ ……ボスがねｗｗｗ", "close"],
    [
        "負けるの早すぎて、こっちの煽りが間に合わなかったんだけどｗ",
        "instant worse",
    ],
    ["今の負け方、逆に才能あるよｗｗｗ", "instant worse"],
    ["え、今ので終わり？ まだ僕、自己紹介しかしてないよ？", "instant"],
    ["君が勝つルート、開発段階で削除された？ｗｗｗ", "retry"],

    // ② 正論ぶって精神を削る
    [
        "では、敗因を発表してください。制限時間はありません。どうせ考えてもわからないのでｗ",
        "",
    ],
    [
        "今の弾、見えてたよね？ 見えてたのに当たったんだよね？ ……なるほどｗ",
        "burst",
    ],
    ["回避ボタン、飾りとして実装したわけじゃないんだけどなぁｗ", "still"],
    [
        "今のミスを一言で説明してください。はい、『自分のせい』ですｗ",
        "burst inverted",
    ],
    [
        "反省点は3つ！ 1つ目、避けなかった。2つ目、当たった。3つ目、負けたｗ",
        "still",
    ],
    ["その動き、敵の攻撃を避けるというより、弾に会いに行ってるよねｗ", "busy"],
    [
        "今の攻撃の安全地帯、ちゃんとあったんだけど……君の画面だけ消えてた？ｗ",
        "burst",
    ],
    ["攻略動画を見る前に、自分のプレイ動画を見たほうがいいかもｗ", "retry"],
    [
        "君の操作と敵の攻撃、完全に連携してたね。全部当たりに行ってたｗ",
        "busy inverted",
    ],
    [
        "敗因は何でしょう？ A：弾　B：ボス　C：自分の操作　正解は……全部ではなくCですｗ",
        "inverted",
    ],

    // ③ 配信者・切り抜き公開処刑
    [
        "切り抜きよろしく～！ タイトルは『最強を名乗った結果』で！ｗ",
        "deep last",
    ],
    ["今の場面、編集でカットしないでね！ ここが本編だからｗ", "close"],
    ["はい、ここでコメント欄の皆さん！ 敗因予想をどうぞ！ｗ", ""],
    ["サムネ用の文字は『余裕の表情からの即終了』で決まり！", "instant still"],
    ["今のプレイ、字幕つけるなら『なぜか避けない』だねｗ", "still"],
    ["配信タイトル変えよ！ 『ラスボス討伐』から『ラスボス見学会』にｗ", "last"],
    ["アーカイブ残してね。未来の君が反省するために必要だからｗ", "long retry"],
    ["今の負け、切り抜き職人さんが一番困るやつ。短すぎてｗ", "instant"],
    [
        "視聴者さん、今のはボスが強かったんじゃありません。君が……おっと、言いすぎた？ｗ",
        "",
    ],
    ["はい、敗北記念スクリーンショット！ 額縁に入れて飾っとこうｗ", "deep"],

    // ④ しつこすぎる小馬鹿系
    ["よわよわ〜〜笑", ""],
    ["ピチピチピチ～！ あっ、逃げられなかったねｗ", "busy"],
    ["よわ！ よわ！ よわ！ ……あれ、まだリザルト画面見てるの？ｗ", "retry"],
    ["ドンマイ！ ドンマイ！ ドンマイ！ ……何回言わせる気？ｗ", "retry"],
    ["惜しかったね！ ……うん、惜しかったということにしておこうｗ", "close"],
    ["君のHP、僕の期待値より先にゼロになったねｗ", "instant burst"],
    ["リトライする？ するよね？ 負けるの好きそうだもんねｗ", "retry"],
    ["また負けちゃった！ もう負け方のコレクション作れるねｗ", "!again worse"],
    ["あれ？ 勝つ予定だったんじゃないの？ 予定だけは最強だったねｗ", "f1"],
    ["安心して！ 僕は君を見捨てないよ！ 次の敗北も見届けるからねｗ", "again"],

    // ⑤ ラスボスの上から目線
    ["お疲れ様。ちなみに、今のは第1形態のウォーミングアップです", "!f1"],
    ["え、ここで負けたの？ まだ本気を出すか迷ってたんだけどｗ", "f1 bossHigh"],
    [
        "君のために新技を用意したのに……使う前に終わるとは思わなかったｗ",
        "f1 instant",
    ],
    ["第2形態に進めると思った？ ……その自信、どこから来たの？ｗ", "!f1"],
    ["君のHPが減るたびに、僕のやる気が上がる仕様ですｗ", "burst"],
    [
        "今の攻撃、難しかった？ ごめんね。次はもっと簡単に……すると思った？ｗ",
        "burst",
    ],
    [
        "まだ僕のHP、ほとんど減ってないんだけど。君のほうはもう空っぽだねｗ",
        "!bossHigh",
    ],
    [
        "ここまで来た努力は認めるよ。勝てるとは一言も言ってないけどｗ",
        "deep last close",
    ],
    [
        "君が僕を倒す未来、シミュレーションしてみたけど……エラーが出たｗ",
        "deep last rl",
    ],
    ["敗北おめでとう。君は今、僕の勝利演出を解放しました！", ""],

    // ⑥ 褒めてるフリして落とす
    ["すごい！ ここまで負けられるの、なかなかできないよ！", "deep long"],
    ["君、成長したね！ 負けるまでの時間が前回より長かった！", "!improved"],
    ["天才かもしれない！ その避け方で全部当たるなんて！", "busy burst"],
    ["素晴らしい判断力！ ……敵にとってはねｗ", "still"],
    ["完璧な立ち回りだったよ！ 敵の攻撃を受けるという点ではｗ", "busy"],
    ["今日の君は輝いてたよ！ 敗北画面がねｗ", ""],
    ["君のプレイ、独創的だね。普通はそこに突っ込まないからｗ", "busy worse"],
    ["惜しい！ 判断は正しかった！ タイミングと場所と操作以外はｗ", "close"],
    ["いやぁ、感動した！ こんなに期待を裏切るのがうまいなんて！", "worse"],
    ["君ならできると思ってたよ！ ……負けることならねｗ", "retry"],

    // ⑦ リトライするたびにウザい
    ["おかえり！ また会えたね！ 予想してたよｗ", "!n2"],
    ["2回目の挑戦！ 今度こそ勝てるかな？ ……記録更新に期待！", "!n2"],
    ["3回目！ そろそろ攻略法より言い訳が増えてきたかな？ｗ", "!n3"],
    ["5回も挑戦してくれるなんて！ 僕のファンなの？", "!n5"],
    ["10回目の挑戦、おめでとう！ そろそろ常連って呼んでいい？ｗ", "!n10"],
    ["あ、また君だ！ もう入場曲いらないねｗ", "!again"],
    ["リトライボタン押すのだけは世界最速だねｗ", "!again retry"],
    ["君の執念はすごい。勝率以外は全部成長してるｗ", "!again retry improved"],
    ["次は勝てるよ！ ……というセリフを前回も言った気がするｗ", "!again"],
    ["何回でも来てね！ 僕の勝利数が増えるから！ｗ", "!again"],

    // ⑧ 意味不明なテンションで煽る
    [
        "うえええええええええええい！！ 勝ったあああああ！！ ……え、君は？ あ、負けたのかｗｗｗ",
        "fake",
    ],
    ["勝利！ 勝利！ 大勝利！ 敗北！ 敗北！ 大敗北！ ……君のほうねｗ", ""],
    ["うぉぉぉぉ！ 今の攻撃、最高だった！ 君のリアクションがｗ", "burst"],
    [
        "どわああああ！ ……って言いたかったのに、君が先に倒れちゃったｗ",
        "instant",
    ],
    ["はい優勝～～！ 参加者1名！ 敗者1名！ 君です！！ｗ", ""],
    [
        "やったあああ！ ……あ、ごめん。君が負けたことを忘れて盛り上がっちゃったｗ",
        "fake instant",
    ],
    ["パパパパーン！ 敗北のファンファーレでーす！", ""],
    [
        "君の敗北に祝杯を……あっ、お祝いの準備するほど時間かからなかったねｗ",
        "instant",
    ],
    ["勝利の舞、いきます！ らんらんる～～！ ……まだリザルト見てる？ｗ", "retry"],
    ["ボス撃破！ ……されてません！ 君が撃破されました～～！！ｗ", "close"],

    // ⑨ 冷静すぎて逆に腹立つ
    ["敗北を確認しました。原因は、敗北したことです", ""],
    [
        "戦闘終了。君の活躍については……記録する項目がありませんでした",
        "instant still",
    ],
    ["今回の戦闘データを分析中……分析終了。もう一度やってみましょう", "rl"],
    [
        "残念なお知らせです。君の作戦は、敵にとって都合がよかったようです",
        "still",
    ],
    ["結果は変わりませんでした。君の自信だけが変わりました", "retry"],
    ["君の努力は確認できました。勝利は確認できませんでした", "deep close"],
    [
        "生存時間を記録しました。次回の目標は、今回の記録を超えることです",
        "long improved",
    ],
    ["敗北理由を検索中……候補が多すぎるため、検索を終了しました", "burst busy"],
    [
        "君のプレイは統計上、非常に興味深い結果となりました。悪い意味で",
        "rl worse",
    ],
    ["お疲れ様でした。なお、ボスはまだ元気です", "bossHigh"],

    // ⑩ 最終兵器・ウザさ限界突破
    ["君が勝つまで付き合うよ！ ……僕は負けないから、ずっと会えるねｗ", "again"],
    ["君のこと、忘れないよ！ 何回も来てくれるからねｗ", "!again"],
    ["今回の敗北をバネにして頑張ろう！ ……バネ、折れないといいねｗ", ""],
    [
        "君には無限の可能性がある！ ただし、勝利する可能性がいつ来るかは未定ですｗ",
        "deep",
    ],
    ["君の挑戦は無駄じゃないよ！ 僕が強くなった気がするからｗ", "rl"],
    [
        "君はまだ本気を出してないんだよね？ ……え、出してたの？ そっかぁｗ",
        "still instant",
    ],
    ["次は勝てる！ 次の次も勝てる！ ……僕がねｗ", "retry"],
    [
        "君の伝説はここから始まる！ 『何度挑んでも勝てなかった者』としてｗ",
        "retry",
    ],
    [
        "ゲームオーバー！ 君の冒険は終わったけど、僕の休憩時間が始まったよｗ",
        "long",
    ],
];

/* ----------------------------------------------------------------------------
 *  /beta 追加機能の設定値: かすりゲージ / ボスの癖 / 視聴者介入
 *  （しくみは script.js の「/beta 追加機能」にある）
 * -------------------------------------------------------------------------- */
// ---- かすりゲージ: 弾のぎりぎりを通るとたまる。満タンで「近くの弾を消す + 攻撃力アップ」 ----
const GRAZE_EXTRA_R = 16; // 当たり判定のすぐ外側（この距離まで）を通ると「かすり」
const GRAZE_BULLET_PT = 1; // 弾1発ぶんのポイント（同じ弾は1回だけ）
const GRAZE_BEAM_PT = 0.12; // ビームのすぐ横にいる間、1フレームごとのポイント
const GRAZE_MAX = 30; // 満タンになるポイント
const GRAZE_BLAST_R = 160; // 満タンで弾を消す半径(px)。オレンジの壁は消さない
const GRAZE_POWER_FRAMES = 300; // 攻撃力アップの長さ（60 = 1秒）
const GRAZE_POWER_MUL = 2; // 攻撃力アップ中の、自機ショットのダメージ倍率

// ---- ボスの癖: プレイヤーがよくいる場所を覚えて、そこを狙う ----
const HABIT_COLS = 3; // 画面を 3 x 3 のマスに分けて、どこにいた時間が長いかを数える
const HABIT_ROWS = 3;
const HABIT_NAMES = [
    ["左上", "上", "右上"],
    ["左", "真ん中", "右"],
    ["左下", "下", "右下"],
];
const HABIT_DECAY = 0.9997; // 1フレームごとに記録を薄める（今の動きほど重く見る）
const HABIT_MIN_TOTAL = 1200; // これ以上たまるまでは「覚えた」ことにしない（約20秒ぶん）
const HABIT_MIN_SHARE = 0.35; // 1つのマスにいた割合がこれ以上なら「癖」とみなす
const HABIT_FROM_FORM = 1; // この形態から狙い始める（0 = 第1形態）
const HABIT_FIRST = 600; // 戦闘開始から最初の狙い撃ちまでの最短フレーム
const HABIT_INTERVAL = 1500; // 狙い撃ちの間隔（フレーム）
const HABIT_WARN = 100; // 爆発マークが出てから爆発するまで（フレーム）
const HABIT_SPEECH_FRAMES = 150; // 吹き出しを出しておく長さ
const HABIT_LINES = [
    "また{n}か",
    "{n}にいること多いよね？ ｗ",
    "知ってる？ 君、{n}が好きなんだよ",
    "{n}に逃げるの、もうバレてるよ",
    "はい{n}。覚えました",
];

// ---- 視聴者介入: 観戦している人がボタンで邪魔を入れる（クールダウンはサーバー側でも見張る）----
const MEDDLE_BUTTONS = [
    { k: "fake", label: "偽の玉" },
    { k: "dark", label: "暗転" },
    { k: "taunt", label: "煽る" },
];
const MEDDLE_FAKE_ORBS = 3; // 偽の玉の数
const MEDDLE_DARK_FRAMES = 90; // 暗転の長さ。自機のまわりだけは見える
const MEDDLE_SPEECH_FRAMES = 200; // 視聴者の煽りを出しておく長さ
const MEDDLE_PLAYER_GAP = 120; // プレイヤー側: 介入が続けて入らない最短間隔（フレーム）
const VIEWER_TAUNTS = [
    "視聴者「そこで被弾するの？ ｗ」",
    "視聴者「ボスもう笑ってるよ」",
    "視聴者「次は避けられるって信じてる（信じてない）」",
    "視聴者「画面見えてる？」",
    "視聴者「がんばれ〜（棒）」",
    "視聴者「それ、見えてたよね？」",
];

/* ============================================================================
 *  3. ORBS (色玉)
 *
 *  Each orb has:
 *    color : circle color
 *    name  : one-character color name shown in the legend
 *    hint  : vague text shown in the legend of the first selection
 *    apply : what happens when the player takes it
 *
 *  EXAMPLE - a new orb that gives 1 life:
 *    life1: { color: "#fd0", name: "黄", hint: "ちょっと.....",
 *             apply() { player.hp = Math.min(playerMaxHp, player.hp + 1); } },
 *  Then add "life1" to SELECT_ORBS (and/or the ORB_ORDER lists below).
 * ========================================================================== */
const ORBS = {
    // orange: reversed controls
    invert: {
        color: "#f93",
        name: "橙",
        hint: "なんだか世界が.....",
        apply() {
            invertTimer = INVERT_FRAMES;
        },
    },
    // red: you +2 hearts, boss HP up AND boss attack power up (damage taken rises to the mode's
    // redDmgMul, only if it is not already that high)
    heal: {
        color: "#f33",
        name: "赤",
        hint: "ボスが.....",
        apply() {
            player.hp = Math.min(playerMaxHp, player.hp + RED_PLAYER_HEAL);
            boss.hp = Math.min(
                boss.max,
                boss.hp + Math.round(boss.max * gameMode.bossHealRatio),
            );
            if (dmgMul < gameMode.redDmgMul) dmgMul = gameMode.redDmgMul; // attack power up (once)
        },
    },
    // blue: gag time (with confirmations)
    gag: {
        color: "#39f",
        name: "青",
        hint: "ちょっとした余興が.....",
        apply() {
            state = S.GAG;
            gagStep = 0;
            gagLock = 0;
            gagSwap = false;
            gagText = pick(GAG_TEXTS);
        },
    },
    // green: damage taken is doubled
    double: {
        color: "#3c3",
        name: "緑",
        hint: "痛みが.....",
        apply() {
            dmgMul = Math.max(dmgMul, 2); // never lowers a bigger multiplier (red = 3)
        },
    },
    // yellow: fight the form 1 boss, then return to the form you were in (see DETOUR_* above)
    back: {
        color: "#fd0",
        name: "黄",
        hint: "時間が.....",
        apply() {
            if (
                detour ||
                boss.hp <= 0 ||
                phase < DETOUR_MIN_FORM ||
                phase > gameMode.detourMaxForm
            )
                return; // no effect
            detourSave = { hp: boss.hp, max: boss.max, patIdx }; // restored when the form 1 boss is beaten
            detour = true;
            boss.hp = boss.max = BOSS_HP[0];
            bullets = []; // the attacks start over with form 1's first pattern
            beams = [];
            queue = [];
            patIdx = 0;
            patTime = 0;
        },
    },
    // purple: fake game over (longer each time), then invincibility when it ends
    fake: {
        color: "#a4f",
        name: "紫",
        hint: "終わった.....？",
        apply() {
            state = S.FAKE;
            fakeCount++;
            fakeTimer = Math.min(
                FAKE_WAIT_MAX_FRAMES,
                FAKE_WAIT_FRAMES + (fakeCount - 1) * FAKE_WAIT_ADD_FRAMES,
            );
        },
    },
};

// Orbs offered on the selection screen after every boss defeat, left to right
// (the colors stay in place, but which effect each color has changes every time, by a rule: see enterSelect() in script.js)
// The ORDER here is the number of each colour: 橙1 赤2 青3 緑4 紫5
const SELECT_ORBS = ["invert", "heal", "gag", "double", "fake"];

// Orbs that fall from the sky (the position is random, the order is fixed)
// (14 slots: red "heal" twice, purple "fake" twice, yellow "back" once)
const ORB_ORDER_MAIN = [
    "gag",
    "double",
    "fake",
    "invert",
    "back",
    "double",
    "heal",
    "gag",
    "invert",
    "heal",
    "fake",
    "double",
    "gag",
    "invert",
];
// Used by the "orbs" pattern: only the first 6 slots are ever used (one purple, one red).
const ORB_ORDER_PATTERN = ["gag", "double", "fake", "invert", "heal", "back"];

/* ============================================================================
 *  4. BULLET TYPES (弾の種類)
 *
 *  A bullet type is a preset. Use it like:   shoot("wall", x, y, angle, speed)
 *
 *  Available properties (all optional, defaults are in BULLET_DEFAULTS):
 *    r            radius in pixels
 *    color        CSS color
 *    delay        frames the bullet waits (drawn faint) before it starts moving
 *    path         name from PATHS (section 6): "straight", "homing", ...
 *    paces        list of names from PACES (section 5), always applied
 *    randomTempo  false -> never get a random stop/dash from RANDOM_TEMPO
 *  Any property can be overridden per shot:  shoot("normal", x, y, a, 3, { r: 9 })
 *
 *  EXAMPLE - a big slow green bullet that stops and goes by itself:
 *    bigGreen: { r: 10, color: "#3c3", paces: ["wave", "stopGo"], tempoAt: 30, tempoLen: 40 },
 * ========================================================================== */
const BULLET_DEFAULTS = {
    r: 5,
    color: "#f55",
    delay: 0,
    path: "straight",
    paces: ["wave"],
    randomTempo: true,
};

const BULLET_TYPES = {
    normal: {}, // red, the standard bullet
    yellow: { color: "#ff0" }, // yellow, used for the "different" shots
    cyan: { color: "#5cf" }, // used by the "follow" pattern
    aqua: { color: "#0ff" }, // used by the "fake homing" pattern
    // the big orange bullets of the wall. A whole ROW moves together (see wallPath / wallPace).
    wall: {
        r: 6,
        color: "#f80",
        path: "wallPath",
        paces: ["wallPace"],
        randomTempo: false,
    },
    homing: { r: 6, color: "#f6f", path: "homing", homeFrames: 80 }, // chases the player for a while
    trail: { r: 4, color: "#fa0", delay: 40 }, // left behind the player, appears later

    // ---- 理不尽 mode bullets (used by the forms 5-7 patterns). All of them have a FIXED timing
    // (randomTempo: false) so the player can learn them. ----
    // looks exactly like "normal", but at the last moment (age = lateAt) it aims at you once
    lateHome: {
        color: "#f55",
        path: "lateHome",
        lateAt: 40,
        randomTempo: false,
    },
    // flies, STOPS (holdLen frames), then every bullet of the volley sets off toward you together
    freeze: {
        r: 5,
        color: "#8cf",
        path: "freezeAim",
        paces: ["wave", "holdPace"],
        holdAt: 28,
        holdLen: 70,
        randomTempo: false,
    },
    // goes out, then turns around and comes back the same way (age = turnAt)
    boomerang: {
        r: 6,
        color: "#6f6",
        path: "boomerang",
        turnAt: 60,
        randomTempo: false,
    },
    // bursts into a small ring of normal bullets (age = splitAt)
    splitter: {
        r: 7,
        color: "#fc6",
        path: "splitter",
        splitAt: 60,
        randomTempo: false,
    },
    // big and slow
    big: { r: 11, color: "#e8e", randomTempo: false },
    // starts slow and keeps speeding up
    accel: { r: 5, color: "#9f9", paces: ["wave", "ramp"], randomTempo: false },
    // appears (faint) at its spawn point, and only starts moving after `delay` frames
    lag: { r: 5, color: "#ddd", delay: 35, randomTempo: false },
    // curves, and the curve gets weaker and weaker (pass { turn: -0.03 } to curve the other way)
    swirl: {
        r: 4,
        color: "#4fc",
        path: "swirlFade",
        turn: 0.03,
        randomTempo: false,
    },

    // ---- いろんな攻撃(練習モード専用)の弾: 一定速度・固定タイミング(randomTempo なし) ----
    v: { color: "#ff4169", paces: [], randomTempo: false }, // the standard bullet of these attacks
    vSmall: { r: 4, color: "#ff4169", paces: [], randomTempo: false },
    vHome: {
        r: 7,
        color: "#ff9b4d",
        path: "turnHome",
        homeFrames: 102,
        turnRate: 0.03,
        paces: [],
        randomTempo: false,
    },
    vBounce: {
        r: 5,
        color: "#f9e66b",
        path: "bounceEdge",
        life: 450, // was 300: longer life = more bounces = the whole field gets covered evenly
        paces: [],
        randomTempo: false,
    },
    vSplit: {
        r: 9,
        color: "#ff6fba",
        path: "splitN",
        splitAt: 63,
        splitN: 5,
        splitSpeed: 2.58,
        paces: [],
        randomTempo: false,
    },
    vDive: {
        r: 10,
        color: "#ff4169",
        path: "diveStop",
        stopLen: 21,
        paces: [],
        randomTempo: false,
    },
    vBack: {
        r: 5,
        color: "#ff4169",
        path: "boomerang",
        turnAt: 210, // frames before it turns back (was 66, then 130): now it flies out far (~500 px) first
        turnEdge: true, // ... but if it reaches the edge of the screen first, it turns there (it never leaves for good)
        paces: [],
        randomTempo: false,
    },
};

/* ============================================================================
 *  5. PACE (緩急: speed changes over a bullet's life)
 *
 *  A pace is a function that receives the bullet `b` and returns a speed factor:
 *    1 = normal speed, 0 = stopped, 2 = twice as fast.
 *  Useful fields of b:  b.age (frames since it appeared),
 *                       b.tempoAt / b.tempoLen (set by RANDOM_TEMPO)
 *  All paces of a bullet are multiplied together.
 *
 *  EXAMPLE - a bullet that starts fast and slows down over one second:
 *    fastStart: (b) => Math.max(0.4, 2 - b.age / 40),
 *  Then use it: put "fastStart" in a bullet type's `paces`, or in RANDOM_TEMPO.
 * ========================================================================== */
const PACES = {
    // smooth speed wave (applied to every bullet by default)
    wave: (b) => 1 + WAVE_AMP * Math.sin((2 * PI * b.age) / WAVE_PERIOD),

    // moves, stops for a while, then bursts forward and eases back to normal
    stopGo: (b) => {
        if (b.age < b.tempoAt) return 1;
        if (b.age < b.tempoAt + b.tempoLen) return 0;
        return 1 + 1.2 * Math.exp(-(b.age - b.tempoAt - b.tempoLen) / 30);
    },

    // creeps slowly, then suddenly dashes
    dash: (b) => (b.age < b.tempoAt ? 0.45 : 2.0),

    // example (not used yet): linearly slows down to 30% over one second
    slowDown: (b) => Math.max(0.3, 1 - b.age / 85),

    // freeze bullets: normal speed, then stopped for holdLen frames, then normal again
    holdPace: (b) =>
        b.age < b.holdAt ? 1 : b.age < b.holdAt + b.holdLen ? 0 : 1,

    // accel bullets: crawls at first, then speeds up to about twice the normal speed
    ramp: (b) => Math.min(2.2, 0.35 + b.age / 40),

    // wall bullets: the speed factor belongs to the ROW of the bullet (see wallStepOnce),
    // so a whole row speeds up / slows down together and rows never overtake each other
    wallPace: (b) => wallRowFactor(b),
};

/* ============================================================================
 *  6. PATHS (軌道: how the direction of a bullet changes)
 *
 *  A path is a function called once per frame BEFORE the bullet moves.
 *  It may change b.vx / b.vy (the velocity). Useful fields of b:
 *    b.x, b.y, b.vx, b.vy, b.speed (the base speed), b.age
 *  Extra numbers can be passed per shot:  shoot("normal", ..., { path: "curve", turn: 0.02 })
 *
 *  EXAMPLE - a bullet that drifts to the right more and more:
 *    drift: (b) => { b.vx += 0.01; },
 * ========================================================================== */
const PATHS = {
    // goes straight (nothing to do)
    straight: () => {},

    // ---- いろんな攻撃(練習モード専用)の軌道 ----
    // turnHome: chases the player but can only turn `turnRate` radians per frame, for `homeFrames` frames
    turnHome: (b) => {
        if (b.age >= b.homeFrames) return;
        const want = aim(b.x, b.y);
        const cur = Math.atan2(b.vy, b.vx);
        const d = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        const na = cur + Math.max(-b.turnRate, Math.min(b.turnRate, d));
        const v = Math.hypot(b.vx, b.vy);
        b.vx = Math.cos(na) * v;
        b.vy = Math.sin(na) * v;
    },

    // bounceEdge: bounces off all four edges of the screen, disappears after `life` frames
    bounceEdge: (b) => {
        if (b.age > b.life) {
            b.x = -999; // moving far away removes it (same trick as "splitter")
            return;
        }
        if (b.x < b.r) b.vx = Math.abs(b.vx);
        if (b.x > W - b.r) b.vx = -Math.abs(b.vx);
        if (b.y < b.r) b.vy = Math.abs(b.vy);
        if (b.y > H - b.r) b.vy = -Math.abs(b.vy);
    },

    // diveStop: falls slowly, stops at y = stopY for `stopLen` frames, then drops straight down at `diveV`
    diveStop: (b) => {
        if (b.stopAge === undefined) {
            if (b.y >= b.stopY) {
                b.stopAge = 0;
                b.vx = 0;
                b.vy = 0;
            }
        } else if (b.stopAge >= 0) {
            b.stopAge++;
            if (b.stopAge > b.stopLen) {
                b.stopAge = -1; // diving: nothing more to do
                b.vy = b.diveV;
            }
        }
    },

    // splitN: at age = splitAt it bursts into `splitN` small bullets (speed `splitSpeed`)
    splitN: (b) => {
        if (b.age === b.splitAt) {
            const x = b.x,
                y = b.y;
            const n = b.splitN,
                sp = b.splitSpeed;
            b.x = -999;
            later(1, () => vRing("vSmall", x, y, n, sp, 0));
        }
    },

    // aims at the player for `homeFrames` frames, then goes straight
    homing: (b) => {
        if (b.homeFrames > 0) {
            b.homeFrames--;
            const a = aim(b.x, b.y);
            b.vx = Math.cos(a) * b.speed;
            b.vy = Math.sin(a) * b.speed;
        }
    },

    // pushes sideways: use { path: "sideAccel", accelX: 0.015 } (negative = left)
    sideAccel: (b) => {
        b.vx += b.accelX;
    },

    // wall bullets always fall at the same base speed (the current speed multiplier included)
    wallPath: (b) => {
        b.vx = 0;
        b.vy = WALL_SPEED * speedMul;
    },

    // lateHome: once, at age = lateAt, aims at the player (a bit faster), then goes straight
    lateHome: (b) => {
        if (b.age === b.lateAt) {
            const a = aim(b.x, b.y);
            b.vx = Math.cos(a) * b.speed * 1.15;
            b.vy = Math.sin(a) * b.speed * 1.15;
        }
    },

    // freezeAim: when the stop ends (age = holdAt + holdLen) it aims at where the player is NOW
    freezeAim: (b) => {
        if (b.age === b.holdAt + b.holdLen) {
            const a = aim(b.x, b.y);
            b.vx = Math.cos(a) * b.speed * 1.3;
            b.vy = Math.sin(a) * b.speed * 1.3;
        }
    },

    // boomerang: reverses the direction once, at age = turnAt
    boomerang: (b) => {
        if (b.turned) return;
        // turnEdge: also turn when it gets near the edge of the screen (otherwise it would leave before turning)
        const atEdge = b.turnEdge && (b.x < 8 || b.x > W - 8 || b.y < 8 || b.y > H - 8);
        if (b.age === b.turnAt || atEdge) {
            b.turned = true;
            b.vx = -b.vx;
            b.vy = -b.vy;
        }
    },

    // splitter: at age = splitAt the bullet disappears and 8 small bullets fly out of that spot.
    // (A path cannot add bullets directly, so later() is used; moving b.x far away removes this one.)
    splitter: (b) => {
        if (b.age === b.splitAt) {
            const x = b.x,
                y = b.y,
                a = aim(x, y);
            b.x = -999;
            later(1, () => ring("normal", x, y, 8, 1.8, a, { r: 4 })); // the ring speed after the burst
        }
    },

    // swirlFade: like "curve", but `turn` shrinks every frame, so the bullet bends once and then flies straight
    swirlFade: (b) => {
        const c = Math.cos(b.turn),
            s = Math.sin(b.turn);
        const vx = b.vx * c - b.vy * s;
        b.vy = b.vx * s + b.vy * c;
        b.vx = vx;
        b.turn *= 0.98;
    },

    // turns by `turn` radians every frame: use { path: "curve", turn: 0.02 }
    curve: (b) => {
        const c = Math.cos(b.turn),
            s = Math.sin(b.turn);
        const vx = b.vx * c - b.vy * s;
        b.vy = b.vx * s + b.vy * c;
        b.vx = vx;
    },
};

/* ============================================================================
 *  7. ATTACK PATTERNS (攻撃パターン)
 *
 *  A pattern is { duration, run(t) }:
 *    duration : how many frames the pattern lasts
 *    waitClear: (optional) a bullet type name. After `duration` ends, the next step does not
 *               start until no bullet of that type is left on the screen
 *    run(t)   : called every frame, t = frames since the pattern started (0, 1, 2 ...)
 *
 *  TOOLS you can call inside run(t):
 *    shoot(type, x, y, angle, speed, opts)      one bullet
 *    bossShot(type, angle, speed, opts)         one bullet from the boss
 *    bossRing(type, count, speed, offset, opts) a ring of bullets from the boss
 *    ring(type, x, y, count, speed, offset, opts)
 *    beam({ x, y, angle, turn, warn, dur, width, bounces })
 *    later(frames, fn)                          run fn after some frames
 *    aim(x, y)                                  angle from (x, y) to the player
 *    aimFromBoss()                              angle from the boss to the player
 *    spawnOrb(id)                               drop an orb from the sky
 *  and these values: t, W (screen width), H, CX (screen center x), boss, player, PI
 *
 *  Angles are in radians: 0 = right, PI/2 = down, PI = left, -PI/2 = up.
 *
 *  EXAMPLE - 12 yellow bullets in a ring every second, for 5 seconds:
 *    mine: {
 *        duration: 300,
 *        run(t) {
 *            if (t % 60 === 0) bossRing("yellow", 12, 2.5, t * 0.1);
 *        },
 *    },
 *  Then add "mine" to a list in SEQUENCES below.
 * ========================================================================== */
const GAP_HALF = 40; // wall pattern: half width of the safe gap in pixels
const WALL_SPEED = 2.8; // wall pattern: base fall speed (pixels per frame)
// The wall can never move faster than this (pixels per frame), however many tempo events / orbs stack up.
// Why: the gap shifts sideways by up to WALL_GAP_SLOPE * 150 px per row, and rows arrive every
// WALL_ROW_SPACING / speed frames. At 4.6 px/frame and 0.3 that is about 3 px/frame of sideways
// movement needed, which is below the player speed (PLAYER_SPEED = 4), so the wall stays dodgeable.
const WALL_MAX_V = 4.6;
const WALL_GAP_SLOPE = 0.3; // how fast the gap swings from row to row (smaller = gentler)
const WALL_ROW_SPACING = 68; // wall pattern: distance between rows in pixels (always kept)
// The wall of 理不尽モード / RLモード (流れる → 突然停止 → 急降下 → 画面外で消去):
//   1. every row flows down at a constant speed (WALL_SPEED)
//   2. when the lowest flowing row reaches WALL_STOP_Y, ALL rows stop at the same moment (WALL_STOP_FRAMES = 0.6 s)
//   3. then ALL rows drop straight down together at WALL_DASH_V, keeping their shape and spacing
//   4. bullets that left the screen are deleted at once (updateBullets), and so are their rows
// Why the dash stays dodgeable: the stopped wall stands still for 0.6 s, so the player can see the gaps and
// line up before the dash starts, and the gap is 80 px wide (the numbers are explained at WALL_GAP_AMP_DASH).
const WALL_MIN_ROW_GAP = 56; // rows never come closer than this (a bit less than WALL_ROW_SPACING = 68)
const WALL_STOP_Y = [330, 430]; // the wall stops when its lowest row reaches a y inside this range (random each time)
const WALL_STOP_FRAMES = 36; // how long the wall stands still (0.6 s)
const WALL_DASH_V = 7; // px per frame while dropping (the flowing wall is slower, see WALL_MAX_V)
// The gap of this wall bends strongly: it shifts sideways by up to WALL_GAP_AMP_DASH * WALL_GAP_SLOPE_DASH
// = 100 * 0.45 = 45 px from row to row (about 33 degrees). Rows pass the player 68 / 7 = 9.7 frames apart, so on
// paper that needs 4.6 px/frame (the player moves 4), but the gap is 80 px wide, which gives the player slack.
// Measured with tools/smoke-test.js: a player who only follows the gaps at 3 px/frame (75% of the top speed)
// is never hit. Going further breaks it (at a drop speed of 7): 50 px/row hits a 3 px/frame follower, 55 px/row
// even hits a 3.4 px/frame one.
// A faster drop (WALL_DASH_V) needs a smaller shift: 9 px/frame with 36 px/row is the same level of safety.
const WALL_GAP_AMP_DASH = 100; // how far the gap swings to the left / right (px, at 480 px width)
const WALL_GAP_SLOPE_DASH = 0.45; // how fast the gap bends from row to row
// whole-wall tempo events (used by 通常モード only, see below)
const WALL_EVENTS = [
    { kind: "stop", weight: 1, len: [25, 55] }, // the row stops for `len` frames, then bursts forward
    { kind: "dash", weight: 1, slow: [25, 45], len: [30, 45] }, // creeps for `slow`, then dashes for `len`
];

let wallList = []; // the rows on the screen, the oldest (lowest) first: { y, idx, f, mode: flow|stop|dash, stopStart, dashStart }
let wallStopY = 380; // where the next stop happens
let wallRows = 0; // rows fired so far in this pattern
let wallCount = 0; // orange walls started in this run (reset by resetGame); only used when the mode has wallVariety
let wallWave = true; // how the wall on the screen moves: true = rowWave style, false = 通常モード style (wallVariety modes)
// Does the wall move the 理不尽 way (rows flow -> stop -> drop together, true) or the 通常モード way (the whole wall
// speeds up / slows down together, false)? Normally that is the mode's rowWave; with wallVariety it is decided each
// time a wall starts (wallPickStyle).
const wallIsWave = () => (gameMode.wallVariety ? wallWave : gameMode.rowWave);
function wallPickStyle() {
    if (!gameMode.wallVariety) return;
    wallCount++;
    wallWave =
        wallCount === 1 ? true : wallCount === 2 ? false : Math.random() < 0.5;
}
let wallStepFrame = -1; // the frame in which the rows were last moved (they move once per frame)
// 通常モード (mode.rowWave = false): the WHOLE wall shares one speed wave and stops / dashes together
// (the old behaviour), so no row is ever faster or slower than another.
const WALL_EVENT_GAP = [50, 110]; // frames between two whole-wall tempo events
let wallEvent = null; // the whole-wall tempo event in progress: { kind, start, slow, len }
let wallNextEvent = 0; // frame when the next whole-wall event starts
let wallFiring = false; // the pattern is still firing rows (new whole-wall events start only then)
function startWallEvent() {
    let roll = Math.random() * WALL_EVENTS.reduce((s, e) => s + e.weight, 0);
    const def =
        WALL_EVENTS.find((e) => (roll -= e.weight) < 0) || WALL_EVENTS[0];
    const slow = def.slow ? rand(...def.slow) : 0;
    const len = rand(...def.len);
    wallEvent = { kind: def.kind, start: frame, slow, len };
    wallNextEvent = frame + slow + len + rand(...WALL_EVENT_GAP);
}
function wallSyncFactor() {
    if (wallFiring && frame >= wallNextEvent) startWallEvent();
    let f = 1 + WAVE_AMP * Math.sin((2 * PI * frame) / WAVE_PERIOD);
    const e = wallEvent;
    if (e) {
        const dt = frame - e.start;
        if (e.kind === "stop") {
            if (dt < e.len) f = 0;
            else f *= 1 + 1.2 * Math.exp(-(dt - e.len) / 30);
        } else if (dt < e.slow) f *= 0.45;
        else if (dt < e.slow + e.len) f *= 2.0;
    }
    return f;
}

// flow -> stop -> dash for the whole group of rows at once
function wallGroupStep() {
    const stopped = wallList.filter((r) => r.mode === "stop");
    if (stopped.length) {
        if (frame - stopped[0].stopStart >= WALL_STOP_FRAMES) {
            for (const r of stopped) {
                r.mode = "dash"; // all rows drop at the same moment
                r.dashStart = frame;
            }
        }
        return;
    }
    const flowing = wallList.filter((r) => r.mode === "flow");
    if (flowing.length && flowing[0].y >= wallStopY) {
        for (const r of flowing) {
            r.mode = "stop"; // all rows stop at the same moment
            r.stopStart = frame;
        }
        wallStopY = rand(...WALL_STOP_Y);
    }
}

// Moves every row by this frame's distance and stores it as row.f (the speed factor of its bullets).
// Called from wallRun() and from the bullets' pace, so the rows keep moving after the pattern is over.
function wallStepOnce() {
    if (wallStepFrame === frame) return;
    wallStepFrame = frame;
    const base = WALL_SPEED * speedMul;
    const cap = WALL_MAX_V / base; // speed cap (see WALL_MAX_V)
    let frontY = Infinity; // y of the row in front of this one
    const rowWave = wallIsWave(); // false: every row gets the same factor (通常モード)
    const syncF = rowWave ? 1 : wallSyncFactor();
    if (rowWave) wallGroupStep();
    for (const r of wallList) {
        let f = syncF;
        let dashing = false;
        if (rowWave) {
            if (r.mode === "stop") f = 0;
            else if (r.mode === "dash") dashing = true;
            else f = 1; // flowing: a constant speed
        }
        let d = dashing ? WALL_DASH_V : base * Math.min(f, cap);
        d = Math.max(0, Math.min(d, frontY - WALL_MIN_ROW_GAP - r.y)); // never pass / touch the row in front
        r.f = d / base;
        r.y += d;
        frontY = r.y;
    }
    wallList = wallList.filter((r) => r.y < H + 30);
}
// the pace of a wall bullet = the speed factor of its row
function wallRowFactor(b) {
    wallStepOnce();
    return b.row ? b.row.f : 1;
}
function newWallRow() {
    return {
        y: -8,
        idx: wallRows,
        f: 0,
        mode: "flow",
        stopStart: 0,
        dashStart: null,
    }; // f = 0: it starts to move next frame
}

// The wall pattern as a function: dir = 1 sweeps the gap to the right first, dir = -1 (mirrored) to the left first.
function wallRun(t, dir) {
    if (t === 0) {
        wallPickStyle(); // 1st wall of the run: as is / 2nd: 通常モード way / after that: random
        wallRows = 0;
        if (!bullets.some((b) => b.type === "wall")) wallList = []; // forget rows whose bullets are gone
        wallEvent = null;
        wallNextEvent = frame + rand(...WALL_EVENT_GAP);
        wallStopY = rand(...WALL_STOP_Y);
    }
    wallFiring = t < 340;
    wallStepOnce();
    if (t >= 340) return;
    const newest = wallList[wallList.length - 1];
    if (newest && newest.y < -8 + WALL_ROW_SPACING) return; // the next row is fired when the last one has moved far enough
    // A wider screen gets a larger but slower sweep, so the gap speed stays dodgeable.
    const slope = wallIsWave() ? WALL_GAP_SLOPE_DASH : WALL_GAP_SLOPE;
    const amp = wallIsWave() ? WALL_GAP_AMP_DASH : 150;
    const gap =
        CX + dir * Math.sin(wallRows * slope * (480 / W)) * amp * (W / 480);
    const shift = wallRows % 2 ? 12 : 0;
    const row = newWallRow();
    row.gap = gap; // where the gap of this row is (only used by tools/smoke-test.js)
    wallList.push(row);
    for (let x = 10 + shift; x < W; x += 24) {
        if (Math.abs(x - gap) > GAP_HALF)
            shoot("wall", x, row.y, PI / 2, WALL_SPEED, { row });
    }
    wallRows++;
}

// ---- state of the 理不尽 patterns "habit" (行動記録) and "camper" (同じ場所禁止) ----
let habitSide = 0; // side (-1 left / +1 right) at the last check, 0 = no check yet
let habitSame = 0; // checks in a row on the same side
let habitFlip = 0; // side changes in a row
let camperN = 0; // checks in a row where the player barely moved
let habitYSide = 0; // same as habitSide, for the top / bottom halves (pattern "habitY")
let habitYSame = 0;
let habitYFlip = 0;

// "habit": the boss watches which half of the screen you stand in. These rules are FIXED:
//   - same half at 2 checks in a row  -> that half gets sealed by vertical beams
//   - left/right/left (2 switches)    -> the half you are about to go to gets sealed
// sealing = vertical beams (80 px apart, gaps of 44 px) over one half; the warning lasts 1 second.
// Like the other beam patterns, the positions swap every second time (A, B, A, B ...):
//   A: 40 / 120 / 200 px from the center, B: 80 / 160 / 240 px (shifted by 40 px, the last one is at the wall).
let sealAlt = false; // false = A, true = B (flips on every seal, also across plays)
function sealSide(side) {
    const start = sealAlt ? 80 : 40;
    for (let d = start; d < W / 2 + (sealAlt ? 1 : 0); d += 80)
        beam({
            x: CX + side * d,
            y: 0,
            angle: PI / 2,
            warn: 60,
            dur: 40,
            width: 36,
        });
    sealAlt = !sealAlt;
}

// Beam patterns that start from the same positions every time are easy to memorise. So every beam pattern
// remembers how often it was played and swaps its positions every second time (A, B, A, B ...).
// beamAlt(name, t) is false for the 1st, 3rd, ... play and true for the 2nd, 4th, ... play. Call it every frame.
const beamAltState = {};
function beamAlt(name, t) {
    const s =
        beamAltState[name] || (beamAltState[name] = { plays: 0, alt: false });
    if (t === 0) {
        s.alt = s.plays % 2 === 1;
        s.plays++;
    }
    return s.alt;
}

// Horizontal version of sealSide: horizontal beams over the top (side = -1) or bottom (side = +1) half.
// Same spacing / width / warning as sealSide, and it also swaps its positions every time (A, B, A, B ...):
//   A: 40 / 120 / 200 / 280 px from the middle line, B: 80 / 160 / 240 / 320 px (the last one is at the screen edge).
let sealYAlt = false;
function sealHalfY(side) {
    const start = sealYAlt ? 80 : 40;
    for (let d = start; d < H / 2 + (sealYAlt ? 1 : 0); d += 80)
        beam({
            x: 0,
            y: H / 2 + side * d,
            angle: 0,
            warn: 60,
            dur: 40,
            width: 36,
        });
    sealYAlt = !sealYAlt;
}

/* ----------------------------------------------------------------------------
 *  攻撃タイムライン（第4形態専用 /beta）  別名: 連続攻撃シーケンス / 攻撃キュー
 *
 *  予告線(warn)とビーム(beam)を「別々の攻撃要素」として並べ、書いた順に連続して発生させる。
 *  各要素は自分のタイミングで始まり、前の要素が終わる前に次が始まってもよい（重なる）。
 *
 *    例:  予告線1 → 予告線2 → ビーム1 → 予告線3 → ビーム2 → ビーム3
 *
 *  要素の種類（kind）:
 *    warn  予告線。vis フレームだけ表示されて消える。当たり判定なし
 *    beam  ビーム。dur フレームだけ出る。ref に予告線の id を書くと「その予告線が出た位置」に出る
 *    do    その瞬間に fn(t) を呼ぶ（弾を撃つなど）
 *
 *  開始タイミング（上から順に、どれか1つ）:
 *    at: 30           パターン開始から30フレーム後
 *    after: "w1"      id が "w1" の要素が終わってから（gap フレーム後）
 *    gap: 25          1つ前の要素が「始まって」から25フレーム後（省略時 0 = 同時）
 *
 *  geom() は発射の瞬間に呼ばれ { x, y, angle, width, bounces } を返す。
 *  予告線の位置はその時点で固定されるので、自機を狙う線は「予告線が出た時の自機位置」に出る。
 * -------------------------------------------------------------------------- */
function attackTimeline(events, tail = 20) {
    const refs = {}; // 予告線が出た位置（beam の ref から参照される）
    const ends = {}; // id -> その要素が終わるフレーム
    let prevStart = 0;
    const list = events.map((e) => {
        let start;
        if (e.at !== undefined) start = e.at;
        else if (e.after) {
            if (ends[e.after] === undefined)
                throw new Error(
                    'attackTimeline: after "' +
                        e.after +
                        '" は先に書いた id である必要があります',
                );
            start = ends[e.after] + (e.gap || 0);
        } else start = prevStart + (e.gap || 0);
        const len = e.kind === "warn" ? e.vis : e.kind === "beam" ? e.dur : 0;
        if (e.id) ends[e.id] = start + len;
        prevStart = start;
        return { ...e, start, end: start + len };
    });
    const fireOne = (e, t) => {
        if (e.kind === "do") return e.fn(t);
        const saved = e.kind === "beam" && e.ref ? refs[e.ref] : null;
        const g = saved || e.geom();
        if (e.kind === "warn") {
            if (e.id) refs[e.id] = g;
            beam({ ...g, warn: e.vis, warnVis: e.vis, dur: 0 }); // 表示だけ（vis フレームで消える）
        } else {
            beam({ ...g, warn: 0, warnVis: -1, dur: e.dur }); // 予告なしで即ビーム（予告線は別要素）
        }
    };
    return {
        duration: Math.max(...list.map((e) => e.end)) + tail,
        run(t) {
            if (t === 0) for (const k in refs) delete refs[k];
            for (const e of list) if (e.start === t) fireOne(e, t);
        },
    };
}

// 第4形態のタイムライン一式。
//   vis   = 予告線が見えているフレーム数（60フレーム = 約1秒）
//   wait  = 予告線が消えてから、ビームが出るまでのフレーム数（予告線の位置を覚えて待つ）
//   shots = 待っている間に自機狙いの弾を撃つか
function form4Patterns(sfx, vis, wait, shots) {
    // geom の部品（CX / boss / player は発射の瞬間に読む）
    const V = (dx, w) => () => ({ x: CX + dx, y: 0, angle: PI / 2, width: w }); // 縦ビーム（中央からdx）
    const Hz = (y, w) => () => ({ x: 0, y, angle: 0, width: w }); // 横ビーム
    const B =
        (f, w, bounces = 0) =>
        () => ({
            x: boss.x,
            y: boss.y + BOSS_MUZZLE_Y,
            angle: PI * f,
            width: w,
            bounces,
        }); // ボスから角度 PI*f（反射 bounces 回）
    const PV = (w) => () => ({ x: player.x, y: 0, angle: PI / 2, width: w }); // 自機の縦線
    const PH = (w) => () => ({ x: 0, y: player.y, angle: 0, width: w }); // 自機の横線
    const PA = (w) => () => ({
        x: boss.x,
        y: boss.y + BOSS_MUZZLE_Y,
        angle: aim(boss.x, boss.y + BOSS_MUZZLE_Y, player),
        width: w,
        bounces: 0,
    }); // ボスから自機への直線
    // 要素
    const warn = (id, geom, gap = 25) => ({ kind: "warn", id, geom, vis, gap });
    const blast = (id, ref, dur = 40) => ({
        kind: "beam",
        id,
        ref,
        dur,
        after: ref,
        gap: wait,
    }); // ref の予告線が消えて wait フレーム後に出る
    const aimShot = () => bossShot("normal", aimFromBoss(), 2.6);
    // 待ち時間の間に弾を4発（予告線を出し終わってから 1秒おき）
    const waitShots = () =>
        shots
            ? [60, 60, 60, 60].map((gap) => ({ kind: "do", gap, fn: aimShot }))
            : [];
    // 予告線5本 → 待ち時間 → ビーム5本、の形
    const five = (geoms, dur = 40) => [
        ...geoms.map((g, i) => warn("w" + i, g, i ? undefined : 0)),
        ...waitShots(),
        ...geoms.map((g, i) => blast("b" + i, "w" + i, dur)),
    ];

    return {
        // 縦3本・横2本の格子
        ["seqCross" + sfx]: attackTimeline(
            five([V(-150, 34), Hz(200, 34), V(150, 34), Hz(400, 34), V(0, 34)]),
        ),
        // ボスから扇状に5本
        ["seqFan" + sfx]: attackTimeline(
            five([
                B(0.2, 26),
                B(0.35, 26),
                B(0.5, 26),
                B(0.65, 26),
                B(0.8, 26),
            ]),
        ),
        // 壁で3回反射するビーム4本 + まっすぐ下へ1本
        ["seqReflect" + sfx]: attackTimeline(
            five(
                [
                    B(0.25, 14, 3),
                    B(0.75, 14, 3),
                    B(0.5, 18),
                    B(0.35, 14, 3),
                    B(0.65, 14, 3),
                ],
                55,
            ),
        ),
        // 予告線が出た瞬間の自機位置を狙う（動き続けないと意味がない）
        ["seqAim" + sfx]: attackTimeline(
            five([PV(26), PH(26), PA(22), PV(26), PH(26)]),
        ),
        // 縦ビームで左右を封鎖 + 真ん中 + 横2本
        ["seqCage" + sfx]: attackTimeline(
            five(
                [V(-180, 50), V(180, 50), V(0, 80), Hz(220, 34), Hz(420, 34)],
                45,
            ),
        ),
    };
}

const PATTERNS = {
    // fan shots; from the 4th volley the shots bend sideways
    rep: {
        duration: 260,
        run(t) {
            if (t % 60 !== 0 || t >= 240) return;
            const count = t / 60,
                a = aimFromBoss();
            for (let i = -4; i <= 4; i++) {
                if (count < 3) bossShot("normal", a + i * 0.17, 3);
                else
                    bossShot("yellow", a + i * 0.17, 2.8, {
                        path: "sideAccel",
                        accelX: i % 2 ? 0.015 : -0.015,
                    });
            }
        },
    },

    // a bullet that appears where you dodged to, a moment later
    follow: {
        duration: 300,
        run(t) {
            if (t % 100 === 0) {
                shoot("cyan", W + 8, player.y, PI, 4.2);
                later(28, () => shoot("cyan", -8, player.y, 0, 4.6));
            }
            if (t % 100 === 50) {
                shoot("cyan", player.x, -8, PI / 2, 4.2);
                later(28, () => shoot("cyan", player.x, H + 8, -PI / 2, 4.6));
            }
        },
    },

    // a wall of bullets with a moving gap. Odd rows are shifted (checkerboard).
    // Rows are fired by distance (WALL_ROW_SPACING); every row has its own speed wave (see wallStepOnce).
    wall: {
        duration: 360,
        waitClear: "wall", // the next step (beams etc.) waits until every "wall" bullet has left the screen
        run(t) {
            wallRun(t, 1);
        },
    },

    // a warning line, then a beam; plus rings
    beam: {
        duration: 260,
        run(t) {
            if (t === 10 || t === 130)
                beam({
                    x: player.x,
                    y: 0,
                    angle: PI / 2,
                    warn: 50,
                    dur: 30,
                    width: 18,
                });
            if (t % 40 === 0) bossRing("normal", 10, 2.2, t);
        },
    },

    // homing bullets from the left and right
    home: {
        duration: 330,
        run(t) {
            if (t % 50 !== 0 || t >= 250) return;
            const x = t % 100 ? CX + 120 : CX - 120;
            shoot("homing", x, 100, aim(x, 100), 2.4);
        },
    },

    // bullets are left where you walk
    trail: {
        duration: 300,
        run(t) {
            if (t % 8 === 0) shoot("trail", player.x, player.y, PI / 2, 1.5);
            if (t % 70 === 0)
                bossShot("homing", aimFromBoss(), 2.4, { homeFrames: 60 });
        },
    },

    // vertical beams (the gaps move) with a few horizontal beams in between
    vbeam: {
        duration: 300,
        run(t) {
            const alt = beamAlt("vbeam", t); // every second play: the two waves and the horizontal beams swap places
            if (t === 0 || t === 150) {
                const offset = (t ? 40 : 0) ^ (alt ? 40 : 0); // 0 / 40 first, then the other one
                // beams across the whole width (6 beams when W = 480)
                const n = Math.floor(W / 80),
                    x0 = (W - (n - 1) * 80) / 2;
                for (let i = 0; i < n; i++)
                    beam({
                        x: x0 + i * 80 + offset,
                        y: 0,
                        angle: PI / 2,
                        warn: 70,
                        dur: 40,
                        width: 36,
                    });
            }
            // 3 horizontal beams per wave, fired between the vertical waves
            if (t === 70 || t === 210) {
                const ys =
                    (t === 70) !== alt ? [180, 340, 500] : [260, 420, 580];
                for (const y of ys)
                    beam({ x: 0, y, angle: 0, warn: 50, dur: 40, width: 36 });
            }
            if (t % 45 === 20) bossShot("normal", aimFromBoss(), 3);
        },
    },

    // beams that bounce off the side walls (the angle is fixed)
    refl: {
        duration: 330,
        run(t) {
            const alt = beamAlt("refl", t); // every second play: the two volleys swap places
            if (t === 0 || t === 150) {
                for (const f of (t === 0) !== alt ? [0.35, 0.65] : [0.2, 0.8])
                    beam({
                        x: boss.x,
                        y: boss.y + BOSS_MUZZLE_Y,
                        angle: PI * f,
                        warn: 60,
                        dur: 70,
                        width: 12,
                        bounces: 3,
                    });
            }
            if (t % 60 === 30) bossRing("normal", 12, 2, t);
        },
    },

    // the fan again, but the last volley is faster, then a ring
    rep2: {
        duration: 260,
        run(t) {
            if (t % 60 !== 0 || t >= 240) return;
            const count = t / 60,
                a = aimFromBoss(),
                early = count < 3;
            for (let i = -4; i <= 4; i++)
                bossShot(
                    early ? "normal" : "yellow",
                    a + i * 0.17,
                    early ? 3 : 4.4,
                );
            if (count === 3) later(20, () => bossRing("yellow", 14, 2.4, 0));
        },
    },

    // fake homing: aims where you were a moment ago
    fake: {
        duration: 300,
        run(t) {
            if (t % 40 === 0)
                bossShot(
                    "aqua",
                    aim(boss.x, boss.y + BOSS_MUZZLE_Y, history[0] || player),
                    3.6,
                );
            if (t % 90 === 45) bossRing("normal", 8, 2, 0);
        },
    },

    // a slowly rotating beam plus rings
    rot: {
        duration: 320,
        run(t) {
            const alt = beamAlt("rot", t); // every second play: the mirror image (starts on the other side, turns the other way)
            if (t === 0)
                beam({
                    x: boss.x,
                    y: boss.y + BOSS_MUZZLE_Y,
                    angle: alt ? PI - 0.2 : 0.2,
                    turn: alt ? -0.011 : 0.011,
                    warn: 40,
                    dur: 260,
                    width: 22,
                });
            if (t % 30 === 0) bossRing("normal", 6, 2.3, t * 0.07);
        },
    },

    // orbs mixed into the bullets
    orbs: {
        duration: 320,
        run(t) {
            if (t % 50 === 0 && t < 300)
                spawnOrb(
                    ORB_ORDER_PATTERN[(t / 50) % ORB_ORDER_PATTERN.length],
                );
            if (t % 45 === 0) bossRing("normal", 8, 2.1, t);
        },
    },

    /* ======================================================================
     *  理不尽モード patterns (forms 5-7). Every one has a fixed rule, so it can be learned.
     * ==================================================================== */

    // 四連偽装: the fan looks the same 4 times, but the 4th volley bends toward you at the last moment
    rep3: {
        duration: 300,
        run(t) {
            if (t % 60 !== 0 || t >= 240) return;
            const a = aimFromBoss();
            for (let i = -4; i <= 4; i++)
                bossShot(t / 60 < 3 ? "normal" : "lateHome", a + i * 0.17, 3);
        },
    },

    // 逆パターン: the same wall as form 1, but the gap sweeps to the LEFT first
    wallR: {
        duration: 360,
        waitClear: "wall",
        run(t) {
            wallRun(t, -1);
        },
    },

    // 停止弾: a ring that stops in mid-air, then every bullet flies at you together
    freezeRing: {
        duration: 300,
        run(t) {
            if (t % 120 === 0 && t < 240) bossRing("freeze", 14, 3, t * 0.05);
            if (t % 50 === 25) bossRing("normal", 8, 2, 0);
        },
    },

    // 往復弾: a bullet sweeps across at your height from alternating sides, then comes back
    boom: {
        duration: 300,
        run(t) {
            if (t % 90 === 0 && t < 270) {
                const left = (t / 90) % 2 === 0;
                shoot(
                    "boomerang",
                    left ? -8 : W + 8,
                    player.y,
                    left ? 0 : PI,
                    4.2,
                );
            }
            if (t % 60 === 30) bossShot("normal", aimFromBoss(), 3);
        },
    },

    // 分裂弾: a bullet that bursts into a ring
    burst: {
        duration: 300,
        run(t) {
            if (t % 70 === 0 && t < 240)
                bossShot("splitter", aimFromBoss(), 2.0);
            if (t % 90 === 45) bossRing("normal", 8, 2, t * 0.1);
        },
    },

    // 圧力: big slow bullets in 3 columns, plus bullets that start slow and speed up
    pressure: {
        duration: 320,
        run(t) {
            if (t % 60 === 0 && t < 260)
                for (const dx of [-110, 0, 110])
                    shoot(
                        "big",
                        boss.x + dx,
                        boss.y + BOSS_MUZZLE_Y,
                        PI / 2,
                        1.6,
                    );
            if (t % 45 === 0) bossShot("accel", aimFromBoss(), 3);
        },
    },

    // 包囲: 6 faint bullets appear around you; 35 frames later they fly to where you WERE
    surround: {
        duration: 320,
        run(t) {
            if (t % 80 !== 0 || t >= 260) return;
            const px = player.x,
                py = player.y;
            for (let i = 0; i < 6; i++) {
                const a = t * 0.01 + (i * PI) / 3;
                const x = Math.max(8, Math.min(W - 8, px + Math.cos(a) * 110));
                const y = Math.max(8, Math.min(H - 8, py + Math.sin(a) * 110));
                shoot("lag", x, y, Math.atan2(py - y, px - x), 2.6);
            }
        },
    },

    // 渦: rings of bullets that bend (alternating left / right)
    swirl: {
        duration: 300,
        run(t) {
            if (t % 30 === 0 && t < 270)
                bossRing("swirl", 8, 2.6, t * 0.2, {
                    turn: (t / 30) % 2 ? 0.03 : -0.03,
                });
        },
    },

    // 行動記録 (see sealSide above): checked every 80 frames
    habit: {
        duration: 360,
        run(t) {
            if (t === 0) {
                habitSide = 0;
                habitSame = 0;
                habitFlip = 0;
            }
            if (t % 60 === 20 && t < 300) bossShot("normal", aimFromBoss(), 3);
            if (t % 80 !== 40 || t >= 320) return;
            const side = player.x < CX ? -1 : 1;
            if (habitSide !== 0) {
                if (side === habitSide) {
                    habitSame++;
                    habitFlip = 0;
                } else {
                    habitFlip++;
                    habitSame = 0;
                }
            }
            habitSide = side;
            if (habitSame >= 1)
                sealSide(side); // stayed on one side
            else if (habitFlip >= 2) sealSide(-side); // keeps switching sides: seal where you go next
        },
    },

    // 行動記録・横 (form 7): the same rules as "habit", but it watches the top / bottom half and seals with horizontal beams
    habitY: {
        duration: 360,
        run(t) {
            if (t === 0) {
                habitYSide = 0;
                habitYSame = 0;
                habitYFlip = 0;
            }
            if (t % 60 === 20 && t < 300) bossShot("normal", aimFromBoss(), 3);
            if (t % 80 !== 40 || t >= 320) return;
            const side = player.y < H / 2 ? -1 : 1;
            if (habitYSide !== 0) {
                if (side === habitYSide) {
                    habitYSame++;
                    habitYFlip = 0;
                } else {
                    habitYFlip++;
                    habitYSame = 0;
                }
            }
            habitYSide = side;
            if (habitYSame >= 1)
                sealHalfY(side); // stayed in one half
            else if (habitYFlip >= 2) sealHalfY(-side); // keeps switching halves: seal where you go next
        },
    },

    // 同じ場所禁止: stay within 40 px of the spot you were at 1 second ago for 1.5 seconds -> aimed fans
    camper: {
        duration: 300,
        run(t) {
            if (t === 0) camperN = 0;
            if (t % 30 !== 0) return;
            const old = history[0] || player;
            camperN =
                Math.hypot(old.x - player.x, old.y - player.y) < 40
                    ? camperN + 1
                    : 0;
            if (camperN >= 3) {
                const a = aimFromBoss();
                for (let i = -2; i <= 2; i++)
                    bossShot("normal", a + i * 0.14, 3.4);
            }
        },
    },

    // HP12%発狂: when the boss HP is low, extra fans and swirling rings (add it to any step that lasts 240+ frames)
    rage: {
        duration: 240,
        run(t) {
            if (boss.hp > boss.max * 0.12 || t % 40 !== 20) return;
            const a = aimFromBoss();
            for (let i = -3; i <= 3; i++) bossShot("yellow", a + i * 0.2, 3.2);
            bossRing("swirl", 10, 2.2, t, { turn: 0.03 });
        },
    },

    // ---- 第4形態: 攻撃タイムライン（予告線とビームを別々の攻撃要素として順番に実行）----
    // 中身は form4Patterns() （PATTERNS の直前）にある。"" = 通常 / "H" = 理不尽モード用（今は同じ値。別々に調整できる）
    ...form4Patterns("", 120, 240, true), // 予告線2秒 → 消えて4秒後にビーム
    ...form4Patterns("H", 120, 240, true),
};

// Attack order of each form. Every inner list runs at the same time;
// when the longest one ends, the next list starts (and it loops).
const SEQUENCES = [
    // form 1
    [["rep"], ["follow"], ["wall"], ["beam"]],
    // form 2
    [["home"], ["trail"], ["vbeam"], ["refl"]],
    // form 3
    [["rep2"], ["fake"], ["rot"], ["orbs"]],
    // form 4 (several patterns at once)
    [
        ["rep2", "home"],
        ["wall"], // no beam here: wall + beam was impossible to dodge
        ["refl", "vbeam", "fake"],
        ["orbs", "trail", "follow"],
        ["rot", "home", "orbs"], // no vbeam here: the rotating beam + the vertical beams were impossible to dodge
    ],
];

// 理不尽モード (7 forms): forms 1-4 are the same as above, forms 5-7 are new.
const SEQUENCES_HARD = [
    SEQUENCES[0],
    SEQUENCES[1],
    SEQUENCES[2],
    SEQUENCES[3],
    // form 5 「覚えた奴ほど死ぬ」: things you learned, with a twist at the end
    [["rep3"], ["wallR"], ["freezeRing"], ["boom"], ["burst"]],
    // form 6 「プレイヤー対策」: reacts to how you move
    [
        ["habit"],
        ["surround"],
        ["habit", "boom"],
        ["swirl", "burst"],
        ["pressure", "camper"],
    ],
    // form 7 「最終理不尽」: everything together (rage = extra attacks when the boss HP is low)
    [
        ["rep3", "freezeRing", "rage"],
        ["wallR"], // no rage here: the wall must stay dodgeable
        ["habit", "burst", "rage"],
        ["habitY", "burst", "rage"], // the horizontal version of habit
        ["surround", "swirl", "rage"],
        ["pressure", "camper", "freezeRing", "rage"],
    ],
];

// Attach the attack lists to the modes (MODES is defined at the top, before these lists exist).
// The number of lists must equal the number of forms (the length of bossHp); script.js checks it.
// ---- eased attack lists (forms 1-3 are untouched; from form 4 fewer patterns run at the same time) ----
// SEQUENCES / SEQUENCES_HARD above are NOT edited: the RLモード builds its list of actions from SEQUENCES_HARD,
// and its learned data (data/rl-model.json, rl-pretrained.js) depends on that list.
// ---- 第4形態: 攻撃タイムライン（予告線とビームを順番に連続実行。詳細は attackTimeline() ）----
const FORM4_EASED = [
    ["seqCross"],
    ["seqFan"],
    ["seqReflect"],
    ["seqAim"],
    ["seqCage"],
];
const SEQUENCES_EASED = [SEQUENCES[0], SEQUENCES[1], SEQUENCES[2], FORM4_EASED]; // 通常モード
// 理不尽モード forms 4-7: 第4形態は攻撃タイムライン、forms 5-7 は理不尽攻撃
const FORM4_HARD = [
    ["seqCrossH"],
    ["seqReflectH"],
    ["seqFanH"],
    ["seqCageH"],
    ["seqAimH"],
];
const SEQUENCES_HARD_EASED = [
    SEQUENCES[0],
    SEQUENCES[1],
    SEQUENCES[2],
    FORM4_HARD,
    // form 5: the last step now stacks two patterns
    [["rep3"], ["wallR"], ["freezeRing"], ["boom"], ["burst", "rep3"]],
    // form 6: habit+boom and swirl+burst are back; the original last step is split into burst+camper and pressure+camper
    [
        ["habit"],
        ["surround"],
        ["habit", "boom"],
        ["swirl", "burst"],
        ["burst", "camper"],
        ["pressure", "camper"],
    ],
    // form 7: rage is kept; three steps stack patterns again, habitY and surround stay single
    [
        ["rep3", "freezeRing", "rage"],
        ["wallR"], // no rage here: the wall must stay dodgeable
        ["habit", "burst", "rage"],
        ["habitY", "rage"],
        ["surround", "rage"],
        ["pressure", "camper", "rage"],
    ],
];

MODES.find((m) => m.id === "hard").sequences = SEQUENCES_HARD_EASED;
MODES.find((m) => m.id === "normal").sequences = SEQUENCES_EASED;
MODES.find((m) => m.id === "rl").sequences = SEQUENCES_HARD; // same 7 forms; RL picks the steps itself

/* ============================================================================
 *  9. いろんな攻撃パターン (練習モード専用)
 *
 *  「超理不尽モードクリア可能版.html」にあった16種類の攻撃を、このゲームの仕組みに移したもの。
 *  - 練習モードの4つ目のタブ「いろんな攻撃」に並ぶ。本番のモード(MODES)には入っていない。
 *  - 1つの攻撃を繰り返し撃ち続ける。ボスを倒すとクリア。
 *  - 体力と攻撃力は全部の攻撃で一律:
 *      ボスの体力 = VARIETY_BOSS_HP, 被ダメージ = 1(第4形態の2倍ダメージも赤玉の倍率もなし),
 *      玉(オーブ)は降ってこない、隠しキーの回復もなし。
 *  - 弾の速さ・タイミングは元のHTML(px/秒)を px/フレームに直しただけ(÷60)。弾は一定速度。
 * ========================================================================== */
const VARIETY_BOSS_HP = 170; // every attack: the same boss HP (= the first form of the other modes)
const VARIETY_BULLET_CAP = 420; // like the original: no new bullets while this many are on the screen
const VARIETY_BEAM_CAP = 18; // like the original: at most this many beams at once
const VARIETY_HAZARD_CAP = 40;
const VARIETY_PERIOD = 29; // an attack fires every 29 frames (0.48 s, as in the original)

const vClamp = (v, a, b) => Math.max(a, Math.min(b, v));
function vShoot(type, x, y, angle, speed, opts) {
    if (bullets.length < VARIETY_BULLET_CAP)
        shoot(type, x, y, angle, speed, opts);
}
function vRing(type, x, y, n, speed, offset = 0, opts) {
    for (let i = 0; i < n; i++)
        vShoot(type, x, y, offset + (i * 2 * PI) / n, speed, opts);
}
// aimed at the player (`lead` moves the target 22 px in that direction, as in the original)
function vAimed(type, x, y, speed, opts, lead = 0) {
    const tx = player.x + Math.cos(lead) * 22;
    const ty = player.y + Math.sin(lead) * 22;
    vShoot(type, x, y, Math.atan2(ty - y, tx - x), speed, opts);
}
function vBeam(o) {
    if (beams.length < VARIETY_BEAM_CAP) beam(o);
}
function vHazard(o) {
    if (hazards.length < VARIETY_HAZARD_CAP) hazard(o);
}
const vVertical = (x, warn, dur, width) =>
    vBeam({ x, y: 0, angle: PI / 2, warn, dur, width }); // a beam from the top to the bottom
const vHorizontal = (y, warn, dur, width) =>
    vBeam({ x: 0, y, angle: 0, warn, dur, width }); // a beam from the left to the right
// the point the bullets come from: it wanders around the upper half of the screen
const vEmitter = () => ({
    x: CX + Math.sin(frame * 0.0183) * Math.min(145, W * 0.3),
    y: 190 + Math.cos(frame * 0.0133) * 80,
});
const VARIETY_GOLDEN = 2.399963; // the golden angle (rad)
let vBounceN = 0; // volleys of 跳弾三角網 so far (not reset between loops)
const vSecs = () => frame / 60; // seconds since the game loop started (the waves of the original used elapsed seconds)
const vBlast = (h) => vRing("vSmall", h.x, h.y, 10, 135 / 60, Math.random() * 2 * PI);

// n = how many times this attack has fired in the current loop of the pattern
const VARIETY_ATTACKS = [
    {
        name: "螺旋追跡網",
        desc: "逆回転する弾列が通路をねじりながら狭める",
        fire() {
            const e = vEmitter(),
                a = vSecs() * 1.4;
            for (let j = 0; j < 2; j++)
                for (let q = 0; q < 2; q++)
                    vShoot("v", e.x, e.y, a + j * PI + q * 0.15, (125 + q * 30) / 60);
            vRing("vSmall", e.x, e.y, 7, 95 / 60, -a);
        },
    },
    {
        name: "蛇行弾壁",
        desc: "切れ目の位置が蛇行し、遅れて第二の壁が重なる",
        fire() {
            const ts = vSecs(),
                gap = player.x + Math.sin(ts * 1.5) * 120;
            for (let x = 22; x < W; x += 34) {
                if (Math.abs(x - gap) <= 66) continue;
                const vx = (Math.sin(ts * 2 + x * 0.03) * 30) / 60,
                    vy = 150 / 60;
                vShoot("v", x, -8, Math.atan2(vy, vx), Math.hypot(vx, vy));
            }
            const gap2 = W - gap; // the second wall comes up from the bottom
            for (let x = 22; x < W; x += 38) {
                if (Math.abs(x - gap2) <= 58) continue;
                const vx = (Math.sin(ts + x) * 22) / 60,
                    vy = -145 / 60;
                vShoot("v", x, H + 4, Math.atan2(vy, vx), Math.hypot(vx, vy));
            }
        },
    },
    {
        name: "三連追尾珠",
        desc: "複数の追尾珠が別角度から挟み込む",
        fire() {
            const ts = vSecs(),
                e = vEmitter();
            const xs = [60, CX, W - 60];
            for (let j = 0; j < 3; j++)
                vAimed("vHome", xs[j], 35 + (j % 2) * 60, (120 + j * 16) / 60, {}, Math.sin(ts + j) * 0.6);
            vRing("vSmall", e.x, e.y, 5, 82 / 60, ts * 0.8);
        },
    },
    {
        name: "掃引ビーム",
        desc: "長射程ビームが画面を掃き、次の掃引が逆から来る",
        fire() {
            const ts = vSecs();
            vVertical(vClamp(player.x + Math.sin(ts * 1.4) * 180, 35, W - 35), 21, 54, 24);
            vHorizontal(vClamp(player.y + Math.cos(ts * 1.2) * 100, 45, H - 45), 18, 42, 22);
        },
    },
    {
        name: "遅延マーカー",
        desc: "現在地へ予告し、爆発の後に追撃弾を発生させる",
        fire() {
            const e = vEmitter();
            vHazard({
                x: player.x + Math.sin(vSecs() * 2) * 65,
                y: player.y - 35,
                r: 38,
                delay: 27,
                life: 25,
                burst: vBlast,
            });
            vAimed("v", e.x, e.y, 155 / 60);
        },
    },
    {
        name: "跳弾三角網",
        desc: "壁で反射する弾が三角形の軌道で交差する",
        // The 3 bullets form a triangle (120 deg apart) and every volley turns it by the golden angle, so the
        // directions never pile up. What matters more for covering the whole screen is how long a bullet lives
        // (vBounce.life): with 450 frames each bullet bounces long enough to visit the bottom as well as the top.
        // `vBounceN` keeps counting across loops of the pattern, so the directions never start over.
        fire() {
            const e = vEmitter();
            const base = vBounceN++ * VARIETY_GOLDEN;
            for (let j = 0; j < 3; j++) {
                const a = base + (j * 2 * PI) / 3;
                vShoot("vBounce", e.x + Math.cos(a) * 40, e.y + Math.sin(a) * 40, a, 155 / 60);
            }
        },
    },
    {
        name: "二段分裂花",
        desc: "大弾が分裂し、小弾が花のように広がる",
        fire() {
            const e = vEmitter();
            for (let j = 0; j < 3; j++)
                vShoot("vSplit", e.x, e.y, vSecs() * 1.1 + j * 2.1, 105 / 60);
        },
    },
    {
        name: "縦横格子",
        desc: "縦横レーザーの安全セルが段階的に移動する",
        fire() {
            const ts = vSecs();
            const safeX = (47 + ts * 60) % W,
                safeY = (23 + ts * 42) % H;
            const step = Math.max(82, W / 7); // wide screens: fewer beams (the beam cap is 18)
            for (let x = 35; x < W; x += step)
                if (Math.abs(x - safeX) > 29) vVertical(x, 15, 33, 17);
            // rows from the top down to the very bottom (the old rows stopped at y=567, so standing at the bottom
            // was always safe from them): the rows are spaced evenly and the last one sits at H - 30
            const rows = Math.max(1, Math.round((H - 65) / 76));
            for (let k = 0; k <= rows; k++) {
                const y = 35 + (k * (H - 65)) / rows;
                if (Math.abs(y - safeY) > 26) vHorizontal(y, 15, 33, 17);
            }
        },
    },
    {
        name: "停止急降下",
        desc: "波状の珠が停止し、短い予告後に真下へ急降下する",
        fire(n) {
            const sx = 60 + ((n * 211 + 97) % Math.max(1, W - 120));
            vShoot("vDive", sx, 20, PI / 2, 80 / 60, {
                vx: ((Math.sin(vSecs() * 2) * 65) / 60) * speedMul,
                vy: (80 / 60) * speedMul,
                stopY: 180 + ((n * 53) % 110),
                diveV: (310 / 60) * speedMul,
            });
            // the small ball: about half of them chase you (random), the rest fly straight at you
            if (Math.random() < 0.5) vAimed("vHome", W - sx, 40, 120 / 60, { r: 5 });
            else vAimed("v", W - sx, 40, 120 / 60);
        },
    },
    {
        name: "回転扇雨",
        desc: "扇形の弾幕が2つ同時に、反対向きから回転しながら放たれる",
        fire() {
            const e = vEmitter(),
                a = vSecs() * 0.9;
            for (let k = 0; k < 2; k++) // two fans at once, on opposite sides (half a turn apart)
                for (let j = 0; j < 7; j++)
                    vShoot("v", e.x, e.y, a + k * PI + (j - 3) * 0.19, 145 / 60);
        },
    },
    {
        name: "収縮リング",
        desc: "複数リングが広がった後、別方向から収縮する",
        fire() {
            const e = vEmitter(),
                ts = vSecs();
            for (let j = 0; j < 3; j++) {
                const r = 65 + j * 45,
                    ang = ts * 0.55 + j * 1.8;
                vHazard({
                    x: e.x + Math.cos(ang) * r,
                    y: e.y + Math.sin(ang) * r,
                    r: 28,
                    delay: 17,
                    life: 23,
                    burst: (h) => {
                        vBlast(h);
                        vRing("vSmall", h.x, h.y, 8, 90 / 60, Math.random() * 2 * PI);
                    },
                });
            }
            vRing("vSmall", e.x, e.y, 6, 105 / 60, ts);
        },
    },
    {
        name: "左右クロスファイア",
        desc: "左右の射線が交差し、時間差で高さをずらす",
        fire() {
            for (let j = 0; j < 4; j++) {
                const sy = (70 + j * 115) * (H / 560);
                vAimed("v", 8, sy, 185 / 60);
                vAimed("v", W - 8, H - sy, 185 / 60);
            }
        },
    },
    {
        name: "追尾ビームロック",
        desc: "照準が追尾してから固定され、長いビームを放つ",
        fire() {
            const e = vEmitter();
            vVertical(vClamp(player.x + Math.sin(vSecs() * 1.5) * 110, 24, W - 24), 25, 45, 31);
            vAimed("vHome", e.x, e.y, 130 / 60, { r: 5 });
        },
    },
    {
        name: "安全地帯リレー",
        desc: "安全な切れ目が移動し、古い位置へ追撃が入る",
        fire() {
            const gap = (13 + vSecs() * 105) % W;
            for (let x = 20; x < W; x += 27)
                if (Math.abs(x - gap) > 47)
                    vShoot("v", x, -5, PI / 2, 170 / 60, { r: 4.5 });
            vHazard({ x: gap, y: H - 70, r: 38, delay: 33, life: 24, burst: vBlast });
        },
    },
    {
        name: "反転ブーメラン",
        desc: "外へ進んだ弾が戻り、往路と復路を塞ぐ",
        fire() {
            const e = vEmitter(),
                a = Math.atan2(player.y - e.y, player.x - e.x);
            for (let j = 0; j < 5; j++)
                vShoot("vBack", e.x, e.y, a + j * 0.48 - 1.0, 145 / 60);
        },
    },
    {
        name: "四隅連動砲",
        desc: "四隅から順番に撃ち、最後に中央で軌道が交わる",
        fire() {
            const corners = [
                [18, 18],
                [W - 18, 18],
                [18, H - 18],
                [W - 18, H - 18],
            ];
            corners.forEach((p, j) =>
                vAimed("v", p[0], p[1], (150 + j * 12) / 60, {}, (j * PI) / 2),
            );
            vRing("vSmall", W / 2, H / 2, 8, 115 / 60, vSecs() * 0.6);
        },
    },
];

// Register every attack as a pattern ("var0" ... "var15"): it fires every VARIETY_PERIOD frames, forever
VARIETY_ATTACKS.forEach((a, i) => {
    PATTERNS["var" + i] = {
        duration: VARIETY_PERIOD * 10,
        run(t) {
            if (t % VARIETY_PERIOD === 0) a.fire((t / VARIETY_PERIOD) | 0);
        },
    };
});

// The practice-only "mode": one form per attack. Same HP for all, `uniform` = same damage, no orbs (see script.js)
const VARIETY_MODE = {
    id: "variety",
    label: "いろんな攻撃",
    desc: "いろんな攻撃パターンを1つずつ練習（記録なし）",
    color: "#fc4",
    uniform: true,
    bossHp: VARIETY_ATTACKS.map(() => VARIETY_BOSS_HP),
    sequences: VARIETY_ATTACKS.map((_, i) => [["var" + i]]),
    formTitles: VARIETY_ATTACKS.map((a) => a.name),
    detourMaxForm: -1,
    startSpeedMul: 1.0, // the speeds of the original are used as they are
    bossHealRatio: 0,
    redDmgMul: 1,
    ranked: false,
};
