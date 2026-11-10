"use strict";
/* tools/ultra-oracle.js - 「予告を見て先に動く」検証ボット (tools/ultra-test.js が、ゲームと同じ vm の中で読み込む)
 *
 *  ai.js のAIは0.4秒しか先を読まず、予告線にも反応しない。人間は予告を見て、発射の前に動ける。
 *  そこで、今見えている弾・ビーム(予告中のものも含む)を ORACLE_HORIZON 先までゲームと同じ動きでシミュレーションし、
 *  「安全なマスだけをたどって最後まで生き残れる経路」があるかを調べて、その最初の一歩に動く。
 *    - 画面を ORACLE_CELL px のマスに分け、2フレームごとに隣(斜めも)のマスへ動ける  = 自機の速さは 3 px/フレーム
 *      (ゲームの 4 px/フレームより遅い。人間の操作の遅れ・ずれの余裕)
 *    - 弾・ビームから ORACLE_MARGIN px 余計に離れる
 *    - まだ現れていないもの(これから発射される技)は見えない = 人間と同じ
 *  このボットが避けられない技は、設計(隙間の広さ・予告の長さ)に問題がある。
 */
const ORACLE_CELL = 6;
const ORACLE_STEP = 2; // frames per cell move (-> 3 px / frame)
const ORACLE_STEPS = 40; // look-ahead: 80 frames
const ORACLE_MARGIN = 8;
const ORACLE_SOON = 30; // steps (60 frames): a cell that is in danger within this time is one to leave
const ORACLE_EVERY = 6; // plan every N frames
const ORACLE_LEAD = 8; // a beam's area counts as dangerous this many steps (x 2 frames) before it fires: a human does not stand on the line until the last moment

const oracle = { cols: Math.ceil(W / ORACLE_CELL), rows: Math.ceil(H / ORACLE_CELL), target: null, plans: 0, doomed: 0 };

function oracleMark(grid, x, y, rad) {
    const c = ORACLE_CELL;
    const x0 = Math.max(0, Math.floor((x - rad) / c)),
        x1 = Math.min(oracle.cols - 1, Math.floor((x + rad) / c));
    const y0 = Math.max(0, Math.floor((y - rad) / c)),
        y1 = Math.min(oracle.rows - 1, Math.floor((y + rad) / c));
    for (let gy = y0; gy <= y1; gy++)
        for (let gx = x0; gx <= x1; gx++) {
            const dx = gx * c + c / 2 - x,
                dy = gy * c + c / 2 - y;
            if (dx * dx + dy * dy <= rad * rad) grid[gy * oracle.cols + gx] = 1;
        }
}
function oracleMarkBeam(grid, b) {
    const rad = b.w / 2 + PLAYER_HIT_R + ORACLE_MARGIN;
    const path = beamPath(b);
    const c = ORACLE_CELL;
    for (let i = 0; i < path.length - 1; i++) {
        const [ax, ay] = path[i],
            [bx, by] = path[i + 1];
        const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - rad) / c)),
            x1 = Math.min(oracle.cols - 1, Math.floor((Math.max(ax, bx) + rad) / c));
        const y0 = Math.max(0, Math.floor((Math.min(ay, by) - rad) / c)),
            y1 = Math.min(oracle.rows - 1, Math.floor((Math.max(ay, by) + rad) / c));
        for (let gy = y0; gy <= y1; gy++)
            for (let gx = x0; gx <= x1; gx++)
                if (distToSegment(gx * c + c / 2, gy * c + c / 2, path[i], path[i + 1]) < rad) grid[gy * oracle.cols + gx] = 1;
    }
}

// where to go next (a point), or null = stay. Returns { x, y, doomed }
function oraclePlan() {
    const { cols, rows } = oracle;
    const keep = { bullets, beams, queue, hazards, frame, hurt: hurtPlayer, speedMulKeep: speedMul };
    bullets = JSON.parse(JSON.stringify(bullets));
    beams = JSON.parse(JSON.stringify(beams));
    queue = queue.map((q) => ({ ...q }));
    hazards = hazards.map((h) => ({ ...h }));
    hurtPlayer = () => {};
    const haz = [];
    const beamHaz = []; // the beam part of each step (spread to the earlier steps below)
    try {
        for (let k = 0; k < ORACLE_STEPS; k++) {
            const grid = new Uint8Array(cols * rows);
            const bgrid = new Uint8Array(cols * rows);
            for (let sub = 0; sub < ORACLE_STEP; sub++) {
                runQueue();
                updateBullets();
                updateBeams();
                updateHazards();
                frame++;
                for (const b of beams) if (b.age > b.warn && b.age <= b.warn + b.dur) oracleMarkBeam(bgrid, b);
                for (const b of bullets) if (!(b.delay > 0)) oracleMark(grid, b.x, b.y, b.r + PLAYER_HIT_R + ORACLE_MARGIN);
                for (const h of hazards) if (h.done) oracleMark(grid, h.x, h.y, h.r + ORACLE_MARGIN);
            }
            haz.push(grid);
            beamHaz.push(bgrid);
        }
    } finally {
        bullets = keep.bullets;
        beams = keep.beams;
        queue = keep.queue;
        hazards = keep.hazards;
        frame = keep.frame;
        hurtPlayer = keep.hurt;
    }
    for (let k = 0; k < ORACLE_STEPS; k++)
        for (let j = k; j <= Math.min(ORACLE_STEPS - 1, k + ORACLE_LEAD); j++) {
            const src = beamHaz[j],
                dst = haz[k];
            for (let i = 0; i < dst.length; i++) if (src[i]) dst[i] = 1;
        }
    // backward: alive[k][cell] = the cell is free at step k and some neighbour is alive at step k+1
    const n = cols * rows;
    let next = new Uint8Array(n);
    const alives = new Array(ORACLE_STEPS);
    for (let k = ORACLE_STEPS - 1; k >= 0; k--) {
        const cur = new Uint8Array(n);
        const h = haz[k];
        for (let gy = 0; gy < rows; gy++)
            for (let gx = 0; gx < cols; gx++) {
                const i = gy * cols + gx;
                if (h[i]) continue;
                if (k === ORACLE_STEPS - 1) {
                    cur[i] = 1;
                    continue;
                }
                let ok = 0;
                for (let dy = -1; dy <= 1 && !ok; dy++) {
                    const yy = gy + dy;
                    if (yy < 0 || yy >= rows) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = gx + dx;
                        if (xx < 0 || xx >= cols) continue;
                        if (next[yy * cols + xx]) {
                            ok = 1;
                            break;
                        }
                    }
                }
                cur[i] = ok;
            }
        alives[k] = cur;
        next = cur;
    }
    // "danger soon": cells that are in danger within the next ORACLE_SOON steps, and for every cell the distance (in cells)
    // to the nearest cell that is not. The bot walks towards such cells early instead of waiting for the last moment.
    const soon = new Uint8Array(n);
    for (let k = 0; k < Math.min(ORACLE_SOON, ORACLE_STEPS); k++) for (let i = 0; i < n; i++) if (haz[k][i]) soon[i] = 1;
    const away = new Int16Array(n).fill(-1);
    const bfs = [];
    for (let i = 0; i < n; i++)
        if (!soon[i]) {
            away[i] = 0;
            bfs.push(i);
        }
    for (let h = 0; h < bfs.length; h++) {
        const i = bfs[h],
            gx = i % cols,
            gy = (i / cols) | 0;
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                const xx = gx + dx,
                    yy = gy + dy;
                if (xx < 0 || yy < 0 || xx >= cols || yy >= rows || away[yy * cols + xx] >= 0) continue;
                away[yy * cols + xx] = away[i] + 1;
                bfs.push(yy * cols + xx);
            }
    }
    // the path: from the player's cell, each time to the neighbour that is alive at the next step (the nearest one)
    const px = uClamp(Math.floor(player.x / ORACLE_CELL), 0, cols - 1),
        py = uClamp(Math.floor(player.y / ORACLE_CELL), 0, rows - 1);
    const path = [];
    let gx0 = px,
        gy0 = py;
    for (let k = 0; k < ORACLE_EVERY / ORACLE_STEP; k++) {
        let best = null,
            bestCost = 1e9;
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                const gx = gx0 + dx,
                    gy = gy0 + dy;
                if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
                if (!alives[k][gy * cols + gx]) continue;
                // prefer staying, then small moves, and a little pull to the lower middle (so that it does not hug the walls)
                const cost = 0.4 * (Math.abs(dx) + Math.abs(dy)) + 3 * away[gy * cols + gx] + 0.02 * Math.hypot(gx * ORACLE_CELL - CX, gy * ORACLE_CELL - 480);
                if (cost < bestCost) {
                    bestCost = cost;
                    best = [gx, gy];
                }
            }
        if (!best) break;
        [gx0, gy0] = best;
        path.push({ x: gx0 * ORACLE_CELL + ORACLE_CELL / 2, y: gy0 * ORACLE_CELL + ORACLE_CELL / 2 });
    }
    let best = path.length ? path[0] : null;
    oracle.plans++;
    if (!best) {
        oracle.doomed++;
        // no safe path: go to the neighbour that is free for the longest time
        let bestK = -1;
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                const gx = px + dx,
                    gy = py + dy;
                if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
                let k = 0;
                while (k < ORACLE_STEPS && !haz[k][gy * cols + gx]) k++;
                if (k > bestK) {
                    bestK = k;
                    best = { x: gx * ORACLE_CELL + ORACLE_CELL / 2, y: gy * ORACLE_CELL + ORACLE_CELL / 2 };
                }
            }
    }
    return { path: path.length ? path : [best], doomed: path.length === 0 };
}

// one frame of the bot: plan now and then, and walk (max 3 px / frame) to the planned cell
function oracleMove(t) {
    if (t % ORACLE_EVERY === 0 || !oracle.target) {
        oracle.target = oraclePlan();
        oracle.planAt = t;
    }
    const path = oracle.target.path;
    const g = path[Math.min(path.length - 1, Math.floor((t - oracle.planAt) / ORACLE_STEP))];
    const dx = g.x - player.x,
        dy = g.y - player.y;
    const d = Math.hypot(dx, dy);
    const v = Math.min(d, ORACLE_CELL / ORACLE_STEP);
    if (d > 0.01) {
        player.x = uClamp(player.x + (dx / d) * v, 8, W - 8);
        player.y = uClamp(player.y + (dy / d) * v, 8, H - 8);
    }
}
