/* ============================================================================
 *  script.js - 世界一イライラするゲーム  (engine)
 *
 *  Game loop, input, drawing. You rarely need to edit this file.
 *  All numbers / bullets / patterns / texts are in config.js (loaded before this file):
 *    H, PI, PLAYER_*, BOSS_*, ORBS, BULLET_TYPES, PACES, PATHS, PATTERNS, SEQUENCES ...
 * ========================================================================== */

/* ============================================================================
 *  8. ENGINE  (you rarely need to edit below this line)
 * ========================================================================== */

/* ---- basic objects ---- */
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
let W = MIN_W; // logical width (updated by layout())
let CX = W / 2; // horizontal center

const S = {
    TITLE: "title",
    MODE: "mode",
    PRACT: "pract", // practice mode: pick a mode's form to practice
    SELECT: "select",
    PLAY: "play",
    GAG: "gag",
    FAKE: "fake",
    FCLEAR: "fclear",
    OVER: "over",
    WIN: "win",
    WLIST: "wlist", // spectating: list of players who are playing now
    WATCH: "watch", // spectating: watching one of them
};

const PLAYER_START = { x: 240, y: 580 }; // x follows the screen center (see layout())
const BTN_FAKE_RESTART = { x: 170, y: 340, w: 140, h: 60 }; // x follows the screen center
const BTN_GAG_DONE = { x: 150, y: 420, w: 180, h: 60 }; // x follows the screen center
// the two buttons of a confirmation: side 0 = left, 1 = right (x follows the screen center)
const gagBtn = (side) => ({ x: CX - 150 + side * 160, y: 420, w: 140, h: 60 });
const MODE_BTN = { x: 90, y: 215, w: 300, h: 74, gap: 12 }; // mode select buttons (x follows the screen center)
// spectating buttons (x follows the screen center)
const watchBtn = () => ({ x: CX - 70, y: 588, w: 140, h: 30 }); // on the title screen
const watchRow = (i) => ({ x: CX - 150, y: 120 + i * 52, w: 300, h: 44 }); // one playing person
const watchBack = () => ({ x: 20, y: H - 46, w: 110, h: 30 });
const modeBtn = (i) => ({
    x: MODE_BTN.x,
    y: MODE_BTN.y + i * (MODE_BTN.h + MODE_BTN.gap),
    w: MODE_BTN.w,
    h: MODE_BTN.h,
});

/* ---- game state ---- */
let state; // current screen
let player; // { x, y, hp, inv }
let fx = []; // particles and rings: { x, y, vx, vy, r, life, max, color, ring?, grow? }
let shake = 0; // frames of screen shake left
let bossFlash = 0; // frames the boss is drawn with a white flash (after being hit)
let boss; // { x, y, hp, max }
let bullets, beams, shots, orbs, queue, history;
let gameMode = MODES[0]; // the chosen mode (see MODES in config.js)
let modeIdx = 0; // highlighted entry on the mode select screen
let practice = false; // true while playing in practice mode (never recorded)
let practMode = 0; // practice screen: index in MODES
let practForm = 0; // practice screen: highlighted form (0 = form 1)
let speedMul; // bullet speed multiplier (grows with some orbs)
let dmgMul; // damage multiplier (green orb: 2, red orb: 3)
let phase; // progress: the form you are on (0 .. formCount() - 1). Score and form changes use this
let detour; // true while fighting the form 1 boss because of the yellow orb
let detourSave; // { hp, max, patIdx } of the form to return to after the detour
let patIdx, patTime; // position in SEQUENCES and frames since the current step started
let frame; // global frame counter
let selectMap = [...SELECT_ORBS]; // effect of each selection orb (shuffled at every selection after form 1)
let selectRandom = false; // false: the selection after form 1 (original behavior), true: the selections after form 2 and later
let fakeTimer, clearTimer, gagText, tauntText;
let fakeCount; // purple orbs taken in this run (decides how long the fake game over lasts)
let invertTimer; // frames left of reversed controls
let gagStep, gagLock; // gag confirmation progress / press cooldown
let gagSwap; // true: the "はい" button is on the right and "いいえ" on the left (changes at random)
let keyHealUsed; // the random-key heal was used
let secretKey; // the one key that heals (chosen at random every game)
let keyDebug; // { text, t } debug text of the last pressed key
let formSplits; // run time (ms) at the moment each form was defeated, null = not defeated yet
let runFrames, formFrames; // frames spent actually playing: whole run / current form (this is the score)
let usedAdmin; // invincible mode was on at some point in this run -> not recorded
let lastRun; // the finished run: { mode, form, cleared, formMs, totalMs, splits, hp, score, parts, rank }
let runToken = 0; // identifies the finished run (a restart cancels a pending name entry)
let scoreOpen = false; // the name entry panel is open

// The form that is actually being fought: form 1 during a detour, otherwise the progress form.
// It decides the attack list, the form name on screen and the taunt.
const fightForm = () => (detour ? 0 : phase);
// Per-mode values: the number of forms, the HP of a form and the attack lists come from the chosen mode
const formCount = () => gameMode.bossHp.length;
const bossHpOf = (i) => gameMode.bossHp[i];
const sequencesOf = () => gameMode.sequences;
// Mode select entries: the real modes + the practice mode (the last entry, index MODES.length)
const MODE_MENU = [
    ...MODES,
    {
        id: "practice",
        label: "練習モード",
        desc: "形態を選んで練習（記録なし）",
        color: "#6d6",
    },
];
const PRACTICE_IDX = MODES.length;

// practice screens (all x positions follow the screen center)
const practTab = (i) => ({ x: CX - 150 + i * 102, y: 190, w: 96, h: 40 }); // mode tabs (3 modes)
const practRow = (i) => ({ x: CX - 150, y: 246 + i * 44, w: 300, h: 40 }); // one row per form
const practBack = () => ({ x: 10, y: 596, w: 90, h: 32 });
const practRetryBtn = () => ({ x: CX - 150, y: 450, w: 140, h: 46 }); // after game over / practice clear
const practMenuBtn = () => ({ x: CX + 10, y: 450, w: 140, h: 46 });
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const rand = (a, b) => a + Math.random() * (b - a);

// Mode select: apply the mode and start the run
function chooseMode(i) {
    modeIdx = i;
    if (i === PRACTICE_IDX) {
        state = S.PRACT; // practice: pick the mode and the form first
        return;
    }
    gameMode = MODES[i];
    if (gameMode.ranked) boardMode = gameMode.id; // after the run, the title screen shows this mode's ranking
    speedMul = gameMode.startSpeedMul;
    // the number of forms depends on the mode: prepare the first form and the split times
    boss.hp = boss.max = bossHpOf(0);
    formSplits = Array(formCount()).fill(null);
    RL.reset(); // the boss AI starts a fresh run (what it learned stays)
    state = S.PLAY;
}

// Practice: start the chosen form of the chosen mode (also used to retry)
function startPractice() {
    const keep = { invincible, attackMul, playerMaxHp }; // admin settings stay while practicing
    resetGame();
    invincible = keep.invincible;
    attackMul = keep.attackMul;
    playerMaxHp = keep.playerMaxHp;
    adminInv.checked = invincible;
    syncAdminSliders();
    practice = true;
    modeIdx = practMode;
    gameMode = MODES[practMode];
    speedMul = gameMode.startSpeedMul;
    phase = practForm;
    boss.hp = boss.max = bossHpOf(phase);
    formSplits = Array(formCount()).fill(null);
    player.hp = playerMaxHp;
    // the orb selection only happens after a boss defeat: practicing form 2 starts with the original selection
    RL.reset();
    if (phase === 1) enterSelect(false);
    else state = S.PLAY;
}
// leave the practice and go back to the form list
function exitPractice() {
    const keep = { invincible, attackMul, playerMaxHp };
    resetGame();
    invincible = keep.invincible;
    attackMul = keep.attackMul;
    playerMaxHp = keep.playerMaxHp;
    adminInv.checked = invincible;
    syncAdminSliders();
    state = S.PRACT;
}

function resetGame() {
    fx = [];
    shake = 0;
    bossFlash = 0;
    practice = false;
    state = S.TITLE;
    selectMap = [...SELECT_ORBS];
    selectRandom = false;
    keyHealUsed = false;
    invertTimer = 0;
    secretKey = pick([...SECRET_KEY_CANDIDATES]);
    keyDebug = { text: "", t: 0 };
    attackMul = 1; // admin sliders are NOT carried over to the next run
    playerMaxHp = PLAYER_MAX_HP;
    syncAdminSliders();
    player = { x: PLAYER_START.x, y: PLAYER_START.y, hp: playerMaxHp, inv: 0 };
    bullets = [];
    beams = [];
    shots = [];
    orbs = [];
    queue = [];
    history = [];
    speedMul = gameMode.startSpeedMul;
    dmgMul = 1;
    phase = 0;
    detour = false;
    detourSave = null;
    fakeCount = 0;
    patIdx = 0;
    patTime = 0;
    frame = 0;
    runFrames = 0;
    formFrames = 0;
    formSplits = Array(formCount()).fill(null);
    invincible = false; // admin mode is NOT carried over to the next run
    adminInv.checked = false; // keep the admin panel checkbox in sync
    usedAdmin = false;
    lastRun = null;
    runToken++;
    closeScore();
    fetchScores(); // refresh the ranking shown on the title screen
    boss = { x: CX, y: BOSS_START_Y, hp: bossHpOf(0), max: bossHpOf(0) };
    RL.reset();
}

/* ---- config check: gives a clear message when a name has a typo ---- */
function checkConfig() {
    const fail = (msg) => {
        throw new Error("[config] " + msg);
    };
    for (const id of [
        ...SELECT_ORBS,
        ...ORB_ORDER_MAIN,
        ...ORB_ORDER_PATTERN,
    ])
        if (!ORBS[id]) fail('unknown orb "' + id + '" (see ORBS)');
    for (const m of MODES) {
        if (!m.bossHp || !m.sequences)
            fail('mode "' + m.id + '" needs bossHp and sequences');
        if (m.sequences.length !== m.bossHp.length)
            fail(
                'mode "' +
                    m.id +
                    '": sequences (' +
                    m.sequences.length +
                    ") and bossHp (" +
                    m.bossHp.length +
                    ") must have the same length",
            );
        if (m.bossHp.length > FORM_NAMES.length)
            fail('FORM_NAMES is too short for mode "' + m.id + '"');
        for (const form of m.sequences)
            for (const step of form)
                for (const name of step)
                    if (!PATTERNS[name])
                        fail(
                            'unknown pattern "' +
                                name +
                                '" in the sequences of mode "' +
                                m.id +
                                '" (see PATTERNS)',
                        );
    }
    for (const [name, t] of Object.entries(BULLET_TYPES)) {
        const type = { ...BULLET_DEFAULTS, ...t };
        if (!PATHS[type.path])
            fail(
                'bullet type "' + name + '": unknown path "' + type.path + '"',
            );
        for (const p of type.paces)
            if (!PACES[p])
                fail('bullet type "' + name + '": unknown pace "' + p + '"');
    }
    for (const e of RANDOM_TEMPO)
        if (!PACES[e.pace]) fail('RANDOM_TEMPO: unknown pace "' + e.pace + '"');
}

/* ---- orb selection layout: a grid centered on the screen ---- */
function selectOrbPos(i) {
    const rows = Math.ceil(SELECT_ORBS.length / SEL_COLS);
    return {
        x: CX + ((i % SEL_COLS) - (SEL_COLS - 1) / 2) * SEL_GAP,
        y: H / 2 + (((i / SEL_COLS) | 0) - (rows - 1) / 2) * SEL_GAP,
    };
}
// The effect of the i-th selection orb (the colors stay in place, the effects are shuffled every time)
function selectEffect(i) {
    return selectMap[i];
}
// Open the orb selection and put the player at the start.
// random = false: the selection after form 1 (every color keeps its own effect, as before)
// random = true: after form 2 and later (which effect each color has is shuffled every time)
function enterSelect(random = true) {
    selectRandom = random;
    selectMap = [...SELECT_ORBS];
    if (random)
        for (let i = selectMap.length - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) | 0;
            [selectMap[i], selectMap[j]] = [selectMap[j], selectMap[i]];
        }
    state = S.SELECT;
    player.x = PLAYER_START.x;
    player.y = PLAYER_START.y;
}
// Taking an orb on the selection screen (every selection): the "heal" effect only heals the player.
// Falling orbs do not use this, so a falling red orb keeps its full effect (player heal + boss heal + boss power up)
function takeSelectOrb(id) {
    if (id === "heal") {
        state = S.PLAY;
        player.hp = Math.min(playerMaxHp, player.hp + RED_PLAYER_HEAL);
    } else takeOrb(id);
}

/* ---- input ---- */
const keys = {};

/* admin mode (Shift+@ to open) */
let adminOpen = false; // while true the game is paused and keys go to the panel
let adminAuthed = false; // stays true until the page is reloaded
let invincible = false; // admin: no damage
let attackMul = 1; // admin: damage of each player shot to the boss (slider)
let playerMaxHp = PLAYER_MAX_HP; // admin: max HP of the player (slider); also used by every heal

const adminEl = document.getElementById("admin");
const adminLogin = document.getElementById("admin-login");
const adminPanel = document.getElementById("admin-panel");
const adminPass = document.getElementById("admin-pass");
const adminMsg = document.getElementById("admin-msg");
const adminInv = document.getElementById("admin-inv");
const adminAtk = document.getElementById("admin-atk");
const adminAtkVal = document.getElementById("admin-atk-val");
const adminHp = document.getElementById("admin-hp");
const adminHpVal = document.getElementById("admin-hp-val");
const adminReset = document.getElementById("admin-reset");
const adminResetMsg = document.getElementById("admin-reset-msg");
let adminPassUsed = ""; // the password accepted at login (re-checked by the server on reset)
let resetArmed = false; // the reset button was pressed once and waits for the confirming press
let resetTimer = 0;

// JIS keyboard: Shift+@ gives "`". US keyboard: Shift+2 gives "@".
const isAdminShortcut = (e) => e.shiftKey && (e.key === "@" || e.key === "`");

function showAdminView() {
    adminLogin.hidden = adminAuthed;
    adminPanel.hidden = !adminAuthed;
    adminMsg.textContent = "";
    adminPass.value = "";
    adminInv.checked = invincible;
    syncAdminSliders();
    disarmReset();
    adminResetMsg.textContent = "";
    adminRlMsg.textContent = "";
    disarmRlReset();
    (adminAuthed ? adminInv : adminPass).focus();
}
function openAdmin() {
    adminOpen = true;
    for (const k in keys) delete keys[k]; // release held movement keys
    adminEl.hidden = false;
    showAdminView();
}
function closeAdmin() {
    adminOpen = false;
    adminEl.hidden = true;
    if (document.activeElement) document.activeElement.blur();
}
function tryAdminLogin() {
    if (adminPass.value === ADMIN_PASSWORD) {
        adminAuthed = true;
        adminPassUsed = adminPass.value;
        showAdminView();
    } else {
        adminMsg.textContent = "パスワードが違います";
        adminPass.value = "";
        adminPass.focus();
    }
}
adminPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryAdminLogin();
});
document.getElementById("admin-ok").addEventListener("click", tryAdminLogin);
// show the current slider values (attackMul / playerMaxHp) in the panel
function syncAdminSliders() {
    adminAtk.value = attackMul;
    adminAtkVal.textContent = attackMul;
    adminHp.value = playerMaxHp;
    adminHpVal.textContent = playerMaxHp;
}
// a run with a changed slider is not recorded in the ranking (same as invincible mode)
function markAdminIfChanged() {
    if (attackMul !== 1 || playerMaxHp !== PLAYER_MAX_HP) usedAdmin = true;
}
adminAtk.addEventListener("input", () => {
    attackMul = Number(adminAtk.value);
    adminAtkVal.textContent = attackMul;
    markAdminIfChanged();
});
adminHp.addEventListener("input", () => {
    playerMaxHp = Number(adminHp.value);
    adminHpVal.textContent = playerMaxHp;
    if (player) player.hp = playerMaxHp; // moving the slider also refills the HP
    markAdminIfChanged();
});
adminInv.addEventListener("change", () => {
    invincible = adminInv.checked;
    if (invincible) usedAdmin = true; // a run played with invincibility is not recorded
});
/* reset every ranking record: press twice (second press within 4 s) to confirm */
function disarmReset() {
    resetArmed = false;
    clearTimeout(resetTimer);
    adminReset.textContent = "全スコアボードをリセット";
    adminReset.disabled = false;
}
adminReset.addEventListener("click", async () => {
    if (!adminAuthed) return;
    if (!resetArmed) {
        resetArmed = true;
        adminReset.textContent = "本当に全削除する？ もう一度押すと実行";
        adminResetMsg.textContent = "";
        resetTimer = setTimeout(disarmReset, 4000);
        return;
    }
    disarmReset();
    adminReset.disabled = true;
    adminResetMsg.textContent = "リセット中…";
    try {
        const res = await fetch(SCORE_API + "/api/scores/reset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: adminPassUsed }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        boards = {
            hard: { rows: [], status: "ok", at: Date.now() },
            normal: { rows: [], status: "ok", at: Date.now() },
        };
        adminResetMsg.textContent = "全スコアを削除しました";
    } catch (err) {
        adminResetMsg.textContent =
            "リセットできませんでした（" + (err.message || "error") + "）";
    }
    adminReset.disabled = false;
});
/* reset what the RLモード boss AI has learned in this browser: press twice (second press within 4 s) */
const adminRlReset = document.getElementById("admin-rl-reset");
const adminRlMsg = document.getElementById("admin-rl-msg");
let rlResetArmed = false;
let rlResetTimer = 0;
const RL_RESET_LABEL = "ボスAI(RLモード)の学習をリセット";
function disarmRlReset() {
    rlResetArmed = false;
    clearTimeout(rlResetTimer);
    adminRlReset.textContent = RL_RESET_LABEL;
}
adminRlReset.addEventListener("click", () => {
    if (!adminAuthed) return;
    if (!rlResetArmed) {
        rlResetArmed = true;
        adminRlReset.textContent = "本当にリセットする？ もう一度押すと実行";
        adminRlMsg.textContent = "";
        rlResetTimer = setTimeout(disarmRlReset, 4000);
        return;
    }
    disarmRlReset();
    RL.clear();
    adminRlMsg.textContent = "ボスAIの学習をリセットしました";
});
adminEl
    .querySelectorAll("[data-close]")
    .forEach((b) => b.addEventListener("click", closeAdmin));

/* ---- scoreboard (talks to server.js) ---- */
const scoreEl = document.getElementById("score");
const scoreResult = document.getElementById("score-result");
const scoreName = document.getElementById("score-name");
const scoreMsg = document.getElementById("score-msg");
const scoreOk = document.getElementById("score-ok");
const scoreSkip = document.getElementById("score-skip");
scoreName.maxLength = SCORE_NAME_MAX;

// One ranking per mode (hard = 理不尽, normal = 通常). status: loading / ok / error
const newBoard = () => ({ rows: [], status: "loading", at: 0 });
let boards = { hard: newBoard(), normal: newBoard() };
let boardMode = "hard"; // the ranking shown on the title screen
function setBoard(mode) {
    boardMode = mode;
    fetchScores(false, mode); // load it if it is not loaded yet
}
const fmtScore = (n) => n.toLocaleString("en-US"); // 12345 -> "12,345"

// 83700 ms -> "1:23.7"
function fmtTime(ms) {
    const t = Math.floor(ms / 100);
    return (
        Math.floor(t / 600) +
        ":" +
        String(Math.floor((t % 600) / 10)).padStart(2, "0") +
        "." +
        (t % 10)
    );
}

async function fetchScores(force = false, mode = boardMode) {
    if (!SCORE_ENABLED) return;
    const now = Date.now();
    if (!force && now - boards[mode].at < SCORE_REFETCH_MIN_MS) return;
    boards[mode].at = now;
    try {
        const res = await fetch(SCORE_API + "/api/scores?mode=" + mode);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        boards[mode] = { rows: data.scores, status: "ok", at: now };
    } catch (_) {
        boards[mode].status = "error";
    }
}

// Called when a real game over / real CLEAR happens
function finishRun(cleared) {
    lastRun = {
        mode: gameMode.id,
        form: phase + 1,
        cleared,
        formMs: Math.round(formFrames * STEP_MS),
        totalMs: Math.round(runFrames * STEP_MS),
        splits: [...formSplits],
        hp: cleared ? Math.max(0, player.hp) : 0, // only a CLEAR keeps its HP
        rank: 0,
    };
    // the score (see scoring.js); a practice run has no score because it skips the earlier forms
    if (gameMode.rl) RL.save(); // keep what the boss AI learned in this run
    if (!practice && Scoring.MODES[lastRun.mode]) {
        lastRun.parts = Scoring.compute(lastRun.mode, lastRun);
        lastRun.score = lastRun.parts.total;
    }
    if (practice || !SCORE_ENABLED || usedAdmin || !gameMode.ranked) return; // practice is never recorded
    const token = ++runToken;
    setTimeout(() => {
        if (token === runToken && (state === S.OVER || state === S.WIN))
            openScore();
    }, SCORE_PROMPT_DELAY_MS);
}

function openScore() {
    scoreOpen = true;
    for (const k in keys) delete keys[k]; // release held movement keys
    const pt = lastRun.parts;
    scoreResult.textContent =
        gameMode.label +
        "\n" +
        (lastRun.cleared
            ? "CLEAR！ タイム " +
              fmtTime(lastRun.totalMs) +
              "　残り体力 " +
              lastRun.hp
            : "第" +
              FORM_NAMES[lastRun.form - 1] +
              "形態 " +
              fmtTime(lastRun.formMs) +
              "（生存 " +
              fmtTime(lastRun.totalMs) +
              "）") +
        "\nスコア " +
        fmtScore(lastRun.score) +
        "\n形態 " +
        fmtScore(pt.formPts) +
        " ＋ タイム " +
        fmtScore(pt.timePts) +
        (lastRun.cleared
            ? " ＋ クリア " + fmtScore(pt.clear) + " ＋ 体力 " + fmtScore(pt.hp)
            : " ＋ 生存 " + fmtScore(pt.survive));
    let saved = "";
    try {
        saved = localStorage.getItem(SCORE_NAME_KEY) || "";
    } catch (_) {}
    scoreName.value = saved;
    scoreMsg.textContent = "";
    scoreOk.disabled = false;
    scoreEl.hidden = false;
    scoreName.focus();
    scoreName.select();
}
function closeScore() {
    scoreOpen = false;
    scoreEl.hidden = true;
    if (document.activeElement) document.activeElement.blur();
}
async function submitScore() {
    if (!scoreOpen || scoreOk.disabled || !lastRun) return;
    const run = lastRun;
    const name = scoreName.value.trim().slice(0, SCORE_NAME_MAX);
    scoreOk.disabled = true;
    scoreMsg.textContent = "送信中…";
    try {
        const res = await fetch(SCORE_API + "/api/scores", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: run.mode,
                name,
                form: run.form,
                cleared: run.cleared,
                formMs: run.formMs,
                totalMs: run.totalMs,
                splits: run.splits,
                hp: run.hp,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        run.rank = data.rank;
        run.score = data.score; // the server's score is the official one
        try {
            localStorage.setItem(SCORE_NAME_KEY, name);
        } catch (_) {}
        boards[run.mode] = { rows: data.scores, status: "ok", at: Date.now() };
        boardMode = run.mode; // the title screen shows the ranking you just entered
        closeScore();
    } catch (err) {
        scoreMsg.textContent =
            "送信できませんでした（" + (err.message || "error") + "）";
        scoreOk.disabled = false;
    }
}
scoreOk.addEventListener("click", submitScore);
scoreSkip.addEventListener("click", closeScore);
scoreName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitScore();
});

/* fullscreen */
function enterFullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req && !document.fullscreenElement) {
        try {
            Promise.resolve(req.call(el)).catch(() => {});
        } catch (_) {}
    }
}
function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else enterFullscreen();
}

// Gag state. Step 0: the "やりました！" button. Then GAG_CONFIRMS.length confirmations, each with
// "はい" / "いいえ" (their places swap at random). "いいえ" goes back to the gag (step 0).
function rollGagSwap() {
    gagSwap = Math.random() < GAG_SWAP_CHANCE;
}
function pressGagAnswer(yes) {
    if (gagLock > 0) return;
    gagLock = GAG_LOCK_FRAMES;
    if (gagStep === 0) {
        gagStep = 1; // "やりました！"
        rollGagSwap();
    } else if (!yes) {
        gagStep = 0; // "いいえ": do it again
    } else if (gagStep < GAG_CONFIRMS.length) {
        gagStep++;
        rollGagSwap();
    } else state = S.PLAY;
}
// Enter / Space only press "やりました！" (step 0); the confirmations need the real buttons or the arrow keys
function pressGagDone() {
    if (gagStep === 0) pressGagAnswer(true);
}

// Enter / Space / click: "go to the next screen"
function advance() {
    if (state === S.TITLE) enterFullscreen(); // go fullscreen when the game starts
    if (state === S.GAG)
        pressGagDone(); // Enter only presses "やりました！"; the confirmations need the buttons / arrow keys
    else if (state === S.TITLE) state = S.MODE;
    else if (state === S.MODE) chooseMode(modeIdx);
    else if (state === S.PRACT) startPractice();
    else if (state === S.OVER || state === S.WIN)
        practice ? startPractice() : resetGame();
}

function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return {
        x: ((e.clientX - r.left) * W) / r.width,
        y: ((e.clientY - r.top) * H) / r.height,
    };
}
const inButton = (p, b) =>
    p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;

// Any key that is not a movement key: only the secret key heals (once)
function onOtherKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const IGNORED_KEYS = [
        "w",
        "a",
        "s",
        "d",
        "f",
        "arrowup",
        "arrowdown",
        "arrowleft",
        "arrowright",
        "enter",
        " ",
        "shift",
        "control",
        "alt",
        "meta",
        "tab",
        "escape",
        "capslock",
    ];
    const key = e.key.toLowerCase();
    if (IGNORED_KEYS.includes(key)) return;
    let note = "";
    if (state === S.PLAY) {
        if (key !== secretKey) {
            note = " → ハズレ";
        } else if (keyHealUsed) {
            note = " → 使用済み";
        } else {
            keyHealUsed = true;
            player.hp = Math.min(playerMaxHp, player.hp + KEY_HEAL);
            speedMul += KEY_BOSS_BUFF;
            note = " → 回復! ボス強化";
        }
    }
    keyDebug = { text: "押されたキー: " + e.key + note, t: KEY_DEBUG_FRAMES };
}

window.addEventListener("keydown", (e) => {
    if (scoreOpen) {
        if (e.key === "Escape") closeScore();
        return; // keys belong to the name entry while it is open
    }
    if (adminOpen) {
        if (e.key === "Escape") closeAdmin();
        return; // keys belong to the panel while it is open
    }
    if (isAdminShortcut(e)) {
        e.preventDefault();
        openAdmin();
        return;
    }
    keys[e.key.toLowerCase()] = true;
    if (state === S.GAG && gagStep >= 1 && !e.repeat) {
        // confirmations: the left / right arrow (or A / D) presses the button on that side
        const k = e.key.toLowerCase();
        const yesSide = gagSwap ? 1 : 0;
        if (k === "a" || k === "arrowleft") pressGagAnswer(yesSide === 0);
        if (k === "d" || k === "arrowright") pressGagAnswer(yesSide === 1);
    }
    if (
        state === S.TITLE &&
        !e.repeat &&
        e.key.toLowerCase() === "v" &&
        Net.available() &&
        Net.online !== null
    )
        openWatchList();
    if (state === S.WLIST && e.key === "Escape") state = S.TITLE;
    if (state === S.WATCH && e.key === "Escape") openWatchList();
    if (state === S.TITLE && SCORE_ENABLED && !e.repeat) {
        const k = e.key.toLowerCase();
        // A / D / arrows / Tab: switch between the two rankings
        if (
            k === "a" ||
            k === "d" ||
            k === "arrowleft" ||
            k === "arrowright" ||
            k === "tab"
        ) {
            e.preventDefault();
            setBoard(boardMode === "hard" ? "normal" : "hard");
        }
    }
    if (state === S.MODE && !e.repeat) {
        const k = e.key.toLowerCase();
        if (k === "w" || k === "arrowup")
            modeIdx = (modeIdx + MODE_MENU.length - 1) % MODE_MENU.length;
        if (k === "s" || k === "arrowdown")
            modeIdx = (modeIdx + 1) % MODE_MENU.length;
        if (k === "escape") state = S.TITLE;
    }
    if (state === S.PRACT && !e.repeat) {
        const k = e.key.toLowerCase();
        const n = () => MODES[practMode].bossHp.length;
        if (k === "a" || k === "d" || k === "arrowleft" || k === "arrowright") {
            practMode = (practMode + 1) % MODES.length;
            practForm = Math.min(practForm, n() - 1);
        }
        if (k === "w" || k === "arrowup")
            practForm = (practForm + n() - 1) % n();
        if (k === "s" || k === "arrowdown") practForm = (practForm + 1) % n();
        if (k === "escape") state = S.MODE;
    } else if (practice && e.key === "Escape") {
        exitPractice(); // Esc while practicing: back to the form list
    }
    if (!e.repeat) {
        if (e.key.toLowerCase() === "f") toggleFullscreen();
        onOtherKey(e);
    }
    if (e.key.startsWith("Arrow")) e.preventDefault();
    if (e.key === "Enter" || e.key === " ") {
        advance();
        e.preventDefault();
    }
});
window.addEventListener("keyup", (e) => {
    keys[e.key.toLowerCase()] = false;
});

canvas.addEventListener("click", (e) => {
    const p = canvasPoint(e);
    if (state === S.FAKE) {
        // pressing the fake RESTART button does NOT restart the run any more: it ends the fake game over right away
        if (inButton(p, BTN_FAKE_RESTART)) resetGame(); // update() then returns to the game (with the invincibility)
    } else if (state === S.GAG) {
        if (gagStep === 0) {
            if (inButton(p, BTN_GAG_DONE)) pressGagAnswer(true);
        } else {
            const yesSide = gagSwap ? 1 : 0;
            [0, 1].forEach((side) => {
                if (inButton(p, gagBtn(side))) pressGagAnswer(side === yesSide);
            });
        }
    } else if (state === S.MODE) {
        MODE_MENU.forEach((_, i) => {
            if (inButton(p, modeBtn(i))) chooseMode(i);
        });
    } else if (state === S.PRACT) {
        MODES.forEach((_, i) => {
            if (inButton(p, practTab(i))) {
                practMode = i;
                practForm = Math.min(practForm, MODES[i].bossHp.length - 1);
            }
        });
        MODES[practMode].bossHp.forEach((_, i) => {
            if (inButton(p, practRow(i))) {
                practForm = i;
                startPractice();
            }
        });
        if (inButton(p, practBack())) state = S.MODE;
    } else if (practice && (state === S.OVER || state === S.WIN)) {
        if (inButton(p, practRetryBtn())) startPractice();
        else if (inButton(p, practMenuBtn())) exitPractice();
    } else if (state === S.WLIST) {
        Net.list.slice(0, 8).forEach((r, i) => {
            if (inButton(p, watchRow(i))) startWatching(r.id);
        });
        if (inButton(p, watchBack())) state = S.TITLE;
    } else if (state === S.WATCH) {
        if (inButton(p, watchBack())) openWatchList();
    } else if (
        state === S.TITLE &&
        Net.available() &&
        Net.online !== null &&
        inButton(p, watchBtn())
    ) {
        openWatchList();
    } else if (
        state === S.TITLE &&
        SCORE_ENABLED &&
        RANKED_MODES.some((_, i) => inButton(p, boardTab(i)))
    ) {
        RANKED_MODES.forEach((m, i) => {
            if (inButton(p, boardTab(i))) setBoard(m.id); // switch the ranking (does not start the game)
        });
    } else {
        advance();
    }
});

// touch: drag to move the player
let touch = null;
const clampPlayer = () => {
    player.x = Math.max(8, Math.min(W - 8, player.x));
    player.y = Math.max(8, Math.min(H - 8, player.y));
};
canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    touch = { start: canvasPoint(e), px: player.x, py: player.y };
    canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
    if (!touch || (state !== S.PLAY && state !== S.SELECT)) return;
    const q = canvasPoint(e);
    const dir = invertTimer > 0 ? -1 : 1; // reversed while the orange orb is active
    player.x = touch.px + dir * (q.x - touch.start.x);
    player.y = touch.py + dir * (q.y - touch.start.y);
    clampPlayer();
});
const endTouch = () => {
    touch = null;
};
canvas.addEventListener("pointerup", endTouch);
canvas.addEventListener("pointercancel", endTouch);

/* ---- helpers used by the patterns ---- */
const aim = (x, y, target = player) => Math.atan2(target.y - y, target.x - x);
const aimFromBoss = () => aim(boss.x, boss.y);
const later = (frames, fn) => queue.push({ t: frames, f: fn });
const spawnOrb = (id) =>
    orbs.push({
        x: ORB_MARGIN_X + Math.random() * (W - ORB_MARGIN_X * 2),
        y: -10,
        id,
    });

// Roll a random extra tempo from RANDOM_TEMPO. Returns fields that can be passed to shoot().
function rollTempo() {
    let roll = Math.random();
    for (const e of RANDOM_TEMPO) {
        if (roll < e.chance)
            return {
                extraPace: e.pace,
                tempoAt: rand(...e.at),
                tempoLen: rand(...e.len),
            };
        roll -= e.chance;
    }
    return { extraPace: null, tempoAt: 0, tempoLen: 0 };
}

function shoot(type, x, y, angle, speed, opts = {}) {
    const preset = BULLET_TYPES[type];
    if (!preset)
        throw new Error(
            'Unknown bullet type "' + type + '" (see BULLET_TYPES)',
        );
    const base = { ...BULLET_DEFAULTS, ...preset };
    const v = speed * speedMul;
    bullets.push({
        ...base,
        ...(base.randomTempo
            ? rollTempo()
            : { extraPace: null, tempoAt: 0, tempoLen: 0 }),
        type, // the bullet type name (used by waitClear)
        x,
        y,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v,
        speed: v, // base speed (already multiplied by speedMul)
        age: 0, // frames since it appeared
        ...opts, // per-shot overrides (r, color, path, accelX, tempo ...)
    });
}
function ring(type, x, y, count, speed, offset = 0, opts) {
    for (let i = 0; i < count; i++)
        shoot(type, x, y, offset + (i * 2 * PI) / count, speed, opts);
}
const bossShot = (type, angle, speed, opts) =>
    shoot(type, boss.x, boss.y + BOSS_MUZZLE_Y, angle, speed, opts);
const bossRing = (type, count, speed, offset, opts) =>
    ring(type, boss.x, boss.y + BOSS_MUZZLE_Y, count, speed, offset, opts);

function beam({ x, y, angle, turn = 0, warn, dur, width, bounces = 0 }) {
    beams.push({
        x,
        y,
        a: angle,
        da: turn,
        warn,
        dur,
        w: width,
        refl: bounces,
        age: 0,
    });
}

/* ---- beam geometry ---- */
// The beam is a polyline (it bounces off the side walls)
function beamPath(b) {
    let x = b.x,
        y = b.y,
        dx = Math.cos(b.a),
        dy = Math.sin(b.a);
    const path = [[x, y]];
    for (let i = 0; i <= b.refl; i++) {
        const tx = dx > 1e-6 ? (W - x) / dx : dx < -1e-6 ? -x / dx : 1e9;
        const ty = dy > 1e-6 ? (H - y) / dy : dy < -1e-6 ? -y / dy : 1e9;
        const t = Math.min(tx, ty);
        x += dx * t;
        y += dy * t;
        path.push([x, y]);
        if (ty <= tx) break; // hit the top/bottom: stop
        dx = -dx; // hit a side: bounce
    }
    return path;
}
function distToSegment(px, py, a, b) {
    const vx = b[0] - a[0],
        vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.max(
        0,
        Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / len2),
    );
    return Math.hypot(px - a[0] - vx * t, py - a[1] - vy * t);
}

/* ---- effects ---- */
// a burst of n small squares flying out of (x, y)
function burstFx(x, y, color, n, speed, life) {
    if (!FX_ENABLED) return;
    for (let i = 0; i < n && fx.length < FX_MAX; i++) {
        const a = Math.random() * PI * 2;
        const s = speed * (0.4 + Math.random() * 0.6);
        fx.push({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s,
            r: 2 + Math.random() * 2,
            life,
            max: life,
            color,
        });
    }
}
// a ring that grows by `grow` pixels while it fades out
function ringFx(x, y, color, grow, life) {
    if (!FX_ENABLED || fx.length >= FX_MAX) return;
    fx.push({
        ring: true,
        x,
        y,
        vx: 0,
        vy: 0,
        r: 6,
        grow,
        life,
        max: life,
        color,
    });
}
function updateFx() {
    let n = 0;
    for (const p of fx) {
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.92;
        p.vy *= 0.92;
        if (--p.life > 0) fx[n++] = p; // keep the living ones (in place, no new array)
    }
    fx.length = n;
    if (shake > 0) shake--;
    if (bossFlash > 0) bossFlash--;
}
function drawFx() {
    for (const p of fx) {
        ctx.globalAlpha = p.life / p.max;
        if (p.ring) {
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r + (1 - p.life / p.max) * p.grow, 0, PI * 2);
            ctx.stroke();
        } else {
            ctx.fillStyle = p.color;
            ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
        }
    }
    ctx.globalAlpha = 1;
}
const orbFx = (x, y, color) => {
    ringFx(x, y, color, 26, 16);
    burstFx(x, y, color, 8, 2.5, 16);
};

/* ---- game logic ---- */
function takeOrb(id) {
    state = S.PLAY;
    ORBS[id].apply();
}

function hurtPlayer() {
    if (player.inv > 0 || invincible) return;
    player.hp -= dmgMul;
    player.inv = HURT_INVINCIBLE_FRAMES;
    if (gameMode.rl) RL.onHit(); // the boss AI learns from it (and takes a short break if it hits too often)
    burstFx(player.x, player.y, "#f66", 10, 3, 18);
    ringFx(player.x, player.y, "#f88", 24, 16);
    shake = FX_SHAKE_HURT;
    if (player.hp <= 0) {
        burstFx(player.x, player.y, "#fff", 14, 4, 30); // extra burst when it is the last hit
        ringFx(player.x, player.y, "#fff", 44, 28);
        state = S.OVER;
        tauntText = pick(TAUNTS).replace("◯", FORM_NAMES[fightForm()]);
        finishRun(false);
    }
}

function movePlayer() {
    const speed =
        (keys.shift ? PLAYER_SLOW_SPEED : PLAYER_SPEED) *
        (invertTimer > 0 ? -1 : 1);
    if (keys.a || keys.arrowleft) player.x -= speed;
    if (keys.d || keys.arrowright) player.x += speed;
    if (keys.w || keys.arrowup) player.y -= speed;
    if (keys.s || keys.arrowdown) player.y += speed;
    clampPlayer();
}

function updateShots() {
    if (frame % PLAYER_SHOT_INTERVAL === 0) {
        const sy = player.y - PLAYER_SHOT_OFFSET_Y;
        shots.push(
            { x: player.x - PLAYER_SHOT_SPACING, y: sy },
            { x: player.x + PLAYER_SHOT_SPACING, y: sy },
        );
    }
    shots = shots.filter((s) => {
        s.y -= PLAYER_SHOT_SPEED;
        if (
            Math.abs(s.x - boss.x) < BOSS_HIT_HALF_W &&
            Math.abs(s.y - boss.y) < BOSS_HIT_HALF_H
        ) {
            boss.hp -= attackMul; // 1 normally, more with the admin slider
            bossFlash = 3;
            burstFx(s.x, s.y, "#9ef", 2, 2.5, 10); // tiny sparks at the hit point
            return false;
        }
        return s.y > -10;
    });
}

function runPatterns() {
    const step = sequencesOf()[fightForm()][patIdx];
    for (const name of step) {
        const p = PATTERNS[name];
        if (patTime < p.duration) p.run(patTime);
    }
    patTime++;
    // A pattern with `waitClear` holds the next step until its bullets have left the screen
    const waiting = step.some((n) => {
        const type = PATTERNS[n].waitClear;
        return type && bullets.some((b) => b.type === type);
    });
    if (
        !waiting &&
        patTime >= Math.max(...step.map((n) => PATTERNS[n].duration))
    ) {
        patTime = 0;
        patIdx = (patIdx + 1) % sequencesOf()[fightForm()].length;
    }
}

function runQueue() {
    queue.forEach((q) => q.t--);
    const due = queue.filter((q) => q.t <= 0);
    queue = queue.filter((q) => q.t > 0);
    due.forEach((q) => q.f());
}

// The speed factor of a bullet: all of its paces multiplied together
function paceFactor(b) {
    let f = 1;
    for (const name of b.paces) f *= PACES[name](b);
    if (b.extraPace) f *= PACES[b.extraPace](b);
    return f;
}

function updateBullets() {
    bullets = bullets.filter((b) => {
        if (b.delay > 0) {
            b.delay--;
            return true;
        }
        PATHS[b.path](b); // trajectory: may change vx / vy
        const f = paceFactor(b); // pace: speed factor
        b.age++;
        b.x += b.vx * f;
        b.y += b.vy * f;
        if (Math.hypot(b.x - player.x, b.y - player.y) < b.r + PLAYER_HIT_R)
            hurtPlayer();
        return b.x > -20 && b.x < W + 20 && b.y > -20 && b.y < H + 20;
    });
}

function updateBeams() {
    beams = beams.filter((b) => {
        b.age++;
        b.a += b.da;
        if (b.age > b.warn && b.age <= b.warn + b.dur) {
            const path = beamPath(b);
            for (let i = 0; i < path.length - 1; i++) {
                if (
                    distToSegment(player.x, player.y, path[i], path[i + 1]) <
                    b.w / 2 + PLAYER_HIT_R
                )
                    hurtPlayer();
            }
        }
        return b.age <= b.warn + b.dur;
    });
}

function updateOrbs() {
    orbs = orbs.filter((o) => {
        o.y += ORB_FALL_SPEED;
        if (Math.hypot(o.x - player.x, o.y - player.y) < ORB_PICK_R) {
            orbFx(o.x, o.y, ORBS[o.id].color);
            takeOrb(o.id);
            return false;
        }
        return o.y < H + 20;
    });
}

// Form changes when the boss is defeated
function checkBossDefeated() {
    if (boss.hp > 0 || state !== S.PLAY) return;
    // the boss goes down: two rings and a burst, plus a screen shake
    ringFx(boss.x, boss.y, "#fff", 50, 24);
    ringFx(boss.x, boss.y, "#fc3", 80, 32);
    burstFx(boss.x, boss.y, "#fc3", 26, 5, 34);
    shake = FX_SHAKE_DEFEAT;
    bullets = [];
    beams = [];
    queue = [];
    orbs = [];
    patTime = 0;
    patIdx = 0;
    if (detour) {
        // the form 1 boss is beaten: go back to the form we came from, with the HP it had
        detour = false;
        boss.hp = detourSave.hp;
        boss.max = detourSave.max;
        patIdx = detourSave.patIdx;
        return;
    }
    formSplits[phase] = Math.round(runFrames * STEP_MS); // time at which this form was defeated
    // the form is over: the boss attack power from the red / green orbs goes back to normal
    if (dmgMul !== 1) ringFx(player.x, player.y, "#4df", 30, 20); // a small ring as the cue
    dmgMul = 1;
    if (practice || phase === formCount() - 1) {
        // practice: clearing the chosen form is the end
        state = S.WIN;
        finishRun(true);
    } else if (phase === formCount() - 2) {
        state = S.FCLEAR; // the fake "CLEAR" (before the last form)
        clearTimer = FCLEAR_FRAMES;
    } else {
        phase++;
        formFrames = 0;
        boss.hp = boss.max = bossHpOf(phase);
        enterSelect(phase !== 1); // every boss defeat is followed by the orb selection (form 1's is the original one)
    }
}

function updatePlay() {
    runFrames++;
    formFrames++;
    movePlayer();
    if (player.inv > 0) player.inv--;
    history.push({ x: player.x, y: player.y });
    if (history.length > HISTORY_FRAMES) history.shift();

    if (gameMode.rl)
        RL.moveBoss(); // RLモード: the AI moves the boss
    else
        boss.x =
            CX + Math.sin(frame / BOSS_MOVE_PERIOD) * BOSS_MOVE_AMP * (W / 480);

    // From form 2: an orb falls at a fixed interval (fixed order, random position)
    if (
        phase >= ORB_DROP_FROM_FORM &&
        frame % ORB_DROP_INTERVAL === ORB_DROP_OFFSET
    )
        spawnOrb(
            ORB_ORDER_MAIN[
                ((frame / ORB_DROP_INTERVAL) | 0) % ORB_ORDER_MAIN.length
            ],
        );

    updateShots();
    if (gameMode.rl)
        RL.update(); // RLモード: the AI chooses the attacks (no fixed order)
    else runPatterns();
    runQueue();
    updateBullets();
    updateBeams();
    updateOrbs();

    checkBossDefeated();
}

function update() {
    if (adminOpen) return; // paused while the admin panel is open
    frame++;
    pumpSpectate();
    updateFx();
    if (keyDebug.t > 0) keyDebug.t--;
    if (invertTimer > 0 && (state === S.PLAY || state === S.SELECT))
        invertTimer--;
    switch (state) {
        case S.SELECT:
            movePlayer();
            for (let i = 0; i < SELECT_ORBS.length; i++) {
                const o = selectOrbPos(i);
                if (Math.hypot(o.x - player.x, o.y - player.y) < SEL_PICK) {
                    orbFx(o.x, o.y, ORBS[selectEffect(i)].color);
                    takeSelectOrb(selectEffect(i));
                    break;
                }
            }
            break;
        case S.PLAY:
            updatePlay();
            break;
        case S.GAG:
            if (gagLock > 0) gagLock--;
            break;
        case S.FAKE:
            if (--fakeTimer <= 0) {
                state = S.PLAY;
                player.inv = FAKE_INV_FRAMES; // invincible when the fake game over ends
            }
            break;
        case S.FCLEAR:
            if (--clearTimer <= 0) {
                phase = formCount() - 1; // the last form
                formFrames = 0;
                boss.hp = boss.max = bossHpOf(phase);
                enterSelect(); // the selection before the last form too
            }
            break;
    }
}

/* ---- live broadcast for spectators (see net.js / realtime.js) ---- */
const SNAP_EVERY = 3; // send the screen every 3 frames (20 times per second)
const isBroadcasting = () =>
    !practice &&
    (state === S.SELECT ||
        state === S.PLAY ||
        state === S.GAG ||
        state === S.FAKE ||
        state === S.FCLEAR);

// The whole screen of this player in a compact form (bullets are grouped by look: [color, r, faint, [x, y, x, y ...]])
function buildSnap() {
    const groups = new Map();
    for (const b of bullets) {
        const key = b.color + "|" + b.r + "|" + (b.delay > 0 ? 1 : 0);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = [b.color, b.r, b.delay > 0 ? 1 : 0, []]));
        if (g[3].length < 2000) g[3].push(Math.round(b.x), Math.round(b.y));
    }
    const pts = [];
    shots.forEach(
        (q) => pts.length < 200 && pts.push(Math.round(q.x), Math.round(q.y)),
    );
    return {
        w: W,
        m: gameMode.id,
        f: fightForm(),
        d: detour ? 1 : 0,
        k: state === S.FCLEAR ? 1 : 0,
        l: state === S.SELECT ? 1 : 0, // choosing a colour orb
        p: [
            Math.round(player.x),
            Math.round(player.y),
            player.inv % 6 < 3 ? 1 : 0,
            Math.max(0, player.hp),
            dmgMul >= 3 ? 2 : dmgMul > 1 ? 1 : 0,
        ],
        b: [
            Math.round(boss.x),
            Math.round(boss.y),
            Math.max(0, Math.round(boss.hp)),
            Math.round(boss.max),
        ],
        g: [...groups.values()],
        e: beams.map((b) => [
            b.w,
            b.age > b.warn ? 1 : 0,
            beamPath(b).flat().map(Math.round),
        ]),
        sh: pts,
        // on the selection screen the "orbs" are the choices (same positions as drawSelect)
        o:
            state === S.SELECT
                ? SELECT_ORBS.map((id, i) => {
                      const q = selectOrbPos(i);
                      return [Math.round(q.x), Math.round(q.y), id];
                  })
                : orbs.map((o) => [Math.round(o.x), Math.round(o.y), o.id]),
    };
}

// called every frame from update()
function pumpSpectate() {
    if (isBroadcasting()) {
        if (frame % SNAP_EVERY === 0) Net.sendSnap(buildSnap());
    } else Net.stopSending();
    if (state === S.WLIST && frame % 120 === 0) Net.requestList(); // keep the list fresh
    // the watched player stopped: show the message for a moment, then back to the list
    if (state === S.WATCH && Net.endedAt && Date.now() - Net.endedAt > 2500)
        openWatchList();
}

function openWatchList() {
    Net.unwatch();
    Net.requestList();
    state = S.WLIST;
}
function startWatching(id) {
    Net.watch(id);
    state = S.WATCH;
}

/* ---- drawing ---- */
// Text that shrinks until it fits in 440px
function drawText(str, x, y, size, color, align = "center") {
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.font = "bold " + size + "px sans-serif";
    while (ctx.measureText(str).width > 440 && size > 10)
        ctx.font = "bold " + --size + "px sans-serif";
    ctx.fillText(str, x, y);
}

function drawCircle(x, y, r, color, filled = true) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 7);
    if (filled) {
        ctx.fillStyle = color;
        ctx.fill();
    } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

const fillScreen = (color) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, W, H);
};

function drawPlayer(color) {
    drawCircle(player.x, player.y, 9, color, false);
    drawCircle(player.x, player.y, PLAYER_HIT_R, "#fff");
}

function drawSelect() {
    drawText("好きな玉を選んでください", CX, 240, 24, "#fff");
    drawText("WASDで移動", CX, 400, 16, "#889");
    if (!selectRandom) {
        // legend of the selection after form 1 (effects can change later, so it stays vague)
        drawText(
            "色玉の効果（途中で変わることがあります）",
            CX,
            50,
            15,
            "#aab",
        );
        SELECT_ORBS.forEach((id, i) => {
            const o = ORBS[id];
            const y = 86 + i * 26;
            drawCircle(CX - 130, y - 5, 7, o.color);
            drawText(o.name + "玉　" + o.hint, CX - 112, y, 16, "#ddd", "left");
        });
    } else
        drawText(
            "どの色がどの効果かは、毎回ランダムです",
            CX,
            50,
            15,
            "#aab",
        );
    SELECT_ORBS.forEach((id, i) => {
        const q = selectOrbPos(i);
        drawCircle(q.x, q.y, SEL_R, ORBS[id].color);
        drawCircle(q.x, q.y, SEL_R + 5, ORBS[id].color + "8", false);
    });
    drawPlayer("#4df");
}

function drawField() {
    // boss
    if (bossFlash > 0) drawCircle(boss.x, boss.y, 30, "rgba(255,255,255,0.35)"); // flash when hit
    ctx.font = "48px serif";
    ctx.textAlign = "center";
    ctx.fillText(state === S.FCLEAR ? "💀" : "👿", boss.x, boss.y + 16);

    // beams (warning line, then the real beam)
    for (const b of beams) {
        const active = b.age > b.warn;
        ctx.beginPath();
        beamPath(b).forEach((q, i) =>
            i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]),
        );
        ctx.strokeStyle = active ? "#fff" : "rgba(255,80,80,.5)";
        ctx.lineWidth = active ? b.w : 2;
        ctx.stroke();
    }
    // streaks behind the orange wall while it drops (one path per streak style, so it stays light)
    for (const [len, w, a] of [
        [70, 2, 0.16],
        [34, 4, 0.3],
    ]) {
        ctx.beginPath();
        let any = false;
        for (const b of bullets)
            if (b.row && b.row.mode === "dash") {
                ctx.moveTo(b.x, b.y);
                ctx.lineTo(b.x, b.y - len);
                any = true;
            }
        if (!any) break;
        ctx.strokeStyle = "rgba(255,136,0," + a + ")";
        ctx.lineWidth = w;
        ctx.stroke();
    }
    // bullets (faint while waiting)
    for (const b of bullets) {
        ctx.globalAlpha = b.delay > 0 ? 0.3 : 1;
        drawCircle(b.x, b.y, b.r, b.color);
        ctx.globalAlpha = 1;
    }
    // falling orbs
    for (const o of orbs) {
        const c = ORBS[o.id].color;
        drawCircle(o.x, o.y, 12, c);
        drawCircle(o.x, o.y, 17, c + "8", false);
    }
    // player shots and the player (blinks while invincible)
    ctx.fillStyle = "#9ef";
    shots.forEach((s) => ctx.fillRect(s.x - 1, s.y - 6, 3, 10));
    if (player.inv % 6 < 3)
        drawPlayer(dmgMul >= 3 ? "#f55" : dmgMul > 1 ? "#3c3" : "#4df");
    drawFx();

    // HUD
    ctx.fillStyle = "#333";
    ctx.fillRect(10, 10, W - 20, 8);
    ctx.fillStyle = "#e44";
    ctx.fillRect(10, 10, ((W - 20) * Math.max(0, boss.hp)) / boss.max, 8);
    const formTitle = gameMode.formTitles && gameMode.formTitles[fightForm()]; // 理不尽 forms 5-7 have a subtitle
    drawText(
        "第" +
            FORM_NAMES[fightForm()] +
            "形態" +
            (formTitle ? "「" + formTitle + "」" : "") +
            (detour ? "（戻された）" : ""),
        10,
        36,
        14,
        "#aab",
        "left",
    );
    if (gameMode.rl) drawText(RL.hud(), 10, 52, 11, "#6d6", "left"); // what the boss AI is doing
    // many hearts would not fit: show "♥×N" above 16
    drawText(
        player.hp > 16 ? "♥×" + player.hp : "♥".repeat(Math.max(0, player.hp)),
        10,
        H - 10,
        16,
        "#f66",
        "left",
    );
    if (practice) drawText("練習　Esc: 形態選択へ", CX, H - 10, 11, "#6d6");
    if (invincible) drawText("ADMIN: 無敵", W - 10, 36, 14, "#fc3", "right");
    if (attackMul !== 1 || playerMaxHp !== PLAYER_MAX_HP)
        drawText(
            "ADMIN: 攻撃力×" + attackMul + " 体力" + playerMaxHp,
            W - 10,
            invincible ? 52 : 36,
            12,
            "#fc3",
            "right",
        );
    if (invertTimer > 0)
        drawText(
            "操作反転 " + Math.ceil(invertTimer / 60) + "秒",
            W - 10,
            H - 10,
            16,
            "#f93",
            "right",
        );
}

// top 10 at the top of the title screen: "rank. name", the score, the time each form was defeated and the HP left
const SCORE_X = 118; // right edge of the score column
const SCORE_COLS_X = [164, 209, 254, 299, 344, 389, 434]; // right edges of the form time columns (7 forms at most)
const RANKED_MODES = MODES.filter((m) => m.ranked); // only these have a ranking (RLモード has none)
const boardTab = (i) => ({ x: CX - 112 + i * 118, y: 184, w: 106, h: 20 }); // buttons that switch the ranking
// shorten a text with "…" until it fits in maxW pixels (uses the current font)
function fitText(str, maxW) {
    if (ctx.measureText(str).width <= maxW) return str;
    const chars = [...str];
    while (
        chars.length > 1 &&
        ctx.measureText(chars.join("") + "…").width > maxW
    )
        chars.pop();
    return chars.join("") + "…";
}
function drawScoreboard() {
    if (!SCORE_ENABLED) return;
    const board = boards[boardMode];
    const nForms = Scoring.MODES[boardMode].forms; // 7 for 理不尽, 4 for 通常
    const hpX = SCORE_COLS_X[nForms - 1] + 40; // the HP column follows the last form column
    ctx.textAlign = "left";
    ctx.fillStyle = "#fc3";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("TOP " + SCORE_TOP_N, 10, 22);
    ctx.font = "9px sans-serif";
    // column headers
    ctx.fillStyle = "#889";
    ctx.textAlign = "right";
    ctx.fillText("SCORE", SCORE_X, 22);
    SCORE_COLS_X.slice(0, nForms).forEach((x, k) =>
        ctx.fillText("第" + FORM_NAMES[k], x, 22),
    );
    ctx.fillText("HP", hpX, 22);
    if (!board.rows.length) {
        ctx.textAlign = "left";
        const msg = {
            loading: "読み込み中…",
            error: "ランキングを取得できません",
            ok: "まだ記録がありません",
        }[board.status];
        ctx.fillText(msg, 10, 40);
        return;
    }
    board.rows.slice(0, SCORE_TOP_N).forEach((r, i) => {
        const y = 40 + i * 14;
        const main = i === 0 ? "#fd0" : "#ccd";
        ctx.font = "9px sans-serif";
        ctx.fillStyle = main;
        ctx.textAlign = "left";
        ctx.fillText(fitText(i + 1 + ". " + r.name, 66), 10, y); // "rank. name"
        ctx.textAlign = "right";
        ctx.font = "bold 9px sans-serif";
        ctx.fillText(fmtScore(r.score), SCORE_X, y);
        ctx.font = "9px sans-serif";
        const sp = r.splits || [];
        SCORE_COLS_X.slice(0, nForms).forEach((x, k) => {
            const ms = sp[k];
            ctx.fillStyle = ms == null ? "#667" : main;
            ctx.fillText(ms == null ? SCORE_NA_TEXT : fmtTime(ms), x, y);
        });
        ctx.fillStyle = r.cleared ? main : "#667";
        ctx.fillText(r.cleared ? "♥" + r.hp : SCORE_NA_TEXT, hpX, y);
    });
}
// the two buttons under the ranking: 理不尽 / 通常
function drawBoardTabs() {
    if (!SCORE_ENABLED) return;
    RANKED_MODES.forEach((m, i) => {
        const b = boardTab(i);
        const sel = m.id === boardMode;
        ctx.fillStyle = sel ? m.color : "#2a2a3c";
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        drawText(
            m.label.replace("モード", "") + "ランキング",
            b.x + b.w / 2,
            b.y + 14,
            11,
            sel ? "#000" : "#ccd",
        );
    });
}
function drawRunResult(y1, y2) {
    if (!lastRun) return;
    drawText(
        (lastRun.cleared
            ? "クリアタイム " +
              fmtTime(lastRun.totalMs) +
              "　残り体力 " +
              lastRun.hp
            : "第" +
              FORM_NAMES[lastRun.form - 1] +
              "形態　生存 " +
              fmtTime(lastRun.totalMs)) +
            (lastRun.score != null
                ? "　スコア " + fmtScore(lastRun.score)
                : ""), // practice runs have no score
        CX,
        y1,
        15,
        "#aab",
    );
    if (lastRun.rank)
        drawText(lastRun.rank + "位に登録しました！", CX, y2, 18, "#fd0");
    else if (usedAdmin)
        drawText("ADMIN使用のため記録されません", CX, y2, 13, "#fc3");
}

// practice: "retry" and "back to the form list" buttons on the game over / clear screens
function drawPracticeButtons() {
    [
        [practRetryBtn(), "もう一度 (Enter)", "#6d6"],
        [practMenuBtn(), "形態選択へ (Esc)", "#6af"],
    ].forEach(([b, label, color]) => {
        ctx.fillStyle = color;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        drawText(label, b.x + b.w / 2, b.y + 29, 15, "#012");
    });
}

const MODE_LABEL = (id) =>
    (MODES.find((m) => m.id === id) || { label: id }).label;

function drawWatchList() {
    fillScreen("#10101c");
    drawText("観戦", CX, 70, 30, "#6af");
    drawText("いまプレイ中の人を選んでください", CX, 100, 14, "#aab");
    const rows = Net.list.slice(0, 8);
    rows.forEach((r, i) => {
        const b = watchRow(i);
        ctx.fillStyle = "#2a2a3c";
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = "#6af";
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        drawText("プレイヤー#" + r.id, b.x + 12, b.y + 27, 16, "#fff", "left");
        const f = FORM_NAMES[r.form] ? "第" + FORM_NAMES[r.form] + "形態" : "";
        drawText(
            MODE_LABEL(r.mode) + " " + f + " ♥" + r.hp,
            b.x + b.w - 12,
            b.y + 27,
            12,
            "#aab",
            "right",
        );
    });
    if (!rows.length)
        drawText(
            Net.listAt ? "いまプレイ中の人はいません" : "読み込み中…",
            CX,
            200,
            16,
            "#889",
        );
    const bk = watchBack();
    ctx.fillStyle = "#334";
    ctx.fillRect(bk.x, bk.y, bk.w, bk.h);
    drawText("戻る (Esc)", bk.x + bk.w / 2, bk.y + 21, 12, "#ccd");
}

// the watched player's screen, redrawn from the latest snapshot sent by the server (already validated there)
function drawWatch() {
    fillScreen("#10101c");
    const s = Net.snap;
    const bk = watchBack();
    if (!s) {
        drawText(
            Net.endedAt ? "プレイが終了しました" : "接続中…",
            CX,
            H / 2,
            20,
            "#889",
        );
    } else {
        // the watched screen may have another width: fit it in, centered
        const k = Math.min(1, W / s.w);
        ctx.save();
        ctx.translate(CX - (s.w * k) / 2, (H - H * k) / 2);
        ctx.scale(k, k);
        ctx.font = "48px serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        if (!s.l) ctx.fillText(s.k ? "💀" : "👿", s.b[0], s.b[1] + 16);
        for (const [bw, active, pts] of s.e) {
            ctx.beginPath();
            for (let i = 0; i < pts.length; i += 2)
                i ? ctx.lineTo(pts[i], pts[i + 1]) : ctx.moveTo(pts[0], pts[1]);
            ctx.strokeStyle = active ? "#fff" : "rgba(255,80,80,.5)";
            ctx.lineWidth = active ? bw : 2;
            ctx.stroke();
        }
        for (const [color, r, faint, pts] of s.g) {
            ctx.globalAlpha = faint ? 0.3 : 1;
            for (let i = 0; i < pts.length; i += 2)
                drawCircle(pts[i], pts[i + 1], r, color);
            ctx.globalAlpha = 1;
        }
        for (const [x, y, id] of s.o) {
            const c = ORBS[id] ? ORBS[id].color : "#fff";
            drawCircle(x, y, s.l ? SEL_R : 12, c);
            drawCircle(x, y, s.l ? SEL_R + 5 : 17, c + "8", false);
        }
        if (s.l) drawText("好きな玉を選んでいます…", s.w / 2, 240, 22, "#fff");
        ctx.fillStyle = "#9ef";
        for (let i = 0; i < s.sh.length; i += 2)
            ctx.fillRect(s.sh[i] - 1, s.sh[i + 1] - 6, 3, 10);
        if (s.p[2]) {
            const col = s.p[4] === 2 ? "#f55" : s.p[4] === 1 ? "#3c3" : "#4df";
            drawCircle(s.p[0], s.p[1], 9, col, false);
            drawCircle(s.p[0], s.p[1], PLAYER_HIT_R, "#fff");
        }
        ctx.restore();
        // HUD (boss HP, form, hearts)
        ctx.fillStyle = "#333";
        ctx.fillRect(10, 24, W - 20, 8);
        ctx.fillStyle = "#e44";
        ctx.fillRect(10, 24, ((W - 20) * s.b[2]) / s.b[3], 8);
        const m = MODES.find((x) => x.id === s.m);
        const title = m && m.formTitles && m.formTitles[s.f];
        drawText(
            "第" +
                (FORM_NAMES[s.f] || "?") +
                "形態" +
                (title ? "「" + title + "」" : "") +
                (s.d ? "（戻された）" : ""),
            10,
            52,
            14,
            "#aab",
            "left",
        );
        drawText(
            s.p[3] > 16 ? "♥×" + s.p[3] : "♥".repeat(s.p[3]),
            10,
            H - 54,
            16,
            "#f66",
            "left",
        );
        if (Net.endedAt)
            drawText("プレイが終了しました", CX, H / 2, 22, "#fc3");
    }
    drawText(
        "観戦中" + (Net.watching !== null ? " プレイヤー#" + Net.watching : ""),
        CX,
        H - 10,
        12,
        "#6af",
    );
    ctx.fillStyle = "#334";
    ctx.fillRect(bk.x, bk.y, bk.w, bk.h);
    drawText("戻る (Esc)", bk.x + bk.w / 2, bk.y + 21, 12, "#ccd");
}

function drawOverlay() {
    switch (state) {
        case S.WLIST:
            drawWatchList();
            break;
        case S.WATCH:
            drawWatch();
            break;
        case S.TITLE:
            fillScreen("#10101c");
            ctx.font = "72px serif";
            ctx.textAlign = "center";
            ctx.fillText("👿", CX, 268);
            drawText("世界一", CX, 323, 36, "#fff");
            drawText("イライラするゲーム", CX, 368, 40, "#f55");
            drawText(
                "難しいんじゃない。イライラするだけ。",
                CX,
                418,
                15,
                "#889",
            );
            if (frame % 60 < 40)
                drawText(
                    "タップ / クリック / Enter でスタート",
                    CX,
                    500,
                    22,
                    "#fff",
                );
            drawText(
                "移動: WASD・矢印キー / スマホは画面をドラッグ　攻撃: 自動",
                CX,
                560,
                14,
                "#889",
            );
            drawScoreboard();
            drawBoardTabs();
            if (Net.available() && Net.online !== null) {
                const wb = watchBtn();
                ctx.fillStyle = "#234";
                ctx.fillRect(wb.x, wb.y, wb.w, wb.h);
                ctx.strokeStyle = "#6af";
                ctx.lineWidth = 2;
                ctx.strokeRect(wb.x, wb.y, wb.w, wb.h);
                drawText(
                    "👀 観戦する (V)",
                    wb.x + wb.w / 2,
                    wb.y + 21,
                    13,
                    "#8cf",
                );
            }
            break;
        case S.MODE:
            fillScreen("#10101c");
            drawText("モードを選んでください", CX, 190, 28, "#fff");
            MODE_MENU.forEach((m, i) => {
                const b = modeBtn(i);
                const sel = i === modeIdx;
                ctx.fillStyle = sel ? m.color : "#2a2a3c";
                ctx.fillRect(b.x, b.y, b.w, b.h);
                ctx.strokeStyle = m.color;
                ctx.lineWidth = 3;
                ctx.strokeRect(b.x, b.y, b.w, b.h);
                drawText(m.label, CX, b.y + 34, 26, sel ? "#000" : "#fff");
                drawText(m.desc, CX, b.y + 62, 14, sel ? "#112" : "#aab");
            });
            drawText(
                "W/S・矢印で選択、Enter か タップで決定",
                CX,
                560,
                14,
                "#889",
            );
            if (modeIdx === PRACTICE_IDX)
                drawText(
                    "※練習モードはランキングに登録されません",
                    CX,
                    590,
                    12,
                    "#fc3",
                );
            break;
        case S.PRACT: {
            fillScreen("#10101c");
            drawText("練習モード", CX, 130, 30, "#6d6");
            drawText(
                "モードを選んで、練習する形態を選んでください",
                CX,
                165,
                14,
                "#aab",
            );
            MODES.forEach((m, i) => {
                const b = practTab(i);
                const sel = i === practMode;
                ctx.fillStyle = sel ? m.color : "#2a2a3c";
                ctx.fillRect(b.x, b.y, b.w, b.h);
                ctx.strokeStyle = m.color;
                ctx.lineWidth = 2;
                ctx.strokeRect(b.x, b.y, b.w, b.h);
                drawText(
                    m.label,
                    b.x + b.w / 2,
                    b.y + 26,
                    13,
                    sel ? "#000" : "#fff",
                );
            });
            const pm = MODES[practMode];
            pm.bossHp.forEach((hp, i) => {
                const b = practRow(i);
                const sel = i === practForm;
                ctx.fillStyle = sel ? pm.color : "#2a2a3c";
                ctx.fillRect(b.x, b.y, b.w, b.h);
                ctx.strokeStyle = pm.color;
                ctx.lineWidth = 2;
                ctx.strokeRect(b.x, b.y, b.w, b.h);
                const title = pm.formTitles && pm.formTitles[i];
                drawText(
                    "第" +
                        FORM_NAMES[i] +
                        "形態" +
                        (title ? "「" + title + "」" : ""),
                    CX,
                    b.y + 26,
                    16,
                    sel ? "#000" : "#fff",
                );
            });
            drawText(
                "A/D・←→ でモード切替　W/S・↑↓ で形態選択　Enter / タップで開始",
                CX,
                572,
                12,
                "#889",
            );
            const bk = practBack();
            ctx.fillStyle = "#334";
            ctx.fillRect(bk.x, bk.y, bk.w, bk.h);
            drawText("戻る (Esc)", bk.x + bk.w / 2, bk.y + 21, 12, "#ccd");
            break;
        }
        case S.GAG: {
            const b = BTN_GAG_DONE;
            fillScreen("rgba(0,0,40,.9)");
            if (gagStep === 0) {
                drawText("一発芸タイム！", CX, 200, 30, "#6af");
                drawText(gagText, CX, 320, 28, "#fff");
            } else {
                drawText(
                    "最終確認 " + gagStep + "/" + GAG_CONFIRMS.length,
                    CX,
                    200,
                    30,
                    "#fc3",
                );
                drawText(GAG_CONFIRMS[gagStep - 1], CX, 320, 26, "#fff");
            }
            ctx.fillStyle = gagLock > 0 ? "#456" : "#6af"; // both buttons look the same: you have to read them
            if (gagStep === 0) {
                ctx.fillRect(b.x, b.y, b.w, b.h);
                drawText("やりました！", CX, 460, 22, "#012");
                drawText("終わったらボタンを押してね", CX, 520, 14, "#889");
            } else {
                [0, 1].forEach((side) => {
                    const q = gagBtn(side);
                    ctx.fillStyle = gagLock > 0 ? "#456" : "#6af"; // drawText changes the fill color, so set it for each button
                    ctx.fillRect(q.x, q.y, q.w, q.h);
                    drawText(
                        side === (gagSwap ? 1 : 0) ? "はい" : "いいえ",
                        q.x + q.w / 2,
                        q.y + 40,
                        22,
                        "#012",
                    );
                });
                drawText(
                    "ボタンを押してね（←→キーでも選べます）",
                    CX,
                    520,
                    14,
                    "#889",
                );
            }
            break;
        }
        case S.FAKE: {
            const b = BTN_FAKE_RESTART;
            fillScreen("#000");
            drawText("GAME OVER", CX, 260, 52, "#e22");
            ctx.fillStyle = "#ddd";
            ctx.fillRect(b.x, b.y, b.w, b.h);
            drawText("RESTART", CX, 380, 22, "#000");
            drawText(
                "待つか、RESTARTを押すと再開",
                W - 4,
                H - 4,
                11,
                "#889",
                "right",
            ); // no number: the wait grows
            break;
        }
        case S.FCLEAR:
            drawText("CLEAR", CX, 320, 64, "#fd0");
            break;
        case S.OVER:
            fillScreen("rgba(0,0,0,.8)");
            drawText("GAME OVER", CX, 250, 48, "#e22");
            drawText("👿「" + tauntText + "」", CX, 330, 22, "#fff");
            drawRunResult(365, 392);
            if (practice) drawPracticeButtons();
            else
                drawText(
                    "タップ / クリック / Enter でもう一度",
                    CX,
                    420,
                    16,
                    "#889",
                );
            break;
        case S.WIN:
            fillScreen("rgba(0,0,0,.8)");
            drawText(
                practice ? "練習クリア！" : "本物のCLEAR！",
                CX,
                280,
                44,
                "#fd0",
            );
            drawText("ちゃんと避けられたね", CX, 340, 20, "#fff");
            drawRunResult(372, 398);
            if (practice) drawPracticeButtons();
            else
                drawText(
                    "タップ / クリック / Enter でもう一度",
                    CX,
                    420,
                    16,
                    "#889",
                );
            break;
    }
}

function draw() {
    ctx.clearRect(0, 0, W, H);
    if (state === S.SELECT) drawSelect();
    else if (shake > 0) {
        ctx.save(); // screen shake: shift only the playfield, not the HUD overlay
        const a = Math.min(4, shake * 0.6);
        ctx.translate(
            (Math.random() - 0.5) * 2 * a,
            (Math.random() - 0.5) * 2 * a,
        );
        drawField();
        ctx.restore();
    } else drawField();
    drawOverlay();
    if (Net.online !== null)
        drawText("👥 " + Net.online, W - 8, 12, 11, "#8cf", "right");
    if (keyDebug.t > 0)
        drawText(keyDebug.text, W - 6, H - 26, 11, "#8c8", "right");
}

/* ---- screen size ---- */
// Fill the window: the logical width follows the window aspect ratio (the height stays 640).
// Narrower than 3:4 -> keep 480 wide and letterbox vertically; wider than MAX_W -> letterbox sideways.
function layout() {
    const vw = window.innerWidth,
        vh = window.innerHeight;
    const oldCX = CX;
    W = Math.min(MAX_W, Math.max(MIN_W, Math.round((H * vw) / vh)));
    CX = W / 2;
    const scale = Math.min(vw / W, vh / H);
    const cssW = W * scale,
        cssH = H * scale;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";

    // sharp rendering: backing store = displayed size in device pixels
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);

    // keep everything that depends on the width in sync
    PLAYER_START.x = CX;
    BTN_FAKE_RESTART.x = CX - BTN_FAKE_RESTART.w / 2;
    BTN_GAG_DONE.x = CX - BTN_GAG_DONE.w / 2;
    MODE_BTN.x = CX - MODE_BTN.w / 2;
    if (typeof player !== "undefined" && CX !== oldCX) {
        player.x += CX - oldCX; // stay at the same place relative to the center
        clampPlayer();
        boss.x += CX - oldCX;
    }
}
window.addEventListener("resize", layout);
// Leaving fullscreen: the browser reports the new window size a moment later, so lay out again a few times
// (otherwise the canvas can keep the fullscreen size and part of the screen is cut off).
const relayout = () => {
    layout();
    requestAnimationFrame(layout);
    setTimeout(layout, 150);
    setTimeout(layout, 500);
};
document.addEventListener("fullscreenchange", relayout);
document.addEventListener("webkitfullscreenchange", relayout);
if (window.visualViewport)
    window.visualViewport.addEventListener("resize", layout); // mobile: address bar shows / hides

/* ---- main loop (fixed time step, about 60 updates per second) ---- */
checkConfig();
layout();
resetGame();
let accumulator = 0,
    lastTime = performance.now();
function loop(now) {
    accumulator += Math.min(100, now - lastTime);
    lastTime = now;
    while (accumulator >= STEP_MS) {
        update();
        accumulator -= STEP_MS;
    }
    draw();
    requestAnimationFrame(loop);
}
loop(lastTime);
