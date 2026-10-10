/* ---------- 上限の食い違いの注意（2026-10-10 まりほ「全商品の合計を、商品それぞれの合計が超えちゃったらどうなるの？」） ----------
 * 予約は「全商品の合計（1日の上限）」「商品ごとの上限」のどれかに達した時点で止まる（サーバーの判定）。
 * 商品ごとの上限を足すと全商品の合計を超える日は、全商品の合計で先に止まる＝商品ごとの台数まで受けられない。
 * 設定の間違いに気づけるよう、その日を挙げて注意を出す（読むだけ・DB変更なし）。
 * 数え方：その日の上限＝日ごとの上書きがあればそれ、無ければ普段の上限（fn_rule_limit と同じ）。
 *         全商品の合計は「全体」の上限のうちいちばん厳しいもの。商品は 公開中・削除されていない・その日が受取期間内 のものだけ。
 *         上限なし（空欄）の商品は足さない。休みの日と、全商品の合計が0台（その日は受けない）の日は出さない。
 *   LimitCheck.load(api, tenantId, from, to) → [{from, to, days, total, sum, items:[{name, limit}]}]（続いた同じ内容の日はまとめる）
 *   LimitCheck.html(list, esc) → 注意の文（無ければ ""） */
(() => {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const next = (s) => { const d = parse(s); d.setDate(d.getDate() + 1); return ymd(d); };
  const md = (s) => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };

  async function load(api, tenantId, from, to) {
    const t = `tenant_id=eq.${tenantId}`;
    const [rules, links, products, tenants, closed] = await Promise.all([
      api("GET", `/rest/v1/capacity_rules?${t}&is_active=eq.true&scope=in.(all,products)&select=id,name,scope,daily_limit`),
      api("GET", `/rest/v1/capacity_rule_products?${t}&select=rule_id,product_id`),
      api("GET", `/rest/v1/products?${t}&deleted_at=is.null&is_published=eq.true&select=id,name,pickup_start_date,pickup_end_date`),
      api("GET", `/rest/v1/tenants?id=eq.${tenantId}&select=closed_weekdays`),
      api("GET", `/rest/v1/date_overrides?${t}&date=gte.${from}&date=lte.${to}&select=date,kind`),
    ]);
    const all = rules.filter((r) => r.scope === "all");
    if (!all.length) return [];   // 全商品の合計が無ければ食い違いは起きない
    const ids = rules.map((r) => r.id);
    const overrides = [];
    if (ids.length) for (;;) {  // 1年分を数える＝行数の上限を超えうるので、空のページまで取る
      const page = await api("GET",
        `/rest/v1/capacity_rule_date_overrides?${t}&rule_id=in.(${ids.join(",")})&date=gte.${from}&date=lte.${to}&select=rule_id,date,daily_limit&order=date,id&limit=1000&offset=${overrides.length}`);
      overrides.push(...page);
      if (page.length < 1000) break;
    }
    const ov = new Map(overrides.map((o) => [o.rule_id + "|" + o.date, o.daily_limit]));
    const limitOn = (r, date) => (ov.has(r.id + "|" + date) ? ov.get(r.id + "|" + date) : r.daily_limit);
    const productById = new Map(products.map((p) => [p.id, p]));
    const productRules = rules.filter((r) => r.scope === "products").map((r) => ({
      ...r, products: links.filter((l) => l.rule_id === r.id).map((l) => productById.get(l.product_id)).filter(Boolean),
    })).filter((r) => r.products.length);
    const closedWeekdays = tenants[0]?.closed_weekdays || [];
    const kind = new Map(closed.map((o) => [o.date, o.kind]));
    const isClosed = (date) => kind.get(date) === "closed" || (kind.get(date) !== "open" && closedWeekdays.includes(parse(date).getDay()));
    const inPeriod = (p, date) => (!p.pickup_start_date || date >= p.pickup_start_date) && (!p.pickup_end_date || date <= p.pickup_end_date);

    const found = [];
    for (let date = from; date <= to; date = next(date)) {
      if (isClosed(date)) continue;
      let total = null;
      for (const r of all) { const l = limitOn(r, date); if (l != null && (total == null || l < total)) total = l; }
      if (total == null || total === 0) continue;  // 0台＝その日はわざと止めている。食い違いではない
      const items = [];
      for (const r of productRules) {
        const l = limitOn(r, date);
        const live = r.products.filter((p) => inPeriod(p, date));  // その日に受け取れる商品だけで名前・IDを作る
        if (l == null || !live.length) continue;
        items.push({ name: live.map((p) => p.name).join("・") || r.name, ids: live.map((p) => p.id), limit: l });
      }
      const sum = items.reduce((n, x) => n + x.limit, 0);
      if (sum > total) found.push({ date, total, sum, items });
    }
    // 続いた日で同じ内容のものは1行に
    const list = [];
    for (const f of found) {
      const key = JSON.stringify([f.total, f.items.map((i) => [i.ids, i.limit])]);  // 同じ名前の別商品をまとめない
      const last = list[list.length - 1];
      if (last && last.key === key && next(last.to) === f.date) { last.to = f.date; last.days += 1; }
      else list.push({ key, from: f.date, to: f.date, days: 1, total: f.total, sum: f.sum, items: f.items });
    }
    return list;
  }

  function html(list, esc) {
    if (!list.length) return "";
    const rows = list.slice(0, 6).map((x) => {
      const when = x.from === x.to ? md(x.from) : `${md(x.from)}〜${md(x.to)}（${x.days}日）`;
      const detail = x.items.map((i) => `${esc(i.name)} ${i.limit}`).join("・");
      return `<li><strong>${when}</strong>：商品ごとの上限の合計 ${x.sum}台（${detail}）が、1日の上限（全商品の合計）${x.total}台を超えています。` +
        `<br>${x.total}台に達した時点で、どの商品も受付が止まります。</li>`;
    }).join("");
    const more = list.length > 6 ? `<li>…ほか${list.length - 6}件</li>` : "";
    return `<div class="limit-warn" role="note"><p>⚠️ 上限の設定を確かめてください</p><ul>${rows}${more}</ul>` +
      `<p class="small">商品ごとの台数まで受けたいときは、その日の「1日の上限（全商品の合計）」を増やすか空欄に。全体で止めたいなら、このままで大丈夫です。</p></div>`;
  }

  window.LimitCheck = { load, html };
})();
