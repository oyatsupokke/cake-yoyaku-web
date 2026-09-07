// 商品編集のデータや保存処理には触れず、狭い画面のナビゲーションを扱う。
(() => {
  const button = document.getElementById('menu-btn');
  const body = document.getElementById('admin-body');
  const nav = document.getElementById('admin-tabs');
  const close = (restoreFocus = false) => {
    body.classList.remove('menu-open');
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus({ preventScroll: true });
  };
  button.addEventListener('click', () => {
    const open = body.classList.toggle('menu-open');
    button.setAttribute('aria-expanded', String(open));
    if (open) document.getElementById('menu-close').focus({ preventScroll: true });
  });
  document.getElementById('menu-close').addEventListener('click', () => close(true));
  document.addEventListener('click', (event) => {
    if (!nav.contains(event.target) && !button.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && body.classList.contains('menu-open')) close(true);
  });
  matchMedia('(min-width: 920px)').addEventListener('change', () => close());
})();
