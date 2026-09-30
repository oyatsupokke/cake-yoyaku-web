/* CakeBook LP の動き。HTMLは静的出力のまま、後から motion.css とこのファイルを差し込む（scripts/lp_add_motion.py）。
   head の小さなインラインscriptが html.cb-motion を付け、このファイルが読めなければ3秒で外す＝中身が隠れたままにならない。 */
(function () {
  var root = document.documentElement;
  if (!root.classList.contains('cb-motion')) return;
  window.__cbMotion = true;

  function $$(sel, base) { return Array.prototype.slice.call((base || document).querySelectorAll(sel)); }

  // ---- スクロールで順に現れる ----
  // [セレクタ, 向き, 同じ親の中でずらす秒数]
  var groups = [
    ['.cb-section .cb-eyebrow, .cb-section h2, .cb-section .cb-lead-sm', '', 0.08],
    ['.cb-worry-grid > article', '', 0.12],
    ['.cb-workload', 'zoom', 0],
    ['.cb-point-list > li', 'left', 0.1],
    ['.cb-customer .cb-link', '', 0],
    ['.cb-customer-art', 'right', 0],
    ['.cb-shop .cb-browser', 'left', 0],
    ['.cb-feature-list > li', '', 0.07],
    ['.cb-shop .cb-link', '', 0],
    ['.cb-origin-art', 'zoom', 0],
    ['.cb-origin-grid > div:not(.cb-origin-art) > *', '', 0.08],
    ['.cb-steps > li', '', 0.15],
    ['.cb-flow .cb-note', '', 0],
    ['.cb-zero', 'zoom', 0],
    ['.cb-plans > .cb-plan', '', 0.15],
    ['.cb-bulk, .cb-price .cb-compare, .cb-price .cb-costs', '', 0],
    ['.cb-faq-list > details', '', 0.06],
    ['.cb-closing-art', 'zoom', 0],
    ['.cb-closing-body > *', '', 0.1]
  ];
  var targets = [];
  groups.forEach(function (g) {
    $$(g[0]).forEach(function (el) {
      if (el.classList.contains('cb-rv')) return;
      var sibs = $$(g[0], el.parentNode).filter(function (s) { return s.parentNode === el.parentNode; });
      el.classList.add('cb-rv');
      if (g[1]) el.classList.add('cb-rv-' + g[1]);
      el.style.setProperty('--rv-d', Math.min(sibs.indexOf(el) * g[2], 0.6) + 's');
      targets.push(el);
    });
  });

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
      if (e.target.classList.contains('cb-workload')) countUp(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  targets.forEach(function (el) { io.observe(el); });

  // ---- ファーストビュー：読み込み時に順に ----
  var heroCopy = $$('.cb-hero-copy > *');
  heroCopy.forEach(function (el, i) { el.style.setProperty('--rv-d', (0.1 + i * 0.12) + 's'); });
  var browser = document.querySelector('.cb-shots > .cb-browser');
  var phone = document.querySelector('.cb-shots > .cb-shot-phone');
  if (browser) { browser.classList.add('cb-rv', 'cb-rv-right'); browser.style.setProperty('--rv-d', '.35s'); }
  if (phone) { phone.style.setProperty('--rv-d', '.6s'); }
  $$('.cb-shots > .cb-art-note').forEach(function (el) { el.style.setProperty('--rv-d', '.9s'); });
  // 隠れた状態をいったん確定させてから is-in を付ける（rAF だと裏タブで止まるので setTimeout）
  void document.body.offsetWidth;
  setTimeout(function () {
    heroCopy.concat($$('.cb-shots > *')).forEach(function (el) { el.classList.add('is-in'); });
  }, 30);

  // ---- 月◯時間◯分を数え上げる ----
  function countUp(box) {
    var strong = box.querySelector('.cb-workload-num strong');
    if (!strong) return;
    var nodes = Array.prototype.filter.call(strong.childNodes, function (n) { return n.nodeType === 3 && /\d/.test(n.nodeValue); });
    if (nodes.length !== 2) return;
    var total = parseInt(nodes[0].nodeValue, 10) * 60 + parseInt(nodes[1].nodeValue, 10);
    var start = null, dur = 1400;
    function frame(t) {
      if (start === null) start = t;
      var p = Math.min((t - start) / dur, 1);
      var v = Math.round(total * (1 - Math.pow(1 - p, 3)));
      nodes[0].nodeValue = String(Math.floor(v / 60));
      nodes[1].nodeValue = String(v % 60);
      if (p < 1) requestAnimationFrame(frame);
    }
    nodes[0].nodeValue = '0'; nodes[1].nodeValue = '0';
    requestAnimationFrame(frame);
  }

  // ---- ヘッダーの影 ----
  var header = document.querySelector('.cb-header');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---- 予約画面の見本：見えている間、選択肢を自動で切り替えて見せる。触ったら止める ----
  var demo = document.querySelector('.cb-demo');
  if (demo) {
    var steps = ['cb-choco-berry', 'cb-fruit-pile', 'cb-topping-usagi', 'cb-choco-choco', 'cb-fruit-side', 'cb-topping-kuma',
      'cb-choco-none', 'cb-fruit-ring', 'cb-topping-wanko', 'cb-choco-choco', 'cb-topping-none'];
    var i = 0, timer = null, stopped = false, visible = false;
    var cap = demo.querySelector('.cb-demo-cap');
    var hint = null;
    if (cap) {
      hint = document.createElement('small');
      hint.className = 'cb-demo-hint';
      hint.textContent = '選択肢を押すと、ご自分で試せます';
      cap.parentNode.insertBefore(hint, cap.nextSibling);
    }
    function tick() {
      var input = document.getElementById(steps[i % steps.length]);
      i++;
      if (!input) return;
      input.checked = true;
      var label = demo.querySelector('label[for="' + input.id + '"]');
      if (label) {
        label.classList.add('is-auto');
        setTimeout(function () { label.classList.remove('is-auto'); }, 400);
      }
    }
    function play() { if (!stopped && visible && !timer) timer = setInterval(tick, 1700); }
    function pause() { clearInterval(timer); timer = null; }
    function stop() { stopped = true; pause(); if (hint) hint.classList.add('is-off'); }
    // ケーキの絵が見えている間だけ（スマホでは見本が縦に長いので、見本全体ではなく絵で判定）
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      visible ? play() : pause();
    }, { threshold: 0.6 }).observe(demo.querySelector('.cb-demo-canvas') || demo);
    ['pointerdown', 'keydown', 'change'].forEach(function (ev) {
      demo.addEventListener(ev, function (e) { if (e.isTrusted) stop(); });
    });
    document.addEventListener('visibilitychange', function () { document.hidden ? pause() : play(); });
  }
})();
