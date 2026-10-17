/* ============================================================================
 *  audio.js - 音声(BGM / 効果音)
 *
 *  音声ファイルは「audio/」フォルダに、下の名前で置くだけで鳴ります。
 *    audio/bgm/title.mp3 , audio/se/hurt.mp3 ...
 *  ファイルが無い音は、エラーにならずに無音のままです(あとから1つずつ追加できます)。
 *
 *  差し替え・追加のしかた
 *    1. 同じファイル名で上書きする          → 何も編集しなくてOK
 *    2. 拡張子を変えたい(wav / ogg など)    → 下の ext を変える(全部そろえる)
 *    3. 1つだけ別のファイル名にしたい       → その音に file: "xxx/yyy.ogg" を書く
 *    4. 音量・連打の間隔を調整したい        → vol(0〜1) / cooldown(ミリ秒) を書く
 *    5. 新しい効果音を足したい              → se に名前を足して、鳴らしたい所で Sound.se("名前")
 *
 *  操作: 「-」キーでミュート(設定はブラウザに保存されます)
 * ========================================================================== */

const AUDIO = {
    dir: "audio", // 音声フォルダ
    ext: "mp3", // 拡張子(mp3 / ogg / wav ...)
    bgmVolume: 0.5, // BGM全体の音量 0〜1
    seVolume: 0.7, // 効果音全体の音量 0〜1
    fadeMs: 400, // BGMが切り替わる時のフェード時間

    // ---- BGM: audio/bgm/<名前>.<ext> ----
    //  form1〜form7 が無い形態は play が流れます(形態ごとに変えたい時だけ form◯ を置く)
    bgm: {
        title: {}, // タイトル・モード選択・練習の選択画面
        select: {}, // 玉の選択画面
        play: {}, // 戦闘中(形態ごとの曲が無い時はこれ)
        form1: {},
        form2: {},
        form3: {},
        form4: {},
        form5: {},
        form6: {},
        form7: {},
        over: { loop: false }, // ゲームオーバー
        win: { loop: false }, // クリア
    },

    // ---- 効果音: audio/se/<名前>.<ext> ----
    se: {
        shot: { vol: 0.25, cooldown: 90 }, // 自機のショット
        bossHit: { vol: 0.3, cooldown: 80 }, // ショットがボスに当たった
        hurt: {}, // 被弾
        orb: {}, // 玉を取った
        heal: {}, // ランダムキーの回復
        bossDefeat: {}, // ボスを倒した
        gameover: {}, // ゲームオーバー
        clear: {}, // クリア
        fclear: {}, // 偽のCLEAR(最終形態の前)
        fake: {}, // 偽のゲームオーバー(紫の玉)
        decide: {}, // 決定・戻る
        cursor: {}, // カーソル移動
    },
};

const Sound = (() => {
    const hasAudio = typeof Audio !== "undefined" && typeof window !== "undefined";
    const KEY = "shootingAudio";
    const POOL = 4; // 同じ効果音を重ねて鳴らせる数
    const dead = new Set(); // 読み込めなかった音(ファイル無し) "bgm:title" / "se:hurt"
    const seNodes = {}; // name -> { els: [], i: 0, last: 0 }
    const bgmEls = {}; // name -> Audio
    let unlocked = false;
    let muted = false;
    let want = null; // 今流したいBGM { names: [優先, 代わり], }
    let cur = null; // 今流れているBGM { name, el }
    let fadeTimer = 0;

    try {
        const s = JSON.parse(localStorage.getItem(KEY) || "{}");
        if (typeof s.muted === "boolean") muted = s.muted;
        if (typeof s.bgm === "number") AUDIO.bgmVolume = s.bgm;
        if (typeof s.se === "number") AUDIO.seVolume = s.se;
    } catch (_) {}
    const save = () => {
        try {
            localStorage.setItem(
                KEY,
                JSON.stringify({ muted, bgm: AUDIO.bgmVolume, se: AUDIO.seVolume }),
            );
        } catch (_) {}
    };

    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const path = (kind, name, o) =>
        (o && o.file) || `${AUDIO.dir}/${kind}/${name}.${AUDIO.ext}`;

    function makeEl(kind, name, o, onDead) {
        const el = new Audio();
        el.preload = "auto";
        el.addEventListener("error", () => {
            dead.add(kind + ":" + name);
            if (onDead) onDead();
        });
        el.src = path(kind, name, o);
        return el;
    }

    // ---- 効果音 ----
    function seNode(name) {
        const o = AUDIO.se[name];
        if (!o || dead.has("se:" + name)) return null;
        if (!seNodes[name]) {
            seNodes[name] = {
                els: [makeEl("se", name, o)],
                i: 0,
                last: 0,
            };
        }
        return seNodes[name];
    }
    function se(name) {
        if (!hasAudio || !unlocked || muted) return;
        const o = AUDIO.se[name];
        const n = seNode(name);
        if (!o || !n) return;
        const now = Date.now();
        if (o.cooldown && now - n.last < o.cooldown) return;
        n.last = now;
        // 重ねて鳴らせるように、必要なぶんだけ複製して使い回す
        if (n.els.length < POOL) n.els.push(n.els[0].cloneNode());
        const el = n.els[n.i++ % n.els.length];
        el.volume = clamp01((o.vol == null ? 1 : o.vol) * AUDIO.seVolume);
        try {
            el.currentTime = 0;
            const p = el.play();
            if (p && p.catch) p.catch(() => {});
        } catch (_) {}
    }

    // ---- BGM ----
    function bgmVol(name) {
        const o = AUDIO.bgm[name] || {};
        return clamp01((o.vol == null ? 1 : o.vol) * AUDIO.bgmVolume);
    }
    function bgmEl(name) {
        if (!bgmEls[name]) {
            const o = AUDIO.bgm[name] || {};
            bgmEls[name] = makeEl("bgm", name, o, apply); // 無かったら代わりの曲に切り替える
            bgmEls[name].loop = o.loop !== false;
        }
        return bgmEls[name];
    }
    function fadeTo(el, vol, ms, done) {
        clearInterval(el._fade);
        const from = el.volume;
        const t0 = Date.now();
        if (ms <= 0) {
            el.volume = vol;
            if (done) done();
            return;
        }
        el._fade = setInterval(() => {
            const k = Math.min(1, (Date.now() - t0) / ms);
            el.volume = clamp01(from + (vol - from) * k);
            if (k >= 1) {
                clearInterval(el._fade);
                if (done) done();
            }
        }, 40);
    }
    function stopCur() {
        if (!cur) return;
        const old = cur.el;
        cur = null;
        fadeTo(old, 0, AUDIO.fadeMs, () => {
            old.pause();
            old.currentTime = 0;
        });
    }
    // 流したい曲(want)と、今流れている曲(cur)を合わせる
    function apply() {
        if (!hasAudio || !unlocked) return;
        const name = want && want.find((n) => AUDIO.bgm[n] && !dead.has("bgm:" + n));
        if (!name || muted) {
            stopCur();
            return;
        }
        if (cur && cur.name === name) {
            cur.el.volume = bgmVol(name);
            if (cur.el.paused && !document.hidden) {
                const p = cur.el.play();
                if (p && p.catch) p.catch(() => {});
            }
            return;
        }
        stopCur();
        const el = bgmEl(name);
        el.volume = 0;
        el.currentTime = 0;
        cur = { name, el };
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
        fadeTo(el, bgmVol(name), AUDIO.fadeMs);
    }
    // names: 流したい曲の名前(優先順)。null / [] で無音
    function bgm(...names) {
        const list = names.filter(Boolean);
        const same =
            want && want.length === list.length && want.every((n, i) => n === list[i]);
        if (same) return;
        want = list.length ? list : null;
        apply();
    }

    // ---- ブラウザの自動再生制限: 最初の操作で解除する ----
    function unlock() {
        if (unlocked || !hasAudio) return;
        unlocked = true;
        // 効果音は先に読み込んでおく(押した瞬間に鳴らすため)
        Object.keys(AUDIO.se).forEach(seNode);
        apply(); // 操作前に流したかったBGMを流す
    }
    if (hasAudio) {
        ["pointerdown", "keydown", "touchend"].forEach((ev) =>
            window.addEventListener(ev, unlock, { passive: true }),
        );
        // タブを離れたらBGMを止める
        document.addEventListener("visibilitychange", () => {
            if (!cur) return;
            if (document.hidden) cur.el.pause();
            else apply();
        });
    }

    return {
        se,
        bgm,
        isMuted: () => muted,
        setMuted(v) {
            muted = !!v;
            save();
            apply();
        },
        toggleMute() {
            this.setMuted(!muted);
            return muted;
        },
        setVolume({ bgm: b, se: s } = {}) {
            if (typeof b === "number") AUDIO.bgmVolume = clamp01(b);
            if (typeof s === "number") AUDIO.seVolume = clamp01(s);
            save();
            apply();
        },
    };
})();
