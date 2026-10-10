/* 製造数の「内訳」（2026-10-10 まりほ要望「12cmで シャインマスカット1台・ナガノパープル1台・ミックス1台 のように分かると助かる」
 * 「お店によって知りたい情報が違うので、表示の仕方も設定できるように」）。
 * 店が選んだ選択グループ・質問（名前で持つ＝商品ごとに作った同じ名前のグループもまとめて数える）で、商品×サイズの台数を分ける。
 *   combine=true ：選んだグループを組み合わせて1行に（例「シャインマスカット × フルーツ1周」）
 *   combine=false：グループごとに別々に数える（例「フルーツ：シャインマスカット」「飾り方：フルーツ1周」）
 * 同じグループで2つ以上選んだケーキは「・」でつなぐ。選んだグループが1つも無いケーキは内訳に出さない（台数の行はそのまま）。
 * 数はケーキの台数（選択肢の個数ではない）。設定は tenants.kitchen_breakdown（{groups:[名前], combine:bool}）。 */
globalThis.KitchenBreakdown = (() => {
  const norm = (s) => String(s ?? "").normalize("NFKC").trim();
  function normalizeSetting(raw) {
    const groups = Array.isArray(raw?.groups) ? [...new Set(raw.groups.map(norm).filter(Boolean))] : [];
    return {groups, combine: raw?.combine !== false};
  }
  // 見出し用の短い名前（「フルーツをお選びください」→「フルーツ」）
  const shortName = (name) => name.replace(/を?(お選び|選んで)ください[。．]?$/, "").trim() || name;
  // 戻り値：Map「商品名｜サイズ」→ [{label, count}]（多い順・同数は名前順）
  // 項目は「選択グループの名前」か「質問の文」（2026-10-10：旧フォームからの予約とジェンダーリビールは果物が質問の回答に入っていた）。
  // 質問の回答は予約ごとなので、その予約のケーキ全部に当てる。
  function build(orders, setting) {
    const {groups, combine} = normalizeSetting(setting);
    const out = new Map();
    if (!groups.length) return out;
    for (const order of orders) {
      const answers = new Map(groups.map((g) => [g, []]));
      for (const a of order.order_answers || []) {
        const vals = answers.get(norm(a.label_snapshot));
        const v = norm(a.choice_label_snapshot || a.answer_text).replace(/\s*\n\s*/g, " ");
        if (vals && v && !vals.includes(v)) vals.push(v);
      }
      for (const item of order.order_items || []) {
        const key = `${item.product_name_snapshot}｜${item.variant_label_snapshot || ""}`;
        const cakes = Math.max(1, Number(item.quantity) || 1);
        const picked = new Map(groups.map((g) => [g, [...answers.get(g)]]));
        for (const op of item.order_item_options || []) {
          const names = picked.get(norm(op.group_name_snapshot));
          const name = norm(op.option_name_snapshot);
          if (names && name && !names.includes(name)) names.push(name);
        }
        const parts = groups.filter((g) => picked.get(g).length).map((g) => ({name: shortName(g), value: picked.get(g).join("・")}));
        if (!parts.length) continue;
        // 1つの項目だけなら値だけ（「シャインマスカット」）。2つ以上あるときは何の値か分かるように名前を付ける
        const labels = parts.length === 1 ? [parts[0].value]
          : combine ? [parts.map((p) => `${p.name}：${p.value}`).join(" × ")]
          : parts.map((p) => `${p.name}：${p.value}`);
        if (!out.has(key)) out.set(key, new Map());
        const rows = out.get(key);
        for (const label of labels) rows.set(label, (rows.get(label) || 0) + cakes);
      }
    }
    const sorted = new Map();
    for (const [key, rows] of out) {
      sorted.set(key, [...rows].map(([label, count]) => ({label, count}))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja")));
    }
    return sorted;
  }
  return {build, normalizeSetting};
})();
