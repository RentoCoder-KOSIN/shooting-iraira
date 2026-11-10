#!/usr/bin/env node
"use strict";
/* tools/payments-test.js - server/payments.js のテスト（本物のStripe・PostgreSQL・express は使わない）
 *   node tools/payments-test.js
 *  偽のexpress（ルートを集めて、リクエストを直接流す）+ メモリ保存 + 偽のStripe(fetch) で、次を確認する:
 *   アカウント / CSRF / 商品 / チェックアウト(金額はサーバーが決める) / Webhook(署名・古い通知・二重通知・金額違い・返金) / 管理者 / 鍵(ゲート)
 *  PostgreSQL 用のSQLはここでは動かせない（server/payments.js の createPgPaymentsStore）。本番の前に、テスト用のDBで1回通すこと。
 */
const crypto = require("crypto");
const {
    createPayments,
    createMemoryPaymentsStore,
    hashPassword,
    verifyPassword,
    verifyStripeSignature,
} = require("../server/payments.js");

let failed = 0;
const ok = (name, cond, extra = "") => {
    console.log((cond ? "OK   " : "FAIL ") + name + (cond ? "" : "  " + extra));
    if (!cond) failed++;
};

/* ---- a tiny express ---- */
function makeApp() {
    const routes = [];
    const add = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
    const app = { post: add("POST"), get: add("GET") };
    const express = { json: () => (req, res, next) => next(), raw: () => (req, res, next) => next() };
    return { app, express, routes };
}
async function call(routes, method, path, { body, headers = {}, cookie, ip = "1.1.1.1", rawBody } = {}) {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error("no route " + method + " " + path);
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (!("origin" in h) && method === "POST") h.origin = "https://game.example";
    const req = {
        headers: h,
        body: rawBody !== undefined ? rawBody : body,
        ip,
        protocol: "https",
        secure: true,
        get: (k) => (k.toLowerCase() === "host" ? "game.example" : h[k.toLowerCase()]),
    };
    const out = { status: 200, headers: {}, cookies: [], body: undefined, sent: false };
    const res = {
        get headersSent() {
            return out.sent;
        },
        status(c) {
            out.status = c;
            return res;
        },
        set(k, v) {
            out.headers[k] = v;
            return res;
        },
        type() {
            return res;
        },
        append(k, v) {
            if (k === "Set-Cookie") out.cookies.push(v);
            return res;
        },
        json(b) {
            out.body = b;
            out.sent = true;
            return res;
        },
        send(b) {
            out.body = b;
            out.sent = true;
            return res;
        },
    };
    // run the chain
    // middleware calls next() without returning it: collect every handler's promise and wait for all of them
    let i = 0;
    const pending = [];
    const next = () => {
        const fn = route.handlers[i++];
        if (fn) pending.push(Promise.resolve(fn(req, res, next)));
    };
    next();
    while (pending.length) await pending.shift();
    return out;
}
const cookieOf = (out) => (out.cookies[0] ? out.cookies[0].split(";")[0] : null);

/* ---- a fake Stripe ---- */
function fakeStripe() {
    const calls = [];
    const fetchImpl = async (url, opt) => {
        const form = Object.fromEntries(new URLSearchParams(opt.body));
        calls.push({ url, form, auth: opt.headers.Authorization });
        return { ok: true, status: 200, json: async () => ({ id: "cs_test_" + calls.length, url: "https://checkout.stripe.test/c/" + calls.length }) };
    };
    return { fetchImpl, calls };
}
const SECRET = "whsec_test_secret";
const sign = (body, t = Math.floor(Date.now() / 1000), secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, header: "t=" + t + ",v1=" + crypto.createHmac("sha256", secret).update(t + ".").update(raw).digest("hex") };
};
let evSeq = 0;
const event = (type, object, id = "evt_" + ++evSeq) => ({ id, type, data: { object } });

function setup(envExtra = {}) {
    const env = {
        STRIPE_SECRET_KEY: "sk_test_x",
        STRIPE_WEBHOOK_SECRET: SECRET,
        PUBLIC_BASE_URL: "https://game.example",
        ADMIN_PASSWORD: "admin-pass",
        ...envExtra,
    };
    const store = createMemoryPaymentsStore(env);
    const stripe = fakeStripe();
    const payments = createPayments({ store, env, fetchImpl: stripe.fetchImpl, log: { error() {}, warn() {} } });
    const { app, express, routes } = makeApp();
    payments.register(app, { express, rateLimited: () => false });
    return { env, store, stripe, payments, routes };
}
async function registerUser(t, name = "player1", pw = "correct horse") {
    const r = await call(t.routes, "POST", "/api/auth/register", { body: { username: name, password: pw } });
    return { ...r, cookie: cookieOf(r) };
}
const hook = (t, body, opt = {}) => {
    const s = sign(body, opt.t, opt.secret);
    return call(t.routes, "POST", "/api/stripe/webhook", { rawBody: s.raw, headers: { "stripe-signature": opt.header ?? s.header, origin: undefined } });
};
const completed = (t, sessionId, over = {}) =>
    event("checkout.session.completed", { id: sessionId, payment_status: "paid", amount_total: 500, currency: "jpy", payment_intent: "pi_1", client_reference_id: "1", ...over });
const gateStatus = async (t, cookie) => {
    let passed = false;
    const res = { status: (c) => ((res.code = c), res), type: () => res, set: () => res, send: () => res };
    await t.payments.gate("ultra_mode")({ headers: cookie ? { cookie } : {} }, res, () => (passed = true));
    return passed ? 200 : res.code;
};

(async () => {
    /* ---- passwords ---- */
    {
        const h = await hashPassword("secret pass");
        ok("password: the right one verifies, a wrong one does not", (await verifyPassword("secret pass", h)) && !(await verifyPassword("secret pasS", h)));
        ok("password: the hash is salted (two hashes differ)", h !== (await hashPassword("secret pass")));
        ok("password: the hash does not contain the password", !h.includes("secret pass"));
    }
    /* ---- signature ---- */
    {
        const body = { a: 1 };
        const s = sign(body);
        const nowS = Date.now();
        ok("signature: a good one passes", verifyStripeSignature(s.raw, s.header, SECRET, nowS));
        ok("signature: a wrong secret fails", !verifyStripeSignature(s.raw, s.header, "whsec_other", nowS));
        ok("signature: a changed body fails", !verifyStripeSignature(Buffer.from('{"a":2}'), s.header, SECRET, nowS));
        ok("signature: 10 minutes old fails (replay)", !verifyStripeSignature(s.raw, s.header, SECRET, nowS + 10 * 60e3));
        ok("signature: garbage / missing header fails", !verifyStripeSignature(s.raw, "t=1,v1=zz", SECRET, nowS) && !verifyStripeSignature(s.raw, undefined, SECRET, nowS));
    }
    /* ---- accounts ---- */
    {
        const t = setup();
        let r = await call(t.routes, "POST", "/api/auth/register", { body: { username: "ab", password: "correct horse" } });
        ok("register: a 2-letter name is refused", r.status === 400);
        r = await call(t.routes, "POST", "/api/auth/register", { body: { username: "player1", password: "short" } });
        ok("register: a short password is refused", r.status === 400);
        r = await registerUser(t);
        ok("register: ok, a session cookie is set (HttpOnly, SameSite, Secure)", r.status === 200 && /HttpOnly/.test(r.cookies[0]) && /SameSite=Lax/.test(r.cookies[0]) && /Secure/.test(r.cookies[0]) && r.body.user.name === "player1");
        ok("register: the cookie holds a random token, not the user id or the password", !/player1|correct horse/.test(r.cookies[0]));
        const dup = await call(t.routes, "POST", "/api/auth/register", { body: { username: "PLAYER1", password: "another pass" } });
        ok("register: the same name in another case is refused", dup.status === 409);
        let me = await call(t.routes, "GET", "/api/auth/me", { cookie: r.cookie });
        ok("me: shows the user", me.body.user && me.body.user.name === "player1" && Array.isArray(me.body.owned));
        me = await call(t.routes, "GET", "/api/auth/me", {});
        ok("me: nobody logged in", me.body.user === null);
        let bad = await call(t.routes, "POST", "/api/auth/login", { body: { username: "player1", password: "wrong password" } });
        ok("login: a wrong password is 401", bad.status === 401);
        bad = await call(t.routes, "POST", "/api/auth/login", { body: { username: "nobody", password: "whatever pass" } });
        ok("login: an unknown user is 401 with the same message", bad.status === 401 && bad.body.error === (await call(t.routes, "POST", "/api/auth/login", { body: { username: "player1", password: "wrong password" } })).body.error);
        const good = await call(t.routes, "POST", "/api/auth/login", { body: { username: "Player1", password: "correct horse" } });
        ok("login: the right password works (the name is not case sensitive)", good.status === 200 && cookieOf(good));
        const out = await call(t.routes, "POST", "/api/auth/logout", { cookie: r.cookie });
        const after = await call(t.routes, "GET", "/api/auth/me", { cookie: r.cookie });
        ok("logout: the session is gone on the server", out.status === 200 && after.body.user === null);
    }
    /* ---- CSRF / rate limit ---- */
    {
        const t = setup();
        let r = await call(t.routes, "POST", "/api/auth/register", { body: { username: "player1", password: "correct horse" }, headers: { origin: "https://evil.example" } });
        ok("csrf: a POST from another site is refused", r.status === 403);
        r = await call(t.routes, "POST", "/api/auth/register", { body: { username: "player1", password: "correct horse" }, headers: { origin: undefined, "sec-fetch-site": "cross-site" } });
        ok("csrf: no Origin but Sec-Fetch-Site: cross-site is refused", r.status === 403);
        const { app, express, routes } = makeApp();
        const t2 = setup();
        t2.payments.register(app, { express, rateLimited: () => true });
        r = await call(routes, "POST", "/api/auth/login", { body: { username: "a", password: "b" } });
        ok("rate limit: 429 when the limiter says so", r.status === 429);
    }
    /* ---- items + checkout ---- */
    {
        const t = setup();
        const items = await call(t.routes, "GET", "/api/items", {});
        ok("items: 超理不尽モード is for sale with a server-side price", items.body.items.length === 1 && items.body.items[0].id === "ultra_mode" && items.body.items[0].priceJpy === 500 && items.body.items[0].owned === false);
        let r = await call(t.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" } });
        ok("checkout: needs a login", r.status === 401);
        const u = await registerUser(t);
        r = await call(t.routes, "POST", "/api/payments/checkout", { body: { itemId: "nope" }, cookie: u.cookie });
        ok("checkout: an unknown item is 404", r.status === 404);
        r = await call(t.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode", priceJpy: 1, amount: 1, price: 1 }, cookie: u.cookie });
        const form = t.stripe.calls[0] && t.stripe.calls[0].form;
        ok("checkout: ok, returns the Stripe url", r.status === 200 && /^https:\/\/checkout\.stripe\.test\//.test(r.body.url));
        ok("checkout: the amount is the server's 500 yen, whatever the browser sent", form && form["line_items[0][price_data][unit_amount]"] === "500" && form["line_items[0][price_data][currency]"] === "jpy");
        ok("checkout: the user and the purchase travel with the session", form["client_reference_id"] === "1" && form["metadata[purchase_id]"] === "1" && form["metadata[item_id]"] === "ultra_mode");
        ok("checkout: the secret key is only in the Authorization header of the call to Stripe", t.stripe.calls[0].auth === "Bearer sk_test_x" && !JSON.stringify(r.body).includes("sk_test"));
        ok("checkout: return urls come from PUBLIC_BASE_URL, not from the request", form.success_url === "https://game.example/beta?purchase=success" && form.cancel_url === "https://game.example/beta?purchase=cancel");
        ok("checkout: before the webhook nothing is owned", (await call(t.routes, "GET", "/api/items/mine", { cookie: u.cookie })).body.owned.length === 0 && (await gateStatus(t, u.cookie)) === 403);
    }
    /* ---- webhook: the happy path and everything that must not grant ---- */
    {
        const t = setup();
        const u = await registerUser(t);
        await call(t.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u.cookie });
        const session = "cs_test_1";
        let r = await hook(t, completed(t, session), { header: "t=1,v1=" + "0".repeat(64) });
        ok("webhook: a bad signature is 400 and grants nothing", r.status === 400 && (await gateStatus(t, u.cookie)) === 403);
        r = await hook(t, completed(t, session), { t: Math.floor(Date.now() / 1000) - 3600 });
        ok("webhook: a validly signed but old request is 400 (replay)", r.status === 400 && (await gateStatus(t, u.cookie)) === 403);
        r = await hook(t, completed(t, session, { payment_status: "unpaid" }));
        ok("webhook: a session that is not paid yet grants nothing", r.body.result === "not_paid_yet" && (await gateStatus(t, u.cookie)) === 403);
        r = await hook(t, completed(t, session, { amount_total: 100 }));
        ok("webhook: a wrong amount grants nothing", r.body.result === "mismatch" && (await gateStatus(t, u.cookie)) === 403);

        // the purchase above failed (mismatch): a new checkout, then the real payment
        const t2 = setup();
        const u2 = await registerUser(t2);
        await call(t2.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u2.cookie });
        r = await hook(t2, completed(t2, "cs_test_1", { client_reference_id: "999" }));
        ok("webhook: a payment that belongs to another user grants nothing", r.body.result === "mismatch" && (await gateStatus(t2, u2.cookie)) === 403);

        const t3 = setup();
        const u3 = await registerUser(t3);
        await call(t3.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u3.cookie });
        r = await hook(t3, completed(t3, "cs_unknown"));
        ok("webhook: a session we never made grants nothing", r.body.result === "unknown_session");
        const ev = completed(t3, "cs_test_1");
        ok("gate: locked before the payment", (await gateStatus(t3, u3.cookie)) === 403 && (await gateStatus(t3, null)) === 403);
        r = await hook(t3, ev);
        ok("webhook: a good payment grants the item", r.status === 200 && r.body.result === "granted");
        ok("gate: open for the buyer, still locked for everybody else", (await gateStatus(t3, u3.cookie)) === 200 && (await gateStatus(t3, null)) === 403);
        const other = await registerUser(t3, "player2", "another pass1");
        ok("gate: another logged-in user without the item is locked", (await gateStatus(t3, other.cookie)) === 403);
        r = await hook(t3, ev);
        ok("webhook: the same event twice is not processed twice", r.body.result === "duplicate_event" && t3.store._purchases.filter((p) => p.status === "paid").length === 1);
        r = await hook(t3, completed(t3, "cs_test_1"));
        ok("webhook: the same payment in a new event is 'already paid'", r.body.result === "already_paid");
        r = await call(t3.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u3.cookie });
        ok("checkout: an owner cannot buy it again", r.status === 409);
        ok("items/mine: lists the item after the purchase", (await call(t3.routes, "GET", "/api/items/mine", { cookie: u3.cookie })).body.owned.join() === "ultra_mode");

        // refunds
        r = await hook(t3, event("charge.refunded", { payment_intent: "pi_1", refunded: false }));
        ok("refund: a partial refund keeps the item", r.body.result === "partial_refund_ignored" && (await gateStatus(t3, u3.cookie)) === 200);
        r = await hook(t3, event("charge.refunded", { payment_intent: "pi_1", refunded: true }));
        ok("refund: a full refund takes the item away", r.body.result === "revoked" && (await gateStatus(t3, u3.cookie)) === 403);
        ok("refund: the purchase is kept (status refunded), not deleted", t3.store._purchases.length === 1 && t3.store._purchases[0].status === "refunded");
        ok("refund: it can be bought again afterwards", (await call(t3.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u3.cookie })).status === 200);

        // a dispute
        const t4 = setup();
        const u4 = await registerUser(t4);
        await call(t4.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u4.cookie });
        await hook(t4, completed(t4, "cs_test_1", { payment_intent: "pi_9" }));
        r = await hook(t4, event("charge.dispute.created", { payment_intent: "pi_9" }));
        ok("dispute: a chargeback takes the item away", r.body.result === "revoked" && (await gateStatus(t4, u4.cookie)) === 403);

        // a payment method that pays later
        const t5 = setup();
        const u5 = await registerUser(t5);
        await call(t5.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u5.cookie });
        await hook(t5, completed(t5, "cs_test_1", { payment_status: "unpaid" }));
        r = await hook(t5, event("checkout.session.async_payment_succeeded", { id: "cs_test_1", payment_status: "paid", amount_total: 500, currency: "jpy", payment_intent: "pi_a", client_reference_id: "1" }));
        ok("async payment: granted only when Stripe says it succeeded", r.body.result === "granted" && (await gateStatus(t5, u5.cookie)) === 200);

        // double payment (two tabs)
        const t6 = setup();
        const u6 = await registerUser(t6);
        await call(t6.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u6.cookie });
        await call(t6.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u6.cookie });
        await hook(t6, completed(t6, "cs_test_1", { payment_intent: "pi_a" }));
        r = await hook(t6, completed(t6, "cs_test_2", { payment_intent: "pi_b" }));
        ok("double payment: the item is not granted twice, and it is flagged for a refund", r.body.result === "granted_duplicate" && t6.store._purchases[1].note === "duplicate payment" && (await gateStatus(t6, u6.cookie)) === 200);
        // refunding the duplicate must not take away the item that was paid for the first time
        await hook(t6, event("charge.refunded", { payment_intent: "pi_b", refunded: true }));
        ok("double payment: refunding the duplicate keeps the item of the first payment", (await gateStatus(t6, u6.cookie)) === 200);

        r = await hook(t6, event("checkout.session.expired", { id: "cs_x" }));
        ok("webhook: other events are accepted", r.status === 200);
        r = await hook(t6, event("something.else", {}));
        ok("webhook: unknown events are ignored", r.body.result === "ignored");
    }
    /* ---- admin ---- */
    {
        const t = setup();
        const u = await registerUser(t);
        let r = await call(t.routes, "POST", "/api/admin/grant", { body: { password: "wrong", username: "player1", itemId: "ultra_mode" } });
        ok("admin: a wrong password is 403", r.status === 403 && (await gateStatus(t, u.cookie)) === 403);
        r = await call(t.routes, "POST", "/api/admin/grant", { body: { password: "admin-pass", username: "player1", itemId: "ultra_mode" } });
        ok("admin: grant gives the item (recorded as a 0 yen purchase)", r.body.ok && (await gateStatus(t, u.cookie)) === 200 && t.store._purchases[0].amountJpy === 0);
        r = await call(t.routes, "POST", "/api/admin/item", { body: { password: "admin-pass", itemId: "ultra_mode", priceJpy: 50 } });
        ok("admin: a price under 100 yen is refused (allows for Stripe USD settlement minimum)", r.status === 400);
        r = await call(t.routes, "POST", "/api/admin/item", { body: { password: "admin-pass", itemId: "ultra_mode", priceJpy: 800 } });
        ok("admin: the price can be changed", r.body.item.priceJpy === 800 && (await call(t.routes, "GET", "/api/items", {})).body.items[0].priceJpy === 800);
        r = await call(t.routes, "POST", "/api/admin/item", { body: { password: "admin-pass", itemId: "ultra_mode", active: false } });
        ok("admin: a product can be taken off sale", (await call(t.routes, "GET", "/api/items", {})).body.items.length === 0);
        const noPw = setup({ ADMIN_PASSWORD: "" });
        r = await call(noPw.routes, "POST", "/api/admin/grant", { body: { password: "mint", username: "x", itemId: "ultra_mode" } });
        ok("admin: with no ADMIN_PASSWORD set the admin API is off (the ranking's default 'mint' does not work here)", r.status === 503);
    }
    /* ---- shop switched off / test flag ---- */
    {
        const t = setup({ STRIPE_SECRET_KEY: "" });
        const u = await registerUser(t);
        let r = await call(t.routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: u.cookie });
        ok("no Stripe key: accounts work, checkout is 503", u.status === 200 && r.status === 503);
        r = await hook(t, completed(t, "cs_test_1"));
        ok("no Stripe key: the webhook is 503", r.status === 503);
        ok("no Stripe key: the game stays locked", (await gateStatus(t, u.cookie)) === 403);
        const noUrl = setup({ PUBLIC_BASE_URL: "" });
        ok("no PUBLIC_BASE_URL: the shop is off", noUrl.payments.enabled === false);
        const free = setup({ ULTRA_FREE_FOR_TESTING: "1" });
        ok("ULTRA_FREE_FOR_TESTING=1: the gate is open (for development)", (await gateStatus(free, null)) === 200);
        const off = createPayments({ store: null, env: {}, log: { error() {}, warn() {} } });
        const res = { status: (c) => ((res.code = c), res), type: () => res, set: () => res, send: () => res };
        let passed = false;
        await off.gate("ultra_mode")({ headers: {} }, res, () => (passed = true));
        ok("no database: the gate is shut (fail closed)", !passed && res.code === 403);
    }
    /* ---- no database / a live key on a memory store ---- */
    {
        const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: "https://game.example" };
        const payments = createPayments({ store: null, env, log: { error() {}, warn() {} } });
        const { app, express, routes } = makeApp();
        payments.register(app, { express, rateLimited: () => false });
        const r = await call(routes, "POST", "/api/auth/register", { body: { username: "player1", password: "correct horse" } });
        ok("no database: registering says so in Japanese (503), not a bare 'unavailable'", r.status === 503 && /ただいま/.test(r.body.error));
        const me = await call(routes, "GET", "/api/auth/me", {});
        ok("no database: /api/auth/me tells the shop that accounts are off (so it shows 'preparing')", me.body.payments.accounts === false && me.body.payments.enabled === false);
        const live = setup({ STRIPE_SECRET_KEY: "sk_live_x" });
        ok("a memory store with a LIVE key never takes payments (a restart would lose the purchases)", live.payments.enabled === false);
        ok("a memory store with a test key is fine (development)", setup().payments.enabled === true);
    }
    /* ---- stripe errors ---- */
    {
        const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: "https://game.example" };
        const store = createMemoryPaymentsStore(env);
        const payments = createPayments({ store, env, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) }), log: { error() {}, warn() {} } });
        const { app, express, routes } = makeApp();
        payments.register(app, { express, rateLimited: () => false });
        const u = await call(routes, "POST", "/api/auth/register", { body: { username: "player1", password: "correct horse" } });
        const r = await call(routes, "POST", "/api/payments/checkout", { body: { itemId: "ultra_mode" }, cookie: cookieOf(u) });
        ok("stripe error: the user gets a 500 and the pending purchase is marked failed", r.status === 500 && store._purchases[0].status === "failed");
    }
    console.log(failed ? "\nFAILED (" + failed + ")" : "\nALL OK");
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
