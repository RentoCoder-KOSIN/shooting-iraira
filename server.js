"use strict";
/* ============================================================================
 *  server.js - serves the game and keeps the shared ranking.
 *
 *    GET  /api/scores  -> { scores: [top 10] }
 *    POST /api/scores  -> { rank, scores }   body: { name, form, cleared, formMs, totalMs }
 *
 *  Storage:
 *    DATABASE_URL set   -> PostgreSQL (use this on Render; the data survives restarts)
 *    DATABASE_URL unset -> scores.json next to this file (handy for local testing only:
 *                          Render's free web services lose local files on every restart)
 *
 *  Ranking: CLEAR runs first (shortest time first), then the highest form reached,
 *  then the longest time inside that form. Ties: the earlier record stays above.
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
const MAX_MS = 6 * 60 * 60 * 1000; // no run is longer than 6 hours
const MIN_CLEAR_MS = 45 * 1000; // a real CLEAR cannot be faster than this
const POST_LIMIT = { max: 6, windowMs: 60 * 1000 }; // per IP

/* ---------- validation ---------- */
function parseScore(body) {
    const b = body && typeof body === "object" ? body : {};
    const { form, cleared, formMs, totalMs } = b;
    const bad = (error) => ({ error });
    if (!Number.isInteger(form) || form < 1 || form > 4) return bad("bad form");
    if (typeof cleared !== "boolean") return bad("bad cleared");
    if (!Number.isInteger(formMs) || !Number.isInteger(totalMs))
        return bad("bad time");
    if (formMs < 0 || totalMs < 500 || totalMs > MAX_MS || formMs > totalMs)
        return bad("bad time");
    if (cleared && (form !== 4 || totalMs < MIN_CLEAR_MS))
        return bad("bad clear");

    let name = typeof b.name === "string" ? b.name : "";
    name = name
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    name = [...name].slice(0, NAME_MAX).join("");
    if (!name) name = "名無し";
    return { score: { name, form, cleared, formMs, totalMs } };
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
    const ORDER =
        "cleared DESC, CASE WHEN cleared THEN total_ms END ASC, form DESC, form_ms DESC, id ASC";
    const toRow = (r) => ({
        name: r.name,
        form: r.form,
        cleared: r.cleared,
        formMs: r.form_ms,
        totalMs: r.total_ms,
    });
    return {
        kind: "postgres",
        async top(n) {
            const r = await pool.query(
                `SELECT name, form, cleared, form_ms, total_ms FROM scores ORDER BY ${ORDER} LIMIT $1`,
                [n],
            );
            return r.rows.map(toRow);
        },
        async add(s) {
            // rank = number of records that stay above this one (+1); earlier records win ties
            const r = await pool.query(
                `SELECT COUNT(*)::int AS n FROM scores
                 WHERE ($1::boolean AND cleared AND total_ms <= $2::int)
                    OR (NOT $1::boolean AND (cleared OR form > $3::int OR (form = $3::int AND form_ms >= $4::int)))`,
                [s.cleared, s.totalMs, s.form, s.formMs],
            );
            await pool.query(
                "INSERT INTO scores (name, form, cleared, form_ms, total_ms) VALUES ($1, $2, $3, $4, $5)",
                [s.name, s.form, s.cleared, s.formMs, s.totalMs],
            );
            return r.rows[0].n + 1;
        },
    };
}

/* ---------- storage: JSON file (local testing) ---------- */
function createFileStore(file) {
    let rows = [];
    try {
        rows = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {}
    // does record r stay above (or tie with) record s?
    const above = (r, s) =>
        r.cleared
            ? !s.cleared || r.totalMs <= s.totalMs
            : !s.cleared &&
              (r.form > s.form || (r.form === s.form && r.formMs >= s.formMs));
    const compare = (a, b) => {
        if (a.cleared !== b.cleared) return a.cleared ? -1 : 1;
        if (a.cleared) return a.totalMs - b.totalMs;
        return b.form - a.form || b.formMs - a.formMs;
    };
    return {
        kind: "json-file",
        async top(n) {
            return [...rows].sort(compare).slice(0, n);
        },
        async add(s) {
            const rank = rows.filter((r) => above(r, s)).length + 1;
            rows.push(s);
            fs.writeFileSync(file, JSON.stringify(rows));
            return rank;
        },
    };
}

/* ---------- simple per-IP rate limit for POST ---------- */
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(
        (t) => now - t < POST_LIMIT.windowMs,
    );
    list.push(now);
    hits.set(ip, list);
    return list.length > POST_LIMIT.max;
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

/* ---------- app ---------- */
function createApp(store) {
    const app = express();
    app.set("trust proxy", 1); // behind Render's proxy: req.ip is the real client
    app.disable("x-powered-by");

    // Only the game files are public (not server.js / package.json / scores.json)
    const FILES = ["index.html", "style.css", "script.js", "config.js"];
    app.get("/", (req, res) =>
        res.sendFile(path.join(__dirname, "index.html")),
    );
    for (const f of FILES)
        app.get("/" + f, (req, res) => res.sendFile(path.join(__dirname, f)));
    app.get("/favicon.ico", (req, res) => res.status(204).end());

    app.get("/api/scores", async (req, res) => {
        try {
            res.set("Cache-Control", "no-store");
            res.json({ scores: await store.top(TOP_N) });
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
                res.json({ rank, scores: await store.top(TOP_N) });
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
