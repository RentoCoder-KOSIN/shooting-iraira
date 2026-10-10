#!/usr/bin/env node
"use strict";
/* tools/smoke-test.js - 画面遷移を一通り動かして、例外が出ないか確認する (ダミーのブラウザ上)
 *   node tools/smoke-test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

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
    console, performance: { now: () => 0 }, requestAnimationFrame: () => 0, setTimeout: () => 0, clearTimeout: () => 0,
    fetch: () => Promise.reject(new Error("offline")), innerWidth: 480, innerHeight: 640, devicePixelRatio: 1,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    document: new Proxy({}, { get: (_, k) => (k === "getElementById" ? () => dummy() : k === "hidden" ? false : k === "activeElement" ? null : k === "documentElement" ? dummy() : () => undefined) }),
    localStorage: { getItem: (k) => (k in saved ? saved[k] : null), setItem: (k, v) => (saved[k] = v), removeItem: (k) => delete saved[k] },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of ["scoring.js", "config.js", "rl-pretrained.js", "rl.js", "script.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });

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
    ok("mode menu has 4 entries (hard, normal, rl, practice)", MODE_MENU.length === 4 && MODE_MENU[2].id === "rl");

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

    // reset of the learning
    RL.clear();
    ok("RL.clear works", RL.hud().startsWith("AI:"));
    return log.join("\\n") + (process_fail ? "\\nFAILED" : "\\nALL OK");
})()`, ctx);
console.log(t);
process.exit(/FAILED/.test(t) ? 1 : 0);
