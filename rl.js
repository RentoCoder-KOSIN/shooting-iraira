"use strict";
/* ============================================================================
 *  rl.js - RLモードのボスAI (強化学習 = 表形式Q学習)
 *
 *  理不尽モードと同じ7形態・同じHP・同じ玉の効果。違うのはボスの中身だけ:
 *    ・ボスの「動き」を AI が決める (左右にゆらゆらではなく、追う/逃げる/ショットをよける)
 *    ・「何を撃つか・どの順番で撃つか」を AI が決める (固定の順番はない)
 *
 *  AI が選べる行動 (ACTIONS)
 *    micro : 短い攻撃 (狙い扇, リング, 狙撃, 雨, 追尾 ...)  ← この AI 専用に作った技
 *    macro : 理不尽モードの攻撃パターン (config.js の SEQUENCES_HARD にある1ステップ分)
 *            ← 作者が「避けられる」と確認済みの技を、固定順ではなく AI が選んで出す
 *  AI が選べる動き (MOVES): ゆらゆら / プレイヤーを追う / 反対側へ逃げる / ショットをよける
 *
 *  学習: ε-greedy + Q学習 (SMDP版)。報酬 = かすり + 被弾 + プレイヤーを動かした量 - ボスが受けたダメージ
 *  学習結果は localStorage に保存されて、次に遊ぶときも続きから成長する。
 *
 *  「無理ゲーにしない」ための安全装置 (学習結果に関係なくいつも効く / GUARD と書いた部分):
 *    1. 攻撃は同時に1つだけ (技を重ねない)。重ねるのは作者が確認した組み合わせだけ
 *    2. 画面内の弾数に上限 (形態ごと)。超えそうな技は選べない
 *    3. 弾はまず薄く見える状態で止まって (テレグラフ)、少ししてから動き出す
 *    4. プレイヤーの近く (SAFE_R) には弾を出さない
 *    5. 同じ技を連続で出さない / 大技にはクールダウン
 *    6. 短時間に3回当たったら「休憩」(攻撃を止める)。残りHPが少ない時は大技を封印
 *    7. 当たりすぎている時は、当てても報酬が減る → 避けやすい方向に学習が寄る
 *    8. ボスは速く動きすぎない (BOSS_MAX_V)。12秒ダメージを受けなければ疲れて動きが止まる
 * ========================================================================== */
const RL = (() => {
    const VERSION = 1;
    const STORE_KEY = "irritating-game:rl-v" + VERSION;
    const SAVE_EVERY = 900; // frames between automatic saves

    /* ---- learning ---- */
    const GAMMA = 0.9; // discount per second
    const EPS_START = 0.3; // exploration at the beginning of a form ...
    const EPS_MIN = 0.06; // ... shrinking to this as the AI gains experience
    const EPS_DECAY = 1200; // decisions
    const R_GRAZE = 0.12; // a bullet passes close to you
    const R_HIT = 1.0; // you are hit (reduced when you are being hit a lot, see GUARD 7)
    const R_MOVE = 0.002; // per pixel the player moved (makes the player keep moving)
    const R_BOSS_DMG = 0.015; // per HP the boss loses (teaches the boss to dodge your shots)
    const R_OVERLOAD = 0.2; // per second above 90% of the bullet cap
    const HIT_TARGET = 3; // hits per 10 s at which hitting stops being rewarded
    const GRAZE_R = 14; // extra radius (px) that counts as "close"

    /* ---- GUARD: fairness ---- */
    const SAFE_R = 70; // nothing appears this close to the player
    const TELEGRAPH = 10; // frames a new bullet waits (faint) before it starts moving
    const BUDGET = [60, 70, 80, 90, 100, 110, 120]; // max bullets on screen per form
    const MACRO_MAX_BULLETS = 40; // a macro attack only starts when the screen is this empty
    const CALM_HITS = 3; // this many hits ...
    const CALM_WINDOW = 300; // ... within this many frames ...
    const CALM_FRAMES = 150; // ... stop all attacks for this long
    const MERCY_HP = 2; // effective HP (hp / damage multiplier) at or below this: no big attacks
    const BOSS_MAX_V = 2.4; // px per frame
    const TIRED_AFTER = 720; // no damage for this long -> the boss gets tired
    const TIRED_FRAMES = 240; // ... and just sways for this long
    const MOVE_DECIDE_FRAMES = 45;
    const BOSS_MARGIN = 50;

    const MOVES = ["ゆらゆら", "追う", "逃げる", "よける"];
    const N_STATE = 135; // states per form: 5 (x) * 3 (y) * 3 (movement) * 3 (bullets)

    /* ---- helpers ---- */
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const bossY = () => boss.y + BOSS_MUZZLE_Y;
    let form = -1; // the form that is being fought
    let govSpeed = 1; // bullet speed scale (grows a little with the form, smaller when merciful)

    // one bullet. GUARD 3 + 4: it waits `delay` frames, and never appears next to the player
    function fire(type, x, y, ang, v, opts) {
        if (Math.hypot(x - player.x, y - player.y) < SAFE_R) return;
        shoot(type, x, y, ang, v * govSpeed, { delay: TELEGRAPH, ...opts });
    }
    function fireRing(type, n, v, offset, opts) {
        for (let i = 0; i < n; i++) fire(type, boss.x, bossY(), offset + (i * 2 * PI) / n, v, opts);
    }
    const aimNow = () => Math.atan2(player.y - bossY(), player.x - boss.x);

    /* ---- micro attacks (made for the AI) ----
     *  count : how many bullets it adds (for the bullet cap)   rest : frames of rest afterwards
     *  heavy : not used when the player is nearly dead         unlock : first form (0 = form 1)  */
    const MICRO = [
        { id: "wait", name: "溜め", count: 0, rest: 24, heavy: false, unlock: 0, run() {} },
        {
            id: "fan", name: "狙い扇", count: 9, rest: 42, heavy: false, unlock: 0,
            run() {
                const n = 5 + (form >= 2 ? 2 : 0);
                const a = aimNow();
                for (let i = 0; i < n; i++) fire("normal", boss.x, bossY(), a + (i - (n - 1) / 2) * 0.2, 3.0);
            },
        },
        {
            id: "ring", name: "リング", count: 16, rest: 50, heavy: true, unlock: 0,
            run() {
                fireRing("normal", 12 + (form >= 3 ? 2 : 0) + (form >= 5 ? 2 : 0), 2.2, rand(0, PI));
            },
        },
        {
            id: "snipe", name: "連続狙撃", count: 3, rest: 60, heavy: false, unlock: 1,
            run() {
                for (let k = 0; k < 3; k++)
                    later(k * 14, () => fire("normal", boss.x, bossY(), aimNow(), 3.8, { delay: 8 }));
            },
        },
        {
            id: "rain", name: "弾の雨", count: 20, rest: 70, heavy: true, unlock: 0,
            run() {
                for (let w = 0; w < 2; w++)
                    later(w * 35, () => {
                        const off = rand(0, 64);
                        for (let x = off + 20; x < W - 10; x += 64) fire("normal", x, -8, PI / 2, 2.5 + 0.1 * form, { delay: 6 });
                    });
            },
        },
        {
            id: "homing", name: "追尾玉", count: 2, rest: 70, heavy: false, unlock: 2,
            run() {
                const a = aimNow();
                fire("homing", boss.x, bossY(), a - 0.5, 2.4, { delay: 12 });
                fire("homing", boss.x, bossY(), a + 0.5, 2.4, { delay: 12 });
            },
        },
        {
            id: "cross", name: "十字砲火", count: 2, rest: 60, heavy: false, unlock: 1,
            run() {
                fire("normal", -8, player.y, 0, 3.4, { delay: 16 });
                later(30, () => fire("normal", W + 8, player.y, PI, 3.4, { delay: 16 }));
            },
        },
        {
            id: "spiral", name: "渦巻き", count: 24, rest: 60, heavy: true, unlock: 3,
            run() {
                const base = rand(0, PI);
                for (let k = 0; k < 3; k++) later(k * 10, () => fireRing("normal", 8, 2.3, base + k * 0.45));
            },
        },
        {
            id: "burst", name: "ばらまき", count: 8, rest: 40, heavy: false, unlock: 0,
            run() {
                for (let i = 0; i < 8; i++) fire("normal", boss.x, bossY(), PI / 2 + rand(-0.9, 0.9), rand(2, 3.2));
            },
        },
    ];

    /* ---- macro attacks: the steps of the 理不尽 mode attack lists (author-checked) ---- */
    const MACROS = (() => {
        const seen = new Map();
        SEQUENCES_HARD.forEach((formSteps, fi) =>
            formSteps.forEach((step) => {
                const id = step.join("+");
                if (!seen.has(id))
                    seen.set(id, {
                        id,
                        names: [...step],
                        unlock: fi,
                        weight: step.length,
                        dur: Math.max(...step.map((n) => PATTERNS[n].duration)),
                    });
            })
        );
        return [...seen.values()];
    })();

    const ACTIONS = [
        ...MICRO.map((m) => ({ ...m, kind: "micro" })),
        ...MACROS.map((m) => ({ ...m, kind: "macro", name: m.names.join("+"), rest: 0, count: 0, heavy: false })),
    ];
    const A = ACTIONS.length;
    const SIG = ACTIONS.map((a) => a.id).join(",");

    /* ---- the learned tables (sparse: only visited states exist) ---- */
    const table = new Map(); // stateKey -> { q: Float32Array(A), n: Uint16Array(A) }
    const mtable = new Map(); // stateKey -> { q: Float32Array(4), n: Uint16Array(4) }
    let stats = { decisions: 0, byForm: Array(7).fill(0), episodes: 0 };
    const entry = (t, key, size) => {
        let e = t.get(key);
        if (!e) t.set(key, (e = { q: new Float32Array(size), n: new Uint16Array(size) }));
        return e;
    };

    /* ---- run state ---- */
    let macro = null; // { a, t }
    let cool = 0; // frames until the next decision
    let calm = 0; // frames of "no attacks" (GUARD 6)
    let tired = 0;
    let moveMode = 0;
    let nextMoveAt = 0;
    let pending = null; // the attack decision waiting for its reward { key, a, start }
    let mpending = null; // the same for the movement decision
    let acc = 0,
        macc = 0; // reward collected since the decision
    let recent = []; // last chosen actions
    let cd = []; // action index -> frame when it can be used again
    let hitFrames = [];
    let lastBossHp = 0;
    let lastDropFrame = 0;
    let lastPx = 0,
        lastPy = 0;
    let pxHist = [];
    let label = "";
    let lastEps = 0;
    let saveAt = 0;
    let learnOn = true; // tools/train-rl.js can freeze the learning to compare policies
    let epsFixed = null; // ... and fix the exploration
    let rewardSum = 0; // total reward collected (for the tool)
    const usage = {}; // action id -> times chosen (for tools/train-rl.js)

    function softReset() {
        macro = null;
        cool = 20;
        pending = null;
        mpending = null;
        acc = macc = 0;
        recent = [];
        cd = Array(A).fill(0);
        nextMoveAt = frame + 10;
        lastDropFrame = frame;
        lastBossHp = boss.hp;
        lastPx = player.x;
        lastPy = player.y;
        pxHist = [];
        tired = 0;
        label = "";
    }
    function reset() {
        form = -1;
        calm = 0;
        hitFrames = [];
        moveMode = 0;
        softReset();
        syncForm();
    }
    function syncForm() {
        const f = fightForm();
        if (f !== form) {
            form = f;
            softReset();
        }
    }

    /* ---- state ---- */
    function stateKey() {
        const rel = (player.x - boss.x) / W;
        const px = rel < -0.25 ? 0 : rel < -0.08 ? 1 : rel <= 0.08 ? 2 : rel <= 0.25 ? 3 : 4;
        const py = player.y < 260 ? 0 : player.y < 450 ? 1 : 2;
        const old = pxHist.length ? pxHist[0] : player.x;
        const mv = player.x - old;
        const pv = mv > 24 ? 2 : mv < -24 ? 0 : 1;
        const bl = bullets.length < 20 ? 0 : bullets.length < 50 ? 1 : 2;
        return form * N_STATE + ((px * 3 + py) * 3 + pv) * 3 + bl;
    }
    const eps = () => (epsFixed !== null ? epsFixed : Math.max(EPS_MIN, EPS_START * Math.exp(-stats.byForm[form] / EPS_DECAY)));
    const learning = () => learnOn && (typeof usedAdmin === "undefined" || !usedAdmin); // admin runs teach nothing

    /* ---- reward bookkeeping (every frame) ---- */
    // every reward goes to both windows (attack decision / movement decision) and to the total
    function add(x) {
        acc += x;
        macc += x;
        rewardSum += x;
    }
    function observe() {
        for (const b of bullets) {
            if (b.grazed || b.delay > 0) continue;
            if (Math.hypot(b.x - player.x, b.y - player.y) < b.r + GRAZE_R) {
                b.grazed = true;
                add(R_GRAZE);
            }
        }
        add(R_MOVE * Math.hypot(player.x - lastPx, player.y - lastPy));
        lastPx = player.x;
        lastPy = player.y;
        if (boss.hp < lastBossHp) {
            add(-(lastBossHp - boss.hp) * R_BOSS_DMG);
            lastDropFrame = frame;
        }
        lastBossHp = boss.hp;
        if (bullets.length > BUDGET[form] * 0.9) add(-R_OVERLOAD / 60);
        pxHist.push(player.x);
        if (pxHist.length > 20) pxHist.shift();
    }

    // called by hurtPlayer() in script.js
    function onHit() {
        hitFrames.push(frame);
        hitFrames = hitFrames.filter((f) => frame - f < 600);
        add(R_HIT * Math.max(0, 1 - hitFrames.length / HIT_TARGET)); // GUARD 7
        if (hitFrames.filter((f) => frame - f < CALM_WINDOW).length >= CALM_HITS) {
            calm = CALM_FRAMES; // GUARD 6: a short break
            macro = null;
        }
        cool = Math.max(cool, 50);
    }

    /* ---- choosing an attack ---- */
    function allowedMask() {
        const mercy = player.hp / (typeof dmgMul === "number" ? dmgMul : 1) <= MERCY_HP;
        const cap = BUDGET[form];
        const mask = new Array(A).fill(false);
        for (let i = 0; i < A; i++) {
            const a = ACTIONS[i];
            if (calm > 0) {
                mask[i] = a.id === "wait";
                continue;
            }
            if (a.unlock > form || cd[i] > frame) continue;
            if (a.kind === "micro" && bullets.length + a.count > cap) continue;
            if (a.kind === "macro" && bullets.length > MACRO_MAX_BULLETS) continue;
            if (mercy && ((a.kind === "macro" && a.weight >= 4) || a.heavy)) continue;
            if (recent.slice(-3).filter((r) => r === i).length >= 2) continue; // GUARD 5: no spamming
            if (a.kind === "macro" && recent[recent.length - 1] === i) continue;
            mask[i] = true;
        }
        if (!mask.some(Boolean)) mask[0] = true; // "wait" is always possible
        return mask;
    }

    function pickAction(e, mask) {
        const ok = [];
        for (let i = 0; i < A; i++) if (mask[i]) ok.push(i);
        if (Math.random() < eps()) {
            // explore: half of the time a micro attack, half of the time a macro (keeps the variety)
            const micro = ok.filter((i) => ACTIONS[i].kind === "micro" && ACTIONS[i].id !== "wait");
            const mac = ok.filter((i) => ACTIONS[i].kind === "macro");
            const pool = micro.length && (!mac.length || Math.random() < 0.5) ? micro : mac.length ? mac : ok;
            return pool[(Math.random() * pool.length) | 0];
        }
        let best = -1e9,
            list = [];
        for (const i of ok) {
            if (e.q[i] > best + 1e-9) {
                best = e.q[i];
                list = [i];
            } else if (Math.abs(e.q[i] - best) <= 1e-9) list.push(i);
        }
        return list[(Math.random() * list.length) | 0];
    }

    function learnStep(e, a, r, frames, maxNext) {
        const target = r + Math.pow(GAMMA, Math.max(1, frames / 60)) * maxNext;
        const alpha = Math.max(0.05, 1 / (2 + e.n[a]));
        e.q[a] += alpha * (target - e.q[a]);
        if (e.n[a] < 65535) e.n[a]++;
    }

    function decide() {
        syncGov();
        const key = stateKey();
        const e = entry(table, key, A);
        const mask = allowedMask();
        if (pending && learning()) {
            let maxNext = -1e9;
            for (let i = 0; i < A; i++) if (mask[i] && e.q[i] > maxNext) maxNext = e.q[i];
            const frames = frame - pending.start;
            learnStep(entry(table, pending.key, A), pending.a, acc / Math.max(1, frames / 60), frames, maxNext);
        }
        const a = pickAction(e, mask);
        pending = { key, a, start: frame };
        acc = 0;
        const act = ACTIONS[a];
        recent.push(a);
        if (recent.length > 6) recent.shift();
        stats.decisions++;
        stats.byForm[form]++;
        usage[act.id] = (usage[act.id] || 0) + 1;
        lastEps = eps();
        label = act.name;
        if (act.kind === "micro") {
            act.run();
            cool = Math.round(act.rest * (1 - 0.05 * form));
        } else {
            macro = { a, t: 0 };
            cd[a] = frame + act.dur + 420; // GUARD 5: a big attack is not repeated soon
        }
    }

    function syncGov() {
        const mercy = player.hp / (typeof dmgMul === "number" ? dmgMul : 1) <= MERCY_HP;
        govSpeed = (1 + 0.02 * form) * (mercy ? 0.9 : 1);
    }

    /* ---- running a macro attack exactly like runPatterns() does ---- */
    function runMacro() {
        const act = ACTIONS[macro.a];
        for (const name of act.names) {
            const p = PATTERNS[name];
            if (macro.t < p.duration) p.run(macro.t);
        }
        macro.t++;
        const waiting = act.names.some((n) => {
            const type = PATTERNS[n].waitClear;
            return type && bullets.some((b) => b.type === type);
        });
        if (!waiting && macro.t >= act.dur) {
            macro = null;
            cool = 45;
        }
    }

    /* ---- the movement decision ---- */
    function decideMove() {
        const key = stateKey();
        const e = entry(mtable, key, MOVES.length);
        if (mpending && learning()) {
            let maxNext = -1e9;
            for (let i = 0; i < MOVES.length; i++) maxNext = Math.max(maxNext, e.q[i]);
            const frames = frame - mpending.start;
            learnStep(entry(mtable, mpending.key, MOVES.length), mpending.a, macc / Math.max(1, frames / 60), frames, maxNext);
        }
        let a;
        if (Math.random() < eps()) a = (Math.random() * MOVES.length) | 0;
        else {
            let best = -1e9,
                list = [];
            for (let i = 0; i < MOVES.length; i++) {
                if (e.q[i] > best + 1e-9) {
                    best = e.q[i];
                    list = [i];
                } else if (Math.abs(e.q[i] - best) <= 1e-9) list.push(i);
            }
            a = list[(Math.random() * list.length) | 0];
        }
        mpending = { key, a, start: frame };
        macc = 0;
        moveMode = a;
        nextMoveAt = frame + MOVE_DECIDE_FRAMES;
    }

    // x the boss wants to be at (the dodge target moves away from the nearest incoming shot)
    function dodgeTarget() {
        let near = null;
        for (const s of shots) {
            if (s.y < boss.y || Math.abs(s.x - boss.x) > 70) continue;
            if (!near || s.y < near.y) near = s;
        }
        if (!near) return null;
        return boss.x + (boss.x < near.x ? -100 : 100);
    }

    // called by updatePlay() every frame instead of the fixed sway
    function moveBoss() {
        let target = CX + Math.sin(frame / BOSS_MOVE_PERIOD) * BOSS_MOVE_AMP * (W / 480); // the old sway
        if (!macro && tired <= 0) {
            if (moveMode === 1) target = player.x;
            else if (moveMode === 2) target = player.x < CX ? W - 80 : 80;
            else if (moveMode === 3) {
                const d = dodgeTarget();
                if (d !== null) target = d;
            }
        }
        target = clamp(target, BOSS_MARGIN, W - BOSS_MARGIN);
        boss.x += clamp((target - boss.x) * 0.08, -BOSS_MAX_V, BOSS_MAX_V); // GUARD 8
    }

    // called by updatePlay() every frame instead of runPatterns()
    function update() {
        syncForm();
        observe();
        if (calm > 0) calm--;
        if (tired > 0) tired--;
        else if (frame - lastDropFrame > TIRED_AFTER) {
            tired = TIRED_FRAMES; // GUARD 8: the player must always be able to hurt the boss
            lastDropFrame = frame;
        }
        if (frame >= saveAt) {
            saveAt = frame + SAVE_EVERY;
            save();
        }
        if (!macro && frame >= nextMoveAt) decideMove();
        if (macro) {
            runMacro();
            return;
        }
        if (cool > 0) {
            cool--;
            return;
        }
        if (beams.length || queue.length) return; // wait until the last attack is really over
        decide();
    }

    /* ---- save / load ---- */
    function exportData(digits = 3) {
        const dump = (t) => {
            const out = {};
            for (const [k, e] of t) {
                const row = {};
                for (let i = 0; i < e.q.length; i++)
                    if (e.n[i] > 0) row[i] = [Number(e.q[i].toFixed(digits)), e.n[i]];
                if (Object.keys(row).length) out[k] = row;
            }
            return out;
        };
        return { v: VERSION, sig: SIG, stats, t: dump(table), m: dump(mtable) };
    }
    function importData(d) {
        if (!d || d.v !== VERSION || d.sig !== SIG) return false;
        const fill = (t, src, size) => {
            t.clear();
            for (const [k, row] of Object.entries(src || {})) {
                const e = entry(t, Number(k), size);
                for (const [i, qn] of Object.entries(row)) {
                    e.q[i] = qn[0];
                    e.n[i] = qn[1];
                }
            }
        };
        fill(table, d.t, A);
        fill(mtable, d.m, MOVES.length);
        stats = { decisions: 0, byForm: Array(7).fill(0), episodes: 0, ...d.stats };
        return true;
    }
    function save() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(exportData()));
        } catch (_) {}
    }
    // forget what was learned in this browser and go back to the shipped starting point (or nothing)
    function clear() {
        try {
            localStorage.removeItem(STORE_KEY);
        } catch (_) {}
        table.clear();
        mtable.clear();
        stats = { decisions: 0, byForm: Array(7).fill(0), episodes: 0 };
        if (typeof RL_PRETRAINED !== "undefined") importData(RL_PRETRAINED);
        reset();
    }
    function init() {
        let ok = false;
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw) ok = importData(JSON.parse(raw));
        } catch (_) {}
        if (!ok && typeof RL_PRETRAINED !== "undefined") importData(RL_PRETRAINED);
    }
    init();
    if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("pagehide", save);
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) save();
        });
    }

    // text for the HUD
    function hud() {
        const act = macro ? ACTIONS[macro.a].name : label;
        const tag = calm > 0 ? "（休憩）" : tired > 0 ? "（疲れ）" : "";
        return "AI: " + (act || "…") + tag + " / 動き:" + MOVES[moveMode] + " / 学習" + stats.decisions + "手 ε" + (form >= 0 ? eps() : 0).toFixed(2);
    }

    return {
        reset, update, moveBoss, onHit, save, clear, hud, exportData, importData,
        // for tools/train-rl.js
        setLearning(on, epsilon = null) { learnOn = on; epsFixed = epsilon; },
        _internals: { ACTIONS, MOVES, usage, get rewardSum() { return rewardSum; }, get stats() { return stats; }, get calm() { return calm; } },
    };
})();
