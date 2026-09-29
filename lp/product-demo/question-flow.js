/* Shared ordering and visibility rules for the editor and reservation form. */
(function (root) {
  const groupApplies = (g, productId) => g.product_id ? g.product_id === productId
    : !g.target_product_ids || g.target_product_ids.includes(productId);
  const questionApplies = (q, productId) => q.scope !== 'selected'
    || (q._product_ids || (q.common_question_products || []).map(x => x.product_id)).includes(productId);
  const conditionMatches = (item, selected) => !item.condition_mode || item.condition_mode === 'always'
    || (item.condition_mode === 'selected' ? selected.has(item.condition_option_id) : !selected.has(item.condition_option_id));
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
    for (const q of questions) if (q.is_active === false || !questionApplies(q, product.id) || !conditionMatches(q, options)
      || (q.option_id && !options.has(q.option_id))) answers.delete(q.id);
  }
  root.QuestionFlow = {groupApplies, questionApplies, conditionMatches, ordered, prune};
  if (typeof module !== 'undefined') module.exports = root.QuestionFlow;
})(globalThis);
