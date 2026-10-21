#!/usr/bin/env node
"use strict";
/* ============================================================================
 *  tools/pull-rl.js - 公開中のサーバーで「みんなが育てたボスAI」を rl-pretrained.js に取り込む
 *
 *    node tools/pull-rl.js https://xxxx.onrender.com
 *
 *  サーバーの GET /api/rl で、全プレイヤーの対戦から学習したボスAIを受け取り、rl-pretrained.js に書き出す。
 *  これをデプロイし直すと、サーバー側のモデルが作り直されたときや新しいブラウザが、この状態から始まる。
 *  (サーバーの保存済みモデルは、rl-pretrained.js と同じバージョン・技の一覧のうちは引き継がれる)
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const url = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(url)) {
    console.error("使い方: node tools/pull-rl.js https://xxxx.onrender.com");
    process.exit(1);
}
fetch(url + "/api/rl")
    .then(async (res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        const model = await res.json();
        if (!model || !model.sig || !model.t) throw new Error("モデルの形式が違います");
        const text =
            "/* ボスAIの初期状態 (みんなで育てたものを " + new Date().toISOString().slice(0, 10) + " に " + url + " から取得)。ブラウザ内の学習はこれを土台にさらに続く */\n" +
            "const RL_PRETRAINED = " + JSON.stringify(model) + ";\n";
        fs.writeFileSync(path.join(__dirname, "..", "public", "rl-pretrained.js"), text);
        console.log("rl-pretrained.js に書き出しました (" + Math.round(text.length / 1024) + " KB, 学習 " + (model.stats ? model.stats.decisions : "?") + " 手)");
    })
    .catch((err) => {
        console.error("取得に失敗しました: " + err.message);
        process.exit(1);
    });
