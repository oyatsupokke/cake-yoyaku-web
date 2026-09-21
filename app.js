/* =====================================================================
 * pokke予約システム 顧客フォーム v1（ビルド不要の静的アプリ）
 * - カタログ取得: PostgREST（anonキー・RLSで公開範囲のみ）
 * - 残枠: RPC fn_get_availability（open/few/full/closed）
 * - 注文確定: RPC fn_place_order（金額・制約はすべてサーバー側で最終検証）
 * - 排他ペア: 矛盾する選択肢は理由つきで無効表示。前段の選択を変えたら後段を自動で外して通知
 * ===================================================================== */

const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
  // 本番はサブドメインから店舗を判定。開発中は ?shop= で指定（既定 pokke）
  shop: new URLSearchParams(location.search).get("shop") || "pokke",
};

const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + n.toLocaleString("ja-JP");

// 管理画面のデザイン見本。お客様の下書きや外側の画面位置に干渉しない。
const THEME_PREVIEW = window.self !== window.top
  && new URLSearchParams(location.search).get("preview") === "theme";

/* ---------- 変更モード（?edit=<manage_token> で既存予約を読み込んで差し替え） ---------- */
const TRIAL_MODE = new URLSearchParams(location.search).get("trial") === "1";
const EDIT_TOKEN = new URLSearchParams(location.search).get("edit");
const EDIT_MODE = !TRIAL_MODE && !!EDIT_TOKEN;
let EDIT_ORDER = null;   // fn_manage_get_order の order（変更前の内容）

/* ---------- 代行登録モード（?staff=1・管理画面ログイン中のみ） ----------
 * 電話で受けた予約をお店が入力する。締切後・満枠・休業日はオレンジ表示になり、
 * 警告つきで選べる（サーバー側も fn_staff_place_order で店のログインを検証）。
 * メールアドレスは空欄OK＝空欄なら確認メールは送られない */
const STAFF_MODE = !TRIAL_MODE && !EDIT_MODE && new URLSearchParams(location.search).get("staff") === "1";
function staffSession() {
  try { return JSON.parse(localStorage.getItem("pokke_admin_session")); } catch { return null; }
}

const SUBMIT_LABEL = TRIAL_MODE ? "テスト予約を確認する" : EDIT_MODE ? "この内容に変更する"
  : STAFF_MODE ? "この内容で登録する" : "この内容で注文する";

const state = {
  tenant: null,
  products: [],
  questions: [],
  slots: [],
  sel: {
    product: null,     // 商品オブジェクト
    variant: null,     // サイズオブジェクト
    options: new Map(),// option_id -> {qty, text}（textは記入欄付きオプション用）
    answers: new Map(),// question_id -> {text, choiceIds[]}（チェックボックスは複数入る）
    date: null,        // 'YYYY-MM-DD'
    slot: null,        // slotオブジェクト
  },
  calMonth: null,      // カレンダー表示月（Date, 1日固定）
  avail: {},           // 'YYYY-MM-DD' -> status
};

/* ---------- API ---------- */
async function api(path) {
  if (TRIAL_MODE && path.startsWith("/rest/v1/v_public_tenant?")) return staffRpc("fn_trial_preview", { p_action: "catalog", p: { shop: CONFIG.shop } });
  const res = await fetch(CONFIG.url + path, {
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${TRIAL_MODE ? staffSession()?.access_token : CONFIG.anonKey}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}
async function rpc(name, args) {
  if (TRIAL_MODE) return staffRpc("fn_trial_preview", { p_action: name, p: { ...args, shop: CONFIG.shop } });
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

/* ---------- 代行登録の送信（管理画面のログイントークンで呼ぶ） ---------- */
async function staffRpc(name, args) {
  const s = staffSession();
  if (!s?.access_token) throw new Error("管理画面にログインしてから、もう一度この画面を開いてください");
  const call = (token) => fetch(`${CONFIG.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: CONFIG.anonKey, Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  let res = await call(s.access_token);
  if (res.status === 401 && s.refresh_token) {
    // トークン切れ→管理画面と同じ保存場所で更新（管理画面側もそのまま使い続けられる）
    const r2 = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (r2.ok) {
      const ns = await r2.json();
      localStorage.setItem("pokke_admin_session", JSON.stringify(ns));
      res = await call(ns.access_token);
    }
  }
  if (res.status === 401) throw new Error("ログインの有効期限が切れました。管理画面にログインし直してください");
  if (!res.ok) throw new Error(`RPC ${name} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function staffPlaceOrder(p) {
  let r = await staffRpc("fn_staff_place_order", { p, p_force: false });
  if (!r.ok && r.staff_confirm) {
    const go = confirm(`${r.message}\n\nこのまま登録しますか？（登録した分も台数として数えられます）`);
    if (!go) return r;
    r = await staffRpc("fn_staff_place_order", { p, p_force: true });
  }
  return r;
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
  if (TRIAL_MODE || !state.tenant || RESTORING || EDIT_MODE || STAFF_MODE) return;  // 変更・代行モードは新規のファネル計測を汚さない
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
const RETRY_ENABLED = !EDIT_MODE && !STAFF_MODE && !TRIAL_MODE && !THEME_PREVIEW;
let bookingRetry;
function retryStore() {
  return bookingRetry ||= new BookingRetry(sessionStorage, `cake_pending_${CONFIG.url}_${CONFIG.shop}`);
}
let RESTORING = false;

function saveState() {
  if (THEME_PREVIEW || TRIAL_MODE) return;
  if (RESTORING || EDIT_MODE || STAFF_MODE || !state.tenant) return;  // 変更・代行モードは自動保存を使わない（お客様の下書きを壊さない）
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

function clearSavedState() { if (THEME_PREVIEW || TRIAL_MODE) return; try { localStorage.removeItem(SAVE_KEY); } catch {} }

// 商品設定が変わった後も、前回入力に「同じ1択グループの複数選択」や排他違反を持ち込まない。
// 大分類から順に復元し、後段で矛盾する選択だけを落とす。
function sanitizeSavedOptions(product, entries) {
  const saved = new Map(entries || []), kept = new Map();
  const pairs = product.option_exclusions || [];
  for (const g of sortedGroups(product)) {
    for (const o of sortedOpts(g)) {
      if (!o.is_available || !saved.has(o.id)) continue;
      if (g.selection_type === "single" && [...kept.keys()].some((id) => g.options.some((x) => x.id === id))) continue;
      const conflict = pairs.some((e) =>
        (e.option_a === o.id && kept.has(e.option_b)) || (e.option_b === o.id && kept.has(e.option_a)));
      if (!conflict) kept.set(o.id, saved.get(o.id));
    }
  }
  return kept;
}

async function restoreSaved() {
  if (THEME_PREVIEW || TRIAL_MODE) return;
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
    if (!p || !onSale(p) || !p.product_variants.some(validVariant)) return;
    selectProduct(p);
    const v = p.product_variants.find((x) => x.id === saved.variant_id && validVariant(x));
    if (!v) return;
    selectVariant(v);
    // 選択肢: いまも存在するものだけ復元
    const validIds = new Set(p.option_groups.flatMap((g) => g.options.map((o) => o.id)));
    state.sel.options = sanitizeSavedOptions(p, (saved.options || []).filter(([id]) => validIds.has(id)));
    ensureRequiredFallbacks();
    state.sel.answers = new Map((saved.answers || []).map(([qid, a]) => [qid, normAnswer(a)]));
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
  if (TRIAL_MODE) {
    const note = document.createElement("p");
    note.textContent = "店舗専用テスト：実予約は作成されず、メール・LINEは送信されません。画像は端末内で確認します。";
    note.className = "confirm-box";
    document.getElementById("app").prepend(note);
  }
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
  // プレビュー枠の注意書きは店ごとの設定（空欄なら1行も出さない）
  const pnote = (state.tenant.preview_note || "").trim();
  $("preview-note").textContent = pnote;
  $("preview-note").classList.toggle("hidden", !pnote);
  document.title = `${state.tenant.name}｜オーダーケーキのご予約`;
  $("shop-name").textContent = state.tenant.name;
  applyTheme(state.tenant.theme);

  const T = state.tenant.id;
  [state.products, state.questions, state.slots] = await Promise.all([
    api(`/rest/v1/products?tenant_id=eq.${T}&order=display_order` +
        `&select=*,product_variants(*),option_groups(*,options(*,shared_list_items(name,note))),option_exclusions(*)`),
    api(`/rest/v1/common_questions?tenant_id=eq.${T}&order=display_order,id` +
        `&select=*,common_question_choices(*),common_question_products(*)`),
    api(`/rest/v1/pickup_time_slots?tenant_id=eq.${T}&order=display_order&select=*`),
  ]);
  renderProducts();
  if (EDIT_MODE) {
    await enterEditMode();
  } else if (STAFF_MODE) {
    enterStaffMode();
  } else {
    await restoreSaved();
    if (RETRY_ENABLED && retryStore().pending()) {
      $("view-form").classList.add("hidden");
      $("view-confirm").classList.remove("hidden");
      $("confirm-detail").textContent = "前回のお申し込みの送信結果を確認します。内容の変更は、確認後に予約の変更ページから行えます。";
      $("btn-submit").textContent = "前回の送信結果を確認する";
      $("btn-back").disabled = true;
    }
  }
}

/* ---------- 代行登録モードの初期化 ---------- */
function enterStaffMode() {
  document.querySelector(".shop-sub").textContent = "予約の代行登録（お店の入力用）";
  document.title = `${state.tenant.name}｜予約の代行登録`;
  const b = document.createElement("div");
  b.className = "staff-banner";
  if (staffSession()?.access_token) {
    b.innerHTML = "📞 <strong>予約の直接登録モード</strong>：" +
      "締切後・満枠・休業の日もオレンジ表示で選べます（登録前に確認が出ます）。" +
      "メールアドレスは空欄OK。空欄の場合、確認メールは送られません。";
  } else {
    b.innerHTML = "⚠️ 代行登録には管理画面へのログインが必要です。" +
      '<a href="admin/">ログイン画面をひらく</a>';
  }
  document.querySelector(".shop-header").insertAdjacentElement("afterend", b);
  // 電話では聞いていないことが多い項目を任意に（フリガナ・メール）
  $("cust-sei-kana").closest(".field")?.querySelector(".req")?.remove();
  $("cust-email").closest(".field")?.querySelector(".req")?.remove();
  // 確認画面の文言もお店向けに
  document.querySelector("#view-confirm .confirm-title").textContent = "登録内容の確認";
  document.querySelector("#view-confirm .preview-note").textContent =
    "内容を確認のうえ「この内容で登録する」を押すと、予約として登録されます。";
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
    state.sel.answers = new Map();
    for (const a of EDIT_ORDER.answers || []) {
      if (!a.question_id) continue;
      const cur = state.sel.answers.get(a.question_id) || { text: null, choiceIds: [] };
      if (a.choice_id) cur.choiceIds.push(a.choice_id);
      if (a.answer_text) cur.text = a.answer_text;
      state.sel.answers.set(a.question_id, cur);
    }
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
    await loadOrderImages(EDIT_TOKEN);
    toast("いまのご予約内容を読み込みました。変更したいところを直してください");
  } finally {
    RESTORING = false;
  }
}

/* ---------- ユーティリティ ---------- */
/* 販売期間（受付開始・受付終了）。これまでこの判定はサーバー側の日付チェック
 * （fn_date_orderable）にしか無く、受付前・受付終了後の商品も一覧に並んでいた。
 * お客様から見ると「選べるのにカレンダーが全部灰色の商品」になる（2026-09-06 修正）。 */
function onSale(p) {
  const now = Date.now();
  if (p.sale_start_at && now < Date.parse(p.sale_start_at)) return false;
  if (p.sale_end_at   && now > Date.parse(p.sale_end_at))   return false;
  return true;
}
/* 一覧に出す商品。
 *  ・代行登録（お店の入力）は、受付前・受付終了後も店の判断で登録できるので全部出す
 *  ・すでに選んでいる商品は残す＝変更モードで開いた予約の商品が、受付終了後に
 *    消えてお客様が内容変更できなくなるのを防ぐ */
function visibleProducts() {
  if (STAFF_MODE) return state.products;
  return state.products.filter((p) => onSale(p) || p.id === state.sel.product?.id);
}
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
const DETACHED_TOPPING_OPTION = "選んだトッピングを別添えにする";
function detachedOptionEntry() {
  for (const [id, value] of state.sel.options) {
    const f=findOption(id);
    if (f && optName(f.o) === DETACHED_TOPPING_OPTION) return { id, value, ...f };
  }
  return null;
}
function detachedToppingNames() {
  const text=detachedOptionEntry()?.value?.text || "";
  return new Set(text.split("、").map(x=>x.trim()).filter(Boolean));
}
function setDetachedToppingNames(names) {
  const entry=detachedOptionEntry();
  if(entry)entry.value.text=[...names].join("、");
}
function sanitizeDetachedToppingNames() {
  const entry=detachedOptionEntry();
  if(!entry)return;
  const valid=new Set(entry.g.options.filter(o=>o.id!==entry.id&&state.sel.options.has(o.id)).map(optName));
  setDetachedToppingNames([...detachedToppingNames()].filter(name=>valid.has(name)));
}
function optionIsDetached(name) { return detachedToppingNames().has(name); }
function selectedAnimalToppingCount() {
  return [...state.sel.options.keys()].filter((id) => {
    const name=optName(findOption(id)?.o || {});
    return ANIMAL_TOPPING_NAMES.has(name) && !optionIsDetached(name);
  }).length;
}
function toppingCapacityError() {
  if(CONFIG.shop!=="pokke")return "";
  const names=[...state.sel.options.keys()].map(id=>optName(findOption(id)?.o||{}));
  const largeOnCake=names.includes("ナンバークッキー大")&&!optionIsDetached("ナンバークッキー大");
  return largeOnCake&&selectedAnimalToppingCount()>2
    ? "ナンバークッキー大と一緒に載せる動物トッピングは2匹までにしてください" : "";
}
// oyatsupokkeの実物サイズ上限：ナンバー大を載せる場合、動物は12/15/18cm共通で2匹まで。
// 個別に別添えにしたものはケーキ上の面積を使わないため、載せる分だけを数える。
function toppingCapacityConflict(o) {
  if (CONFIG.shop !== "pokke" || state.sel.options.has(o.id)) return "";
  const name = optName(o);
  const largeSelected = [...state.sel.options.keys()].some((id) => optName(findOption(id)?.o || {}) === "ナンバークッキー大")
    && !optionIsDetached("ナンバークッキー大");
  const animals = selectedAnimalToppingCount();
  if (name === "ナンバークッキー大" && animals > 2)
    return "動物トッピングを2匹までにすると選べます";
  if (ANIMAL_TOPPING_NAMES.has(name) && largeSelected && animals >= 2)
    return "ナンバークッキー大と一緒に載せられる動物は2匹までです";
  return "";
}
// 「なし」を含む必須1択は、ほかの選択で現在値が外れたときも未選択にしない。
// 現在は oyatsupokke の「フルーツの飾り方」で使用する。
function ensureRequiredFallbacks() {
  for (const g of sortedGroups(state.sel.product)) {
    if (!g.is_required || g.selection_type !== "single") continue;
    if (g.options.some((o) => state.sel.options.has(o.id))) continue;
    const fallback = sortedOpts(g).find((o) =>
      o.is_available && optName(o) === "上面のフルーツなし" && !conflictsWithSelected(o.id).length);
    if (fallback) state.sel.options.set(fallback.id, { qty: 1, text: "" });
  }
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
function optionPrice(o) {
  const price = o.size_prices?.[state.sel.variant?.size_label];
  return Number.isInteger(price) ? price : o.price_delta;
}
function optionMaxQuantity(o) {
  // タルト・バスク上に無理なく載せられるナンバークッキー大は2枚まで。
  if (CONFIG.shop === "pokke" && ["フルーツタルト","バスクチーズケーキ"].includes(state.sel.product?.name)
      && optName(o) === "ナンバークッキー大") return 2;
  return o.max_quantity || 1;
}
function requiresReview() {
  return [...state.sel.options.keys()].some(id => findOption(id)?.o.requires_review);
}
function currentTotal() {
  if (!state.sel.variant) return null;
  let total = state.sel.variant.price;
  for (const [id, v] of state.sel.options) {
    const f = findOption(id);
    if (f) total += optionPrice(f.o) * v.qty;
  }
  for (const [qid, raw] of state.sel.answers) {
    const q = state.questions.find((x) => x.id === qid);
    if (!q) continue;
    for (const cid of normAnswer(raw).choiceIds) {
      const c = q.common_question_choices.find((x) => x.id === cid);
      if (c) total += c.price_delta;
    }
  }
  return total;
}
function updatePriceBar() {
  const t = currentTotal();
  if (t == null) {
    $("price-summary").textContent = state.sel.product
      ? "サイズを選んでください" : "ケーキを選んでください";
    $("price-total").textContent = "";
  } else {
    $("price-summary").textContent =
      `${state.sel.product.name} ${state.sel.variant.size_label}`;
    $("price-total").textContent = yen(t) + (requiresReview() ? "（選択分・追加希望は別途見積もり）" : "（税込）");
  }  saveState();
}

/* ---------- 1. 商品 ---------- */
const EMOJI = { "生クリームデコレーション": "🍰", "フルーツタルト": "🥧", "チョコレートケーキ": "🍫", "バスクチーズケーキ": "🧀" };
const validVariant = (v) => v.is_available && Number.isInteger(v.price) && v.price >= 0 && !!v.size_label?.trim();
function renderProducts() {
  const wrap = $("product-cards");
  wrap.innerHTML = "";
  for (const p of visibleProducts()) {
    const prices = p.product_variants.filter(validVariant).map((v) => v.price);
    const el = document.createElement("div");
    el.className = "card" + (state.sel.product?.id === p.id ? " selected" : "");
    const visual = p.photo_url
      ? `<div class="card-photo"><img src="${esc(safeImageUrl(p.photo_url))}" alt="${esc(p.name)}" loading="lazy"></div>`
      : `<div class="card-emoji">${EMOJI[p.name] || "🎂"}</div>`;
    el.innerHTML = `
      ${visual}
      <div class="card-name">${esc(p.name)}</div>
      <div class="card-desc">${esc(p.description || "")}</div>
      <div class="card-price">${prices.length ? yen(Math.min(...prices)) + "〜" : "ただいま準備中です"}</div>`;
    el.setAttribute("aria-disabled", String(!prices.length));
    if (prices.length) el.onclick = () => selectProduct(p);
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
const alphaBoundsCache = new Map();
const CALENDAR_FONT = "oyatsupokkefont";
const CALENDAR_OPTION_NAMES = new Set([
  "カレンダーケーキに変更",
  "わんこ・うさぎ付きカレンダーケーキに変更",
  "カレンダーケーキ（動物なし）",
  "カレンダーケーキ（動物付き）",
]);
const ANIMAL_TOPPING_NAMES = new Set([
  "わんこメレンゲ", "うさぎメレンゲ", "くまメレンゲ", "ねこクッキー",
]);
const PREVIEW_POSITION_NOTICE_NAMES = new Set([
  ...ANIMAL_TOPPING_NAMES, "ナンバークッキー大", "ナンバークッキー小",
]);
const BACK_ANIMAL_TOPPING_NAMES = new Set(["ねこクッキー", "うさぎメレンゲ"]);
const HERB_TOPPING_NAMES = new Set([
  "ハーブ、エディブルフラワー1周", "ハーブ、エディブルフラワートッピング",
]);
const cakeLayerAsset = (name) => new URL(`assets/cake-layers/${name}`, location.href).href;
// oyatsupokkeの12cmデコレーションは、15cmと同じ素材を縮小するのではなく、
// 実物の比率で描かれた専用素材へ差し替える。素材URLがStorage配信でも
// ファイル名で解決できるようにし、DB側の設定は15cm・18cmと共用する。
const OYATSU_12CM_DECORATION_LAYER_FILES = {
  "naked-decoration.png": "12cm/naked-decoration.png",
  "chocolate-drip.png": "12cm/chocolate-drip.png",
  "strawberry-drip.png": "12cm/strawberry-drip.png",
  "round-piping.png": "12cm/round-piping.png",
  "fruit-ring-muscat.png": "12cm/fruit-ring-muscat.png",
  "fruit-pile-muscat.png": "12cm/fruit-pile-muscat.png",
  "fruit-side-herb.png": "12cm/fruit-side-herb.png",
  "herb-ring.png": "12cm/herb-ring.png",
  "dog-cake.png": "12cm/dog-cake.png",
};
function layerFileName(url) {
  try { return decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || ""); }
  catch { return String(url || "").split('/').pop() || ""; }
}
function sizeSpecificLayerUrl(url, role = "option") {
  if (CONFIG.shop !== "pokke" || state.sel.product?.name !== "デコレーションケーキ"
      || state.sel.variant?.size_label !== "12cm") return url;
  if (role === "base") return cakeLayerAsset("12cm/decoration-base.png");
  const file = OYATSU_12CM_DECORATION_LAYER_FILES[layerFileName(url)];
  return file ? cakeLayerAsset(file) : url;
}
// oyatsupokkeのタルト・バスクは、商品土台とは別に通常の果物レイヤーが常に付く。
// 他店舗の商品名が同じでも混ざらないよう、店舗キーpokkeだけに限定する。
const OYATSU_PRODUCT_EXTRA_LAYERS = {
  "フルーツタルト": [{ file: "tart-fruit-muscat.png", z: 35 }],
  "バスクチーズケーキ": [{ file: "basque-fruit-muscat.png", z: 35 }],
};
const DEFAULT_PASTEL = { hue: 340, softness: 0 };
/* 淡さスライダーの色域。0＝いちばん濃い／100＝いちばん淡い。
 * まりほ指示 2026-09-16：以前のいちばん濃い側（S45/L82）は濃すぎたため、
 * 従来の淡さ45相当（S33/L88＝#EAD6E3級）を新しい上限にした。
 * 淡い側は彩度を落とさず、グレーではなく「色に白を足した」見え方にする。 */
const PASTEL_RANGE = { sDark: 33, sPale: 50, lDark: 88, lPale: 95 };
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return "#" + [f(0), f(8), f(4)].map(x => Math.round(255*x).toString(16).padStart(2,"0")).join("").toUpperCase();
}
function pastelHex(hue, softness) {
  const t = Math.max(0, Math.min(100, Number(softness) || 0)) / 100;
  // 淡くするほど明度と彩度を上げ、白っぽくても色味が残るようにする。
  const { sDark, sPale, lDark, lPale } = PASTEL_RANGE;
  return hslToHex((Number(hue) || 0) % 360, sDark + (sPale - sDark)*t, lDark + (lPale - lDark)*t);
}
function hexToHsl(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return null;
  const [r,g,b]=[0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16)/255),hi=Math.max(r,g,b),lo=Math.min(r,g,b),d=hi-lo;
  let h=0,s=0,l=(hi+lo)/2;
  if(d){s=d/(1-Math.abs(2*l-1));h=hi===r?((g-b)/d)%6:hi===g?(b-r)/d+2:(r-g)/d+4;h=Math.round(h*60);if(h<0)h+=360;}
  return {h,s:s*100,l:l*100};
}
function parsePastelAnswer(text) {
  const m=/^(#[0-9A-F]{6})(／連動：同色)?(?:／補足：([^\n]{1,200}))?$/i.exec(String(text||""));
  if(!m)return {...DEFAULT_PASTEL,hex:pastelHex(DEFAULT_PASTEL.hue,DEFAULT_PASTEL.softness),note:""};
  const hsl=hexToHsl(m[1])||{};
  const {lDark,lPale}=PASTEL_RANGE;
  return {hue:Math.round(hsl.h??DEFAULT_PASTEL.hue),softness:Math.round(Math.max(0,Math.min(100,((hsl.l??lDark)-lDark)/(lPale-lDark)*100))),hex:m[1].toUpperCase(),linked:!!m[2],note:m[3]||""};
}
const pastelAnswerText = (hex,note,linked=false) => hex.toUpperCase() + (linked?'／連動：同色':'') + (note.trim()?`／補足：${note.trim().slice(0,200)}`:"");
function pastelHueName(hue) {
  const h=((Number(hue)||0)%360+360)%360;
  if(h<15||h>=345)return "赤系";
  if(h<40)return "コーラル系";
  if(h<70)return "黄色系";
  if(h<150)return "緑系";
  if(h<195)return "ミント系";
  if(h<250)return "水色・青系";
  if(h<295)return "紫系";
  return "ピンク系";
}
function loadImg(url) {
  url = safeImageUrl(url);
  if (!url) return Promise.resolve(null);
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

function imageAlphaBounds(img, key) {
  if (alphaBoundsCache.has(key)) return alphaBoundsCache.get(key);
  const c=document.createElement('canvas');c.width=img.naturalWidth||img.width;c.height=img.naturalHeight||img.height;
  const x=c.getContext('2d');x.drawImage(img,0,0);
  const d=x.getImageData(0,0,c.width,c.height).data;
  let left=c.width,top=c.height,right=-1,bottom=-1;
  for(let py=0;py<c.height;py++)for(let px=0;px<c.width;px++)if(d[(py*c.width+px)*4+3]>8){
    if(px<left)left=px;if(px>right)right=px;if(py<top)top=py;if(py>bottom)bottom=py;
  }
  const b=right<left?{x:0,y:0,w:c.width,h:c.height}:{x:left,y:top,w:right-left+1,h:bottom-top+1};
  alphaBoundsCache.set(key,b);return b;
}

function numberCookieLayout(size, layouts, selectedNames) {
  if (size === 'L' && selectedNames.has('メッセージをケーキに直書き')) {
    // 直書きの上面を空け、実物どおりケーキ手前の側面へ付ける。
    return {height:270,maxWidth:440,centerX:400,bottom:780,gap:14};
  }
  if (size === 'L' && selectedNames.has('フルーツサイド寄せ')) {
    return {height:250,maxWidth:350,centerX:265,bottom:330,gap:14};
  }
  return layouts[size];
}

function numberCookieScale(rawWidth, count, layoutMaxWidth) {
  // 3桁までは1枚ごとの大きさを変えない。列を左右へずらして画面内に収める。
  // 4枚以上、または3枚でもキャンバス自体に入らない場合だけ縮小する。
  const available = count <= 3 ? LAYER_CANVAS - 40 : layoutMaxWidth;
  return Math.min(1, available / Math.max(rawWidth, 1));
}

function numberCookieStartX(centerX, totalWidth) {
  return Math.max(20, Math.min(centerX - totalWidth / 2, LAYER_CANVAS - 20 - totalWidth));
}

// 透過余白を除いた数字だけを、組み合わせごとの定位置へ横並びにする。
function drawNumberCookieLayers(ctx, entries) {
  if(!entries.length)return;
  const product=state.sel.product?.name;
  const selectedNames=new Set([...state.sel.options.keys()].map(id=>findOption(id)?.o).filter(Boolean).map(optName));
  const animalCount=selectedAnimalToppingCount();
  const layouts=product==='フルーツタルト'
    ? {L:{height:250,maxWidth:420,centerX:400,bottom:375,gap:14},S:animalCount
        ? {height:150,maxWidth:220,centerX:400,bottom:440,gap:7}
        : {height:165,maxWidth:240,centerX:575,bottom:600,gap:7}}
    : product==='バスクチーズケーキ'
      ? {L:{height:250,maxWidth:390,centerX:280,bottom:380,gap:14},S:animalCount
          ? {height:145,maxWidth:215,centerX:400,bottom:485,gap:7}
          : {height:140,maxWidth:220,centerX:635,bottom:390,gap:7}}
      : {L:{height:220,maxWidth:560,centerX:400,bottom:420,gap:14},S:{height:170,maxWidth:245,centerX:635,bottom:370,gap:8}};
  for(const size of ['L','S']){
    const selected=entries.filter(({layer})=>layer.numberCookie.size===size);
    if(!selected.length)continue;
    const layout=numberCookieLayout(size,layouts,selectedNames),height=layout.height;
    const items=selected.map(({img,layer})=>{
      const b=imageAlphaBounds(img,layer.url),h=height;
      return {img,b,h,w:h*b.w/b.h};
    });
    const gap=layout.gap,raw=items.reduce((n,x)=>n+x.w,0)+gap*(items.length-1);
    // 大は中央。小は参考写真どおり右側の、うさぎとわんこの間へ置く。
    const scale=numberCookieScale(raw,items.length,layout.maxWidth);
    const total=raw*scale,{centerX,bottom}=layout;
    let x=numberCookieStartX(centerX,total);
    for(const item of items){
      const w=item.w*scale,h=item.h*scale;
      ctx.drawImage(item.img,item.b.x,item.b.y,item.b.w,item.b.h,x,bottom-h,w,h);
      x+=w+gap*scale;
    }
  }
}

// まりほ作成の実物配置見本（2026-09-18）に合わせた定位置。
// 選択順に関係なく、中央はメッセージプレート用に空ける。
const ANIMAL_TOPPING_LAYOUTS = {
  round: {
    "ねこクッキー":   { cx: 235, cy: 185, h: 230 },
    "うさぎメレンゲ": { cx: 600, cy: 165, h: 205 },
    "くまメレンゲ":   { cx: 215, cy: 420, h: 205 },
    "わんこメレンゲ": { cx: 595, cy: 440, h: 190 },
  },
  tart: {
    "ねこクッキー":   { cx: 245, cy: 375, h: 210 },
    "うさぎメレンゲ": { cx: 550, cy: 510, h: 200 },
    "くまメレンゲ":   { cx: 165, cy: 510, h: 210 },
    "わんこメレンゲ": { cx: 635, cy: 375, h: 195 },
  },
  basque: {
    "ねこクッキー":   { cx: 285, cy: 200, h: 210 },
    "うさぎメレンゲ": { cx: 565, cy: 390, h: 170 },
    "くまメレンゲ":   { cx: 185, cy: 405, h: 185 },
    "わんこメレンゲ": { cx: 585, cy: 205, h: 180 },
  },
};

function currentAnimalToppingLayout() {
  if(state.sel.product?.name==='フルーツタルト')return ANIMAL_TOPPING_LAYOUTS.tart;
  if(state.sel.product?.name==='バスクチーズケーキ')return ANIMAL_TOPPING_LAYOUTS.basque;
  return ANIMAL_TOPPING_LAYOUTS.round;
}

function selectedAnimalToppingNames() {
  if (!state.sel.product) return [];
  // ナンバー大との組み合わせでは、選んだ順に左枠→右枠へ入れる。
  return [...state.sel.options.keys()]
    .map(id=>optName(findOption(id)?.o||{}))
    .filter(name=>ANIMAL_TOPPING_NAMES.has(name)&&!optionIsDetached(name));
}

function dynamicLargeNumberSelected() {
  return ['フルーツタルト','バスクチーズケーキ'].includes(state.sel.product?.name)
    && [...state.sel.options.keys()].some(id=>optName(findOption(id)?.o||{})==='ナンバークッキー大');
}

function animalToppingIsBack(name, productName) {
  // 丸ケーキと、タルト・バスクでは奥側に置く動物が異なる。
  if (["フルーツタルト","バスクチーズケーキ"].includes(productName))
    return name === "ねこクッキー" || name === "わんこメレンゲ";
  return BACK_ANIMAL_TOPPING_NAMES.has(name);
}

function animalToppingPlacement(name) {
  if(dynamicLargeNumberSelected()){
    const index=selectedAnimalToppingNames().indexOf(name);
    const slots=state.sel.product?.name==='バスクチーズケーキ'
      ? [{cx:585,cy:205,h:180},{cx:250,cy:395,h:175}]
      : [{cx:165,cy:405,h:205},{cx:635,cy:405,h:195}];
    return slots[index] || null;
  }
  return currentAnimalToppingLayout()[name];
}

function drawAnimalToppingLayers(ctx, entries) {
  if (!entries.length) return;
  entries.forEach(({img,layer}) => {
    const b = imageAlphaBounds(img, layer.url);
    const layout = animalToppingPlacement(layer.animalTopping);
    if (!layout) return;
    const {cx,cy,h} = layout;
    const w = h * b.w / b.h;
    ctx.drawImage(img, b.x, b.y, b.w, b.h, cx - w / 2, cy - h / 2, w, h);
  });
}

function messagePlateLayout(img, url, mode) {
  const b=imageAlphaBounds(img,url),product=state.sel.product?.name;
  // サイド寄せでは、まりほ作成の配置見本どおり左側へ大きく置く。
  // ナンバー大は中央を使うため、従来どおり左端へ小さく逃がす。
  if(!mode)return {b,cx:b.x+b.w/2,cy:b.y+b.h/2,w:b.w,h:b.h};
  const layout=mode==='fruit-side-number-large'?{cx:410,cy:430,w:410}
    :mode==='fruit-side'?{cx:265,cy:275,w:410}
    :product==='フルーツタルト'&&mode==='number-large'?{cx:400,cy:545,w:370}
    :product==='フルーツタルト'?{cx:150,cy:440,w:180}
    :product==='バスクチーズケーキ'&&mode==='number-large'?{cx:570,cy:370,w:370}
    :product==='バスクチーズケーキ'?{cx:150,cy:360,w:180}:{cx:155,cy:350,w:215};
  const {cx,cy,w}=layout,h=w*b.h/b.w;
  return {b,cx,cy,w,h};
}

function drawShiftedMessagePlate(ctx, img, url, mode) {
  const {b,cx,cy,w,h}=messagePlateLayout(img,url,mode);
  ctx.drawImage(img,b.x,b.y,b.w,b.h,cx-w/2,cy-h/2,w,h);
}

function wrapMessageParagraph(ctx, text, maxWidth) {
  const clean=String(text||"").replace(/[\t ]+/g," ").trim();
  if(!clean)return [""];
  const words=clean.split(" "),units=words.length>1?words:[...clean],joiner=words.length>1?" ":"";
  const lines=[];let line="";
  for(const unit of units){
    const next=line?line+joiner+unit:unit;
    if(line&&ctx.measureText(next).width>maxWidth){lines.push(line);line=unit;}else line=next;
  }
  if(line)lines.push(line);
  return lines;
}

function messageLines(ctx, text, maxWidth, maxLines) {
  const lines=[];
  for(const paragraph of String(text||"").split(/\r?\n/)){
    for(const line of wrapMessageParagraph(ctx,paragraph,maxWidth)){
      if(lines.length>=maxLines)return lines;
      lines.push(line);
    }
  }
  return lines.slice(0,maxLines);
}

function drawMessagePlateText(ctx,img,url,mode,text){
  if(!String(text||"").trim())return;
  const {cx,cy,w,h}=messagePlateLayout(img,url,mode);
  const maxWidth=w*.72,maxHeight=h*.52,maxLines=3;
  let size=Math.max(18,Math.min(38,h*.23)),lines=[];
  ctx.save();
  ctx.fillStyle="#49352F";ctx.textAlign="center";ctx.textBaseline="middle";
  for(;size>=16;size-=2){
    ctx.font=`${size}px ${CALENDAR_FONT}, sans-serif`;
    lines=messageLines(ctx,text,maxWidth,maxLines);
    const lineHeight=size*1.18;
    if(lines.length*lineHeight<=maxHeight&&lines.every(line=>ctx.measureText(line).width<=maxWidth))break;
  }
  const lineHeight=size*1.18,firstY=cy-(lines.length-1)*lineHeight/2;
  lines.forEach((line,i)=>ctx.fillText(line,cx,firstY+i*lineHeight,maxWidth));
  ctx.restore();
}

function selectedCalendarOption() {
  for (const g of sortedGroups(state.sel.product)) {
    const option = g.options.find((o) => state.sel.options.has(o.id) && CALENDAR_OPTION_NAMES.has(optName(o)));
    if (option) return option;
  }
  return null;
}

function parseIsoDate(text) {
  const value = String(text || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day };
}

// 新しい日付選択は YYYY-MM-DD。以前の「8/18」「8月18日」も予約変更時のために読み続ける。
function parseCalendarDate(text) {
  const value = String(text || "").trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/／/g, "/");
  const iso = parseIsoDate(value);
  if (iso) return iso;
  const pickup = /^(\d{4})-(\d{2})-(\d{2})$/.exec(state.sel.date || "");
  let month, day;
  let m = /^(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})(?:\s*日)?$/.exec(value);
  if (m) {
    month = Number(m[1]); day = Number(m[2]);
  } else if ((m = /^(\d{1,2})(?:\s*日)?$/.exec(value)) && pickup) {
    month = Number(pickup[2]); day = Number(m[1]);
  } else return null;
  const year = pickup ? Number(pickup[1]) : new Date().getFullYear();
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day };
}

function currentCalendarLayer() {
  const option = selectedCalendarOption();
  if (!option) return null;
  const question = state.questions.find((q) => qLive(q) && qOptionId(q) === option.id);
  const date = parseCalendarDate(normAnswer(state.sel.answers.get(question?.id)).text);
  return date ? { ...date, optionId: option.id, questionId: question?.id } : null;
}

let oyatsupokkeFontPromise;
function loadOyatsupokkeFont() {
  if (!document.fonts?.load) return Promise.resolve();
  oyatsupokkeFontPromise ||= document.fonts.load(`32px ${CALENDAR_FONT}`).catch(() => []);
  return oyatsupokkeFontPromise;
}

function currentDirectMessageLayer() {
  const p = state.sel.product;
  if (!p) return null;
  for (const g of sortedGroups(p)) {
    const option = g.options.find((o) => state.sel.options.has(o.id) && optName(o) === "メッセージをケーキに直書き");
    if (!option) continue;
    const question = state.questions.find((q) => qLive(q) && qOptionId(q) === option.id);
    const text = String(normAnswer(state.sel.answers.get(question?.id)).text || "").trim();
    return text ? { text, optionId: option.id, questionId: question?.id } : null;
  }
  return null;
}

function currentOptionMessage(option) {
  const question=state.questions.find((q)=>qLive(q)&&qOptionId(q)===option.id);
  if(question)return String(normAnswer(state.sel.answers.get(question.id)).text||"").trim();
  return String(state.sel.options.get(option.id)?.text||"").trim();
}

function wrapDirectMessage(ctx, text, maxWidth, maxLines) {
  return messageLines(ctx,text,maxWidth,maxLines);
}

function drawDirectMessageLayer(ctx, message) {
  const detachedNames=detachedToppingNames();
  const selectedNames = new Set([...state.sel.options.keys()].map((id) => findOption(id)?.o).filter(Boolean).map(optName)
    .filter(name=>name!==DETACHED_TOPPING_OPTION&&!detachedNames.has(name)));
  const fruitSide = selectedNames.has("フルーツサイド寄せ");
  const layout = fruitSide
    ? { cx: 235, cy: 295, maxWidth: 320, size: 64, lineHeight: 88 }
    : { cx: 400, cy: 315, maxWidth: 430, size: 48, lineHeight: 78 };
  ctx.save();
  ctx.fillStyle = "#49352F";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${layout.size}px ${CALENDAR_FONT}, sans-serif`;
  let lines = wrapDirectMessage(ctx, message.text, layout.maxWidth, 2);
  // 片側寄せの英語2語は、参考見本どおり上下2段にする。
  if (fruitSide && lines.length === 1 && message.text.trim().split(/\s+/).length === 2) {
    lines = message.text.trim().split(/\s+/);
  }
  const firstY = layout.cy - (lines.length - 1) * layout.lineHeight / 2;
  lines.forEach((line, i) => ctx.fillText(line, layout.cx, firstY + i * layout.lineHeight, layout.maxWidth));
  ctx.restore();
}

function drawHeartOutline(ctx, cx, cy, width, height) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy + height * .43);
  ctx.bezierCurveTo(cx - width * .08, cy + height * .34, cx - width * .48, cy + height * .08, cx - width * .48, cy - height * .16);
  ctx.bezierCurveTo(cx - width * .48, cy - height * .50, cx - width * .10, cy - height * .55, cx, cy - height * .25);
  ctx.bezierCurveTo(cx + width * .10, cy - height * .55, cx + width * .48, cy - height * .50, cx + width * .48, cy - height * .16);
  ctx.bezierCurveTo(cx + width * .48, cy + height * .08, cx + width * .08, cy + height * .34, cx, cy + height * .43);
  ctx.closePath();
  ctx.strokeStyle = "#EFA8B7";
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

// 参考写真の手絞りに合わせ、曜日見出しなしの7列カレンダーをケーキ上面に描く。
function drawCalendarLayer(ctx, cal) {
  const brown = "#9A6B55";
  const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  ctx.save();
  ctx.fillStyle = brown;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `58px ${CALENDAR_FONT}, sans-serif`;
  ctx.fillText(String(cal.month), 400, 132);
  ctx.font = `25px ${CALENDAR_FONT}, sans-serif`;
  ctx.fillText(monthNames[cal.month - 1], 400, 178);

  const firstDay = new Date(cal.year, cal.month - 1, 1).getDay();
  const days = new Date(cal.year, cal.month, 0).getDate();
  const cellW = 55, rowH = 50, startX = 235, startY = 238;
  ctx.font = `25px ${CALENDAR_FONT}, sans-serif`;
  for (let day = 1; day <= days; day++) {
    const index = firstDay + day - 1;
    const col = index % 7, row = Math.floor(index / 7);
    const x = startX + col * cellW, y = startY + row * rowH;
    if (day === cal.day) drawHeartOutline(ctx, x, y + 1, 47, 40);
    ctx.fillStyle = brown;
    ctx.fillText(String(day), x, y);
  }
  ctx.restore();
}

// 今の選択内容から、重ねる素材を下から順に並べる
function currentLayers() {
  const p = state.sel.product;
  if (!p?.layer_url) return null;
  const layers = [{ url: sizeSpecificLayerUrl(p.layer_url, "base"), z: 0 }];
  if (CONFIG.shop === "pokke") {
    for (const x of OYATSU_PRODUCT_EXTRA_LAYERS[p.name] || []) {
      layers.push({ url: cakeLayerAsset(x.file), z: x.z });
    }
  }
  const detachedNames=detachedToppingNames();
  const selectedNames = new Set([...state.sel.options.keys()].map((id) => findOption(id)?.o).filter(Boolean).map(optName)
    .filter(name=>name!==DETACHED_TOPPING_OPTION&&!detachedNames.has(name)));
  const dogNumberCombo = CONFIG.shop === "pokke" && selectedNames.has("わんこホイップ絞り") && selectedNames.has("ナンバークッキー大");
  const calendarCake = selectedNames.has("カレンダーケーキに変更") || selectedNames.has("わんこ・うさぎ付きカレンダーケーキに変更");
  for (const g of sortedGroups(p)) {
    const selectedInGroup = g.options.filter((o) => state.sel.options.has(o.id));
    if (selectedInGroup.length) {
      for (const o of selectedInGroup) {
        const name=optName(o);
        // 個別に別添えを選んだものだけ、注文内容には残してケーキ上から外す。
        if(name===DETACHED_TOPPING_OPTION||detachedNames.has(name))continue;
        // サイド寄せの果物には1周ハーブではなく、同じ片側へ寄せた専用レイヤーを使う。
        const rawLayerUrl=CONFIG.shop==="pokke" && ["フルーツタルト","バスクチーズケーキ"].includes(p.name) && name==="クッキープレート"
          ? cakeLayerAsset(p.name==="フルーツタルト"?"tart-message-plate.png":"basque-message-plate.png")
          :CONFIG.shop==="pokke" && selectedNames.has("フルーツサイド寄せ") && HERB_TOPPING_NAMES.has(name)
            ? cakeLayerAsset("fruit-side-herb.png") : o.layer_url;
        const layerUrl=sizeSpecificLayerUrl(rawLayerUrl);
        if (layerUrl) {
          if(dogNumberCombo && name==="わんこホイップ絞り")continue;
          // カレンダーケーキのクッキープレートは別添え。注文には残し、ケーキ上には描かない。
          if(calendarCake && name==="クッキープレート")continue;
          if(layerUrl.includes('{digit}')){
            const q=state.questions.find(q=>qLive(q)&&qOptionId(q)===o.id);
            const digits=(normAnswer(state.sel.answers.get(q?.id)).text||'').match(/[0-9]/g)||[];
            const qty=Math.max(1,state.sel.options.get(o.id)?.qty||1);
            for(const digit of digits.slice(0,qty))layers.push({
              url:layerUrl.replace('{digit}',digit),z:o.layer_z??80,
              numberCookie:{size:name.includes('小')?'S':'L'}
            });
            continue;
          }
          const q=state.questions.find(q=>qLive(q)&&qOptionId(q)===o.id&&q.input_type==='pastel_color');
          const linkedQ=state.questions.find(q=>qLive(q)&&q.input_type==='pastel_color'
            &&q.pastel_link_option_name===name&&state.sel.options.has(qOptionId(q))
            &&parsePastelAnswer(normAnswer(state.sel.answers.get(q.id)).text).linked);
          const tint=q ? parsePastelAnswer(normAnswer(state.sel.answers.get(q.id)).text).hex
            :linkedQ ? parsePastelAnswer(normAnswer(state.sel.answers.get(linkedQ.id)).text).hex : null;
          const animalName=ANIMAL_TOPPING_NAMES.has(name)?name:null;
          const messagePlatePlacement=name==="クッキープレート"
            ? selectedNames.has("ナンバークッキー大")&&selectedNames.has("フルーツサイド寄せ")?"fruit-side-number-large"
              :selectedNames.has("ナンバークッキー大")?"number-large"
              :selectedNames.has("フルーツサイド寄せ")?"fruit-side":null
            :null;
          const messagePlateText=name==="クッキープレート"?currentOptionMessage(o):null;
          const dynamicLargeAnimal=animalName && ["フルーツタルト","バスクチーズケーキ"].includes(p.name) && selectedNames.has("ナンバークッキー大");
          layers.push({
            url: layerUrl, z: animalName?(dynamicLargeAnimal?70:animalToppingIsBack(animalName,p.name)?64:70):(o.layer_z ?? 50), tint,
            animalTopping: animalName,
            dynamicLargeAnimal,
            messagePlatePlacement,
            messagePlateText,
          });
        }
      }
    } else if (g.default_layer_url) {
      // 何も選ばれていないグループの既定イラスト（例: 仕上げ未選択時のノーマルデコ）
      layers.push({ url: sizeSpecificLayerUrl(g.default_layer_url), z: g.default_layer_z ?? 50 });
    }
  }
  if (dogNumberCombo) {
    layers.push({ url: cakeLayerAsset("dog-number-face.png"), z: 76 });
    layers.push({ url: cakeLayerAsset("dog-number-left-paw.png"), z: 85, dogPaw: true });
    layers.push({ url: cakeLayerAsset("dog-number-right-paw.png"), z: 85, dogPaw: true });
  }
  const calendar = currentCalendarLayer();
  if (calendar) layers.push({ z: 60, calendarCake: calendar });
  const directMessage = currentDirectMessageLayer();
  if (directMessage) layers.push({ z: 66, directMessage });
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
    if (layers.some((l) => l.calendarCake || l.directMessage || l.messagePlateText)) await loadOyatsupokkeFont();
    if (token !== previewToken) return; // 描画中に選択が変わったら破棄
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, LAYER_CANVAS, LAYER_CANVAS);
    const numberEntries=[],dogPawEntries=[],dynamicLargeAnimalEntries=[];
    for (let i=0;i<imgs.length;i++) {
      if(layers[i].calendarCake){drawCalendarLayer(ctx,layers[i].calendarCake);continue;}
      if(layers[i].directMessage){drawDirectMessageLayer(ctx,layers[i].directMessage);continue;}
      const img=imgs[i]; if(!img)continue;
      if(layers[i].messagePlatePlacement){drawShiftedMessagePlate(ctx,img,layers[i].url,layers[i].messagePlatePlacement);drawMessagePlateText(ctx,img,layers[i].url,layers[i].messagePlatePlacement,layers[i].messagePlateText);continue;}
      if(layers[i].dogPaw){dogPawEntries.push(img);continue;}
      if(layers[i].numberCookie){numberEntries.push({img,layer:layers[i]});continue;}
      // z=64の奥2匹 → z=65のプレート → z=70の手前2匹、の順にその場で描く。
      if(layers[i].animalTopping){
        if(layers[i].dynamicLargeAnimal)dynamicLargeAnimalEntries.push({img,layer:layers[i]});
        else drawAnimalToppingLayers(ctx,[{img,layer:layers[i]}]);
        continue;
      }
      if(layers[i].tint){
        const mask=document.createElement('canvas');mask.width=mask.height=LAYER_CANVAS;
        const mx=mask.getContext('2d');mx.drawImage(img,0,0,LAYER_CANVAS,LAYER_CANVAS);
        // 元画像のRGBを明暗情報として使う。白は選択色そのまま、薄い影や刷毛跡は
        // 同系色の少し濃い色になり、透明度と輪郭も元画像のまま残る。
        const rgb=[1,3,5].map(n=>parseInt(layers[i].tint.slice(n,n+2),16));
        const pixels=mx.getImageData(0,0,LAYER_CANVAS,LAYER_CANVAS);
        for(let p=0;p<pixels.data.length;p+=4){
          if(!pixels.data[p+3])continue;
          pixels.data[p]=Math.round(rgb[0]*pixels.data[p]/255);
          pixels.data[p+1]=Math.round(rgb[1]*pixels.data[p+1]/255);
          pixels.data[p+2]=Math.round(rgb[2]*pixels.data[p+2]/255);
        }
        mx.putImageData(pixels,0,0);
        ctx.drawImage(mask,0,0);
      } else ctx.drawImage(img, 0, 0, LAYER_CANVAS, LAYER_CANVAS);
      if(layers[i].messagePlateText)drawMessagePlateText(ctx,img,layers[i].url,null,layers[i].messagePlateText);
    }
    drawNumberCookieLayers(ctx,numberEntries);
    drawAnimalToppingLayers(ctx,dynamicLargeAnimalEntries);
    for(const img of dogPawEntries)ctx.drawImage(img,0,0,LAYER_CANVAS,LAYER_CANVAS);
    return;
  }

  if (p?.photo_url) {
    box.innerHTML = `<img src="${esc(safeImageUrl(p.photo_url))}" alt="${esc(p.name)}">`;
  } else {
    box.innerHTML = `<span class="preview-placeholder">${p ? (EMOJI[p.name] || "🎂") : "🎂"}</span>`;
  }
}

function selectProduct(p) {
  if (!p.product_variants.some(validVariant)) { toast("この商品はただいま準備中です"); return; }
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
  if (!THEME_PREVIEW) $("sec-size").scrollIntoView({ behavior: "smooth", block: "center" });
  updatePriceBar();
}

/* ---------- 2. サイズ ---------- */
function renderSizes() {
  const wrap = $("size-pills");
  wrap.innerHTML = "";
  const vs = [...state.sel.product.product_variants]
    .filter(validVariant)
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
  ensureRequiredFallbacks();
  renderSizes();
  renderGroups();
  $("sec-groups").classList.toggle("hidden", !state.sel.product.option_groups.length);
  // 受取日はサイズ確定後に（サイズ別上限があるため）
  state.sel.date = null;
  state.sel.slot = null;
  // 受取できる期間が先にある商品（クリスマスなど）は、その最初の月から開く。
  // 今月から開くと、12月受取の商品なのに真っ白な今月のカレンダーが出てしまう
  const pStart = state.sel.product.pickup_start_date
    ? new Date(state.sel.product.pickup_start_date + "T00:00:00") : null;
  const bounds = BookingWindow.bounds(state.tenant);
  const today = new Date(bounds.today + "T00:00:00");
  const end = new Date(bounds.end + "T00:00:00");
  const calBase = pStart && pStart > today ? (STAFF_MODE || pStart <= end ? pStart : end) : today;
  state.calMonth = new Date(calBase.getFullYear(), calBase.getMonth(), 1);
  $("sec-date").classList.remove("hidden");
  $("slot-area").classList.add("hidden");
  loadCalendar();
  renderQuestions();
  $("sec-questions").classList.toggle("hidden", !visibleQuestions().length);
  $("sec-customer").classList.remove("hidden");
  updatePriceBar();
}

function resetDesign() {
  if (!state.sel.product || !state.sel.variant) return;
  if (!confirm("選んだ装飾・色・メッセージをすべて初期状態に戻しますか？\nケーキの種類とサイズはそのままです。")) return;
  const productOptionIds=new Set(state.sel.product.option_groups.flatMap(g=>g.options.map(o=>o.id)));
  state.sel.options.clear();
  // 色・数字・メッセージ・写真など、商品内の選択肢に付いた回答だけ消す。
  // 店全体の質問やお客様情報、受取日時はそのまま残す。
  for(const q of state.questions)if(productOptionIds.has(qOptionId(q)))state.sel.answers.delete(q.id);
  const preferredDefaults=["通常デザイン","つけない","上面のフルーツなし"];
  for(const g of sortedGroups(state.sel.product)){
    if(!g.is_required||g.selection_type!=="single")continue;
    const available=sortedOpts(g).filter(o=>o.is_available!==false&&(!o.shared_list_item_id||o.shared_list_items));
    const fallback=preferredDefaults.map(name=>available.find(o=>optName(o)===name)).find(Boolean)
      ||available.find(o=>!conflictsWithSelected(o.id));
    if(fallback&&!conflictsWithSelected(fallback.id).length)state.sel.options.set(fallback.id,{qty:1,text:""});
  }
  ensureRequiredFallbacks();
  renderGroups();
  renderQuestions();
  $("sec-questions").classList.toggle("hidden", !visibleQuestions().length);
  updatePriceBar();
  updatePreview();
  saveState();
  track("design_reset");
  toast("デザインを初期状態に戻しました");
}

$("btn-reset-design").onclick=resetDesign;

/* ---------- 3. 選択グループ（排他＝理由つき無効表示） ---------- */
function buildDetachedToppingPicker(g, detachedId) {
  const wrap=document.createElement("div");
  wrap.className="detached-picker";
  const candidates=sortedOpts(g).filter(o=>o.id!==detachedId&&state.sel.options.has(o.id));
  const title=document.createElement("p");
  title.className="detached-picker-title";
  title.textContent="別添えにするものを選んでください";
  wrap.appendChild(title);
  if(!candidates.length){
    const empty=document.createElement("p");
    empty.className="detached-picker-empty";
    empty.textContent="先にメレンゲまたはクッキーを選んでください。";
    wrap.appendChild(empty);
    return wrap;
  }
  const detached=detachedToppingNames();
  for(const option of candidates){
    const name=optName(option),label=document.createElement("label"),input=document.createElement("input");
    label.className="detached-picker-choice";
    input.type="checkbox";
    input.checked=detached.has(name);
    label.append(input,document.createTextNode(name));
    input.onchange=()=>{
      const next=detachedToppingNames();
      if(input.checked)next.add(name);else next.delete(name);
      const previous=detachedToppingNames();
      setDetachedToppingNames(next);
      const capacityError=toppingCapacityError();
      if(capacityError){setDetachedToppingNames(previous);toast(capacityError);}
      renderGroups();
      updatePriceBar();
      updatePreview();
    };
    wrap.appendChild(label);
  }
  return wrap;
}

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
    box.innerHTML = `<h3>${esc(g.name)}${g.is_required ? '<span class="req">必須</span>' : ""}</h3>` +
      (g.description ? `<p class="group-desc">${esc(g.description)}</p>` : "") +
      (g.name === "メレンゲ・クッキートッピング" && g.options.some((o) =>
        state.sel.options.has(o.id) && PREVIEW_POSITION_NOTICE_NAMES.has(optName(o)))
        ? '<p class="group-preview-note">※実際の配置はプレビュー通りではなく、全体のバランスを見て調整いたします。</p>' : "") +
      (g.note ? `<p class="group-note${g.note_accent ? " note-accent" : ""}">${esc(g.note)}</p>` : "") +
      sampleImageHtml(g.sample_image_url);
    wireSampleImage(box);
    for (const o of sortedOpts(g)) {
      if (!o.is_available) continue;
      // 共有リスト由来なのに項目が取れない=停止中（RLSで非表示）→ 出さない
      if (o.shared_list_item_id && !o.shared_list_items) continue;
      const conflictIds = conflictsWithSelected(o.id);
      // 上にある大分類はいつでも変更できる。選ぶと、矛盾する後段の選択を toggleOption が外す。
      // 後段側は無効表示にし、「なぜ選べないか」が分かるようにする。
      const blockingIds = conflictIds.filter((id) => {
        const f = findOption(id);
        return f && (f.g.display_order ?? 0) <= (g.display_order ?? 0);
      });
      const capacityConflict = toppingCapacityConflict(o);
      const row = document.createElement("label");
      row.className = "opt" + ((blockingIds.length || capacityConflict) && !state.sel.options.has(o.id) ? " opt-disabled" : "");
      const type = g.selection_type === "single" ? "radio" : "checkbox";
      const selected = state.sel.options.has(o.id);
      const sel = selected ? state.sel.options.get(o.id) : null;
      const maxQty = optionMaxQuantity(o);
      const price = o.requires_review ? `${optionPrice(o) ? '+'+yen(optionPrice(o))+'・' : ''}別途見積もり` : optionPrice(o) ? `+${yen(optionPrice(o))}` : "無料";
      // 枚数はステッパー（−/＋）で。数字入力欄だけだと枚数と気づけない（まりほ指摘 2026-08-24）
      const qtyUi = maxQty > 1 && selected
        ? `<span class="qty-stepper" role="group" aria-label="枚数">
             <button type="button" class="qty-btn qty-minus" aria-label="減らす">−</button>
             <span class="qty-count">${esc(sel.qty)}<small>枚</small></span>
             <button type="button" class="qty-btn qty-plus" aria-label="増やす">＋</button>
           </span>`
        : "";
      const conflictNote = !selected && capacityConflict
        ? capacityConflict
        : blockingIds.length && !selected
          ? `「${blockingIds.map((id) => optName(findOption(id).o)).join("」「")}」とは組み合わせできません`
          : "";
      row.innerHTML = `
        <input type="${type}" name="g-${esc(g.id)}" ${selected ? "checked" : ""} ${conflictNote ? "disabled" : ""}>
        ${o.photo_url ? `<span class="opt-photo"><img src="${esc(safeImageUrl(o.photo_url))}" alt="" loading="lazy"></span>` : ""}
        <span class="opt-name">${esc(optName(o))}${o.order_deadline_days != null ? `<span class="opt-desc">受取日の${esc(o.order_deadline_days)}日前締切（受付可能日はカレンダーで確認）</span>` : ""}${optDesc(o) ? `<span class="opt-desc">${esc(optDesc(o))}</span>` : ""}${optNote(o) ? `<span class="opt-note${o.note_accent ? " note-accent" : ""}">${esc(optNote(o))}</span>` : ""}${conflictNote ? `<span class="opt-conflict">${esc(conflictNote)}</span>` : ""}</span>
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
          const v = Math.max(1, Math.min(maxQty, cur + delta));
          state.sel.options.get(o.id).qty = v;
          countEl.innerHTML = `${v}<small>枚</small>`;
          stepper.querySelector(".qty-minus").disabled = v <= 1;
          stepper.querySelector(".qty-plus").disabled = v >= maxQty;
          updatePriceBar();
        };
        stepper.querySelector(".qty-minus").onclick = (e) => { e.stopPropagation(); step(-1); };
        stepper.querySelector(".qty-plus").onclick = (e) => { e.stopPropagation(); step(1); };
        stepper.querySelector(".qty-minus").disabled = sel.qty <= 1;
        stepper.querySelector(".qty-plus").disabled = sel.qty >= maxQty;
      }
      box.appendChild(row);
      if(selected && optName(o)===DETACHED_TOPPING_OPTION){
        box.appendChild(buildDetachedToppingPicker(g,o.id));
      }
      // 選択肢の質問: この選択肢を選んだ人にだけ、選択肢のすぐ下に出す
      const oq = selected ? state.questions.find((x) => qLive(x) && qOptionId(x) === o.id) : null;
      if (oq) {
        const wrapQ = document.createElement("div");
        wrapQ.className = "opt-question";
        wrapQ.onclick = (e) => e.stopPropagation();  // 選択肢の行の開閉に巻き込まれないように
        wrapQ.appendChild(buildQuestionField(oq));
        box.appendChild(wrapQ);
      } else if (selected && o.text_prompt) {
        // 移行前の店（options.text_prompt がまだ残っている）は従来どおりの記入欄を出す
        const tf = document.createElement("div");
        tf.className = "opt-textfield";
        tf.innerHTML = `<input type="text" placeholder="${esc(o.text_prompt)}" value="${esc(sel.text || "")}">`;
        const ti = tf.querySelector("input");
        ti.oninput = () => { state.sel.options.get(o.id).text = ti.value; };
        box.appendChild(tf);
      }
    }
    wrap.appendChild(box);
  }
}
function toggleOption(g, o, input) {
  if (!state.sel.options.has(o.id)) {
    const capacityConflict = toppingCapacityConflict(o);
    if (capacityConflict) { input.checked = false; toast(capacityConflict); return; }
  }
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
  sanitizeDetachedToppingNames();
  ensureRequiredFallbacks();
  renderGroups();
  renderQuestions(); // 条件付き質問（選択肢トリガー）の表示を更新
  $("sec-questions").classList.toggle("hidden", !visibleQuestions().length);
  updatePriceBar();
  updatePreview(); // 選択に応じてイラストを組み直す
  // 選択肢の「できない日」を反映してカレンダーを引き直す（表示中なら常に）
  if (state.sel.variant) {
    loadCalendar().then((loaded) => {
      if (!loaded) return;
      if (state.sel.date && !STAFF_MODE) {   // 代行登録は満枠・締切の日も選べるので外さない
        const st = state.avail[state.sel.date];
        if (st !== "open" && st !== "few") {
          state.sel.date = null;
          state.sel.slot = null;
          $("slot-area").classList.add("hidden");
          renderCalendar();
          saveState();
          toast("選んだ内容がご用意できない日のため、受取日を選び直してください");
        }
      }
    });
  }
}

/* ---------- 4. カレンダー・時間枠 ---------- */
const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
let calendarRequest = 0;
async function loadCalendar() {
  const request = ++calendarRequest;
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
    if (request !== calendarRequest) return false;
    state.avail = Object.fromEntries(rows.map((r) => [r.d, r.status]));
    // 短縮前に成立した予約の同日編集を維持。その他の可否は送信時に再検証する。
    if (EDIT_MODE && EDIT_ORDER && EDIT_ORDER.pickup_date > BookingWindow.bounds(state.tenant).end &&
        Object.hasOwn(state.avail, EDIT_ORDER.pickup_date)) {
      state.avail[EDIT_ORDER.pickup_date] = "few";
    }
    renderCalendar();
    return true;
  } catch (e) {
    if (request !== calendarRequest) return false;
    state.avail = {};
    $("cal-grid").innerHTML = '<div class="dow">読み込みに失敗しました</div>';
    return false;
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
  const todayKey = BookingWindow.bounds(state.tenant).today;
  for (let day = 1; day <= days; day++) {
    const key = fmtDate(new Date(m.getFullYear(), m.getMonth(), day));
    const st = state.avail[key] || "closed";
    // 代行登録：本来受付できない日（締切・満枠・休業）も今日以降なら警告つきで選べる
    const staffPick = STAFF_MODE && (st === "full" || st === "closed") && key >= todayKey;
    const el = document.createElement("div");
    el.className = `cal-day ${st}` +
      ((st === "open" || st === "few") ? " clickable" : "") +
      (staffPick ? " clickable staff-warn" : "") +
      (state.sel.date === key ? " selected" : "");
    el.innerHTML = `<span>${day}</span><span class="mark">${staffPick ? "△" : MARK[st]}</span>`;
    if (st === "open" || st === "few") el.onclick = () => selectDate(key);
    else if (staffPick) el.onclick = () => {
      toast("この日は通常は受付できない日です（締切・満枠・休業のいずれか）。代行登録なので選べます");
      selectDate(key);
    };
    grid.appendChild(el);
  }
  // 前月ボタンは今月まで
  const bounds = BookingWindow.update(state.tenant, m, STAFF_MODE);
  const product = state.sel.product;
  const start = product.pickup_mode === 'dates' ? [...(product.pickup_dates || [])].sort()[0] : product.pickup_start_date;
  if (!STAFF_MODE && start && start > bounds.end) {
    const opens = new Date(start + 'T00:00:00Z');
    opens.setUTCDate(opens.getUTCDate() - (state.tenant.booking_window_days ?? 90));
    $("booking-window-note").textContent += ` この商品の受取期間はまだ先です。最初の受取日の予約は${opens.toISOString().slice(0,10).replaceAll('-','/')}から可能です（商品の受付開始日時も適用されます）。`;
  }
}
async function selectDate(key) {
  state.sel.date = key;
  track("date_selected");
  state.sel.slot = null;
  renderCalendar();
  updatePreview();
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
  if (!THEME_PREVIEW) $("slot-area").scrollIntoView({ behavior: "smooth", block: "center" });
}
function renderSlots() {
  const wrap = $("slot-pills");
  wrap.innerHTML = "";
  for (const s of state.slots) {
    const full = state.slotFull?.[s.id];
    const el = document.createElement("button");
    el.type = "button";
    el.className = "pill" + (state.sel.slot?.id === s.id ? " selected" : "") + (full ? " full" : "")
      + (full && STAFF_MODE ? " staff-warn" : "");
    el.textContent = s.label + (full ? "（満員）" : "");
    if (full && !STAFF_MODE) el.disabled = true;
    else el.onclick = () => {
      if (full) toast("この時間帯は満員です。代行登録なので選べます（登録前に確認が出ます）");
      state.sel.slot = s; renderSlots(); saveState();
    };
    wrap.appendChild(el);
  }
}
$("cal-prev").onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); loadCalendar(); };
$("cal-next").onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); loadCalendar(); };

/* ---------- 5. 質問（共通の質問／選択肢の質問） ----------
 * 覚える概念は「質問」1つ。置き場所が2つあるだけ（2026-08-30 作り直し）:
 *   ・共通の質問   = option_id が null。どのケーキで聞くかは scope/対象商品で決まる
 *   ・選択肢の質問 = option_id あり。その選択肢を選んだ人にだけ、選択肢のすぐ下に出す
 * 旧・表示条件（trigger_option_id）は選択肢の質問と同じ意味なので同列に扱う。
 */
const qOptionId = (q) => q.option_id || q.trigger_option_id || null;
const qLive = (q) => q.is_active !== false && (q.label || "").trim() !== "";
const qChoices = (q) => (q.common_question_choices || [])
  .filter((c) => c.is_available !== false)
  .sort((a, b) => a.display_order - b.display_order || a.id.localeCompare(b.id));
// 回答は1つの質問に複数入りうる（チェックボックス）。古い保存データの {choiceId} も受ける
function normAnswer(a) {
  return {
    text: a?.text ?? null,
    choiceIds: a?.choiceIds ? [...a.choiceIds] : (a?.choiceId ? [a.choiceId] : []),
    images: a?.images ?? [],   // 「画像を貼ってもらう」形式の質問の添付（配列は共有して持ち回る）
  };
}
function visibleQuestions() {  // 店全体の質問（選択肢の質問は選択肢の下に出すのでここには含めない）
  return state.questions.filter((q) =>
    qLive(q) && !qOptionId(q) &&
    (q.scope === "all" ||
     q.common_question_products.some((x) => x.product_id === state.sel.product.id)));
}
function optionQuestions() {   // いま選ばれている選択肢にぶら下がる質問
  const out = [];
  for (const id of state.sel.options.keys()) {
    const q = state.questions.find((x) => qLive(x) && qOptionId(x) === id);
    if (q) out.push(q);
  }
  return out;
}
const askedQuestions = () => [...visibleQuestions(), ...optionQuestions()];

function isMessageQuestion(q){
  const option=qOptionId(q)?findOption(qOptionId(q))?.o:null;
  return ["クッキープレート","メッセージをケーキに直書き"].includes(optName(option||{}))
    || /メッセージ/.test(String(q.label||""));
}

function answerInputsHtml(q) {
  const cs = qChoices(q);
  const plus = (c) => (c.price_delta ? `（+${yen(c.price_delta)}）` : "");
  if (q.input_type === "image") {
    return `<span class="img-box" id="img-box-${esc(q.id)}">` +
      `<span class="img-list"></span>` +
      `<span class="img-pick"><input type="file" accept="image/*" multiple hidden>` +
      `<span class="img-pick-label">写真を選ぶ</span></span>` +
      `<span class="small img-note"></span></span>`;
  }
  if(q.input_type==='pastel_color') {
    const linkedSelected=q.pastel_link_option_name&&[...state.sel.options.keys()].some(id=>optName(findOption(id)?.o||{})===q.pastel_link_option_name);
    return `<span class="pastel-picker"><span class="pastel-swatch" aria-hidden="true"></span>`+
    `<label>色の種類<input class="pastel-hue" type="range" min="0" max="359" step="1"></label>`+
    `<span class="pastel-hue-labels" aria-hidden="true"><i>赤</i><i>黄</i><i>緑</i><i>水色</i><i>青</i><i>紫</i><i>ピンク</i><i>赤</i></span>`+
    `<label>淡さ<input class="pastel-soft" type="range" min="0" max="100" step="1"></label>`+
    `<span class="pastel-soft-labels" aria-hidden="true"><i>濃いめ（上限）</i><i>とても淡い</i></span>`+
    `<span class="pastel-name"></span><span class="pastel-value"></span>`+
    (linkedSelected?`<label class="pastel-link"><input type="checkbox">${esc(q.pastel_link_label||`${q.pastel_link_option_name}も同じ色にする`)}</label>`:'')+
    `<textarea class="pastel-note" rows="2" maxlength="200" placeholder="色の補足（任意）例：くすみピンク寄り"></textarea>`+
    `<span class="help">最も濃い位置でも、お店で対応できるパステルの淡さに制限しています。画面と実物の色には差が出る場合があります。</span></span>`;
  }
  if (q.input_type === "date") return `<input type="date">`;
  if (q.input_type === "textarea" || (q.input_type === "text" && isMessageQuestion(q)))
    return `<textarea rows="3" placeholder="例：Happy Birthday&#10;まりちゃん"></textarea>`;
  if (q.input_type === "select") {
    return `<select><option value="">選択してください</option>` +
      cs.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}${plus(c)}</option>`).join("") + `</select>`;
  }
  if (q.input_type === "radio" || q.input_type === "checkbox") {
    const t = q.input_type === "radio" ? "radio" : "checkbox";
    return `<span class="pick-list">` + cs.map((c) =>
      `<label class="pick"><input type="${t}" name="q-${esc(q.id)}" value="${esc(c.id)}">${esc(c.label)}${plus(c)}</label>`).join("") + `</span>`;
  }
  return `<input type="text">`;
}
/* 質問1つ分の入力欄を作る。共通の質問も選択肢の質問も同じ部品を使う */
/* 店が用意した「見本の画像」（色見本・仕上がりの例など）。
 * プレビュー合成には使わない、ただの見本（2026-09-06）。 */
function sampleImageHtml(url) {
  const src = safeImageUrl(url);
  return src ? `<span class="sample-img"><img src="${esc(src)}" alt="見本" loading="lazy"></span>` : "";
}
function wireSampleImage(el) {
  const s = el.querySelector(".sample-img");
  if (!s) return;
  // labelの中にあるので、押しただけで選択が変わらないように止めてから開く
  s.onclick = (e) => { e.preventDefault(); e.stopPropagation(); window.open(s.querySelector("img").src, "_blank", "noopener,noreferrer"); };
}

function buildQuestionField(q) {
  const field = document.createElement("label");
  field.className = "field";
  field.innerHTML = `${esc(q.label)}${q.is_required ? '<span class="req">必須</span>' : ""}` +
    (q.help_text ? `<span class="help">${esc(q.help_text)}</span>` : "") +
    sampleImageHtml(q.sample_image_url) + answerInputsHtml(q);
  wireSampleImage(field);

  if(q.input_type==='pastel_color'){
    field.classList.add('pastel-field');
    const hue=field.querySelector('.pastel-hue'),soft=field.querySelector('.pastel-soft'),note=field.querySelector('.pastel-note'),link=field.querySelector('.pastel-link input');
    const saved=parsePastelAnswer(normAnswer(state.sel.answers.get(q.id)).text);
    hue.value=saved.hue;soft.value=saved.softness;note.value=saved.note;if(link)link.checked=saved.linked;
    const commit=()=>{const hex=pastelHex(hue.value,soft.value);field.querySelector('.pastel-swatch').style.background=hex;field.querySelector('.pastel-name').textContent=pastelHueName(hue.value);field.querySelector('.pastel-value').textContent=hex;hue.style.setProperty('--pastel-thumb',hslToHex(Number(hue.value),55,68));state.sel.answers.set(q.id,{text:pastelAnswerText(hex,note.value,!!link?.checked),choiceIds:[]});updatePreview();updatePriceBar();};
    [hue,soft,note,link].filter(Boolean).forEach(i=>{i.oninput=commit;i.onchange=commit;});commit();return field;
  }

  if (q.input_type === "image") {
    // labelの中にfileを置くと、サムネイルを消すボタンを押しただけでも
    // ファイル選択が開いてしまう。押せる場所を「写真を選ぶ」だけに絞る
    field.className = "field img-field";
    const picker = field.querySelector(".img-pick");
    const file = picker.querySelector("input[type=file]");
    picker.onclick = (e) => { e.preventDefault(); if (!picker.classList.contains("disabled")) file.click(); };
    file.onchange = async (e) => {
      const files = e.target.files;
      e.target.value = "";        // 同じ写真をもう一度選べるように
      await addImageFiles(q, files);
    };
    answerImages(q.id);           // 保存先の配列を用意しておく
    setTimeout(() => paintImageAnswer(q), 0);
    return field;
  }

  const inputs = [...field.querySelectorAll("input,textarea,select")];
  const saved = normAnswer(state.sel.answers.get(q.id));
  const multi = q.input_type === "radio" || q.input_type === "checkbox";
  if (multi) inputs.forEach((i) => { i.checked = saved.choiceIds.includes(i.value); });
  else if (q.input_type === "select") inputs[0].value = saved.choiceIds[0] || "";
  else inputs[0].value = saved.text || "";
  const onChange = () => {
    if (multi) {
      state.sel.answers.set(q.id, { text: null, choiceIds: inputs.filter((i) => i.checked).map((i) => i.value) });
    } else if (q.input_type === "select") {
      state.sel.answers.set(q.id, { text: null, choiceIds: inputs[0].value ? [inputs[0].value] : [] });
    } else {
      state.sel.answers.set(q.id, { text: inputs[0].value, choiceIds: [] });
    }
    updatePriceBar();
    updatePreview();
  };
  inputs.forEach((i) => { i.oninput = onChange; i.onchange = onChange; });
  return field;
}
function renderQuestions() {
  const wrap = $("question-list");
  wrap.innerHTML = "";
  for (const q of visibleQuestions()) wrap.appendChild(buildQuestionField(q));
  for (const q of askedQuestions()) if (q.input_type === "image") paintImageAnswer(q);
}

/* ---------- 画像の添付（2026-09-06：質問の回答のしかたの1つ） ----------
 * 「回答のしかた＝画像を貼ってもらう」の質問だけに出る欄。
 * お客様が選んだ瞬間にブラウザで長辺1600pxへ縮小し、非公開バケットへ仮置きする。
 * 注文が成立した時点でその注文と質問に紐づく（成立しなかったものは24時間で消える）。
 * 実体は署名付きURLでしか読めない＝公開URLにはならない。
 */
const IMG_ENDPOINT = () => `${CONFIG.url}/functions/v1/order-images`;
const IMG_MAX_SIDE = 1600;
const imgMax = (q) => Math.min(Math.max(parseInt(q.image_max, 10) || 3, 1), 3);
function answerImages(qid) {
  let a = state.sel.answers.get(qid);
  if (!a || !a.images) { a = normAnswer(a); state.sel.answers.set(qid, a); }
  return a.images;
}

// スマホの写真はそのままだと数MBある。送る前に縮めるので5MB超の写真も選べる
function shrinkImage(file, maxSide = IMG_MAX_SIDE, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";      // 透過PNG対策（白で塗ってから描く）
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => (blob ? resolve({ blob, w, h }) : reject(new Error("画像を変換できませんでした"))),
        "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")); };
    img.src = url;
  });
}

async function uploadOneImage(file, q) {
  const { blob, w, h } = await shrinkImage(file);
  if (TRIAL_MODE) return { id: crypto.randomUUID(), url: URL.createObjectURL(blob), note: "" };
  const res = await fetch(IMG_ENDPOINT(), {
    method: "POST",
    headers: {
      apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "upload",
      tenant_id: state.tenant.id,
      product_id: state.sel.product.id,
      question_id: q.id,
      content_type: "image/jpeg",
      bytes: blob.size, width: w, height: h,
    }),
  });
  const j = await res.json().catch(() => null);
  if (!j?.ok) throw new Error(j?.message || "画像を受け付けられませんでした");
  const put = await fetch(j.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  if (!put.ok) throw new Error("画像を送れませんでした。電波の良いところでもう一度お試しください");
  return { id: j.id, url: URL.createObjectURL(blob), note: "" };
}

/* レイヤー商品は、予約時点の完成イメージを1枚にして非公開保存する。
 * 商品設定を後から変えても、過去予約の見た目を変えないためのスナップショット。 */
async function uploadOrderPreview() {
  if (TRIAL_MODE || !currentLayers()) return null;
  await updatePreview();
  const canvas = $("preview-canvas").querySelector("canvas");
  if (!canvas) return null;
  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("完成イメージを作成できませんでした")), "image/webp", 0.9);
    } catch { reject(new Error("完成イメージを作成できませんでした")); }
  });
  const contentType = ["image/webp", "image/png", "image/jpeg"].includes(blob.type) ? blob.type : "image/png";
  const res = await fetch(IMG_ENDPOINT(), {
    method: "POST",
    headers: {
      apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "upload_preview", tenant_id: state.tenant.id, product_id: state.sel.product.id,
      content_type: contentType, bytes: blob.size, width: canvas.width, height: canvas.height,
    }),
  });
  const j = await res.json().catch(() => null);
  if (!j?.ok) throw new Error(j?.message || "完成イメージを保存できませんでした");
  const put = await fetch(j.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: blob });
  if (!put.ok) throw new Error("完成イメージを保存できませんでした。通信状態を確認して、もう一度お試しください");
  return j.id;
}

async function addImageFiles(q, files) {
  const list = [...files].filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  if (!list.length) { toast("画像ファイルをお選びください"); return; }
  const images = answerImages(q.id);
  const room = imgMax(q) - images.length;
  if (room <= 0) { toast(`「${q.label}」は${imgMax(q)}枚までです`); return; }
  if (list.length > room) toast(`あと${room}枚まで追加できます`);
  for (const file of list.slice(0, room)) {
    const slot = { id: null, url: null, note: "", busy: true };
    images.push(slot);
    paintImageAnswer(q);
    try {
      const up = await uploadOneImage(file, q);
      slot.id = up.id;
      slot.url = up.url;
      slot.busy = false;
    } catch (e) {
      images.splice(images.indexOf(slot), 1);
      toast(e.message);
    }
    paintImageAnswer(q);
  }
}

/* 質問1つぶんの添付欄を描き直す（サムネイル・×・「写真を選ぶ」の出し分け） */
function paintImageAnswer(q) {
  const box = document.getElementById(`img-box-${q.id}`);
  if (!box) return;
  const images = answerImages(q.id);
  const max = imgMax(q);
  const list = box.querySelector(".img-list");
  list.innerHTML = "";
  for (const slot of images) {
    const cell = document.createElement("span");
    cell.className = "img-cell";
    if (slot.busy) {
      cell.innerHTML = `<span class="img-thumb busy">送信中…</span>`;
    } else {
      // 写真ごとにひとこと（「1枚目はこの形、2枚目はこの色」が書けるように）
      cell.innerHTML =
        `<span class="img-thumb"><img src="${esc(safeImageUrl(slot.url))}" alt="">` +
        `<button type="button" class="rm" title="外す">×</button></span>` +
        `<input type="text" class="img-note-input" maxlength="100" placeholder="この写真について（任意）">`;
      cell.querySelector(".rm").onclick = () => {
        images.splice(images.indexOf(slot), 1);
        paintImageAnswer(q);
      };
      const noteEl = cell.querySelector(".img-note-input");
      noteEl.value = slot.note || "";
      noteEl.oninput = () => { slot.note = noteEl.value; };
    }
    list.appendChild(cell);
  }
  box.querySelector(".img-pick").classList.toggle("disabled", images.length >= max);
  box.querySelector(".img-pick-label").textContent = images.length ? "写真を追加する" : "写真を選ぶ";
  box.querySelector(".img-note").textContent =
    `${max}枚まで・1枚5MBまで（JPEG・PNG）。スマホの写真はそのまま選べます。` +
    `写真ごとに「この形で」などのひとことを添えられます`;
}

/* 変更モード：いまの予約に付いている画像を、質問ごとに読み込む（署名付きURLは1時間有効） */
async function loadOrderImages(token) {
  try {
    const res = await fetch(IMG_ENDPOINT(), {
      method: "POST",
      headers: {
        apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "view", manage_token: token }),
    });
    const j = await res.json();
    if (!j?.ok) return;
    for (const x of j.images || []) {
      if (!x.question_id) continue;
      const a = normAnswer(state.sel.answers.get(x.question_id));
      a.images.push({ id: x.id, url: x.url, note: x.note || "", busy: false });
      state.sel.answers.set(x.question_id, a);
    }
    renderQuestions();
  } catch { /* 読めなくても、変更そのものは進められる */ }
}

/* ---------- 6. 確認 → 注文 ---------- */
function validate() {
  const s = state.sel;
  if (!s.product || !s.variant) return "ケーキとサイズを選んでください";
  const capacityError=toppingCapacityError();
  if(capacityError)return capacityError;
  for (const g of s.product.option_groups) {
    if (g.is_required && ![...s.options.keys()].some((id) => g.options.some((o) => o.id === id)))
      return `「${g.name}」を選択してください`;
  }
  for (const [id, v] of s.options) {
    const f = findOption(id);
    if (f && v.qty > optionMaxQuantity(f.o))
      return `「${optName(f.o)}」は${optionMaxQuantity(f.o)}枚までです`;
    if (f && optName(f.o)===DETACHED_TOPPING_OPTION) {
      const selectedNames=new Set(f.g.options.filter(o=>o.id!==id&&state.sel.options.has(o.id)).map(optName));
      const detached=[...detachedToppingNames()].filter(name=>selectedNames.has(name));
      if(!detached.length)return '別添えにするものを1つ以上お選びください';
    }
    if (f?.o.text_prompt && !(v.text || "").trim())
      return `「${optName(f.o)}」：${f.o.text_prompt}`;
    if (f?.o.layer_url?.includes('{digit}')) {
      const q=state.questions.find((x)=>qLive(x)&&qOptionId(x)===id);
      const digits=(normAnswer(state.sel.answers.get(q?.id)).text||'').match(/[0-9]/g)||[];
      if(digits.length!==v.qty)return `「${optName(f.o)}」は、選んだ枚数分の数字をご記入ください`;
    }
    if (f && CALENDAR_OPTION_NAMES.has(optName(f.o))) {
      const q=state.questions.find((x)=>qLive(x)&&qOptionId(x)===id);
      const value=normAnswer(state.sel.answers.get(q?.id)).text;
      if((value||'').trim()&&!parseCalendarDate(value))return `「${q?.label || '印をつける日にち'}」をカレンダーからお選びください`;
    }
  }
  if (!s.date) return "受取日を選んでください";
  if (!s.slot) return "受取時間を選んでください";
  for (const q of askedQuestions()) {
    const a = normAnswer(s.answers.get(q.id));
    if (q.input_type === "image") {
      if (a.images.some((x) => x.busy)) return "画像の送信が終わるまで少しお待ちください";
      if (q.is_required && !a.images.length) return `「${q.label}」の画像を1枚以上お選びください`;
      if (a.images.length > imgMax(q)) return `「${q.label}」の画像は${imgMax(q)}枚までです`;
      continue;
    }
    if ((a.text || "").trim() && q.input_type === "date" && !parseIsoDate(a.text))
      return `「${q.label}」をカレンダーからお選びください`;
    if (!q.is_required) continue;
    if (!a.choiceIds.length && !(a.text || "").trim()) return `「${q.label}」にご記入ください`;
  }
  if (!$("cust-sei").value.trim() || !$("cust-mei").value.trim()) return "お名前（姓・名）をご記入ください";
  if (!STAFF_MODE && (!$("cust-sei-kana").value.trim() || !$("cust-mei-kana").value.trim()))
    return "フリガナ（セイ・メイ）をご記入ください";
  const addrReq = state.tenant.customer_form?.address;
  if (!STAFF_MODE && addrReq?.enabled && addrReq?.required && $("cust-postal")) {
    if (!$("cust-postal").value.trim()) return "郵便番号をご記入ください";
    if (!$("cust-address").value.trim()) return "ご住所をご記入ください";
  }
  if (!$("cust-phone").value.trim()) return "お電話番号をご記入ください";
  const email = $("cust-email").value.trim();
  if (STAFF_MODE) {
    // 代行登録はメール空欄OK。書いてあるなら形式だけ確認
    if (email && !email.includes("@")) return "メールアドレスをご確認ください";
  } else if (!email || !email.includes("@")) {
    return "メールアドレスをご確認ください";
  }
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
  const review = requiresReview();
  $("btn-submit").textContent = review && !TRIAL_MODE ? "この内容で見積もりを依頼する" : SUBMIT_LABEL;
  document.querySelector("#view-confirm .preview-note").textContent = review
    ? "追加希望の対応内容と金額をお店が確認します。この送信では予約は確定しません。お見積もりへの承諾後に確定します。"
    : STAFF_MODE ? "内容を確認のうえ登録してください。" : EDIT_MODE ? "内容を確認のうえ変更を確定してください。" : "この内容で注文すると、ご注文が確定します。";
  const rows = [];
  const row = (k, v) => rows.push(`<div class="confirm-row"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`);
  row("ケーキ", `${s.product.name} ${s.variant.size_label}`);
  row("価格", yen(s.variant.price));
  for (const [id, v] of s.options) {
    const f = findOption(id);
    const price = f.o.requires_review ? `${optionPrice(f.o) ? '+'+yen(optionPrice(f.o)*v.qty)+'・' : ''}追加希望は別途見積もり` : optionPrice(f.o) ? `+${yen(optionPrice(f.o) * v.qty)}` : "無料";
    const text = (v.text || "").trim() ? `「${v.text.trim()}」` : "";
    row(f.g.name, `${optName(f.o)}${v.qty > 1 ? ` ×${v.qty}` : ""}${text}（${price}）`);
  }
  for (const q of askedQuestions()) {
    const a = normAnswer(s.answers.get(q.id));
    if (q.input_type === "image") {
      if (a.images.length) {
        rows.push(`<div class="confirm-row"><span class="k">${esc(q.label)}</span>` +
          `<span class="confirm-thumbs">` +
          a.images.map((x) => `<span class="confirm-thumb"><img src="${esc(safeImageUrl(x.url))}" alt="">` +
            ((x.note || "").trim() ? `<span class="cap">${esc((x.note || "").trim())}</span>` : "") +
            `</span>`).join("") + `</span></div>`);
      }
      continue;
    }
    let v = a.text || "";
    if (a.choiceIds.length) {
      v = a.choiceIds.map((cid) => {
        const c = q.common_question_choices.find((x) => x.id === cid);
        return c ? c.label + (c.price_delta ? `（+${yen(c.price_delta)}）` : "") : "";
      }).filter(Boolean).join("、");
    }
    if (v && q.input_type === "date") {
      const date = parseIsoDate(v);
      if (date) v = `${date.year}年${date.month}月${date.day}日`;
      row(q.label, v);
    } else if (v && q.input_type === "pastel_color") {
      rows.push(`<div class="confirm-row"><span class="k">${esc(q.label)}</span><span>${answerValueHtml(v)}</span></div>`);
    } else if (v) row(q.label, v);
  }
  const [y, m, d] = s.date.split("-");
  row("受取日時", `${y}年${+m}月${+d}日 ${s.slot.label}`);
  row("お名前", `${$("cust-sei").value.trim()} ${$("cust-mei").value.trim()}`);
  const kana = `${$("cust-sei-kana").value.trim()} ${$("cust-mei-kana").value.trim()}`.trim();
  if (kana || !STAFF_MODE) row("フリガナ", kana);
  row("お電話", $("cust-phone").value.trim());
  row("メール", $("cust-email").value.trim() ||
    (STAFF_MODE ? "（なし・確認メールは送られません）" : ""));
  if ($("cust-address") && $("cust-address").value.trim())
    row("ご住所", `${$("cust-postal").value.trim()} ${$("cust-address").value.trim()}`.trim());
  row("お支払い", "店頭でのお支払い");
  rows.push(`<div class="confirm-row total"><span class="k">${review ? "選択分（税込・仮）" : "合計（税込）"}</span><span>${yen(currentTotal())}</span></div>`);
  $("confirm-detail").innerHTML = rows.join("");
  $("cancel-policy").textContent = state.tenant.cancel_policy || "";
  // 特商法の表記。店が設定していれば確認画面に折りたたみで出す（未設定なら丸ごと非表示）
  const toku = (state.tenant.tokushoho?.text || "").trim();
  $("tokushoho-text").textContent = toku;
  $("tokushoho-box").classList.toggle("hidden", !toku);
}

$("btn-submit").onclick = async () => {
  const btn = $("btn-submit");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "送信中…";
  $("submit-error").classList.add("hidden");
  try {
    const s = state.sel;
    let pending = RETRY_ENABLED ? retryStore().pending() : null;
    const previewId = pending ? null : await uploadOrderPreview();
    let payload = pending?.payload;
    if (!payload) payload = {
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
        preview_id: previewId,
        options: [...s.options].map(([option_id, v]) => ({
          option_id, quantity: v.qty, text: (v.text || "").trim() || null,
        })),
        // 非表示になった質問の残骸は送らない。チェックボックスは選んだ数だけ行を作る
        answers: (() => {
          const asked = new Set(askedQuestions().map((q) => q.id));
          const out = [];
          for (const [question_id, raw] of s.answers) {
            if (!asked.has(question_id)) continue;
            const a = normAnswer(raw);
            // 画像の回答（仮置きのid。成立した時点でサーバー側が注文と質問に紐づける）
            const imgs = a.images.filter((x) => x.id)
              .map((x) => ({ id: x.id, note: (x.note || "").trim() || null }));
            if (imgs.length) {
              out.push({ question_id, answer_text: null, choice_id: null, images: imgs });
            } else if (a.choiceIds.length) {
              for (const choice_id of a.choiceIds) out.push({ question_id, answer_text: null, choice_id });
            } else if ((a.text || "").trim()) {
              out.push({ question_id, answer_text: a.text.trim(), choice_id: null });
            }
          }
          return out;
        })(),
      },
    };
    if (RETRY_ENABLED && !pending) {
      pending = retryStore().begin(payload, s.slot.label);
      payload = pending.payload;
    }
    const r = EDIT_MODE
      ? await rpc("fn_manage_replace", { p_token: EDIT_TOKEN, p: payload.p })
      : STAFF_MODE
        ? await staffPlaceOrder(payload.p)
        : await rpc("fn_place_order", payload);
    if (!r.ok) {
      // A business rejection is definitive; transport errors remain pending.
      if (RETRY_ENABLED && r.code !== "request_conflict") retryStore().clear();
      throw new Error(r.message || (EDIT_MODE ? "ご変更を受け付けられませんでした" : "ご注文を受け付けられませんでした"));
    }

    // 確認メールの送信をキック（失敗しても注文は成立済みなので握りつぶす）
    if (!TRIAL_MODE) fetch(`${CONFIG.url}/functions/v1/send-order-emails`, {
      method: "POST",
      headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}` },
    }).catch(() => {});
    track("order_placed", { option_count: s.options.size, amount: r.total_amount });
    if (EDIT_MODE) {
      $("view-done").querySelector("h2").textContent = "ご予約内容を変更しました";
    }
    if (STAFF_MODE) {
      $("view-done").querySelector("h2").textContent = "予約を登録しました";
      $("view-done").querySelector(".done-emoji").textContent = "📞";
    }
    $("done-number").textContent = `No.${r.order_number}`;
    $("done-total").textContent = yen(r.total_amount);
    const [y, m, d] = payload.p.pickup_date.split("-");
    $("done-pickup").textContent =
      `${y}年${+m}月${+d}日 ${pending?.slotLabel || s.slot.label} に${state.tenant.name}でお渡しします。` +
      (EDIT_MODE ? "変更後の内容で確認メールをお送りします。"
       : STAFF_MODE ? ($("cust-email").value.trim()
           ? "「確認済」で登録し、お客様に確認メールをお送りします。"
           : "「確認済」で登録しました（メール未記入のため確認メールは送られません）。")
       : "確認のご連絡をお待ちください。");
    if (TRIAL_MODE) {
      $("view-done").querySelector("h2").textContent = "テスト予約を確認しました";
      $("done-number").textContent = "テスト（保存なし）";
      $("done-pickup").textContent = "この内容で予約できることを確認しました。実予約・メール・LINEは作成されていません。";
    }
    if (r.review_state === "requested" && !TRIAL_MODE) {
      $("view-done").querySelector("h2").textContent = "追加希望を受け付けました（予約未確定）";
      $("done-total").textContent = yen(r.total_amount) + "［選択分・追加希望分は未確定］";
      $("done-pickup").textContent = `${y}年${+m}月${+d}日 ${pending?.slotLabel || s.slot.label} の受取希望として受け付けました。対応内容と金額をご案内します。専用ページで承諾すると予約が確定します。`;
    }
    $("view-confirm").classList.add("hidden");
    if (!EDIT_MODE && !STAFF_MODE) clearSavedState();
    if (STAFF_MODE && !$("done-staff-back")) {
      const back = document.createElement("p");
      back.id = "done-staff-back";
      back.innerHTML = `<a href="admin/">← 管理画面に戻る</a>　` +
        `<a href="?shop=${encodeURIComponent(CONFIG.shop)}&staff=1">続けてもう1件登録する</a>`;
      $("view-done").querySelector(".done-box").appendChild(back);
    }
    // 変更・キャンセル用の専用リンク（確認メールにも同じものが載る）
    if (!STAFF_MODE && r.manage_token && !$("done-manage-link")) {
      const p2 = document.createElement("p");
      p2.className = "small";
      p2.id = "done-manage-link";
      p2.innerHTML = `${r.review_state === 'requested' ? '依頼内容・お見積もりの確認は' : 'ご予約の変更・キャンセルは'}<a href="manage.html?t=${encodeURIComponent(r.manage_token)}">こちらのページ</a>から（確認メールにも同じリンクが届きます）`;
      $("view-done").querySelector(".done-box").appendChild(p2);
    }
    // LINE通知の案内（店側でONのときだけ。メールは変わらず届く。代行登録では出さない）
    if (!STAFF_MODE && r.manage_token && state.tenant.line_notify_enabled && !$("done-line-link")) {
      const div = document.createElement("div");
      div.id = "done-line-link";
      div.className = "line-invite";
      div.innerHTML =
        `<a class="line-btn" href="${CONFIG.url}/functions/v1/line-link?t=${encodeURIComponent(r.manage_token)}">` +
        `LINEで通知を受け取る</a>` +
        `<p class="small">ご予約の控えやお知らせがLINEにも届きます（メールも変わらず届きます）</p>`;
      $("view-done").querySelector(".done-box").appendChild(div);
    }
    $("view-done").classList.remove("hidden");
    $("view-form").classList.add("hidden");
    if (RETRY_ENABLED) retryStore().clear();
    window.scrollTo({ top: 0 });
  } catch (e) {
    let uncertain = false;
    try { uncertain = RETRY_ENABLED && !!retryStore().pending(); } catch { /* storage error */ }
    $("submit-error").textContent = uncertain
      ? "送信結果を確認できませんでした。もう一度押すと、前回と同じ申し込みの結果を確認します。入力を変更しても、新しい予約は作りません。"
      : e.message;
    $("submit-error").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    let pending = false;
    try { pending = RETRY_ENABLED && !!retryStore().pending(); } catch { /* storage unavailable */ }
    btn.textContent = pending ? "前回の送信結果を確認する" : requiresReview() && !TRIAL_MODE ? "この内容で見積もりを依頼する" : SUBMIT_LABEL;
    $("btn-back").disabled = pending;
  }
};

load().catch((e) => {
  $("shop-name").textContent = "読み込みエラー";
  console.error(e);
});

/* ---------- 見た目（tenants.theme） ----------
 * 形：{ accent, type:'maru'|'kaku'|'min', logo_url, sub, adv:{bg,ink,boxbg,box,line,on,sel,selbox,selink} }
 * adv に無い色は styles.css の自動値（基調色から計算）が使われる。
 * 旧形式 { primary } は accent として読む。 */
const THEME_ADV_KEYS = ["bg", "ink", "boxbg", "box", "line", "on", "sel", "selbox", "selink"];
function applyTheme(th) {
  th = th || {};
  const root = document.documentElement;
  const accent = th.accent || th.primary || null;
  if (accent) root.style.setProperty("--accent", accent); else root.style.removeProperty("--accent");
  const adv = th.adv || {};
  for (const k of THEME_ADV_KEYS) {
    if (adv[k]) root.style.setProperty("--" + k, adv[k]); else root.style.removeProperty("--" + k);
  }
  root.classList.remove("type-maru", "type-kaku", "type-min");
  if (th.type) root.classList.add("type-" + th.type);
  const logo = document.getElementById("shop-logo"), name = document.getElementById("shop-name");
  if (logo && name) {
    if (safeImageUrl(th.logo_url)) { logo.src = safeImageUrl(th.logo_url); logo.classList.remove("hidden"); name.classList.add("hidden"); }
    else { logo.classList.add("hidden"); name.classList.remove("hidden"); }
  }
  const sub = document.getElementById("shop-sub");
  if (sub) sub.textContent = th.sub || "オーダーケーキのご予約";
}
// 管理画面「設定 › 見た目」の見本用：保存前の設定を受け取ってその場で反映（同一オリジンのみ）
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  if (e.data && e.data.type === "pokke-theme") applyTheme(e.data.theme);
});
