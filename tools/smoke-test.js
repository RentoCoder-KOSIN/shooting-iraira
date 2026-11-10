#!/usr/bin/env node
"use strict";
/* tools/smoke-test.js - 画面遷移を一通り動かして、例外が出ないか確認する (ダミーのブラウザ上)
 *   node tools/smoke-test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..", "public");
// node tools/smoke-test.js --beta : test /beta (files in public/beta/ first, the rest from public/ - like the server)
const BETA = process.argv.includes("--beta") || process.argv.includes("--locked");
// --locked: the player has not bought 超理不尽モード (the server does not send ultra.js): the menu shows a locked entry that opens the shop
const LOCKED = process.argv.includes("--locked");
const fileOf = (f) => (BETA && fs.existsSync(path.join(ROOT, "beta", f)) ? path.join(ROOT, "beta", f) : path.join(ROOT, f));

function dummy() {
    const store = {};
    return new Proxy(function () {}, {
        get(_, k) {
            if (k === Symbol.toPrimitive) return () => 0;
            if (k in store) return store[k];
            if (k === "measureText") return () => ({ width: 10 });
            if (k === "getBoundingClientRect") return () => ({ left: 0, top: 0, width: 480, height: 640 });
            if (k === "getContext") return () => dummy();
            if (k === "style") return (store.style = {});
            return () => [];
        },
        set(_, k, v) {
            store[k] = v;
            return true;
        },
    });
}
const listeners = {};
const saved = {};
const sandbox = {
    __listeners: listeners, // lets the test fire keydown / click events at the game
    sanitizeSnap: require("../server/realtime.js").sanitizeSnap, // server-side validation of spectator snapshots
    console, performance: { now: () => 0 }, requestAnimationFrame: () => 0, setTimeout: () => 0, clearTimeout: () => 0,
    fetch: () => Promise.reject(new Error("offline")), innerWidth: 480, innerHeight: 640, devicePixelRatio: 1,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    document: new Proxy({}, { get: (_, k) => (k === "getElementById" ? () => dummy() : k === "hidden" ? false : k === "activeElement" ? null : k === "documentElement" ? dummy() : () => undefined) }),
    localStorage: { getItem: (k) => (k in saved ? saved[k] : null), setItem: (k, v) => (saved[k] = v), removeItem: (k) => delete saved[k] },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
// every script that index.html loads must be one the server hands out (server.js has a list: FILES / BETA_ONLY_FILES).
// A file that is missing from the list is a 404 in the browser, and nothing here would notice.
{
    const server = fs.readFileSync(path.join(__dirname, "..", "server", "server.js"), "utf8");
    const listOf = (name) => {
        const m = server.match(new RegExp("const " + name + " = \\[([^\\]]*)\\]"));
        return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    };
    // BETA_LOCKED_FILES = { "ultra.js": "ultra_mode", ... } (only buyers get them, but they are served)
    const lockedFiles = (server.match(/const BETA_LOCKED_FILES = \{([^}]*)\}/)?.[1].match(/"([^"]+)"\s*:/g) || []).map((s) => s.replace(/[":\s]/g, ""));
    const served = { "/play": new Set(listOf("FILES")), "/beta": new Set([...listOf("FILES"), ...listOf("BETA_ONLY_FILES"), ...lockedFiles]) };
    for (const [route, file] of [["/play", "index.html"], ["/beta", path.join("beta", "index.html")]]) {
        const html = fs.readFileSync(path.join(ROOT, file), "utf8");
        const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => path.basename(m[1]));
        const missing = scripts.filter((f) => !served[route].has(f));
        console.log((missing.length ? "FAIL" : "OK") + " " + route + ": every script of index.html is served by server.js" + (missing.length ? " (not served: " + missing.join(", ") + ")" : ""));
        if (missing.length) process.exitCode = 1;
    }
}
vm.runInContext("var __BETA = " + BETA + "; var __LOCKED = " + LOCKED + ";", ctx);
if (LOCKED) vm.runInContext("var Shop = { opened: 0, open() { this.opened++; } };", ctx); // shop.js needs a real page: a stand-in
const FILES = ["scoring.js", "config.js", "rl-pretrained.js", "rl.js", "net.js", "audio.js", "ai.js", ...(BETA && !LOCKED ? ["ultra-data.js", "ultra.js"] : []), "script.js"];
for (const f of FILES) vm.runInContext(fs.readFileSync(fileOf(f), "utf8"), ctx, { filename: f });

const t = vm.runInContext(`(function () {
    const log = [];
    const ok = (name, cond) => { log.push((cond ? "OK   " : "FAIL ") + name); if (!cond) process_fail = true; };
    let process_fail = false;
    const key = (k) => window.__fire && 0;
    function frames(n) { for (let i = 0; i < n; i++) update(); }
    function drawAll() { draw(); }

    // title: only the ranked modes get a ranking tab (RLモード has none)
    ok("ranking tabs: only hard + normal", RANKED_MODES.length === 2 && RANKED_MODES.every((m) => boards[m.id]));
    drawAll();
    state = S.MODE; drawAll();
    if (__LOCKED) ok("locked: the menu has a locked 超理不尽モード before the practice mode", MODE_MENU.length === 5 && MODE_MENU[3].id === "ultra-locked" && MODE_MENU[3].locked && MODE_MENU[4].id === "practice" && PRACTICE_IDX === 4);
    else if (__BETA) ok("mode menu has 5 entries (hard, normal, rl, ultra, practice)", MODE_MENU.length === 5 && MODE_MENU[2].id === "rl" && MODE_MENU[3].id === "ultra");
    else ok("mode menu has 4 entries (hard, normal, rl, practice)", MODE_MENU.length === 4 && MODE_MENU[2].id === "rl");

    // choose the RL mode
    chooseMode(2);
    ok("RL mode is selected", gameMode.id === "rl" && state === S.PLAY && formCount() === 7);
    ok("ranking board stays on a ranked mode", boardMode === "hard" || boardMode === "normal");
    drawAll();

    // play 3000 frames without moving: boss must move and attack, no exception
    const xs = new Set();
    let maxBullets = 0;
    for (let i = 0; i < 3000 && state === S.PLAY; i++) {
        update(); orbs = []; if (i % 20 === 0) xs.add(Math.round(boss.x / 20));
        maxBullets = Math.max(maxBullets, bullets.length);
        if (i % 500 === 0) drawAll();
    }
    ok("boss moved around (" + xs.size + " different x cells)", xs.size >= 4);
    ok("bullets were fired (max " + maxBullets + " on screen)", maxBullets > 5);
    ok("HUD text exists: " + RL.hud(), RL.hud().startsWith("AI:"));

    // spectating: the snapshot of a real run passes the server validation unchanged, and both screens draw
    {
        const raw = JSON.parse(JSON.stringify(buildSnap()));
        const clean = sanitizeSnap(raw);
        const nb = (g) => g.reduce((n, x) => n + x[3].length, 0);
        ok("snapshot is valid (" + nb(raw.g) / 2 + " bullets, " + raw.e.length + " beams)", !!clean && nb(clean.g) === nb(raw.g) && clean.e.length === raw.e.length);
        ok("snapshot is small (" + JSON.stringify(raw).length + " bytes)", JSON.stringify(raw).length < 30000);
        ok("garbage snapshots are rejected", [null, 1, {}, { w: "x" }, { ...raw, m: "evil" }, { ...raw, p: [NaN, 0, 0, 0, 0] }].every((x) => sanitizeSnap(x) === null));
        ok("bad colours / points are dropped", sanitizeSnap({ ...raw, g: [["red;alert(1)", 3, 0, [1, 2]], ["#fff", 3, 0, [1]]] }).g.length === 0);
        // choosing a colour orb: the broadcast must go on (otherwise the spectators are kicked out) and show the choices
        const keep = state; state = S.SELECT;
        const sel = sanitizeSnap(JSON.parse(JSON.stringify(buildSnap())));
        ok("selection screen is still broadcast", isBroadcasting() && sel && sel.l === 1 && sel.o.length === SELECT_ORBS.length);
        Net.snap = sel; state = S.WATCH; drawAll();
        state = keep;
        Net.snap = clean; state = S.WATCH; drawAll();
        Net.list = [{ id: 2, mode: "hard", form: 6, hp: 5 }]; state = S.WLIST; drawAll();
        Net.snap = null; state = S.PLAY;
    }

    // death -> OVER screen, no ranking prompt, no crash
    player.hp = 1; player.inv = 0; dmgMul = 1; hurtPlayer();
    ok("game over reached", state === S.OVER);
    ok("RL run is not scored/ranked", lastRun && lastRun.mode === "rl" && lastRun.score === undefined && !scoreOpen);
    drawAll();
    resetGame(); ok("resetGame works after RL", state === S.TITLE);

    // practice with RL: form 5 (index 4)
    practMode = 2; practForm = 4; startPractice();
    ok("RL practice starts at form 5", practice && phase === 4 && state === S.PLAY && gameMode.id === "rl");
    for (let i = 0; i < 1200 && state === S.PLAY; i++) { update(); orbs = []; }
    drawAll();
    state = S.PRACT; drawAll();

    // wall: 理不尽/RL = flow -> ALL rows stop together (0.6 s) -> ALL rows drop together, shape kept;
    //       通常 = the old whole-wall wave
    for (const [mid, name] of [["hard", "wall"], ["hard", "wallR"], ["rl", "wall"], ["normal", "wall"]]) {
        gameMode = MODES.find((m) => m.id === mid);
        let minGap = 1e9, maxSpread = 0, mismatch = 0, stuck = 0, maxClear = 0, groups = 0;
        let stopSeen = 0, maxNormal = 0, maxDash = 0, badStop = 0, badDash = 0, badShape = 0, flowOk = 0, maxRows = 0, maxBullets = 0;
        for (let trial = 0; trial < 20; trial++) {
            bullets = []; wallList = []; speedMul = 1.1; player.x = CX; player.y = -900; player.inv = 1e9;
            const seenStop = new Set();
            let cleared = -1;
            for (let i = 0; i < 2500; i++) {
                if (i < PATTERNS[name].duration) PATTERNS[name].run(i);
                const before = new Map(wallList.map((r) => [r, r.y]));
                updateBullets(); frame++;
                for (let k = 1; k < wallList.length; k++) minGap = Math.min(minGap, wallList[k - 1].y - wallList[k].y);
                const fs = wallList.filter((r) => r.y > -8).map((r) => r.f); // a row fired this frame has not moved yet
                if (fs.length > 2) maxSpread = Math.max(maxSpread, Math.max(...fs) - Math.min(...fs));
                const dashSteps = new Map(); // dashStart -> steps of the rows that dash together
                for (const r of wallList) {
                    if (r.mode === "stop") {
                        stopSeen++;
                        if (r.y > 150 && r.f !== 0) badStop++;
                        seenStop.add(r);
                    }
                    if (r.dashStart !== null && r.stopStart > 0 && r.dashStart - r.stopStart !== WALL_STOP_FRAMES) badDash++;
                    if (!before.has(r)) continue;
                    const step = r.y - before.get(r);
                    if (r.mode === "dash") {
                        maxDash = Math.max(maxDash, step);
                        if (!dashSteps.has(r.dashStart)) dashSteps.set(r.dashStart, []);
                        dashSteps.get(r.dashStart).push(step);
                    } else {
                        maxNormal = Math.max(maxNormal, step);
                        if (r.mode === "flow" && Math.abs(step - WALL_SPEED * speedMul) < 1e-9) flowOk++;
                    }
                }
                for (const steps of dashSteps.values()) if (Math.max(...steps) - Math.min(...steps) > 1e-9) badShape++;
                // all rows that stopped in the same frame must have the same stopStart
                const starts = new Set(wallList.filter((r) => r.mode === "stop").map((r) => r.stopStart));
                if (starts.size > 1) badStop++;
                maxRows = Math.max(maxRows, wallList.length);
                maxBullets = Math.max(maxBullets, bullets.length);
                for (const b of bullets) if (b.type === "wall" && b.row && Math.abs(b.y - b.row.y) > 1e-6 && b.row.y < H) mismatch++;
                if (i >= PATTERNS[name].duration && !bullets.some((b) => b.type === "wall")) { cleared = i; break; }
            }
            if (cleared < 0) stuck++; else maxClear = Math.max(maxClear, cleared);
            groups += new Set([...seenStop].map((r) => r.stopStart)).size;
        }
        const tag = mid + "/" + name;
        ok(tag + ": rows keep >= " + WALL_MIN_ROW_GAP + "px apart (min " + minGap.toFixed(1) + ")", minGap >= WALL_MIN_ROW_GAP - 1e-6);
        if (gameMode.rowWave) {
            ok(tag + ": the wall stops, all rows in the same frame (" + groups / 20 + " stops per run)", stopSeen > 50 && badStop === 0 && groups / 20 >= 1);
            ok(tag + ": it stands still for exactly " + WALL_STOP_FRAMES + " frames, then all rows drop together", badDash === 0);
            ok(tag + ": drops at " + maxDash.toFixed(1) + " px/frame (cap " + WALL_DASH_V + ")", maxDash > WALL_DASH_V - 0.01 && maxDash <= WALL_DASH_V + 1e-6);
            ok(tag + ": rows keep their shape while dropping", badShape === 0);
            ok(tag + ": flows at a constant speed (" + flowOk + " flowing steps, max " + maxNormal.toFixed(2) + " px/frame)", flowOk > 100 && maxNormal <= WALL_MAX_V + 1e-6);
            ok(tag + ": stays light (max " + maxRows + " rows, " + maxBullets + " bullets alive)", maxRows <= 12 && maxBullets < 400);
        } else {
            ok(tag + ": NO wave - every row has the same speed (spread " + maxSpread.toFixed(4) + ")", maxSpread < 1e-9);
            ok(tag + ": speed cap respected (max " + maxNormal.toFixed(2) + " px/frame)", maxNormal <= WALL_MAX_V + 1e-6);
        }
        ok(tag + ": every bullet stays on its row", mismatch === 0);
        ok(tag + ": always leaves the screen (slowest " + maxClear + " frames)", stuck === 0);
    }
    bullets = []; wallList = []; player.inv = 0; player.y = 500; speedMul = 1;

    // the new wall must be dodgeable the way a person does it: line up with the gap of the row that
    // arrives next and move on to the next gap after it has passed (4 px/frame, the real player speed)
    for (const [mid, name, py] of [["hard", "wall", 560], ["hard", "wallR", 560], ["rl", "wall", 560], ["hard", "wall", 300], ["hard", "wallR", 130]]) {
        gameMode = MODES.find((m) => m.id === mid);
        let hits = 0, frames = 0;
        for (let trial = 0; trial < 20; trial++) {
            bullets = []; wallList = []; speedMul = 1.1; player.x = CX; player.y = py; player.inv = 0; player.hp = 1000; dmgMul = 1;
            for (let i = 0; i < 2500; i++) {
                if (i < PATTERNS[name].duration) PATTERNS[name].run(i);
                // the closest row above the player: where is its gap?
                const above = wallList.filter((r) => r.y < player.y - 4 && r.y > -8).sort((a, b) => b.y - a.y)[0];
                if (above) {
                    const xs = bullets.filter((b) => b.row === above).map((b) => b.x).sort((a, b) => a - b);
                    let best = 0, cx = CX, prev = 0;
                    for (const x of [...xs, W]) { if (x - prev > best) { best = x - prev; cx = (x + prev) / 2; } prev = x; }
                    const dx = Math.max(-4, Math.min(4, cx - player.x));
                    player.x += dx;
                }
                const hp = player.hp;
                updateBullets(); frame++;
                if (player.inv > 0) player.inv--;
                if (player.hp < hp) hits++;
                frames++;
                if (i >= PATTERNS[name].duration && !bullets.some((b) => b.type === "wall")) break;
            }
        }
        ok(mid + "/" + name + " at y=" + py + ": a gap-follower is never hit (" + hits + " hits in " + (frames / 3600).toFixed(1) + " min)", hits === 0);
    }
    bullets = []; wallList = []; player.inv = 0; player.y = 500; speedMul = 1;

    // normal modes are untouched
    resetGame(); chooseMode(0);
    for (let i = 0; i < 600 && state === S.PLAY; i++) { update(); orbs = []; }
    ok("理不尽モード still runs with fixed patterns", gameMode.id === "hard" && state === S.PLAY);
    resetGame(); chooseMode(1);
    for (let i = 0; i < 600 && state === S.PLAY; i++) { update(); orbs = []; }
    ok("通常モード still runs", gameMode.id === "normal" && state === S.PLAY);

    // pause: Esc / button / Q
    const fire = (type, ev) => (__listeners[type] || []).forEach((f) => f(Object.assign({ preventDefault() {}, repeat: false }, ev)));
    resetGame(); chooseMode(1);
    frames(60);
    fire("keydown", { key: "Escape" });
    ok("Esc pauses the fight", paused === true);
    const f0 = frame, rf0 = runFrames, text0 = keyDebug.text;
    frames(120); draw();
    ok("nothing advances while paused", frame === f0 && runFrames === rf0);
    fire("keydown", { key: "x" });
    ok("other keys are ignored while paused", keyDebug.text === text0);
    fire("keydown", { key: "Escape" });
    frames(10);
    ok("Esc resumes and the game runs again", paused === false && frame > f0 && runFrames > rf0);
    // (the test canvas cannot receive clicks, so only the menu button positions are checked)
    const rb = pauseResumeBtn(), qb = pauseQuitBtn();
    ok("pause menu buttons are inside the screen and do not overlap", [rb, qb].every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H) && rb.y + rb.h < qb.y);
    ok("pausing is only possible while fighting", canPause() === true && (state = S.TITLE, canPause() === false) && (state = S.PLAY, true));
    fire("keydown", { key: " " });
    ok("Space pauses too", paused === true);
    fire("keydown", { key: " " });
    ok("Space resumes", paused === false);
    setPaused(true); fire("keydown", { key: "q" });
    ok("Q quits a real run to the title", paused === false && state === S.TITLE);
    practMode = 0; practForm = 0; startPractice(); setPaused(true); fire("keydown", { key: "q" });
    ok("Q quits a practice to the form list", paused === false && state === S.PRACT && practice === false);
    resetGame(); chooseMode(1); setPaused(true); resetGame();
    ok("resetGame clears the pause", paused === false);

    // not bought: the locked entry opens the shop and nothing else; the practice mode still works
    if (__LOCKED) {
        resetGame(); state = S.MODE;
        chooseMode(3);
        ok("locked: choosing it opens the shop and does not start a game", Shop.opened === 1 && state === S.MODE && gameMode.id !== "ultra");
        drawAll();
        chooseMode(PRACTICE_IDX);
        ok("locked: the practice mode (the entry after the locked one) still opens", state === S.PRACT && PRACT_MODES.every((m) => m.id !== "ultra"));
        drawAll();
        chooseMode(0); resetGame();
        ok("locked: a normal mode still starts", state === S.PLAY || gameMode.id === MODES[0].id);
        resetGame();
    }
    // 超理不尽モード (/beta only, bought)
    if (__BETA && !__LOCKED) {
        const ui = MODES.findIndex((m) => m.id === "ultra");
        resetGame(); chooseMode(ui);
        ok("ultra mode: selected, 10 forms, not ranked", gameMode.id === "ultra" && state === S.PLAY && formCount() === 10 && !gameMode.ranked);
        for (let i = 0; i < 900; i++) { player.inv = 1e9; update(); if (i % 60 === 0) draw(); }
        ok("ultra mode runs 900 frames; the attack name is shown", state === S.PLAY && uShown.name !== "");
        for (const f of [0, 4, 9]) {
            practMode = ui; practForm = f; startPractice();
            for (let i = 0; i < 500; i++) { player.inv = 1e9; update(); if (i % 100 === 0) draw(); }
        }
        ok("ultra practice (forms 1, 5, 10) runs", practice && gameMode.id === "ultra");
        state = S.PRACT; practMode = ui; drawAll();
        ok("practice tabs fit the screen (5 tabs)", PRACT_MODES.length === 5 && practTab(4).x + practTab(4).w <= W);
        state = S.MODE; drawAll();
        ok("mode buttons fit the screen (5 buttons)", modeBtn(4).y + modeBtn(4).h <= H);
        resetGame();
    }

    // reset of the learning
    RL.clear();
    ok("RL.clear works", RL.hud().startsWith("AI:"));
    return log.join("\\n") + (process_fail ? "\\nFAILED" : "\\nALL OK");
})()`, ctx);
console.log(t);
process.exit(/FAILED/.test(t) ? 1 : 0);
