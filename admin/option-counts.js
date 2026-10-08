/* 製造数の「飾り・選択肢の数」（2026-10-08・まりほ要望「ナンバークッキー1が何枚か分かる欄」）。
 * 予約時のスナップショット（グループ名・選択肢名・個数）を、ケーキの台数を掛けて足し上げる。
 * 選択肢にぶら下がる質問の答えが数字だけ（例：ナンバークッキーの「12」）なら、数字ごとの枚数にも分ける。
 * 質問と選択肢のつながりは common_questions.option_id（questionOptions）。消えた質問は、質問文に選択肢名が入っているときだけ使う。 */
globalThis.OptionCounts = (() => {
  const digitsOnly = value => {
    const text = String(value ?? "").normalize("NFKC").replace(/[\s・,、，/／\-ー－]+/g, "");
    return /^[0-9]+$/.test(text) ? text.split("") : null;
  };
  function answerFor(order, op, questionOptions) {
    const answers = (order.order_answers || []).filter(a => (a.answer_text || "").trim());
    if (op.option_id) {
      const linked = answers.filter(a => a.question_id && questionOptions.get(a.question_id) === op.option_id);
      if (linked.length) return linked;
    }
    return answers.filter(a => !(a.question_id && questionOptions.has(a.question_id))
      && op.option_name_snapshot && (a.label_snapshot || "").includes(op.option_name_snapshot));
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
        const found = answerFor(order, op, questionOptions);
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
