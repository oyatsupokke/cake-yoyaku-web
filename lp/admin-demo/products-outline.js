/* 編集中のDOMを目次にする。未保存の名前・表示範囲・並び順もそのまま反映する。 */
(() => {
  const app = document.getElementById('view-app');
  const rail = document.createElement('aside');
  rail.className = 'question-outline';
  rail.setAttribute('aria-label', '質問の目次');
  rail.innerHTML = '<div class="outline-head"><strong>質問の目次</strong><button type="button" class="outline-hide">畳む</button></div><p class="outline-product"></p><nav class="outline-list" aria-label="設定項目"></nav>';
  app.appendChild(rail);
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.id = 'question-outline-open'; trigger.textContent = '☰ 質問一覧';
  trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', 'question-outline-dialog');
  document.getElementById("editor").prepend(trigger);
  const dialog = document.createElement('dialog');
  dialog.id = 'question-outline-dialog'; dialog.className = 'question-outline-dialog';
  dialog.setAttribute('aria-label', '質問の目次');
  dialog.innerHTML = '<div class="outline-head"><strong>質問の目次</strong><button type="button" class="outline-close">閉じる</button></div><p class="outline-product"></p><nav class="outline-list" aria-label="設定項目"></nav>';
  app.appendChild(dialog);
  // 目次を左に出すのは1600px以上。admin-layout.css の @media(min-width:1600px) と必ず揃える
  // （products.css の 1280px の指定は admin-layout.css が !important で上書きしていて効かない）。
  // 1280〜1599pxは左メニューと本文で幅が足りないため、目次は「☰ 質問一覧」から開く小窓で出す。
  const wide = matchMedia('(min-width: 1600px)');
  let entries = [], signature = '', scheduled = false, scrollScheduled = false, nextId = 0;
  const ids = new WeakMap();
  const name = (el, selector, fallback) => el.querySelector(selector)?.value?.trim() || fallback;
  function add(target, title, depth = 0, badge = '') {
    if (!target) return;
    if (!ids.has(target)) ids.set(target, `outline-target-${++nextId}`);
    entries.push({target, title, depth, badge, key:ids.get(target)});
  }
  function refresh() {
    scheduled = false; entries = [];
    const editor = document.getElementById('editor');
    if (!editor.classList.contains('hidden')) {
      add(editor.querySelector('.product-compact-card'), '基本情報');
      for (const row of document.querySelectorAll('#groups-list > [data-question-key]')) {
        const scope = row.querySelector('.question-scope');
        const badge = scope?.dataset.shared === 'true' ? (scope.querySelector('input[value=all]')?.checked ? '全ケーキ共通' : '対象ケーキ共通') : 'このケーキのみ';
        add(row, name(row, '.gname, .qname', '質問文未入力'), 0, row.classList.contains('stopped') ? '停止中' : badge);
        for (const option of row.querySelectorAll('.g-options > .opt')) {
          const questions = option.querySelectorAll('.o-question-item');
          add(option, name(option, '.oname', '名前未入力の選択肢'), 1, option.classList.contains('stopped') ? '停止中' : questions.length ? '選んだ人への質問' : '');
          for (const question of questions) add(question, name(question, '.q-label', '質問文未入力'), 2, question.classList.contains('stopped') ? '停止中' : '');
        }
      }
    }
    if (!editor.classList.contains('hidden')) add(document.querySelector('.preview-illustration-card'), 'プレビュー用イラスト');
    const product = document.getElementById('p-name').value.trim() || state.current?.name || '商品未選択';
    const next = JSON.stringify([product, entries.map(({key,title,depth,badge}) => ({key,title,depth,badge}))]);
    if (next !== signature) {
      signature = next;
      for (const container of [rail, dialog]) {
        container.querySelector('.outline-product').textContent = product;
        const nav = container.querySelector('nav'); nav.replaceChildren();
        for (const [index, entry] of entries.entries()) {
          const button = document.createElement('button'); button.type = 'button';
          button.dataset.target = entry.key; button.className = `outline-item outline-depth-${entry.depth}`;
          if (entry.depth === 2 && entries[index + 1]?.depth !== 2) button.classList.add("outline-branch-last");
          const label = document.createElement('span'); label.textContent = entry.title; button.appendChild(label);
          if (entry.badge) { const badge = document.createElement('small'); badge.textContent = entry.badge; button.appendChild(badge); }
          button.onclick = () => jump(entry);
          nav.appendChild(button);
        }
      }
    }
    highlight();
  }
  function jump(entry) {
    if (dialog.open) dialog.close();
    if (typeof closePreview === 'function') closePreview();
    const option = entry.target.closest('.opt');
    if (option && !option.classList.contains('open')) option.querySelector('.o-more')?.click();
    for (let el = entry.target.parentElement; el; el = el.parentElement) if (el.tagName === 'DETAILS') el.open = true;
    // dialogのフォーカス復帰後に編集欄へフォーカスを渡す。
    requestAnimationFrame(() => {
      const field = entry.target.querySelector('.gname, .q-label, .qname, .oname') || entry.target.querySelector('input:not([type=hidden]), button');
      if (field) field.focus({preventScroll:true});
      entry.target.scrollIntoView({block:'start', behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    });
  }
  function highlight() {
    scrollScheduled = false;
    const visible = entries.filter(e => e.target.getClientRects().length);
    let current = visible[0];
    for (const entry of visible) if (entry.target.getBoundingClientRect().top <= 160) current = entry;
    for (const button of app.querySelectorAll('.outline-item')) {
      if (button.dataset.target === current?.key) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(refresh); } }
  for (const id of ['groups-list', 'questions-list', 'prod-tabs']) new MutationObserver(schedule).observe(document.getElementById(id), {childList:true,subtree:true});
  new MutationObserver(schedule).observe(document.getElementById('editor'), {attributes:true,attributeFilter:['class']});
  app.addEventListener('input', schedule); app.addEventListener('change', schedule);
  window.addEventListener('scroll', () => { if (!scrollScheduled) { scrollScheduled = true; requestAnimationFrame(highlight); } }, {passive:true});
  rail.querySelector('.outline-hide').onclick = () => { document.body.classList.add('outline-collapsed'); trigger.focus(); };
  trigger.onclick = () => {
    refresh();
    if (wide.matches) { document.body.classList.remove('outline-collapsed'); rail.querySelector('.outline-hide').focus(); }
    else { dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); }
  };
  dialog.querySelector('.outline-close').onclick = () => dialog.close();
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => trigger.setAttribute('aria-expanded', 'false'));
  wide.addEventListener('change', () => { if (dialog.open) dialog.close(); schedule(); });
  const mobile = matchMedia('(max-width: 919px)');
  const bar = document.getElementById('save-bar'), preview = document.getElementById('fab');
  const save = document.getElementById('btn-save-all');
  function arrangeActions() {
    if (mobile.matches) {
      bar.insertBefore(trigger, save); bar.insertBefore(preview, save);
    } else {
      document.getElementById("editor").prepend(trigger); document.getElementById('app').appendChild(preview);
    }
  }
  mobile.addEventListener('change', arrangeActions); arrangeActions();
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--product-action-height', `${bar.getBoundingClientRect().height}px`);
  }).observe(bar);
  refresh();
})();
