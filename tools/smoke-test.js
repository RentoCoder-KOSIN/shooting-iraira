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

    // title -> mode select
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
