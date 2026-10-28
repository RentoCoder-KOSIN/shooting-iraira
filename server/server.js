"use strict";
/* ============================================================================
 *  server.js - serves the game and keeps the shared ranking.
 *
 *    GET  /api/scores?mode=hard|normal -> { scores: [top 10 of that mode] }   (default: hard)
 *    POST /api/scores  -> { rank, score, scores }
 *         body: { mode, name, form, cleared, formMs, totalMs, splits, hp }
 *      mode   = "hard" (理不尽, 7 forms) or "normal" (通常, 4 forms): each mode has its own ranking
 *      splits = one entry per form: the run time (ms) at which each form was defeated,
 *               null for a form that was not defeated (shown as NA)
 *      hp     = HP left when the run ended (only a CLEAR keeps HP, otherwise 0)
 *      The SCORE is computed here with scoring.js (the client value is never trusted).
 *
 *    WS   /ws -> online count + live spectating (see realtime.js)
 *
 *    GET  /api/rl  /  POST /api/rl  /  POST /api/rl/reset -> the boss AI that all players teach together
 *      (RLモード; see rlmodel.js). The model is kept in the same database (table kv) or in rl-model.json.
 *
 *    POST /api/scores/reset -> { ok: true, scores: [] }   body: { password }
 *      admin only: deletes ALL records. The password is checked here on the server
 *      (env ADMIN_PASSWORD; falls back to the same default as config.js).
 *    POST /api/scores/delete -> { ok: true, deleted, scores: [top 10 of that mode] }   body: { password, mode, id }
 *      admin only: deletes ONE record (the `id` of a row of GET /api/scores). Same password check as reset.
 *
 *  Storage:
 *    DATABASE_URL set   -> PostgreSQL (use this on Render; the data survives restarts)
 *    DATABASE_URL unset -> scores.json next to this file (handy for local testing only:
 *                          Render's free web services lose local files on every restart)
 *
 *  Ranking (per mode): the highest SCORE first (see scoring.js). Ties: the earlier record stays above.
 *  Records from before the modes were separated have no mode: they stay in the database but are not shown.
 *
 *  NOTE: the game runs in the player's browser, so a determined cheater can send fake
 *  scores. The checks below only stop obviously impossible values and spam.
 * ========================================================================== */
const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TOP_N = 10;
const NAME_MAX = 12;
const Scoring = require("../public/scoring.js"); // the score formula (shared with the browser)
const { createRlModel } = require("./rlmodel.js"); // the boss AI everybody teaches
const MODE_IDS = Object.keys(Scoring.MODES); // "hard", "normal"
const MAX_MS = 6 * 60 * 60 * 1000; // no run is longer than 6 hours
const MIN_CLEAR_MS = { hard: 60 * 1000, normal: 30 * 1000 }; // a real CLEAR cannot be faster than this
const POST_LIMIT = { max: 6, windowMs: 60 * 1000 }; // per IP
const RESET_LIMIT = { max: 5, windowMs: 60 * 1000 }; // per IP (admin password guessing)
const RL_LIMIT = { max: 12, windowMs: 60 * 1000 }; // per IP: uploads of what the boss learned
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "mint"; // keep in sync with config.js unless the env var is set

/* ---------- 不適切ワードフィルター ---------- */
// 日本語・英語の不適切表現（読み替え・変形もある程度カバー）
const BAD_WORDS = [
    // 日本語 (ひらがな/カタカナ/漢字)
    "うんこ", "うんち", "ちんこ", "ちんぽ", "まんこ", "おっぱい", "せっくす", "えっち",
    "ちくび", "きんたま", "おちんちん", "むけちん", "しこ", "おなに", "ふぇら",
    "くそ", "ばか", "あほ", "しね", "死ね", "殺す", "ころす", "きもい", "きもち悪い",
    "クソ", "バカ", "アホ", "キモい", "ウンコ", "ウンチ", "チンコ", "チンポ", "マンコ",
    "オッパイ", "セックス", "エッチ", "チクビ", "キンタマ", "オチンチン", "オナニ", "フェラ",
    "ちんちん", "まんちん", "おまんこ", "おちんちん", "ちんぽこ",
    // 英語
    "fuck", "shit", "ass", "bitch", "bastard", "damn", "cunt", "dick", "cock",
    "pussy", "nigger", "nigga", "faggot", "retard", "whore", "slut",
    "penis", "vagina", "anus", "boob", "tit", "porn", "sex", "nude",
    "kill", "die", "rape", "racist",
];

// 正規化して比較（全角→半角、大文字→小文字、スペース・記号除去）
function normalizeForFilter(str) {
    return str
        .toLowerCase()
        .replace(/[\s\-_・]/g, "")
        // 全角英数→半角
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) - 0xfee0),
        )
        // ひらがな→カタカナ統一（カタカナへ）
        .replace(/[ぁ-ん]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) + 0x60),
        );
}

function containsBadWord(name) {
    const normalized = normalizeForFilter(name);
    return BAD_WORDS.some((w) => normalized.includes(normalizeForFilter(w)));
}

/* ---------- validation ---------- */
function parseScore(body) {
    const b = body && typeof body === "object" ? body : {};
    const { mode, form, cleared, formMs, totalMs, hp } = b;
    const bad = (error) => ({ error });
    if (!MODE_IDS.includes(mode)) return bad("bad mode");
    const n = Scoring.MODES[mode].forms; // number of forms of this mode
    if (!Number.isInteger(form) || form < 1 || form > n) return bad("bad form");
    if (typeof cleared !== "boolean") return bad("bad cleared");
    if (!Number.isInteger(formMs) || !Number.isInteger(totalMs))
        return bad("bad time");
    if (formMs < 0 || totalMs < 500 || totalMs > MAX_MS || formMs > totalMs)
        return bad("bad time");
    if (cleared && (form !== n || totalMs < MIN_CLEAR_MS[mode]))
        return bad("bad clear");
    // HP left: a CLEAR keeps at least 1 HP, every other run ended with 0
    if (!Number.isInteger(hp) || hp < 0 || hp > Scoring.MAX_HP)
        return bad("bad hp");
    if (cleared ? hp < 1 : hp !== 0) return bad("bad hp");

    // splits: cumulative times at which each form was defeated (null = not defeated)
    if (!Array.isArray(b.splits) || b.splits.length !== n)
        return bad("bad splits");
    const defeated = cleared ? n : form - 1; // forms before the reached one are defeated
    let prev = 0;
    for (let i = 0; i < n; i++) {
        const v = b.splits[i];
        if (i < defeated) {
            if (!Number.isInteger(v) || v < prev || v > totalMs)
                return bad("bad splits");
            prev = v;
        } else if (v !== null) return bad("bad splits");
    }
    const splits = b.splits;

    let name = typeof b.name === "string" ? b.name : "";
    name = name
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    name = [...name].slice(0, NAME_MAX).join("");
    if (!name) name = "名無し";
    if (containsBadWord(name)) return bad("inappropriate name");
    const score = Scoring.compute(mode, {
        cleared,
        form,
        formMs,
        splits,
        hp,
    }).total;
    return {
        score: {
            mode,
            name,
            form,
            cleared,
            formMs,
            totalMs,
            splits,
            hp,
            score,
        },
    };
}

/* ---------- storage: PostgreSQL ---------- */
async function createPgStore(url) {
    const { Pool } = require("pg");
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const ssl =
        local || process.env.PGSSL === "off"
            ? false
            : { rejectUnauthorized: false };
    const pool = new Pool({
        connectionString: url,
        ssl,
        max: 5,
        connectionTimeoutMillis: 20000,
        idleTimeoutMillis: 10000,
    });
    pool.on("error", (err) =>
        console.warn("[scores] idle db connection dropped:", err.message),
    );
    await pool.query(`
        CREATE TABLE IF NOT EXISTS scores (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL,
            form       INTEGER NOT NULL,
            cleared    BOOLEAN NOT NULL,
            form_ms    INTEGER NOT NULL,
            total_ms   INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    // added later: the time each form was defeated (old rows keep NULL)
    await pool.query(
        "ALTER TABLE scores ADD COLUMN IF NOT EXISTS splits JSONB",
    );
    // added later: one ranking per mode + score-based ranking. Old rows keep NULL mode (= hidden, not deleted)
    await pool.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS mode TEXT");
    await pool.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS hp INTEGER");
    await pool.query(
        "ALTER TABLE scores ADD COLUMN IF NOT EXISTS score INTEGER",
    );
    await pool.query(
        "CREATE INDEX IF NOT EXISTS scores_mode_score ON scores (mode, score DESC)",
    );
    // small key/value table (the shared boss AI of the RLモード lives here)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS kv (
            k          TEXT PRIMARY KEY,
            v          JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    const toRow = (r) => ({
        id: r.id,
        mode: r.mode,
        name: r.name,
        form: r.form,
        cleared: r.cleared,
        formMs: r.form_ms,
        totalMs: r.total_ms,
        splits: r.splits || null,
        hp: r.hp,
        score: r.score,
    });
    return {
        kind: "postgres",
        async top(mode, n) {
            const r = await pool.query(
                "SELECT id, mode, name, form, cleared, form_ms, total_ms, splits, hp, score FROM scores WHERE mode = $1 ORDER BY score DESC, id ASC LIMIT $2",
                [mode, n],
            );
            return r.rows.map(toRow);
        },
        async add(s) {
            // rank = number of records of the same mode that stay above this one (+1); earlier records win ties
            const r = await pool.query(
                "SELECT COUNT(*)::int AS n FROM scores WHERE mode = $1 AND score >= $2::int",
                [s.mode, s.score],
            );
            await pool.query(
                "INSERT INTO scores (mode, name, form, cleared, form_ms, total_ms, splits, hp, score) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)",
                [
                    s.mode,
                    s.name,
                    s.form,
                    s.cleared,
                    s.formMs,
                    s.totalMs,
                    JSON.stringify(s.splits),
                    s.hp,
                    s.score,
                ],
            );
            return r.rows[0].n + 1;
        },
        async clear() {
            await pool.query("TRUNCATE TABLE scores RESTART IDENTITY");
        },
        // delete one record of that mode; true when a record was deleted
        async remove(mode, id) {
            const r = await pool.query(
                "DELETE FROM scores WHERE mode = $1 AND id = $2",
                [mode, id],
            );
            return r.rowCount > 0;
        },
        async getKV(k) {
            const r = await pool.query("SELECT v FROM kv WHERE k = $1", [k]);
            return r.rows[0] ? r.rows[0].v : null;
        },
        async setKV(k, v) {
            await pool.query(
                "INSERT INTO kv (k, v, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()",
                [k, JSON.stringify(v)],
            );
        },
    };
}

/* ---------- storage: JSON file (local testing) ---------- */
function createFileStore(file, kvFile) {
    let rows = [];
    try {
        rows = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {}
    // every record needs an id so that the admin can delete one (old records get one here)
    let nextId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
    for (const r of rows) if (!Number.isInteger(r.id)) r.id = nextId++;
    // records of one mode, best score first (the sort is stable: earlier records stay above on ties).
    // Old records have no mode and are ignored.
    const ofMode = (mode) =>
        rows.filter((r) => r.mode === mode).sort((a, b) => b.score - a.score);
    return {
        kind: "json-file",
        async top(mode, n) {
            return ofMode(mode).slice(0, n);
        },
        async add(s) {
            const rank =
                rows.filter((r) => r.mode === s.mode && r.score >= s.score)
                    .length + 1;
            rows.push({ ...s, id: nextId++ });
            fs.writeFileSync(file, JSON.stringify(rows));
            return rank;
        },
        async clear() {
            rows = [];
            fs.writeFileSync(file, "[]");
        },
        async remove(mode, id) {
            const before = rows.length;
            rows = rows.filter((r) => !(r.mode === mode && r.id === id));
            if (rows.length === before) return false;
            fs.writeFileSync(file, JSON.stringify(rows));
            return true;
        },
        async getKV(k) {
            try {
                return JSON.parse(fs.readFileSync(kvFile, "utf8"))[k] ?? null;
            } catch (_) {
                return null;
            }
        },
        async setKV(k, v) {
            let all = {};
            try {
                all = JSON.parse(fs.readFileSync(kvFile, "utf8"));
            } catch (_) {}
            all[k] = v;
            fs.writeFileSync(kvFile, JSON.stringify(all));
        },
    };
}

/* ---------- simple per-IP rate limit for POST ---------- */
const hits = new Map(); // key -> [timestamps]
function rateLimited(ip, limit = POST_LIMIT, bucket = "post") {
    const key = bucket + ":" + ip;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < limit.windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length > limit.max;
}
setInterval(
    () => {
        const now = Date.now();
        for (const [ip, list] of hits)
            if (!list.some((t) => now - t < POST_LIMIT.windowMs))
                hits.delete(ip);
    },
    5 * 60 * 1000,
).unref();

/* ---------- constant-time string compare ---------- */
function safeEqual(a, b) {
    const crypto = require("crypto");
    const ha = crypto.createHash("sha256").update(a).digest();
    const hb = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/* ---------- app ---------- */
function createApp(store, rl) {
    const app = express();
    app.set("trust proxy", 1); // behind Render's proxy: req.ip is the real client
    app.disable("x-powered-by");

    // Only the game files in public/ are served (not server/ / package.json / data/)
    const PUBLIC_DIR = path.join(__dirname, "..", "public");
    const SITE_DIR = path.join(__dirname, "..", "site");
    const FILES = [
        "script.js",
        "config.js",
        "scoring.js",
        "rl.js",
        "rl-pretrained.js",
        "net.js",
        "audio.js",
        "ai.js",
    ];
    app.get("/", (req, res) => res.sendFile(path.join(SITE_DIR, "index.html"))); // 紹介ページ
    app.use((req, res, next) =>
        req.path === "/play/" ? res.redirect(301, "/play") : next(),
    ); // 末尾スラッシュだと相対パスが壊れるため
    app.get("/play", (req, res) =>
        res.sendFile(path.join(PUBLIC_DIR, "index.html")),
    ); // ゲーム本体

    // /beta: 実験用ルート。public/beta/ にあるファイルを優先し、なければ public/ にフォールバック
    const BETA_DIR = path.join(PUBLIC_DIR, "beta");
    app.use((req, res, next) =>
        req.path === "/beta/" ? res.redirect(301, "/beta") : next(),
    );
    app.get("/beta", (req, res) =>
        res.sendFile(path.join(BETA_DIR, "index.html")),
    ); // betaゲーム本体
    // /beta/〇〇.js , /beta/style.css: beta/ にあればそちら、なければ public/ にフォールバック
    for (const f of [...FILES, "style.css"]) {
        app.get("/beta/" + f, (req, res) => {
            const betaFile = path.join(BETA_DIR, f);
            if (fs.existsSync(betaFile)) {
                res.sendFile(betaFile);
            } else {
                res.sendFile(path.join(PUBLIC_DIR, f));
            }
        });
    }

    app.use(
        "/site",
        express.static(SITE_DIR, { fallthrough: true, index: false }),
    ); // 紹介ページの css / js
    for (const f of [...FILES, "style.css"])
        app.get("/" + f, (req, res) => res.sendFile(path.join(PUBLIC_DIR, f)));
    app.get("/favicon.ico", (req, res) => res.status(204).end());
    // BGM / sound effects (audio/bgm/*.mp3, audio/se/*.mp3). Missing files simply answer 404 and the game stays silent
    app.use(
        "/audio",
        express.static(path.join(PUBLIC_DIR, "audio"), {
            fallthrough: true,
            index: false,
        }),
    );

    app.get("/api/scores", async (req, res) => {
        try {
            const mode = MODE_IDS.includes(req.query.mode)
                ? req.query.mode
                : "hard";
            res.set("Cache-Control", "no-store");
            res.json({ scores: await store.top(mode, TOP_N) });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: "server error" });
        }
    });

    app.post(
        "/api/scores",
        express.json({ limit: "2kb" }),
        async (req, res) => {
            if (rateLimited(req.ip))
                return res
                    .status(429)
                    .json({ error: "送信が多すぎます。少し待ってください" });
            const parsed = parseScore(req.body);
            if (parsed.error)
                return res.status(400).json({ error: parsed.error });
            try {
                const rank = await store.add(parsed.score);
                res.set("Cache-Control", "no-store");
                res.json({
                    rank,
                    score: parsed.score.score,
                    scores: await store.top(parsed.score.mode, TOP_N),
                });
            } catch (err) {
                console.error(err);
                res.status(500).json({ error: "server error" });
            }
        },
    );

    // the shared boss AI (RLモード): download it / teach it / admin reset
    if (rl) {
        app.get("/api/rl", (req, res) => {
            if (!rl.ready())
                return res
                    .status(404)
                    .json({ error: "shared learning is off" });
            const { json, etag } = rl.snapshot();
            res.set({ "Cache-Control": "no-cache", ETag: etag });
            if (req.get("If-None-Match") === etag) return res.status(304).end();
            res.type("application/json").send(json);
        });
        app.post("/api/rl", express.json({ limit: "96kb" }), (req, res) => {
            if (rateLimited(req.ip, RL_LIMIT, "rl"))
                return res.status(429).json({ error: "too many uploads" });
            const r = rl.merge(req.body);
            if (!r.ok) return res.status(r.status).json({ error: r.error });
            res.set("Cache-Control", "no-store");
            res.json({ ok: true });
        });
        app.post(
            "/api/rl/reset",
            express.json({ limit: "1kb" }),
            (req, res) => {
                if (rateLimited(req.ip, RESET_LIMIT, "reset"))
                    return res
                        .status(429)
                        .json({
                            error: "試行が多すぎます。少し待ってください",
                        });
                const given = req.body && req.body.password;
                if (
                    typeof given !== "string" ||
                    !safeEqual(given, ADMIN_PASSWORD)
                )
                    return res
                        .status(403)
                        .json({ error: "パスワードが違います" });
                if (!rl.reset())
                    return res
                        .status(404)
                        .json({ error: "shared learning is off" });
                console.warn(
                    "[rl] the shared boss was reset by admin (" + req.ip + ")",
                );
                res.set("Cache-Control", "no-store");
                res.json({ ok: true });
            },
        );
    }

    // admin: delete every record
    app.post(
        "/api/scores/reset",
        express.json({ limit: "1kb" }),
        async (req, res) => {
            if (rateLimited(req.ip, RESET_LIMIT, "reset"))
                return res
                    .status(429)
                    .json({ error: "試行が多すぎます。少し待ってください" });
            const given = req.body && req.body.password;
            if (typeof given !== "string" || !safeEqual(given, ADMIN_PASSWORD))
                return res.status(403).json({ error: "パスワードが違います" });
            try {
                await store.clear();
                console.warn(
                    "[scores] all records were reset by admin (" + req.ip + ")",
                );
                res.set("Cache-Control", "no-store");
                res.json({ ok: true, scores: [] });
            } catch (err) {
                console.error(err);
                res.status(500).json({ error: "server error" });
            }
        },
    );

    // admin: delete ONE record (the password is checked here, like for reset)
    app.post(
        "/api/scores/delete",
        express.json({ limit: "1kb" }),
        async (req, res) => {
            if (rateLimited(req.ip, RESET_LIMIT, "reset"))
                return res
                    .status(429)
                    .json({ error: "試行が多すぎます。少し待ってください" });
            const { password, mode, id } = req.body || {};
            if (typeof password !== "string" || !safeEqual(password, ADMIN_PASSWORD))
                return res.status(403).json({ error: "パスワードが違います" });
            if (!MODE_IDS.includes(mode) || !Number.isInteger(id) || id < 1)
                return res.status(400).json({ error: "bad request" });
            try {
                const deleted = await store.remove(mode, id);
                console.warn(
                    "[scores] record " + mode + "#" + id +
                        (deleted ? " was deleted" : " was not found") +
                        " by admin (" + req.ip + ")",
                );
                res.set("Cache-Control", "no-store");
                res.json({ ok: true, deleted, scores: await store.top(mode, TOP_N) });
            } catch (err) {
                console.error(err);
                res.status(500).json({ error: "server error" });
            }
        },
    );

    // bad JSON etc.
    app.use((err, req, res, next) => {
        if (err && err.type === "entity.parse.failed")
            return res.status(400).json({ error: "bad json" });
        if (err && err.type === "entity.too.large")
            return res.status(413).json({ error: "too large" });
        console.error(err);
        res.status(500).json({ error: "server error" });
    });
    return app;
}

async function main() {
    const url = process.env.DATABASE_URL;
    const store = url
        ? await createPgStore(url)
        : createFileStore(
              path.join(__dirname, "..", "data", "scores.json"),
              path.join(__dirname, "..", "data", "rl-model.json"),
          );
    if (!url)
        console.warn(
            "[scores] DATABASE_URL is not set: using scores.json (the data is lost when Render restarts)",
        );
    const rl = createRlModel(store);
    await rl.init();
    const server = createApp(store, rl).listen(PORT, () =>
        console.log("listening on " + PORT + " (storage: " + store.kind + ")"),
    );
    // Render stops the old instance with SIGTERM on every deploy: save the shared boss first
    process.on("SIGTERM", () => {
        rl.flush()
            .catch((err) => console.warn("[rl] save failed:", err.message))
            .finally(() => process.exit(0));
    });
    require("./realtime.js").attach(server); // WebSocket: online count + spectating
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
module.exports = {
    parseScore,
    createApp,
    createFileStore,
    createPgStore,
    createRlModel,
};
