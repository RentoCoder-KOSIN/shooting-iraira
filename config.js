/* ============================================================================
 *  config.js - 世界一イライラするゲーム  (game values / bullets / patterns)
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
 *   7. ATTACK PATTERNS what the boss fires, and in what order (SEQUENCES)
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
const PLAYER_MAX_HP = 8;
const PLAYER_SPEED = 4; // pixels per frame
const PLAYER_SLOW_SPEED = 2; // while holding Shift
const PLAYER_HIT_R = 3; // the real hit box is tiny
const HURT_INVINCIBLE_FRAMES = 60; // invincibility after being hit

// ---- boss ----
const BOSS_HP = [170, 220, 260, 340]; // HP of each form
const FORM_NAMES = "一二三四"; // used in "第◯形態"
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
const MID_PICK_FORM = 1; // the forced 2nd selection happens in this form (0 = form 1) ...
const MID_PICK_HP_RATIO = 0.6; // ... when the boss HP drops to this ratio
const FCLEAR_FRAMES = 200; // the fake CLEAR screen lasts this long

// ---- falling orbs ----
const ORB_DROP_FROM_FORM = 1; // orbs start falling from this form (0 = form 1)
const ORB_DROP_INTERVAL = 270; // an orb falls every N frames ...
const ORB_DROP_OFFSET = 135; // ... at this frame inside each interval
const ORB_FALL_SPEED = 1.8; // pixels per frame
const ORB_PICK_R = 16; // how close the player must be to take it
const ORB_MARGIN_X = 70; // orbs do not fall closer than this to the left / right edge

// ---- red orb (heal) ----
const HEAL_SMALL = 2; // +2 life ...
const HEAL_FULL_CHANCE = 0.2; // ... but 20% of the time it is a full heal
const BUFF_SMALL = 1.3; // boss bullet speed after a small heal
const BUFF_FULL = 1.5; // boss bullet speed after a full heal

// ---- other orbs ----
const INVERT_FRAMES = 600; // orange: reversed controls for 10 seconds
const FAKE_WAIT_FRAMES = 300; // purple: fake game over lasts 5 seconds
const FAKE_INV_FRAMES = 300; // purple: 5 seconds of invincibility afterwards

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
 *             apply() { player.hp = Math.min(PLAYER_MAX_HP, player.hp + 1); } },
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
    // red: +2 life (80%) or full heal (20%), and the boss gets stronger
    heal: {
        color: "#f33",
        name: "赤",
        hint: "体力が.....",
        apply() {
            if (Math.random() < HEAL_FULL_CHANCE) {
                player.hp = PLAYER_MAX_HP;
                speedMul = Math.max(speedMul, BUFF_FULL);
            } else {
                player.hp = Math.min(PLAYER_MAX_HP, player.hp + HEAL_SMALL);
                speedMul = Math.max(speedMul, BUFF_SMALL);
            }
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
            gagText = pick(GAG_TEXTS);
        },
    },
    // green: damage taken is doubled
    double: {
        color: "#3c3",
        name: "緑",
        hint: "痛みが.....",
        apply() {
            dmgMul = 2;
        },
    },
    // purple: fake game over, then invincibility when it ends
    fake: {
        color: "#a4f",
        name: "紫",
        hint: "終わった.....？",
        apply() {
            state = S.FAKE;
            fakeTimer = FAKE_WAIT_FRAMES;
        },
    },
};

// Orbs offered on the selection screen, left to right
const SELECT_ORBS = ["invert", "heal", "gag", "double", "fake"];
// On the 2nd selection these two orbs swap their abilities (falling orbs are never swapped)
const SWAP_ON_SECOND_PICK = ["heal", "gag"];

// Orbs that fall from the sky (the position is random, the order is fixed)
const ORB_ORDER_MAIN = ["heal", "gag", "double", "fake", "invert", "double", "fake", "gag", "heal", "invert"];
const ORB_ORDER_PATTERN = ["heal", "gag", "double", "fake", "invert", "fake"];

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
    wall: { r: 6, color: "#f80" }, // the big orange bullets of the wall
    homing: { r: 6, color: "#f6f", path: "homing", homeFrames: 80 }, // chases the player for a while
    trail: { r: 4, color: "#fa0", delay: 40 }, // left behind the player, appears later
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
const GAP_HALF = 36; // wall pattern: half width of the safe gap in pixels

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
    wall: {
        duration: 360,
        run(t) {
            if (t % 22 !== 0 || t >= 340) return;
            // A wider screen gets a larger but slower sweep, so the gap speed stays dodgeable.
            const gap = CX + Math.sin((t / 22) * 0.45 * (480 / W)) * 150 * (W / 480);
            const shift = (t / 22) % 2 ? 12 : 0;
            // One tempo per row: the whole row stops / dashes together and stays a straight line.
            const tempo = rollTempo();
            for (let x = 10 + shift; x < W; x += 24) {
                if (Math.abs(x - gap) > GAP_HALF) shoot("wall", x, -8, PI / 2, 2.8, tempo);
            }
        },
    },

    // a warning line, then a beam; plus rings
    beam: {
        duration: 260,
        run(t) {
            if (t === 10 || t === 130)
                beam({ x: player.x, y: 0, angle: PI / 2, warn: 50, dur: 30, width: 18 });
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
            if (t % 70 === 0) bossShot("homing", aimFromBoss(), 2.4, { homeFrames: 60 });
        },
    },

    // vertical beams (the gaps move) with a few horizontal beams in between
    vbeam: {
        duration: 300,
        run(t) {
            if (t === 0 || t === 150) {
                const offset = t ? 40 : 0;
                // beams across the whole width (6 beams when W = 480)
                const n = Math.floor(W / 80),
                    x0 = (W - (n - 1) * 80) / 2;
                for (let i = 0; i < n; i++)
                    beam({ x: x0 + i * 80 + offset, y: 0, angle: PI / 2, warn: 70, dur: 40, width: 36 });
            }
            // 3 horizontal beams per wave, fired between the vertical waves
            if (t === 70 || t === 210) {
                const ys = t === 70 ? [180, 340, 500] : [260, 420, 580];
                for (const y of ys) beam({ x: 0, y, angle: 0, warn: 50, dur: 40, width: 36 });
            }
            if (t % 45 === 20) bossShot("normal", aimFromBoss(), 3);
        },
    },

    // beams that bounce off the side walls (the angle is fixed)
    refl: {
        duration: 330,
        run(t) {
            if (t === 0 || t === 150) {
                for (const f of t ? [0.2, 0.8] : [0.35, 0.65])
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
                bossShot(early ? "normal" : "yellow", a + i * 0.17, early ? 3 : 4.4);
            if (count === 3) later(20, () => bossRing("yellow", 14, 2.4, 0));
        },
    },

    // fake homing: aims where you were a moment ago
    fake: {
        duration: 300,
        run(t) {
            if (t % 40 === 0)
                bossShot("aqua", aim(boss.x, boss.y + BOSS_MUZZLE_Y, history[0] || player), 3.6);
            if (t % 90 === 45) bossRing("normal", 8, 2, 0);
        },
    },

    // a slowly rotating beam plus rings
    rot: {
        duration: 320,
        run(t) {
            if (t === 0)
                beam({
                    x: boss.x,
                    y: boss.y + BOSS_MUZZLE_Y,
                    angle: 0.2,
                    turn: 0.011,
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
                spawnOrb(ORB_ORDER_PATTERN[(t / 50) % ORB_ORDER_PATTERN.length]);
            if (t % 45 === 0) bossRing("normal", 8, 2.1, t);
        },
    },
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
        ["rot", "vbeam", "home", "orbs"],
    ],
];
