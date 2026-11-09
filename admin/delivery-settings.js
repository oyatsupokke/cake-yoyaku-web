/* =====================================================================
 * 設定タブ「カード払い（Stripe）」と「配送」（2026-10-05・2026-11-09 に2つの欄へ分けた）
 *   設計＝kaihatsu/haisou-card-sekkei-2026-10-05.md
 * - 店のStripe口座をつなぐ（stripe-connect・オーナーだけ）・店頭受取のお支払い
 *   （店頭払いのみ／お客様が選ぶ＝stripe_prepay_enabled／カード払いのみ＝card_required・2026-11-09）
 * - 配送の設定は tenants.delivery_settings（jsonb 1列）。保存は画面下の保存バー（admin.js の regField）
 *   形：{enabled, regions:{地域:{on,fee,days}}, free_over, time_windows[], note}
 *   on＝配送する（送料必須・0円＝送料無料）、days＝届くまでの日数＝お届け日の何日前に発送するか
 * - 地域の区分と都道府県はDBの fn_delivery_regions() と同じ（予約ページ app.js の DELIVERY_REGIONS も）
 * ===================================================================== */
(() => {
  const el = (id) => document.getElementById(id);
  const REGIONS = [
    // [キー, 地域, 都道府県, 届くまでの日数の既定]（DBの fn_delivery_regions と同じ）
    ["hokkaido", "北海道", "北海道", 2], ["kita_tohoku", "北東北", "青森・秋田・岩手", 1],
    ["minami_tohoku", "南東北", "宮城・山形・福島", 1], ["kanto", "関東", "茨城・栃木・群馬・埼玉・千葉・東京・神奈川・山梨", 1],
    ["shinetsu", "信越", "新潟・長野", 1], ["hokuriku", "北陸", "富山・石川・福井", 1],
    ["chubu", "中部", "静岡・愛知・三重・岐阜", 1], ["kansai", "関西", "大阪・京都・滋賀・奈良・和歌山・兵庫", 1],
    ["chugoku", "中国", "岡山・広島・山口・鳥取・島根", 1], ["shikoku", "四国", "香川・徳島・愛媛・高知", 1],
    ["kyushu", "九州", "福岡・佐賀・長崎・熊本・大分・宮崎・鹿児島", 1], ["okinawa", "沖縄", "沖縄", 2],
  ];
  const WINDOWS = ["指定なし", "午前中", "14〜16時", "16〜18時", "18〜20時", "19〜21時"];
  let tenant = null;
  const dirty = () => { if (typeof markDirty === "function") markDirty(); };
  const intOrNull = (v) => { const n = parseInt(String(v).trim(), 10); return Number.isFinite(n) && n >= 0 ? n : null; };

  function paintStripe() {
    const st = el("dl-stripe-status");
    const ready = !!tenant?.stripe_charges_enabled;
    st.textContent = ready ? "✓ つながっています。お客様にカードで払ってもらえます。"
      : tenant?.stripe_account_id ? "登録の途中です。「Stripeをつなぐ」から続きを入力してください（入力が終わると数分で使えるようになります）。"
      : "まだつながっていません。";
    st.classList.toggle("ok", ready);
    el("dl-stripe-connect").textContent = ready ? "Stripeの登録内容を確認する" : tenant?.stripe_account_id ? "Stripeの登録を続ける" : "Stripeをつなぐ";
    // 配送の欄：つながるまでは「先にカード払いでStripeをつなぐ」の案内。カード払いの欄：事前払いにチェックしたのに未接続なら注意
    el("dl-not-ready").classList.toggle("hidden", ready);
    el("dl-prepay-not-ready").classList.toggle("hidden", ready || window.payModeValue() === "store");
  }

  /* 店頭受取のお支払い（3択）。保存は admin.js が2つの列（stripe_prepay_enabled・card_required）に分けて登録する */
  const PAY_HELP = {
    store: "お客様には店頭でのお支払いだけをご案内します。",
    optional: "予約は今までどおりすぐ成立し、払いたいお客様だけが予約のあとカードで払います（受取日の前日まで）。払わなければ店頭払いのまま。お客様が期限内に自分でキャンセルしたときは自動で全額返金されます。",
    required: "お客様はご予約のあと、そのままカードで払います。払うとご予約が確定し、確認メールが届きます。30分以内に払われなければ自動で取り消されます（その間は枠を押さえます）。" +
      "お客様ご自身での内容の変更はできなくなります（受取日時の変更と、期限内のキャンセル＝自動で全額返金はできます）。追加希望（お見積もり）は、承諾のあとお客様が確認ページから払います。予約の直接登録は店頭払いのままです。",
  };
  window.payModeValue = () => document.querySelector('input[name="dl-paymode"]:checked')?.value || "store";
  function paintPayMode() {
    el("dl-prepay-help").textContent = tenant?.square_prepay_enabled
      ? "このお店は Square で事前のカード払いを受け付けています（こちらの設定は使いません）。"
      : PAY_HELP[window.payModeValue()];
    paintStripe();
  }
  el("dl-paymode").addEventListener("change", paintPayMode);

  /** 「配送する」を外した行は送料・日数を灰色にして触れないようにする（値は残す＝付け直したら戻る） */
  function paintRow(tr) {
    if (!tr) return;
    const on = tr.querySelector("[data-on]").checked;
    tr.classList.toggle("dl-off", !on);
    for (const x of tr.querySelectorAll("[data-fee], [data-days]")) x.disabled = !on;
  }

  el("dl-all-on").onclick = () => {
    for (const tr of el("dl-fee-rows").querySelectorAll("tr")) { tr.querySelector("[data-on]").checked = true; paintRow(tr); }
    dirty();
  };

  /** 保存の前の確認（admin.js の saveAll）。「配送する」なのに送料が空欄の地域があれば止める */
  window.deliverySettingsProblem = () => {
    if (!tenant || tenant.reservation_plan === "lite") return null;
    for (const [key, label] of REGIONS) {
      const on = el("dl-fee-rows").querySelector(`[data-on="${key}"]`);
      const fee = el("dl-fee-rows").querySelector(`[data-fee="${key}"]`);
      if (on?.checked && intOrNull(fee.value) == null) return { input: fee, message: `配送の「${label}」の送料を入れてください（送料無料なら 0）` };
    }
    return null;
  };

  async function connect(action) {
    const send = () => fetch(`${CONFIG.url}/functions/v1/stripe-connect`, {
      method: "POST",
      headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session?.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    let r = await send();
    if (r.status === 401 && typeof refreshSession === "function" && await refreshSession()) r = await send();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Stripeとの接続でエラーが起きました");
    return j;
  }

  async function refresh() {
    const b = el("dl-stripe-refresh");
    b.disabled = true;
    try {
      const j = await connect("refresh");
      tenant.stripe_charges_enabled = !!j.charges_enabled;
      if (!j.connected) tenant.stripe_account_id = null;
      paintStripe();
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  }

  el("dl-stripe-connect").onclick = async () => {
    const b = el("dl-stripe-connect");
    if (state.dirty && !confirm("保存していない変更があります。Stripeの画面に移る前に、下の「保存する」で保存してください。\nこのまま移りますか？")) return;
    b.disabled = true;
    try {
      const j = await connect("link");
      location.href = j.url;
    } catch (e) { toast(e.message); b.disabled = false; }
  };
  el("dl-stripe-refresh").onclick = refresh;

  /** 設定タブを開くたび（admin.js の loadTenantForm）に呼ばれる。regField より先に欄を埋める */
  window.initDeliverySettings = (t) => {
    tenant = t;
    // カード払い・配送は Standard の機能（2026-10-05）。Lite では見出しと案内だけ出す（LINE連携と同じ形）
    const lite = t.reservation_plan === "lite";
    for (const [id, what] of [["settings-card", "事前のカード払い"], ["settings-delivery", "配送"]]) {
      const card = el(id);
      card.querySelector(".dl-lite-note")?.remove();
      Array.from(card.children).forEach((x, i) => { x.style.display = lite && i >= 2 ? "none" : ""; });
      if (lite) {
        const p = document.createElement("p");
        p.className = "small dl-lite-note";
        p.textContent = `${what}はStandardプランの機能です。「ご契約・お支払い」からStandardへ切り替えると使えます。`;
        card.appendChild(p);
      }
    }
    const s = t.delivery_settings || {};
    el("dl-enabled").checked = !!s.enabled;
    // 店頭受取の事前カード払い（任意）。Square で事前払いを受けている店（pokke）は Square のまま（2026-10-05 まりほ）
    // Square で事前払いを受けている店（pokke）は Square のまま（2026-10-05 まりほ）
    const mode = t.card_required && t.stripe_prepay_enabled ? "required" : t.stripe_prepay_enabled ? "optional" : "store";
    for (const r of document.querySelectorAll('input[name="dl-paymode"]')) {
      r.checked = r.value === mode;
      r.disabled = !!t.square_prepay_enabled;
    }
    paintPayMode();
    el("dl-free").value = s.free_over ?? "";
    el("dl-note").value = s.note || "";
    const rows = el("dl-fee-rows");
    rows.innerHTML = "";
    for (const [key, label, prefs, days] of REGIONS) {
      const r = s.regions?.[key] || {};
      // 開発中の古い形（on なし＝送料があれば配送・何日前＋追加の日数）も読む（DBの fn_delivery_region_rule と同じ）
      const on = "on" in r ? !!r.on : r.fee != null;
      const d = r.days ?? (s.lead_days != null || r.extra_days != null ? (s.lead_days ?? 1) + (r.extra_days ?? days - 1) : days);
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><input type="checkbox" data-on="${key}" aria-label="${label}へ配送する"></td>
        <th scope="row"><span class="dl-region">${label}</span><span class="dl-prefs">${prefs}</span></th>
        <td><input type="number" min="0" max="100000" step="1" inputmode="numeric" data-fee="${key}" aria-label="${label}の送料"> 円</td>
        <td><input type="number" min="0" max="7" step="1" inputmode="numeric" data-days="${key}" aria-label="${label}へ届くまでの日数" style="width:60px"> 日</td>`;
      tr.querySelector("[data-on]").checked = on;
      tr.querySelector("[data-fee]").value = r.fee ?? "";
      tr.querySelector("[data-days]").value = d;
      rows.appendChild(tr);
      paintRow(tr);
    }
    const chosen = new Set(s.time_windows?.length ? s.time_windows : ["指定なし"]);
    el("dl-windows").innerHTML = WINDOWS.map((w) =>
      `<label class="cf-check"><input type="checkbox" value="${w}" ${chosen.has(w) ? "checked" : ""}>${w}</label>`).join("");
    for (const id of ["settings-card", "settings-delivery"]) {
      for (const input of el(id).querySelectorAll("input:not([type=checkbox]), textarea"))
        input.oninput = dirty;
      for (const input of el(id).querySelectorAll("input[type=checkbox]"))
        input.onchange = () => { paintRow(input.closest("#dl-fee-rows tr")); dirty(); paintStripe(); };
    }
    paintStripe();
    // Stripeの登録画面から戻ってきた（?stripe=return / refresh）：状態を取り直して配送の欄へ
    const q = new URLSearchParams(location.search);
    // 商品の設定のリンク（./#settings-delivery・./#settings-card）から来たとき
    const jump = { "#settings-delivery": "settings-delivery", "#settings-card": "settings-card" }[location.hash];
    if (!q.get("stripe") && jump && !window._deliveryJumped) {
      window._deliveryJumped = true;
      document.querySelector('.tab[data-tab="settings"]')?.click();
      setTimeout(() => el(jump).scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    }
    // Stripeの登録画面から戻ってきた（?stripe=return / refresh）：状態を取り直してカード払いの欄へ
    if (q.get("stripe")) {
      q.delete("stripe");
      history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : "") + "#settings-card");
      document.querySelector('.tab[data-tab="settings"]')?.click();
      setTimeout(() => el("settings-card").scrollIntoView({ behavior: "smooth", block: "start" }), 300);
      refresh();
    }
  };

  /** 保存する値（admin.js の regField が使う） */
  window.deliverySettingsValue = () => {
    if (!tenant) return null;
    const regions = {};
    for (const [key, , , days] of REGIONS) {
      const q = (a) => el("dl-fee-rows").querySelector(`[data-${a}="${key}"]`);
      const on = q("on").checked;
      const fee = intOrNull(q("fee").value);
      regions[key] = { on, fee, days: Math.min(intOrNull(q("days").value) ?? days, 7) };   // 送料なしの「配送する」は保存前に止める（deliverySettingsProblem）
    }
    const windows = [...el("dl-windows").querySelectorAll("input:checked")].map((x) => x.value);
    return {
      enabled: el("dl-enabled").checked,
      regions,
      free_over: intOrNull(el("dl-free").value),
      time_windows: windows.length ? windows : ["指定なし"],
      note: el("dl-note").value.trim() || null,
    };
  };
})();
