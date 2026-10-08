/* 製造数の「飾り・選択肢の数」（2026-10-08・まりほ要望「ナンバークッキー1が何枚か分かる欄」）。
 * 予約時のスナップショット（グループ名・選択肢名・個数）を、ケーキの台数を掛けて足し上げる。
 * 選択肢にぶら下がる記入欄の答えが数字だけ（例：ナンバークッキーの「12」）なら、数字ごとの枚数にも分ける。
 * 質問と選択肢のつながりは common_questions.option_id（questionOptions：質問ID→{option_id,input_type}）。
 * つながりの無い答え（消えた質問・SELECTTYPEからの移行予約の「ナンバークッキーの数字」）は、
 * 質問文に選択肢名（かっこ書きを除いた名前でも可）が入っていて、その予約で当てはまる選択肢が1つだけのときに使う。
 * 日付・選択式など、記入欄（1行・複数行）以外の答えは数えない（カレンダーケーキの日付を数字と数えていた・2026-10-08）。 */
globalThis.OptionCounts = (() => {
  const digitsOnly = value => {
    const raw = String(value ?? "").normalize("NFKC").trim();
    if (/\d[-/.年月]\d/.test(raw)) return null; // 日付・時刻らしい答えは数えない
    const text = raw.replace(/[\s・,、]+/g, "");
    return /^[0-9]+$/.test(text) ? text.split("") : null;
  };
  // 「ナンバークッキー（大）」→「ナンバークッキー」。移行予約の質問文「ナンバークッキーの数字」に当てるため。
  const baseName = name => String(name || "").normalize("NFKC").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const TEXT_TYPES = new Set(["text", "textarea"]);
  function answerFor(order, op, questionOptions, orderOptions) {
    const answers = (order.order_answers || []).filter(a => (a.answer_text || "").trim());
    const linkedTo = a => a.question_id ? questionOptions.get(a.question_id) : null;
    if (op.option_id) {
      const linked = answers.filter(a => linkedTo(a)?.option_id === op.option_id);
      if (linked.length) return linked.filter(a => TEXT_TYPES.has(linkedTo(a).input_type));
    }
    const label = a => String(a.label_snapshot || "").normalize("NFKC");
    const free = answers.filter(a => !linkedTo(a));
    const exact = free.filter(a => op.option_name_snapshot && label(a).includes(String(op.option_name_snapshot).normalize("NFKC")));
    if (exact.length) return exact;
    const base = baseName(op.option_name_snapshot);
    if (!base) return [];
    // 同じ予約に「（大）」「（小）」の両方があると、どちらの数字か分からないので分けない。
    if (orderOptions.filter(o => baseName(o.option_name_snapshot) === base).length !== 1) return [];
    return free.filter(a => label(a).includes(base));
  }
  function build(orders, questionOptions = new Map()) {
    const groups = new Map();
    for (const order of orders) for (const item of order.order_items || []) {
      const cakes = Math.max(1, Number(item.quantity) || 1);
      for (const op of item.order_item_options || []) {
        const group = op.group_name_snapshot || "", name = op.option_name_snapshot || "";
        const each = Math.max(1, Number(op.quantity) || 1);
        if (!groups.has(group)) groups.set(group, new Map());
        const options = groups.get(group);
        if (!options.has(name)) options.set(name, {group, name, count: 0, digits: new Map(), mismatches: []});
        const row = options.get(name);
        row.count += each * cakes;
        // 数字の内訳は、答えが1つに決まり、数字だけのときに限る（文章の答えは数えない）。
        // 答えは予約ごとなので、同じ予約のほかのケーキの選択肢も含めて1つに決まるかを見る。
        const found = answerFor(order, op, questionOptions, (order.order_items || []).flatMap(i => i.order_item_options || []));
        const digits = found.length === 1 ? digitsOnly(found[0].answer_text) : null;
        if (!digits) continue;
        for (const d of digits) row.digits.set(d, (row.digits.get(d) || 0) + cakes);
        if (digits.length !== each) row.mismatches.push({order_number: order.order_number, quantity: each, answer: found[0].answer_text});
      }
    }
    return [...groups.values()].flatMap(options => [...options.values()]).map(row => ({
      ...row, digits: [...row.digits].sort(([a], [b]) => a.localeCompare(b)),
    }));
  }
  return {build, digitsOnly};
})();
