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
    SELECT: "select",
    PLAY: "play",
    GAG: "gag",
    FAKE: "fake",
    FCLEAR: "fclear",
    OVER: "over",
    WIN: "win",
};

const PLAYER_START = { x: 240, y: 580 }; // x follows the screen center (see layout())
const BTN_FAKE_RESTART = { x: 170, y: 340, w: 140, h: 60 }; // x follows the screen center
const BTN_GAG_DONE = { x: 150, y: 420, w: 180, h: 60 }; // x follows the screen center

/* ---- game state ---- */
let state; // current screen
let player; // { x, y, hp, inv }
let boss; // { x, y, hp, max }
let bullets, beams, shots, orbs, queue, history;
let speedMul; // bullet speed multiplier (grows with some orbs)
let dmgMul; // damage multiplier (green orb: 2, red orb: 3)
let phase; // progress: the form you are on (0..3). Score and form changes use this
let detour; // true while fighting the form 1 boss because of the yellow orb
let detourSave; // { hp, max, patIdx } of the form to return to after the detour
let patIdx, patTime; // position in SEQUENCES and frames since the current step started
let frame; // global frame counter
let swapOrbs; // true during the 2nd selection
let midPickDone; // the 2nd selection has happened
let fakeTimer, clearTimer, gagText, tauntText;
let invertTimer; // frames left of reversed controls
let gagStep, gagLock; // gag confirmation progress / press cooldown
let keyHealUsed; // the random-key heal was used
let secretKey; // the one key that heals (chosen at random every game)
let keyDebug; // { text, t } debug text of the last pressed key
let runFrames, formFrames; // frames spent actually playing: whole run / current form (this is the score)
let usedAdmin; // invincible mode was on at some point in this run -> not recorded
let lastRun; // the finished run: { form, cleared, formMs, totalMs, rank }
let runToken = 0; // identifies the finished run (a restart cancels a pending name entry)
let scoreOpen = false; // the name entry panel is open

// The form that is actually being fought: form 1 during a detour, otherwise the progress form.
// It decides the attack list, the form name on screen and the taunt.
const fightForm = () => (detour ? 0 : phase);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const rand = (a, b) => a + Math.random() * (b - a);

function resetGame() {
    state = S.TITLE;
    swapOrbs = false;
    midPickDone = false;
    keyHealUsed = false;
    invertTimer = 0;
    secretKey = pick([...SECRET_KEY_CANDIDATES]);
    keyDebug = { text: "", t: 0 };
    player = { x: PLAYER_START.x, y: PLAYER_START.y, hp: PLAYER_MAX_HP, inv: 0 };
    bullets = [];
    beams = [];
    shots = [];
    orbs = [];
    queue = [];
    history = [];
    speedMul = START_SPEED_MUL;
    dmgMul = 1;
    phase = 0;
    detour = false;
    detourSave = null;
    patIdx = 0;
    patTime = 0;
    frame = 0;
    runFrames = 0;
    formFrames = 0;
    invincible = false; // admin mode is NOT carried over to the next run
    adminInv.checked = false; // keep the admin panel checkbox in sync
    usedAdmin = false;
    lastRun = null;
    runToken++;
    closeScore();
    fetchScores(); // refresh the ranking shown on the title screen
    boss = { x: CX, y: BOSS_START_Y, hp: BOSS_HP[0], max: BOSS_HP[0] };
}

/* ---- config check: gives a clear message when a name has a typo ---- */
function checkConfig() {
    const fail = (msg) => {
        throw new Error("[config] " + msg);
    };
    for (const id of [...SELECT_ORBS, ...SWAP_ON_SECOND_PICK, ...ORB_ORDER_MAIN, ...ORB_ORDER_PATTERN])
        if (!ORBS[id]) fail('unknown orb "' + id + '" (see ORBS)');
    for (const form of SEQUENCES)
        for (const step of form)
            for (const name of step)
                if (!PATTERNS[name]) fail('unknown pattern "' + name + '" in SEQUENCES (see PATTERNS)');
    for (const [name, t] of Object.entries(BULLET_TYPES)) {
        const type = { ...BULLET_DEFAULTS, ...t };
        if (!PATHS[type.path]) fail('bullet type "' + name + '": unknown path "' + type.path + '"');
        for (const p of type.paces)
            if (!PACES[p]) fail('bullet type "' + name + '": unknown pace "' + p + '"');
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
// On the 2nd selection the two orbs of SWAP_ON_SECOND_PICK swap abilities
function selectEffect(i) {
    const id = SELECT_ORBS[i];
    if (swapOrbs && id === SWAP_ON_SECOND_PICK[0]) return SWAP_ON_SECOND_PICK[1];
    if (swapOrbs && id === SWAP_ON_SECOND_PICK[1]) return SWAP_ON_SECOND_PICK[0];
    return id;
}

/* ---- input ---- */
const keys = {};

/* admin mode (Shift+@ to open) */
let adminOpen = false; // while true the game is paused and keys go to the panel
let adminAuthed = false; // stays true until the page is reloaded
let invincible = false; // admin: no damage

const adminEl = document.getElementById("admin");
const adminLogin = document.getElementById("admin-login");
const adminPanel = document.getElementById("admin-panel");
const adminPass = document.getElementById("admin-pass");
const adminMsg = document.getElementById("admin-msg");
const adminInv = document.getElementById("admin-inv");

// JIS keyboard: Shift+@ gives "`". US keyboard: Shift+2 gives "@".
const isAdminShortcut = (e) => e.shiftKey && (e.key === "@" || e.key === "`");

function showAdminView() {
    adminLogin.hidden = adminAuthed;
    adminPanel.hidden = !adminAuthed;
    adminMsg.textContent = "";
    adminPass.value = "";
    adminInv.checked = invincible;
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
adminInv.addEventListener("change", () => {
    invincible = adminInv.checked;
    if (invincible) usedAdmin = true; // a run played with invincibility is not recorded
});
adminEl.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeAdmin));

/* ---- scoreboard (talks to server.js) ---- */
const scoreEl = document.getElementById("score");
const scoreResult = document.getElementById("score-result");
const scoreName = document.getElementById("score-name");
const scoreMsg = document.getElementById("score-msg");
const scoreOk = document.getElementById("score-ok");
const scoreSkip = document.getElementById("score-skip");
scoreName.maxLength = SCORE_NAME_MAX;

let scoreboard = { rows: [], status: "loading", at: 0 }; // status: loading / ok / error

// 83700 ms -> "1:23.7"
function fmtTime(ms) {
    const t = Math.floor(ms / 100);
    return Math.floor(t / 600) + ":" + String(Math.floor((t % 600) / 10)).padStart(2, "0") + "." + (t % 10);
}
// one line of the ranking: CLEAR time, or the form reached + time in that form
const runLabel = (r) => (r.cleared ? "CLEAR " + fmtTime(r.totalMs) : r.form + "形態 " + fmtTime(r.formMs));

async function fetchScores(force = false) {
    if (!SCORE_ENABLED) return;
    const now = Date.now();
    if (!force && now - scoreboard.at < SCORE_REFETCH_MIN_MS) return;
    scoreboard.at = now;
    try {
        const res = await fetch(SCORE_API + "/api/scores");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        scoreboard = { rows: data.scores, status: "ok", at: now };
    } catch (_) {
        scoreboard.status = "error";
    }
}

// Called when a real game over / real CLEAR happens
function finishRun(cleared) {
    lastRun = {
        form: phase + 1,
        cleared,
        formMs: Math.round(formFrames * STEP_MS),
        totalMs: Math.round(runFrames * STEP_MS),
        rank: 0,
    };
    if (!SCORE_ENABLED || usedAdmin) return;
    const token = ++runToken;
    setTimeout(() => {
        if (token === runToken && (state === S.OVER || state === S.WIN)) openScore();
    }, SCORE_PROMPT_DELAY_MS);
}

function openScore() {
    scoreOpen = true;
    for (const k in keys) delete keys[k]; // release held movement keys
    scoreResult.textContent = lastRun.cleared
        ? "CLEAR！ タイム " + fmtTime(lastRun.totalMs)
        : "第" + FORM_NAMES[lastRun.form - 1] + "形態 " + fmtTime(lastRun.formMs) + "（生存 " + fmtTime(lastRun.totalMs) + "）";
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
            body: JSON.stringify({ name, form: run.form, cleared: run.cleared, formMs: run.formMs, totalMs: run.totalMs }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        run.rank = data.rank;
        try {
            localStorage.setItem(SCORE_NAME_KEY, name);
        } catch (_) {}
        scoreboard = { rows: data.scores, status: "ok", at: Date.now() };
        closeScore();
    } catch (err) {
        scoreMsg.textContent = "送信できませんでした（" + (err.message || "error") + "）";
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

// "done" press in the gag state: needs GAG_CONFIRMS.length extra confirmations
function pressGagDone() {
    if (gagLock > 0) return;
    gagLock = GAG_LOCK_FRAMES;
    if (gagStep < GAG_CONFIRMS.length) gagStep++;
    else state = S.PLAY;
}

// Enter / Space / click: "go to the next screen"
function advance() {
    if (state === S.TITLE) enterFullscreen(); // go fullscreen when the game starts
    if (state === S.GAG) pressGagDone(); // the keyboard goes through the same confirmations
    else if (state === S.TITLE) state = S.PLAY;
    else if (state === S.OVER || state === S.WIN) resetGame();
}

function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
}
const inButton = (p, b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;

// Any key that is not a movement key: only the secret key heals (once)
function onOtherKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const IGNORED_KEYS = [
        "w", "a", "s", "d", "f",
        "arrowup", "arrowdown", "arrowleft", "arrowright",
        "enter", " ", "shift", "control", "alt", "meta", "tab", "escape", "capslock",
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
            player.hp = Math.min(PLAYER_MAX_HP, player.hp + KEY_HEAL);
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
        // pressing the fake RESTART button really restarts the game (a trap)
        if (inButton(p, BTN_FAKE_RESTART)) resetGame();
    } else if (state === S.GAG) {
        if (inButton(p, BTN_GAG_DONE)) pressGagDone();
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
    orbs.push({ x: ORB_MARGIN_X + Math.random() * (W - ORB_MARGIN_X * 2), y: -10, id });

// Roll a random extra tempo from RANDOM_TEMPO. Returns fields that can be passed to shoot().
function rollTempo() {
    let roll = Math.random();
    for (const e of RANDOM_TEMPO) {
        if (roll < e.chance)
            return { extraPace: e.pace, tempoAt: rand(...e.at), tempoLen: rand(...e.len) };
        roll -= e.chance;
    }
    return { extraPace: null, tempoAt: 0, tempoLen: 0 };
}

function shoot(type, x, y, angle, speed, opts = {}) {
    const preset = BULLET_TYPES[type];
    if (!preset) throw new Error('Unknown bullet type "' + type + '" (see BULLET_TYPES)');
    const base = { ...BULLET_DEFAULTS, ...preset };
    const v = speed * speedMul;
    bullets.push({
        ...base,
        ...(base.randomTempo ? rollTempo() : { extraPace: null, tempoAt: 0, tempoLen: 0 }),
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
    for (let i = 0; i < count; i++) shoot(type, x, y, offset + (i * 2 * PI) / count, speed, opts);
}
const bossShot = (type, angle, speed, opts) =>
    shoot(type, boss.x, boss.y + BOSS_MUZZLE_Y, angle, speed, opts);
const bossRing = (type, count, speed, offset, opts) =>
    ring(type, boss.x, boss.y + BOSS_MUZZLE_Y, count, speed, offset, opts);

function beam({ x, y, angle, turn = 0, warn, dur, width, bounces = 0 }) {
    beams.push({ x, y, a: angle, da: turn, warn, dur, w: width, refl: bounces, age: 0 });
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
    const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / len2));
    return Math.hypot(px - a[0] - vx * t, py - a[1] - vy * t);
}

/* ---- game logic ---- */
function takeOrb(id) {
    state = S.PLAY;
    ORBS[id].apply();
}

function hurtPlayer() {
    if (player.inv > 0 || invincible) return;
    player.hp -= dmgMul;
    player.inv = HURT_INVINCIBLE_FRAMES;
    if (player.hp <= 0) {
        state = S.OVER;
        tauntText = pick(TAUNTS).replace("◯", FORM_NAMES[fightForm()]);
        finishRun(false);
    }
}

function movePlayer() {
    const speed = (keys.shift ? PLAYER_SLOW_SPEED : PLAYER_SPEED) * (invertTimer > 0 ? -1 : 1);
    if (keys.a || keys.arrowleft) player.x -= speed;
    if (keys.d || keys.arrowright) player.x += speed;
    if (keys.w || keys.arrowup) player.y -= speed;
    if (keys.s || keys.arrowdown) player.y += speed;
    clampPlayer();
}

function updateShots() {
    if (frame % PLAYER_SHOT_INTERVAL === 0) {
        const sy = player.y - PLAYER_SHOT_OFFSET_Y;
        shots.push({ x: player.x - PLAYER_SHOT_SPACING, y: sy }, { x: player.x + PLAYER_SHOT_SPACING, y: sy });
    }
    shots = shots.filter((s) => {
        s.y -= PLAYER_SHOT_SPEED;
        if (Math.abs(s.x - boss.x) < BOSS_HIT_HALF_W && Math.abs(s.y - boss.y) < BOSS_HIT_HALF_H) {
            boss.hp--;
            return false;
        }
        return s.y > -10;
    });
}

function runPatterns() {
    const step = SEQUENCES[fightForm()][patIdx];
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
    if (!waiting && patTime >= Math.max(...step.map((n) => PATTERNS[n].duration))) {
        patTime = 0;
        patIdx = (patIdx + 1) % SEQUENCES[fightForm()].length;
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
        if (Math.hypot(b.x - player.x, b.y - player.y) < b.r + PLAYER_HIT_R) hurtPlayer();
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
                if (distToSegment(player.x, player.y, path[i], path[i + 1]) < b.w / 2 + PLAYER_HIT_R)
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
            takeOrb(o.id);
            return false;
        }
        return o.y < H + 20;
    });
}

// Form 2 at 60% boss HP: force the 2nd selection (red and blue swap abilities)
function checkMidPick() {
    if (fightForm() === MID_PICK_FORM && !midPickDone && boss.hp > 0 && boss.hp <= boss.max * MID_PICK_HP_RATIO) {
        midPickDone = true;
        swapOrbs = true;
        state = S.SELECT;
        bullets = [];
        beams = [];
        queue = [];
        shots = [];
        player.x = PLAYER_START.x;
        player.y = PLAYER_START.y;
        return true;
    }
    return false;
}

// Form changes when the boss is defeated
function checkBossDefeated() {
    if (boss.hp > 0 || state !== S.PLAY) return;
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
    if (phase === 3) {
        state = S.WIN;
        finishRun(true);
    } else if (phase === 2) {
        state = S.FCLEAR; // the fake "CLEAR"
        clearTimer = FCLEAR_FRAMES;
    } else {
        phase++;
        formFrames = 0;
        boss.hp = boss.max = BOSS_HP[phase];
        if (phase === 1) {
            state = S.SELECT;
            player.x = PLAYER_START.x;
            player.y = PLAYER_START.y;
        }
    }
}

function updatePlay() {
    runFrames++;
    formFrames++;
    movePlayer();
    if (player.inv > 0) player.inv--;
    history.push({ x: player.x, y: player.y });
    if (history.length > HISTORY_FRAMES) history.shift();

    boss.x = CX + Math.sin(frame / BOSS_MOVE_PERIOD) * BOSS_MOVE_AMP * (W / 480);

    // From form 2: an orb falls at a fixed interval (fixed order, random position)
    if (phase >= ORB_DROP_FROM_FORM && frame % ORB_DROP_INTERVAL === ORB_DROP_OFFSET)
        spawnOrb(ORB_ORDER_MAIN[((frame / ORB_DROP_INTERVAL) | 0) % ORB_ORDER_MAIN.length]);

    updateShots();
    runPatterns();
    runQueue();
    updateBullets();
    updateBeams();
    updateOrbs();

    if (checkMidPick()) return;
    checkBossDefeated();
}

function update() {
    if (adminOpen) return; // paused while the admin panel is open
    frame++;
    if (keyDebug.t > 0) keyDebug.t--;
    if (invertTimer > 0 && (state === S.PLAY || state === S.SELECT)) invertTimer--;
    switch (state) {
        case S.SELECT:
            movePlayer();
            for (let i = 0; i < SELECT_ORBS.length; i++) {
                const o = selectOrbPos(i);
                if (Math.hypot(o.x - player.x, o.y - player.y) < SEL_PICK) {
                    takeOrb(selectEffect(i));
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
                phase = 3;
                formFrames = 0;
                swapOrbs = false;
                boss.hp = boss.max = BOSS_HP[3];
                state = S.PLAY;
            }
            break;
    }
}

/* ---- drawing ---- */
// Text that shrinks until it fits in 440px
function drawText(str, x, y, size, color, align = "center") {
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.font = "bold " + size + "px sans-serif";
    while (ctx.measureText(str).width > 440 && size > 10) ctx.font = "bold " + --size + "px sans-serif";
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
    if (!swapOrbs) {
        // legend of the first selection (effects can change later, so it stays vague)
        drawText("色玉の効果（途中で変わることがあります）", CX, 50, 15, "#aab");
        SELECT_ORBS.forEach((id, i) => {
            const o = ORBS[id];
            const y = 86 + i * 26;
            drawCircle(CX - 130, y - 5, 7, o.color);
            drawText(o.name + "玉　" + o.hint, CX - 112, y, 16, "#ddd", "left");
        });
    }
    SELECT_ORBS.forEach((id, i) => {
        const q = selectOrbPos(i);
        drawCircle(q.x, q.y, SEL_R, ORBS[id].color);
        drawCircle(q.x, q.y, SEL_R + 5, ORBS[id].color + "8", false);
    });
    drawPlayer("#4df");
}

function drawField() {
    // boss
    ctx.font = "48px serif";
    ctx.textAlign = "center";
    ctx.fillText(state === S.FCLEAR ? "💀" : "👿", boss.x, boss.y + 16);

    // beams (warning line, then the real beam)
    for (const b of beams) {
        const active = b.age > b.warn;
        ctx.beginPath();
        beamPath(b).forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
        ctx.strokeStyle = active ? "#fff" : "rgba(255,80,80,.5)";
        ctx.lineWidth = active ? b.w : 2;
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
    if (player.inv % 6 < 3) drawPlayer(dmgMul >= 3 ? "#f55" : dmgMul > 1 ? "#3c3" : "#4df");

    // HUD
    ctx.fillStyle = "#333";
    ctx.fillRect(10, 10, W - 20, 8);
    ctx.fillStyle = "#e44";
    ctx.fillRect(10, 10, ((W - 20) * Math.max(0, boss.hp)) / boss.max, 8);
    drawText("第" + FORM_NAMES[fightForm()] + "形態" + (detour ? "（戻された）" : ""), 10, 36, 14, "#aab", "left");
    drawText("♥".repeat(Math.max(0, player.hp)), 10, H - 10, 16, "#f66", "left");
    if (invincible) drawText("ADMIN: 無敵", W - 10, 36, 14, "#fc3", "right");
    if (invertTimer > 0)
        drawText("操作反転 " + Math.ceil(invertTimer / 60) + "秒", W - 10, H - 10, 16, "#f93", "right");
}

// top 10 in the top-left corner of the title screen
function drawScoreboard() {
    if (!SCORE_ENABLED) return;
    ctx.textAlign = "left";
    ctx.fillStyle = "#fc3";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("TOP " + SCORE_TOP_N, 10, 22);
    ctx.font = "10px sans-serif";
    if (!scoreboard.rows.length) {
        ctx.fillStyle = "#889";
        const msg = { loading: "読み込み中…", error: "ランキングを取得できません", ok: "まだ記録がありません" }[scoreboard.status];
        ctx.fillText(msg, 10, 40);
        return;
    }
    scoreboard.rows.slice(0, SCORE_TOP_N).forEach((r, i) => {
        const y = 40 + i * 15;
        ctx.fillStyle = i === 0 ? "#fd0" : "#ccd";
        ctx.textAlign = "left";
        ctx.fillText(i + 1 + ". " + r.name, 10, y, 100);
        ctx.textAlign = "right";
        ctx.fillText(runLabel(r), 190, y);
    });
}

// result lines of the game over / clear screens
function drawRunResult(y1, y2) {
    if (!lastRun) return;
    drawText(
        lastRun.cleared
            ? "クリアタイム " + fmtTime(lastRun.totalMs)
            : "第" + FORM_NAMES[lastRun.form - 1] + "形態　生存 " + fmtTime(lastRun.totalMs),
        CX, y1, 15, "#aab"
    );
    if (lastRun.rank) drawText(lastRun.rank + "位に登録しました！", CX, y2, 18, "#fd0");
    else if (usedAdmin) drawText("ADMIN使用のため記録されません", CX, y2, 13, "#fc3");
}

function drawOverlay() {
    switch (state) {
        case S.TITLE:
            fillScreen("#10101c");
            ctx.font = "72px serif";
            ctx.textAlign = "center";
            ctx.fillText("👿", CX, 200);
            drawText("世界一", CX, 290, 36, "#fff");
            drawText("イライラするゲーム", CX, 340, 40, "#f55");
            drawText("難しいんじゃない。イライラするだけ。", CX, 390, 15, "#889");
            if (frame % 60 < 40) drawText("タップ / クリック / Enter でスタート", CX, 500, 22, "#fff");
            drawText("移動: WASD・矢印キー / スマホは画面をドラッグ　攻撃: 自動", CX, 560, 14, "#889");
            drawScoreboard();
            break;
        case S.GAG: {
            const b = BTN_GAG_DONE;
            fillScreen("rgba(0,0,40,.9)");
            if (gagStep === 0) {
                drawText("一発芸タイム！", CX, 200, 30, "#6af");
                drawText(gagText, CX, 320, 28, "#fff");
            } else {
                drawText("最終確認 " + gagStep + "/" + GAG_CONFIRMS.length, CX, 200, 30, "#fc3");
                drawText(GAG_CONFIRMS[gagStep - 1], CX, 320, 26, "#fff");
            }
            ctx.fillStyle = gagLock > 0 ? "#456" : "#6af";
            ctx.fillRect(b.x, b.y, b.w, b.h);
            drawText(gagStep === 0 ? "やりました！" : "はい", CX, 460, 22, "#012");
            drawText("終わったらボタンを押してね", CX, 520, 14, "#889");
            break;
        }
        case S.FAKE: {
            const b = BTN_FAKE_RESTART;
            fillScreen("#000");
            drawText("GAME OVER", CX, 260, 52, "#e22");
            ctx.fillStyle = "#ddd";
            ctx.fillRect(b.x, b.y, b.w, b.h);
            drawText("RESTART", CX, 380, 22, "#000");
            drawText("5秒待つと？", W - 4, H - 4, 9, "#444", "right");
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
            drawText("タップ / クリック / Enter でもう一度", CX, 420, 16, "#889");
            break;
        case S.WIN:
            fillScreen("rgba(0,0,0,.8)");
            drawText("本物のCLEAR！", CX, 280, 44, "#fd0");
            drawText("ちゃんと避けられたね", CX, 340, 20, "#fff");
            drawRunResult(372, 398);
            drawText("タップ / クリック / Enter でもう一度", CX, 420, 16, "#889");
            break;
    }
}

function draw() {
    ctx.clearRect(0, 0, W, H);
    if (state === S.SELECT) drawSelect();
    else drawField();
    drawOverlay();
    if (keyDebug.t > 0) drawText(keyDebug.text, W - 6, H - 26, 11, "#8c8", "right");
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
    if (typeof player !== "undefined" && CX !== oldCX) {
        player.x += CX - oldCX; // stay at the same place relative to the center
        clampPlayer();
        boss.x += CX - oldCX;
    }
}
window.addEventListener("resize", layout);
document.addEventListener("fullscreenchange", layout);

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
