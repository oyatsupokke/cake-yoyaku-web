/* お試し中（有料契約の前）のプランの選び直し（2026-10-26）。処理は Edge Function `trial-plan`。
   「ご契約状況」の中に2つのプランを並べ、いま選んでいる方に印を付ける。 */
globalThis.TrialPlan = (() => {
  const el = id => document.getElementById(id);
  let tenant = null, busy = false, generation = 0;
  const NAMES = { lite: 'Lite（月額1,980円）', standard: 'Standard（月額4,980円）' };
  const CONFIRM = {
    lite: 'Liteにしますか？\n\n・予約は月30台・30日先までになります\n・商品ごとの締切は、予約設定の「締切」にそろいます\n・LINE通知は止まります\n\n有料契約の前なので料金はかかりません。あとからStandardに戻せます。',
    standard: 'Standardにしますか？\n\n有料契約の前なので料金はかかりません。あとからLiteに戻せます。',
  };
  const cards = () => [...document.querySelectorAll('#trial-plan .plan-card')];
  async function request(body) {
    const response = await fetch(`${CONFIG.url}/functions/v1/trial-plan`, {
      method: 'POST',
      headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || 'プランを変更できませんでした。時間をおいて再度お試しください。');
    return data;
  }
  function showBlockers(list) {
    const box = el('trial-plan-blockers');
    box.querySelector('ul').replaceChildren(...(list || []).map(text => {
      const li = document.createElement('li'); li.textContent = text; return li;
    }));
    box.classList.toggle('hidden', !(list || []).length);
  }
  function render(t) {
    const box = el('trial-plan');
    if (!box) return;
    generation++;
    tenant = t;
    const show = t?.billing_status === 'setup_trial' && !t.first_paid_at;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    const plan = t.reservation_plan === 'lite' ? 'lite' : 'standard';
    for (const card of cards()) card.classList.toggle('is-current', card.dataset.plan === plan);
    el('trial-plan-status').textContent = '';
    showBlockers([]);
  }
  async function change(target) {
    if (busy || !tenant || target === tenant.reservation_plan) return;
    if (!confirm(CONFIRM[target])) return;
    const version = generation;
    busy = true;
    const buttons = document.querySelectorAll('#trial-plan .plan-pick');
    buttons.forEach(b => { b.disabled = true; });
    el('trial-plan-status').textContent = '変更しています…';
    showBlockers([]);
    try {
      const data = await request({ action: 'switch', plan: target });
      if (version !== generation) return;
      if (data.ok === false) {
        el('trial-plan-status').textContent = data.blockers ? '' : (data.message || '');
        showBlockers(data.blockers);
        return;
      }
      el('trial-plan-status').textContent = `${NAMES[data.plan]}にしました。画面を読み込み直します…`;
      // 商品設定・受付日数など、プランで変わる表示をまとめて出し直す
      setTimeout(() => { location.href = `${location.pathname}?tab=billing`; }, 800);
    } catch (error) {
      if (version === generation) el('trial-plan-status').textContent = error.message;
    } finally {
      busy = false;
      buttons.forEach(b => { b.disabled = false; });
    }
  }
  for (const card of cards()) card.querySelector('.plan-pick')?.addEventListener('click', () => change(card.dataset.plan));
  return { render };
})();
