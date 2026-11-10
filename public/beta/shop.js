"use strict";
/* ============================================================================
 *  shop.js - 購入画面 (/beta)。ゲームの画面(canvas)の上に重ねる HTML の画面。
 *    ログイン / 新規登録 -> 商品(超理不尽モード) -> 「購入する」 -> Stripe の決済画面 -> 戻ってきて購入を確認 -> 再読み込み
 *
 *  遊べるかどうかを決めるのは、この画面ではなくサーバー（買った人にだけ ultra.js を配る）。
 *  この画面は「買う・ログインする」ための入口でしかないので、ここをいじっても無料では遊べない。
 *  決済の成否もブラウザの戻りURL(?purchase=success)では決めない。サーバーが Stripe の通知を受け取ったあとに
 *  /api/auth/me の owned に入るのを待って、はじめて「購入できました」と表示する。
 * ========================================================================== */
const Shop = (() => {
    const ITEM_ID = "ultra_mode";
    // 利用規約・プライバシーポリシー・特定商取引法に基づく表示のページができたら、ここに書く（表示される）。
    // 例: [{ label: "利用規約", href: "/legal/terms.html" }]
    const LEGAL_LINKS = [];

    const state = { me: null, items: [], busy: false, message: "", tab: "login", waiting: false };
    let overlay = null;

    async function api(method, path, body) {
        const res = await fetch(path, {
            method,
            credentials: "same-origin",
            headers: body ? { "Content-Type": "application/json" } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "エラー (" + res.status + ")");
        return data;
    }
    const owned = () => !!(state.me && state.me.owned.includes(ITEM_ID));
    async function refresh() {
        state.me = await api("GET", "/api/auth/me");
        state.items = (await api("GET", "/api/items")).items;
    }
    const yen = (n) => "¥" + n.toLocaleString("ja-JP");

    /* ---- DOM ---- */
    function el(tag, attrs = {}, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === "style") Object.assign(e.style, v);
            else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
            else e[k] = v;
        }
        for (const kid of kids) e.append(kid);
        return e;
    }
    const css = {
        overlay: { position: "fixed", inset: "0", background: "rgba(8,8,20,.88)", zIndex: "1000", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif", color: "#eef" },
        card: { background: "#1b1b2e", border: "2px solid #c4f", borderRadius: "10px", padding: "22px", width: "min(92vw, 380px)", maxHeight: "92vh", overflow: "auto", boxSizing: "border-box" },
        input: { width: "100%", boxSizing: "border-box", margin: "6px 0", padding: "10px", fontSize: "16px", background: "#10101c", color: "#fff", border: "1px solid #556", borderRadius: "6px" },
        button: { width: "100%", margin: "6px 0", padding: "12px", fontSize: "16px", fontWeight: "bold", border: "0", borderRadius: "6px", cursor: "pointer", background: "#c4f", color: "#101" },
        sub: { background: "#2a2a3c", color: "#fff", fontWeight: "normal" },
        note: { fontSize: "12px", color: "#aab", lineHeight: "1.6", margin: "8px 0" },
        error: { fontSize: "14px", color: "#f88", margin: "8px 0" },
    };
    const button = (label, onclick, sub = false) => el("button", { textContent: label, onclick, disabled: state.busy, style: { ...css.button, ...(sub ? css.sub : {}), opacity: state.busy ? ".6" : "1" } });

    function view() {
        const item = state.items.find((i) => i.id === ITEM_ID);
        const kids = [el("h2", { textContent: "超理不尽モード", style: { margin: "0 0 4px", color: "#d9a8ff" } })];
        if (item) kids.push(el("p", { textContent: item.description, style: css.note }));

        if (state.me && state.me.payments && state.me.payments.accounts === false) {
            // the server has nowhere to keep accounts (no database): a form would only fail
            kids.push(el("p", { textContent: "ただいまアカウントの登録・購入の準備中です。しばらくしてからもう一度お試しください。", style: { margin: "14px 0", color: "#fc8" } }));
        } else if (state.waiting) {
            kids.push(el("p", { textContent: "決済を確認しています…（最大1分ほどかかります）", style: { margin: "14px 0" } }));
        } else if (owned()) {
            kids.push(
                el("p", { textContent: "購入ありがとうございます。購入済みです。", style: { margin: "14px 0", color: "#8f8" } }),
                button("遊ぶ（ページを読み込み直す）", () => (location.href = location.pathname)),
            );
        } else if (!state.me || !state.me.user) {
            // not logged in
            const name = el("input", { type: "text", placeholder: "ユーザー名（3〜20文字）", autocomplete: "username", maxLength: 20, style: css.input });
            const pass = el("input", { type: "password", placeholder: "パスワード（8文字以上）", autocomplete: state.tab === "login" ? "current-password" : "new-password", maxLength: 128, style: css.input });
            const submit = () =>
                run(async () => {
                    await api("POST", "/api/auth/" + (state.tab === "login" ? "login" : "register"), { username: name.value.trim(), password: pass.value });
                    await refresh();
                });
            pass.addEventListener("keydown", (e) => e.key === "Enter" && submit());
            kids.push(
                el("p", { textContent: "購入するにはアカウントが必要です。", style: css.note }),
                el("div", { style: { display: "flex", gap: "8px" } }, button("ログイン", () => ((state.tab = "login"), render()), state.tab !== "login"), button("新規登録", () => ((state.tab = "register"), render()), state.tab !== "register")),
                name,
                pass,
                button(state.tab === "login" ? "ログイン" : "登録する", submit),
                el("p", { textContent: "※ メールアドレスは登録しません。パスワードを忘れると、アカウント（と購入記録）を復旧できません。", style: css.note }),
            );
        } else {
            const payable = state.me.payments.enabled && item;
            kids.push(
                el("p", { textContent: "ログイン中: " + state.me.user.name, style: css.note }),
                item ? el("p", { textContent: yen(item.priceJpy) + "（買い切り）", style: { fontSize: "26px", fontWeight: "bold", margin: "8px 0" } }) : el("p", { textContent: "商品を読み込めませんでした。", style: css.error }),
                payable ? button("購入する（Stripe の決済画面へ）", buy) : el("p", { textContent: "ただいま購入を受け付けていません。", style: css.error }),
                button("ログアウト", () => run(async () => (await api("POST", "/api/auth/logout"), await refresh())), true),
            );
        }
        if (state.message) kids.push(el("p", { textContent: state.message, style: css.error }));
        if (LEGAL_LINKS.length) kids.push(el("p", { style: css.note }, ...LEGAL_LINKS.flatMap((l) => [el("a", { href: l.href, target: "_blank", rel: "noopener", textContent: l.label, style: { color: "#9cf", marginRight: "12px" } })])));
        kids.push(button("閉じる", close, true));
        return el("div", { style: css.card }, ...kids);
    }
    function render() {
        if (!overlay) return;
        overlay.replaceChildren(view());
    }
    async function run(fn) {
        state.busy = true;
        state.message = "";
        render();
        try {
            await fn();
        } catch (err) {
            state.message = err.message;
        }
        state.busy = false;
        render();
    }
    async function buy() {
        await run(async () => {
            const { url } = await api("POST", "/api/payments/checkout", { itemId: ITEM_ID });
            location.href = url; // the payment page of Stripe (the price was decided by the server)
        });
    }

    /* ---- open / close ---- */
    async function open() {
        if (overlay) return;
        overlay = el("div", { style: css.overlay });
        // typing in the form must not move the game's menu (the game listens to keys on window)
        for (const t of ["keydown", "keyup", "keypress"]) overlay.addEventListener(t, (e) => e.stopPropagation());
        overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
        document.body.append(overlay);
        state.message = "";
        render();
        await run(refresh);
    }
    function close() {
        if (overlay) overlay.remove();
        overlay = null;
        state.waiting = false;
    }

    /* ---- coming back from Stripe: ?purchase=success | cancel ----
     *  The URL only says that the customer came back. The item is theirs when the server has got Stripe's notice. */
    async function afterCheckout() {
        const result = new URLSearchParams(location.search).get("purchase");
        if (!result) return;
        history.replaceState(null, "", location.pathname); // do not run this again on a reload
        await open();
        if (result === "cancel") {
            state.message = "購入をキャンセルしました。";
            return render();
        }
        state.waiting = true;
        render();
        for (let i = 0; i < 30 && !owned() && overlay; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
                await refresh();
            } catch {
                /* try again */
            }
        }
        state.waiting = false;
        if (!owned()) state.message = "まだ確認できていません。しばらくしてから、もう一度開いてください（支払いは確認でき次第、反映されます）。";
        render();
    }
    if (typeof window !== "undefined" && typeof document !== "undefined" && document.addEventListener)
        document.addEventListener("DOMContentLoaded", () => afterCheckout().catch(() => {}));

    return { open, close, owned, refresh, ITEM_ID };
})();
