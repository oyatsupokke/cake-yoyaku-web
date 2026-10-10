/* ---------- 予約カレンダー（2026-10-05・まりほ決定「トップを予約カレンダーに」） ----------
 * ログインして最初に開く画面。月の各日に、受け取るケーキの台数・1日の上限・未確認の件数・休みを出し、
 * 日付を押すとその日の「予約・製造」を開く。読むだけの画面なのでDBの変更はなし。
 * 台数の数え方はサーバーの上限判定（fn_rule_usage）と同じ＝キャンセル以外の注文の数量の合計。
 * 上限は「1日の上限（全体）」（capacity_rules.scope='all'）だけを出す。商品ごとの上限は日付を押した先で見る。
 * 休みの判定は fn_is_business_day と同じ（臨時休業 > 定休日、ただし臨時営業の日は営業）。
 * admin.js の api / state / fmt / parseYmd / setDate / reviewPending を使う（admin.js の後に読み込む）。 */
(() => {
  const view = { month: null, generation: 0 };
  const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

  async function getAll(path) {
    const rows = [];
    for (;;) {
      const page = await api("GET", `${path}&limit=1000&offset=${rows.length}`);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }

  async function load() {
    const generation = ++view.generation, tenant = state.tenantId;
    const first = view.month, last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const from = fmt(first), to = fmt(last);
    paintHead();
    // 前の月のセルを残すと、読み込み中に押されて前の月の日付を開いてしまう
    $("order-calendar").innerHTML = "";
    $("cal-summary").textContent = "読み込み中…";
    const [orders, tenants, overrides, rules] = await Promise.all([
      getAll(`/rest/v1/orders?tenant_id=eq.${tenant}&pickup_date=gte.${from}&pickup_date=lte.${to}&status=neq.canceled` +
        `&select=id,pickup_date,status,review_state,order_items!order_items_order_id_fkey(quantity)&order=id`),
      api("GET", `/rest/v1/tenants?id=eq.${tenant}&select=closed_weekdays`),
      api("GET", `/rest/v1/date_overrides?tenant_id=eq.${tenant}&date=gte.${from}&date=lte.${to}&select=date,kind`),
      api("GET", `/rest/v1/capacity_rules?tenant_id=eq.${tenant}&scope=eq.all&is_active=eq.true&select=id,daily_limit`),
    ]);
    const ruleDays = rules.length ? await api("GET",
      `/rest/v1/capacity_rule_date_overrides?tenant_id=eq.${tenant}&rule_id=in.(${rules.map((r) => r.id).join(",")})` +
      `&date=gte.${from}&date=lte.${to}&select=rule_id,date,daily_limit`) : [];
    if (generation !== view.generation || tenant !== state.tenantId) return;

    const days = new Map();
    const day = (d) => days.get(d) || days.set(d, { cakes: 0, orders: 0, unconfirmed: 0 }).get(d);
    for (const o of orders) {
      const x = day(o.pickup_date);
      x.orders += 1;
      x.cakes += (o.order_items || []).reduce((n, i) => n + (i.quantity || 0), 0);
      if (o.status === "new" || reviewPending(o)) x.unconfirmed += 1;
    }
    const closedWeekdays = tenants[0]?.closed_weekdays || [];
    const overrideKind = new Map(overrides.map((o) => [o.date, o.kind]));
    const isClosed = (date) => {
      const kind = overrideKind.get(date);
      if (kind === "closed") return true;
      if (kind === "open") return false;
      return closedWeekdays.includes(parseYmd(date).getDay());
    };
    // 「全体」の上限が複数あるときは、いちばん厳しいものがその日の上限（サーバーの判定と同じ）
    const limitOf = (date) => {
      let min = null;
      for (const r of rules) {
        const o = ruleDays.find((x) => x.rule_id === r.id && x.date === date);
        const limit = o ? o.daily_limit : r.daily_limit;
        if (limit != null && (min == null || limit < min)) min = limit;
      }
      return min;
    };
    paintGrid(days, isClosed, limitOf);
    let cakes = 0, unconfirmed = 0;
    for (const x of days.values()) { cakes += x.cakes; unconfirmed += x.unconfirmed; }
    $("cal-summary").innerHTML = `${first.getMonth() + 1}月の受取：<strong>${cakes}台</strong>` +
      (unconfirmed ? `　<span class="oc-unconfirmed-total">未確認 ${unconfirmed}件</span>` : "");
    // 商品ごとの上限の合計が全商品の合計を超える日（limit-check.js）。読めなくてもカレンダーは出す
    const warn = $("cal-limit-warn");
    if (warn && window.LimitCheck) {
      warn.innerHTML = "";
      window.LimitCheck.load(api, tenant, from, to)
        .then((list) => { if (generation === view.generation) warn.innerHTML = window.LimitCheck.html(list, esc); })
        .catch(() => {});
    }
  }

  function paintHead() {
    const m = view.month;
    $("cal-title").textContent = `${m.getFullYear()}年${m.getMonth() + 1}月`;
  }

  function paintGrid(days, isClosed, limitOf) {
    const grid = $("order-calendar");
    const m = view.month, today = fmt(new Date());
    const cells = ["日", "月", "火", "水", "木", "金", "土"].map((w, i) =>
      `<div class="oc-wd${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${w}</div>`);
    for (let i = 0; i < m.getDay(); i++) cells.push(`<div class="oc-blank"></div>`);
    const lastDay = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    for (let n = 1; n <= lastDay; n++) {
      const d = new Date(m.getFullYear(), m.getMonth(), n), date = fmt(d);
      const x = days.get(date) || { cakes: 0, orders: 0, unconfirmed: 0 };
      const closed = isClosed(date), limit = closed ? null : limitOf(date);
      const full = limit != null && x.cakes >= limit;
      const cls = ["oc-day"];
      if (closed) cls.push("closed");
      if (full) cls.push("full");
      if (date === today) cls.push("today");
      if (date < today) cls.push("past");
      if (d.getDay() === 0) cls.push("sun"); else if (d.getDay() === 6) cls.push("sat");
      const count = limit != null ? `${x.cakes}<small>／${limit}台</small>`
        : x.cakes || !closed ? `${x.cakes}<small>台</small>` : "";   // 休みで予約の無い日だけ空ける
      const label = [`${m.getMonth() + 1}月${n}日`, closed ? "休み" : "",
        x.cakes ? `${x.cakes}台（${x.orders}件）` : "予約なし", limit != null ? `上限${limit}台` : "",
        full ? "満枠" : "", x.unconfirmed ? `未確認${x.unconfirmed}件` : ""].filter(Boolean).join("・");
      cells.push(`<button type="button" class="${cls.join(" ")}" data-date="${date}" aria-label="${label}">
        <span class="oc-num">${n}</span>
        ${closed ? `<span class="oc-tag">休</span>` : full ? `<span class="oc-tag oc-full">満</span>` : ""}
        <span class="oc-count${x.cakes ? "" : " zero"}">${count}</span>
        ${x.unconfirmed ? `<span class="oc-new"><span class="wide">未確認</span><span class="narrow">未</span>${x.unconfirmed}</span>` : ""}
      </button>`);
    }
    grid.innerHTML = cells.join("");
  }

  function show(month) {
    view.month = firstOfMonth(month);
    load().catch(() => toast("カレンダーを読み込めませんでした。通信状態を確認して、もう一度お試しください。"));
  }

  $("order-calendar").addEventListener("click", (e) => {
    const cell = e.target.closest(".oc-day");
    if (!cell) return;
    document.querySelector('.tab[data-tab="pickup"]')?.click();
    setDate(parseYmd(cell.dataset.date));
  });
  $("cal-prev").onclick = () => show(new Date(view.month.getFullYear(), view.month.getMonth() - 1, 1));
  $("cal-next").onclick = () => show(new Date(view.month.getFullYear(), view.month.getMonth() + 1, 1));
  $("cal-this-month").onclick = () => show(new Date());

  // 開くたびに読み直す（予約・製造で確認済にした分などを反映する）。見ていた月は保つ
  window.OrderCalendar = { open: () => show(view.month || new Date()) };
})();
