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
 *    POST /api/scores/reset -> { ok: true, scores: [] }   body: { password }
 *      admin only: deletes ALL records. The password is checked here on the server
 *      (env ADMIN_PASSWORD; falls back to the same default as config.js).
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
const Scoring = require("./scoring.js"); // the score formula (shared with the browser)
const MODE_IDS = Object.keys(Scoring.MODES); // "hard", "normal"
const MAX_MS = 6 * 60 * 60 * 1000; // no run is longer than 6 hours
const MIN_CLEAR_MS = { hard: 60 * 1000, normal: 30 * 1000 }; // a real CLEAR cannot be faster than this
const POST_LIMIT = { max: 6, windowMs: 60 * 1000 }; // per IP
const RESET_LIMIT = { max: 5, windowMs: 60 * 1000 }; // per IP (admin password guessing)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "mint"; // keep in sync with config.js unless the env var is set

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
    if (!Number.isInteger(hp) || hp < 0 || hp > Scoring.MAX_HP) return bad("bad hp");
    if (cleared ? hp < 1 : hp !== 0) return bad("bad hp");

    // splits: cumulative times at which each form was defeated (null = not defeated)
    if (!Array.isArray(b.splits) || b.splits.length !== n) return bad("bad splits");
    const defeated = cleared ? n : form - 1; // forms before the reached one are defeated
    let prev = 0;
    for (let i = 0; i < n; i++) {
        const v = b.splits[i];
        if (i < defeated) {
            if (!Number.isInteger(v) || v < prev || v > totalMs) return bad("bad splits");
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
    const score = Scoring.compute(mode, { cleared, form, formMs, splits, hp }).total;
    return { score: { mode, name, form, cleared, formMs, totalMs, splits, hp, score } };
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
    await pool.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS splits JSONB");
    // added later: one ranking per mode + score-based ranking. Old rows keep NULL mode (= hidden, not deleted)
    await pool.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS mode TEXT");
    await pool.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS hp INTEGER");
    await pool.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS score INTEGER");
    await pool.query("CREATE INDEX IF NOT EXISTS scores_mode_score ON scores (mode, score DESC)");
    const toRow = (r) => ({
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
                "SELECT mode, name, form, cleared, form_ms, total_ms, splits, hp, score FROM scores WHERE mode = $1 ORDER BY score DESC, id ASC LIMIT $2",
                [mode, n],
            );
            return r.rows.map(toRow);
        },
        async add(s) {
            // rank = number of records of the same mode that stay above this one (+1); earlier records win ties
            const r = await pool.query("SELECT COUNT(*)::int AS n FROM scores WHERE mode = $1 AND score >= $2::int", [s.mode, s.score]);
            await pool.query(
                "INSERT INTO scores (mode, name, form, cleared, form_ms, total_ms, splits, hp, score) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)",
                [s.mode, s.name, s.form, s.cleared, s.formMs, s.totalMs, JSON.stringify(s.splits), s.hp, s.score],
            );
            return r.rows[0].n + 1;
        },
        async clear() {
            await pool.query("TRUNCATE TABLE scores RESTART IDENTITY");
        },
    };
}

/* ---------- storage: JSON file (local testing) ---------- */
function createFileStore(file) {
    let rows = [];
    try {
        rows = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {}
    // records of one mode, best score first (the sort is stable: earlier records stay above on ties).
    // Old records have no mode and are ignored.
    const ofMode = (mode) => rows.filter((r) => r.mode === mode).sort((a, b) => b.score - a.score);
    return {
        kind: "json-file",
        async top(mode, n) {
            return ofMode(mode).slice(0, n);
        },
        async add(s) {
            const rank = rows.filter((r) => r.mode === s.mode && r.score >= s.score).length + 1;
            rows.push(s);
            fs.writeFileSync(file, JSON.stringify(rows));
            return rank;
        },
        async clear() {
            rows = [];
            fs.writeFileSync(file, "[]");
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
function createApp(store) {
    const app = express();
    app.set("trust proxy", 1); // behind Render's proxy: req.ip is the real client
    app.disable("x-powered-by");

    // Only the game files are public (not server.js / package.json / scores.json)
    const FILES = ["index.html", "style.css", "script.js", "config.js", "scoring.js", "rl.js", "rl-pretrained.js"];
    app.get("/", (req, res) =>
        res.sendFile(path.join(__dirname, "index.html")),
    );
    for (const f of FILES)
        app.get("/" + f, (req, res) => res.sendFile(path.join(__dirname, f)));
    app.get("/favicon.ico", (req, res) => res.status(204).end());

    app.get("/api/scores", async (req, res) => {
        try {
            const mode = MODE_IDS.includes(req.query.mode) ? req.query.mode : "hard";
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
                res.json({ rank, score: parsed.score.score, scores: await store.top(parsed.score.mode, TOP_N) });
            } catch (err) {
                console.error(err);
                res.status(500).json({ error: "server error" });
            }
        },
    );

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
                console.warn("[scores] all records were reset by admin (" + req.ip + ")");
                res.set("Cache-Control", "no-store");
                res.json({ ok: true, scores: [] });
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
        : createFileStore(path.join(__dirname, "scores.json"));
    if (!url)
        console.warn(
            "[scores] DATABASE_URL is not set: using scores.json (the data is lost when Render restarts)",
        );
    createApp(store).listen(PORT, () =>
        console.log("listening on " + PORT + " (storage: " + store.kind + ")"),
    );
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
module.exports = { parseScore, createApp, createFileStore, createPgStore };
