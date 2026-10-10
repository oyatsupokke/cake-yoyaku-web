/* 管理画面の操作デモ：画面の中だけで動く疑似サーバー（2026-10-10）。
 * 管理画面のコード（index.html・admin.js など）は scripts/build_admin_demo.mjs が今の管理画面から写す。手で書いてよいのはこのファイルと demo-banner.css・assets/ だけ。
 * - データは架空の店・架空の予約だけ（本番のデータは一切使わない）。受取日は「今日」から先に並ぶように毎回作る
 * - 通信はすべてここで返す。外へは何も送らない（メール・LINE・決済・画像のアップロードはしない）
 * - 変更（確認済・日時の変更・メモ・設定など）は、このタブの中だけに残る（sessionStorage）。「最初から」で戻る
 * - 本物の管理画面のログイン（pokke_admin_session）とは別の保存場所を使う（build で置き換え済み）＝お店のログインを消さない */
(() => {
  const STORE = 'cakebook_admin_demo_v6', SESSION = 'cakebook_admin_demo_session', TENANT = 'demo-shop';
  const pad = (n) => String(n).padStart(2, '0');
  const jst = () => new Date(Date.now() + 9 * 3600e3);
  const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
  const today = () => ymd(jst());
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let seq = 1000;
  const newId = () => 'demo-' + Date.now().toString(36) + '-' + (++seq);

  /* ---------- 架空のデータ ---------- */
  // 商品写真は oyatsupokke の写真（まりほ了承 2026-10-10・予約画面デモと同じファイル）
  const PHOTO_DIR = '/lp/product-demo/assets/store/products/';
  const PHOTOS = {
    'p-deco': [PHOTO_DIR + 'ea593e33-09a5-4ed9-a6eb-93cc32b5d596.jpg', 'ふわふわのスポンジに生クリームと季節の果物をサンドした、定番のケーキです。'],
    'p-choco': [PHOTO_DIR + '3f916a9c-8a44-4bce-b20b-731c65a69fd6.jpg', 'スイートチョコレートを使ったチョコレートケーキ。'],
    'p-tart': [PHOTO_DIR + '1c025a08-83e4-416d-8d92-5ee69765db34.jpg', 'サクサクのクッキー生地にアーモンドクリームとたっぷりのフルーツ。'],
  };
  function seed() {
    const t0 = today();
    const tenant = {
      id: TENANT, name: 'サンプル洋菓子店', subdomain: 'sample-demo', timezone: 'Asia/Tokyo', contact_email: 'shop@example.invalid',
      billing_status: 'active', reservation_plan: 'standard', first_paid_at: '2026-09-01T00:00:00+09:00', trial_ends_at: null,
      theme: { accent: '#5b7ba6', type: 'kaku', sub: 'ホールケーキのご予約' }, closed_weekdays: [2],
      default_deadline_days: 3, order_cutoff_time: '20:00:00', deadline_mode: 'calendar', booking_window_days: 60,
      self_manage_enabled: true, self_slot_days: 1, self_slot_time: '12:00:00', self_content_days: 2, self_content_time: '12:00:00', self_cancel_days: 1, self_cancel_time: '09:00:00',
      // 製造数の「内訳」（2026-10-10 本番に入った機能）：果物で分けて見せる
      kitchen_breakdown: { groups: ['フルーツをお選びください'], combine: true },
      reminder_enabled: true, reminder_send_at: '18:00:00', public_form_url: 'https://cakebook.jp/', customer_form: {},
      cancel_policy: '変更・キャンセルは、確認メールの専用リンクから受取日の前日9:00までお手続きいただけます。',
      tokushoho: { text: 'サンプル洋菓子店（架空の店です）' }, email_texts: {}, preview_note: '写真・イラストはイメージです。', square_prepay_enabled: false,
    };
    const products = [
      { id: 'p-deco', name: 'デコレーションケーキ', sizes: [['4号（12cm）', 3500], ['5号（15cm）', 4500], ['6号（18cm）', 5500]], deco: true, fruit: true },
      { id: 'p-choco', name: 'チョコレートケーキ', sizes: [['4号（12cm）', 3700], ['5号（15cm）', 4700]] },
      { id: 'p-tart', name: 'フルーツタルト', sizes: [['18cm', 4800]], fruit: true },
    ];
    const slots = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']
      .map((t, i) => ({ id: 'slot-' + i, tenant_id: TENANT, label: t, start_time: t + ':00', is_active: true, daily_capacity: i === 2 ? 3 : null, display_order: i }));
    const people = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '松本', '井上', '木村', '林', '清水', '山口', '森', '池田'];
    const decos = [['フルーツ1周', 0, 'ring'], ['フルーツ盛り', 500, 'pile'], ['フルーツサイド寄せ', 0, 'side']];
    // 受取日は今日（10月）から先なので秋の果物（いちごは冬から・まりほ指摘 2026-10-10）
    const fruits = [['シャインマスカット', 0], ['ナガノパープル', 0], ['いちじく', 200], ['フルーツミックス', 200]];
    const plates = ['Happy Birthday', 'おたんじょうびおめでとう', 'Happy Birthday はるくん', 'いつもありがとう', ''];
    const notes = ['ろうそく 大2本・小5本', '保冷剤を多めに（車で1時間）', '17時以降に来店の可能性あり'];
    // 決まった並びの「乱数」（読み込むたびに中身が変わらないように）
    let r = 7; const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
    const orders = []; let no = 100;
    for (let i = 0; i <= 34; i++) {
      const date = addDays(t0, i), dow = new Date(date + 'T00:00:00Z').getUTCDay();
      if (dow === 2) continue; // 定休日（火）
      const n = i === 0 ? 10 : Math.round((dow === 0 || dow === 6 ? 9 : 4) * (0.4 + rnd()) * (i < 14 ? 1 : 0.6));
      for (let k = 0; k < n; k++) {
        // デザインイメージ（重ねイラスト）付きの商品は一部だけ（写真で選ぶ店が多いため・2026-10-10）
        // 今日の最初の2件はデザインイメージ付き（予約・製造を開いたときに見本が必ず見えるように）
        const showcase = i === 0 && k < 2;
        const p = showcase ? products[0] : products[Math.floor(rnd() * (rnd() < 0.5 ? 1 : 3))] || products[0];
        const [size, base] = p.sizes[Math.floor(rnd() * p.sizes.length)];
        // デザインイメージ（重ねイラスト）付きは一部の予約だけ（写真で選ぶ店が多いため）
        const deco = p.deco && (showcase || rnd() < 0.4) ? decos[k % 3] : null;
        const fruit = p.fruit ? fruits[Math.floor(rnd() * fruits.length)] : null;
        const plate = plates[Math.floor(rnd() * plates.length)];
        const slot = slots[Math.floor(rnd() * slots.length)];
        const via = rnd() < 0.2 ? 'staff' : 'web';
        const recent = i <= 3 ? rnd() < 0.45 : i <= 10 ? rnd() < 0.15 : false;
        const id = 'order-' + (++no), price = base + (deco?.[1] || 0) + (fruit?.[1] || 0);
        orders.push({
          id, tenant_id: TENANT, order_number: no, pickup_date: date, pickup_slot_id: slot.id, pickup_slot_label: slot.label,
          status: recent ? 'new' : 'confirmed', review_state: 'none', created_via: via, staff_note: rnd() < 0.08 ? notes[Math.floor(rnd() * notes.length)] : null,
          customer_name: people[(no * 7) % people.length] + '（見本）', customer_kana: 'サンプル', customer_phone: '00000000000',
          customer_email: via === 'staff' ? null : 'customer@example.invalid', line_user_id: null,
          total_amount: price, paid_amount: 0, payment_method: 'store', mail_failed: false, current_quote_id: null, quote: null,
          created_at: new Date(Date.now() - (40 - i) * 3600e3 * 5).toISOString(),
          order_images: [], order_refunds: [],
          order_previews: deco ? [{ id: 'pv-' + id, path: `demo/preview-${deco[2]}.png`, created_at: new Date().toISOString() }] : [],
          order_items: [{ id: 'item-' + id, order_id: id, product_id: p.id, variant_id: p.id + '-' + size, product_name_snapshot: p.name, variant_label_snapshot: size, quantity: 1, unit_price: price,
            order_item_options: [
              ...(fruit ? [{ id: 'oif-' + id, option_id: 'fruit-' + fruit[0], group_name_snapshot: 'フルーツをお選びください', option_name_snapshot: fruit[0], price_snapshot: fruit[1], price_delta: fruit[1], quantity: 1 }] : []),
              ...(deco ? [{ id: 'oio-' + id, option_id: 'opt-' + deco[2], group_name_snapshot: 'フルーツの飾り方', option_name_snapshot: deco[0], price_snapshot: deco[1], price_delta: deco[1], quantity: 1 }] : []),
            ] }],
          order_answers: plate ? [{ id: 'ans-' + id, question_id: 'q-plate', label_snapshot: 'プレートのメッセージ', answer_text: plate }] : [],
        });
      }
    }
    return {
      tenants: [tenant],
      tenant_users: [{ tenant_id: TENANT, user_id: 'demo-user', role: 'owner' }],
      orders,
      pickup_time_slots: slots,
      capacity_rules: [{ id: 'rule-all', tenant_id: TENANT, name: '全体上限', scope: 'all', daily_limit: 12, slot_limit: null, is_active: true }],
      capacity_rule_date_overrides: [{ id: 'dl-1', tenant_id: TENANT, rule_id: 'rule-all', date: addDays(t0, 20), daily_limit: 20 }],
      capacity_rule_products: [],
      date_overrides: [],
      // 商品の設定ページ用（表は本物と同じ分け方。商品ページの読み込みでは embed() が入れ子にして返す）
      products: products.map((p, i) => ({ id: p.id, tenant_id: TENANT, name: p.name, description: PHOTOS[p.id][1], photo_url: PHOTOS[p.id][0],
        is_published: true, display_order: i, deleted_at: null, category_id: null, layer_url: null, size_layer_urls: null,
        sale_start_at: null, sale_end_at: null, pickup_start_date: null, pickup_end_date: null, order_deadline_days: null, booking_window_days: null,
        created_at: '2026-09-01T00:00:00Z' })),
      product_variants: products.flatMap((p) => p.sizes.map(([s, price], j) => ({ id: p.id + '-' + s, tenant_id: TENANT, product_id: p.id, size_label: s, price, is_available: true, display_order: j }))),
      option_groups: products.filter((p) => p.fruit).flatMap((p) => [
        { id: 'g-fruit-' + p.id, tenant_id: TENANT, product_id: p.id, name: 'フルーツをお選びください', description: '季節の果物からお選びください', selection: 'single', is_required: true, min_select: 1, max_select: 1, display_order: 0, created_at: '2026-09-01T00:00:00Z' },
        ...(p.deco ? [{ id: 'g-deco-' + p.id, tenant_id: TENANT, product_id: p.id, name: 'フルーツの飾り方', description: null, selection: 'single', is_required: true, min_select: 1, max_select: 1, display_order: 1, created_at: '2026-09-01T00:00:00Z' }] : []),
      ]),
      options: products.filter((p) => p.fruit).flatMap((p) => [
        ...fruits.map(([n, d], j) => ({ id: `o-${p.id}-f${j}`, tenant_id: TENANT, group_id: 'g-fruit-' + p.id, name: n, price_delta: d, is_available: true, shared_list_item_id: null, display_order: j, photo_url: null, layer_url: null })),
        ...(p.deco ? decos.map(([n, d], j) => ({ id: `o-${p.id}-d${j}`, tenant_id: TENANT, group_id: 'g-deco-' + p.id, name: n, price_delta: d, is_available: true, shared_list_item_id: null, display_order: j, photo_url: null, layer_url: null })) : []),
      ]),
      option_exclusions: [],
      categories: [],
      common_questions: [{ id: 'q-plate', tenant_id: TENANT, option_id: null, label: 'プレートのメッセージ', input_type: 'text', scope: 'all', is_active: true, is_required: false, display_order: 0, placeholder: null, created_at: '2026-09-01T00:00:00Z' }],
      common_question_choices: [],
      common_question_products: [],
      selfcheck_results: [],
    };
  }
  let db;
  try { db = JSON.parse(sessionStorage.getItem(STORE)); } catch {}
  if (!db || db._day !== today()) { db = seed(); db._day = today(); }
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(db)); } catch {} };
  save();
  // 管理画面は「ログイン済み」で開く（デモ専用の保存場所。本物のログインとは別）
  const session = { access_token: 'demo-only', refresh_token: 'demo-only', token_type: 'bearer', expires_in: 86400, expires_at: 4102444800, user: { id: 'demo-user', email: 'demo@example.invalid' } };
  try { if (!localStorage.getItem(SESSION)) localStorage.setItem(SESSION, JSON.stringify(session)); } catch {}

  /* ---------- PostgREST のまね（読む・足す・直す・消す） ---------- */
  const SKIP = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or', 'and', 'columns']);
  function match(row, key, raw) {
    let v = raw, not = false;
    if (v.startsWith('not.')) { not = true; v = v.slice(4); }
    const i = v.indexOf('.'), op = v.slice(0, i), arg = v.slice(i + 1), cell = row[key];
    const s = cell == null ? null : String(cell);
    let ok;
    switch (op) {
      case 'eq': ok = s === arg; break;
      case 'neq': ok = s !== arg; break;
      case 'gt': ok = s != null && (typeof cell === 'number' ? cell > +arg : s > arg); break;
      case 'gte': ok = s != null && (typeof cell === 'number' ? cell >= +arg : s >= arg); break;
      case 'lt': ok = s != null && (typeof cell === 'number' ? cell < +arg : s < arg); break;
      case 'lte': ok = s != null && (typeof cell === 'number' ? cell <= +arg : s <= arg); break;
      case 'in': ok = arg.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')).includes(s); break;
      case 'is': ok = arg === 'null' ? cell == null : arg === 'true' ? cell === true : arg === 'false' ? cell === false : true; break;
      default: ok = true; // like・ilike など、デモでは絞らない
    }
    return not ? !ok : ok;
  }
  function filter(rows, params) {
    for (const [k, v] of params) if (!SKIP.has(k) && !k.includes('.')) rows = rows.filter((r) => match(r, k, v));
    const order = params.get('order');
    if (order) {
      const keys = order.split(',').map((x) => x.split('.'));
      rows = [...rows].sort((a, b) => {
        for (const [k, dir] of keys) { const x = a[k] ?? '', y = b[k] ?? ''; if (x < y) return dir === 'desc' ? 1 : -1; if (x > y) return dir === 'desc' ? -1 : 1; }
        return 0;
      });
    }
    return rows;
  }
  const json = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const refuse = (message) => json({ message, error: message, msg: message }, 400);

  // 埋め込み（PostgREST の select=*,子(*)）のまね。商品の設定ページが読む形だけ
  const kids = (t, col, id) => clone((db[t] || []).filter((r) => r[col] === id)).sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  function embed(table, rows, select) {
    const has = (name) => select.includes(name);
    for (const r of rows) {
      if (table === 'products') {
        if (has('product_variants')) r.product_variants = kids('product_variants', 'product_id', r.id);
        if (has('option_groups')) r.option_groups = kids('option_groups', 'product_id', r.id).map((g) => ({ ...g, options: kids('options', 'group_id', g.id).map((o) => ({ ...o, shared_list_items: null })) }));
        if (has('option_exclusions')) r.option_exclusions = kids('option_exclusions', 'product_id', r.id);
      }
      if (table === 'option_groups' && has('options')) r.options = kids('options', 'group_id', r.id).map((o) => ({ ...o, shared_list_items: null }));
      if (table === 'common_questions') {
        if (has('common_question_choices')) r.common_question_choices = kids('common_question_choices', 'question_id', r.id);
        if (has('common_question_products')) r.common_question_products = kids('common_question_products', 'question_id', r.id);
      }
      if (table === 'capacity_rules' && has('capacity_rule_products')) r.capacity_rule_products = kids('capacity_rule_products', 'rule_id', r.id);
    }
    return rows;
  }
  function rest(table, method, params, body, prefer) {
    const all = db[table] || (db[table] = []);
    let rows = filter(all, params);
    // capacity_rules?…&capacity_rule_products.product_id=eq.X（!inner）＝その商品に結んだルールだけ
    const linked = params.get('capacity_rule_products.product_id');
    if (table === 'capacity_rules' && linked) rows = rows.filter((r) => (db.capacity_rule_products || []).some((l) => l.rule_id === r.id && 'eq.' + l.product_id === linked));
    if (method === 'GET' || method === 'HEAD') {
      const off = +(params.get('offset') || 0), lim = params.has('limit') ? +params.get('limit') : rows.length;
      const page = rows.slice(off, off + lim);
      const range = { 'content-range': `${page.length ? off : '*'}-${page.length ? off + page.length - 1 : ''}/${rows.length}`.replace('*-/', '*/') };
      if (method === 'HEAD') return new Response(null, { status: 200, headers: range });
      return json(embed(table, clone(page), params.get('select') || ''), 200, range);
    }
    if (method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const keys = (params.get('on_conflict') || '').split(',').filter(Boolean);
      const out = [];
      for (const r of list) {
        const hit = keys.length && prefer.includes('merge-duplicates') ? all.find((x) => keys.every((k) => String(x[k]) === String(r[k]))) : null;
        if (hit) { Object.assign(hit, r); out.push(hit); } else { const row = { id: newId(), is_active: true, ...r }; all.push(row); out.push(row); }
      }
      save();
      return prefer.includes('return=minimal') ? new Response(null, { status: 201 }) : json(clone(out), 201);
    }
    if (method === 'PATCH') {
      for (const r of rows) Object.assign(r, body);
      save();
      return json(clone(rows));
    }
    if (method === 'DELETE') {
      db[table] = all.filter((r) => !rows.includes(r));
      save();
      return json(clone(rows));
    }
    return refuse('この操作はデモの対象外です');
  }

  function rpc(name, body) {
    if (name === 'fn_staff_change_slot') {
      const o = db.orders.find((x) => x.id === body.p_order), s = db.pickup_time_slots.find((x) => x.id === body.p_slot);
      if (!o || !s) return json({ ok: false, message: '予約が見つかりません' });
      Object.assign(o, { pickup_date: body.p_date, pickup_slot_id: s.id, pickup_slot_label: s.label });
      save();
      return json({ ok: true, notified: false });
    }
    if (name === 'fn_reservation_usage') return json([]);
    if (name === 'fn_log_form_event') return json({ ok: true });
    return refuse('この操作は、デモでは行えません（お試し登録で実際にお使いいただけます）');
  }

  const realFetch = window.fetch.bind(window);
  // 返事はページのスクリプトが全部読み込まれてから返す。すぐ返すと、管理画面の最初の表示（予約カレンダーを開く）が
  // order-calendar.js より先に終わってしまい、カレンダーが空のまま出ることがあった（本物は通信に時間がかかるので起きない）
  const ready = new Promise((ok) => document.readyState !== 'loading' ? ok() : document.addEventListener('DOMContentLoaded', () => setTimeout(ok, 0)));
  window.fetch = async (input, init = {}) => {
    await ready;
    try {
      const u = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!u.pathname.startsWith('/demo-api/')) {
        // 同じサイトの静的ファイル（ヘルプなど）だけは読む。それ以外の外部通信はしない
        const m = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();  // Request で渡された POST も素通りさせない
        if (u.origin === location.origin && m === 'GET') return realFetch(input, init);
        return refuse('デモでは外部への通信は行いません');
      }
      const p = u.pathname.slice('/demo-api'.length), method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
      let body = null; try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch {}
      const headers = new Headers(init.headers || {}), prefer = headers.get('Prefer') || '';
      if (p.startsWith('/auth/v1/token')) return json(session);
      if (p.startsWith('/auth/v1/user')) return json(session.user);
      if (p.startsWith('/auth/v1/')) return json({});
      if (p.startsWith('/storage/v1/object/sign/')) {
        // デザインイメージ：デモ同梱の画像を指す（CONFIG.url + "/storage/v1" + signedURL がこのフォルダの画像になる）
        const file = (x) => '/../../../lp/admin-demo/assets/' + String(x).split('/').pop().replace(/[^a-z0-9.-]/gi, '');
        if (body?.paths) return json(body.paths.map((x) => ({ path: x, signedURL: file(x) })));
        return json({ signedURL: file(p) });
      }
      if (p.startsWith('/storage/')) return refuse('デモでは画像のアップロードは行いません');
      // 商品設定アシストの入口は出す（押したときは見本を出すだけ・AIへは送らない）
      if (p.startsWith('/functions/v1/suggest-product') && method === 'GET') return json({ available: true });
      if (p.startsWith('/functions/')) return refuse('メール・LINEの送信、決済、AIの機能はデモでは動きません（お試し登録で実際にお使いいただけます）');
      if (p.startsWith('/rest/v1/rpc/')) return rpc(p.split('/').pop(), body || {});
      if (p.startsWith('/rest/v1/')) {
        const table = p.split('/').pop();
        if (table === 'v_public_tenant') return json(clone(db.tenants));
        return rest(table, method, u.searchParams, body, prefer);
      }
      return refuse('この操作はデモの対象外です');
    } catch (e) { return refuse(e.message); }
  };

  /* ---------- 画面のまわり ---------- */
  const NOTE = 'この操作はデモでは行えません。14日間の無料お試し（カード登録なし）で、実際にお使いいただけます。';
  window.open = () => { alert(NOTE); return null; };
  // 商品の設定：予約画面での確認（別のページを開く）・AIの商品設定アシスト・商品のコピーはデモでは動かさない
  document.addEventListener('click', (e) => {
    // AIは見本だけ（本物のAIのページ・iframe は開かない＝同じブラウザの本物のログインでAIに送らない）
    const ai = e.target.closest('#btn-ai-product, .admin-help-launcher, a[href*="assistant.html"]');
    if (ai) { e.preventDefault(); e.stopImmediatePropagation(); showFeature(ai.id === 'btn-ai-product' ? 'assist' : 'help'); return; }
    const b = e.target.closest('#draft-preview-open, #btn-p-copy');
    if (b) { e.preventDefault(); e.stopImmediatePropagation(); alert(NOTE); }
  }, true);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || a.closest('.admin-demo-banner')) return;
    const href = a.getAttribute('href') || '';
    if (/menu-sheets\.html|reset\.html|assistant\.html/.test(href) || a.id === 'preview-link' || a.origin !== location.origin) { e.preventDefault(); alert(NOTE); }
  }, true);
  /* AIの機能は、デモでは動かさずに「こんな機能です」の見本を出す（2026-10-10 まりほ「存在だけアピールできませんか」）。
   * 中身は使い方マニュアル（第2章・第4章）の手順に合わせた例。AIには何も送らない */
  const FEATURES = {
    assist: {
      title: '商品設定アシスト（AI）',
      lead: 'ケーキの内容を文章で書くだけで、AIが商品の設定案を作ります。確認して直してから、非公開で保存します。',
      body: '<p class="fd-label">たとえば、こう書くと</p>' +
        '<p class="fd-input">いちごのショートケーキ。12cm 3,800円、15cm 4,800円。フルーツは いちご か シャインマスカット（+300円）。メッセージプレートは無料で、文字を聞きたい。</p>' +
        '<p class="fd-label">こんな設定案ができます</p>' +
        '<ul class="fd-result"><li><b>商品名</b>いちごのショートケーキ</li><li><b>サイズと価格</b>12cm 3,800円／15cm 4,800円</li>' +
        '<li><b>選択肢</b>フルーツ：いちご（+0円）・シャインマスカット（+300円）</li><li><b>質問</b>プレートのメッセージ（文字を入力）</li></ul>' +
        '<p class="fd-note">写真や細かい条件は、あとから商品画面で整えて公開します。AIの案はお店で確認してからお使いください。</p>',
    },
    help: {
      title: '使い方をAIに質問',
      lead: '管理画面からそのまま質問できます。使い方マニュアルをもとに、手順を答えます。',
      body: '<div class="fd-chat"><p class="fd-q">定休日はどこで設定する？</p>' +
        '<p class="fd-a">左のメニューの「予約設定」を開き、「定休日」で休みの曜日を押して選びます。画面下の「保存する」を押すと決まります。選んだ曜日は、お客様が受取日に選べなくなります。</p>' +
        '<p class="fd-q">クリスマスだけ定休日に営業したい</p>' +
        '<p class="fd-a">「予約設定」の「臨時休業・臨時営業」で日付を選び、「定休日だけど営業」にして「追加」を押してください。その日はお客様が受取日に選べるようになります。</p></div>' +
        '<p class="fd-note">答えはお店で確認してからお使いください。</p>',
    },
  };
  function showFeature(kind) {
    const f = FEATURES[kind];
    document.getElementById('demo-feature')?.remove();
    const d = document.createElement('dialog');
    d.id = 'demo-feature'; d.className = 'demo-feature';
    d.innerHTML = `<div class="fd-head"><strong>${f.title}</strong><span class="fd-tag">Standard</span><button type="button" class="fd-close" aria-label="閉じる">×</button></div>` +
      `<p class="fd-lead">${f.lead}</p>${f.body}` +
      '<p class="fd-demo">このデモではAIは動きません（画面の見本です）。14日間の無料お試し（カード登録なし）で、実際にお使いいただけます。</p>' +
      '<p class="fd-actions"><a class="admin-demo-signup" href="https://cakebook.jp/signup.html">14日間無料で試す</a><button type="button" class="fd-close2">閉じる</button></p>';
    document.body.append(d);
    const close = () => d.close();
    d.querySelector('.fd-close').onclick = close; d.querySelector('.fd-close2').onclick = close;
    d.addEventListener('click', (e) => { if (e.target === d) close(); });
    d.showModal();
  }

  window.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.className = 'admin-demo-banner';
    bar.innerHTML = '<strong>管理画面の操作デモ</strong><span>架空の店・架空の予約です。操作はこの画面の中だけで、メールなどは送られません。</span>' +
      '<nav><a href="/lp/product-demo/">お客様の予約画面デモ</a><a href="/lp/">サービス紹介に戻る</a><a class="admin-demo-signup" href="https://cakebook.jp/signup.html">14日間無料で試す</a><button type="button" id="admin-demo-reset">最初から</button></nav>';
    document.body.prepend(bar);
    const off = () => document.documentElement.style.setProperty('--demo-off', Math.max(0, bar.offsetHeight - window.scrollY) + 'px');
    off(); window.addEventListener('scroll', off, { passive: true }); window.addEventListener('resize', off);
    document.getElementById('admin-demo-reset').onclick = () => {
      try { sessionStorage.removeItem(STORE); localStorage.setItem(SESSION, JSON.stringify(session)); } catch {}
      location.href = location.pathname;
    };
  });
})();
