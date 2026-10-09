"use strict";
/* ============================================================================
 *  scoring.js - the score formula. ONE file used by both the game (browser, via
 *  <script src="scoring.js">) and server.js (require), so they can never disagree.
 *
 *  A run is worth (higher = better):
 *    形態ポイント   every defeated form: FORM_BASE + FORM_STEP * (form number - 1)
 *    タイムボーナス every defeated form: up to TIME_MAX, shrinking to 0 as the time spent in that
 *                   form grows to its "par" time (parMs below, = boss HP x 200 ms)
 *    生存ボーナス   (not cleared) the form you died in: up to SURVIVE_MAX, depending on how long
 *                   you lasted in it compared to its par time
 *    クリアボーナス (cleared) CLEAR_BONUS
 *    体力ボーナス   (cleared) HP_POINT per HP left at the end
 *  Tune the numbers below to change the balance. Old records are not affected on the server,
 *  because the server stores the score it computed when the record was sent.
 * ========================================================================== */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.Scoring = factory();
})(typeof self !== "undefined" ? self : this, function () {
    const MAX_HP = 8; // the player's normal max HP (records with admin sliders are never sent)

    const FORM_BASE = 1000;
    const FORM_STEP = 250;
    const TIME_MAX = 500;
    const SURVIVE_MAX = 300;
    const CLEAR_BONUS = 5000;
    const HP_POINT = 300;

    // forms = number of forms of the mode, parMs = par time per form (ms)
    const MODES = {
        hard: { forms: 7, parMs: [34000, 44000, 52000, 68000, 76000, 88000, 112000] },
        normal: { forms: 4, parMs: [34000, 44000, 52000, 68000] },
    };

    // r: { cleared, form (1-based, the form reached), formMs, splits (cumulative ms per form, null = not defeated), hp }
    // returns { total, formPts, timePts, survive, clear, hp } (all integers)
    function compute(mode, r) {
        const m = MODES[mode];
        const defeated = r.cleared ? m.forms : r.form - 1;
        let formPts = 0,
            timePts = 0,
            prev = 0;
        for (let i = 0; i < defeated; i++) {
            formPts += FORM_BASE + FORM_STEP * i;
            const t = Math.max(0, r.splits[i] - prev);
            prev = r.splits[i];
            timePts += Math.round(TIME_MAX * Math.max(0, 1 - t / m.parMs[i]));
        }
        const survive = r.cleared ? 0 : Math.round(SURVIVE_MAX * Math.min(1, r.formMs / m.parMs[r.form - 1]));
        const clear = r.cleared ? CLEAR_BONUS : 0;
        const hp = r.cleared ? Math.max(0, r.hp) * HP_POINT : 0;
        return { total: formPts + timePts + survive + clear + hp, formPts, timePts, survive, clear, hp };
    }

    return { MAX_HP, MODES, compute };
});
