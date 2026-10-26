/* お試し中（有料契約の前）のプランの選び直し（2026-10-26）。処理は Edge Function `trial-plan`。 */
globalThis.TrialPlan = (() => {
  const el = id => document.getElementById(id);
  let tenant = null, busy = false, generation = 0;
  const NAMES = { lite: 'Lite（月額1,980円）', standard: 'Standard（月額4,980円）' };
  const NOTES = {
    lite: 'Standardにすると、受付台数の上限がなくなり、最大90日先までの予約・季節商品（販売期間）・飾りなどの選択グループ・LINE通知が使えます。',
    standard: 'Liteは月30台・30日先までの予約です。季節商品（販売期間）・飾りなどの選択グループ・LINE通知は使えません。商品ごとの締切は、設定の「締切」にそろいます。',
  };
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
    const other = plan === 'lite' ? 'standard' : 'lite';
    el('trial-plan-current').textContent = NAMES[plan];
    el('trial-plan-note').textContent = NOTES[plan];
    el('trial-plan-switch').textContent = `${NAMES[other]}に変更する`;
    el('trial-plan-status').textContent = '';
    showBlockers([]);
  }
  async function change() {
    if (busy || !tenant) return;
    const target = tenant.reservation_plan === 'lite' ? 'standard' : 'lite';
    if (!confirm(`プランを ${NAMES[target]} に変更しますか？\n（有料契約の前なので料金はかかりません。あとから戻せます）`)) return;
    const version = generation;
    busy = true; el('trial-plan-switch').disabled = true;
    el('trial-plan-status').textContent = '変更しています…';
    try {
      const data = await request({ action: 'switch', plan: target });
      if (version !== generation) return;
      if (data.ok === false) {
        el('trial-plan-status').textContent = data.blockers ? '' : (data.message || '');
        showBlockers(data.blockers);
        return;
      }
      el('trial-plan-status').textContent = `${NAMES[data.plan]}に変更しました。画面を読み込み直します…`;
      // 商品設定・受付日数など、プランで変わる表示をまとめて出し直す
      setTimeout(() => { location.href = `${location.pathname}?tab=billing`; }, 800);
    } catch (error) {
      if (version === generation) el('trial-plan-status').textContent = error.message;
    } finally {
      busy = false; el('trial-plan-switch').disabled = false;
    }
  }
  el('trial-plan-switch')?.addEventListener('click', change);
  return { render };
})();
