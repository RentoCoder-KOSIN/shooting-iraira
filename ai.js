/* ============================================================================
 *  ai.js - AIプレイ観戦(AIが自機を操作して、その様子を見るモード)
 *
 *  タイトル画面の「🤖 AIプレイ」(Pキー)から始めます。モードを選ぶと、あとはAIが遊びます。
 *    - 弾・レーザー・落ちてくる玉を先読みして避けます(ボスの弾は、ゲーム本体と同じ動きを数十フレーム先まで
 *      シミュレーションして、いちばん安全な動きを選びます)
 *    - 玉の選択画面では、いちばん得な玉(赤 > 紫 > 青 > 橙 > 緑)をとりにいきます
 *    - ギャグ画面は、ちゃんとボタンを押して進めます
 *    - ゲームオーバー / クリアのあとは、少し待ってから同じモードで自動的にやり直します
 *  ランキングには登録されません。RLモードは、ボスの学習データが汚れるので選べません。
 *
 *  操作: Esc で終了 / Space・Enter・タップで再生速度(×1 → ×2 → ×4)
 *
 *  このファイルは script.js より先に読み込みます(script.js の変数は、実行時に参照します)。
 * ========================================================================== */

let aiPlay = false; // true while the AI is playing
let aiSpeed = 1; // playback speed (see AI_SPEEDS)
const AI_SPEEDS = [1, 2, 4];
const aiMove = { dx: 0, dy: 0, slow: false }; // what the AI "presses" this frame (movePlayer() reads it)
const aiStats = { runs: 0, clears: 0, bestForm: 0, bestMs: 0 };

let aiPrevState = null;
let aiCounted = false; // the result of this run was already counted
let aiWait = 0; // frames until the next restart
let aiGagWait = 0; // frames until the next gag button press
let aiPrevAct = null; // the action chosen at the last planning (to avoid jitter)
let aiPlanAt = -99; // frame of the last planning

/* ---- start / stop (called from script.js) ---- */
function aiOpen() {
    aiPlay = true;
    aiSpeed = 1;
    aiPrevState = null;
    aiCounted = false;
    aiStats.runs = aiStats.clears = aiStats.bestForm = aiStats.bestMs = 0;
    modeIdx = 0;
    state = S.MODE; // choose the mode the AI plays
}
function aiExit() {
    aiPlay = false;
    aiSpeed = 1;
    resetGame(); // back to the title
}
function aiCycleSpeed() {
    aiSpeed = AI_SPEEDS[(AI_SPEEDS.indexOf(aiSpeed) + 1) % AI_SPEEDS.length];
}

/* ---- planner ----
 *  Every few frames: simulate the bullets / beams / orbs AI_T frames ahead (they hardly depend on what the
 *  player does), then search the player's moves (AI_DEPTH moves of AI_SEG frames each, 9 directions) and pick the
 *  first move of the cheapest sequence. Cost = hit (huge) + getting too close + bad places (edges, far from the boss). */
const AI_SEG = 8; // frames per move
const AI_DEPTH = 3; // moves looked ahead
const AI_T = AI_SEG * AI_DEPTH; // frames looked ahead
const AI_RANGE = 300; // only things this close to the player are simulated
const AI_MARGIN = 14; // wish to stay at least this far from a bullet edge
const AI_HIT = 1000; // cost of a hit
const AI_PLAN_EVERY = 2; // plan every N frames
const AI_ACTS_FIRST = []; // the first move may also be slow (Shift) for fine dodging
const AI_ACTS = [];
for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const a = { dx, dy, slow: false };
    AI_ACTS.push(a);
    AI_ACTS_FIRST.push(a);
    if (dx || dy) AI_ACTS_FIRST.push({ dx, dy, slow: true });
}

// Where bullets / beams will be in each of the next AI_T frames: { bul[t] = [x, y, r, ...], beam[t] = [[ax, ay, bx, by, halfWidth], ...] }
function aiPredict() {
    const px = player.x,
        py = player.y;
    const realBullets = bullets,
        realQueue = queue;
    let sim = [];
    for (const b of realBullets)
        if (Math.abs(b.x - px) < AI_RANGE && Math.abs(b.y - py) < AI_RANGE) sim.push({ ...b });
    const simBeams = beams.map((b) => ({ ...b }));
    const simOrbs = orbs.map((o) => ({ x: o.x, y: o.y }));
    const P = { bul: [], beam: [] };
    bullets = sim; // the paths (splitter) may add bullets through shoot() / later(): let them use scratch copies
    queue = [];
    try {
        for (let t = 0; t < AI_T; t++) {
            const next = [];
            const rec = [];
            for (const b of sim) {
                if (b.delay > 0) {
                    b.delay--; // still faint and harmless
                    next.push(b);
                    continue;
                }
                if (b.path === "wallPath") {
                    b.age++; // the wall rows speed up and stop as a group: be pessimistic and assume the fast drop
                    b.y += WALL_DASH_V;
                } else {
                    PATHS[b.path](b);
                    const f = paceFactor(b);
                    b.age++;
                    b.x += b.vx * f;
                    b.y += b.vy * f;
                }
                if (b.x > -20 && b.x < W + 20 && b.y > -20 && b.y < H + 20) {
                    next.push(b);
                    rec.push(b.x, b.y, b.r);
                }
            }
            sim = next;
            bullets = sim;
            for (let i = queue.length - 1; i >= 0; i--) {
                if (--queue[i].t <= 0) {
                    const q = queue.splice(i, 1)[0];
                    q.f(); // e.g. the 8 small bullets of a splitter
                }
            }
            for (const o of simOrbs) {
                o.y += ORB_FALL_SPEED;
                rec.push(o.x, o.y, ORB_PICK_R - PLAYER_HIT_R + 2); // an orb is something to avoid too
            }
            P.bul.push(rec);
            const segs = [];
            for (const b of simBeams) {
                b.age++;
                b.a += b.da;
                if (b.age > b.warn && b.age <= b.warn + b.dur) {
                    const path = beamPath(b);
                    for (let i = 0; i < path.length - 1; i++)
                        segs.push([path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], b.w / 2 + PLAYER_HIT_R]);
                }
            }
            P.beam.push(segs);
        }
    } finally {
        bullets = realBullets; // always give the real game its own state back
        queue = realQueue;
    }
    return P;
}

// The cost of standing at (x, y) in frame t (0-based). Sets aiHitNow when that would be a hit.
let aiHitNow = false;
function aiFrameCost(P, t, x, y, vuln) {
    let c = 0;
    aiHitNow = false;
    const w = vuln ? 1 : 0.3;
    const bl = P.bul[t];
    for (let i = 0; i < bl.length; i += 3) {
        const r = bl[i + 2] + PLAYER_HIT_R;
        const lim = r + AI_MARGIN;
        const dx = bl[i] - x;
        if (dx > lim || dx < -lim) continue;
        const dy = bl[i + 1] - y;
        if (dy > lim || dy < -lim) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 < r * r) aiHitNow = true;
        else if (d2 < lim * lim) {
            const k = (AI_MARGIN - (Math.sqrt(d2) - r)) / AI_MARGIN;
            c += k * k * 3 * w;
        }
    }
    for (const s of P.beam[t]) {
        const vx = s[2] - s[0],
            vy = s[3] - s[1];
        const len2 = vx * vx + vy * vy || 1;
        const u = Math.max(0, Math.min(1, ((x - s[0]) * vx + (y - s[1]) * vy) / len2));
        const d = Math.hypot(x - s[0] - vx * u, y - s[1] - vy * u);
        if (d < s[4]) aiHitNow = true;
        else if (d < s[4] + AI_MARGIN) {
            const k = (AI_MARGIN - (d - s[4])) / AI_MARGIN;
            c += k * k * 3 * w;
        }
    }
    return c;
}

// Where it is good to be when nothing is about to hit: not in a corner, low on the screen, under the boss
function aiLeafCost(x, y) {
    let c = 0;
    const ex = Math.min(x, W - x);
    if (ex < 50) c += (50 - ex) * (50 - ex) * 0.015;
    const ey = H - y;
    if (ey < 40) c += (40 - ey) * (40 - ey) * 0.015;
    if (y < 300) c += (300 - y) * (300 - y) * 0.01; // never go up toward the boss
    c += (y - (H - 110)) * (y - (H - 110)) * 0.0015;
    const off = Math.abs(x - boss.x) - 40;
    if (off > 0) c += off * 0.04; // stay under the boss so the shots hit it
    return c;
}

function aiNode(P, depth, x, y, cost, hit, acts, best) {
    if (depth === AI_DEPTH) {
        cost += aiLeafCost(x, y);
        if (cost < best.cost) {
            best.cost = cost;
            best.act = acts[0];
        }
        return;
    }
    const inv = player.inv;
    for (const a of depth === 0 ? AI_ACTS_FIRST : AI_ACTS) {
        const sp = a.slow ? PLAYER_SLOW_SPEED : PLAYER_SPEED;
        let cx = x,
            cy = y,
            c = cost + (depth === 0 && a !== aiPrevAct ? 0.6 : 0),
            h = hit;
        for (let k = 0; k < AI_SEG && c < best.cost; k++) {
            const t = depth * AI_SEG + k;
            cx = Math.max(8, Math.min(W - 8, cx + a.dx * sp));
            cy = Math.max(8, Math.min(H - 8, cy + a.dy * sp));
            c += aiFrameCost(P, t, cx, cy, !h && t + 1 >= inv);
            if (aiHitNow && !h && t + 1 >= inv) {
                h = true; // after a hit the player is invincible for the rest of the look-ahead
                c += AI_HIT * (1 + (AI_T - t) / AI_T);
            }
        }
        if (c >= best.cost) continue;
        acts[depth] = a;
        aiNode(P, depth + 1, cx, cy, c, h, acts, best);
    }
}

function aiPlanPlay() {
    if (frame - aiPlanAt >= AI_PLAN_EVERY || !aiPrevAct) {
        aiPlanAt = frame;
        const P = aiPredict();
        const best = { cost: Infinity, act: AI_ACTS[0] };
        aiNode(P, 0, player.x, player.y, 0, false, [], best);
        aiPrevAct = best.act;
    }
    aiMove.dx = aiPrevAct.dx;
    aiMove.dy = aiPrevAct.dy;
    aiMove.slow = aiPrevAct.slow;
}

/* ---- the orb selection screen: walk to the best orb without touching the others ---- */
const AI_ORB_RANK = ["heal", "fake", "gag", "invert", "double"]; // best first
function aiPlanSelect() {
    let target = 0,
        rank = 99;
    for (let i = 0; i < SELECT_ORBS.length; i++) {
        const r = AI_ORB_RANK.indexOf(selectEffect(i));
        if (r < rank) {
            rank = r;
            target = i;
        }
    }
    const tp = selectOrbPos(target);
    // a distance map from the target over an 8 px grid; the cells near the other orbs are walls
    const C = 8,
        cols = Math.ceil(W / C),
        rows = Math.ceil(H / C);
    const dist = new Int16Array(cols * rows).fill(-1);
    const others = [];
    for (let i = 0; i < SELECT_ORBS.length; i++) if (i !== target) others.push(selectOrbPos(i));
    const blocked = (cx, cy) =>
        others.some((o) => Math.hypot(o.x - (cx * C + C / 2), o.y - (cy * C + C / 2)) < SEL_PICK + 6);
    const t0 = Math.max(0, Math.min(cols - 1, (tp.x / C) | 0)) + Math.max(0, Math.min(rows - 1, (tp.y / C) | 0)) * cols;
    const q = [t0];
    dist[t0] = 0;
    for (let h = 0; h < q.length; h++) {
        const cx = q[h] % cols,
            cy = (q[h] / cols) | 0;
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx,
                    ny = cy + dy;
                if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                const id = nx + ny * cols;
                if (dist[id] >= 0 || blocked(nx, ny)) continue;
                dist[id] = dist[q[h]] + 1;
                q.push(id);
            }
    }
    let gx = tp.x,
        gy = tp.y;
    if (Math.hypot(tp.x - player.x, tp.y - player.y) > 14) {
        const pcx = Math.max(0, Math.min(cols - 1, (player.x / C) | 0)),
            pcy = Math.max(0, Math.min(rows - 1, (player.y / C) | 0));
        let bestD = Infinity;
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                const nx = pcx + dx,
                    ny = pcy + dy;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                const d = dist[nx + ny * cols];
                if (d >= 0 && d < bestD) {
                    bestD = d;
                    gx = nx * C + C / 2;
                    gy = ny * C + C / 2;
                }
            }
    }
    aiMove.dx = gx - player.x > 1.5 ? 1 : gx - player.x < -1.5 ? -1 : 0;
    aiMove.dy = gy - player.y > 1.5 ? 1 : gy - player.y < -1.5 ? -1 : 0;
    aiMove.slow = false;
}

/* ---- gag screen: press the buttons like a person would (a short pause each time) ---- */
function aiPlanGag() {
    if (aiPrevState !== S.GAG) aiGagWait = 45;
    if (gagLock > 0) return;
    if (aiGagWait > 0) {
        aiGagWait--;
        return;
    }
    pressGagAnswer(true);
    aiGagWait = 40;
}

/* ---- the end of a run: count it, wait a little, then play again ---- */
function aiPlanEnd() {
    if (!aiCounted) {
        aiCounted = true;
        aiWait = 180;
        aiStats.runs++;
        if (state === S.WIN) aiStats.clears++;
        if (lastRun) {
            aiStats.bestForm = Math.max(aiStats.bestForm, lastRun.form + (lastRun.cleared ? 1 : 0));
            if (lastRun.cleared && (!aiStats.bestMs || lastRun.totalMs < aiStats.bestMs)) aiStats.bestMs = lastRun.totalMs;
        }
    }
    if (--aiWait > 0) return;
    aiCounted = false;
    aiPrevAct = null;
    if (practice) startPractice();
    else {
        resetGame();
        chooseMode(modeIdx);
    }
}

// Called every frame from update() while the AI plays
function aiThink() {
    aiMove.dx = aiMove.dy = 0;
    aiMove.slow = false;
    if (state === S.PLAY) aiPlanPlay();
    else if (state === S.SELECT) aiPlanSelect();
    else if (state === S.GAG) aiPlanGag();
    else if (state === S.OVER || state === S.WIN) aiPlanEnd();
    aiPrevState = state;
}

/* ---- on-screen info (bottom of the playfield) ---- */
function aiDraw() {
    if (state === S.TITLE || state === S.MODE || state === S.PRACT) return;
    const best = aiStats.bestForm ? "　最高: 第" + FORM_NAMES[Math.min(aiStats.bestForm, FORM_NAMES.length) - 1] + "形態" : "";
    drawText(
        "🤖 AIプレイ中 ×" + aiSpeed + "　" + aiStats.runs + "回終了" + (aiStats.clears ? "（クリア" + aiStats.clears + "回）" : "") + best,
        CX,
        H - 30,
        12,
        "#8cf",
    );
    drawText("Esc: 終了　Space・タップ: 速度", CX, H - 12, 11, "#789");
}
