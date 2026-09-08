/* =====================================================================
 * 管理画面 v1（店頭・厨房・設定）
 * - 認証: Supabase Auth（メール+パスワード）。RLSによりログインスタッフの
 *   自店データのみ読める・書ける（テナント分離はDB層で強制）
 * - 受取リスト: 状態管理（未確認→確認済／キャンセル）。旧状態は確認済として表示。
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
  new: "未確認", confirmed: "確認済", in_production: "確認済",
  completed: "確認済", canceled: "キャンセル",
};

const state = { session: null, tenantId: null, tenantName: "", date: null, orders: [], tab: "pickup",
  // お客様へのメール文面（設定タブ）。編集中の種類と、種類ごとの下書き
  mailKind: "customer", mailCh: "mail", formUrl: "", mailTexts: {}, mailLight: null, mailBound: false };

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  t.style.opacity = 1;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.classList.add("hidden"), 400); }, 2600);
}

/* ---------- 入力欄をスクロールから守る（2026-09-06） ----------
 * ブラウザの仕様で、数値・日時の入力欄はフォーカスされているとホイールで値が変わる。
 * 空の datetime-local はそれだけで「いまの日時」が入る。
 * 実際に本番で「受付開始」に身に覚えのない日時（保存の86秒前・秒は00）が入っていた。
 * 価格や台数でも同じ事故が起きるので、ホイールが来たらフォーカスを外して値を守る。 */
const SPINNABLE = /^(number|date|datetime-local|time|month|week)$/;
document.addEventListener("wheel", (e) => {
  const el = document.activeElement;
  if (!el || el !== e.target || !SPINNABLE.test(el.type)) return;
  e.preventDefault();   // 値を動かさない（passiveだと止められないので、この監視は非passive）
  el.blur();
  // 日付欄はblurしても中の桁にフォーカスが残る（Chrome）。
  // そのままだとページが動かず固まって見えるので、代わりに自分でスクロールする
  if (document.activeElement === el) window.scrollBy(0, e.deltaY);
}, { passive: false });

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
  if (typeof resetReports === "function") resetReports();
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
  const data = t ? JSON.parse(t) : null;
  const table = path.match(/^\/rest\/v1\/([a-z_]+)(?:\?|$)/)?.[1];
  if (method === "DELETE" && table && Array.isArray(data)) {
    const ids = data.map(row => row.id);
    drafts.forget(table, ids);
    state.fields = state.fields.filter(f => f.table !== table || !ids.includes(f.id));
  }
  return method === "GET" && table ? drafts.overlay(table, data) : data;
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
    `/rest/v1/tenants?id=eq.${state.tenantId}&select=name,subdomain,billing_status,trial_ends_at,theme`);
  state.tenantName = t[0]?.name || "";
  // 管理画面の基調色は店の色（見出し・選んだタブ・保存ボタン）。無ければ admin.css の既定色
  const accent = t[0]?.theme?.accent || t[0]?.theme?.primary;
  if (accent) document.documentElement.style.setProperty("--accent", accent);
  state.subdomain = t[0]?.subdomain || "";
  $("admin-shop-name").textContent = `${state.tenantName}｜管理`;
  // 電話予約の代行登録：お客様フォームを代行モードで開く（同じログインを使う）
  const staffBtn = $("btn-staff-order");
  if (staffBtn) staffBtn.onclick = () => {
    window.open(`../?shop=${encodeURIComponent(state.subdomain)}${state.billingStatus === "setup_trial" ? "&trial=1" : "&staff=1"}`, "_blank");
    $("admin-body").classList.remove("menu-open");
    $("menu-btn").setAttribute("aria-expanded", "false");
  };
  renderBillingBanner(t[0]);
  $("view-login").classList.add("hidden");
  $("view-app").classList.remove("hidden");
  setDate(new Date());
  loadSettings();
  // 独立した商品設定ページからも、選んだ管理画面へ直接戻れる。
  const requestedTab = new URLSearchParams(location.search).get("tab");
  if (["pickup", "kitchen", "reports", "settings", "design", "support", "account", "billing"].includes(requestedTab)) {
    // 旧「製造ケーキ一覧」へのリンクも、統合後の「予約・製造」を開く。
    const tab = requestedTab === "kitchen" ? "pickup" : requestedTab;
    document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
  }
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
  const labels = { setup_trial: "カード不要のお試し中", exempt: "課金対象外", none: "お支払い未登録", trialing: "無料トライアル中", active: "ご契約中", past_due: "お支払いの確認が必要です", unpaid: "未払いのため利用停止中", canceled: "解約済み", incomplete: "お支払い手続き中", incomplete_expired: "お支払い手続きの期限切れ", paused: "ご契約を一時停止中" };
  $("billing-page-status").textContent = labels[status] || "ご契約状況を確認してください";
  $("billing-page-trial").textContent = ["trialing", "setup_trial"].includes(status) && t.trial_ends_at
    ? `無料期間の終了日：${new Date(t.trial_ends_at).toLocaleDateString("ja-JP")}` : "";
  $("billing-page-help").textContent = status === "exempt"
    ? "この店舗は課金対象外です。お支払い登録は不要です。"
    : "カードの変更・請求書の確認・解約は、Stripeのお支払い管理で行えます。";
  $("btn-billing-page-checkout").classList.toggle("hidden", !["setup_trial", "none", "canceled", "incomplete_expired"].includes(status));
  $("btn-billing-page-portal").classList.toggle("hidden", ["setup_trial", "exempt", "none", "incomplete_expired"].includes(status));
  const portalBtn = `<button type="button" class="pill" id="btn-billing-portal">お支払い管理</button>`;
  let html = "";
  if (status === "setup_trial") {
    const expired = !t.trial_ends_at || new Date(t.trial_ends_at) <= new Date();
    $("billing-page-status").textContent = expired ? "お試し終了・休止中" : "カード不要のお試し中";
    $("billing-page-help").textContent = "有料契約の決済完了から月額4,980円（税込）がかかり、本予約の受付を開始します。自動課金はありません。";
    html = expired ? "7日間のお試しが終了しました。設定は保存されています。" : "カード不要の7日間お試し中です。本予約は受け付けません。";
    if (!expired) html += ` <a class="pill" href="../?shop=${encodeURIComponent(t.subdomain)}&trial=1" target="_blank">テスト予約を試す</a>`;
    html += ` <button type="button" class="pill" id="btn-billing-checkout">有料契約へ（月額4,980円）</button>`;
  } else if (status === "none") {
    html = `⚠️ お支払い登録が未完了のため、予約フォームはまだ公開されていません。
      <button type="button" class="pill" id="btn-billing-checkout">有料契約へ（月額4,980円）</button>`;
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
    `&select=*,order_items(*,order_item_options(*)),order_answers(*),order_images(id,path,question_id,note,created_at),order_previews(id,path,created_at)`);
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
        <span class="order-name">${esc(o.customer_name)} 様${o.customer_kana ? ` <span class="order-kana">（${esc(o.customer_kana)}）</span>` : ""}
          <span class="order-product">No.${esc(o.order_number)}　${esc(item.product_name_snapshot)} ${esc(item.variant_label_snapshot)}</span>
        </span>
        <span class="order-total">${yen(o.total_amount)}</span>
        <span class="status-badge st-${o.status}">${STATUS[o.status]}</span>
        ${o.created_via === "staff" ? `<span class="status-badge st-staff">電話</span>` : ""}
        ${(o.order_images || []).length ? `<span class="status-badge st-image" title="お客様の添付画像あり">📷${o.order_images.length}</span>` : ""}
        ${(o.order_previews || []).length ? `<span class="status-badge st-preview" title="予約時の完成イメージあり">🎨 完成イメージ</span>` : ""}
        ${o.mail_failed ? `<span class="status-badge st-mailfail">メール未送信</span>` : ""}
      </div>
      ${o.status === "new" ? '<div class="order-actions"><button type="button" class="pill confirm-order-btn">→ 確認済にする</button></div>' : ''}
      <div class="order-body hidden"></div>`;
    card.querySelector('.confirm-order-btn')?.addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try { await updateStatus(o, "confirmed"); }
      catch { toast("確認済みにできませんでした。通信状態を確認して、もう一度お試しください。"); button.disabled = false; }
    });
    const body = card.querySelector(".order-body");
    card.querySelector(".order-head").onclick = () => {
      if (body.classList.contains("hidden")) { fillOrderBody(body, o); body.classList.remove("hidden"); }
      else body.classList.add("hidden");
    };
    wrap.appendChild(card);
  }
}
/* お客様が添付した画像（非公開バケット）を見るための署名付きURL。
 * 店のログインで Storage に直接署名を頼む（ポリシー order_images_staff_object_read）。
 * 有効期限は1時間。画面を開き直せばまた新しいURLが出る。 */
async function signOrderImages(images) {
  const out = [];
  for (const im of [...(images || [])].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))) {
    try {
      const r = await api("POST", `/storage/v1/object/sign/order-images/${im.path}`, { expiresIn: 3600 });
      if (r?.signedURL) out.push({
        id: im.id, question_id: im.question_id, note: im.note,
        url: CONFIG.url + "/storage/v1" + r.signedURL,
      });
    } catch { /* 1枚読めなくても残りは見せる */ }
  }
  return out;
}

async function ensureOrderPreviewUrl(o) {
  if (o._preview_url) return o._preview_url;
  const preview = (o.order_previews || [])[0];
  if (!preview?.path) return null;
  try {
    const r = await api("POST", `/storage/v1/object/sign/order-images/${preview.path}`, { expiresIn: 3600 });
    if (r?.signedURL) o._preview_url = CONFIG.url + "/storage/v1" + r.signedURL;
  } catch { /* 完成イメージだけ読めなくても予約詳細は見せる */ }
  return o._preview_url || null;
}

async function paintOrderPreview(box, o) {
  const url = await ensureOrderPreviewUrl(o);
  if (!url) { box.remove(); return; }
  box.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="予約時の完成イメージ"></a>` +
    `<span>予約時にお客様が確認したイメージです</span>`;
}
/* 予約詳細に画像を並べる（タップで原寸を別タブ） */
async function paintOrderImages(box, o) {
  const signed = await signOrderImages(o.order_images);
  if (!signed.length) { box.remove(); return; }
  const cell = (list) => list.map((x) =>
    `<span class="order-image"><a href="${x.url}" target="_blank" rel="noopener">` +
    `<img src="${x.url}" alt="お客様の添付画像"></a>` +
    (x.note ? `<span class="cap">${esc(x.note)}</span>` : "") + `</span>`).join("");
  // 質問ごとにまとめて、その質問の行（「2枚」と出ている行）を画像そのものに置き換える
  const byQ = new Map();
  const rest = [];
  for (const x of signed) {
    if (!x.question_id) { rest.push(x); continue; }
    byQ.set(x.question_id, [...(byQ.get(x.question_id) || []), x]);
  }
  const body = box.parentElement;
  for (const [qid, list] of byQ) {
    const target = body.querySelector(`[data-q="${qid}"] .v`);
    if (target) target.outerHTML = `<span class="order-images">${cell(list)}</span>`;
    else rest.push(...list);
  }
  if (!rest.length) { box.previousElementSibling?.remove(); box.remove(); return; }
  box.innerHTML = cell(rest);
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
    const v = a.answer_text || a.choice_label_snapshot;
    if (!v) continue;
    // 画像の回答は、あとで paintOrderImages がこの行にサムネイルを入れる
    rows.push(`<div class="confirm-row" data-q="${esc(a.question_id || "")}">` +
      `<span class="k">${esc(a.label_snapshot)}</span><span class="v">${esc(v)}</span></div>`);
  }
  const phone = String(o.customer_phone ?? "");
  const tel = phone.replace(/[^0-9+*#,;]/g, "");
  rows.push(`<div class="confirm-row"><span class="k">電話</span><span><a href="tel:${esc(tel)}">${esc(phone)}</a></span></div>`);
  row("メール", o.customer_email);
  row("支払い", o.payment_method === "store" ? "店頭払い" : o.payment_method);
  let actions = "";
  if (o.status !== "canceled") {
    actions += `<button type="button" class="pill danger cancel-btn">キャンセル</button>`;
  }
  if (o.mail_failed) {
    actions += `<button type="button" class="pill mail-btn">確認メールを再送</button>`;
  }
  const hasImages = (o.order_images || []).length > 0;
  const hasPreview = (o.order_previews || []).length > 0;
  el.innerHTML = (hasPreview ? `<div class="order-preview">読み込み中…</div>` : "") + rows.join("") +
    (hasImages ? `<div class="confirm-row"><span class="k">添付画像</span></div>
       <div class="order-images">読み込み中…</div>` : "") +
    (actions ? `<div class="order-actions">${actions}</div>` : "");
  if (hasImages) paintOrderImages(el.querySelector(".order-images"), o);
  if (hasPreview) paintOrderPreview(el.querySelector(".order-preview"), o);
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
        <span>No.${esc(o.order_number)} ${esc(o.customer_name)}様${(o.order_images || []).length ? ` 📷${esc(o.order_images.length)}` : ""}${(o.order_previews || []).length ? " 🎨" : ""}</span>
        <span>${esc(it.product_name_snapshot)} ${esc(it.variant_label_snapshot)}</span></div>
      ${o._preview_url ? `<div class="kpreview"><img src="${esc(o._preview_url)}" alt="予約時の完成イメージ"><span>完成イメージ</span></div>` : ""}
      <ul>${opts}${notes}</ul>
      ${plate?.answer_text ? `<span class="plate">プレート：「${esc(plate.answer_text)}」</span>` : ""}`;
    wrap.appendChild(card);
  }
}
$("btn-print").onclick = async () => {
  await Promise.all(state.orders.filter((o) => o.status !== "canceled").map(ensureOrderPreviewUrl));
  renderKitchen();
  await Promise.all([...document.querySelectorAll("#kitchen-detail img")].map((img) =>
    img.complete ? Promise.resolve() : new Promise((resolve) => { img.onload = img.onerror = resolve; })));
  window.print();
};

/* ---------- 設定の保存（画面下の保存バー1つにまとめる） ---------- */
state.fields = [];
const drafts = createEditDrafts();
function regField(table, id, column, el, opts = {}) {
  const get = opts.get || (() => {
    if (el.type === "checkbox") return el.checked;
    const v = el.value.trim();
    if (opts.number) return v === "" ? null : parseInt(v, 10);
    return v === "" ? null : v;
  });
  state.fields.push(drafts.register({ table, id, column, el, get, original: get() }));
  const evt = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(evt, markDirty);
}
function collectChanges() {
  return drafts.changes(state.fields);
}

function markDirty() {
  const n = collectChanges().length;
  state.dirty = n > 0;
  $("save-bar").classList.toggle("dirty", state.dirty);
  $("save-status").textContent = state.dirty ? "保存していない変更があります" : "変更はありません";
  $("btn-save-all").disabled = !!state.saving || !state.dirty;
}
async function saveChange(c) {
  await api("PATCH", `/rest/v1/${c.table}?id=eq.${c.id}`, c.patch);
}
async function saveAll() {
  if (state.saving) return;
  const changes = collectChanges();
  if (!changes.length) { toast("変更はありません"); return; }
  const btn = $("btn-save-all");
  state.saving = true;
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    for (const c of changes) {
      await saveChange(c);
      drafts.acknowledge(c, state.fields);
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
    state.saving = false;
    btn.textContent = "保存する";
    markDirty();
  }
}
$("btn-save-all").onclick = saveAll;
window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- お客様へのメール／LINEの文面（設定タブ） ----------
 * 店主が書けるのは3つだけ：はじめの文・おわりに足す文・お支払いの1行。
 * 予約番号・受取日時・ご注文内容・合計金額は注文から自動で作る部分なので編集させない
 * （消せてしまうと、受取日時の書いていない確認メールが送れてしまう）。
 * 「※このメールは送信専用です。」などの締めの文も固定にしてある。置き換え式にすると
 * 消せてしまうし、メール用の文言がそのままLINEに出てしまう。
 *
 * 文面の正本はDBの fn_render_order_email / fn_render_line_message。
 * ここの見本は、どこに何が入るかを見せるためにJSで同じ形を組み立てている。
 * 既定文がSQLとズレていないかは scripts/test_mail_texts_defaults.mjs が見張る。
 */
const MAIL_KINDS = [
  { k: "customer", label: "ご予約確認",
    subject: "ご予約を承りました",
    intro: "このたびはご予約いただきありがとうございます。\n以下の内容で承りました。",
    closing: "※このメールは送信専用です。",
    manage: true, policy: true,
    line: { when: "お客様がLINE連携をされたとき", noNote: true,
            greeting: "LINE通知の設定が完了しました。ご予約は以下の内容で承っています。" } },
  { k: "customer_change", label: "内容の変更",
    subject: "ご予約内容の変更を承りました",
    intro: "ご予約内容の変更を承りました。\n変更後の内容は以下のとおりです。",
    closing: "※このメールは送信専用です。",
    manage: true, policy: true,
    line: { when: "ご予約内容が変更されたとき",
            greeting: "ご予約内容の変更を承りました。変更後の内容：" } },
  { k: "customer_cancel", label: "キャンセル",
    subject: "ご予約のキャンセルを承りました",
    intro: "以下のご予約のキャンセルを承りました。",
    pre: "またのご利用を心よりお待ちしております。",
    closing: "※このメールは送信専用です。",
    manage: false, policy: false, shortBlock: true,
    line: { when: "キャンセルされたとき",
            greeting: "以下のご予約のキャンセルを承りました。",
            pre: "またのご利用を心よりお待ちしております。" } },
  { k: "customer_reminder", label: "受取前日のお知らせ",
    subject: "明日はお受け取り日です",
    intro: "ご予約いただいた商品は、明日お受け取りいただけます。\nお気をつけてお越しください。",
    closing: "※このメールは送信専用です。\nお受け取り日時のご相談は、お店までご連絡ください。",
    manage: true, policy: false,
    line: { when: "お受け取りの前日",
            greeting: "明日はお受け取り日です。お気をつけてお越しください。", pay: true } },
];
const MAIL_PAY_DEFAULT = "店頭でのお支払いをお願いします";
const LINE_PAY_DEFAULT = "お支払いは店頭でお願いします。";
const mailKind = () => MAIL_KINDS.find((m) => m.k === state.mailKind) || MAIL_KINDS[0];

/* いま画面に出ている2枠を、種類ごとの下書きへしまう（種類を切り替えても消えないように） */
function mailStash() {
  const cur = state.mailTexts[state.mailKind] || (state.mailTexts[state.mailKind] = {});
  cur.intro = $("t-mail-intro").value;
  cur.outro = $("t-mail-outro").value;
}

/* 保存する値。書いていない種類はキーごと持たない＝既定文のまま送られる */
function mailTextsValue() {
  mailStash();
  const out = {};
  const pay = $("t-mail-payment").value.trim();
  if (pay) out.payment = pay;
  for (const m of MAIL_KINDS) {
    const v = state.mailTexts[m.k] || {};
    const one = {};
    if ((v.intro || "").trim()) one.intro = v.intro.trim();
    if ((v.outro || "").trim()) one.outro = v.outro.trim();
    if (Object.keys(one).length) out[m.k] = one;
  }
  return Object.keys(out).length ? out : null;
}

function mailPaint() {
  const m = mailKind();
  const cur = state.mailTexts[m.k] || {};
  $("t-mail-intro").value = cur.intro || "";
  $("t-mail-outro").value = cur.outro || "";
  // 空欄のときは既定文をうすく見せる＝「空欄にすると何が送られるか」が分かる
  $("t-mail-intro").placeholder = m.intro;
  $("t-mail-outro").placeholder = "例：駐車場は店舗裏に3台ございます。";
  for (const [id, val] of [["mail-kinds", m.k], ["mail-ch", state.mailCh]]) {
    [...$(id).querySelectorAll("button")].forEach((b) => b.classList.toggle("on", b.dataset.v === val));
  }
  mailPreview();
}

/* 送られる文の見本。色の付いた行が店主の書いた文、それ以外は自動で作られる部分 */
function mailPreview() {
  const m = mailKind();
  const cur = state.mailTexts[m.k] || {};
  const shop = $("t-name").value.trim() || "お店の名前";
  const payRaw = $("t-mail-payment").value.trim();
  const policy = $("t-cancel").value.trim();
  const selfOn = $("t-self-enabled").checked;
  const outro = (cur.outro || "").trim();
  const mine = (text, key) =>
    `<span class="mail-mine${state.mailLight === key ? " lit" : ""}">${esc(text)}</span>`;
  const out = [];

  if (state.mailCh === "line") {
    const L = m.line;
    out.push(`LINE：${esc(L.when)}に届きます`
             + (L.noNote ? "" : "（LINE連携をされたお客様にだけ）"));
    out.push("──────────");
    out.push("山田 花子 様");
    out.push(esc(L.greeting));
    out.push("");
    out.push("予約番号：No.1024");
    out.push("受取日時：2026年12月24日（木） 15:00〜16:00");
    out.push("ご注文：ショートケーキ（5号）");
    if (!m.shortBlock) out.push("合計：4,800円（税込）");
    if (L.pay) out.push(mine(payRaw || LINE_PAY_DEFAULT, "pay"));
    if (m.manage && selfOn && state.formUrl) {
      out.push("");
      out.push("▼ご予約の確認・変更・キャンセル");
      out.push(esc(state.formUrl) + "manage.html?t=…");
    }
    if (L.pre) { out.push(""); out.push(esc(L.pre)); }
    if (outro) { out.push(""); out.push(mine(outro, "outro")); }
    out.push("");
    out.push(esc(shop));
    $("mail-preview").innerHTML = out.join("\n");
    return;
  }

  out.push(`件名：【${esc(shop)}】${esc(m.subject)}（No.1024）`);
  out.push("──────────");
  out.push("山田 花子 様");
  out.push("");
  out.push(mine(cur.intro?.trim() || m.intro, "intro"));
  out.push("");
  out.push("■ 予約番号：No.1024");
  out.push("■ 受取日時：2026年12月24日（木） 15:00〜16:00");
  out.push("■ ご注文：ショートケーキ（5号）");
  if (!m.shortBlock) {
    out.push("　・フルーツ：いちご");
    out.push("■ ご記入内容");
    out.push("　・プレートの文字：Happy Birthday");
    out.push("■ 合計金額：4,800円（税込）");
    out.push("■ お支払い：" + mine(payRaw || MAIL_PAY_DEFAULT, "pay"));
  }
  // 描画の条件はDB側と同じ（self_manage_enabled かつ public_form_url が空でない）。
  // URLが無い店では見本からもこの節が消えるので、沈黙する機能に目で気づける
  if (m.manage && selfOn && state.formUrl) {
    out.push("");
    out.push("■ ご予約の確認・変更・キャンセル");
    out.push("以下のページからご自身でお手続きいただけます。");
    out.push(esc(state.formUrl) + "manage.html?t=…");
  }
  if (m.policy && policy) {
    out.push("");
    out.push("■ キャンセルについて");
    out.push(esc(policy));
  }
  if (m.pre) { out.push(""); out.push(esc(m.pre)); }
  if (outro) { out.push(""); out.push(mine(outro, "outro")); }
  out.push("");
  out.push(esc(m.closing));
  out.push("");
  out.push(esc(shop));
  out.push(esc($("t-email").value.trim() || "notify@example.com"));
  $("mail-preview").innerHTML = out.join("\n");
}

function mailInit(t) {
  const src = t.email_texts || {};
  state.mailTexts = {};
  for (const m of MAIL_KINDS) {
    state.mailTexts[m.k] = { intro: src[m.k]?.intro || "", outro: src[m.k]?.outro || "" };
  }
  $("t-mail-payment").value = src.payment || "";
  state.mailKind = MAIL_KINDS[0].k;
  state.mailCh = "mail";

  const chips = (id, items, onPick) => {
    const wrap = $(id);
    wrap.innerHTML = "";
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill mail-chip";
      b.dataset.v = it.v;
      b.textContent = it.label;
      b.onclick = () => { mailStash(); onPick(it.v); mailPaint(); };
      wrap.appendChild(b);
    }
  };
  chips("mail-kinds", MAIL_KINDS.map((m) => ({ v: m.k, label: m.label })), (v) => { state.mailKind = v; });
  chips("mail-ch", [{ v: "mail", label: "メール" }, { v: "line", label: "LINE" }],
        (v) => { state.mailCh = v; });

  // 設定タブは読み直すたびに loadTenantForm が走るので、登録は1度だけにする
  if (!state.mailBound) {
    state.mailBound = true;
    const keys = { "t-mail-intro": "intro", "t-mail-outro": "outro", "t-mail-payment": "pay" };
    for (const [id, key] of Object.entries(keys)) {
      $(id).addEventListener("input", () => { mailStash(); mailPreview(); markDirty(); });
      // 触っている欄が見本のどこに出るかを光らせる（説明文の代わり・商品ページと同じ）
      $(id).addEventListener("focus", () => { state.mailLight = key; mailPreview(); });
      $(id).addEventListener("blur", () => { state.mailLight = null; mailPreview(); });
    }
    // 見本には店名・通知メール・キャンセルポリシー・セルフ操作の有無も映る
    for (const id of ["t-name", "t-email", "t-cancel"]) $(id).addEventListener("input", mailPreview);
    $("t-self-enabled").addEventListener("change", mailPreview);
  }
  mailPaint();
}

/* ---------- 設定 ---------- */
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
async function loadTenantForm() {
  const t = (await api("GET", `/rest/v1/tenants?id=eq.${state.tenantId}&select=*`))[0];
  initLineSettings(t);
  $("t-name").value = t.name || "";
  $("t-email").value = t.contact_email || "";
  $("t-cutoff").value = (t.order_cutoff_time || "21:00").slice(0, 5);
  $("t-deadline").value = t.default_deadline_days ?? 3;
  const mode = t.deadline_skip_closed_days ? "business" : "calendar";
  [...document.querySelectorAll('input[name="deadline-mode"]')].forEach((r) => { r.checked = r.value === mode; });
  $("t-preview-note").value = t.preview_note || "";
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
  // 未記入なら注意書きを出す（公開前チェック。お客様の確認画面に何も出ない状態を気づかせる）
  const tokuWarn = () =>
    $("tokushoho-warn").classList.toggle("hidden", $("t-tokushoho").value.trim() !== "");
  $("t-tokushoho").addEventListener("input", tokuWarn);
  tokuWarn();
  // お客様セルフ操作（変更・キャンセル）の期限設定
  $("t-self-enabled").checked = t.self_manage_enabled !== false;
  $("t-self-slot-days").value = t.self_slot_days ?? 1;
  $("t-self-slot-time").value = (t.self_slot_time || "12:00").slice(0, 5);
  $("t-self-content-days").value = t.self_content_days ?? 2;
  $("t-self-content-time").value = (t.self_content_time || "12:00").slice(0, 5);
  $("t-self-cancel-days").value = t.self_cancel_days ?? 1;
  $("t-self-cancel-time").value = (t.self_cancel_time || "09:00").slice(0, 5);
  // 受取前日のリマインド
  $("t-reminder-enabled").checked = t.reminder_enabled === true;
  $("t-reminder-time").value = (t.reminder_send_at || "18:00").slice(0, 5);
  // 予約フォームの公開URL。ここが空だと、セルフ操作もLINEもリンクが出ない
  // （管理画面では有効に見えるのに機能だけ沈黙する形だったので、気づけるようにする）
  state.formUrl = (t.public_form_url || "").trim();
  $("self-url-warn").classList.toggle("hidden", !!state.formUrl);
  // お客様へのメール／LINEの文面（はじめの文・おわりに足す文・お支払いの1行）
  mailInit(t);
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
  regField("tenants", T, "preview_note", $("t-preview-note"),
    { get: () => $("t-preview-note").value.trim() });   // 空欄=注意書きを出さない
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
  // 見た目（theme は1列のJSON。入力欄は複数なので get でまとめる）
  initTheme(t.theme || {});
  regField("tenants", T, "theme", $("th-accent"), { get: buildTheme });
  const themeEvt = () => { markDirty(); pushThemePreview(); };
  document.querySelectorAll("#theme-box input").forEach((el) => {
    if (el.type === "file") return;
    el.addEventListener(el.type === "checkbox" || el.type === "radio" ? "change" : "input", themeEvt);
  });
  const frame = $("th-frame");
  const src = `../?shop=${encodeURIComponent(state.subdomain)}&preview=theme${state.billingStatus === "setup_trial" ? "&trial=1" : ""}`;
  if (frame.getAttribute("src") !== src) frame.src = src;
  frame.onload = pushThemePreview;
  regField("tenants", T, "reminder_enabled", $("t-reminder-enabled"));
  // メール文面は4種ぶんを1つのjsonbにまとめて持つ（tokushoho・customer_form と同じ形）。
  // 代表の欄として「はじめの文」を登録し、値は mailTextsValue が4種ぶん組み立てる
  regField("tenants", T, "email_texts", $("t-mail-intro"), { get: mailTextsValue });
  // 時刻はNOT NULL。空にされたら既定の18:00に戻す（空欄保存でエラーにしない）
  regField("tenants", T, "reminder_send_at", $("t-reminder-time"),
    { get: () => $("t-reminder-time").value.trim() || "18:00" });
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

function initLineSettings(t) {
  const enabled = $("line-enabled"), button = $("line-save");
  const provisioned = /^\d+$/.test(String(t.line_login_channel_id || ""));
  enabled.checked = !!t.line_notify_enabled;
  enabled.disabled = !provisioned;
  button.disabled = true;
  $("line-config-status").textContent = !provisioned ? "接続情報が未登録です。運営側の設定が必要です。" : `接続情報：登録あり ／ LINE通知の案内：${t.line_notify_enabled ? "ON" : "OFF"}`;
  $("line-config-id").textContent = provisioned ? `LINEログインチャネルID：${t.line_login_channel_id}` : "";
  enabled.onchange = () => { button.disabled = !provisioned || enabled.checked === !!t.line_notify_enabled; };
  button.onclick = async () => {
    const next = enabled.checked;
    button.disabled = true; enabled.disabled = true;
    $("line-result").textContent = "保存中…";
    try {
      await api("POST", "/rest/v1/rpc/fn_set_line_notify", { p_tenant_id: state.tenantId, p_enabled: next });
      initLineSettings({ ...t, line_notify_enabled: next });
      $("line-result").textContent = "LINEの設定を保存しました。実際の配信は動作確認の手順でご確認ください。";
    } catch {
      enabled.disabled = !provisioned; button.disabled = false;
      $("line-result").textContent = "保存できませんでした。通信状態をご確認ください。接続設定やサーバー側の更新が未完了の場合はサポートへご連絡ください。";
    }
  };
}

async function loadSettings() {
  drafts.capture(state.fields);
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
      <input type="number" min="0" placeholder="なし" value="${r.daily_limit ?? ""}"> 台/日
      <button type="button" class="pill danger">やめる</button>`;
    regField("capacity_rules", r.id, "daily_limit", row.querySelector("input"), { number: true });
    row.querySelector("button").onclick = async () => {
      if (!confirm(`「${r.name}」をやめますか？\n（この上限がなくなり、1日に受ける台数は無制限になります）`)) return;
      await api("DELETE", `/rest/v1/capacity_rules?id=eq.${r.id}`);
      toast("上限をやめました");
      loadSettings();
    };
    rw.appendChild(row);
  }
  // 上限のルールが1本も無い店では、ここから追加できるようにする（2026-09-04）
  // 以前は pokke 側がSQLで入れるしかなく、導入手順の工程4が店の手で完結しなかった
  const hasAll = rules.some((r) => r.scope === "all");
  if (!hasAll) {
    rw.insertAdjacentHTML("beforeend",
      `<p class="small">現在は1日の上限がありません。</p>`);
  }
  $("rule-add").classList.toggle("hidden", hasAll);

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
  drafts.capture(state.fields);
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
  markDirty();
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
$("btn-rule-add").onclick = async () => {
  const n = parseInt($("rule-daily").value, 10);
  if (!(n >= 0)) { toast("1日に受ける台数を入れてください"); return; }
  await api("POST", "/rest/v1/capacity_rules", {
    tenant_id: state.tenantId, name: "全体上限", scope: "all", daily_limit: n,
  });
  $("rule-daily").value = "";
  toast(`1日${n}台までにしました`);
  loadSettings();
};

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
// 狭い画面のメニュー開閉（☰）。広い画面ではボタン自体が非表示なので何も起きない
$("menu-btn").onclick = (e) => {
  e.stopPropagation();
  const open = $("admin-body").classList.toggle("menu-open");
  $("menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
};
$("menu-close").onclick = () => {
  $("admin-body").classList.remove("menu-open");
  $("menu-btn").setAttribute("aria-expanded", "false");
};
// メニューの外を触ったら閉じる
document.addEventListener("click", (e) => {
  if (!$("admin-body").classList.contains("menu-open")) return;
  if (e.target.closest("#admin-tabs")) return;
  $("admin-body").classList.remove("menu-open");
  $("menu-btn").setAttribute("aria-expanded", "false");
});
document.querySelectorAll(".tab[data-tab]").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("selected"));
    b.classList.add("selected");
    state.tab = b.dataset.tab;
    // 選んだらメニューを閉じる
    $("admin-body").classList.remove("menu-open");
    $("menu-btn").setAttribute("aria-expanded", "false");
    $("tab-pickup").classList.toggle("hidden", state.tab !== "pickup");
    $("tab-settings").classList.toggle("hidden", state.tab !== "settings");
    $("tab-design").classList.toggle("hidden", state.tab !== "design");
    $("tab-reports").classList.toggle("hidden", state.tab !== "reports");
    $("tab-support").classList.toggle("hidden", state.tab !== "support");
    $("tab-account").classList.toggle("hidden", state.tab !== "account");
    $("tab-billing").classList.toggle("hidden", state.tab !== "billing");
    if (state.tab === "account") openAccount();
    const editing = state.tab === "settings" || state.tab === "design";
    $("date-nav").classList.toggle("hidden", editing || ["reports", "support", "account", "billing"].includes(state.tab));
    // 設定とデザインの下書きは画面を切り替えても保持し、一緒に保存する。
    $("save-bar").classList.toggle("hidden", !editing);
    if (state.tab === "design") pushThemePreview();
    if (state.tab === "reports") openReports();
    if (state.tab === "support") openSupport();
    window.scrollTo(0, 0);
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
async function sendPasswordRecovery(email) {
  const redirect = new URL("./reset.html", location.href).href;
  const res = await fetch(`${CONFIG.url}/auth/v1/recover?redirect_to=${encodeURIComponent(redirect)}`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error("送信できませんでした。時間をおいてもう一度お試しください。");
}
let recoverySending = false;
$("link-forgot").onclick = async (e) => {
  e.preventDefault();
  if (recoverySending) return;
  $("forgot-sent").classList.add("hidden");
  $("login-error").classList.add("hidden");
  const input = $("login-email");
  const email = input.value.trim();
  if (!email || !input.checkValidity()) { toast("メールアドレスを正しく入力してから押してください"); return; }
  recoverySending = true;
  try {
    await sendPasswordRecovery(email);
    // 未登録アドレスでも同じ表示。登録の有無を漏らさない。
    $("forgot-sent").classList.remove("hidden");
  } catch (e) {
    $("login-error").textContent = e.message;
    $("login-error").classList.remove("hidden");
  } finally { recoverySending = false; }
};

/* ---------- アカウント・契約の専用画面 ---------- */
async function openAccount() {
  $("account-email").textContent = "読み込み中…";
  $("account-message").textContent = "";
  $("btn-account-reset").disabled = true;
  state.accountEmail = null;
  try {
    const user = await api("GET", "/auth/v1/user");
    state.accountEmail = user.email || null;
    $("account-email").textContent = user.email || "メールアドレスが登録されていません";
    $("btn-account-reset").disabled = !user.email;
  } catch {
    $("account-email").textContent = "ログイン情報を取得できませんでした。もう一度ログインしてください。";
  }
}
$("btn-account-reset").onclick = async () => {
  if (!state.accountEmail) return;
  const button = $("btn-account-reset");
  button.disabled = true;
  $("account-message").textContent = "送信中…";
  try {
    await sendPasswordRecovery(state.accountEmail);
    $("account-message").textContent = "再設定メールを送りました。メール内のリンクからパスワードを変更してください。";
  } catch (e) {
    $("account-message").textContent = e.message;
    button.disabled = false;
  }
};
for (const [id, name] of [["btn-billing-page-checkout", "create-checkout-session"], ["btn-billing-page-portal", "create-portal-session"]]) {
  $(id).onclick = async () => {
    $(id).disabled = true;
    try { await callBillingFn(name); }
    catch (e) { toast(e.message); }
    finally { $(id).disabled = false; }
  };
}

/* ---------- 起動 ---------- */
(async () => {
  loadSession();
  if (state.session) {
    try { await showApp(); return; } catch { /* 失効 → ログインへ */ }
  }
  showLogin();
})();

/* ---------- 設定 › 見た目 ----------
 * tenants.theme = { accent, type, logo_url, sub, adv:{bg,ink,boxbg,box,line,on,sel,selbox,selink} }
 * adv は「自動」を外した色だけ持つ（無い色はフォーム側が基調色から計算）。 */
const THEME_KEYS = ["bg", "ink", "boxbg", "box", "line", "on", "sel", "selbox", "selink"];
const THEME_DEFAULT_ACCENT = "#4a4a4a";
function mixHex(a, b, t) {
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
  const ch = (i) => Math.round(((A >> i) & 255) * t + ((B >> i) & 255) * (1 - t));
  return "#" + [16, 8, 0].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
}
function lum(h) {
  const n = parseInt(h.slice(1), 16);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
// 「自動」の色（styles.css の計算と同じ結果になるように）
function themeAutoColors(accent, adv) {
  const bg = adv.bg || "#ffffff", ink = adv.ink || "#2a2a2a";
  return { bg, ink, boxbg: bg, box: "#e3e3e3", line: "#e3e3e3", on: "#ffffff",
           sel: mixHex(accent, bg, 0.16), selbox: mixHex(accent, "#000000", 0.75), selink: ink };
}
function themeSetAccent(c) {
  $("th-accent").value = c;
  $("th-accent-hex").textContent = c;
  document.querySelectorAll(".th-swatch").forEach((b) => b.setAttribute("aria-pressed", b.dataset.c === c ? "true" : "false"));
}
function themeRefreshAuto() {
  const accent = $("th-accent").value;
  const adv = {};
  for (const k of THEME_KEYS) if (!$(`th-${k}-auto`).checked) adv[k] = $(`th-${k}`).value;
  const auto = themeAutoColors(accent, adv);
  for (const k of THEME_KEYS) {
    const isAuto = $(`th-${k}-auto`).checked;
    $(`th-${k}`).disabled = isAuto;
    if (isAuto) $(`th-${k}`).value = auto[k];
  }
  const eff = Object.assign({}, auto, adv);
  $("th-warn").classList.toggle("hidden", contrast(eff.ink, eff.bg) >= 4.5 && contrast(eff.on, accent) >= 3);
}
function initTheme(th) {
  themeSetAccent(th.accent || th.primary || THEME_DEFAULT_ACCENT);
  const adv = th.adv || {};
  for (const k of THEME_KEYS) {
    $(`th-${k}-auto`).checked = !adv[k];
    if (adv[k]) $(`th-${k}`).value = adv[k];
  }
  $("th-adv").open = Object.keys(adv).length > 0;
  const type = ["maru", "kaku", "min"].includes(th.type) ? th.type : "kaku";
  document.querySelector(`input[name="th-type"][value="${type}"]`).checked = true;
  $("th-logo-url").value = th.logo_url || "";
  themeShowLogo(th.logo_url || "");
  $("th-sub").value = th.sub || "";
  themeRefreshAuto();
}
function buildTheme() {
  const th = { accent: $("th-accent").value, type: document.querySelector('input[name="th-type"]:checked').value };
  const adv = {};
  for (const k of THEME_KEYS) if (!$(`th-${k}-auto`).checked) adv[k] = $(`th-${k}`).value;
  if (Object.keys(adv).length) th.adv = adv;
  if ($("th-logo-url").value) th.logo_url = $("th-logo-url").value;
  const sub = $("th-sub").value.trim();
  if (sub) th.sub = sub;
  return th;
}
function pushThemePreview() {
  const frame = $("th-frame");
  if (frame?.contentWindow) frame.contentWindow.postMessage({ type: "pokke-theme", theme: buildTheme() }, location.origin);
}
function themeShowLogo(url) {
  const img = $("th-logo-img");
  if (url) { img.src = url; img.classList.remove("hidden"); $("th-logo-clear").classList.remove("hidden"); }
  else { img.removeAttribute("src"); img.classList.add("hidden"); $("th-logo-clear").classList.add("hidden"); }
}
document.querySelectorAll(".th-swatch").forEach((b) => b.addEventListener("click", () => {
  themeSetAccent(b.dataset.c); themeRefreshAuto(); markDirty(); pushThemePreview();
}));
$("th-accent").addEventListener("input", () => { themeSetAccent($("th-accent").value); themeRefreshAuto(); });
document.querySelectorAll('#th-adv input[type="checkbox"], #th-adv input[type="color"]').forEach((el) =>
  el.addEventListener(el.type === "checkbox" ? "change" : "input", themeRefreshAuto));
$("th-reset").onclick = () => {
  initTheme({});
  markDirty(); pushThemePreview();
};
$("th-logo-clear").onclick = () => { $("th-logo-url").value = ""; themeShowLogo(""); markDirty(); pushThemePreview(); };
$("th-logo-file").addEventListener("change", async () => {
  const file = $("th-logo-file").files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) { toast("画像ファイルを選んでください"); return; }
  if (file.size > 2 * 1024 * 1024) { toast("画像が大きすぎます（2MBまで）"); return; }
  try {
    // バケットが受けるのは jpeg/png/webp（20260725100000_images.sql）
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[file.type];
    if (!ext) throw new Error("PNG・JPEG・WebP の画像を選んでください");
    const name = `${state.tenantId}/logo/${crypto.randomUUID()}.${ext}`;
    const res = await fetch(`${CONFIG.url}/storage/v1/object/shop-images/${name}`, {
      method: "POST",
      headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}`, "Content-Type": file.type, "x-upsert": "true" },
      body: file,
    });
    if (!res.ok) throw new Error(`アップロードに失敗しました (${res.status})`);
    const url = `${CONFIG.url}/storage/v1/object/public/shop-images/${name}`;
    $("th-logo-url").value = url;
    themeShowLogo(url);
    markDirty(); pushThemePreview();
  } catch (e) {
    toast(e.message);
  } finally {
    $("th-logo-file").value = "";
  }
});
