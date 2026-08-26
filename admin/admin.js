/* =====================================================================
 * 管理画面 v1（店頭・厨房・設定）
 * - 認証: Supabase Auth（メール+パスワード）。RLSによりログインスタッフの
 *   自店データのみ読める・書ける（テナント分離はDB層で強制）
 * - 受取リスト: ステータス変更（未確認→確認済→製造中→受渡済／キャンセル）
 * - 厨房: 商品×サイズの製造集計＋製造カード＋印刷帳票
 * - 設定: 1日上限・臨時休業・商品の公開切替
 * ===================================================================== */

const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
};

const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + n.toLocaleString("ja-JP");
// DB由来の文字列は、顧客入力・店舗設定とも必ずエスケープしてからHTMLに入れる。
// 管理画面のセッションはlocalStorageにあるため、stored XSSは店舗アカウント乗っ取りに直結する。
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[ch]);
const STATUS = {
  new: "未確認", confirmed: "確認済", in_production: "製造中",
  completed: "受渡済", canceled: "キャンセル",
};
const NEXT = { new: "confirmed", confirmed: "in_production", in_production: "completed" };

const state = { session: null, tenantId: null, tenantName: "", date: null, orders: [], tab: "pickup" };

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  t.style.opacity = 1;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.classList.add("hidden"), 400); }, 2600);
}

/* ---------- 認証 ---------- */
function saveSession(s) { localStorage.setItem("pokke_admin_session", JSON.stringify(s)); state.session = s; }
function loadSession() {
  try { state.session = JSON.parse(localStorage.getItem("pokke_admin_session")); } catch { state.session = null; }
}
async function login(email, password) {
  const res = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.msg || "ログインに失敗しました");
  saveSession(body);
}
async function refreshSession() {
  if (!state.session?.refresh_token) return false;
  const res = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: state.session.refresh_token }),
  });
  if (!res.ok) return false;
  saveSession(await res.json());
  return true;
}
function logout() {
  localStorage.removeItem("pokke_admin_session");
  state.session = null;
  showLogin();
}

/* ---------- API（自動リフレッシュ付き） ---------- */
async function api(method, path, body) {
  const doFetch = () => fetch(CONFIG.url + path, {
    method,
    headers: {
      apikey: CONFIG.anonKey,
      Authorization: `Bearer ${state.session.access_token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch();
  if (res.status === 401 && await refreshSession()) res = await doFetch();
  if (res.status === 401) { showLogin(); throw new Error("再ログインしてください"); }
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/* ---------- 画面切替 ---------- */
function showLogin() {
  $("view-login").classList.remove("hidden");
  $("view-app").classList.add("hidden");
}
async function showApp() {
  const tu = await api("GET", "/rest/v1/tenant_users?select=tenant_id");
  if (!tu.length) { toast("店舗が紐付いていません"); logout(); return; }
  state.tenantId = tu[0].tenant_id;
  const t = await api("GET",
    `/rest/v1/tenants?id=eq.${state.tenantId}&select=name,subdomain,billing_status,trial_ends_at`);
  state.tenantName = t[0]?.name || "";
  state.subdomain = t[0]?.subdomain || "";
  $("admin-shop-name").textContent = `${state.tenantName}｜管理`;
  // 電話予約の代行登録：お客様フォームを代行モードで開く（同じログインを使う）
  const staffBtn = $("btn-staff-order");
  if (staffBtn) staffBtn.onclick = () =>
    window.open(`../?shop=${encodeURIComponent(state.subdomain)}&staff=1`, "_blank");
  renderBillingBanner(t[0]);
  $("view-login").classList.add("hidden");
  $("view-app").classList.remove("hidden");
  setDate(new Date());
  loadSettings();
}

/* ---------- 課金状態バナー（SaaS） ---------- */
async function callBillingFn(name) {
  const res = await fetch(`${CONFIG.url}/functions/v1/${name}`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.url) throw new Error(json.error || "処理に失敗しました");
  location.href = json.url;
}
function renderBillingBanner(t) {
  const el = $("billing-banner");
  if (!el || !t) return;
  const status = t.billing_status || "exempt";
  state.billingStatus = status;
  // 設定タブの「ご契約・お支払い」：自店(exempt)と未登録(none)では隠す
  const box = $("billing-settings-box");
  if (box) {
    box.classList.toggle("hidden", status === "exempt" || status === "none");
    const pb = $("btn-billing-portal-settings");
    if (pb) pb.onclick = () => callBillingFn("create-portal-session").catch((e) => toast(e.message));
  }
  const portalBtn = `<button type="button" class="pill" id="btn-billing-portal">お支払い管理</button>`;
  let html = "";
  if (status === "none") {
    html = `⚠️ お支払い登録が未完了のため、予約フォームはまだ公開されていません。
      <button type="button" class="pill" id="btn-billing-checkout">お支払い登録へ（7日間無料）</button>`;
  } else if (status === "trialing") {
    const days = t.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(t.trial_ends_at) - Date.now()) / 86400000)) : null;
    html = `🎀 無料トライアル中${days !== null ? `（あと${days}日）` : ""}。期間が終わると月額課金が始まります。 ${portalBtn}`;
  } else if (status === "past_due") {
    html = `⚠️ お支払いに問題があります。カード情報をご確認ください。 ${portalBtn}`;
  } else if (status === "canceled") {
    html = `ご契約が終了しています（予約フォームは非公開）。再開するにはお支払い登録をしてください。
      <button type="button" class="pill" id="btn-billing-checkout">お支払い登録へ</button>`;
  } else {
    el.classList.add("hidden"); // active / exempt はバナーなし
    return;
  }
  el.innerHTML = html;
  el.classList.remove("hidden");
  const co = $("btn-billing-checkout");
  if (co) co.onclick = () => callBillingFn("create-checkout-session").catch((e) => toast(e.message));
  const po = $("btn-billing-portal");
  if (po) po.onclick = () => callBillingFn("create-portal-session").catch((e) => toast(e.message));
}

/* ---------- 日付 ---------- */
const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function setDate(d) {
  state.date = fmt(d);
  $("date-input").value = state.date;
  loadOrders();
}
$("date-prev").onclick = () => { const d = new Date(state.date); d.setDate(d.getDate() - 1); setDate(d); };
$("date-next").onclick = () => { const d = new Date(state.date); d.setDate(d.getDate() + 1); setDate(d); };
$("date-today").onclick = () => setDate(new Date());
$("date-input").onchange = () => { if ($("date-input").value) setDate(new Date($("date-input").value)); };

/* ---------- 注文ロード ---------- */
async function loadOrders() {
  state.orders = await api("GET",
    `/rest/v1/orders?tenant_id=eq.${state.tenantId}&pickup_date=eq.${state.date}` +
    `&order=pickup_slot_label.asc,order_number.asc` +
    `&select=*,order_items(*,order_item_options(*)),order_answers(*)`);
  renderPickup();
  renderKitchen();
}

/* ---------- 受取リスト ---------- */
function renderPickup() {
  const wrap = $("pickup-list");
  wrap.innerHTML = "";
  const active = state.orders;
  if (!active.length) {
    wrap.innerHTML = `<p class="empty-note">この日の予約はありません</p>`;
    return;
  }
  for (const o of active) {
    const item = o.order_items[0] || {};
    const card = document.createElement("div");
    card.className = "order-card" + (o.status === "canceled" ? " canceled" : "");
    card.innerHTML = `
      <div class="order-head">
        <span class="order-time">${esc(o.pickup_slot_label)}</span>
        <span class="order-name">${esc(o.customer_name)} 様
          <span class="order-product">No.${esc(o.order_number)}　${esc(item.product_name_snapshot)} ${esc(item.variant_label_snapshot)}</span>
        </span>
        <span class="order-total">${yen(o.total_amount)}</span>
        <span class="status-badge st-${o.status}">${STATUS[o.status]}</span>
        ${o.created_via === "staff" ? `<span class="status-badge st-staff">電話</span>` : ""}
        ${o.mail_failed ? `<span class="status-badge st-mailfail">メール未送信</span>` : ""}
      </div>
      <div class="order-body hidden"></div>`;
    const body = card.querySelector(".order-body");
    card.querySelector(".order-head").onclick = () => {
      if (body.classList.contains("hidden")) { fillOrderBody(body, o); body.classList.remove("hidden"); }
      else body.classList.add("hidden");
    };
    wrap.appendChild(card);
  }
}
function fillOrderBody(el, o) {
  const rows = [];
  const row = (k, v) => rows.push(`<div class="confirm-row"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`);
  for (const it of o.order_items) {
    for (const op of it.order_item_options) {
      row(op.group_name_snapshot,
        `${op.option_name_snapshot}${op.quantity > 1 ? ` ×${op.quantity}` : ""}` +
        (op.option_text ? `「${op.option_text}」` : ""));
    }
  }
  for (const a of o.order_answers) {
    if (a.answer_text || a.choice_label_snapshot) row(a.label_snapshot, a.answer_text || a.choice_label_snapshot);
  }
  if (o.customer_kana) row("フリガナ", o.customer_kana);
  const phone = String(o.customer_phone ?? "");
  const tel = phone.replace(/[^0-9+*#,;]/g, "");
  rows.push(`<div class="confirm-row"><span class="k">電話</span><span><a href="tel:${esc(tel)}">${esc(phone)}</a></span></div>`);
  row("メール", o.customer_email);
  row("支払い", o.payment_method === "store" ? "店頭払い" : o.payment_method);
  let actions = "";
  if (o.status !== "canceled" && o.status !== "completed") {
    actions += `<button type="button" class="pill next-btn">→ ${STATUS[NEXT[o.status]]}にする</button>`;
  }
  if (o.status !== "canceled") {
    actions += `<button type="button" class="pill danger cancel-btn">キャンセル</button>`;
  }
  if (o.mail_failed) {
    actions += `<button type="button" class="pill mail-btn">確認メールを再送</button>`;
  }
  el.innerHTML = rows.join("") + (actions ? `<div class="order-actions">${actions}</div>` : "");
  el.querySelector(".next-btn")?.addEventListener("click", () => updateStatus(o, NEXT[o.status]));
  el.querySelector(".mail-btn")?.addEventListener("click", () => resendMail(o));
  el.querySelector(".cancel-btn")?.addEventListener("click", () => {
    if (confirm(`No.${o.order_number} ${o.customer_name}様の予約をキャンセルしますか？（枠が1つ戻ります）`))
      updateStatus(o, "canceled");
  });
}
/** 確認メールの再送：送信待ちに戻して送信ワーカーを起こす（宛先・本文はサーバー側で組む） */
async function resendMail(o) {
  try {
    await api("PATCH", `/rest/v1/order_emails?order_id=eq.${o.id}&status=neq.sent`,
      { status: "pending", attempts: 0, processing_at: null, last_error: null });
    await api("PATCH", `/rest/v1/orders?id=eq.${o.id}`, { mail_failed: false });
    await fetch(`${CONFIG.url}/functions/v1/send-order-emails`, {
      method: "POST",
      headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}` },
    });
    toast(`No.${o.order_number} の確認メールを送信しました`);
  } catch (e) {
    toast("再送に失敗しました：" + e.message);
  }
  loadOrders();
}

async function updateStatus(o, status) {
  await api("PATCH", `/rest/v1/orders?id=eq.${o.id}`, { status });
  toast(`No.${o.order_number} を「${STATUS[status]}」にしました`);
  loadOrders();
}

/* ---------- 厨房ビュー ---------- */
function renderKitchen() {
  const [y, m, d] = state.date.split("-");
  $("kitchen-title").textContent = `${y}年${+m}月${+d}日 製造一覧（${state.tenantName}）`;
  const active = state.orders.filter((o) => o.status !== "canceled");
  // 集計: 商品×サイズ
  const agg = new Map();
  for (const o of active) for (const it of o.order_items) {
    const key = `${it.product_name_snapshot}｜${it.variant_label_snapshot || ""}`;
    agg.set(key, (agg.get(key) || 0) + it.quantity);
  }
  let sum = `<table class="kitchen-table"><tr><th>商品</th><th>サイズ</th><th style="width:70px">台数</th></tr>`;
  let total = 0;
  for (const [key, qty] of agg) {
    const [name, size] = key.split("｜");
    sum += `<tr><td>${esc(name)}</td><td>${esc(size)}</td><td class="qty-cell">${esc(qty)}</td></tr>`;
    total += qty;
  }
  sum += `<tr><td colspan="2"><strong>合計</strong></td><td class="qty-cell">${total}</td></tr></table>`;
  $("kitchen-summary").innerHTML = active.length ? sum : `<p class="empty-note">この日の製造はありません</p>`;

  // 製造カード（1台ごとの作る内容）
  const wrap = $("kitchen-detail");
  wrap.innerHTML = "";
  for (const o of active) {
    const it = o.order_items[0] || {};
    const opts = (it.order_item_options || [])
      .map((op) => `<li>${esc(op.group_name_snapshot)}: ${esc(op.option_name_snapshot)}` +
        `${op.quantity > 1 ? ` ×${esc(op.quantity)}` : ""}${op.option_text ? `「${esc(op.option_text)}」` : ""}</li>`)
      .join("");
    const plate = o.order_answers.find((a) => a.label_snapshot.includes("メッセージ"));
    const notes = o.order_answers
      .filter((a) => a !== plate && (a.answer_text || a.choice_label_snapshot))
      .map((a) => `<li>${esc(a.label_snapshot)}: ${esc(a.answer_text || a.choice_label_snapshot)}</li>`)
      .join("");
    const card = document.createElement("div");
    card.className = "kcard";
    card.innerHTML = `
      <div class="khead"><span>${esc(o.pickup_slot_label)}</span>
        <span>No.${esc(o.order_number)} ${esc(o.customer_name)}様</span>
        <span>${esc(it.product_name_snapshot)} ${esc(it.variant_label_snapshot)}</span></div>
      <ul>${opts}${notes}</ul>
      ${plate?.answer_text ? `<span class="plate">プレート：「${esc(plate.answer_text)}」</span>` : ""}`;
    wrap.appendChild(card);
  }
}
$("btn-print").onclick = () => window.print();

/* ---------- 設定の保存（画面下の保存バー1つにまとめる） ---------- */
state.fields = [];
function regField(table, id, column, el, opts = {}) {
  const get = opts.get || (() => {
    if (el.type === "checkbox") return el.checked;
    const v = el.value.trim();
    if (opts.number) return v === "" ? null : parseInt(v, 10);
    return v === "" ? null : v;
  });
  state.fields.push({ table, id, column, el, get, original: get() });
  const evt = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(evt, markDirty);
}
function collectChanges() {
  const changes = new Map();
  for (const f of state.fields) {
    if (!document.body.contains(f.el)) continue;
    const v = f.get();
    if (JSON.stringify(v) === JSON.stringify(f.original)) continue;
    const key = `${f.table}:${f.id}`;
    if (!changes.has(key)) changes.set(key, { table: f.table, id: f.id, patch: {} });
    changes.get(key).patch[f.column] = v;
  }
  return [...changes.values()];
}
function markDirty() {
  const n = collectChanges().length;
  state.dirty = n > 0;
  $("save-bar").classList.toggle("dirty", state.dirty);
  $("save-status").textContent = state.dirty ? "保存していない変更があります" : "変更はありません";
  $("btn-save-all").disabled = !state.dirty;
}
async function saveAll() {
  const changes = collectChanges();
  if (!changes.length) { toast("変更はありません"); return; }
  const btn = $("btn-save-all");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    for (const c of changes) {
      await api("PATCH", `/rest/v1/${c.table}?id=eq.${c.id}`, c.patch);
    }
    toast(`保存しました（${changes.length}件）`);
    state.dirty = false;
    if (state.tenantName !== $("t-name").value.trim()) {
      state.tenantName = $("t-name").value.trim();
      $("admin-shop-name").textContent = `${state.tenantName}｜管理`;
    }
    await loadSettings();
  } catch (e) {
    toast("保存できませんでした：" + e.message);
  } finally {
    btn.textContent = "保存する";
    markDirty();
  }
}
$("btn-save-all").onclick = saveAll;
window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- 設定 ---------- */
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
async function loadTenantForm() {
  const t = (await api("GET", `/rest/v1/tenants?id=eq.${state.tenantId}&select=*`))[0];
  $("t-name").value = t.name || "";
  $("t-email").value = t.contact_email || "";
  $("t-cutoff").value = (t.order_cutoff_time || "21:00").slice(0, 5);
  $("t-deadline").value = t.default_deadline_days ?? 3;
  const mode = t.deadline_skip_closed_days ? "business" : "calendar";
  [...document.querySelectorAll('input[name="deadline-mode"]')].forEach((r) => { r.checked = r.value === mode; });
  $("t-cancel").value = t.cancel_policy || "";
  const cf = t.customer_form?.address ?? { enabled: false, required: false };
  $("t-addr-enabled").checked = !!cf.enabled;
  $("t-addr-required").checked = !!cf.required;
  $("t-addr-required").disabled = !cf.enabled;
  $("t-addr-enabled").onchange = () => {
    $("t-addr-required").disabled = !$("t-addr-enabled").checked;
    if (!$("t-addr-enabled").checked) $("t-addr-required").checked = false;
    markDirty();
  };
  $("t-addr-required").onchange = markDirty;
  $("t-tokushoho").value = t.tokushoho?.text || "";
  // お客様セルフ操作（変更・キャンセル）の期限設定
  $("t-self-enabled").checked = t.self_manage_enabled !== false;
  $("t-self-slot-days").value = t.self_slot_days ?? 1;
  $("t-self-slot-time").value = (t.self_slot_time || "12:00").slice(0, 5);
  $("t-self-content-days").value = t.self_content_days ?? 2;
  $("t-self-content-time").value = (t.self_content_time || "12:00").slice(0, 5);
  $("t-self-cancel-days").value = t.self_cancel_days ?? 1;
  $("t-self-cancel-time").value = (t.self_cancel_time || "09:00").slice(0, 5);
  const w = $("t-weekdays");
  w.innerHTML = "";
  WEEKDAYS.forEach((name, i) => {
    const on = (t.closed_weekdays || []).includes(i);
    const lb = document.createElement("label");
    lb.className = on ? "on" : "";
    lb.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}>${name}`;
    lb.querySelector("input").onchange = (e) => { lb.classList.toggle("on", e.target.checked); markDirty(); };
    w.appendChild(lb);
  });

  // 保存バーで一括保存する項目を登録
  const T = state.tenantId;
  regField("tenants", T, "name", $("t-name"));
  regField("tenants", T, "contact_email", $("t-email"));
  regField("tenants", T, "order_cutoff_time", $("t-cutoff"));
  regField("tenants", T, "default_deadline_days", $("t-deadline"), { number: true });
  regField("tenants", T, "cancel_policy", $("t-cancel"));
  regField("tenants", T, "customer_form", $("t-addr-enabled"), {
    get: () => ({ address: { enabled: $("t-addr-enabled").checked,
                             required: $("t-addr-enabled").checked && $("t-addr-required").checked } }),
  });
  regField("tenants", T, "tokushoho", $("t-tokushoho"),
    { get: () => ($("t-tokushoho").value.trim() ? { text: $("t-tokushoho").value.trim() } : null) });
  regField("tenants", T, "self_manage_enabled", $("t-self-enabled"));
  regField("tenants", T, "self_slot_days", $("t-self-slot-days"), { number: true });
  regField("tenants", T, "self_slot_time", $("t-self-slot-time"));
  regField("tenants", T, "self_content_days", $("t-self-content-days"), { number: true });
  regField("tenants", T, "self_content_time", $("t-self-content-time"));
  regField("tenants", T, "self_cancel_days", $("t-self-cancel-days"), { number: true });
  regField("tenants", T, "self_cancel_time", $("t-self-cancel-time"));
  regField("tenants", T, "closed_weekdays", w, {
    get: () => [...w.querySelectorAll("input")].map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0),
  });
  const modeEls = [...document.querySelectorAll('input[name="deadline-mode"]')];
  modeEls.forEach((r) => r.addEventListener("change", markDirty));
  regField("tenants", T, "deadline_skip_closed_days", modeEls[0], {
    get: () => document.querySelector('input[name="deadline-mode"]:checked')?.value === "business",
  });
}
async function unusedTenantSave() {
  const closed = [...$("t-weekdays").querySelectorAll("input")]
    .map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0);
  const name = $("t-name").value.trim();
  const email = $("t-email").value.trim();
  if (!name || !email) { toast("店名と通知メールは必須です"); return; }
  await api("PATCH", `/rest/v1/tenants?id=eq.${state.tenantId}`, {
    name, contact_email: email,
    closed_weekdays: closed,
    order_cutoff_time: $("t-cutoff").value || "21:00",
    default_deadline_days: Math.max(0, parseInt($("t-deadline").value || "3", 10) || 3),
    deadline_skip_closed_days:
      document.querySelector('input[name="deadline-mode"]:checked')?.value === "business",
    cancel_policy: $("t-cancel").value.trim() || null,
    tokushoho: $("t-tokushoho").value.trim() ? { text: $("t-tokushoho").value.trim() } : null,
  });
  state.tenantName = name;
  $("admin-shop-name").textContent = `${name}｜管理`;
  toast("店舗情報を保存しました");
};

// 「商品ごとの上限」は商品エディタ（products.html）の各商品ページへ移設（まりほ指摘 2026-08-25：分類が変）

async function loadSettings() {
  state.fields = []; // 入力欄の登録をやり直す
  await loadTenantForm();
  // 全体の上限ルール（商品指定でないもの）
  const rules = await api("GET",
    `/rest/v1/capacity_rules?tenant_id=eq.${state.tenantId}&scope=neq.products&order=name`);
  const rw = $("rules-list");
  rw.innerHTML = "";
  for (const r of rules) {
    const row = document.createElement("div");
    row.className = "rule-row";
    row.innerHTML = `<span class="rule-name">${esc(r.name)}</span>
      <input type="number" min="0" placeholder="なし" value="${r.daily_limit ?? ""}"> 台/日`;
    regField("capacity_rules", r.id, "daily_limit", row.querySelector("input"), { number: true });
    rw.appendChild(row);
  }

  // 商品ごとの設定（締切・公開・上限）は商品エディタ（products.html）に集約（まりほ指摘 2026-08-25）

  // 受取時間枠
  await loadSlots();

  markDirty();

  // 臨時休業
  const ovs = await api("GET",
    `/rest/v1/date_overrides?tenant_id=eq.${state.tenantId}&order=date&date=gte.${fmt(new Date())}`);
  const ow = $("overrides-list");
  ow.innerHTML = ovs.length ? "" : `<p class="small">登録なし</p>`;
  for (const ov of ovs) {
    const row = document.createElement("div");
    row.className = "ov-row";
    row.innerHTML = `<span style="flex:1">${esc(ov.date)}　${ov.kind === "closed" ? "臨時休業" : "臨時営業"}</span>
      <button type="button" class="pill danger">削除</button>`;
    row.querySelector("button").onclick = async () => {
      await api("DELETE", `/rest/v1/date_overrides?id=eq.${ov.id}`);
      loadSettings();
    };
    ow.appendChild(row);
  }

}
/* ---------- 受取時間枠の設定 ---------- */
const hm = (t) => t.slice(0, 5); // "11:00:00" -> "11:00"
async function loadSlots() {
  const slots = await api("GET",
    `/rest/v1/pickup_time_slots?tenant_id=eq.${state.tenantId}&order=start_time`);
  const wrap = $("slots-list");
  wrap.innerHTML = slots.length ? "" : `<p class="small">枠がありません。上の「まとめて追加」で作成してください。</p>`;
  for (const s of slots) {
    const row = document.createElement("div");
    row.className = "rule-row";
    row.innerHTML = `
      <span class="rule-name">${hm(s.start_time)}</span>
      上限 <input type="number" min="0" placeholder="なし" value="${s.daily_capacity ?? ""}"> 台
      <span class="state-badge ${s.is_active ? "on" : ""}">${s.is_active ? "使用中" : "停止中"}</span>
      <button type="button" class="pill toggle-btn">${s.is_active ? "停止する" : "再開する"}</button>
      <button type="button" class="pill danger del-btn">削除</button>`;
    regField("pickup_time_slots", s.id, "daily_capacity", row.querySelector("input"), { number: true });
    row.querySelector(".toggle-btn").onclick = async () => {
      await api("PATCH", `/rest/v1/pickup_time_slots?id=eq.${s.id}`, { is_active: !s.is_active });
      loadSlots();
    };
    row.querySelector(".del-btn").onclick = async () => {
      try {
        await api("DELETE", `/rest/v1/pickup_time_slots?id=eq.${s.id}`);
        toast(`${hm(s.start_time)} を削除しました`);
      } catch {
        toast("この枠には予約があるため削除できません（無効化を使ってください）");
      }
      loadSlots();
    };
    wrap.appendChild(row);
  }
  state._slots = slots;
}
async function addSlots(times) {
  const existing = new Set((state._slots || []).map((s) => hm(s.start_time)));
  const rows = times
    .filter((t) => !existing.has(t))
    .map((t) => ({
      tenant_id: state.tenantId, label: t.replace(/^0/, ""), start_time: t,
      display_order: parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10),
    }));
  if (!rows.length) { toast("追加する枠はありません（すべて登録済み）"); return; }
  await api("POST", "/rest/v1/pickup_time_slots", rows);
  toast(`${rows.length}枠を追加しました`);
  loadSlots();
}
$("btn-slot-bulk").onclick = () => {
  const start = $("slot-start").value, end = $("slot-end").value;
  const step = parseInt($("slot-interval").value, 10);
  if (!start || !end || start > end) { toast("開始と終了の時刻を確認してください"); return; }
  const times = [];
  let [h, m] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  while (h * 60 + m <= eh * 60 + em) {
    times.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    m += step;
    h += Math.floor(m / 60);
    m %= 60;
  }
  addSlots(times);
};
$("btn-slot-add").onclick = () => {
  const t = $("slot-one").value;
  if (!t) { toast("時刻を選んでください"); return; }
  addSlots([t]);
};

$("btn-ov-add").onclick = async () => {
  const date = $("ov-date").value;
  if (!date) { toast("日付を選んでください"); return; }
  await api("POST", "/rest/v1/date_overrides",
    [{ tenant_id: state.tenantId, date, kind: $("ov-kind").value }]);
  $("ov-date").value = "";
  toast("登録しました");
  loadSettings();
};

/* ---------- タブ・ログインUI ---------- */
document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("selected"));
    b.classList.add("selected");
    state.tab = b.dataset.tab;
    $("tab-pickup").classList.toggle("hidden", state.tab !== "pickup");
    $("tab-kitchen").classList.toggle("hidden", state.tab !== "kitchen");
    $("tab-settings").classList.toggle("hidden", state.tab !== "settings");
    $("date-nav").classList.toggle("hidden", state.tab === "settings");
    // 保存バーは設定タブでだけ出す
    $("save-bar").classList.toggle("hidden", state.tab !== "settings");
  };
});
$("btn-login").onclick = async () => {
  $("login-error").classList.add("hidden");
  try {
    await login($("login-email").value.trim(), $("login-password").value);
    await showApp();
  } catch (e) {
    $("login-error").textContent = e.message;
    $("login-error").classList.remove("hidden");
  }
};
$("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-login").click(); });
$("btn-logout").onclick = logout;
$("link-forgot").onclick = async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  if (!email) { toast("メールアドレスを入力してから押してください"); return; }
  await fetch(`${CONFIG.url}/auth/v1/recover`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, options: {} , gotrue_meta_security: {}}),
  });
  // 存在しないメールでも同じ表示（メールアドレスの存在を漏らさない）
  $("forgot-sent").classList.remove("hidden");
};

/* ---------- 起動 ---------- */
(async () => {
  loadSession();
  if (state.session) {
    try { await showApp(); return; } catch { /* 失効 → ログインへ */ }
  }
  showLogin();
})();
