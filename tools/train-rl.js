#!/usr/bin/env node
"use strict";
/* ============================================================================
 *  tools/train-rl.js - ボスAI(RLモード)をブラウザなしで訓練・検証するツール
 *
 *  ゲーム本体(config.js / rl.js / script.js)をそのまま読み込み、ダミーのDOMの上で動かす。
 *  プレイヤー役は「弾を避けるBot」。1フレームずつゲームを進めて、ボスAIに学習させる。
 *
 *  使い方:
 *    node tools/train-rl.js eval  [rounds]      今の学習状態で、避けやすさ(被弾率)を測る (学習しない)
 *    node tools/train-rl.js train [rounds] [seed] 訓練して rl-pretrained.js に書き出す (初期状態としてゲームに同梱される)
 *    node tools/train-rl.js fresh [rounds]      学習ゼロのボス(ランダムに技を選ぶ)で測定 = 学習前の比較用
 *    node tools/train-rl.js base  [rounds]      比較用: 理不尽モード(固定順)のボスで同じ測定
 *  rounds = 7形態を何周するか (1周 = 各形態 40 秒)
 *  環境変数 BOT=weak  で人間っぽい弱いBot(見える範囲が狭い・たまに操作が止まる)に変えられる
 * ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const mode = process.argv[2] || "eval";
const rounds = Number(process.argv[3]) || 3;

/* ---- a fake browser: every property is a harmless function / value holder ---- */
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
            return () => []; // e.g. querySelectorAll(...).forEach(...) works
        },
        set(_, k, v) {
            store[k] = v;
            return true;
        },
    });
}
const sandbox = {
    console,
    Math,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => 0,
    fetch: () => Promise.reject(new Error("offline")),
    innerWidth: 480,
    innerHeight: 640,
    devicePixelRatio: 1,
    addEventListener() {},
    document: new Proxy(
        {},
        {
            get: (_, k) => (k === "getElementById" ? () => dummy() : k === "hidden" ? false : k === "activeElement" ? null : k === "documentElement" ? dummy() : () => undefined),
        }
    ),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
// math: a seeded random number generator makes runs repeatable
let seed = Number(process.argv[4]) || 12345;
sandbox.Math = Object.create(Math);
sandbox.Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

load("scoring.js");
load("config.js");
if ((mode === "eval" || mode === "base") && fs.existsSync(path.join(ROOT, "rl-pretrained.js"))) load("rl-pretrained.js"); // eval: start from the shipped state
else vm.runInContext("const RL_PRETRAINED = undefined;", ctx);
load("rl.js");
load("script.js");

/* ---- the driver runs INSIDE the game's scope (it can read the game's variables) ---- */
const WEAK = process.env.BOT === "weak";
const driver = `(function () {
    const WEAK = ${WEAK};
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const modeOf = (id) => MODES.find((m) => m.id === id);

    // the player: a bot that looks a few frames ahead and moves to the safest spot
    function botMove() {
        if (WEAK && Math.random() < 0.2) return; // inattentive: no move on 20% of the frames
        const near = bullets.filter((b) => Math.hypot(b.x - player.x, b.y - player.y) < (WEAK ? 110 : 180));
        let best = null, bestCost = 1e18;
        for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
            const speeds = dx || dy ? (WEAK ? [2, 3] : [2, 4]) : [0];
            for (const sp of speeds) {
                const n = Math.hypot(dx, dy) || 1;
                const vx = (dx / n) * sp, vy = (dy / n) * sp;
                let cost = 0;
                for (const t of (WEAK ? [2, 5, 8] : [2, 5, 8, 12, 16])) {
                    const px = clamp(player.x + vx * t, 8, W - 8), py = clamp(player.y + vy * t, 8, H - 8);
                    for (const b of near) {
                        const tt = Math.max(0, t - Math.max(0, b.delay));
                        const f = b.delay > 0 ? 1 : paceFactor(b);
                        const bx = b.x + b.vx * f * tt, by = b.y + b.vy * f * tt;
                        const d = Math.hypot(px - bx, py - by);
                        const rr = b.r + 10;
                        if (d < rr) cost += 100 / (1 + t * 0.2);
                        else if (d < rr + 16) cost += (rr + 16 - d) * 0.5;
                    }
                    for (const bm of beams) {
                        const age = bm.age + t;
                        const live = age > bm.warn && age <= bm.warn + bm.dur;
                        const warn = age > bm.warn - 25 && age <= bm.warn;
                        if (!live && !warn) continue;
                        const pth = beamPath({ x: bm.x, y: bm.y, a: bm.a + bm.da * t, refl: bm.refl });
                        for (let i = 0; i < pth.length - 1; i++) {
                            const d = distToSegment(px, py, pth[i], pth[i + 1]);
                            if (d < bm.w / 2 + 11) cost += live ? 100 / (1 + t * 0.2) : 20;
                        }
                    }
                }
                const fx = clamp(player.x + vx * 8, 8, W - 8), fy = clamp(player.y + vy * 8, 8, H - 8);
                cost += Math.max(0, 40 - Math.min(fx, W - fx)) * 0.5 + Math.max(0, 40 - Math.min(fy, H - fy)) * 0.5;
                cost += 0.004 * Math.abs(fx - boss.x) + 0.01 * Math.abs(fy - 520) + Math.random() * 0.4;
                if (cost < bestCost) { bestCost = cost; best = [vx, vy]; }
            }
        }
        player.x = clamp(player.x + best[0], 8, W - 8);
        player.y = clamp(player.y + best[1], 8, H - 8);
    }

    function setup(mode, f) {
        gameMode = mode;
        modeIdx = MODES.indexOf(mode);
        resetGame();
        practice = true;
        speedMul = gameMode.startSpeedMul;
        phase = f;
        boss.hp = boss.max = bossHpOf(f);
        player.hp = playerMaxHp;
        dmgMul = 1;
        midPickDone = true;
        swapOrbs = false;
        detour = false;
        patIdx = 0; patTime = 0;
        RL.reset();
        state = S.PLAY;
    }

    // plays one form for \`frames\` frames. returns the numbers that matter
    function episode(mode, f, frames, learn) {
        setup(mode, f);
        const r = { hits: 0, deaths: 0, frames, hitWindow: 0, maxBurst: 0, bulletsSum: 0 };
        const hitAt = [];
        for (let i = 0; i < frames; i++) {
            botMove();
            update();
            orbs = [];
            if (player.inv === HURT_INVINCIBLE_FRAMES) { r.hits++; hitAt.push(i); }
            if (state === S.OVER) { r.deaths++; state = S.PLAY; player.hp = playerMaxHp; player.inv = 120; bullets = []; beams = []; queue = []; }
            if (boss.hp < boss.max * 0.25) boss.hp = boss.max;
            r.bulletsSum += bullets.length;
        }
        for (let i = 0; i < hitAt.length; i++) {
            let n = 1;
            while (i + n < hitAt.length && hitAt[i + n] - hitAt[i] < 300) n++;
            r.maxBurst = Math.max(r.maxBurst, n);
        }
        RL.save();
        return r;
    }
    return { episode, modeOf };
})()`;
const sim = vm.runInContext(driver, ctx);

/* ---- run ---- */
const FRAMES = 2400; // 40 s per form
// eval / fresh: the learning is frozen and the boss plays its best known move (fresh = nothing learned = random)
if (mode === "eval" || mode === "fresh") vm.runInContext("RL.setLearning(false, 0.03)", ctx);
const rl = sim.modeOf("rl");
const reward0 = () => vm.runInContext("RL._internals.rewardSum", ctx);
const target = mode === "base" ? sim.modeOf("hard") : rl;
const names = ["一", "二", "三", "四", "五", "六", "七"];
const total = { hits: 0, frames: 0, deaths: 0 };
const per = names.map(() => ({ hits: 0, frames: 0, deaths: 0, maxBurst: 0, bullets: 0 }));
const t0 = Date.now();
const rw0 = reward0();
for (let round = 0; round < rounds; round++) {
    for (let f = 0; f < 7; f++) {
        const r = sim.episode(target, f, FRAMES);
        const p = per[f];
        p.hits += r.hits; p.frames += r.frames; p.deaths += r.deaths; p.maxBurst = Math.max(p.maxBurst, r.maxBurst); p.bullets += r.bulletsSum;
        total.hits += r.hits; total.frames += r.frames; total.deaths += r.deaths;
    }
    if (mode === "train" && (round + 1) % 5 === 0) {
        const hpm = (total.hits / (total.frames / 3600)).toFixed(2);
        console.log("round " + (round + 1) + "/" + rounds + "  被弾/分 " + hpm + "  (" + ((Date.now() - t0) / 1000).toFixed(0) + "s)");
    }
}
console.log("\n=== " + mode + " (" + (mode === "base" ? "理不尽モード・固定順" : mode === "fresh" ? "RLモード・学習前" : "RLモード") + ", " + rounds + "周, " + (WEAK ? "弱いBot" : "Bot") + "操作) ===");
console.log("形態  被弾/分  死亡/分  最大連続被弾(5秒内)  平均弾数");
per.forEach((p, i) => {
    const min = p.frames / 3600;
    console.log("第" + names[i] + "   " + (p.hits / min).toFixed(2).padStart(6) + "  " + (p.deaths / min).toFixed(2).padStart(6) + "  " + String(p.maxBurst).padStart(10) + "         " + (p.bullets / p.frames).toFixed(1));
});
const min = total.frames / 3600;
console.log("全体  " + (total.hits / min).toFixed(2).padStart(6) + "  " + (total.deaths / min).toFixed(2).padStart(6));
if (mode !== "base") console.log("ボスの報酬/分: " + ((reward0() - rw0) / min).toFixed(2) + "  (大きいほどボスAIにとって良い攻め)");
if (mode !== "base") {
    const info = vm.runInContext("({usage: RL._internals.usage, stats: RL._internals.stats})", ctx);
    console.log("学習手数:", info.stats.decisions, " 形態別:", info.stats.byForm.join("/"));
    const u = Object.entries(info.usage).sort((a, b) => b[1] - a[1]);
    console.log("技の使用回数(上位12):", u.slice(0, 12).map(([k, v]) => k + ":" + v).join("  "));
}
if (mode === "train") {
    const data = vm.runInContext("RL.exportData(2)", ctx);
    const json = JSON.stringify(data);
    fs.writeFileSync(path.join(ROOT, "rl-pretrained.js"), "/* ボスAIの初期状態 (tools/train-rl.js が生成)。ブラウザ内の学習はこれを土台にさらに続く */\nconst RL_PRETRAINED = " + json + ";\n");
    console.log("rl-pretrained.js に書き出しました (" + (json.length / 1024).toFixed(0) + " KB)");
}
