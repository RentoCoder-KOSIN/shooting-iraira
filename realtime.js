"use strict";
/* ============================================================================
 *  realtime.js - WebSocket hub: online count + live spectating.   (private: not served as a static file)
 *
 *  Client -> server                                  Server -> client
 *    { t: "snap", s }  a player's current screen      { t: "hello", id }          your connection id
 *    { t: "stop" }     the player's run ended         { t: "online", n }          people connected now
 *    { t: "list" }     who is playing?                { t: "list", players: [{ id, mode, form, hp }] }
 *    { t: "watch", id } / { t: "unwatch" }            { t: "snap", s }            screen of the watched player
 *                                                     { t: "end" }                the watched player stopped
 *
 *  The game runs in the browser, so every "snap" is untrusted: sanitizeSnap() rebuilds it from
 *  validated numbers / known colours only (spectators never receive raw client data).
 *  State is kept in memory => run ONE instance (Render free plan = 1 instance).
 * ========================================================================== */
const { WebSocketServer } = require("ws");

const MAX_CONNECTIONS = 500;
const MAX_PER_IP = 10;
const MAX_WATCHERS = 50; // per watched player
const MSG_LIMIT = 60; // messages per second per connection (a player sends ~20 snaps/s)
const STALE_MS = 10000; // a player without snaps for this long is not "playing" any more
const LIST_MAX = 20;
const MODE_IDS = ["hard", "normal", "rl"];

/* ---------- snapshot validation ---------- */
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const ORB_ID = /^[A-Za-z0-9_]{1,16}$/;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const int = (v, lo, hi) => (isNum(v) ? Math.round(clamp(v, lo, hi)) : null);

// a flat [x, y, x, y ...] list -> cleaned copy (null if invalid)
function points(a, maxNums) {
    if (!Array.isArray(a) || a.length % 2 || a.length > maxNums) return null;
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) {
        const v = int(a[i], -300, 3000);
        if (v === null) return null;
        out[i] = v;
    }
    return out;
}

function sanitizeSnap(s) {
    if (!s || typeof s !== "object") return null;
    const w = int(s.w, 200, 2000);
    const f = int(s.f, 0, 6);
    if (w === null || f === null || !MODE_IDS.includes(s.m)) return null;
    const p = Array.isArray(s.p) ? s.p : [];
    const b = Array.isArray(s.b) ? s.b : [];
    const player = [int(p[0], -300, 3000), int(p[1], -300, 3000), p[2] ? 1 : 0, int(p[3], 0, 999), int(p[4], 0, 2)];
    const boss = [int(b[0], -300, 3000), int(b[1], -300, 3000), int(b[2], 0, 1e7), int(b[3], 1, 1e7)];
    if (player.includes(null) || boss.includes(null)) return null;

    let total = 0;
    const g = [];
    for (const grp of Array.isArray(s.g) ? s.g.slice(0, 60) : []) {
        if (!Array.isArray(grp) || typeof grp[0] !== "string" || !COLOR.test(grp[0])) continue;
        const r = int(grp[1], 1, 60);
        const pts = points(grp[3], 3000 - total);
        if (r === null || !pts) continue;
        total += pts.length;
        g.push([grp[0], r, grp[2] ? 1 : 0, pts]);
    }
    const e = [];
    for (const bm of Array.isArray(s.e) ? s.e.slice(0, 40) : []) {
        if (!Array.isArray(bm)) continue;
        const bw = int(bm[0], 1, 200);
        const pts = points(bm[2], 40);
        if (bw === null || !pts) continue;
        e.push([bw, bm[1] ? 1 : 0, pts]);
    }
    const sh = points(s.sh === undefined ? [] : s.sh, 400) || [];
    const o = [];
    for (const orb of Array.isArray(s.o) ? s.o.slice(0, 20) : []) {
        if (!Array.isArray(orb) || typeof orb[2] !== "string" || !ORB_ID.test(orb[2])) continue;
        const x = int(orb[0], -300, 3000);
        const y = int(orb[1], -300, 3000);
        if (x !== null && y !== null) o.push([x, y, orb[2]]);
    }
    return { w, m: s.m, f, d: s.d ? 1 : 0, k: s.k ? 1 : 0, p: player, b: boss, g, e, sh, o };
}

/* ---------- hub ---------- */
function attach(server) {
    const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
    const wss = new WebSocketServer({
        server,
        path: "/ws",
        maxPayload: 32 * 1024,
        // only pages served by this server (or ALLOWED_ORIGINS) may open the socket
        verifyClient: ({ origin, req }) => {
            if (!origin) return true; // not a browser (curl, tests)
            try {
                const host = new URL(origin).host;
                return host === req.headers.host || allowed.includes(origin);
            } catch (_) {
                return false;
            }
        },
    });

    let nextId = 1;
    const clients = new Map(); // id -> { id, ws, ip, playing: {mode, form, hp, at} | null, watching: id | null, count, windowStart }
    const watchers = new Map(); // watched id -> Set of watcher ids
    const ipCount = new Map();

    const send = (c, obj) => {
        if (c.ws.readyState === 1) c.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
    };

    // online count: coalesce bursts of connect / disconnect into one broadcast per 500 ms
    let onlineTimer = null;
    const scheduleOnline = () => {
        if (onlineTimer) return;
        onlineTimer = setTimeout(() => {
            onlineTimer = null;
            const msg = JSON.stringify({ t: "online", n: clients.size });
            for (const c of clients.values()) send(c, msg);
        }, 500);
    };

    const stopWatching = (c) => {
        if (c.watching === null) return;
        const set = watchers.get(c.watching);
        if (set) {
            set.delete(c.id);
            if (!set.size) watchers.delete(c.watching);
        }
        c.watching = null;
    };
    const stopPlaying = (c) => {
        if (!c.playing) return;
        c.playing = null;
        const set = watchers.get(c.id);
        if (set) {
            for (const wid of set) {
                const w = clients.get(wid);
                if (w) {
                    w.watching = null;
                    send(w, { t: "end" });
                }
            }
            watchers.delete(c.id);
        }
    };
    const isPlaying = (c, now) => c.playing && now - c.playing.at < STALE_MS;

    function onMessage(c, raw) {
        let m;
        try {
            m = JSON.parse(raw);
        } catch (_) {
            return;
        }
        if (!m || typeof m !== "object") return;
        const now = Date.now();
        if (m.t === "snap") {
            const s = sanitizeSnap(m.s);
            if (!s) return;
            c.playing = { mode: s.m, form: s.f, hp: s.p[3], at: now };
            const set = watchers.get(c.id);
            if (set && set.size) {
                const msg = JSON.stringify({ t: "snap", s });
                for (const wid of set) {
                    const w = clients.get(wid);
                    if (w) send(w, msg);
                }
            }
        } else if (m.t === "stop") {
            stopPlaying(c);
        } else if (m.t === "list") {
            const players = [];
            for (const o of clients.values())
                if (o.id !== c.id && isPlaying(o, now))
                    players.push({ id: o.id, mode: o.playing.mode, form: o.playing.form, hp: o.playing.hp });
            send(c, { t: "list", players: players.slice(0, LIST_MAX) });
        } else if (m.t === "watch") {
            stopWatching(c);
            const target = Number.isInteger(m.id) ? clients.get(m.id) : null;
            const set = target ? watchers.get(target.id) : null;
            if (!target || target.id === c.id || !isPlaying(target, now) || (set && set.size >= MAX_WATCHERS))
                return send(c, { t: "end" });
            if (set) set.add(c.id);
            else watchers.set(target.id, new Set([c.id]));
            c.watching = target.id;
        } else if (m.t === "unwatch") {
            stopWatching(c);
        }
    }

    wss.on("connection", (ws, req) => {
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        if (clients.size >= MAX_CONNECTIONS || (ipCount.get(ip) || 0) >= MAX_PER_IP) return ws.close(1013);
        ipCount.set(ip, (ipCount.get(ip) || 0) + 1);

        const c = { id: nextId++, ws, ip, playing: null, watching: null, count: 0, windowStart: Date.now(), alive: true };
        clients.set(c.id, c);
        send(c, { t: "hello", id: c.id });
        scheduleOnline();

        ws.on("pong", () => (c.alive = true));
        ws.on("message", (data, isBinary) => {
            if (isBinary) return;
            const now = Date.now();
            if (now - c.windowStart >= 1000) {
                c.windowStart = now;
                c.count = 0;
            }
            if (++c.count > MSG_LIMIT) return ws.close(1008); // too many messages
            onMessage(c, data.toString());
        });
        ws.on("error", () => {});
        ws.on("close", () => {
            stopPlaying(c);
            stopWatching(c);
            clients.delete(c.id);
            const n = (ipCount.get(ip) || 1) - 1;
            if (n > 0) ipCount.set(ip, n);
            else ipCount.delete(ip);
            scheduleOnline();
        });
    });

    // heartbeat: keeps idle sockets alive through the proxy, drops dead ones, retires stale players
    setInterval(() => {
        const now = Date.now();
        for (const c of clients.values()) {
            if (!c.alive) {
                c.ws.terminate();
                continue;
            }
            c.alive = false;
            c.ws.ping();
            if (c.playing && now - c.playing.at >= STALE_MS) stopPlaying(c);
        }
    }, 25000).unref();

    return wss;
}

module.exports = { attach, sanitizeSnap };
