"use strict";
/* ============================================================================
 *  net.js - WebSocket client: online count + live spectating (server side: realtime.js)
 *  Nothing here touches the game state: script.js calls these functions.
 * ========================================================================== */
const Net = (() => {
    let ws = null;
    let retry = 0; // failed attempts in a row (for the reconnect delay)
    let sending = false; // true while this browser is broadcasting its own run
    const api = {
        online: null, // people connected (null = not connected)
        myId: null,
        list: [], // [{ id, mode, form, hp }] players that can be watched
        listAt: 0, // Date.now() of the last list
        snap: null, // latest screen of the watched player
        watching: null, // id of the watched player
        endedAt: 0, // Date.now() when the watched player stopped (0 = still playing)
    };

    const available = () => typeof WebSocket !== "undefined" && typeof SCORE_ENABLED !== "undefined" && SCORE_ENABLED;
    const wsUrl = () => {
        const base = SCORE_API ? SCORE_API.replace(/^http/, "ws") : (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
        return base + "/ws";
    };
    const send = (obj) => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    };

    function connect() {
        if (!available()) return;
        ws = new WebSocket(wsUrl());
        ws.onopen = () => {
            retry = 0;
            if (api.watching !== null) send({ t: "watch", id: api.watching }); // after a reconnect
        };
        ws.onmessage = (e) => {
            let m;
            try {
                m = JSON.parse(e.data);
            } catch (_) {
                return;
            }
            if (m.t === "hello") api.myId = m.id;
            else if (m.t === "online") api.online = m.n;
            else if (m.t === "list") {
                api.list = Array.isArray(m.players) ? m.players : [];
                api.listAt = Date.now();
            } else if (m.t === "snap") api.snap = m.s;
            else if (m.t === "end") api.endedAt = Date.now();
        };
        ws.onclose = () => {
            ws = null;
            api.online = null;
            // reconnect with a growing delay (1s, 2s, 4s ... max 30s)
            setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
        };
        ws.onerror = () => {}; // onclose follows
    }

    /* ---- broadcasting my own run ---- */
    api.sendSnap = (s) => {
        if (!ws || ws.readyState !== 1 || ws.bufferedAmount > 65536) return; // skip when the line is congested
        sending = true;
        send({ t: "snap", s });
    };
    api.stopSending = () => {
        if (!sending) return;
        sending = false;
        send({ t: "stop" });
    };

    /* ---- watching somebody else ---- */
    api.requestList = () => send({ t: "list" });
    api.watch = (id) => {
        api.watching = id;
        api.snap = null;
        api.endedAt = 0;
        send({ t: "watch", id });
    };
    api.unwatch = () => {
        api.watching = null;
        api.snap = null;
        api.endedAt = 0;
        send({ t: "unwatch" });
    };

    api.available = available;
    connect();
    return api;
})();
