/* Shared ordering and visibility rules for the editor and reservation form. */
(function (root) {
  const groupApplies = (g, productId) => g.product_id ? g.product_id === productId
    : !g.target_product_ids || g.target_product_ids.includes(productId);
  const questionApplies = (q, productId) => q.scope !== 'selected'
    || (q._product_ids || (q.common_question_products || []).map(x => x.product_id)).includes(productId);
  // 表示条件。選択グループの選択肢（condition_option_ids）か、ほかの質問の回答（condition_choice_ids・2026-10-02）。
  // 2026-10-03〜複数指定できる＝どれか1つでも選ばれたら「選んだ」。配列の列が無い（DB反映前・古いデータ）ときだけ1つの列を見る
  // （DBが配列と1つの列を常に揃えるので、配列があれば配列が正。管理画面で全部外した下書きは空のまま扱う）
  const idsOf = (many, one) => Array.isArray(many) ? many : one ? [one] : [];
  const conditionOptionIds = (item) => idsOf(item.condition_option_ids, item.condition_option_id);
  const conditionChoiceIds = (item) => idsOf(item.condition_choice_ids, item.condition_choice_id);
  const choicePicked = (answers, choiceId) => !!answers && [...answers.values()]
    .some(a => Array.isArray(a?.choiceIds) && a.choiceIds.includes(choiceId));
  const conditionMatches = (item, selected, answers) => {
    if (!item.condition_mode || item.condition_mode === 'always') return true;
    const choices = conditionChoiceIds(item);
    const hit = choices.length ? choices.some(id => choicePicked(answers, id))
      : conditionOptionIds(item).some(id => selected.has(id));
    return item.condition_mode === 'selected' ? hit : !hit;
  };
  function ordered(product, groups, questions) {
    const old = new Map((product.group_order || []).map((id, i) => [id, i]));
    const base = [...groups].filter(g => groupApplies(g, product.id)).sort((a, b) =>
      (old.get(a.id) ?? Infinity) - (old.get(b.id) ?? Infinity)
      || (a.display_order || 0) - (b.display_order || 0) || Number(a.product_id === null) - Number(b.product_id === null)
      || a.id.localeCompare(b.id)).map(data => ({kind:'group', key:`group:${data.id}`, data}));
    base.push(...questions.filter(q => !q.option_id && questionApplies(q, product.id))
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0) || a.id.localeCompare(b.id))
      .map(data => ({kind:'question', key:`question:${data.id}`, data})));
    const positions = new Map((product.question_order || []).map((key, i) => [key, i]));
    return base.sort((a, b) => (positions.get(a.key) ?? Infinity) - (positions.get(b.key) ?? Infinity));
  }
  // Remove hidden selections before price, required checks and payload creation. Repeat for chained conditions.
  function prune(product, groups, questions, options, answers) {
    for (let i = 0; i <= groups.length; i++) {
      let changed = false;
      for (const g of groups) if (!groupApplies(g, product.id) || !conditionMatches(g, options)) {
        for (const o of g.options || []) if (options.delete(o.id)) changed = true;
      }
      if (!changed) break;
    }
    // 回答を消すと、その回答を条件にしていた質問も消える。変わらなくなるまで繰り返す
    for (let i = 0; i <= questions.length; i++) {
      let changed = false;
      for (const q of questions) if ((q.is_active === false || !questionApplies(q, product.id) || !conditionMatches(q, options, answers)
        || (q.option_id && !options.has(q.option_id))) && answers.delete(q.id)) changed = true;
      if (!changed) break;
    }
  }
  root.QuestionFlow = {groupApplies, questionApplies, conditionMatches, conditionOptionIds, conditionChoiceIds, ordered, prune};
  if (typeof module !== 'undefined') module.exports = root.QuestionFlow;
})(globalThis);
