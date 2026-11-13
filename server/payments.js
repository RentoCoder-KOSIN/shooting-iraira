"use strict";
/* ============================================================================
 *  server/payments.js - アカウント + ショップ + Stripe Checkout (買い切りアイテム。今は「超理不尽モード」だけ)
 *
 *    POST /api/auth/register | /api/auth/login | /api/auth/logout      GET /api/auth/me
 *    GET  /api/items            販売中の商品（ログインしていれば所持済みかも）
 *    GET  /api/items/mine       所持アイテム
 *    POST /api/payments/checkout  { itemId } -> { url }  Stripe の決済画面のURL（サーバーで金額を決める）
 *    POST /api/stripe/webhook     Stripe からの通知。ここで署名を検証して、初めてアイテムを付与する
 *    POST /api/admin/grant | /api/admin/item   管理者用（ADMIN_PASSWORD を環境変数に設定したときだけ使える）
 *
 *  方針（課金.md の「技術・セキュリティ方針」）
 *    - 決済・金額・商品はサーバーが決める。ブラウザの「成功しました」は信用しない（付与は検証済みWebhookだけ）
 *    - Webhook は署名を検証し、同じイベントを二度処理しない（stripe_events）。付与はDBトランザクション
 *    - 購入履歴は消さない（返金は status を変えるだけ）
 *    - 設定が足りない / DBの初期化に失敗した場合は、課金機能だけを止める。ゲーム本体は止めない（= 買った人にも遊ばせられないが、
 *      壊れた状態で課金を受け付けるより安全）
 *    - 新しい依存は入れない（Stripe は REST API を fetch で呼ぶ。署名検証は crypto）
 *
 *  環境変数
 *    STRIPE_SECRET_KEY      sk_test_... / sk_live_...   （無いと課金は無効）
 *    STRIPE_WEBHOOK_SECRET  whsec_...                  （無いと課金は無効）
 *    PUBLIC_BASE_URL        https://（公開URL）          （決済後の戻り先。無いと課金は無効）
 *    DATABASE_URL           PostgreSQL                  （課金を有効にするには必須。メモリ保存では本番の課金は受けない）
 *    ULTRA_PRICE_JPY        超理不尽モードの価格（商品テーブルを最初に作るときだけ使う。既定 500）
 *    ADMIN_PASSWORD         管理者用（無いと /api/admin/* は使えない。ランキングの既定パスワードは使わない）
 *    ULTRA_FREE_FOR_TESTING=1  誰でも遊べる（開発用。本番に付けない）
 * ========================================================================== */
const crypto = require("crypto");

const SESSION_DAYS = 30;
const COOKIE = "sid";
const NAME_RE = /^[\p{L}\p{N}_-]{3,20}$/u;
const PASS_MIN = 8;
const PASS_MAX = 128;
// Leave room for Stripe's USD settlement minimum ($0.50) after currency conversion.
// The API's 50 JPY native minimum may be too low for accounts settling in USD.
const MIN_PRICE_JPY = 100;
// One-time access to a web game: streamed video game with conditional rights.
const DEFAULT_PRODUCT_TAX_CODE = "txcd_10201004";
const AUTH_LIMIT = { max: 10, windowMs: 60 * 1000 }; // per IP
const CHECKOUT_LIMIT = { max: 8, windowMs: 60 * 1000 }; // per IP
const WEBHOOK_TOLERANCE_S = 300;

const ITEM_SEEDS = (env) => [
    {
        id: "ultra_mode",
        name: "超理不尽モード",
        description: "全10形態・全1000技の超高難度モード（買い切り）",
        kind: "mode",
        price_jpy: Math.max(MIN_PRICE_JPY, Number(env.ULTRA_PRICE_JPY) || 500),
    },
];

/* ---------- passwords / tokens ---------- */
function scryptAsync(password, salt, keylen, opts) {
    return new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
    );
}
const SCRYPT = { N: 16384, r: 8, p: 1 };
async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scryptAsync(password, salt, 32, SCRYPT);
    return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}
async function verifyPassword(password, stored) {
    const [kind, N, r, p, saltB64, keyB64] = String(stored).split("$");
    if (kind !== "scrypt") return false;
    const want = Buffer.from(keyB64, "base64");
    const got = await scryptAsync(password, Buffer.from(saltB64, "base64"), want.length, { N: +N, r: +r, p: +p });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH = hashPassword("dummy-password-for-timing"); // so that an unknown user takes as long as a wrong password
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

/* ---------- Stripe webhook signature (https://docs.stripe.com/webhooks#verify-manually) ---------- */
function verifyStripeSignature(rawBody, header, secret, nowMs = Date.now(), toleranceS = WEBHOOK_TOLERANCE_S) {
    if (!header || !secret || !Buffer.isBuffer(rawBody)) return false;
    const parts = String(header).split(",").map((s) => s.trim().split("="));
    const t = parts.find(([k]) => k === "t")?.[1];
    const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
    if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
    if (Math.abs(nowMs / 1000 - Number(t)) > toleranceS) return false; // old = a replayed request
    const expected = crypto.createHmac("sha256", secret).update(t + ".").update(rawBody).digest("hex");
    const eb = Buffer.from(expected, "hex");
    return sigs.some((s) => /^[0-9a-f]{64}$/.test(s) && crypto.timingSafeEqual(Buffer.from(s, "hex"), eb));
}

/* ============================================================================
 *  storage. Two implementations of the same interface: PostgreSQL (production) and memory (tests / local development).
 *  Every operation that must be atomic (granting, refunding) is ONE method, a transaction in PostgreSQL.
 * ========================================================================== */
async function createPgPaymentsStore(pool, env) {
    const q = (text, params) => pool.query(text, params);
    // ---- the tables (課金.md Phase 2). Nothing here touches the tables of the game (scores, kv) ----
    await q(`CREATE TABLE IF NOT EXISTS game_users (
        id          SERIAL PRIMARY KEY,
        username    TEXT NOT NULL,
        username_lc TEXT NOT NULL UNIQUE,
        pass_hash   TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE IF NOT EXISTS game_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES game_users(id),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await q("CREATE INDEX IF NOT EXISTS game_sessions_user ON game_sessions (user_id)");
    await q(`CREATE TABLE IF NOT EXISTS game_items (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        kind            TEXT NOT NULL DEFAULT 'item',
        price_jpy       INTEGER NOT NULL CHECK (price_jpy >= ${MIN_PRICE_JPY}),
        stripe_price_id TEXT,
        active          BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE IF NOT EXISTS game_purchases (
        id                    SERIAL PRIMARY KEY,
        user_id               INTEGER NOT NULL REFERENCES game_users(id),
        item_id               TEXT NOT NULL REFERENCES game_items(id),
        amount_jpy            INTEGER NOT NULL,
        status                TEXT NOT NULL CHECK (status IN ('pending','paid','failed','expired','refunded','granted')),
        stripe_session_id     TEXT UNIQUE,
        stripe_payment_intent TEXT,
        note                  TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        paid_at               TIMESTAMPTZ,
        refunded_at           TIMESTAMPTZ)`);
    await q("CREATE INDEX IF NOT EXISTS game_purchases_user ON game_purchases (user_id)");
    await q("CREATE INDEX IF NOT EXISTS game_purchases_pi ON game_purchases (stripe_payment_intent)");
    await q(`CREATE TABLE IF NOT EXISTS game_entitlements (
        user_id     INTEGER NOT NULL REFERENCES game_users(id),
        item_id     TEXT NOT NULL REFERENCES game_items(id),
        purchase_id INTEGER REFERENCES game_purchases(id),
        status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at  TIMESTAMPTZ,
        PRIMARY KEY (user_id, item_id))`);
    await q(`CREATE TABLE IF NOT EXISTS stripe_events (
        event_id    TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // the products (inserted once; changing a price later is done with /api/admin/item or SQL, not by this seed)
    for (const it of ITEM_SEEDS(env))
        await q(
            "INSERT INTO game_items (id, name, description, kind, price_jpy) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
            [it.id, it.name, it.description, it.kind, it.price_jpy],
        );

    // runs fn(client) inside a transaction
    async function tx(fn) {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            const out = await fn(c);
            await c.query("COMMIT");
            return out;
        } catch (e) {
            await c.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            c.release();
        }
    }
    const userRow = (r) => (r ? { id: r.id, username: r.username, passHash: r.pass_hash } : null);
    const itemRow = (r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        kind: r.kind,
        priceJpy: r.price_jpy,
        stripePriceId: r.stripe_price_id,
        active: r.active,
    });
    return {
        kind: "postgres",
        async createUser(username, passHash) {
            const r = await q(
                "INSERT INTO game_users (username, username_lc, pass_hash) VALUES ($1,$2,$3) ON CONFLICT (username_lc) DO NOTHING RETURNING id, username, pass_hash",
                [username, username.toLowerCase(), passHash],
            );
            return userRow(r.rows[0]);
        },
        async getUserByName(username) {
            return userRow((await q("SELECT * FROM game_users WHERE username_lc = $1", [username.toLowerCase()])).rows[0]);
        },
        async createSession(userId, tokenHash, expiresAt) {
            await q("INSERT INTO game_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)", [tokenHash, userId, expiresAt]);
        },
        async getSessionUser(tokenHash) {
            const r = await q(
                "SELECT u.id, u.username, u.pass_hash FROM game_sessions s JOIN game_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()",
                [tokenHash],
            );
            return userRow(r.rows[0]);
        },
        async deleteSession(tokenHash) {
            await q("DELETE FROM game_sessions WHERE token_hash = $1", [tokenHash]);
        },
        async deleteExpiredSessions() {
            await q("DELETE FROM game_sessions WHERE expires_at <= now()");
        },
        async listItems() {
            return (await q("SELECT * FROM game_items WHERE active ORDER BY created_at, id")).rows.map(itemRow);
        },
        async getItem(id) {
            const r = await q("SELECT * FROM game_items WHERE id = $1", [id]);
            return r.rows[0] ? itemRow(r.rows[0]) : null;
        },
        async updateItem(id, { priceJpy, active }) {
            const r = await q(
                "UPDATE game_items SET price_jpy = COALESCE($2, price_jpy), active = COALESCE($3, active) WHERE id = $1 RETURNING *",
                [id, priceJpy ?? null, active ?? null],
            );
            return r.rows[0] ? itemRow(r.rows[0]) : null;
        },
        async ownedItemIds(userId) {
            const r = await q("SELECT item_id FROM game_entitlements WHERE user_id = $1 AND status = 'active'", [userId]);
            return r.rows.map((x) => x.item_id);
        },
        async createPurchase(userId, itemId, amountJpy) {
            const r = await q(
                "INSERT INTO game_purchases (user_id, item_id, amount_jpy, status) VALUES ($1,$2,$3,'pending') RETURNING id",
                [userId, itemId, amountJpy],
            );
            return r.rows[0].id;
        },
        async attachStripeSession(purchaseId, sessionId) {
            await q("UPDATE game_purchases SET stripe_session_id = $2 WHERE id = $1", [purchaseId, sessionId]);
        },
        async failPurchase(purchaseId, note) {
            await q("UPDATE game_purchases SET status = 'failed', note = $2 WHERE id = $1 AND status = 'pending'", [purchaseId, note]);
        },
        // ---- Stripe says: paid. ONE transaction: remember the event, check the money, grant ----
        async completeCheckout({ eventId, eventType, sessionId, userRef, amountTotal, currency, paymentIntent }) {
            return tx(async (c) => {
                const ev = await c.query(
                    "INSERT INTO stripe_events (event_id, type) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
                    [eventId, eventType],
                );
                if (!ev.rowCount) return "duplicate_event";
                const p = await c.query("SELECT * FROM game_purchases WHERE stripe_session_id = $1 FOR UPDATE", [sessionId]);
                if (!p.rowCount) return "unknown_session";
                const row = p.rows[0];
                if (row.status === "paid" || row.status === "granted") return "already_paid";
                if (row.status === "refunded") return "already_refunded";
                if (row.amount_jpy !== amountTotal || String(currency).toLowerCase() !== "jpy" || (userRef != null && String(row.user_id) !== String(userRef))) {
                    await c.query("UPDATE game_purchases SET status = 'failed', note = $2 WHERE id = $1", [
                        row.id,
                        "mismatch: stripe " + amountTotal + " " + currency + " / expected " + row.amount_jpy + " jpy",
                    ]);
                    return "mismatch";
                }
                const had = await c.query("SELECT status FROM game_entitlements WHERE user_id = $1 AND item_id = $2", [row.user_id, row.item_id]);
                const duplicate = had.rowCount && had.rows[0].status === "active";
                await c.query(
                    "UPDATE game_purchases SET status = 'paid', paid_at = now(), stripe_payment_intent = $2, note = $3 WHERE id = $1",
                    [row.id, paymentIntent || null, duplicate ? "duplicate payment: the item was already owned (refund it)" : null],
                );
                await c.query(
                    `INSERT INTO game_entitlements (user_id, item_id, purchase_id, status) VALUES ($1,$2,$3,'active')
                     ON CONFLICT (user_id, item_id) DO UPDATE SET status = 'active', revoked_at = NULL,
                       purchase_id = CASE WHEN game_entitlements.status = 'active' THEN game_entitlements.purchase_id ELSE EXCLUDED.purchase_id END,
                       granted_at = CASE WHEN game_entitlements.status = 'active' THEN game_entitlements.granted_at ELSE now() END`,
                    [row.user_id, row.item_id, row.id],
                );
                return duplicate ? "granted_duplicate" : "granted";
            });
        },
        // ---- a refund / a dispute: the money is gone, so is the item ----
        async refundByPaymentIntent({ eventId, eventType, paymentIntent }) {
            return tx(async (c) => {
                const ev = await c.query(
                    "INSERT INTO stripe_events (event_id, type) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
                    [eventId, eventType],
                );
                if (!ev.rowCount) return "duplicate_event";
                const p = await c.query("SELECT * FROM game_purchases WHERE stripe_payment_intent = $1 FOR UPDATE", [paymentIntent]);
                if (!p.rowCount) return "unknown_payment";
                for (const row of p.rows) {
                    await c.query("UPDATE game_purchases SET status = 'refunded', refunded_at = now() WHERE id = $1", [row.id]);
                    await c.query(
                        "UPDATE game_entitlements SET status = 'revoked', revoked_at = now() WHERE purchase_id = $1 AND status = 'active'",
                        [row.id],
                    );
                }
                return "revoked";
            });
        },
        async expireSession({ eventId, eventType, sessionId }) {
            return tx(async (c) => {
                const ev = await c.query(
                    "INSERT INTO stripe_events (event_id, type) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
                    [eventId, eventType],
                );
                if (!ev.rowCount) return "duplicate_event";
                await c.query("UPDATE game_purchases SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'", [sessionId]);
                return "expired";
            });
        },
        // ---- admin: give an item without a payment (for testing / a gift). It is recorded as a purchase of 0 yen ----
        async grant(userId, itemId, note) {
            return tx(async (c) => {
                const pr = await c.query(
                    "INSERT INTO game_purchases (user_id, item_id, amount_jpy, status, note, paid_at) VALUES ($1,$2,0,'granted',$3, now()) RETURNING id",
                    [userId, itemId, note || "admin grant"],
                );
                await c.query(
                    `INSERT INTO game_entitlements (user_id, item_id, purchase_id, status) VALUES ($1,$2,$3,'active')
                     ON CONFLICT (user_id, item_id) DO UPDATE SET status = 'active', revoked_at = NULL, purchase_id = EXCLUDED.purchase_id, granted_at = now()`,
                    [userId, itemId, pr.rows[0].id],
                );
                return pr.rows[0].id;
            });
        },
    };
}

// the same interface in memory (tests and local development; nothing survives a restart)
function createMemoryPaymentsStore(env = {}) {
    const users = [],
        sessions = new Map(),
        items = new Map(),
        purchases = [],
        ent = new Map(),
        events = new Set();
    for (const it of ITEM_SEEDS(env)) items.set(it.id, { id: it.id, name: it.name, description: it.description, kind: it.kind, priceJpy: it.price_jpy, stripePriceId: null, active: true });
    const key = (u, i) => u + ":" + i;
    return {
        kind: "memory",
        _purchases: purchases,
        _entitlements: ent,
        async createUser(username, passHash) {
            if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return null;
            const u = { id: users.length + 1, username, passHash };
            users.push(u);
            return u;
        },
        async getUserByName(username) {
            return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
        },
        async createSession(userId, tokenHash, expiresAt) {
            sessions.set(tokenHash, { userId, expiresAt: new Date(expiresAt) });
        },
        async getSessionUser(tokenHash) {
            const s = sessions.get(tokenHash);
            return s && s.expiresAt > new Date() ? users.find((u) => u.id === s.userId) : null;
        },
        async deleteSession(tokenHash) {
            sessions.delete(tokenHash);
        },
        async deleteExpiredSessions() {},
        async listItems() {
            return [...items.values()].filter((i) => i.active);
        },
        async getItem(id) {
            return items.get(id) || null;
        },
        async updateItem(id, { priceJpy, active }) {
            const it = items.get(id);
            if (!it) return null;
            if (priceJpy != null) it.priceJpy = priceJpy;
            if (active != null) it.active = active;
            return it;
        },
        async ownedItemIds(userId) {
            return [...ent.values()].filter((e) => e.userId === userId && e.status === "active").map((e) => e.itemId);
        },
        async createPurchase(userId, itemId, amountJpy) {
            purchases.push({ id: purchases.length + 1, userId, itemId, amountJpy, status: "pending", sessionId: null, paymentIntent: null, note: null });
            return purchases.length;
        },
        async attachStripeSession(purchaseId, sessionId) {
            purchases[purchaseId - 1].sessionId = sessionId;
        },
        async failPurchase(purchaseId, note) {
            const p = purchases[purchaseId - 1];
            if (p.status === "pending") ((p.status = "failed"), (p.note = note));
        },
        async completeCheckout({ eventId, sessionId, userRef, amountTotal, currency, paymentIntent }) {
            if (events.has(eventId)) return "duplicate_event";
            events.add(eventId);
            const p = purchases.find((x) => x.sessionId === sessionId);
            if (!p) return "unknown_session";
            if (p.status === "paid" || p.status === "granted") return "already_paid";
            if (p.status === "refunded") return "already_refunded";
            if (p.amountJpy !== amountTotal || String(currency).toLowerCase() !== "jpy" || (userRef != null && String(p.userId) !== String(userRef))) {
                p.status = "failed";
                p.note = "mismatch";
                return "mismatch";
            }
            const had = ent.get(key(p.userId, p.itemId));
            const duplicate = !!had && had.status === "active";
            p.status = "paid";
            p.paymentIntent = paymentIntent || null;
            p.note = duplicate ? "duplicate payment" : null;
            if (!duplicate) ent.set(key(p.userId, p.itemId), { userId: p.userId, itemId: p.itemId, purchaseId: p.id, status: "active" });
            return duplicate ? "granted_duplicate" : "granted";
        },
        async refundByPaymentIntent({ eventId, paymentIntent }) {
            if (events.has(eventId)) return "duplicate_event";
            events.add(eventId);
            const rows = purchases.filter((x) => x.paymentIntent === paymentIntent);
            if (!rows.length) return "unknown_payment";
            for (const p of rows) {
                p.status = "refunded";
                for (const e of ent.values()) if (e.purchaseId === p.id && e.status === "active") e.status = "revoked";
            }
            return "revoked";
        },
        async expireSession({ eventId, sessionId }) {
            if (events.has(eventId)) return "duplicate_event";
            events.add(eventId);
            const p = purchases.find((x) => x.sessionId === sessionId);
            if (p && p.status === "pending") p.status = "expired";
            return "expired";
        },
        async grant(userId, itemId, note) {
            purchases.push({ id: purchases.length + 1, userId, itemId, amountJpy: 0, status: "granted", sessionId: null, paymentIntent: null, note: note || "admin grant" });
            ent.set(key(userId, itemId), { userId, itemId, purchaseId: purchases.length, status: "active" });
            return purchases.length;
        },
    };
}

/* ============================================================================
 *  routes
 * ========================================================================== */
function createPayments({ store, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const stripeKey = env.STRIPE_SECRET_KEY,
        webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    const baseUrl = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    // payments are on only when everything they need is there (and, in production, a database that keeps the data)
    // A memory store loses everything on a restart: with a LIVE key a customer could pay and lose the item. Never allow that.
    const memoryWithLiveKey = !!store && store.kind === "memory" && /^(sk|rk)_live_/.test(stripeKey || "");
    const disabledForDebug = env.PAYMENTS_DISABLED === "1";
    const enabled = !disabledForDebug && !!(store && stripeKey && webhookSecret && /^https?:\/\//.test(baseUrl)) && !memoryWithLiveKey;
    const adminPassword = env.ADMIN_PASSWORD || ""; // NOT the default of the ranking: the admin API stays shut until it is set
    const free = disabledForDebug || env.ULTRA_FREE_FOR_TESTING === "1";

    /* ---- cookies / sessions ---- */
    const cookieOf = (req, name) => {
        for (const part of String(req.headers.cookie || "").split(";")) {
            const [k, ...v] = part.trim().split("=");
            if (k === name) return decodeURIComponent(v.join("="));
        }
        return null;
    };
    const setCookie = (req, res, value, maxAgeS) =>
        res.append(
            "Set-Cookie",
            COOKIE + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAgeS + (req.secure ? "; Secure" : ""),
        );
    async function sessionUser(req) {
        const token = cookieOf(req, COOKIE);
        if (!token || !store) return null;
        return store.getSessionUser(sha256(token));
    }
    async function startSession(req, res, userId) {
        const token = newToken();
        await store.createSession(userId, sha256(token), new Date(now() + SESSION_DAYS * 86400e3));
        setCookie(req, res, token, SESSION_DAYS * 86400);
    }

    /* ---- CSRF: a state-changing request must come from our own page ---- */
    function sameOriginOk(req) {
        const origin = req.get("origin");
        const mine = [req.protocol + "://" + req.get("host"), baseUrl].filter(Boolean);
        if (origin) return mine.includes(origin);
        return req.get("sec-fetch-site") !== "cross-site"; // no Origin = not a browser form post
    }
    const guard = (limitBucket, limit, rateLimited) => (req, res, next) => {
        if (!sameOriginOk(req)) return res.status(403).json({ error: "bad origin" });
        if (rateLimited && rateLimited(req.ip, limit, limitBucket)) return res.status(429).json({ error: "too many requests" });
        next();
    };
    const asyncRoute = (fn) => (req, res) =>
        fn(req, res).catch((err) => {
            log.error("[payments]", err && err.stack ? err.stack : err);
            if (!res.headersSent) res.status(500).json({ error: "server error" });
        });

    /* ---- the entitlement gate for files that only buyers get (ultra.js ...) ---- */
    const gate = (itemId) => async (req, res, next) => {
        try {
            if (free) return next();
            const user = await sessionUser(req);
            if (user && (await store.ownedItemIds(user.id)).includes(itemId)) {
                res.set("Cache-Control", "private, no-store");
                return next();
            }
        } catch (err) {
            log.error("[payments] gate:", err.message);
        }
        res.status(403).type("text/plain").set("Cache-Control", "no-store").send("locked");
    };

    /* ---- Stripe REST ---- */
    async function stripePost(path, form) {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) body.append(k, String(v));
        const res = await fetchImpl("https://api.stripe.com/v1" + path, {
            method: "POST",
            headers: { Authorization: "Bearer " + stripeKey, "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error("stripe " + res.status + ": " + (json.error && json.error.message));
        return json;
    }

    /* ---- one Stripe event ---- */
    async function handleEvent(event) {
        const obj = event.data && event.data.object ? event.data.object : {};
        const base = { eventId: event.id, eventType: event.type };
        switch (event.type) {
            case "checkout.session.completed":
            case "checkout.session.async_payment_succeeded": {
                // a payment method that pays later (convenience store ...) completes the session unpaid: wait for the success event
                if (obj.payment_status !== "paid") return "not_paid_yet";
                const r = await store.completeCheckout({
                    ...base,
                    sessionId: obj.id,
                    userRef: obj.client_reference_id,
                    amountTotal: obj.amount_total,
                    currency: obj.currency,
                    paymentIntent: obj.payment_intent,
                });
                if (r === "mismatch" || r === "granted_duplicate" || r === "unknown_session") log.warn("[payments] " + event.id + ": " + r + " (session " + obj.id + ")");
                return r;
            }
            case "checkout.session.async_payment_failed":
            case "checkout.session.expired":
                return store.expireSession({ ...base, sessionId: obj.id });
            case "charge.refunded":
                if (obj.refunded !== true) return "partial_refund_ignored"; // a partial refund keeps the item
                return store.refundByPaymentIntent({ ...base, paymentIntent: obj.payment_intent });
            case "charge.dispute.created":
                return store.refundByPaymentIntent({ ...base, paymentIntent: obj.payment_intent });
            default:
                return "ignored";
        }
    }

    /* ---- the routes ---- */
    function register(app, { express, rateLimited }) {
        const json = express.json({ limit: "2kb" });
        const authGuard = guard("auth", AUTH_LIMIT, rateLimited);
        // accounts: false = nothing can be saved on the server (no database): the shop shows "preparing" instead of a form that cannot work
        const status = { enabled, accounts: !!store };
        const meBody = (user, owned) => ({ user: user ? { name: user.username } : null, owned: owned || [], payments: status });

        app.post("/api/auth/register", authGuard, json, asyncRoute(async (req, res) => {
            if (!store) return res.status(503).json({ error: "ただいまアカウントの登録・ログインを受け付けていません" });
            const { username, password } = req.body || {};
            if (typeof username !== "string" || !NAME_RE.test(username)) return res.status(400).json({ error: "ユーザー名は3〜20文字（文字・数字・_ -）" });
            if (typeof password !== "string" || password.length < PASS_MIN || password.length > PASS_MAX) return res.status(400).json({ error: "パスワードは8〜128文字" });
            const user = await store.createUser(username, await hashPassword(password));
            if (!user) return res.status(409).json({ error: "そのユーザー名は使われています" });
            await startSession(req, res, user.id);
            res.json(meBody(user, []));
        }));

        app.post("/api/auth/login", authGuard, json, asyncRoute(async (req, res) => {
            if (!store) return res.status(503).json({ error: "ただいまアカウントの登録・ログインを受け付けていません" });
            const { username, password } = req.body || {};
            if (typeof username !== "string" || typeof password !== "string" || password.length > PASS_MAX) return res.status(400).json({ error: "bad request" });
            const user = await store.getUserByName(username);
            const ok = await verifyPassword(password, user ? user.passHash : await DUMMY_HASH);
            if (!user || !ok) return res.status(401).json({ error: "ユーザー名かパスワードが違います" });
            await startSession(req, res, user.id);
            res.json(meBody(user, await store.ownedItemIds(user.id)));
        }));

        app.post("/api/auth/logout", authGuard, asyncRoute(async (req, res) => {
            const token = cookieOf(req, COOKIE);
            if (token && store) await store.deleteSession(sha256(token));
            setCookie(req, res, "", 0);
            res.json(meBody(null, []));
        }));

        app.get("/api/auth/me", asyncRoute(async (req, res) => {
            res.set("Cache-Control", "no-store");
            const user = await sessionUser(req);
            res.json(meBody(user, user ? await store.ownedItemIds(user.id) : []));
        }));

        app.get("/api/items", asyncRoute(async (req, res) => {
            res.set("Cache-Control", "no-store");
            if (!store) return res.json({ items: [], payments: status });
            const user = await sessionUser(req);
            const owned = user ? await store.ownedItemIds(user.id) : [];
            const items = (await store.listItems()).map((i) => ({ id: i.id, name: i.name, description: i.description, kind: i.kind, priceJpy: i.priceJpy, owned: owned.includes(i.id) }));
            res.json({ items, payments: status });
        }));

        app.get("/api/items/mine", asyncRoute(async (req, res) => {
            res.set("Cache-Control", "no-store");
            const user = await sessionUser(req);
            res.json({ owned: user ? await store.ownedItemIds(user.id) : [] });
        }));

        app.post("/api/payments/checkout", guard("checkout", CHECKOUT_LIMIT, rateLimited), json, asyncRoute(async (req, res) => {
            if (!enabled) return res.status(503).json({ error: "ただいま購入を受け付けていません" });
            const user = await sessionUser(req);
            if (!user) return res.status(401).json({ error: "ログインしてください" });
            const itemId = req.body && req.body.itemId;
            const item = typeof itemId === "string" ? await store.getItem(itemId) : null;
            if (!item || !item.active) return res.status(404).json({ error: "商品が見つかりません" });
            if ((await store.ownedItemIds(user.id)).includes(item.id)) return res.status(409).json({ error: "購入済みです" });
            if (!Number.isInteger(item.priceJpy) || item.priceJpy < MIN_PRICE_JPY) {
                return res.status(400).json({ error: `この商品の価格では決済できません。${MIN_PRICE_JPY}円以上に設定してください。` });
            }
            // the price is the server's: nothing the browser sends decides it
            const purchaseId = await store.createPurchase(user.id, item.id, item.priceJpy);
            const form = {
                mode: "payment",
                locale: "ja",
                success_url: baseUrl + "/beta?purchase=success",
                cancel_url: baseUrl + "/beta?purchase=cancel",
                client_reference_id: user.id,
                "metadata[purchase_id]": purchaseId,
                "metadata[item_id]": item.id,
                "metadata[user_id]": user.id,
                "payment_intent_data[metadata][purchase_id]": purchaseId,
                "line_items[0][quantity]": 1,
            };
            if (item.stripePriceId) form["line_items[0][price]"] = item.stripePriceId;
            else {
                form["line_items[0][price_data][currency]"] = "jpy";
                form["line_items[0][price_data][unit_amount]"] = item.priceJpy;
                form["line_items[0][price_data][product_data][name]"] = item.name;
                form["line_items[0][price_data][product_data][tax_code]"] = env.STRIPE_PRODUCT_TAX_CODE || DEFAULT_PRODUCT_TAX_CODE;
            }
            let session;
            try {
                session = await stripePost("/checkout/sessions", form);
            } catch (err) {
                await store.failPurchase(purchaseId, "checkout session failed: " + err.message);
                throw err;
            }
            await store.attachStripeSession(purchaseId, session.id);
            res.json({ url: session.url });
        }));

        // Stripe -> us. The body must stay RAW: the signature is computed over the exact bytes
        app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "256kb" }), asyncRoute(async (req, res) => {
            if (!enabled) return res.status(503).json({ error: "disabled" });
            if (!verifyStripeSignature(req.body, req.get("stripe-signature"), webhookSecret, now())) return res.status(400).json({ error: "bad signature" });
            let event;
            try {
                event = JSON.parse(req.body.toString("utf8"));
            } catch {
                return res.status(400).json({ error: "bad json" });
            }
            const result = await handleEvent(event); // an exception here = 500 = Stripe sends it again
            res.json({ received: true, result });
        }));

        /* ---- admin ---- */
        const adminOk = (req, res) => {
            const given = req.body && req.body.password;
            if (!adminPassword) return (res.status(503).json({ error: "admin api is off (ADMIN_PASSWORD is not set)" }), false);
            if (typeof given !== "string" || !crypto.timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(adminPassword)))) return (res.status(403).json({ error: "forbidden" }), false);
            return true;
        };
        const adminGuard = guard("admin", { max: 5, windowMs: 60 * 1000 }, rateLimited);
        app.post("/api/admin/grant", adminGuard, json, asyncRoute(async (req, res) => {
            if (!adminOk(req, res)) return;
            const { username, itemId } = req.body;
            const user = typeof username === "string" ? await store.getUserByName(username) : null;
            const item = typeof itemId === "string" ? await store.getItem(itemId) : null;
            if (!user || !item) return res.status(404).json({ error: "user or item not found" });
            await store.grant(user.id, item.id, "admin grant");
            res.json({ ok: true });
        }));
        app.post("/api/admin/item", adminGuard, json, asyncRoute(async (req, res) => {
            if (!adminOk(req, res)) return;
            const { itemId, priceJpy, active } = req.body;
            if (priceJpy != null && !(Number.isInteger(priceJpy) && priceJpy >= MIN_PRICE_JPY && priceJpy <= 1000000)) return res.status(400).json({ error: `price must be between ${MIN_PRICE_JPY} and 1000000 JPY` });
            if (active != null && typeof active !== "boolean") return res.status(400).json({ error: "bad active" });
            const item = typeof itemId === "string" ? await store.updateItem(itemId, { priceJpy, active }) : null;
            if (!item) return res.status(404).json({ error: "item not found" });
            res.json({ ok: true, item });
        }));
    }
    return { enabled, free, gate, register, handleEvent, sessionUser };
}

module.exports = {
    createPayments,
    createPgPaymentsStore,
    createMemoryPaymentsStore,
    hashPassword,
    verifyPassword,
    verifyStripeSignature,
};
