"use strict";
/* ============================================================================
 *  ultra.js - 超理不尽モード (/beta)
 *
 *  元資料: 「超理不尽モード 第1形態〜第10形態・全1000技名一覧」「攻撃詳細一覧」(技名は ultra-data.js)
 *  全10形態 x 100技。技名は「変化(反射・分裂・追尾 ...)」と「形(線・玉・格子・回廊 ...)」の組み合わせで
 *  できているので、技名のキーワードから攻撃を組み立てる（1000技を1つずつ手書きしない）。
 *
 *    技名 --(tagsOf)--> { delivery: 形, mods: [変化 ...] } --(buildAttack)--> 攻撃（予告 → 発射 → 変化）
 *
 *  公平性のルール（資料の「実装時の共通ルール」より）。どの技もこれを守って組み立てる:
 *    - 予告線は発射の0.7秒前(U_MIN_WARN。早い形態は1秒近く)から出す。変化する弾は、変化の0.4秒前(U_CUE)から白く光る
 *    - 必ず通れる隙間を残す（隙間の幅は自機の当たり判定の十数倍）
 *    - 弾やビームの数に上限を付ける（U_BULLET_CAP / U_BEAM_CAP）
 *    - 追尾・分裂・反射は同時に全部は起こさず、時間をずらす
 *    - 偽の予告（フェイント）は必ず「点滅して消える」。本物は消えない
 *
 *  読み込み順: config.js -> ultra-data.js -> ultra.js -> script.js （script.js が起動時に MODES を検査するため）
 *  この技の作り方の確認は tools/ultra-test.js（全1000技を作って動かし、AIに避けさせる）
 * ========================================================================== */

const U_BEAM_CAP = 24;
const U_BULLET_CAP = 340;
const U_MIN_WARN = 42; // 0.7 s (the last forms)
const U_DIFFICULTY = 1.4; // global difficulty multiplier: raises density, speed, and tighter patterns across every form
const U_CUE = 24; // 0.4 s
const U_DECOY_VIS = 30; // a decoy warning line blinks and vanishes after this many frames

const uRand = (a, b) => a + Math.random() * (b - a);
const uPick = (arr) => arr[(Math.random() * arr.length) | 0];
const uSign = () => (Math.random() < 0.5 ? -1 : 1);
const uClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uMuzzle = () => ({ x: boss.x, y: boss.y + BOSS_MUZZLE_Y });
// the last 3 seconds of the player's positions (an attack records one per frame while it runs)
const uTrail = [];

/* ---- bullets: one programmable path ("uPlan") ----
 *  A bullet carries a plan: acts that happen at an exact age. 0.4 s before an act the bullet glows white.
 *    stop    stands still            go      starts again (towards st.ang or the player)
 *    speed   changes speed (st.k)    turn    turns by st.by rad
 *    reverse flies back              split   bursts into st.n small bullets
 *    vanish  disappears (decoys)     aim     flies at the player (speed st.v)
 *  b.bounces = how many times it may bounce off the side walls. b.home = { until, rate } steers to the player. */
const U_ACTS = {
    stop(b) {
        b.vx = 0;
        b.vy = 0;
    },
    go(b, st) {
        const a = st.ang === "aim" || st.ang === undefined ? aim(b.x, b.y) : st.ang;
        const v = st.v === undefined ? b.speed : st.v * speedMul;
        b.vx = Math.cos(a) * v;
        b.vy = Math.sin(a) * v;
    },
    aim(b, st) {
        U_ACTS.go(b, { ang: "aim", v: st.v });
    },
    speed(b, st) {
        b.vx *= st.k;
        b.vy *= st.k;
    },
    turn(b, st) {
        const a = Math.atan2(b.vy, b.vx) + st.by;
        const v = Math.hypot(b.vx, b.vy);
        b.vx = Math.cos(a) * v;
        b.vy = Math.sin(a) * v;
    },
    reverse(b) {
        b.vx = -b.vx;
        b.vy = -b.vy;
    },
    split(b, st) {
        const { x, y } = b;
        const a0 = st.ang ?? Math.atan2(b.vy, b.vx);
        const v = st.v ?? Math.max(1.6, Math.hypot(b.vx, b.vy) * 0.9);
        b.x = -999; // moving far away removes it (same trick as "splitter")
        for (let i = 0; i < st.n; i++) {
            const a = a0 + (i - (st.n - 1) / 2) * (st.spread ?? 0.55);
            if (bullets.length < U_BULLET_CAP) shoot("uS", x, y, a, v / speedMul);
        }
    },
    vanish(b) {
        b.x = -999;
    },
};
PATHS.uPlan = (b) => {
    if (b.home && b.age < b.home.until) {
        const want = aim(b.x, b.y);
        const cur = Math.atan2(b.vy, b.vx);
        const d = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        const na = cur + uClamp(d, -b.home.rate, b.home.rate);
        const v = Math.hypot(b.vx, b.vy);
        b.vx = Math.cos(na) * v;
        b.vy = Math.sin(na) * v;
    }
    if (b.plan)
        for (const st of b.plan) {
            if (b.age === st.at - U_CUE) b.color = "#fff"; // the cue: it glows before it changes
            if (b.age === st.at) {
                b.color = b.baseColor;
                U_ACTS[st.act](b, st);
            }
        }
    if (b.bounces > 0) {
        if ((b.x < b.r && b.vx < 0) || (b.x > W - b.r && b.vx > 0)) {
            b.vx = -b.vx;
            b.bounces--;
        }
    }
};
// every ultra bullet: no pace (a constant speed), no random stops
BULLET_TYPES.u = { r: 5, color: "#ff4169", path: "uPlan", paces: [], randomTempo: false };
BULLET_TYPES.uS = { r: 4, color: "#ff8aa0", path: "uPlan", paces: [], randomTempo: false };
BULLET_TYPES.uBig = { r: 9, color: "#c4f", path: "uPlan", paces: [], randomTempo: false };

// shoots a bullet that carries a plan; `speed` is in px/frame (like shoot())
function uOrb(type, x, y, angle, speed, o = {}) {
    if (bullets.length >= U_BULLET_CAP) return;
    const color = o.color ?? BULLET_TYPES[type].color;
    shoot(type, x, y, angle, speed, { color, baseColor: color, ...o });
}

/* ---- beams ---- */
// warn = frames from the warning line to the beam. vis < warn = the line blinks and vanishes before the beam
// (a decoy has dur = 0: only the line). The geometry is fixed when the line appears.
function uBeam(g, o = {}) {
    if (beams.length >= U_BEAM_CAP) return null;
    const warn = Math.max(U_MIN_WARN, o.warn ?? 60);
    beam({
        x: g.x,
        y: g.y,
        angle: g.angle,
        turn: o.turn ?? 0,
        warn,
        warnVis: o.vis ?? warn,
        dur: o.dur ?? 26,
        width: o.width ?? 22,
        bounces: o.bounces ?? 0,
        trackPlayer: o.trackPlayer ?? false,
    });
    return beams[beams.length - 1];
}
const uVert = (x) => ({ x, y: 0, angle: PI / 2 });
const uHorz = (y) => ({ x: 0, y, angle: 0 });
const uFromBoss = (angle) => ({ ...uMuzzle(), angle });
const uAimBoss = () => uFromBoss(aim(boss.x, boss.y + BOSS_MUZZLE_Y));
// decoy: a warning line that blinks and vanishes (never fires)
const uDecoy = (g, o = {}) => uBeam(g, { ...o, dur: 0, vis: U_DECOY_VIS, warn: Math.max(o.warn ?? 60, U_DECOY_VIS + 6) });

/* ---- the script of one attack ----
 *  Events at exact frames (like attackTimeline() in config.js, but the content is made when the attack starts,
 *  so positions that depend on the player are fixed at that moment). */
class UScript {
    constructor() {
        this.items = [];
        this.ticks = [];
        this.end = 0;
    }
    at(t, fn) {
        this.items.push({ t: Math.round(t), fn });
        this.end = Math.max(this.end, Math.round(t));
        return this;
    }
    tick(fn) {
        this.ticks.push(fn);
    }
    run(t) {
        for (const it of this.items) if (it.t === t) it.fn(t);
        for (const k of this.ticks) k(t);
    }
}

/* ============================================================================
 *  deliveries (形): what is thrown. Each takes (S, c, t0) and returns the frame where it is over.
 *  c = { lv, wn, sp, mir, has(tag) }   lv = form index (0..9)   wn = warning frames   sp = bullet speed (px/frame)
 *  The modifiers (変化) change the content; the ones a delivery does not use are simply ignored.
 * ========================================================================== */

// the player's moving direction over the last 10 frames -> where it will be in `frames` frames
function uPredict(frames) {
    const n = uTrail.length;
    if (n < 12) return { x: player.x, y: player.y };
    const a = uTrail[n - 11];
    const vx = (player.x - a.x) / 10,
        vy = (player.y - a.y) / 10;
    return {
        x: uClamp(player.x + vx * frames, 20, W - 20),
        y: uClamp(player.y + vy * frames, 60, H - 20),
    };
}
// Aim at the position the player is likely to reach while a bullet travels.
function uAim(x, y, speed) {
    const n = uTrail.length;
    if (n < 12) return aim(x, y);
    const a = uTrail[n - 11];
    const vx = (player.x - a.x) / 10;
    const vy = (player.y - a.y) / 10;
    const travel = uClamp(Math.hypot(player.x - x, player.y - y) / Math.max(1, speed), 0, 36);
    return Math.atan2(player.y + vy * travel - y, player.x + vx * travel - x);
}
// x positions the player visited recently (spread apart), for the "軌道記憶" attacks
function uVisited(count) {
    const xs = [];
    for (let i = uTrail.length - 1; i >= 0 && xs.length < count; i -= 8) {
        const x = uTrail[i].x;
        if (xs.every((v) => Math.abs(v - x) > 70)) xs.push(x);
    }
    while (xs.length < count) xs.push(uClamp(player.x + (xs.length + 1) * uSign() * 90, 40, W - 40));
    return xs;
}
const uMirrorX = (c, x) => (c.mir ? W - x : x);
const uLerp = (a, b, t) => a + (b - a) * t;

/* ---- how hard: c.h = 0..1 (a form's place between "a first form" and "the last form"; U_DIFFICULTY scales all of it)
 *  Every number below that makes an attack harder is a uLerp(easy, hard, c.h): more things, closer together, narrower gaps. */

// ---- 線: beams ----
function dLine(S, c, t0) {
    const h = c.h;
    const n = Math.min(9, Math.round(uLerp(4, 8, h))) - (c.passes > 1 ? 1 : 0) - (c.light ? 1 : 0);
    const shape = c.has("fall")
        ? "H"
        : c.has("cross")
          ? "X"
          : c.has("spin")
            ? "S"
            : c.has("homing") || c.has("reflect")
              ? "B"
              : "V";
    const tracked = [];
    let t = t0,
        lastX = null,
        side = uSign();
    const visited = c.has("record") ? [] : null;
    for (let i = 0; i < n; i++) {
        const step = c.has("accel")
            ? Math.max(14, uLerp(34, 22, h) - i * uLerp(5, 6, h))
            : c.has("chain")
              ? uLerp(30, 19, h)
              : uLerp(34, 24, h);
        const hold = c.has("stop") && i === 0 ? 36 : 0; // 停止: the first line waits longer
        const warn = c.wn + hold;
        const width = Math.round(uLerp(20, 26, h));
        S.at(t, () => {
            if (visited && !visited.length) visited.push(...uVisited(n));
            let g;
            if (shape === "V") {
                let x = visited ? visited[i] : lastX === null ? player.x : uClamp(lastX + side * uRand(90, 140), 40, W - 40);
                if (lastX !== null && Math.abs(x - lastX) < 60) x = uClamp(lastX + side * 100, 40, W - 40);
                x = uMirrorX(c, x);
                side = -side;
                lastX = x;
                g = uVert(x);
                if (c.has("decoy")) uDecoy(uVert(uClamp(x + side * 130, 40, W - 40)), { warn });
                uBeam(g, { warn, width });
            } else if (shape === "H") {
                const dir = player.y < H / 2 ? 1 : -1;
                const y = uClamp(player.y + dir * i * uLerp(105, 90, h), 70, H - 70);
                if (c.has("decoy")) uDecoy(uHorz(uClamp(y + dir * 90, 70, H - 70)), { warn });
                uBeam(uHorz(y), { warn, width });
            } else if (shape === "X") {
                const cx = uClamp(uMirrorX(c, player.x), 160, W - 160);
                uBeam({ x: cx - 150, y: 0, angle: PI / 2 - 0.5 }, { warn, width });
                uBeam({ x: cx + 150, y: 0, angle: PI / 2 + 0.5 }, { warn: warn + 16, width });
            } else if (shape === "S") {
                const sg = uSign();
                uBeam(uFromBoss(PI / 2 + sg * 0.34), { warn, turn: -sg * uLerp(0.0062, 0.0085, h), dur: 70, width: 20 });
            } else {
                const ang = uClamp(aim(boss.x, boss.y + BOSS_MUZZLE_Y), 0.45, PI - 0.45);
                const b = uBeam(uFromBoss(ang), { warn, bounces: c.has("reflect") ? 2 : 0, width: 18, trackPlayer: true });
                if (b && c.has("homing")) tracked.push({ b, until: frame + warn - U_CUE });
            }
            if (c.has("split") && shape !== "S") {
                // 分裂: two more lines from the same place, a little later
                const base = shape === "B" ? uClamp(aim(boss.x, boss.y + BOSS_MUZZLE_Y), 0.45, PI - 0.45) : PI / 2;
                const o = shape === "B" ? uMuzzle() : { x: lastX ?? player.x, y: 0 };
                for (const d of [-0.5, 0.5]) uBeam({ x: o.x, y: o.y, angle: base + d }, { warn: warn + 36, width: 16 });
            }
        });
        t += step;
    }
    S.tick(() => {
        for (const k of tracked) if (frame < k.until) k.b.a = aim(k.b.x, k.b.y); // 追尾: the line follows you, then locks (and glows)
    });
    return t + c.wn + 40;
}

// ---- 扇: a fan of beams from the boss. The second fan is shifted by half a beam spacing: the lane you stood in is a beam now ----
function dFan(S, c, t0) {
    const h = c.h;
    const count = Math.round(uLerp(5, 9, h)) | 1; // odd
    const span = uLerp(1.7, 2.0, h);
    const waves = Math.round(uLerp(2, 4, h)) + (c.has("chain") || c.has("double") ? 1 : 0);
    const gapTime = Math.max(42, Math.round(uLerp(52, 42, h))); // between two waves (a beam lasts 26 frames: what is left is the time to shift)
    S.at(t0, () => {
        const m = uMuzzle();
        const spacing = span / (count - 1);
        const turn = c.has("spin") ? uSign() * 0.004 : 0;
        for (let w = 0; w < waves; w++) {
            const off = (w % 2) * spacing * 0.5 * (c.has("reverse") && w > 1 ? -1 : 1);
            for (let i = 0; i < count; i++) {
                const ang = PI / 2 - span / 2 + i * spacing + off;
                if (w === 0 && c.has("decoy") && i % 2 === 1) uDecoy({ ...m, angle: ang }, { warn: c.wn });
                else uBeam({ ...m, angle: ang }, { warn: c.wn + w * gapTime, width: 16, turn, dur: turn ? 40 : 26 });
            }
        }
    });
    return t0 + c.wn + waves * gapTime + 50;
}

// ---- 弾幕: rings of bullets from the boss, each with a gap that moves round ----
function dRings(S, c, t0) {
    const h = c.h;
    const rings = Math.min(7, Math.round(uLerp(3, 6, h))) - (c.light ? 1 : 0);
    const period = Math.max(30, Math.round(uLerp(46, 32, h)));
    const count = Math.min(30, Math.round(uLerp(20, 28, h)));
    const gapOrbs = Math.max(3, Math.round(uLerp(4, 3, h))); // the gap: this many orbs missing
    let phi = null,
        dir = uSign();
    for (let r = 0; r < rings; r++) {
        S.at(t0 + r * period, () => {
            const m = uMuzzle();
            if (phi === null) phi = aim(m.x, m.y) + uSign() * 0.5;
            else phi += dir * uLerp(0.55, 0.85, h);
            if (c.has("reverse") && r % 2 === 1) dir = -dir;
            const gapAt = phi;
            const startAngle = r * 0.11;
            for (let i = 0; i < count; i++) {
                const a = startAngle + (i * 2 * PI) / count;
                const d = Math.atan2(Math.sin(a - gapAt), Math.cos(a - gapAt));
                if (Math.abs(d) < (gapOrbs * PI) / count) continue;
                const plan = c.has("accel") ? [{ at: 50, act: "speed", k: 1.6 }] : c.has("stop") ? [{ at: 30, act: "stop" }, { at: 54, act: "go", ang: a, v: c.sp * 1.4 }] : [];
                if (c.has("decoy") && i % 5 === 2) uOrb("uS", m.x, m.y, a, c.sp * 0.9, { plan: [{ at: U_DECOY_VIS + 4, act: "vanish" }], color: "#8899aa" });
                else uOrb("u", m.x, m.y, a, c.sp * 0.9, { plan });
            }
        });
    }
    return t0 + rings * period + 170;
}

// ---- 区画: the screen is four sectors; three of them blow up, the safe one moves round ----
function dSector(S, c, t0) {
    const h = c.h;
    const phases = Math.round(uLerp(4, 7, h)) + (c.has("chain") ? 1 : 0);
    const period = Math.max(60, Math.round(uLerp(76, 62, h))); // the time between two blasts (a blast lasts 24 frames: 38+ frames left to walk to the next sector)
    // clockwise. (W is known only once the game has started: this is made inside the events)
    const centers = () => [
        [W * 0.27, 240],
        [W * 0.73, 240],
        [W * 0.73, 460],
        [W * 0.27, 460],
    ];
    let safe = null,
        dir = uSign();
    for (let k = 0; k < phases; k++) {
        S.at(t0 + k * period, () => {
            if (safe === null) {
                // the sector the player stands in is safe the first time
                let best = 0,
                    bd = 1e9;
                centers().forEach(([x, y], i) => {
                    const d = Math.hypot(x - player.x, y - player.y);
                    if (d < bd) ((bd = d), (best = i));
                });
                safe = best;
            } else {
                if (c.has("reverse") && k % 3 === 0) dir = -dir;
                safe = (safe + dir + 4) % 4;
            }
            centers().forEach(([x, y], i) => {
                if (i !== safe) hazard({ x, y, r: Math.round(uLerp(118, 128, h)), delay: c.wn, life: 24 });
            });
        });
    }
    return t0 + phases * period + c.wn;
}

// ---- 玉: orbs ----
function dOrb(S, c, t0) {
    if (c.has("ring")) return dRings(S, c, t0);
    const h = c.h;
    const n = Math.min(18, Math.round(uLerp(7, 16, h))) - (c.passes > 1 ? 2 : 0) - (c.light ? 1 : 0);
    const sp = c.sp;
    const shape = c.has("wave")
        ? "wave"
        : c.has("fall")
          ? "rain"
          : c.has("converge")
            ? "ring"
            : c.has("cross")
              ? "cross"
              : c.has("spin")
                ? "spiral"
                : "fan";
    // the plan every orb of this attack carries (changes happen at exact ages, with a cue)
    const plan = [];
    const o = {};
    if (c.has("stop")) plan.push({ at: 38, act: "stop" }, { at: 70, act: "go", ang: "aim", v: sp * 1.9 });
    else if (c.has("accel")) plan.push({ at: 42, act: "speed", k: 2.3 });
    if (c.has("reverse")) plan.push({ at: 58, act: "reverse" }, { at: 118, act: "reverse" });
    if (c.has("split") && !c.has("stop")) plan.push({ at: 52, act: "split", n: 3 });
    if (c.has("split") && c.has("stop")) plan.push({ at: 96, act: "split", n: 3 });
    if (c.has("homing")) o.home = { until: 52, rate: 0.032 };
    if (c.has("reflect")) o.bounces = 2;
    plan.sort((a, b) => a.at - b.at);
    const base = c.has("accel") && !c.has("stop") ? 0.75 : 1;
    const fire = (type, x, y, ang, k = 1, extra = {}) => uOrb(type, x, y, ang, sp * base * k, { plan, ...o, ...extra });
    const decoyOf = (i) => c.has("decoy") && i % 2 === 1;
    const orb = (i, x, y, ang, k = 1, extra = {}) => {
        if (decoyOf(i)) uOrb("uS", x, y, ang, sp * k, { plan: [{ at: U_DECOY_VIS + 4, act: "vanish" }], color: "#8899aa" });
        else fire("u", x, y, ang, k, extra);
    };
    const step = c.has("chain") ? Math.round(uLerp(14, 9, h)) : c.has("delay") ? 10 : 0;
    if (shape === "fan" || shape === "spiral") {
        for (let i = 0; i < n; i++) {
            S.at(t0 + i * step + (shape === "spiral" ? i * 6 : 0), () => {
                const m = uMuzzle();
                let a;
                if (shape === "spiral") a = ((i * 2.399963) % (2 * PI)) + (c.mir ? PI : 0);
                else if (c.has("record")) {
                    const p = uTrail[Math.max(0, uTrail.length - 1 - i * 14)] ?? player;
                    a = Math.atan2(p.y - m.y, p.x - m.x);
                } else a = uAim(m.x, m.y, sp * base) + (i - (n - 1) / 2) * (c.has("reflect") ? 0.3 : uLerp(0.17, 0.12, h));
                if (shape === "spiral" && Math.sin(a) < -0.2) a = -a; // keep most of them on the screen
                orb(i, m.x, m.y, a, shape === "spiral" ? 0.85 : 1);
            });
        }
        return t0 + (n - 1) * (step + (shape === "spiral" ? 6 : 0)) + 150;
    }
    if (shape === "rain" || shape === "wave") {
        const sheets = shape === "wave" ? 2 : 1;
        for (let sh = 0; sh < sheets; sh++)
            S.at(t0 + sh * 46, () => {
                const lane = uClamp(player.x + uSign() * uRand(110, 170), 70, W - 70);
                const band = uLerp(62, 46, h);
                let i = 0;
                for (let x = 24; x < W; x += uLerp(40, 34, h), i++) {
                    if (Math.abs(x - lane) < band) continue;
                    const dly = c.has("chain") ? i * 3 : 0;
                    // 波: each column zigzags (the turns are cued like every change)
                    const zig =
                        shape === "wave"
                            ? [
                                  { at: 26, act: "turn", by: i % 2 ? 0.55 : -0.55 },
                                  { at: 60, act: "turn", by: i % 2 ? -1.1 : 1.1 },
                                  { at: 94, act: "turn", by: i % 2 ? 1.1 : -1.1 },
                              ]
                            : null;
                    orb(i, x, -8 - dly * 2, PI / 2, 1, { delay: c.has("delay") ? (i % 3) * 14 : 0, ...(zig ? { plan: zig } : {}) });
                }
            });
        return t0 + (sheets - 1) * 46 + 190;
    }
    if (shape === "ring") {
        S.at(t0, () => {
            const cx = uClamp(player.x, 120, W - 120),
                cy = uClamp(player.y, 200, H - 120);
            // the opening of the ring faces the roomier side
            const open = cx < W / 2 ? 0 : PI;
            const R = 200;
            const count = Math.round(uLerp(16, 22, h));
            const gap = uLerp(0.62, 0.5, h);
            for (let i = 0; i < count; i++) {
                const a = (i * 2 * PI) / count;
                const d = Math.atan2(Math.sin(a - open), Math.cos(a - open));
                if (Math.abs(d) < gap) continue; // the gap
                const x = cx + Math.cos(a) * R,
                    y = cy + Math.sin(a) * R;
                orb(i, x, y, a + PI, 0.8);
            }
        });
        return t0 + 200;
    }
    // cross: two groups from the left and the right
    S.at(t0, () => {
        const rowsN = Math.round(uLerp(6, 8, h));
        const sp2 = uLerp(58, 46, h);
        for (let i = 0; i < rowsN; i++) {
            const y = 110 + i * sp2 + (c.mir ? sp2 / 2 : 0);
            orb(i, -8, y, 0.14, 1);
            orb(i + 1, W + 8, y + sp2 / 2, PI - 0.14, 1);
        }
    });
    return t0 + 190;
}

// ---- 格子: lattice ----
function dGrid(S, c, t0) {
    const h = c.h;
    const G = Math.max(80, uLerp(104, 82, h));
    S.at(t0, () => {
        const gapX = uClamp(player.x + uSign() * uRand(40, 120), 80, W - 80);
        const gapY = uClamp(player.y + uSign() * uRand(40, 110), 140, H - 120);
        const moved = c.has("gap") || c.has("reverse") || c.has("chain") || h > 0.6;
        const gapX2 = moved ? uClamp(gapX + uSign() * uRand(110, 150), 80, W - 80) : gapX;
        const warn = c.wn;
        const gapFrac = uLerp(0.55, 0.5, h);
        for (let x = 36; x < W; x += G) if (Math.abs(x - gapX) > G * gapFrac) uBeam(uVert(x), { warn, width: 20 });
        for (let y = 130; y < H - 40; y += G) if (Math.abs(y - gapY) > G * gapFrac) uBeam(uHorz(y), { warn: warn + 32, width: 20 });
        if (moved) for (let x = 36; x < W; x += G) if (Math.abs(x - gapX2) > G * gapFrac) uBeam(uVert(x), { warn: warn + 68, width: 20 });
    });
    return t0 + c.wn + 70 + 60;
}

// ---- 回廊/安全窓: a wall of beams with a gap that moves ----
function dCorridor(S, c, t0) {
    const h = c.h;
    const lanes = 9;
    const walls = (c.has("chain") || c.has("double") || c.has("reverse") ? 3 : 2) + (h > 0.7 ? 1 : 0);
    const spacing = Math.max(38, Math.round(uLerp(50, 38, h))); // between two walls (a beam lasts 26 frames)
    S.at(t0, () => {
        const step = W / lanes;
        let gap = uClamp(player.x + uSign() * uRand(70, 130), 70, W - 70);
        for (let k = 0; k < walls; k++) {
            const warn = c.wn + k * spacing;
            for (let i = 0; i < lanes; i++) {
                const x = step * (i + 0.5);
                if (Math.abs(x - gap) < step * Math.max(0.95, uLerp(1.15, 0.95, h))) continue; // the gap
                uBeam(uVert(x), { warn, width: 26 });
            }
            if (c.has("decoy") && k === 0) uDecoy(uVert(gap), { warn });
            // the next gap: it moves, but never further than the player can walk in the time between the walls
            gap = uClamp(gap + uSign() * uRand(95, uLerp(125, 140, h)), 70, W - 70);
        }
    });
    return t0 + c.wn + walls * spacing + 60;
}

// ---- 包囲/封鎖/網: pairs of beams that close in on a corridor ----
function dNet(S, c, t0) {
    const h = c.h;
    const stages = Math.min(6, Math.round(uLerp(3, 5, h)));
    const stepGap = Math.max(24, Math.round(uLerp(30, 24, h)));
    S.at(t0, () => {
        const cx = uClamp(player.x, 150, W - 150);
        let d = 215;
        for (let k = 0; k < stages; k++) {
            const warn = c.wn + k * stepGap;
            for (const sg of [-1, 1]) uBeam(uVert(cx + sg * d), { warn, width: 24 });
            d = Math.max(70, d - uLerp(38, 34, h)); // the last pair leaves a corridor of about 70-90 px
        }
        if (c.has("decoy")) uDecoy(uVert(cx), { warn: c.wn });
        if (c.has("spin") || c.has("cross") || h > 0.65) {
            uBeam(uHorz(uClamp(player.y - 130, 90, H - 200)), { warn: c.wn + stages * stepGap + 10, width: 20 });
        }
    });
    return t0 + c.wn + stages * stepGap + 60;
}

// ---- 狩り/狙撃: beams from the boss at where you are / will be ----
function dHunt(S, c, t0) {
    const h = c.h;
    const shots = Math.min(8, Math.round(uLerp(3, 6, h)) + (c.has("chain") ? 1 : 0)) - (c.light ? 1 : 0);
    let t = t0;
    for (let i = 0; i < shots; i++) {
        const predicted = c.has("record") || c.has("homing") || i > 0;
        S.at(t, () => {
            const p = predicted ? uPredict(c.wn) : player;
            const m = uMuzzle();
            const ang = uClamp(Math.atan2(p.y - m.y, p.x - m.x), 0.35, PI - 0.35);
            const b = uBeam(uFromBoss(ang), { warn: c.wn, width: Math.round(uLerp(18, 22, h)), bounces: c.has("reflect") ? 1 : 0, trackPlayer: true });
            if (b && c.has("split")) uBeam(uFromBoss(ang + (i % 2 ? 0.45 : -0.45)), { warn: c.wn + 28, width: 16 });
            if (b && c.has("delay")) uBeam(uFromBoss(ang), { warn: c.wn + 50, width: 18 }); // the same line again, later
            if (c.has("decoy")) uDecoy(uFromBoss(ang + uSign() * 0.4), { warn: c.wn });
        });
        t += Math.round(c.wn * uLerp(0.62, 0.42, h) + (c.has("accel") ? 4 : 16)) - Math.min(i * 3, 10);
    }
    return t + 60;
}

// ---- 列: rows of orbs with a gap ----
function dRow(S, c, t0) {
    const h = c.h;
    const rows = Math.min(8, Math.round(uLerp(4, 7, h)));
    let gap = null; // the gap of the first row is chosen when the attack starts (it depends on where you are)
    const period = Math.round(c.has("accel") ? uLerp(46, 36, h) : uLerp(58, 42, h));
    for (let k = 0; k < rows; k++) {
        S.at(t0 + k * period, () => {
            gap = gap === null ? uClamp(player.x + uSign() * 90, 90, W - 90) : uClamp(gap + uSign() * uRand(80, uLerp(115, 130, h)), 90, W - 90);
            const g = gap;
            const hole = uLerp(50, 40, h) + (c.has("decoy") ? 4 : 0);
            let i = 0;
            for (let x = 22; x < W; x += 34, i++) {
                if (Math.abs(x - g) < hole + 22) continue;
                // 加速: speeds up halfway down. 停止: stops for a moment, then drops fast
                const plan = c.has("accel")
                    ? [{ at: 48, act: "speed", k: 1.8 }]
                    : c.has("stop")
                      ? [
                            { at: 40, act: "stop" },
                            { at: 66, act: "go", ang: PI / 2, v: c.sp * 1.6 },
                        ]
                      : [];
                uOrb("u", x, -8, PI / 2, c.sp * 0.95, { plan });
            }
        });
    }
    return t0 + rows * period + 130;
}

const U_DELIVERIES = { line: dLine, orb: dOrb, grid: dGrid, corridor: dCorridor, net: dNet, hunt: dHunt, row: dRow, fan: dFan, sector: dSector };

/* ============================================================================
 *  name -> { delivery, mods }
 *  mods keep this order (it is also the priority: at most 3 are used)
 * ========================================================================== */
const U_MODS = [
    ["wave", /波|蛇行|蛇/],
    ["ring", /円環|円形|円周|弾幕|リング|波紋|全域/],
    ["reflect", /反射|鏡|跳躍|折返|折曲|端点/],
    ["split", /分裂|分岐|分割|枝|散開|拡散/],
    ["homing", /追尾|追跡|追撃|誘導|予測|逃走|先読|照準|狙撃|狩/],
    ["stop", /停止|停滞|止|凍/],
    ["accel", /加速|高速|瞬|超速|速度|突進|追越|急|光速|ブースト/],
    ["reverse", /反転|逆|戻|交換|入替|入れ替|往復/],
    ["delay", /遅延|時間差|遅|予約|残響/],
    ["chain", /連鎖|連続|連結|連携|連射|交互|順番/],
    ["double", /二重|二段|三重|三段|二連|三連|多重/],
    ["cross", /交差|挟|十字|斜|同期/],
    ["fall", /落下|降下|雨|ダイブ|着弾/],
    ["decoy", /偽|消失|消去|残像|影|虚|錯覚|フェイント|表裏|コピー|復活/],
    ["converge", /収束|集束|圧縮|縮小|圧迫|狭窄|包囲|封鎖|囲/],
    ["spin", /回転|螺旋|周回|渦|旋回/],
    ["record", /未来|軌道|記憶|記録|過去|零秒|審判|時間(?!差)/],
];
// the shape: the first one that matches (an orb is anything whose name ends with 玉 / 弾)
const U_SHAPES = [
    ["finale", /形態奥義/],
    ["orb", /(玉|弾|球|珠|分裂|急襲)$/],
    ["fan", /扇|掃射|ブレード/],
    ["sector", /区画|区域|セクター|四方|空間分割|全方位/],
    ["grid", /格子/],
    ["corridor", /回廊|窓|通路|隙間|安全地帯|安全圏|空白|牢獄/],
    ["net", /包囲|封鎖|網|囲|檻/],
    ["hunt", /狩|狙撃|予測|追撃|追跡|照準|審判/],
    ["row", /列/],
];
// the modifiers a shape already is (so they are not applied twice)
const U_IMPLIED = { corridor: ["gap"], net: ["converge"] };

function uTags(name) {
    const delivery = (U_SHAPES.find(([, re]) => re.test(name)) || ["line"])[0];
    const implied = U_IMPLIED[delivery] || [];
    const mods = U_MODS.filter(([tag, re]) => re.test(name) && !implied.includes(tag))
        .map(([tag]) => tag)
        .slice(0, 3);
    return { delivery, mods };
}

/* ---- composing an attack out of stages ----
 *  A stage = a delivery + modifiers. A normal attack has one stage (twice when it is a 遅延 / 二重 one:
 *  the same thing again, mirrored, a bit faster). A 奥義 (finale) strings three different stages together. */
function uContext(lv, mods, pass, passes, extra = {}) {
    const set = new Set(mods);
    const h = Math.min(1.3, (0.4 + (0.6 * lv) / 9) * U_DIFFICULTY); // 0.5 (form 1) .. 1.25 (form 10)
    return {
        lv,
        h,
        passes,
        mir: pass === 1,
        wn: Math.max(U_MIN_WARN, Math.round(uLerp(62, 40, h)) - pass * 6),
        sp: uLerp(2.9, 4.4, h) * 1.08,
        has: (tag) => set.has(tag),
        ...extra,
    };
}
// A normal attack of the later forms is a compound one: a second, lighter attack of another kind starts while the first is
// still running (beams + bullets, as in the document's "ビームと珠の連携"). Which attacks are compound is fixed by the number.
const uHash = (n) => (((n * 2654435761) >>> 0) % 1000) / 1000;
const U_SIDE_OF_BEAMS = ["orb:", "orb:homing", "orb:stop", "orb:fall", "orb:cross", "orb:spin"];
const U_SIDE_OF_ORBS = ["line:", "hunt:", "line:homing", "fan:", "net:", "line:cross"];
const U_BEAMISH = ["line", "grid", "corridor", "net", "hunt", "fan"];
function uSideOf(stage, no, lv) {
    const h = uContext(lv, [], 0, 1).h;
    if (uHash(no) >= uLerp(0.45, 1.05, h)) return null;
    const pool = U_BEAMISH.includes(stage.delivery) ? U_SIDE_OF_BEAMS : U_SIDE_OF_ORBS;
    return { ...uParse(pool[Math.floor(uHash(no + 7) * pool.length)]), offset: 30 + Math.floor(uHash(no + 13) * 50) };
}
function uCompose(stages, lv, no = 0) {
    const S = new UScript();
    let t = 0;
    stages.forEach((st, k) => {
        const twice = stages.length === 1 && (st.mods.includes("delay") || st.mods.includes("double"));
        for (let pass = 0; pass < (twice ? 2 : 1); pass++) {
            t = U_DELIVERIES[st.delivery](S, uContext(lv, st.mods, pass, twice ? 2 : 1), t);
            if (pass === 0 && twice) t -= 30; // the second one starts while the first one is dying out
        }
        if (k < stages.length - 1) t += 20; // a breath between the stages of a 奥義
    });
    const side = no && stages.length === 1 ? uSideOf(stages[0], no, lv) : null;
    if (side) {
        const end = U_DELIVERIES[side.delivery](S, uContext(lv, side.mods, 0, 1, { light: true }), side.offset);
        t = Math.max(t, end);
    }
    S.length = Math.ceil(t);
    S.compound = !!side;
    S.tick(() => {
        uTrail.push({ x: player.x, y: player.y });
        if (uTrail.length > 180) uTrail.shift();
    });
    return S;
}
const uParse = (recipe) => {
    const [delivery, mods = ""] = recipe.split(":");
    return { delivery, mods: mods ? mods.split(",") : [] };
};

// ---- 奥義 of each form: three stages that show what the form is about ----
const U_FINALE = [
    "corridor:chain|orb:fall,stop|line:chain,accel", // 1 覚醒
    "line:accel,cross|orb:stop,accel|hunt:accel,chain", // 2 速度変化
    "hunt:homing,chain|orb:homing,converge|net:homing", // 3 追尾・包囲
    "line:homing,chain|orb:split,chain|grid:chain", // 4 連携
    "line:decoy,delay|orb:decoy,reverse|corridor:decoy", // 5 真実と虚像
    "corridor:chain|net:converge|grid:reverse", // 6 安全地帯崩壊
    "line:spin,split|orb:spin,split|net:spin", // 7 空間分岐・回転
    "line:reflect,reverse|orb:reflect,reverse|hunt:reflect,split", // 8 鏡像・反射
    "hunt:record,delay|orb:record,delay|line:record,delay", // 9 時間予測
    "grid:chain|orb:split,homing,reverse|hunt:record,split", // 10 終極
].map((s) => s.split("|").map(uParse));
// The ten 奥義 of the last form (第十奥義 -> 第一奥義), in the order of the document
const U_OUGI = [
    ["零秒の審判", "line:chain,delay,reverse|hunt:delay,record"],
    ["無限分岐牢獄", "line:reflect,split|orb:split,reflect|corridor"],
    ["真偽崩壊", "corridor:decoy|grid:decoy,reverse"],
    ["回転世界崩落", "net:spin|line:spin,reverse|orb:spin,split"],
    ["未来狩猟網", "hunt:record,homing|orb:record,homing|line:record"],
    ["最後の一歩", "corridor:chain|orb:fall,split|net:converge"],
    ["鏡像反転地獄", "line:cross,reverse,reflect|orb:cross,reverse|grid:reverse"],
    ["全域連鎖崩壊", "orb:homing,chain|line:reflect,chain|grid:chain"],
    ["沈黙する終末", "row:chain|line:cross,delay|orb:split,stop"],
    ["終極理不尽", "grid:chain|orb:homing,split|hunt:record,split|corridor:chain,decoy"],
].map(([name, r]) => ({ name, stages: r.split("|").map(uParse) }));

/* ---- the 1000 attacks ---- */
const U_FORMS = ULTRA_NAMES.length; // 10
const uNo = (form, i) => form * 100 + i + 1; // No. 1..1000
const U_ATTACKS = ULTRA_NAMES.map((names, form) =>
    names.map((name, i) => {
        const tag = uTags(name);
        const stages = tag.delivery === "finale" ? U_FINALE[form] : [tag];
        const build = () => uCompose(stages, form, tag.delivery === "finale" ? 0 : uNo(form, i));
        return { no: uNo(form, i), name, ...tag, finale: tag.delivery === "finale", build, length: build().length };
    }),
);
const uShown = { no: 0, name: "" }; // the attack that is running (shown on the screen)

// one pattern for a fixed attack
function uPattern(atk, label = atk) {
    let cur = null;
    return {
        duration: atk.length,
        run(t) {
            if (t === 0 || !cur) {
                cur = atk.build();
                uShown.no = atk.no;
                uShown.name = atk.name;
            }
            cur.run(t);
        },
    };
}
// a slot: picks the next attack of the form when it starts (random, not the last 12 of the form again)
const uRecent = U_ATTACKS.map(() => []);
function uNextAttack(form) {
    const pool = U_ATTACKS[form].filter((a) => !a.finale && !uRecent[form].includes(a.no));
    const a = uPick(pool);
    uRecent[form].push(a.no);
    if (uRecent[form].length > 12) uRecent[form].shift();
    return a;
}
function uSlot(form) {
    let cur = null;
    return {
        get duration() {
            return cur ? cur.length : 60; // read every frame by runPatterns(): the step lasts as long as the picked attack
        },
        run(t) {
            if (t === 0 || !cur) {
                const a = uNextAttack(form);
                cur = a.build();
                uShown.no = a.no;
                uShown.name = a.name;
            }
            cur.run(t);
        },
    };
}
// a finale pattern: a numbered 奥義 of the form (form 1..9: the form's own ones in turn), or one of the ten 奥義 (form 10)
function uFinale(form, k) {
    const ougi = U_ATTACKS[form].filter((a) => a.finale);
    let cur = null;
    return {
        get duration() {
            return cur ? cur.length : 60;
        },
        run(t) {
            if (t === 0 || !cur) {
                let stages, no, name;
                if (form === U_FORMS - 1) {
                    const o = U_OUGI[k % U_OUGI.length];
                    stages = o.stages;
                    no = 0;
                    name = "第" + "十九八七六五四三二一"[k % 10] + "奥義「" + o.name + "」";
                } else {
                    const a = ougi[k % ougi.length];
                    stages = U_FINALE[form];
                    no = a.no;
                    name = a.name;
                }
                cur = uCompose(stages, form);
                uShown.no = no;
                uShown.name = name;
            }
            cur.run(t);
        },
    };
}

/* ---- the mode ---- */
const ULTRA_HP = [200, 230, 265, 300, 335, 370, 405, 440, 475, 520];
const ULTRA_SLOTS = 5; // attacks between two 奥義
const ULTRA_SEQUENCES = ULTRA_NAMES.map((_, form) => {
    const steps = [];
    const finales = form === U_FORMS - 1 ? U_OUGI.length : 1;
    for (let k = 0; k < finales; k++) {
        for (let s = 0; s < (form === U_FORMS - 1 ? 2 : ULTRA_SLOTS); s++) {
            const name = "uSlot" + form + "_" + k + "_" + s;
            PATTERNS[name] = uSlot(form);
            steps.push([name]);
        }
        const fin = "uFinale" + form + "_" + k;
        PATTERNS[fin] = uFinale(form, k);
        steps.push([fin]);
    }
    return steps;
});
// every single attack also exists as a pattern: PATTERNS["u0123"] (used by the tests / the practice of one attack)
for (const form of U_ATTACKS) for (const a of form) PATTERNS["u" + String(a.no).padStart(4, "0")] = uPattern(a);

MODES.push({
    id: "ultra",
    label: "超理不尽モード",
    tabLabel: "超理不尽",
    desc: "全10形態・全1000技（βテスト）",
    bossHp: ULTRA_HP,
    formTitles: ULTRA_TITLES,
    detourMaxForm: 8,
    sequences: ULTRA_SEQUENCES,
    color: "#c4f",
    startSpeedMul: 1.1,
    bossHealRatio: 0.15,
    redDmgMul: 1,
    ranked: false, // no ranking board for this mode yet
    rowWave: true,
});

// the attack name on the screen (called from draw() in script.js)
function uDrawName() {
    if (gameMode.id !== "ultra" || !uShown.name) return;
    const label = (uShown.no ? "No." + String(uShown.no).padStart(4, "0") + "  " : "") + uShown.name;
    drawText(label, CX, H - 14, 15, "rgba(210,190,255,.85)");
}
