// Keep the same navigation rail across dashboard and product editing.
(() => {
  const nav = document.getElementById('admin-tabs');
  if (!nav) return;
  const help = document.createElement('a');
  help.className = 'tab tab-link'; help.href = '/help/assistant.html'; help.textContent = '使い方をAIに質問';
  nav.append(help);
  const panel = document.createElement('aside');
  panel.id = 'admin-help-panel'; panel.className = 'admin-help-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', '使い方をAIに質問');
  panel.innerHTML = '<div class="admin-help-heading"><strong>使い方をAIに質問</strong><button type="button" aria-label="チャットを閉じる">閉じる</button></div>';
  const launcher = document.createElement('button');
  launcher.type = 'button'; launcher.className = 'admin-help-launcher'; launcher.textContent = 'AIに質問';
  for (const trigger of [help, launcher]) { trigger.setAttribute('aria-controls', panel.id); trigger.setAttribute('aria-expanded','false'); }
  document.body.append(panel, launcher);
  let frame, opener;
  function closeHelp() {
    panel.hidden = true; document.body.classList.remove('help-chat-open'); launcher.hidden = false;
    for (const trigger of [help, launcher]) trigger.setAttribute('aria-expanded','false');
    if (panel.contains(document.activeElement)) (opener || launcher).focus();
  }
  function openHelp(event) {
    if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    event?.preventDefault(); opener = event?.currentTarget || launcher;
    if (!panel.hidden) { closeHelp(); return; }
    if (!frame) { frame = document.createElement('iframe'); frame.title = '使い方AIチャット'; frame.src = '/help/assistant.html?panel=1'; panel.append(frame); }
    panel.hidden = false; launcher.hidden = true; document.body.classList.add('help-chat-open');
    for (const trigger of [help, launcher]) trigger.setAttribute('aria-expanded','true');
    // 小さい画面ではメニューを閉じ、操作画面とチャットを見られるようにする。
    if (document.getElementById('menu-btn')?.getAttribute('aria-expanded') === 'true') document.getElementById('menu-btn').click();
    panel.querySelector('button').focus();
  }
  help.addEventListener('click', openHelp); launcher.addEventListener('click', openHelp);
  panel.querySelector('button').addEventListener('click', closeHelp);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && panel.contains(document.activeElement)) closeHelp(); });
  window.addEventListener('message', event => { if (event.origin === location.origin && event.source === frame?.contentWindow && event.data?.type === 'help-chat-close') closeHelp(); });
  // ログアウト時には会話も破棄。再び開く際にはログインを確認する。
  function clearSignedOutChat() { if (!localStorage.getItem('cakebook_admin_demo_session') && frame) { closeHelp(); frame.remove(); frame = null; } }
  document.getElementById('btn-logout')?.addEventListener('click', () => setTimeout(clearSignedOutChat, 0));
  window.addEventListener('storage', event => { if (event.key === 'cakebook_admin_demo_session') clearSignedOutChat(); });
  const key = 'cake-admin-nav-collapsed';
  const short = ['暦','予約','集計','設定','商品','表','配色','会員','契約','相談','登録','退出','説明'];
  for (const item of nav.querySelectorAll('.tab')) {
    const label = item.textContent.trim();
    const labels = ['予約カレンダー','予約・製造','集計・CSV','予約設定','商品','メニュー表','デザイン','アカウント・店舗情報','ご契約・お支払い','サポート','予約の直接登録','ログアウト','使い方マニュアル ↗'];
    item.dataset.short = (label === '使い方をAIに質問' ? 'AI' : short[labels.indexOf(label)]) || label.slice(0,2);
    item.title = label;
    item.setAttribute('aria-label', label);
    const text = document.createElement('span'); text.className = 'nav-label'; text.textContent = label;
    item.replaceChildren(text);
  }
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'nav-collapse';
  toggle.setAttribute('aria-controls','admin-tabs');
  nav.after(toggle);
  toggle.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h8M3 12h8M3 19h8"/><path class="nav-chevron" d="m21 6-6 6 6 6"/></svg>';
  const paint = () => {
    const collapsed = document.body.classList.contains('nav-collapsed');
    toggle.querySelector('.nav-chevron').setAttribute('d', collapsed ? 'm16 6 6 6-6 6' : 'm21 6-6 6 6 6');
    toggle.title = collapsed ? 'メニューを広げる' : 'メニューを畳む';
    toggle.setAttribute('aria-label',toggle.title);
    toggle.setAttribute('aria-expanded',String(!collapsed));
  };
  try { document.body.classList.toggle('nav-collapsed',localStorage.getItem(key)==='1'); } catch {}
  paint();
  toggle.onclick = () => {
    document.body.classList.toggle('nav-collapsed'); paint();
    try { localStorage.setItem(key,document.body.classList.contains('nav-collapsed')?'1':'0'); } catch {}
  };
})();
