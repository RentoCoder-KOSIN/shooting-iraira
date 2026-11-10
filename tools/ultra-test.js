#!/usr/bin/env node
"use strict";
/* tools/ultra-test.js - 超理不尽モードの全1000技を作って動かし、公平性のルールを守っているか確認する (/beta)
 *   node tools/ultra-test.js            ... 静的な確認(例外・予告時間・数の上限・長さ)
 *   node tools/ultra-test.js --ai       ... さらにAI(ai.js)に避けさせて、被弾が多い技を一覧にする
 *   node tools/ultra-test.js --form 3   ... 第3形態だけ        --only 123  ... No.123 だけ
 *   --trials N                          ... AIの試行回数 (既定 3)
 *  ファイルは public/beta/ を優先し、無いものは public/ から読む(サーバーと同じ)。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const PUBLIC = path.join(__dirname, "..", "public");
const BETA = path.join(PUBLIC, "beta");
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const ORACLE = args.includes("--oracle"); // tools/ultra-oracle.js: a bot that looks 1.3 s ahead (warning lines included)
const WITH_AI = args.includes("--ai") || args.includes("--baseline");
const BASELINE = args.includes("--baseline"); // the AI plays the attacks of the 理不尽モード too (what is "normal" for this AI?)
const ONLY_FORM = opt("--form") ? Number(opt("--form")) : null;
const ONLY_NO = opt("--only") ? Number(opt("--only")) : null;
const TRIALS = Number(opt("--trials", 3));
const RANGE = opt("--range") ? opt("--range").split("-").map(Number) : null; // e.g. --range 700-703
const STRIDE = Number(opt("--stride", 1)); // test only every Nth attack of each form (a full run of 1000 takes about 45 minutes)
// the bot: "strong" = the real speed of the player (4 px / frame) and little margin = if even this one cannot dodge, the attack is unfair
//          "weak" (default) = 3 px / frame and a wide margin = how hard is it for something that is not perfect
const BOT = opt("--bot", "weak");
const BOSSX = opt("--bossx"); // fix the boss x position (the boss stands where it was left, otherwise)
const DUMP = args.includes("--dump"); // print where the beams are (use with --only)
const AI_DEPTH = opt("--depth"); // the AI looks AI_SEG x depth frames ahead (the game's value is 3 = 0.4 s; a human sees the warning 0.8-1.1 s ahead)

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
const saved = {};
const sandbox = {
    console,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => 0,
    fetch: () => Promise.reject(new Error("offline")),
    innerWidth: 480,
    innerHeight: 640,
    devicePixelRatio: 1,
    addEventListener() {},
    document: new Proxy({}, { get: (_, k) => (k === "getElementById" ? () => dummy() : k === "hidden" ? false : k === "activeElement" ? null : k === "documentElement" ? dummy() : () => undefined) }),
    localStorage: { getItem: (k) => (k in saved ? saved[k] : null), setItem: (k, v) => (saved[k] = v), removeItem: (k) => delete saved[k] },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
// the same order as /beta/index.html
vm.runInContext("var __RANGE = " + JSON.stringify(RANGE) + ";", ctx);
vm.runInContext("var __BOSSX = " + (BOSSX ? Number(BOSSX) : "null") + ";", ctx);
const EXTRA = ORACLE ? [["oracle", null]] : [];
for (const f of ["scoring.js", "config.js", "rl-pretrained.js", "rl.js", "net.js", "audio.js", "ai.js", "ultra-data.js", "ultra.js", "script.js"]) {
    const p = fs.existsSync(path.join(BETA, f)) ? path.join(BETA, f) : path.join(PUBLIC, f);
    let src = fs.readFileSync(p, "utf8");
    if (f === "ai.js" && AI_DEPTH) src = src.replace(/const AI_DEPTH = \d+;/, "const AI_DEPTH = " + Number(AI_DEPTH) + ";");
    vm.runInContext(src, ctx, { filename: f });
}
const ORACLE_SRC = () => {
    let src = fs.readFileSync(path.join(__dirname, "ultra-oracle.js"), "utf8");
    if (BOT === "strong") src = src.replace("const ORACLE_CELL = 6;", "const ORACLE_CELL = 8;").replace("const ORACLE_MARGIN = 8;", "const ORACLE_MARGIN = 4;");
    return src;
};

for (const [name] of EXTRA) vm.runInContext(ORACLE_SRC(), ctx, { filename: "ultra-oracle.js" });
const report = vm.runInContext(
    `(function (WITH_AI, ONLY_FORM, ONLY_NO, TRIALS, BASELINE, DUMP, ORACLE, STRIDE) {
    const problems = [];
    const note = (no, msg) => problems.push("No." + String(no).padStart(4, "0") + " " + msg);
    const ultraIdx = MODES.findIndex((m) => m.id === "ultra");
    const frames = (n) => { for (let i = 0; i < n; i++) update(); };
    const INVINCIBLE_FRAMES_FOR_TEST = 90;
    const out = { checked: 0, problems, hitsByNo: {}, stats: {}, lengths: [] };

    // ---- the mode itself ----
    if (ultraIdx < 0) throw new Error("the ultra mode is not registered");
    const mode = MODES[ultraIdx];
    if (mode.bossHp.length !== 10 || mode.sequences.length !== 10) note(0, "the mode must have 10 forms");
    if (ULTRA_NAMES.some((f) => f.length !== 100)) note(0, "every form needs 100 names");

    // ---- watch every beam that is made ----
    let minWarn = 1e9, realBeams = 0, decoysNotBlinking = 0;
    const origBeam = beam;
    beam = function (o) {
        const warn = o.warn ?? 240;
        if (o.dur > 0) { realBeams++; minWarn = Math.min(minWarn, warn); }
        else if (!((o.warnVis ?? warn) < warn)) decoysNotBlinking++; // a decoy must vanish before its (never coming) beam
        return origBeam(o);
    };

    const ids = [];
    ULTRA_NAMES.forEach((names, f) => { if (ONLY_FORM && ONLY_FORM !== f + 1) return; names.forEach((n, i) => { const no = f * 100 + i + 1; if (i % STRIDE !== 0) return; if ((!ONLY_NO || ONLY_NO === no) && (!__RANGE || (no >= __RANGE[0] && no <= __RANGE[1]))) ids.push([f, no]); }); });

    // ---- run each attack alone, nobody there to be hit ----
    chooseMode(ultraIdx);
    player.inv = 1e9; player.x = CX; player.y = 500;
    for (const [form, no] of ids) {
        const id = "u" + String(no).padStart(4, "0");
        const p = PATTERNS[id];
        let maxBeams = 0, maxBullets = 0;
        try {
            bullets = []; beams = []; hazards = []; queue = []; frame = 0; speedMul = 1.1;
            player.x = CX; player.y = 500; player.inv = 1e9;
            const len = p.duration;
            out.lengths.push(len);
            // a normal attack: 1 to 12.5 s. a 奥義 strings 3-4 stages together: up to 16 s
            const maxLen = U_ATTACKS[form].find((a) => a.no === no).finale ? 1000 : 760;
            if (!(len >= 60 && len <= maxLen)) note(no, "length " + len + " frames is out of range");
            for (let t = 0; t < len + 240; t++) {
                if (t < len) p.run(t);
                runQueue(); updateBullets(); updateBeams(); updateHazards(); frame++;
                maxBeams = Math.max(maxBeams, beams.length); maxBullets = Math.max(maxBullets, bullets.length);
                if (!isFinite(player.x) || bullets.some((b) => !isFinite(b.x) || !isFinite(b.y))) { note(no, "NaN position"); break; }
            }
            if (maxBeams > U_BEAM_CAP) note(no, "beams " + maxBeams);
            if (maxBullets > U_BULLET_CAP + 40) note(no, "bullets " + maxBullets);
            out.stats[no] = { form, maxBeams, maxBullets, len };
        } catch (e) {
            note(no, "exception: " + e.message);
        }
        out.checked++;
    }
    beam = origBeam;
    out.minWarn = minWarn; out.realBeams = realBeams; out.decoysNotBlinking = decoysNotBlinking;
    if (realBeams && minWarn < U_MIN_WARN) problems.push("a beam had a warning of " + minWarn + " frames (< " + U_MIN_WARN + ")");
    if (decoysNotBlinking) problems.push(decoysNotBlinking + " decoy line(s) that do not vanish");

    // ---- the mode select / the real sequence loop ----
    {
        bullets = []; beams = []; queue = [];
        chooseMode(ultraIdx);
        player.inv = 1e9;
        for (let f = 0; f < 10; f++) {
            phase = f; patIdx = 0; patTime = 0; boss.hp = boss.max = bossHpOf(f);
            let steps = 0, last = -1;
            const want = Math.min(sequencesOf()[f].length, 12);
            for (let i = 0; i < 12000 && steps <= want; i++) {
                boss.hp = 1e9; player.inv = 1e9;
                update(); orbs = [];
                if (patIdx !== last) { steps++; last = patIdx; }
            }
            if (steps < want) problems.push("form " + (f + 1) + ": the sequence did not advance (" + steps + " steps)");
        }
    }

    // ---- the look-ahead bot plays each attack alone (the boss stands still, the bot moves at 3 px / frame) ----
    if (ORACLE) {
        const origHurt = hurtPlayer;
        let hits = 0, lastHit = -999;
        hurtPlayer = function () { if (frame - lastHit > 90) { hits++; lastHit = frame; } };
        out.oracle = {};
        for (const [form, no] of ids) {
            const id = "u" + String(no).padStart(4, "0");
            const p = PATTERNS[id];
            if (DUMP) console.log("== No." + no);
            bullets = []; beams = []; hazards = []; queue = []; frame = 0; speedMul = 1.1;
            player.x = CX; player.y = 500; hits = 0; lastHit = -999; oracle.target = null; oracle.doomed = 0;
            if (__BOSSX !== null) boss.x = __BOSSX;
            for (let t = 0; t < p.duration + 120; t++) {
                oracleMove(t);
                if (DUMP && t % 6 === 0 && t <= 48) console.log("   plan@" + t + " player=(" + Math.round(player.x) + "," + Math.round(player.y) + ") -> " + JSON.stringify(oracle.target.path.map((q) => [q.x, q.y])) + " doomed=" + oracle.target.doomed);
                if (t < p.duration) p.run(t);
                runQueue(); updateBullets(); updateBeams(); updateHazards(); frame++;
                if (DUMP && t === 40) for (const b of beams) console.log("   path: " + JSON.stringify(beamPath(b).map((q) => q.map(Math.round))) + " w=" + b.w + " bounces=" + b.bounces);
                if (DUMP && t % 10 === 0) console.log("   t=" + t + " player=(" + Math.round(player.x) + "," + Math.round(player.y) + ") hits=" + hits + " beams: " + beams.map((b) => (b.a === PI / 2 ? "V" + Math.round(b.x) : b.a === 0 ? "H" + Math.round(b.y) : "D" + Math.round(b.x) + "/" + b.a.toFixed(2)) + (b.age > b.warn ? (b.age <= b.warn + b.dur ? "!" : "") : "(" + (b.warn - b.age) + ")")).join(" "));
            }
            out.oracle[no] = { hits, doomed: oracle.doomed };
        }
        hurtPlayer = origHurt;
    }

    // ---- the AI plays each attack ----
    if (WITH_AI) {
        const origHurt = hurtPlayer;
        // count hits like the game does: after a hit the player is invincible for a moment, so one beam = one hit
        let hits = 0, lastHit = -999;
        hurtPlayer = function () {
            if (frame - lastHit > INVINCIBLE_FRAMES_FOR_TEST) { hits++; lastHit = frame; }
        };
        const playOnce = (modeIdx, form, id) => {
            aiSetPlay(true);
            chooseMode(modeIdx);
            phase = form; boss.hp = boss.max = 1e9;
            sequencesOf()[form] = [[id]];
            patIdx = 0; patTime = 0; hits = 0;
            const len = PATTERNS[id].duration;
            for (let i = 0; i < len + 90 && state === S.PLAY; i++) {
                boss.hp = 1e9; update(); orbs = [];
                if (DUMP && (i === 0 || i % 20 === 0) && i <= 140) console.log("   beams@" + i + ": " + beams.filter((b) => b.age <= b.warn + b.dur).map((b) => Math.round(b.x) + (b.age > b.warn ? "*" : "")).join(" ") + "  | player x=" + Math.round(player.x));
                if (ONLY_NO && i % 30 === 0) console.log("  t=" + i + " player=(" + Math.round(player.x) + "," + Math.round(player.y) + ") hits=" + hits + " beams=" + beams.length + " bullets=" + bullets.length);
            }
            return hits;
        };
        if (BASELINE) {
            // the attacks of the 理不尽モード (the same AI, the same way of counting)
            const hardIdx = MODES.findIndex((m) => m.id === "hard");
            const names = [...new Set(MODES[hardIdx].sequences.flat(2))].filter((n) => PATTERNS[n] && n !== "orbs");
            const saveSeq = MODES[hardIdx].sequences.map((f) => f.slice());
            out.baseline = {};
            for (const n of names) {
                let total = 0;
                for (let k = 0; k < TRIALS; k++) { total += playOnce(hardIdx, 0, n); MODES[hardIdx].sequences.forEach((f, i) => (f.length = 0, f.push(...saveSeq[i]))); }
                out.baseline[n] = total / TRIALS;
            }
        }
        for (const [form, no] of ids) {
            const id = "u" + String(no).padStart(4, "0");
            let total = 0;
            for (let trial = 0; trial < TRIALS; trial++) total += playOnce(ultraIdx, form, id);
            out.hitsByNo[no] = total / TRIALS;
        }
        hurtPlayer = origHurt;
    }
    return out;
})`,
    ctx,
)(WITH_AI, ONLY_FORM, ONLY_NO, TRIALS, BASELINE, DUMP, ORACLE, STRIDE);

const lens = report.lengths;
console.log("checked " + report.checked + " attacks; length " + Math.min(...lens) + ".." + Math.max(...lens) + " frames (avg " + Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) + ")");
console.log("beams made: " + report.realBeams + ", the shortest warning: " + report.minWarn + " frames, decoys that do not vanish: " + report.decoysNotBlinking);
if (ORACLE) {
    const rows = Object.entries(report.oracle).map(([no, r]) => [Number(no), r]);
    const hit = rows.filter(([, r]) => r.hits > 0);
    const doomed = rows.filter(([, r]) => r.doomed > 0);
    const attacks = vm.runInContext("U_ATTACKS.flat().map((a) => [a.no, a.delivery, a.mods.join(','), a.name])", ctx);
    const info = Object.fromEntries(attacks.map(([no, d, m, n]) => [no, d + ":" + m + " " + n]));
    console.log("ORACLE: attacks the bot got hit by: " + hit.length + " / " + rows.length + "; attacks with a moment without any safe path: " + doomed.length);
    for (const [no, r] of hit.sort((a, b) => b[1].hits - a[1].hits).slice(0, 40)) console.log("  hit No." + no + " x" + r.hits + " (doomed " + r.doomed + ")  " + info[no]);
    const byShape = {};
    for (const [no, r] of rows) { const k = info[no].split(":")[0]; (byShape[k] = byShape[k] || []).push(r.hits > 0 ? 1 : 0); }
    console.log("hit rate by shape: " + Object.entries(byShape).map(([k, v]) => k + " " + v.filter(Boolean).length + "/" + v.length).join(" | "));
}
if (BASELINE) {
    const b = Object.entries(report.baseline);
    const avgB = b.reduce((a, [, h]) => a + h, 0) / (b.length || 1);
    console.log("BASELINE (理不尽モード " + b.length + " patterns, same AI): average hits " + avgB.toFixed(2) + "; " + b.map(([n, h]) => n + ":" + h.toFixed(1)).join(" "));
}
if (WITH_AI) {
    const hits = Object.entries(report.hitsByNo).map(([no, h]) => [Number(no), h]);
    const bad = hits.filter(([, h]) => h > 0).sort((a, b) => b[1] - a[1]);
    const avg = hits.reduce((a, [, h]) => a + h, 0) / (hits.length || 1);
    console.log("AI: average hits per attack " + avg.toFixed(2) + "; attacks hit at least once: " + bad.length + " / " + hits.length);
    console.log("worst: " + bad.slice(0, 25).map(([no, h]) => no + ":" + h.toFixed(1)).join("  "));
}
if (WITH_AI) {
    const byShape = {}, byMod = {};
    const attacks = vm.runInContext("U_ATTACKS.flat().map((a) => [a.no, a.delivery, a.mods])", ctx);
    for (const [no, shape, mods] of attacks) {
        if (report.hitsByNo[no] === undefined) continue;
        (byShape[shape] = byShape[shape] || []).push(report.hitsByNo[no]);
        for (const m of mods) (byMod[m] = byMod[m] || []).push(report.hitsByNo[no]);
    }
    const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
    console.log("by shape: " + Object.entries(byShape).map(([k, v]) => k + " " + avg(v) + " (" + v.length + ")").join(" | "));
    console.log("by mod:   " + Object.entries(byMod).map(([k, v]) => k + " " + avg(v) + " (" + v.length + ")").join(" | "));
}
for (const p of report.problems.slice(0, 60)) console.log("PROBLEM " + p);
if (report.problems.length > 60) console.log("... and " + (report.problems.length - 60) + " more problems");
console.log(report.problems.length ? "FAILED (" + report.problems.length + " problems)" : "ALL OK");
process.exit(report.problems.length ? 1 : 0);
