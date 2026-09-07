/* 表示とCSVは同じ行・同じ集計を使う。予約時のスナップショットが正本。 */
globalThis.BookingReport = (() => {
  const norm = value => String(value ?? "").normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  const productKey = item => JSON.stringify([item.product_id, item.product_name_snapshot || ""]);
  const answers = order => (order.order_answers || []).map(a =>
    `${a.label_snapshot || ""}: ${a.answer_text || a.choice_label_snapshot || ""}`).join("\n");
  const options = item => (item.order_item_options || []).map(o =>
    `${o.group_name_snapshot || ""}: ${o.option_name_snapshot || ""} ×${o.quantity ?? 1}${o.option_text ? `「${o.option_text}」` : ""}`).join("\n");
  function rows(orders, filters = {}) {
    const query = norm(filters.query).trim();
    return orders.flatMap(order => (order.order_items || []).map(item => ({order, item})))
      .filter(({order, item}) => {
        const status = filters.status || "active";
        const shownStatus = ['in_production', 'completed'].includes(order.status) ? 'confirmed' : order.status;
        return (status === "all" || (status === "active" ? order.status !== "canceled" : shownStatus === status)) &&
          (!filters.product || productKey(item) === filters.product) &&
          (!filters.size || item.variant_label_snapshot === filters.size) &&
          (!query || norm([item.product_name_snapshot, item.variant_label_snapshot, options(item), answers(order)].join("\n")).includes(query));
      }).sort((a, b) => {
        const time = o => (o.pickup_slot_label || "").replace(/\d+/g, n => n.padStart(3, "0"));
        return String(a.order.pickup_date).localeCompare(String(b.order.pickup_date)) ||
          time(a.order).localeCompare(time(b.order)) || Number(a.order.order_number) - Number(b.order.order_number) ||
          String(a.item.id).localeCompare(String(b.item.id));
      });
  }
  function summary(rows) {
    const groups = new Map();
    for (const {order, item} of rows) {
      if (order.status === "canceled") continue;
      const key = JSON.stringify([order.pickup_date, item.product_id, item.variant_id, item.product_name_snapshot, item.variant_label_snapshot]);
      if (!groups.has(key)) groups.set(key, {date: order.pickup_date, product: item.product_name_snapshot || "", size: item.variant_label_snapshot || "", quantity: 0});
      groups.get(key).quantity += Number(item.quantity || 0);
    }
    return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.product.localeCompare(b.product, "ja") || a.size.localeCompare(b.size, "ja", {numeric:true}));
  }
  // Excelで開けるUTF-8 BOM。顧客入力を数式として実行させない。
  function csv(table) {
    return "\uFEFF" + table.map(row => row.map(value => {
      let s = String(value ?? "");
      if (/^[\s\u0000-\u001f]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    }).join(",")).join("\r\n") + "\r\n";
  }
  async function fetchOrders(get, tenant, from, to) {
    const orders = [];
    // 応答の件数がサーバーの上限で切られても、空ページまで読み進める。
    for (;;) {
      const page = await get(`/rest/v1/orders?tenant_id=eq.${encodeURIComponent(tenant)}` +
        `&pickup_date=gte.${from}&pickup_date=lte.${to}&order=pickup_date.asc,id.asc` +
        `&select=id,order_number,pickup_date,pickup_slot_label,status,customer_name,customer_phone,order_items(*,order_item_options(*)),order_answers(*)&limit=500&offset=${orders.length}`);
      if (!Array.isArray(page)) throw new Error("予約データを取得できませんでした");
      if (!page.length) return orders;
      orders.push(...page);
    }
  }
  return {norm, productKey, answers, options, rows, summary, csv, fetchOrders};
})();
