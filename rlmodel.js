"use strict";
/* ============================================================================
 *  rlmodel.js - the boss AI that EVERY player teaches together (RLモード)   (private: not served as a file)
 *
 *  The browser (rl.js) plays against the boss and learns. Every ~20 s it sends what it learned as a
 *  list of "lessons"; this module merges the lessons of all players into ONE table, and every browser
 *  downloads that table. So the more people play, the better the boss knows how real players move.
 *
 *    GET  /api/rl            -> the shared model (same format as RL.exportData(); ETag / 304 supported)
 *    POST /api/rl            -> { ok: true }
 *         body: { v, sig, dec: [7 ints], t: { "stateKey:action": [sumOfTargets, count] }, c: {...}, m: {...} }
 *    POST /api/rl/reset      -> admin only: back to the model shipped in rl-pretrained.js
 *
 *  Merge rule (per state/action): Q = (Q * min(N, CAP_N) + sumOfTargets) / (min(N, CAP_N) + count)
 *    CAP_N keeps the boss able to change its mind when the players change their way of playing.
 *
 *  The browser is untrusted, so an upload is checked completely before ANY of it is used:
 *  same model version / action list, keys and actions inside the table sizes, counts and the
 *  average target inside fixed limits, a limited number of entries. (Plus a per-IP rate limit in server.js.)
 *  This stops garbage and spam, not a determined cheater who sends plausible-looking lessons.
 *
 *  Storage: the model lives in memory and is saved (debounced) with store.setKV: PostgreSQL on Render,
 *  rl-model.json locally. If rl-pretrained.js is newer than the saved model (new version / new actions),
 *  the shipped model replaces it. State is kept in memory => run ONE instance (Render free plan = 1 instance).
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const KV_KEY = "rl-model";
const CAP_N = 200; // lessons older than this count no more than this many samples
const MEAN_LIMIT = 40; // the average target of a lesson must be inside +-this (rewards are small numbers)
const MAX_ENTRIES = 800; // entries per upload
const MAX_COUNT_ENTRY = 500; // samples per entry
const MAX_COUNT_TOTAL = 6000; // samples per upload
const MAX_DEC = 2000; // decisions per form per upload
const SAVE_DELAY_MS = 20000;
const TAGS = ["t", "c", "m"];
const KEY_RE = /^(\d{1,5}):(\d{1,3})$/;

// the model shipped with the game (rl-pretrained.js is `const RL_PRETRAINED = {...};`)
function loadSeed() {
    try {
        const text = fs.readFileSync(path.join(__dirname, "rl-pretrained.js"), "utf8");
        const from = text.indexOf("{", text.indexOf("RL_PRETRAINED"));
        const model = JSON.parse(text.slice(from, text.lastIndexOf("}") + 1));
        if (!model || typeof model.sig !== "string" || !model.t) return null;
        if (!model.shape) {
            // an older file without sizes: same layout as rl.js version 2 (7 forms)
            model.shape = { t: 7 * 405, c: 7 * 45, m: 7 * 45, a: model.sig.split(",").length, moves: 5 };
        }
        return model;
    } catch (_) {
        return null;
    }
}

const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);

function createRlModel(store) {
    let model = null;
    let json = null; // cached JSON text of the model
    let rev = 0;
    let dirty = false;
    let timer = null;
    const epoch = Date.now().toString(36);

    const touch = () => {
        rev++;
        json = null;
        dirty = true;
        if (!timer) {
            timer = setTimeout(() => {
                timer = null;
                flush().catch((err) => console.warn("[rl] save failed:", err.message));
            }, SAVE_DELAY_MS);
            timer.unref();
        }
    };
    async function flush() {
        if (!model || !dirty) return;
        dirty = false;
        try {
            await store.setKV(KV_KEY, model);
        } catch (err) {
            dirty = true;
            throw err;
        }
    }

    async function init() {
        const seed = loadSeed();
        let saved = null;
        try {
            saved = await store.getKV(KV_KEY);
        } catch (err) {
            console.warn("[rl] could not read the saved model:", err.message);
        }
        const usable = isObj(saved) && saved.v && typeof saved.sig === "string" && isObj(saved.shape) && isObj(saved.t);
        // a new version / new action list in rl-pretrained.js replaces an old saved model
        if (usable && (!seed || (saved.v === seed.v && saved.sig === seed.sig))) model = saved;
        else model = seed;
        if (model) {
            model.stats = isObj(model.stats) ? model.stats : {};
            if (!Array.isArray(model.stats.byForm) || model.stats.byForm.length !== 7) model.stats.byForm = Array(7).fill(0);
            model.stats.decisions = Number(model.stats.decisions) || 0;
            for (const tag of ["t", "c", "m"]) if (!isObj(model[tag])) model[tag] = {};
            if (model !== saved) touch();
            console.log("[rl] shared boss ready (" + model.stats.decisions + " decisions learned" + (model === saved ? ", restored" : ", from rl-pretrained.js") + ")");
        } else console.warn("[rl] no rl-pretrained.js and no saved model: shared learning is off");
    }

    const ready = () => !!model;
    function snapshot() {
        if (json === null) json = JSON.stringify(model);
        return { json, etag: '"' + epoch + "-" + rev + '"' };
    }

    // check the whole upload, then apply it. -> { ok: true } or { status, error }
    function merge(body) {
        if (!model) return { status: 503, error: "shared learning is off" };
        if (!isObj(body)) return { status: 400, error: "bad body" };
        if (body.v !== model.v || body.sig !== model.sig) return { status: 409, error: "model changed" };
        const { shape } = model;
        const size = { t: shape.t, c: shape.c, m: shape.c }; // movement lessons use the coarse state
        const width = { t: shape.a, c: shape.a, m: shape.moves };

        const lessons = []; // [tag, key, action, sum, count]
        let total = 0;
        for (const tag of TAGS) {
            const part = body[tag];
            if (part === undefined) continue;
            if (!isObj(part)) return { status: 400, error: "bad " + tag };
            for (const [k, v] of Object.entries(part)) {
                const m = KEY_RE.exec(k);
                if (!m) return { status: 400, error: "bad key" };
                const key = Number(m[1]);
                const a = Number(m[2]);
                if (key >= size[tag] || a >= width[tag]) return { status: 400, error: "key out of range" };
                if (!Array.isArray(v) || v.length !== 2) return { status: 400, error: "bad entry" };
                const [sum, count] = v;
                if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT_ENTRY) return { status: 400, error: "bad count" };
                if (typeof sum !== "number" || !Number.isFinite(sum) || Math.abs(sum / count) > MEAN_LIMIT) return { status: 400, error: "bad value" };
                total += count;
                lessons.push([tag, key, a, sum, count]);
                if (lessons.length > MAX_ENTRIES || total > MAX_COUNT_TOTAL) return { status: 400, error: "too many entries" };
            }
        }
        let dec = null;
        if (body.dec !== undefined) {
            if (!Array.isArray(body.dec) || body.dec.length !== 7 || !body.dec.every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_DEC))
                return { status: 400, error: "bad dec" };
            dec = body.dec;
        }

        // everything is valid: apply
        for (const [tag, key, a, sum, count] of lessons) {
            const row = model[tag][key] || (model[tag][key] = {});
            const cur = row[a] || [0, 0];
            const n0 = Math.min(cur[1], CAP_N);
            row[a] = [Number(((cur[0] * n0 + sum) / (n0 + count)).toFixed(3)), Math.min(65535, cur[1] + count)];
        }
        if (dec)
            dec.forEach((n, i) => {
                model.stats.byForm[i] += n;
                model.stats.decisions += n;
            });
        model.stats.episodes = (Number(model.stats.episodes) || 0) + 1;
        touch();
        return { ok: true };
    }

    // admin: forget what the players taught the boss
    function reset() {
        const seed = loadSeed();
        if (!seed) return false;
        model = seed;
        touch();
        return true;
    }

    return { init, ready, snapshot, merge, reset, flush };
}

module.exports = { createRlModel, loadSeed };
