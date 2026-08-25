/* =====================================================================
 * pokke予約システム 顧客フォーム v1（ビルド不要の静的アプリ）
 * - カタログ取得: PostgREST（anonキー・RLSで公開範囲のみ）
 * - 残枠: RPC fn_get_availability（open/few/full/closed）
 * - 注文確定: RPC fn_place_order（金額・制約はすべてサーバー側で最終検証）
 * - 排他ペア: 矛盾する選択肢は非表示。前の選択を変えて矛盾したら自動で外して通知
 * ===================================================================== */

const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
  // 本番はサブドメインから店舗を判定。開発中は ?shop= で指定（既定 pokke）
  shop: new URLSearchParams(location.search).get("shop") || "pokke",
};

const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + n.toLocaleString("ja-JP");

/* ---------- 変更モード（?edit=<manage_token> で既存予約を読み込んで差し替え） ---------- */
const EDIT_TOKEN = new URLSearchParams(location.search).get("edit");
const EDIT_MODE = !!EDIT_TOKEN;
let EDIT_ORDER = null;   // fn_manage_get_order の order（変更前の内容）
const SUBMIT_LABEL = EDIT_MODE ? "この内容に変更する" : "この内容で注文する";

const state = {
  tenant: null,
  products: [],
  questions: [],
  slots: [],
  sel: {
    product: null,     // 商品オブジェクト
    variant: null,     // サイズオブジェクト
    options: new Map(),// option_id -> {qty, text}（textは記入欄付きオプション用）
    answers: new Map(),// question_id -> {text, choiceId}
    date: null,        // 'YYYY-MM-DD'
    slot: null,        // slotオブジェクト
  },
  calMonth: null,      // カレンダー表示月（Date, 1日固定）
  avail: {},           // 'YYYY-MM-DD' -> status
};

/* ---------- API ---------- */
async function api(path) {
  const res = await fetch(CONFIG.url + path, {
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}
async function rpc(name, args) {
  const res = await fetch(`${CONFIG.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`RPC ${name} ${res.status}: ${await res.text()}`);
  return res.json();
}

/* ---------- 郵便番号→住所の自動入力（zipcloud） ---------- */
function setupPostalLookup() {
  const postal = $("cust-postal");
  if (!postal) return;
  let lastLooked = "";
  postal.addEventListener("input", async () => {
    const digits = postal.value.replace(/[^0-9]/g, "");
    if (digits.length !== 7 || digits === lastLooked) return;
    lastLooked = digits;
    try {
      const r = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${digits}`);
      const j = await r.json();
      const hit = j?.results?.[0];
      if (!hit) { $("postal-hint").textContent = "該当する住所が見つかりませんでした。手入力をお願いします"; return; }
      const auto = `${hit.address1}${hit.address2}${hit.address3}`;
      const addr = $("cust-address");
      // 手で入力済みの住所は消さない（自動入力より人の入力を優先）
      if (!addr.value.trim() || addr.value === addr.dataset.autofilled) {
        addr.value = auto;
        addr.dataset.autofilled = auto;
        $("postal-hint").textContent = "続けて番地・建物名をご記入ください";
        addr.focus();
        addr.setSelectionRange(addr.value.length, addr.value.length);
      }
    } catch { /* 検索できなくても手入力できるので何もしない */ }
  });
}
setupPostalLookup();

/* ---------- 計測（プレビュー効果の検証用・個人情報は送らない） ---------- */
const SESSION_ID = (crypto.randomUUID
  ? crypto.randomUUID()
  : String(Date.now()) + Math.random().toString(16).slice(2));
function track(step, detail) {
  if (!state.tenant || RESTORING || EDIT_MODE) return;  // 変更モードは新規のファネル計測を汚さない
  fetch(`${CONFIG.url}/rest/v1/rpc/fn_log_form_event`, {
    method: "POST",
    headers: {
      apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p: {
      tenant_id: state.tenant.id,
      session_id: SESSION_ID,
      step,
      product_id: state.sel?.product?.id ?? null,
      detail: detail ?? {},
    } }),
    keepalive: true,
  }).catch(() => {});   // 計測の失敗が注文の邪魔をしないこと
}

/* ---------- 入力途中の自動保存（更新しても続きから再開できる） ---------- */
const SAVE_KEY = `cake_form_${CONFIG.shop}`;
let RESTORING = false;

function saveState() {
  if (RESTORING || EDIT_MODE || !state.tenant) return;  // 変更モードは自動保存を使わない（新規予約の下書きを壊さない）
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      savedAt: Date.now(),
      product_id: state.sel.product?.id ?? null,
      variant_id: state.sel.variant?.id ?? null,
      options: [...state.sel.options],
      answers: [...state.sel.answers],
      date: state.sel.date,
      slot_id: state.sel.slot?.id ?? null,
      customer: {
        sei: $("cust-sei")?.value ?? "", mei: $("cust-mei")?.value ?? "",
        seiKana: $("cust-sei-kana")?.value ?? "", meiKana: $("cust-mei-kana")?.value ?? "",
        phone: $("cust-phone")?.value ?? "", email: $("cust-email")?.value ?? "",
        postal: $("cust-postal")?.value ?? "", address: $("cust-address")?.value ?? "",
      },
    }));
  } catch { /* ストレージが使えない環境では保存しないだけ */ }
}
let _saveTimer = null;
document.addEventListener("input", () => { clearTimeout(_saveTimer); _saveTimer = setTimeout(saveState, 400); });

function clearSavedState() { try { localStorage.removeItem(SAVE_KEY); } catch {} }

async function restoreSaved() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch {}
  if (!saved || Date.now() - (saved.savedAt || 0) > 24 * 3600 * 1000) return;

  RESTORING = true;   // 復元中は計測イベントと再保存を止める
  try {
    const c = saved.customer || {};
    if ($("cust-sei")) {
      $("cust-sei").value = c.sei || ""; $("cust-mei").value = c.mei || "";
      $("cust-sei-kana").value = c.seiKana || ""; $("cust-mei-kana").value = c.meiKana || "";
      $("cust-phone").value = c.phone || ""; $("cust-email").value = c.email || "";
      if ($("cust-postal")) { $("cust-postal").value = c.postal || ""; $("cust-address").value = c.address || ""; }
    }
    const p = state.products.find((x) => x.id === saved.product_id);
    if (!p) return;
    selectProduct(p);
    const v = p.product_variants.find((x) => x.id === saved.variant_id);
    if (!v) return;
    selectVariant(v);
    // 選択肢: いまも存在するものだけ復元
    const validIds = new Set(p.option_groups.flatMap((g) => g.options.map((o) => o.id)));
    state.sel.options = new Map((saved.options || []).filter(([id]) => validIds.has(id)));
    state.sel.answers = new Map(saved.answers || []);
    renderGroups();
    updatePreview();
    updatePriceBar();
    // 受取日: 過去日になっていたら日付だけ諦める（他は残す）
    const todayKey = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    if (saved.date && saved.date >= todayKey) {
      await selectDate(saved.date);
      const slot = state.slots.find((x) => x.id === saved.slot_id);
      if (slot && !state.slotFull?.[slot.id]) { state.sel.slot = slot; renderSlots(); }
    }
    renderQuestions();
    toast("前回の入力内容を復元しました");
  } finally {
    RESTORING = false;
  }
}

/* ---------- 初期ロード ---------- */
async function load() {
  const tenants = await api(`/rest/v1/v_public_tenant?subdomain=eq.${CONFIG.shop}&select=*`);
  if (!tenants.length) { $("shop-name").textContent = "店舗が見つかりません"; return; }
  state.tenant = tenants[0];
  track("form_open");
  // お客様情報の項目設定（住所を聞くか・必須か）は店の設定に従う
  const addrCfg = state.tenant.customer_form?.address ?? { enabled: false, required: false };
  if (addrCfg.enabled && $("field-postal")) {
    $("field-postal").classList.remove("hidden");
    $("field-address").classList.remove("hidden");
    if (addrCfg.required) {
      $("req-postal").classList.remove("hidden");
      $("req-address").classList.remove("hidden");
    }
  }
  document.title = `${state.tenant.name}｜オーダーケーキのご予約`;
  $("shop-name").textContent = state.tenant.name;
  if (state.tenant.theme?.primary) {
    document.documentElement.style.setProperty("--primary", state.tenant.theme.primary);
  }

  const T = state.tenant.id;
  [state.products, state.questions, state.slots] = await Promise.all([
    api(`/rest/v1/products?tenant_id=eq.${T}&order=display_order` +
        `&select=*,product_variants(*),option_groups(*,options(*,shared_list_items(name,note))),option_exclusions(*)`),
    api(`/rest/v1/common_questions?tenant_id=eq.${T}&order=display_order` +
        `&select=*,common_question_choices(*),common_question_products(*)`),
    api(`/rest/v1/pickup_time_slots?tenant_id=eq.${T}&order=display_order&select=*`),
  ]);
  renderProducts();
  if (EDIT_MODE) {
    await enterEditMode();
  } else {
    await restoreSaved();
  }
}

/* ---------- 変更モードの初期化：既存予約を読み込んでフォームに展開 ---------- */
async function enterEditMode() {
  let r = null;
  try { r = await rpc("fn_manage_get_order", { p_token: EDIT_TOKEN }); } catch { /* 下で弾く */ }
  if (!r?.ok || !r.allowed?.content) {
    // 期限切れ・キャンセル済みなどは管理ページに戻して理由を表示させる
    location.replace(`manage.html?t=${encodeURIComponent(EDIT_TOKEN)}`);
    return;
  }
  EDIT_ORDER = r.order;
  RESTORING = true;
  try {
    document.querySelector(".shop-sub").textContent = `ご予約内容の変更（No.${EDIT_ORDER.order_number}）`;
    document.title = `${state.tenant.name}｜ご予約内容の変更`;
    $("btn-submit").textContent = SUBMIT_LABEL;

    const c = EDIT_ORDER.customer || {};
    const [sei = "", mei = ""] = (c.name || "").split(/[ 　]+/);
    const [seiK = "", meiK = ""] = (c.kana || "").split(/[ 　]+/);
    $("cust-sei").value = sei; $("cust-mei").value = mei;
    $("cust-sei-kana").value = seiK; $("cust-mei-kana").value = meiK;
    $("cust-phone").value = c.phone || ""; $("cust-email").value = c.email || "";
    if ($("cust-postal")) {
      $("cust-postal").value = c.postal_code || "";
      $("cust-address").value = c.address || "";
    }

    const p = state.products.find((x) => x.id === EDIT_ORDER.product_id);
    if (!p) {
      toast("このご予約の商品は現在お取り扱いがないため、この画面では変更できません。お店までご連絡ください");
      return;
    }
    selectProduct(p);
    const v = p.product_variants.find((x) => x.id === EDIT_ORDER.variant_id);
    if (v) selectVariant(v);

    const validIds = new Set(p.option_groups.flatMap((g) => g.options.map((o) => o.id)));
    state.sel.options = new Map((EDIT_ORDER.options || [])
      .filter((o) => o.option_id && validIds.has(o.option_id))
      .map((o) => [o.option_id, { qty: o.quantity || 1, text: o.text || "" }]));
    state.sel.answers = new Map((EDIT_ORDER.answers || [])
      .filter((a) => a.question_id)
      .map((a) => [a.question_id, { text: a.answer_text, choiceId: a.choice_id }]));
    renderGroups();
    updatePreview();
    updatePriceBar();

    // 受取日時：予約中の日時をそのまま展開（日を変えなければ締切に関係なく変更を確定できる）
    const [ey, em] = EDIT_ORDER.pickup_date.split("-").map(Number);
    state.calMonth = new Date(ey, em - 1, 1);
    await loadCalendar();
    await selectDate(EDIT_ORDER.pickup_date);
    const slot = state.slots.find((x) => x.id === EDIT_ORDER.pickup_slot_id);
    if (slot) { state.sel.slot = slot; renderSlots(); }
    renderQuestions();
    toast("いまのご予約内容を読み込みました。変更したいところを直してください");
  } finally {
    RESTORING = false;
  }
}

/* ---------- ユーティリティ ---------- */
const optName = (o) => o.name || o.shared_list_items?.name || "";
const optNote = (o) => o.note || o.shared_list_items?.note || "";
const optDesc = (o) => o.description || "";
function sortedGroups(p) { return [...p.option_groups].sort((a, b) => a.display_order - b.display_order); }
function sortedOpts(g) { return [...g.options].sort((a, b) => a.display_order - b.display_order); }
function findOption(id) {
  for (const g of state.sel.product.option_groups)
    for (const o of g.options) if (o.id === id) return { o, g };
  return null;
}
// 排他: idと衝突する選択済みオプションの一覧
function conflictsWithSelected(id) {
  const pairs = state.sel.product.option_exclusions || [];
  const hits = [];
  for (const pr of pairs) {
    const other = pr.option_a === id ? pr.option_b : pr.option_b === id ? pr.option_a : null;
    if (other && state.sel.options.has(other)) hits.push(other);
  }
  return hits;
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  t.style.opacity = 1;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.classList.add("hidden"), 400); }, 3200);
}

/* ---------- 金額 ---------- */
function currentTotal() {
  if (!state.sel.variant) return null;
  let total = state.sel.variant.price;
  for (const [id, v] of state.sel.options) {
    const f = findOption(id);
    if (f) total += f.o.price_delta * v.qty;
  }
  for (const [qid, a] of state.sel.answers) {
    if (a.choiceId) {
      const q = state.questions.find((x) => x.id === qid);
      const c = q?.common_question_choices.find((x) => x.id === a.choiceId);
      if (c) total += c.price_delta;
    }
  }
  return total;
}
function updatePriceBar() {
  const t = currentTotal();
  if (t == null) {
    $("price-summary").textContent = "ケーキを選んでください";
    $("price-total").textContent = "";
  } else {
    $("price-summary").textContent =
      `${state.sel.product.name} ${state.sel.variant.size_label}`;
    $("price-total").textContent = yen(t) + "（税込）";
  }  saveState();
}

/* ---------- 1. 商品 ---------- */
const EMOJI = { "生クリームデコレーション": "🍰", "フルーツタルト": "🥧", "チョコレートケーキ": "🍫", "バスクチーズケーキ": "🧀" };
function renderProducts() {
  const wrap = $("product-cards");
  wrap.innerHTML = "";
  for (const p of state.products) {
    const prices = p.product_variants.filter((v) => v.is_available).map((v) => v.price);
    const el = document.createElement("div");
    el.className = "card" + (state.sel.product?.id === p.id ? " selected" : "");
    const visual = p.photo_url
      ? `<div class="card-photo"><img src="${p.photo_url}" alt="${p.name}" loading="lazy"></div>`
      : `<div class="card-emoji">${EMOJI[p.name] || "🎂"}</div>`;
    el.innerHTML = `
      ${visual}
      <div class="card-name">${p.name}</div>
      <div class="card-desc">${p.description || ""}</div>
      <div class="card-price">${yen(Math.min(...prices))}〜</div>`;
    el.onclick = () => selectProduct(p);
    wrap.appendChild(el);
  }
}
/* ---------- プレビュー ----------
 * 優先順位（商品ごとに自動で切り替わる。店側のモード設定は不要）
 *   1. イラスト土台がある → 選択内容に応じてレイヤーを合成
 *   2. 商品写真がある     → 写真を表示
 *   3. どちらもない       → 絵文字
 */
const LAYER_CANVAS = 800;
const imgCache = new Map();
function loadImg(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 読めない素材は飛ばす（プレビューは止めない）
    img.src = url;
  });
  imgCache.set(url, p);
  return p;
}

// 今の選択内容から、重ねる素材を下から順に並べる
function currentLayers() {
  const p = state.sel.product;
  if (!p?.layer_url) return null;
  const layers = [{ url: p.layer_url, z: 0 }];
  for (const g of sortedGroups(p)) {
    const selectedInGroup = g.options.filter((o) => state.sel.options.has(o.id));
    if (selectedInGroup.length) {
      for (const o of selectedInGroup) {
        if (o.layer_url) layers.push({ url: o.layer_url, z: o.layer_z ?? 50 });
      }
    } else if (g.default_layer_url) {
      // 何も選ばれていないグループの既定イラスト（例: 仕上げ未選択時のノーマルデコ）
      layers.push({ url: g.default_layer_url, z: g.default_layer_z ?? 50 });
    }
  }
  return layers.sort((a, b) => a.z - b.z);
}

let previewToken = 0;
async function updatePreview() {
  const box = $("preview-canvas");
  const p = state.sel.product;
  const layers = currentLayers();

  if (layers) {
    const token = ++previewToken;
    let canvas = box.querySelector("canvas");
    if (!canvas) {
      box.innerHTML = "";
      canvas = document.createElement("canvas");
      canvas.width = LAYER_CANVAS;
      canvas.height = LAYER_CANVAS;
      box.appendChild(canvas);
    }
    const imgs = await Promise.all(layers.map((l) => loadImg(l.url)));
    if (token !== previewToken) return; // 描画中に選択が変わったら破棄
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, LAYER_CANVAS, LAYER_CANVAS);
    for (const img of imgs) {
      if (img) ctx.drawImage(img, 0, 0, LAYER_CANVAS, LAYER_CANVAS);
    }
    return;
  }

  if (p?.photo_url) {
    box.innerHTML = `<img src="${p.photo_url}" alt="${p.name}">`;
  } else {
    box.innerHTML = `<span class="preview-placeholder">${p ? (EMOJI[p.name] || "🎂") : "🎂"}</span>`;
  }
}

function selectProduct(p) {
  state.sel.product = p;
  track("product_selected");
  state.sel.variant = null;
  state.sel.options.clear();
  state.sel.date = null;
  state.sel.slot = null;
  renderProducts();
  updatePreview();
  renderSizes();
  $("sec-size").classList.remove("hidden");
  ["sec-groups", "sec-date", "sec-questions", "sec-customer"].forEach((s) => $(s).classList.add("hidden"));
  $("sec-size").scrollIntoView({ behavior: "smooth", block: "center" });
  updatePriceBar();
}

/* ---------- 2. サイズ ---------- */
function renderSizes() {
  const wrap = $("size-pills");
  wrap.innerHTML = "";
  const vs = [...state.sel.product.product_variants]
    .filter((v) => v.is_available)
    .sort((a, b) => a.display_order - b.display_order);
  for (const v of vs) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "pill" + (state.sel.variant?.id === v.id ? " selected" : "");
    el.textContent = `${v.size_label}　${yen(v.price)}`;
    el.onclick = () => selectVariant(v);
    wrap.appendChild(el);
  }
}
function selectVariant(v) {
  state.sel.variant = v;
  track("size_selected");
  renderSizes();
  renderGroups();
  $("sec-groups").classList.toggle("hidden", !state.sel.product.option_groups.length);
  // 受取日はサイズ確定後に（サイズ別上限があるため）
  state.sel.date = null;
  state.sel.slot = null;
  state.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  $("sec-date").classList.remove("hidden");
  $("slot-area").classList.add("hidden");
  loadCalendar();
  renderQuestions();
  $("sec-questions").classList.toggle("hidden", !visibleQuestions().length);
  $("sec-customer").classList.remove("hidden");
  updatePriceBar();
}

/* ---------- 3. 選択グループ（排他＝非表示で強制） ---------- */
function renderGroups() {
  const wrap = $("group-list");
  wrap.innerHTML = "";
  // 商品の注意書き（あれば先頭に表示）
  if (state.sel.product.note) {
    const pn = document.createElement("p");
    pn.className = "group-note product-note" + (state.sel.product.note_accent ? " note-accent" : "");
    pn.textContent = state.sel.product.note;
    wrap.appendChild(pn);
  }
  for (const g of sortedGroups(state.sel.product)) {
    const box = document.createElement("div");
    box.className = "group";
    box.innerHTML = `<h3>${g.name}${g.is_required ? '<span class="req">必須</span>' : ""}</h3>` +
      (g.description ? `<p class="group-desc">${g.description}</p>` : "") +
      (g.note ? `<p class="group-note${g.note_accent ? " note-accent" : ""}">${g.note}</p>` : "");
    for (const o of sortedOpts(g)) {
      if (!o.is_available) continue;
      // 共有リスト由来なのに項目が取れない=停止中（RLSで非表示）→ 出さない
      if (o.shared_list_item_id && !o.shared_list_items) continue;
      if (conflictsWithSelected(o.id).length && !state.sel.options.has(o.id)) continue; // 排他→非表示
      const row = document.createElement("label");
      row.className = "opt";
      const type = g.selection_type === "single" ? "radio" : "checkbox";
      const selected = state.sel.options.has(o.id);
      const sel = selected ? state.sel.options.get(o.id) : null;
      const price = o.price_delta ? `+${yen(o.price_delta)}` : "無料";
      // 枚数はステッパー（−/＋）で。数字入力欄だけだと枚数と気づけない（まりほ指摘 2026-08-24）
      const qtyUi = (o.max_quantity || 1) > 1 && selected
        ? `<span class="qty-stepper" role="group" aria-label="枚数">
             <button type="button" class="qty-btn qty-minus" aria-label="減らす">−</button>
             <span class="qty-count">${sel.qty}<small>枚</small></span>
             <button type="button" class="qty-btn qty-plus" aria-label="増やす">＋</button>
           </span>`
        : "";
      row.innerHTML = `
        <input type="${type}" name="g-${g.id}" ${selected ? "checked" : ""}>
        ${o.photo_url ? `<span class="opt-photo"><img src="${o.photo_url}" alt="" loading="lazy"></span>` : ""}
        <span class="opt-name">${optName(o)}${optDesc(o) ? `<span class="opt-desc">${optDesc(o)}</span>` : ""}${optNote(o) ? `<span class="opt-note${o.note_accent ? " note-accent" : ""}">${optNote(o)}</span>` : ""}</span>
        ${qtyUi}
        <span class="opt-price">${price}</span>`;
      const input = row.querySelector("input");
      input.onclick = (e) => { e.stopPropagation(); toggleOption(g, o, input); };
      const stepper = row.querySelector(".qty-stepper");
      if (stepper) {
        stepper.onclick = (e) => e.stopPropagation();
        const countEl = stepper.querySelector(".qty-count");
        const step = (delta) => {
          const cur = state.sel.options.get(o.id).qty;
          const v = Math.max(1, Math.min(o.max_quantity, cur + delta));
          state.sel.options.get(o.id).qty = v;
          countEl.innerHTML = `${v}<small>枚</small>`;
          stepper.querySelector(".qty-minus").disabled = v <= 1;
          stepper.querySelector(".qty-plus").disabled = v >= o.max_quantity;
          updatePriceBar();
        };
        stepper.querySelector(".qty-minus").onclick = (e) => { e.stopPropagation(); step(-1); };
        stepper.querySelector(".qty-plus").onclick = (e) => { e.stopPropagation(); step(1); };
        stepper.querySelector(".qty-minus").disabled = sel.qty <= 1;
        stepper.querySelector(".qty-plus").disabled = sel.qty >= o.max_quantity;
      }
      box.appendChild(row);
      // 記入欄付きオプション（例: ナンバークッキーの数字）: 選択中だけ入力欄を出す
      if (selected && o.text_prompt) {
        const tf = document.createElement("div");
        tf.className = "opt-textfield";
        tf.innerHTML = `<input type="text" placeholder="${o.text_prompt}" value="${sel.text || ""}">`;
        const ti = tf.querySelector("input");
        ti.oninput = () => { state.sel.options.get(o.id).text = ti.value; };
        box.appendChild(tf);
      }
    }
    wrap.appendChild(box);
  }
}
function toggleOption(g, o, input) {
  if (g.selection_type === "single") {
    const wasSelected = state.sel.options.has(o.id);
    // 同グループの他選択を外す
    for (const other of g.options) state.sel.options.delete(other.id);
    if (!wasSelected) state.sel.options.set(o.id, { qty: 1, text: "" });
    input.checked = !wasSelected; // ラジオでも再クリックで解除できるように
  } else {
    if (state.sel.options.has(o.id)) state.sel.options.delete(o.id);
    else state.sel.options.set(o.id, { qty: 1, text: "" });
  }
  // 新しい選択と矛盾する既選択を自動で外して通知（例: 桃 → チョコがけ茶が外れる）
  if (state.sel.options.has(o.id)) {
    for (const otherId of conflictsWithSelected(o.id)) {
      const f = findOption(otherId);
      state.sel.options.delete(otherId);
      toast(`「${optName(f.o)}」は「${optName(o)}」と組み合わせできないため外れました`);
    }
  }
  renderGroups();
  renderQuestions(); // 条件付き質問（選択肢トリガー）の表示を更新
  $("sec-questions").classList.toggle("hidden", !visibleQuestions().length);
  updatePriceBar();
  updatePreview(); // 選択に応じてイラストを組み直す
  // 選択肢の「できない日」を反映してカレンダーを引き直す（表示中なら常に）
  if (state.sel.variant) {
    loadCalendar().then(() => {
      if (state.sel.date) {
        const st = state.avail[state.sel.date];
        if (st !== "open" && st !== "few") {
          state.sel.date = null;
          state.sel.slot = null;
          $("slot-area").classList.add("hidden");
          renderCalendar();
          toast("選んだ内容がご用意できない日のため、受取日を選び直してください");
        }
      }
    });
  }
}

/* ---------- 4. カレンダー・時間枠 ---------- */
const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
async function loadCalendar() {
  const m = state.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
  $("cal-title").textContent = `${m.getFullYear()}年${m.getMonth() + 1}月`;
  $("cal-grid").innerHTML = '<div class="dow">読み込み中…</div>';
  try {
    const optIds = [...state.sel.options.keys()];
    const rows = await rpc("fn_get_availability", {
      p_tenant: state.tenant.id,
      p_product: state.sel.product.id,
      p_variant: state.sel.variant.id,
      p_from: fmtDate(first),
      p_to: fmtDate(last),
      p_options: optIds.length ? optIds : null, // 選択肢の「できない日」も反映
    });
    state.avail = Object.fromEntries(rows.map((r) => [r.d, r.status]));
    renderCalendar();
  } catch (e) {
    $("cal-grid").innerHTML = '<div class="dow">読み込みに失敗しました</div>';
  }
}
function renderCalendar() {
  const grid = $("cal-grid");
  grid.innerHTML = "";
  for (const d of ["日", "月", "火", "水", "木", "金", "土"]) {
    const el = document.createElement("div");
    el.className = "dow";
    el.textContent = d;
    grid.appendChild(el);
  }
  const m = state.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  for (let i = 0; i < first.getDay(); i++) grid.appendChild(document.createElement("div"));
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const MARK = { open: "●", few: "▲", full: "×", closed: "" };
  for (let day = 1; day <= days; day++) {
    const key = fmtDate(new Date(m.getFullYear(), m.getMonth(), day));
    const st = state.avail[key] || "closed";
    const el = document.createElement("div");
    el.className = `cal-day ${st}` +
      ((st === "open" || st === "few") ? " clickable" : "") +
      (state.sel.date === key ? " selected" : "");
    el.innerHTML = `<span>${day}</span><span class="mark">${MARK[st]}</span>`;
    if (st === "open" || st === "few") el.onclick = () => selectDate(key);
    grid.appendChild(el);
  }
  // 前月ボタンは今月まで
  const now = new Date();
  $("cal-prev").disabled = m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth();
}
async function selectDate(key) {
  state.sel.date = key;
  track("date_selected");
  state.sel.slot = null;
  renderCalendar();
  // 枠ごとの満員状況を取得（満員の時間帯はグレーアウト）
  try {
    const rows = await rpc("fn_get_slot_availability", {
      p_tenant: state.tenant.id, p_date: key,
      p_product: state.sel.product.id, p_variant: state.sel.variant.id,
    });
    state.slotFull = Object.fromEntries(rows.map((r) => [r.slot_id, r.is_full]));
    // 変更モード：いま予約している枠は「満員」でも選べる（自分の分を除けば空くため。最終判定はサーバー）
    if (EDIT_MODE && EDIT_ORDER && key === EDIT_ORDER.pickup_date) {
      state.slotFull[EDIT_ORDER.pickup_slot_id] = false;
    }
  } catch { state.slotFull = {}; }
  renderSlots();
  saveState();
  $("slot-area").classList.remove("hidden");
  $("slot-area").scrollIntoView({ behavior: "smooth", block: "center" });
}
function renderSlots() {
  const wrap = $("slot-pills");
  wrap.innerHTML = "";
  for (const s of state.slots) {
    const full = state.slotFull?.[s.id];
    const el = document.createElement("button");
    el.type = "button";
    el.className = "pill" + (state.sel.slot?.id === s.id ? " selected" : "") + (full ? " full" : "");
    el.textContent = s.label + (full ? "（満員）" : "");
    if (full) el.disabled = true;
    else el.onclick = () => { state.sel.slot = s; renderSlots(); saveState(); };
    wrap.appendChild(el);
  }
}
$("cal-prev").onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); loadCalendar(); };
$("cal-next").onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); loadCalendar(); };

/* ---------- 5. 共通質問 ---------- */
function visibleQuestions() {
  return state.questions.filter((q) =>
    q.is_active !== false &&
    (q.scope === "all" ||
     q.common_question_products.some((x) => x.product_id === state.sel.product.id)) &&
    // 表示条件: この選択肢を選んだときだけ表示（例: ジェンダーリビール→性別の質問）
    (!q.trigger_option_id || state.sel.options.has(q.trigger_option_id)));
}
function renderQuestions() {
  const wrap = $("question-list");
  wrap.innerHTML = "";
  for (const q of visibleQuestions()) {
    const field = document.createElement("label");
    field.className = "field";
    let inputHtml = "";
    if (q.input_type === "textarea") {
      inputHtml = `<textarea rows="3"></textarea>`;
    } else if (q.input_type === "select") {
      const opts = q.common_question_choices
        .filter((c) => c.is_available)
        .sort((a, b) => a.display_order - b.display_order)
        .map((c) => `<option value="${c.id}">${c.label}${c.price_delta ? `（+${yen(c.price_delta)}）` : ""}</option>`)
        .join("");
      inputHtml = `<select><option value="">選択してください</option>${opts}</select>`;
    } else {
      inputHtml = `<input type="text">`;
    }
    field.innerHTML = `${q.label}${q.is_required ? '<span class="req">必須</span>' : ""}` +
      (q.help_text ? `<span class="help">${q.help_text}</span>` : "") + inputHtml;
    const input = field.querySelector("input,textarea,select");
    // 再描画時に入力済みの内容を復元
    const saved = state.sel.answers.get(q.id);
    if (saved) input.value = (q.input_type === "select" ? saved.choiceId : saved.text) || "";
    input.oninput = () => {
      if (q.input_type === "select") {
        state.sel.answers.set(q.id, { text: null, choiceId: input.value || null });
      } else {
        state.sel.answers.set(q.id, { text: input.value, choiceId: null });
      }
      updatePriceBar();
    };
    wrap.appendChild(field);
  }
}

/* ---------- 6. 確認 → 注文 ---------- */
function validate() {
  const s = state.sel;
  if (!s.product || !s.variant) return "ケーキとサイズを選んでください";
  for (const g of s.product.option_groups) {
    if (g.is_required && ![...s.options.keys()].some((id) => g.options.some((o) => o.id === id)))
      return `「${g.name}」を選択してください`;
  }
  for (const [id, v] of s.options) {
    const f = findOption(id);
    if (f?.o.text_prompt && !(v.text || "").trim())
      return `「${optName(f.o)}」：${f.o.text_prompt}`;
  }
  if (!s.date) return "受取日を選んでください";
  if (!s.slot) return "受取時間を選んでください";
  for (const q of visibleQuestions()) {
    if (!q.is_required) continue;
    const a = s.answers.get(q.id);
    if (!a || (!a.choiceId && !(a.text || "").trim())) return `「${q.label}」にご記入ください`;
  }
  if (!$("cust-sei").value.trim() || !$("cust-mei").value.trim()) return "お名前（姓・名）をご記入ください";
  if (!$("cust-sei-kana").value.trim() || !$("cust-mei-kana").value.trim()) return "フリガナ（セイ・メイ）をご記入ください";
  const addrReq = state.tenant.customer_form?.address;
  if (addrReq?.enabled && addrReq?.required && $("cust-postal")) {
    if (!$("cust-postal").value.trim()) return "郵便番号をご記入ください";
    if (!$("cust-address").value.trim()) return "ご住所をご記入ください";
  }
  if (!$("cust-phone").value.trim()) return "お電話番号をご記入ください";
  const email = $("cust-email").value.trim();
  if (!email || !email.includes("@")) return "メールアドレスをご確認ください";
  return null;
}

$("btn-confirm").onclick = () => {
  const err = validate();
  if (err) { toast(err); return; }
  renderConfirm();
  track("confirm_viewed", { option_count: state.sel.options.size });
  $("view-form").classList.add("hidden");
  $("view-confirm").classList.remove("hidden");
  $("price-bar").classList.add("hidden");
  window.scrollTo({ top: 0 });
};
$("btn-back").onclick = () => {
  $("view-confirm").classList.add("hidden");
  $("view-form").classList.remove("hidden");
  $("price-bar").classList.remove("hidden");
};

function renderConfirm() {
  const s = state.sel;
  const rows = [];
  const row = (k, v) => rows.push(`<div class="confirm-row"><span class="k">${k}</span><span>${v}</span></div>`);
  row("ケーキ", `${s.product.name} ${s.variant.size_label}`);
  row("価格", yen(s.variant.price));
  for (const [id, v] of s.options) {
    const f = findOption(id);
    const price = f.o.price_delta ? `+${yen(f.o.price_delta * v.qty)}` : "無料";
    const text = (v.text || "").trim() ? `「${v.text.trim()}」` : "";
    row(f.g.name, `${optName(f.o)}${v.qty > 1 ? ` ×${v.qty}` : ""}${text}（${price}）`);
  }
  for (const q of visibleQuestions()) {
    const a = s.answers.get(q.id);
    if (!a) continue;
    let v = a.text || "";
    if (a.choiceId) {
      const c = q.common_question_choices.find((x) => x.id === a.choiceId);
      v = c ? c.label + (c.price_delta ? `（+${yen(c.price_delta)}）` : "") : "";
    }
    if (v) row(q.label, v);
  }
  const [y, m, d] = s.date.split("-");
  row("受取日時", `${y}年${+m}月${+d}日 ${s.slot.label}`);
  row("お名前", `${$("cust-sei").value.trim()} ${$("cust-mei").value.trim()}`);
  row("フリガナ", `${$("cust-sei-kana").value.trim()} ${$("cust-mei-kana").value.trim()}`);
  row("お電話", $("cust-phone").value.trim());
  row("メール", $("cust-email").value.trim());
  if ($("cust-address") && $("cust-address").value.trim())
    row("ご住所", `${$("cust-postal").value.trim()} ${$("cust-address").value.trim()}`.trim());
  row("お支払い", "店頭でのお支払い");
  rows.push(`<div class="confirm-row total"><span class="k">合計（税込）</span><span>${yen(currentTotal())}</span></div>`);
  $("confirm-detail").innerHTML = rows.join("");
  $("cancel-policy").textContent = state.tenant.cancel_policy || "";
}

$("btn-submit").onclick = async () => {
  const btn = $("btn-submit");
  btn.disabled = true;
  btn.textContent = "送信中…";
  $("submit-error").classList.add("hidden");
  try {
    const s = state.sel;
    const payload = {
      p: {
        tenant_id: state.tenant.id,
        product_id: s.product.id,
        variant_id: s.variant.id,
        quantity: 1,
        pickup_date: s.date,
        pickup_slot_id: s.slot.id,
        customer: {
          name: `${$("cust-sei").value.trim()} ${$("cust-mei").value.trim()}`,
          kana: `${$("cust-sei-kana").value.trim()} ${$("cust-mei-kana").value.trim()}`,
          phone: $("cust-phone").value.trim(),
          email: $("cust-email").value.trim(),
          postal_code: $("cust-postal") ? $("cust-postal").value.trim() || null : null,
          address: $("cust-address") ? $("cust-address").value.trim() || null : null,
        },
        payment_method: "store",
        options: [...s.options].map(([option_id, v]) => ({
          option_id, quantity: v.qty, text: (v.text || "").trim() || null,
        })),
        answers: [...s.answers]
          .filter(([qid, a]) => (a.choiceId || (a.text || "").trim())
            && visibleQuestions().some((q) => q.id === qid)) // 非表示になった質問の残骸は送らない
          .map(([question_id, a]) => ({
            question_id,
            answer_text: a.text ? a.text.trim() : null,
            choice_id: a.choiceId,
          })),
      },
    };
    const r = EDIT_MODE
      ? await rpc("fn_manage_replace", { p_token: EDIT_TOKEN, p: payload.p })
      : await rpc("fn_place_order", payload);
    if (!r.ok) throw new Error(r.message || (EDIT_MODE ? "ご変更を受け付けられませんでした" : "ご注文を受け付けられませんでした"));

    // 確認メールの送信をキック（失敗しても注文は成立済みなので握りつぶす）
    fetch(`${CONFIG.url}/functions/v1/send-order-emails`, {
      method: "POST",
      headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}` },
    }).catch(() => {});
    track("order_placed", { option_count: s.options.size, amount: r.total_amount });
    if (EDIT_MODE) {
      $("view-done").querySelector("h2").textContent = "ご予約内容を変更しました";
    }
    $("done-number").textContent = `No.${r.order_number}`;
    $("done-total").textContent = yen(r.total_amount);
    const [y, m, d] = s.date.split("-");
    $("done-pickup").textContent =
      `${y}年${+m}月${+d}日 ${s.slot.label} に${state.tenant.name}でお渡しします。` +
      (EDIT_MODE ? "変更後の内容で確認メールをお送りします。" : "確認のご連絡をお待ちください。");
    $("view-confirm").classList.add("hidden");
    if (!EDIT_MODE) clearSavedState();
    // 変更・キャンセル用の専用リンク（確認メールにも同じものが載る）
    if (r.manage_token && !$("done-manage-link")) {
      const p2 = document.createElement("p");
      p2.className = "small";
      p2.id = "done-manage-link";
      p2.innerHTML = `ご予約の変更・キャンセルは<a href="manage.html?t=${r.manage_token}">こちらのページ</a>から（確認メールにも同じリンクが届きます）`;
      $("view-done").querySelector(".done-box").appendChild(p2);
    }
    $("view-done").classList.remove("hidden");
    window.scrollTo({ top: 0 });
  } catch (e) {
    $("submit-error").textContent = e.message;
    $("submit-error").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = SUBMIT_LABEL;
  }
};

load().catch((e) => {
  $("shop-name").textContent = "読み込みエラー";
  console.error(e);
});
