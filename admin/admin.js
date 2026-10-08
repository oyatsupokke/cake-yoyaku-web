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
const answerValueHtml = (value) => {
  const text = String(value ?? "");
  const match = /^(#[0-9A-Fa-f]{6})(／連動：同色)?(?:／補足：([^\n]{1,200}))?$/.exec(text);
  const shown = match ? match[1]+(match[2]?'／連動する装飾も同色':'')+(match[3]?`／補足：${match[3]}`:'') : text;
  return match
    ? `<i class="answer-swatch" style="background:${match[1]}" aria-hidden="true"></i>${esc(shown)}`
    : esc(text);
};
const STATUS = {
  new: "未確認", confirmed: "確認済", in_production: "確認済",
  completed: "確認済", canceled: "キャンセル",
};
const REVIEW = {requested:"追加希望・確認待ち",quoted:"見積もり・承諾待ち",accepted:"追加希望・承諾済み"};
const reviewPending = o => ['requested','quoted'].includes(o.review_state);

const state = { session: null, tenantId: null, tenantName: "", date: null, orders: [], tab: "calendar",
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
    `/rest/v1/tenants?id=eq.${state.tenantId}&select=id,name,subdomain,billing_status,trial_ends_at,theme,reservation_plan,first_paid_at`);
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
  window.Onboarding?.refresh();
  // 独立した商品設定ページからも、選んだ管理画面へ直接戻れる。
  const requestedTab = new URLSearchParams(location.search).get("tab");
  if (state.tab === "calendar") window.OrderCalendar?.open();
  if (["calendar", "pickup", "kitchen", "reports", "settings", "design", "support", "account", "billing"].includes(requestedTab)) {
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
  const lite=t.reservation_plan==='lite';
  const amount=lite?'1,980':'4,980';
  const intro=lite&&status==='setup_trial'&&new Date(t.trial_ends_at)>new Date()&&!t.first_paid_at;
  const priceText=intro?'最初の３か月は月額1,480円（税込）、４か月目から月額1,980円（税込）':`月額${amount}円（税込）`;
  $('btn-billing-page-checkout').textContent=`有料契約へ（${priceText}）`;
  renderLiteUsage(t);
  globalThis.ReservationUpgrade?.render(t);
  const labels = { setup_trial: "カード不要のお試し中", exempt: "課金対象外", none: "お支払い未登録", trialing: "無料トライアル中", active: "ご契約中", past_due: "お支払いの確認が必要です", unpaid: "未払いのため利用停止中", canceled: "解約済み", incomplete: "お支払い手続き中", incomplete_expired: "お支払い手続きの期限切れ", paused: "ご契約を一時停止中" };
  $("billing-page-status").textContent = status === "active" ? `${lite ? "Lite" : "Standard"}でご契約中` : labels[status] || "ご契約状況を確認してください";
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
    $("billing-page-help").textContent = `有料契約の決済完了から${priceText}で、本予約の受付を開始します。`;
    html = expired ? "14日間のお試しが終了しました。設定は保存されています。" : "カード不要の14日間お試し中です。本予約は受け付けません。";
    if (!expired) html += ` <a class="pill" href="../?shop=${encodeURIComponent(t.subdomain)}&trial=1" target="_blank">テスト予約を試す</a>`;
    html += ` <button type="button" class="pill" id="btn-billing-checkout">有料契約へ（${priceText}）</button>`;
  } else if (status === "none") {
    html = `⚠️ お支払い登録が未完了のため、予約フォームはまだ公開されていません。
      <button type="button" class="pill" id="btn-billing-checkout">有料契約へ（${priceText}）</button>`;
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
// "YYYY-MM-DD" を端末の時刻のその日として作る（new Date("2026-12-24") はUTC扱いになり、
// 日本より西の時差の端末では前日にずれるため）
const parseYmd = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
$("date-prev").onclick = () => { const d = parseYmd(state.date); d.setDate(d.getDate() - 1); setDate(d); };
$("date-next").onclick = () => { const d = parseYmd(state.date); d.setDate(d.getDate() + 1); setDate(d); };
$("date-today").onclick = () => setDate(new Date());
$("date-tomorrow").onclick = () => { const d = new Date(); d.setDate(d.getDate() + 1); setDate(d); };
$("date-input").onchange = () => { if ($("date-input").value) setDate(parseYmd($("date-input").value)); };

/* ---------- 注文ロード ---------- */
// order_previews は注文1件に1枚（order_id が unique）なので、APIは配列でなく1件のまとまりか null で返す。
// 画面側は「配列」として扱うので、読み込んだ直後にそろえる（2026-10-02 これで9/8から一度も表示されていなかった）。
function normalizeOrder(o) {
  o.order_previews = [].concat(o.order_previews || []);
  return o;
}
let orderLoadGeneration = 0;
async function loadOrders() {
  const filter = $("review-filter")?.value || "";
  const generation = ++orderLoadGeneration, tenant = state.tenantId, date = state.date;
  $("tab-kitchen").classList.toggle("hidden", !!filter);
  const path = `/rest/v1/orders?tenant_id=eq.${tenant}` +
    (filter === "new" ? `&status=eq.new&review_state=eq.none`
      : filter ? `&review_state=eq.${filter}&status=neq.canceled` : `&pickup_date=eq.${date}`) +
    `&order=pickup_date.asc,pickup_slot_label.asc,order_number.asc` +
    `&select=*,quote:order_quotes!orders_current_quote_id_fkey(*),order_items!order_items_order_id_fkey(*,order_item_options!order_item_options_order_item_id_fkey(*)),order_answers!order_answers_order_id_fkey(*),order_images!order_images_order_id_fkey(id,path,question_id,note,created_at),order_previews!order_previews_order_id_fkey(id,path,created_at),order_refunds!order_refunds_order_id_fkey(amount,status,error,created_at)`;
  const orders = [];
  for (;;) {
    const page = await api("GET",path + `&limit=500&offset=${orders.length}`);
    if (generation !== orderLoadGeneration || tenant !== state.tenantId) return;
    orders.push(...page.map(normalizeOrder));
    if (page.length < 500) break;
  }
  state.orders = orders;
  // 質問→選択肢の対応は待たずに一覧を出し、読めたら製造数だけ描き直す。
  ensureQuestionOptions().then((loaded) => {
    if (!loaded || generation !== orderLoadGeneration || tenant !== state.tenantId) return;
    if (!$("kitchen-range-mode").checked || kitchenRange) renderKitchen();
  });
  renderPickup();
  if ($("kitchen-range-mode").checked) await loadKitchenRange();
  else renderKitchen();
  refreshUnconfirmedCount().catch(() => {});
}
$("review-filter").onchange = () => loadOrders().catch(() => toast("読み込めませんでした。通信状態を確認して、もう一度お試しください。"));

/* ---------- 未確認をまとめて確認（2026-10-03・まりほ要望） ----------
 * 絞り込み「全日の未確認」は、受取日に関係なく status=new（追加希望の確認待ちは除く）を受取日順に並べる。
 * 一覧の上のボタンで、いま画面に出ている分だけをまとめて「確認済」にする（見ていない予約は対象にしない）。
 * 選択肢の名前には件数を添え、絞り込みを開かなくても未確認が残っているか分かるようにする。 */
let unconfirmedCountGeneration = 0;
async function refreshUnconfirmedCount() {
  const opt = $("review-filter")?.querySelector('option[value="new"]');
  if (!opt || !state.tenantId) return;
  const generation = ++unconfirmedCountGeneration, tenant = state.tenantId;
  const res = await fetch(CONFIG.url + `/rest/v1/orders?tenant_id=eq.${tenant}&status=eq.new&review_state=eq.none&select=id`, {
    method: "HEAD",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}`, Prefer: "count=exact" },
  });
  // 要求が重なったときは最新の応答だけを出す（古い応答で、まとめて確認した後の件数を戻さない）
  if (!res.ok || generation !== unconfirmedCountGeneration || tenant !== state.tenantId) return;
  const n = Number(res.headers.get("content-range")?.split("/")[1]);
  opt.textContent = Number.isFinite(n) && n > 0 ? `全日の未確認（${n}件）` : "全日の未確認";
}
function renderBulkConfirm() {
  const box = $("bulk-confirm");
  if (!box) return;
  const targets = $("review-filter")?.value === "new" ? state.orders.filter((o) => o.status === "new" && !reviewPending(o)) : [];
  box.classList.toggle("hidden", !targets.length);
  if (!targets.length) return;
  $("bulk-confirm-note").textContent = `未確認 ${targets.length}件（受取日順）。内容を見てから、まとめて確認済にできます。`;
  $("bulk-confirm-btn").textContent = `→ ${targets.length}件をまとめて確認済にする`;
}
$("bulk-confirm-btn").onclick = async () => {
  const targets = state.orders.filter((o) => o.status === "new" && !reviewPending(o));
  if (!targets.length) return;
  const lines = targets.slice(0, 8).map((o) => `No.${o.order_number} ${o.pickup_date} ${o.customer_name}様`).join("\n");
  if (!confirm(`表示中の未確認 ${targets.length}件を「確認済」にしますか？\n（お客様へのメールは送りません）\n\n${lines}${targets.length > 8 ? `\n…ほか${targets.length - 8}件` : ""}`)) return;
  const btn = $("bulk-confirm-btn"); btn.disabled = true;
  let done;
  try {
    // 画面に出ている予約だけを対象にする。読み込み後に状態が変わった分（キャンセル等）は条件で外れる
    const ids = targets.map((o) => o.id).join(",");
    done = await api("PATCH", `/rest/v1/orders?tenant_id=eq.${state.tenantId}&id=in.(${ids})&status=eq.new&review_state=eq.none`, { status: "confirmed" });
  } catch { toast("確認済みにできませんでした。通信状態を確認して、もう一度お試しください。"); btn.disabled = false; return; }
  toast(`${Array.isArray(done) ? done.length : targets.length}件を「確認済」にしました`);
  // 更新は済んでいるので、再読み込みの失敗は別の案内にする（一覧が古いままなのを伝える）
  try { await loadOrders(); }
  catch { toast("確認済にしましたが、一覧を読み直せませんでした。ページを再読み込みしてください。"); }
  finally { btn.disabled = false; }
};

/* お店のメモ（orders.staff_note・2026-10-03）。カードには印だけ、中身は詳細の欄で読み書きする */
const staffNoteBadge = (o) => (o.staff_note || "").trim()
  ? `<span class="status-badge st-note" title="${esc((o.staff_note || "").trim().slice(0, 80))}">📝 メモ</span>` : "";

/* ---------- 受取リスト ---------- */
// 旧予約フォーム（SELECTTYPE）から移したご予約。管理メモの先頭で見分ける（2026-09-28の移行時の印）
const legacyOrder = (o) => String(o.internal_memo || "").startsWith("SELECTTYPE");
function renderPickup() {
  const wrap = $("pickup-list");
  wrap.innerHTML = "";
  const active = state.orders;
  renderBulkConfirm();
  if (!active.length) {
    const filter = $("review-filter")?.value;
    wrap.innerHTML = `<p class="empty-note">${filter === "new" ? '未確認の予約はありません' : filter ? '該当する依頼はありません' : 'この日の予約はありません'}</p>`;
    return;
  }
  for (const o of active) {
    const item = o.order_items[0] || {};
    const card = document.createElement("div");
    card.className = "order-card" + (o.status === "canceled" ? " canceled" : "");
    card.innerHTML = `
      <div class="order-head">
        <span class="order-time">${$("review-filter")?.value ? esc(o.pickup_date) + " " : ""}${esc(o.pickup_slot_label)}</span>
        <span class="order-name">${esc(o.customer_name)} 様${o.customer_kana ? ` <span class="order-kana">（${esc(o.customer_kana)}）</span>` : ""}
          <span class="order-product">No.${esc(o.order_number)}　${esc(item.product_name_snapshot)} ${esc(item.variant_label_snapshot)}</span>
        </span>
        ${(o.order_previews || []).length ? `<button type="button" class="order-thumb" aria-label="デザインイメージを大きく見る"></button>` : ""}
        <span class="order-total">${yen(o.quote?.amount ?? o.total_amount)}${reviewPending(o) ? "（未確定）" : ""}</span>
        <span class="status-badge st-${o.status}">${STATUS[o.status]}</span>
        ${REVIEW[o.review_state] ? `<span class="status-badge st-image">${REVIEW[o.review_state]}${o.review_state==='quoted' && new Date(o.quote?.expires_at)<=new Date() ? '・回答期限切れ' : ''}</span>` : ""}
        ${legacyOrder(o) ? `<span class="status-badge st-legacy" title="旧予約フォーム（SELECTTYPE）で受けたご予約">旧フォーム</span>`
          : o.created_via === "staff" ? `<span class="status-badge st-staff">電話</span>` : ""}
        ${prepayBadge(o)}
        ${(o.order_images || []).length ? `<button type="button" class="status-badge st-image photo-badge" aria-label="お客様の添付画像を見る（${o.order_images.length}枚）">📷${o.order_images.length}</button>` : ""}
        ${o.mail_failed ? `<span class="status-badge st-mailfail">メール未送信</span>` : ""}
        ${staffNoteBadge(o)}
      </div>
      ${o.status === "new" && !reviewPending(o) ? '<div class="order-actions"><button type="button" class="pill confirm-order-btn">→ 確認済にする</button></div>' : ''}
      <div class="order-body hidden"></div>`;
    card.querySelector('.confirm-order-btn')?.addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try { await updateStatus(o, "confirmed"); }
      catch { toast("確認済みにできませんでした。通信状態を確認して、もう一度お試しください。"); button.disabled = false; }
    });
    const body = card.querySelector(".order-body");
    card.querySelector(".order-thumb")?.addEventListener("click", async (e) => {
      e.stopPropagation();   // 小さな絵を押したときは詳細を開閉せず、その場で大きく見せる
      openOrderGallery(await orderGallery(o));
    });
    card.querySelector(".photo-badge")?.addEventListener("click", async (e) => {
      e.stopPropagation();   // 📷を押したら、添付画像の1枚目から大きく見せる
      const list = await orderGallery(o);
      openOrderGallery(list, o._preview_url && list.length > 1 ? 1 : 0);
    });
    card.querySelector(".order-head").onclick = () => {
      if (body.classList.contains("hidden")) { fillOrderBody(body, o); body.classList.remove("hidden"); }
      else body.classList.add("hidden");
    };
    wrap.appendChild(card);
  }
  paintPickupThumbs(active);
}
/* 予約カードの左に、予約時のデザインイメージを小さく出す（開かなくても一目で分かるように）。
 * 署名はその日の分をまとめて1回で取る。 */
async function paintPickupThumbs(orders) {
  const need = orders.filter((o) => (o.order_previews || [])[0]?.path && !o._preview_url);
  const urls = await signOrderPaths(need.map((o) => o.order_previews[0].path));
  for (const o of need) o._preview_url ||= urls.get(o.order_previews[0].path) || null;
  const cards = $("pickup-list").querySelectorAll(".order-card");
  orders.forEach((o, i) => {
    const thumb = cards[i]?.querySelector(".order-thumb");
    if (!thumb) return;
    if (o._preview_url) thumb.innerHTML = `<img src="${esc(o._preview_url)}" alt="">`;
    else thumb.remove();
  });
}
/* 非公開バケットの画像の署名付きURLを、まとめて1回で取る（path → URL）。
 * まとめての署名が通らないときは1枚ずつ取り直す。 */
async function signOrderPaths(paths) {
  const out = new Map();
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return out;
  try {
    const r = await api("POST", "/storage/v1/object/sign/order-images", { expiresIn: 3600, paths: list });
    for (const x of r || []) if (x?.signedURL && x.path) out.set(x.path, CONFIG.url + "/storage/v1" + x.signedURL);
  } catch { /* 下で1枚ずつ */ }
  for (const path of list.filter((x) => !out.has(x))) {
    try {
      const r = await api("POST", `/storage/v1/object/sign/order-images/${path}`, { expiresIn: 3600 });
      if (r?.signedURL) out.set(path, CONFIG.url + "/storage/v1" + r.signedURL);
    } catch { /* 1枚読めなくても残りは見せる */ }
  }
  return out;
}
/* その予約の画像を、大きく見る順（デザインイメージ → 添付画像）に並べる */
async function orderGallery(o) {
  const [preview, images] = await Promise.all([ensureOrderPreviewUrl(o), ensureOrderImageUrls(o)]);
  const label = new Map((o.order_answers || []).map((a) => [a.question_id, a.label_snapshot]));
  return [
    ...(preview ? [{ url: preview, caption: "デザインイメージ（予約時にお客様が見ていたもの）", design: true }] : []),
    ...images.map((x) => ({ url: x.url, caption: [label.get(x.question_id), x.note].filter(Boolean).join("：") || "お客様の添付画像" })),
  ];
}
async function ensureOrderImageUrls(o) {
  if (!o._images_signed) o._images_signed = await signOrderImages(o.order_images);
  return o._images_signed;
}
/* お客様が添付した画像（非公開バケット）を見るための署名付きURL。
 * 店のログインで Storage に直接署名を頼む（ポリシー order_images_staff_object_read）。
 * 有効期限は1時間。画面を開き直せばまた新しいURLが出る。 */
async function signOrderImages(images) {
  const sorted = [...(images || [])].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  const urls = await signOrderPaths(sorted.map((im) => im.path));
  return sorted.filter((im) => urls.has(im.path)).map((im) => ({
    id: im.id, question_id: im.question_id, note: im.note, url: urls.get(im.path),
  }));
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
  box.innerHTML = `<button type="button" class="zoom-img design-img" data-url="${esc(url)}" aria-label="デザインイメージを大きく見る"><img src="${esc(url)}" alt="予約時のデザインイメージ"></button>` +
    `<span>予約時にお客様が見ていたデザインイメージです。押すと大きく見られます</span>`;
}
/* 予約詳細に画像を並べる（押すとその場で大きく表示） */
async function paintOrderImages(box, o) {
  const signed = await ensureOrderImageUrls(o);
  if (!signed.length) { box.remove(); return; }
  const cell = (list) => list.map((x) =>
    `<span class="order-image"><button type="button" class="zoom-img" data-url="${esc(x.url)}" aria-label="添付画像を大きく見る">` +
    `<img src="${esc(x.url)}" alt="お客様の添付画像"></button>` +
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
      `<span class="k">${esc(a.label_snapshot)}</span><span class="v">${answerValueHtml(v)}</span></div>`);
  }
  if (legacyOrder(o)) {
    row("受付", "旧予約フォーム（SELECTTYPE）から移したご予約");
    if (o.price_lock) row("価格", "ご予約時の価格のまま（お客様が内容を変更しても、前に選んだ分は同じ価格）");
    rows.push(`<div class="confirm-row"><span class="k">移行時の記録</span><span class="v pre">${esc(o.internal_memo)}</span></div>`);
  }
  const phone = String(o.customer_phone ?? "");
  const tel = phone.replace(/[^0-9+*#,;]/g, "");
  rows.push(`<div class="confirm-row"><span class="k">電話</span><span><a href="tel:${esc(tel)}">${esc(phone)}</a></span></div>`);
  // メールは明示のリンクにする。ただの文字だと iPhone が「メール」の見出しまでアドレスとして拾い、
  // Gmail で開くと宛先の先頭に「メール」が付いて送れなかった（2026-10-04 まりほ実機）
  const email = String(o.customer_email ?? "").trim();
  // 予約ページは「@がある」しか見ないので、?bcc= などを混ぜた値はリンクにしない（文字のまま出す）
  const linkable = /^[^\s@?#%&<>"',;:/\\]+@[^\s@?#%&<>"',;:/\\]+\.[^\s@?#%&<>"',;:/\\]+$/.test(email);
  if (linkable) rows.push(`<div class="confirm-row"><span class="k">メール</span><span><a href="mailto:${esc(email)}">${esc(email)}</a></span></div>`);
  else row("メール", email);
  if (o.paid_amount > 0 || (o.order_refunds || []).length) {
    const p = prepayNumbers(o);
    row("支払い", `事前払い ${yen(o.paid_amount)}（Square）`);
    row("当日のお支払い", p.over > 0 ? `なし（${yen(p.over)} の返金が必要）` : p.due > 0 ? `${yen(p.due)}（差額）` : "なし");
  } else {
    row("支払い", (o.payment_method === "store" ? "店頭払い" : o.payment_method) +
      (legacyOrder(o) ? "（旧フォームでのお支払い済みかは未照合）" : ""));
  }
  let actions = "";
  // 店側からの変更（2026-10-03）。未確認・確認済で、追加希望（見積もり）の途中でないものだけ
  const staffEditable = ["new", "confirmed"].includes(o.status) && (o.review_state || "none") === "none";
  if (staffEditable) {
    actions += `<button type="button" class="pill slot-btn">受取日時を変更</button>` +
               `<button type="button" class="pill content-btn">内容を変更</button>`;
  }
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
  renderStaffNote(el, o);
  if (o.review_state && o.review_state !== "none") renderQuoteEditor(el,o);
  if (o.paid_amount > 0 || (o.order_refunds || []).length) renderRefundBox(el, o);
  if (hasImages) paintOrderImages(el.querySelector(".order-images"), o);
  if (hasPreview) paintOrderPreview(el.querySelector(".order-preview"), o);
  // 詳細を下まで読んだら、そのまま確認済にできるように一番下にも置く（上に戻らなくてよい・2026-10-04 まりほ要望）
  if (o.status === "new" && !reviewPending(o)) {
    const bottom = document.createElement("div");
    bottom.className = "order-actions order-confirm-bottom";
    bottom.innerHTML = `<button type="button" class="pill confirm-order-btn">→ 確認済にする</button>`;
    el.appendChild(bottom);
    bottom.querySelector("button").addEventListener("click", async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try { await updateStatus(o, "confirmed"); }
      catch { toast("確認済みにできませんでした。通信状態を確認して、もう一度お試しください。"); button.disabled = false; }
    });
  }
  // 画像を押したら、その予約の画像（デザインイメージ＋添付画像）をその場で大きく見せる
  el.onclick = async (e) => {
    const btn = e.target.closest(".zoom-img");
    if (!btn) return;
    const list = await orderGallery(o);
    openOrderGallery(list, Math.max(0, list.findIndex((x) => x.url === btn.dataset.url)));
  };
  el.querySelector(".mail-btn")?.addEventListener("click", () => resendMail(o));
  el.querySelector(".content-btn")?.addEventListener("click", () => {
    // 予約ページを「代行＋変更」で開く（番号・お客様の変更リンクは維持。送信は fn_staff_replace）
    window.open(`../?shop=${encodeURIComponent(state.subdomain)}&staff=1&edit=${encodeURIComponent(o.id)}`, "_blank");
  });
  el.querySelector(".slot-btn")?.addEventListener("click", (e) => {
    const button = e.currentTarget;   // 非同期の失敗時には currentTarget が null になるため先に取る
    button.disabled = true;
    renderSlotChange(el, o).catch(() => { toast("受取時間の一覧を読み込めませんでした"); button.disabled = false; });
  });
  el.querySelector(".cancel-btn")?.addEventListener("click", () => {
    if (confirm(`No.${o.order_number} ${o.customer_name}様の予約をキャンセルしますか？（枠が1つ戻ります）`))
      updateStatus(o, "canceled");
  });
}
/* ---------- お店のメモ（2026-10-03・まりほ要望） ----------
 * 予約ごとに店内向けのメモを残す（例：電話で聞いた補足・当日の受け渡しの注意）。お客様には見えない。
 * 保存はこの欄だけで完結し（まとめて保存バーは使わない）、保存するとカードの印と製造カードにも出る。 */
function renderStaffNote(el, o) {
  const box = document.createElement("div");
  box.className = "confirm-box staff-note";
  box.innerHTML = `<label class="field">お店のメモ（お客様には見えません）<textarea class="staff-note-text" rows="3" maxlength="2000" placeholder="例：電話で「ろうそく5本つけて」と追加依頼あり"></textarea></label>
    <div class="order-actions"><button type="button" class="pill staff-note-save" disabled>メモを保存</button><span class="staff-note-state small"></span></div>`;
  const ta = box.querySelector(".staff-note-text"), btn = box.querySelector(".staff-note-save"), st = box.querySelector(".staff-note-state");
  ta.value = o.staff_note || "";
  ta.addEventListener("input", () => { btn.disabled = ta.value === (o.staff_note || ""); st.textContent = btn.disabled ? "" : "未保存"; });
  btn.onclick = async () => {
    const value = ta.value.trim() || null;
    btn.disabled = true; st.textContent = "保存中…";
    try {
      const rows = await api("PATCH", `/rest/v1/orders?id=eq.${o.id}&tenant_id=eq.${state.tenantId}`, { staff_note: value });
      // 更新された行が、この予約の1件であることを確かめる（所属が外れた・予約が消えた等で0件なら失敗扱い）
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== o.id) throw new Error("not updated");
      o.staff_note = value;
      // 期間表示の製造カードは別の注文オブジェクトを使うので、そちらにも写す
      const rangeOrder = kitchenRange?.orders?.find((item) => item.id === o.id);
      if (rangeOrder) rangeOrder.staff_note = value;
      // カードの印を描き直す（詳細は開いたまま）
      const head = el.closest(".order-card")?.querySelector(".order-head");
      head?.querySelector(".st-note")?.remove();
      if (value) head?.insertAdjacentHTML("beforeend", staffNoteBadge(o));
      toast(`No.${o.order_number} のメモを保存しました`);
      renderKitchen();
      // 保存を待つ間に書き足した分は未保存のまま残す
      const dirty = ta.value !== (o.staff_note || "");
      btn.disabled = !dirty; st.textContent = dirty ? "未保存" : "保存しました";
    } catch { st.textContent = "保存できませんでした。通信状態を確認して、もう一度お試しください。"; btn.disabled = false; }
  };
  el.appendChild(box);
}

/* ---------- 店側からの受取日時の変更（2026-10-03・まりほ指摘「お店側で変更できなくない？」） ----------
 * 電話で「別の日にしたい」と言われたときに、キャンセル＋入れ直しをせずに動かす（番号・変更リンク・内容はそのまま）。
 * 期限はお店の判断なので見ない。満枠・休業・締切は fn_staff_change_slot が staff_confirm で返し、確認して強行する。 */
let activeSlotsCache = null;
async function activeSlots() {
  if (activeSlotsCache?.tenant === state.tenantId) return activeSlotsCache.rows;
  const rows = await api("GET", `/rest/v1/pickup_time_slots?tenant_id=eq.${state.tenantId}&is_active=is.true&select=id,label,start_time&order=start_time`);
  activeSlotsCache = { tenant: state.tenantId, rows };
  return rows;
}
async function renderSlotChange(el, o) {
  const slots = await activeSlots();
  el.querySelector(".slot-change")?.remove();
  const box = document.createElement("form");
  box.className = "confirm-box slot-change";
  const canNotify = !!(o.customer_email || "").trim() || !!o.line_user_id;
  box.innerHTML = `
    <p>受取日時だけを変えます。予約番号・ご予約内容・お客様の変更リンクはそのままです。</p>
    <div class="slot-change-row">
      <label class="field">受取日<input type="date" class="slot-date" required value="${esc(o.pickup_date)}"></label>
      <label class="field">受取時間<select class="slot-id" required>${slots.map((s) => `<option value="${esc(s.id)}" ${s.id === o.pickup_slot_id ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
    </div>
    ${canNotify ? `<label class="slot-notify-label"><input type="checkbox" class="slot-notify" checked> お客様に変更のご案内を送る（${[(o.customer_email || "").trim() ? "メール" : "", o.line_user_id ? "LINE" : ""].filter(Boolean).join("・")}）</label>`
                : `<p class="small">メール未記入・LINE未連携のため、お客様へのご案内は送られません。</p>`}
    <div class="order-actions">
      <button type="submit" class="pill slot-save">この日時に変更する</button>
      <button type="button" class="pill slot-cancel">やめる</button>
    </div>
    <p class="slot-error error" role="status"></p>`;
  box.querySelector(".slot-cancel").onclick = () => { box.remove(); el.querySelector(".slot-btn")?.removeAttribute("disabled"); };
  box.onsubmit = async (e) => {
    e.preventDefault(); if (!box.reportValidity()) return;
    const date = box.querySelector(".slot-date").value, slot = box.querySelector(".slot-id").value;
    const notify = !!box.querySelector(".slot-notify")?.checked;
    const label = slots.find((s) => s.id === slot)?.label || "";
    const err = box.querySelector(".slot-error"); err.textContent = "";
    const btn = box.querySelector(".slot-save"); btn.disabled = true;
    try {
      let r = await api("POST", "/rest/v1/rpc/fn_staff_change_slot", { p_order: o.id, p_date: date, p_slot: slot, p_force: false, p_notify: notify });
      if (!r.ok && r.staff_confirm) {
        if (!confirm(`${r.message}\n\nそれでも ${date} ${label} に変更しますか？（変更後の分も台数として数えられます）`)) { btn.disabled = false; return; }
        r = await api("POST", "/rest/v1/rpc/fn_staff_change_slot", { p_order: o.id, p_date: date, p_slot: slot, p_force: true, p_notify: notify });
      }
      if (!r.ok) throw new Error(r.message || "変更できませんでした");
      // お客様へのご案内はアウトボックスに積んであるので、送信ワーカーを起こす（失敗しても変更は成立済み）
      if (r.notified) fetch(`${CONFIG.url}/functions/v1/send-order-emails`, { method: "POST", headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}` } }).catch(() => {});
      toast(`No.${o.order_number} を ${date} ${label} に変更しました${r.notified ? "（お客様へご案内を送ります）" : ""}`);
      await loadOrders();
    } catch (error) { err.textContent = error.message; btn.disabled = false; }
  };
  const anchor = el.querySelector(".order-actions");
  if (anchor) anchor.after(box); else el.appendChild(box);
}

/* ---------- Squareでの事前払い・返金（2026-10-02） ----------
 * 当日のお支払い＝合計 − 事前払い。安くなった・キャンセルした分は、店がここから返金する（自動では返さない） */
function prepayNumbers(o) {
  const total = o.status === "canceled" ? 0 : (o.total_amount || 0);
  const paid = o.paid_amount || 0;
  return { due: Math.max(total - paid, 0), over: Math.max(paid - total, 0) };
}
function prepayBadge(o) {
  const refunding = (o.order_refunds || []).some((r) => r.status === "pending");
  if (!(o.paid_amount > 0)) return refunding ? `<span class="status-badge st-refund">返金処理中</span>` : "";
  const p = prepayNumbers(o);
  return `<span class="status-badge st-prepaid" title="Squareで事前にお支払い済み">💳 事前払い ${yen(o.paid_amount)}</span>` +
    (p.over > 0 ? `<span class="status-badge st-refund">返金 ${yen(p.over)} 未対応</span>`
      : p.due > 0 ? `<span class="status-badge st-prepaid">当日 ${yen(p.due)}</span>` : "") +
    (refunding ? `<span class="status-badge st-refund">返金処理中</span>` : "");
}
function renderRefundBox(el, o) {
  const box = document.createElement("div");
  box.className = "confirm-box refund-box";
  const p = prepayNumbers(o);
  const lines = (o.order_refunds || []).map((r) =>
    `<li>${new Date(r.created_at).toLocaleString("ja-JP")}　${yen(r.amount)}　${
      { pending: "返金処理中", completed: "返金済み", failed: "返金できませんでした" }[r.status] || esc(r.status)}${
      r.status === "failed" && r.error ? `<br><small>${esc(r.error)}</small>` : ""}</li>`).join("");
  box.innerHTML = (lines ? `<p>返金の記録</p><ul class="refund-list">${lines}</ul>` : "") +
    (o.paid_amount > 0 ? `<label class="field">返金する金額（円）
        <input class="refund-amount" type="number" min="1" max="${esc(o.paid_amount)}" step="1" value="${esc(p.over || o.paid_amount)}"></label>
      <button type="button" class="pill danger refund-btn">Squareで返金する</button>
      <p class="small">お客様のカードへ返金されます。取り消しはできません。</p>` : "");
  el.appendChild(box);
  box.querySelector(".refund-btn")?.addEventListener("click", async (e) => {
    const button = e.currentTarget;
    const amount = Number(box.querySelector(".refund-amount").value);
    if (!Number.isInteger(amount) || amount < 1 || amount > o.paid_amount) { toast(`1〜${o.paid_amount}円で入れてください`); return; }
    if (!confirm(`No.${o.order_number} ${o.customer_name}様に ${yen(amount)} を返金しますか？\n（Squareからお客様のカードへ返金されます。取り消しはできません）`)) return;
    button.disabled = true;
    try {
      const res = await fetch(`${CONFIG.url}/functions/v1/square-payments`, {
        method: "POST",
        headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refund", order_id: o.id, amount }),
      });
      const r = await res.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.message || "返金できませんでした");
      toast("返金を受け付けました");
    } catch (err) { toast(err.message); }
    await loadOrders();
  });
}
function renderQuoteEditor(el,o) {
  const box = document.createElement('div'); box.className = 'confirm-box quote-editor';
  const q = o.quote;
  if (q) {
    const detail = document.createElement('p'); detail.style.whiteSpace = 'pre-wrap';
    detail.textContent = `見積もり ${q.revision}：${yen(q.amount)}（税込総額）\n${q.description}\n回答期限：${new Date(q.expires_at).toLocaleString('ja-JP')}\n${q.accepted_at ? '承諾日時：'+new Date(q.accepted_at).toLocaleString('ja-JP') : '未承諾・製造に進めないでください'}`;
    box.appendChild(detail);
  }
  // SELECTTYPEから移した承認待ち（見積もりの話ではない）。旧側で承認したら、ここで確定にするだけ（2026-09-30）
  if (!q && o.review_state === 'requested' && o.status === 'new' && String(o.internal_memo || '').startsWith('SELECTTYPE')) {
    const p = document.createElement('p');
    p.textContent = '旧予約フォーム（SELECTTYPE）から移した、承認待ちのご予約です。SELECTTYPEで承認したら「確定にする」を押してください（お客様へのメールは送りません）。キャンセルした場合は、下のキャンセルを使ってください。';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-primary'; btn.textContent = '確定にする';
    btn.onclick = async () => {
      if (!confirm(`No.${o.order_number} ${o.customer_name}様のご予約を確定にしますか？`)) return;
      btn.disabled = true;
      try {
        const r = await api('POST', '/rest/v1/rpc/fn_confirm_migrated_order', { p_order: o.id });
        if (!r.ok) throw new Error(r.message);
        toast('確定にしました');
        await loadOrders();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    box.append(p, btn);
    el.appendChild(box);
    return;
  }
  if (reviewPending(o) && o.status !== 'canceled') {
    const form = document.createElement('form');
    form.innerHTML = `<p>追加希望を確認し、対応内容と税込総額をお客様へ提示します。承諾前も枠は仮押さえ中です。回答期限が過ぎても自動キャンセルされません。</p>
      <label class="field">対応内容・仕上がりの条件<textarea class="quote-description" rows="4" maxlength="4000" required>${esc(q?.description || '')}</textarea></label>
      <label class="field">ケーキ全体の税込総額（円）<input class="quote-amount" type="number" min="0" max="1000000" step="1" required value="${esc(q?.amount ?? '')}" placeholder="選択分 ${esc(o.total_amount)}円を含む総額"></label>
      <label class="field">回答期限（この端末の時刻）<input class="quote-expiry" type="datetime-local" required></label>
      <button class="btn-primary" type="submit">${q ? '見積もりを更新してメールで案内' : '見積もりをメールで案内'}</button><p class="quote-error error" role="status"></p>`;
    form.onsubmit = async e => {
      e.preventDefault(); if (!form.reportValidity()) return;
      const description = form.querySelector('.quote-description').value.trim();
      const amount = Number(form.querySelector('.quote-amount').value);
      const expiry = new Date(form.querySelector('.quote-expiry').value);
      if (!confirm(`税込総額 ${yen(amount)}\n回答期限 ${expiry.toLocaleString('ja-JP')}\n\n${description}\n\nこの内容をお客様へメールで案内しますか？`)) return;
      const button = form.querySelector('button'); button.disabled = true;
      try {
        const r = await api('POST','/rest/v1/rpc/fn_issue_order_quote',{p_order:o.id,p_amount:amount,p_description:description,p_expires_at:expiry.toISOString(),p_expected_quote:o.current_quote_id || null});
        if (!r.ok) throw new Error(r.message);
        toast('見積もりを保存し、メール送信を受け付けました');
        await loadOrders();
      } catch (error) {form.querySelector('.quote-error').textContent=error.message;button.disabled=false;}
    };
    box.appendChild(form);
  }
  el.appendChild(box);
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

let kitchenRange = null, kitchenGeneration = 0;
function kitchenOrders() { return $("kitchen-range-mode").checked ? (kitchenRange?.orders || []) : state.orders; }
async function loadKitchenRange() {
  const generation = ++kitchenGeneration, tenant = state.tenantId;
  const from = $("kitchen-from").value, to = $("kitchen-to").value;
  kitchenRange = null;
  $("btn-print").disabled = true;
  $("kitchen-summary").replaceChildren(); $("kitchen-detail").replaceChildren();
  $("kitchen-heading").textContent = "期間の製造数";
  if (!from || !to || from > to) { $("kitchen-scope").textContent = "開始日と終了日を確認してください（終了日は開始日以降）。"; return; }
  $("kitchen-scope").textContent = "製造数を読み込み中…";
  try {
    const orders = [];
    for (;;) {
      const page = await api("GET", `/rest/v1/orders?tenant_id=eq.${tenant}&pickup_date=gte.${from}&pickup_date=lte.${to}&order=pickup_date.asc,pickup_slot_label.asc,id.asc&select=*,quote:order_quotes!orders_current_quote_id_fkey(*),order_items!order_items_order_id_fkey(*,order_item_options!order_item_options_order_item_id_fkey(*)),order_answers!order_answers_order_id_fkey(*),order_images!order_images_order_id_fkey(id,path,question_id,note,created_at),order_previews!order_previews_order_id_fkey(id,path,created_at)&limit=500&offset=${orders.length}`);
      if (generation !== kitchenGeneration || tenant !== state.tenantId || !$("kitchen-range-mode").checked) return;
      orders.push(...page.map(normalizeOrder)); if (page.length < 500) break;
    }
    kitchenRange = {from, to, orders}; renderKitchen();
    $("btn-print").disabled = false;
  } catch {
    if (generation === kitchenGeneration) $("kitchen-scope").textContent = "読み込めませんでした。「この期間の製造数を見る」で再度お試しください。";
  }
}
$("kitchen-range-mode").onchange = () => {
  const on = $("kitchen-range-mode").checked;
  $("kitchen-range-fields").classList.toggle("hidden", !on);
  if (on) {
    $("kitchen-from").value ||= state.date;
    $("kitchen-to").value ||= state.date;
    loadKitchenRange();
  } else { ++kitchenGeneration; kitchenRange = null; $("btn-print").disabled = false; renderKitchen(); }
};
$("kitchen-range-load").onclick = loadKitchenRange;
for (const id of ["kitchen-from", "kitchen-to"]) $(id).onchange = loadKitchenRange;

/* ---------- 厨房ビュー ---------- */
// 選択肢にぶら下がる質問（ナンバークッキーの数字など）を見分けるため、質問→選択肢の対応を店ごとに1回読む。
let questionOptions = {tenant: null, map: new Map()};
// 新しく読めたときだけ true（呼び出し側が描き直す）。
async function ensureQuestionOptions() {
  const tenant = state.tenantId;
  if (questionOptions.tenant === tenant) return false;
  try {
    const rows = [];
    for (;;) {
      const page = await api("GET", `/rest/v1/common_questions?tenant_id=eq.${tenant}&option_id=not.is.null&select=id,option_id&order=id&limit=1000&offset=${rows.length}`);
      rows.push(...page); if (page.length < 1000) break;
    }
    if (tenant !== state.tenantId) return false;
    questionOptions = {tenant, map: new Map(rows.map((q) => [q.id, q.option_id]))};
    return true;
  } catch { return false; /* 読めなくても台数・選択肢の数は出す（数字の内訳は質問文に選択肢名がある分だけ） */ }
}
function optionCountsHtml(active) {
  const rows = OptionCounts.build(active, questionOptions.map);
  if (!rows.length) return "";
  let html = `<h3 class="kitchen-sub">飾り・選択肢の数</h3><table class="kitchen-table option-count-table"><tr><th>グループ</th><th>選択肢</th><th style="width:70px">数</th></tr>`;
  let lastGroup = null;
  for (const row of rows) {
    html += `<tr><td>${row.group === lastGroup ? "" : esc(row.group)}</td><td>${esc(row.name)}</td><td class="qty-cell">${esc(row.count)}</td></tr>`;
    lastGroup = row.group;
    for (const [digit, n] of row.digits) html += `<tr class="digit-row"><td></td><td>└ 数字「${esc(digit)}」</td><td class="qty-cell">${esc(n)}</td></tr>`;
    if (row.mismatches.length) html += `<tr class="digit-row"><td></td><td colspan="2" class="digit-warn">⚠️ 枚数と数字の数が合わない予約：${
      row.mismatches.map((m) => `No.${esc(m.order_number)}（${esc(m.quantity)}枚・「${esc(m.answer)}」）`).join("、")}</td></tr>`;
  }
  return html + `</table>`;
}
function renderKitchen() {
  const [y, m, d] = state.date.split("-");
  $("kitchen-title").textContent = `${y}年${+m}月${+d}日 製造一覧（${state.tenantName}）`;
  const rangeMode = $("kitchen-range-mode").checked;
  $("kitchen-heading").textContent = rangeMode ? "期間の製造数" : "この日の製造数";
  $("kitchen-scope").textContent = rangeMode && kitchenRange ? `受取日 ${kitchenRange.from} 〜 ${kitchenRange.to} の合計` : "";
  if (rangeMode && kitchenRange) $("kitchen-title").textContent = `${kitchenRange.from} 〜 ${kitchenRange.to} 製造一覧（${state.tenantName}）`;
  const active = kitchenOrders().filter((o) => o.status !== "canceled" && !reviewPending(o));
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
  $("kitchen-summary").innerHTML = active.length ? sum + optionCountsHtml(active) : `<p class="empty-note">${rangeMode ? "この期間" : "この日"}の製造はありません</p>`;

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
      <div class="khead"><span>${rangeMode ? esc(o.pickup_date) + " " : ""}${esc(o.pickup_slot_label)}</span>
        <span>No.${esc(o.order_number)} ${esc(o.customer_name)}様${(o.order_images || []).length ? ` 📷${esc(o.order_images.length)}` : ""}${(o.order_previews || []).length ? " 🎨" : ""}</span>
        <span>${esc(it.product_name_snapshot)} ${esc(it.variant_label_snapshot)}</span></div>
      ${o._preview_url || (o._images_signed || []).length ? `<div class="kpreview">` +
        (o._preview_url ? `<figure><img class="design-img" src="${esc(o._preview_url)}" alt="予約時のデザインイメージ"><figcaption>デザインイメージ</figcaption></figure>` : "") +
        (o._images_signed || []).map((x) => `<figure class="kimage"><img src="${esc(x.url)}" alt="お客様の添付画像"><figcaption>${esc(x.note || "添付画像")}</figcaption></figure>`).join("") +
        `</div>` : ""}
      <ul>${opts}${notes}</ul>
      ${o.review_state === 'accepted' && o.quote ? `<p style="white-space:pre-wrap"><strong>合意した追加希望：</strong>${esc(o.quote.description)}</p>` : ""}
      ${plate?.answer_text ? `<span class="plate">プレート：「${esc(plate.answer_text)}」</span>` : ""}
      ${(o.staff_note || "").trim() ? `<p class="knote"><strong>お店のメモ：</strong>${esc(o.staff_note.trim())}</p>` : ""}`;
    wrap.appendChild(card);
  }
}
$("btn-print").onclick = async () => {
  await Promise.all(kitchenOrders().filter((o) => o.status !== "canceled")
    .flatMap((o) => [ensureOrderPreviewUrl(o), ensureOrderImageUrls(o)]));
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
  const windowInput = $("t-booking-window");
  if (windowInput && !windowInput.checkValidity()) { windowInput.reportValidity(); return; }
  for (const id of ["t-name", "t-registrant-email", "t-email"]) {
    const input = $(id);
    if ((id === "t-name" && !input.value.trim()) || !input.checkValidity()) {
      document.querySelector(`.tab[data-tab="${id === "t-email" ? "settings" : "account"}"]`).click();
      input.focus(); input.reportValidity(); toast("店名・メールアドレスの入力を確認してください"); return;
    }
  }
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
const TOKUSHO_FIELDS = {
  seller: "t-toku-seller", manager: "t-toku-manager", address: "t-toku-address",
  phone: "t-toku-phone",
  email: "t-toku-email", extraFees: "t-toku-extra-fees", paymentMethod: "t-toku-payment-method",
  paymentTiming: "t-toku-payment-timing", delivery: "t-toku-delivery",
  returns: "t-toku-returns", cancellation: "t-toku-cancellation",
};
function parseLegacyTokushoho(text = "") {
  const labels = { "販売業者": "seller", "運営責任者": "manager", "所在地": "address", "電話番号": "phone",
    "メールアドレス": "email", "商品代金以外の必要料金": "extraFees", "お支払い方法": "paymentMethod",
    "お支払い時期": "paymentTiming", "お引き渡し時期": "delivery",
    "返品・交換について": "returns", "キャンセルについて": "cancellation" };
  const values = {}; let current = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const match = line.match(/^([^：:]+)[：:]\s*(.*)$/), key = match ? labels[match[1].trim()] : "";
    if (key) { current = key; const value = match[2].trim(); values[key] = key === "phone" && /^ご請求があった場合/.test(value) ? "" : value; }
    else if (current && !/^(電話番号|販売価格)[：:]/.test(line)) values[current] = `${values[current] ? values[current] + "\n" : ""}${line}`;
  }
  return values;
}
function tokushohoValue() {
  const fields = Object.fromEntries(Object.entries(TOKUSHO_FIELDS).map(([key, id]) => [key, $(id).value.trim()]));
  if (!Object.values(fields).some(Boolean)) return null;
  const first = [fields.seller && `販売業者：${fields.seller}`, fields.manager && `運営責任者：${fields.manager}`,
    fields.address && `所在地：${fields.address}`,
    fields.phone ? `電話番号：${fields.phone}` : `電話番号：ご請求があった場合、遅滞なく開示いたします。お問い合わせはメールアドレス${fields.email ? `（${fields.email}）` : ""}までお願いいたします`,
    fields.email && `メールアドレス：${fields.email}`].filter(Boolean);
  const terms = ["販売価格：各商品ページに表示された金額（消費税込み）",
    fields.extraFees && `商品代金以外の必要料金：${fields.extraFees}`,
    fields.paymentMethod && `お支払い方法：${fields.paymentMethod}`,
    fields.paymentTiming && `お支払い時期：${fields.paymentTiming}`,
    fields.delivery && `お引き渡し時期：${fields.delivery}`].filter(Boolean);
  const after = [fields.returns && `返品・交換について：\n${fields.returns}`,
    fields.cancellation && `キャンセルについて：\n${fields.cancellation}`].filter(Boolean);
  return { version: 2, ...fields, text: [first.join("\n"), terms.join("\n"), after.join("\n\n")].filter(Boolean).join("\n\n") };
}
function tokushohoComplete() { return Object.entries(TOKUSHO_FIELDS).filter(([key]) => key !== "phone").every(([, id]) => $(id).value.trim()); }
function syncRegistrationPhone() {
  const same = $("t-registrant-same").checked;
  $("t-registrant-phone").disabled = same;
  $("t-registrant-phone").hidden = same;
}
for (const id of ["t-registrant-email", "t-registrant-phone", "t-registrant-same"]) {
  $(id).addEventListener(id === "t-registrant-same" ? "change" : "input", () => { syncRegistrationPhone(); markDirty(); });
}
async function loadTenantForm() {
  const t = (await api("GET", `/rest/v1/tenants?id=eq.${state.tenantId}&select=*`))[0];
  $('rules-list').closest('.confirm-box').classList.toggle('hidden',t.reservation_plan==='lite');
  initLineSettings(t);
  $("t-name").value = t.name || "";
  $("t-email").value = t.contact_email || "";
  $("t-shop-phone").value = t.phone || "";
  $("t-shop-address").value = t.address || "";
  const contact = t.registration_contact || {};
  $("t-registrant-name").value = contact.name || "";
  $("t-registrant-email").value = contact.email || "";
  $("t-registrant-same").checked = !!contact.same_as_shop;
  $("t-registrant-phone").value = contact.phone || "";
  syncRegistrationPhone();
  $("t-cutoff").value = (t.order_cutoff_time || "21:00").slice(0, 5);
  $("t-deadline").value = t.default_deadline_days ?? 3;
  const windowMax = t.reservation_plan === "lite" ? 30 : 90;
  $("t-booking-window").max = windowMax;
  $("t-booking-window").value = t.booking_window_days ?? windowMax;
  $("t-booking-window-help").textContent = `1〜${windowMax}日で設定できます。${windowMax === 90 ? "90日は約3か月です。" : "Liteは最大30日です。"}`;
  const mode = t.deadline_skip_closed_days ? "business" : "calendar";
  [...document.querySelectorAll('input[name="deadline-mode"]')].forEach((r) => { r.checked = r.value === mode; });
  $("t-page-notice").value = t.page_notice || "";
  $("t-preview-note").value = t.preview_note || "";
  $("t-pickup-note").value = t.pickup_note || "";
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
  const toku = t.tokushoho || {}, legacyToku = parseLegacyTokushoho(toku.text || "");
  for (const [key, id] of Object.entries(TOKUSHO_FIELDS)) {
    $(id).value = toku[key] || legacyToku[key] ||
      (key === "seller" ? t.name || "" : key === "email" ? t.contact_email || "" : "");
  }
  // 未入力の項目があれば注意書きを出す。保存時に表示用文章も自動生成する。
  const tokuWarn = () => $("tokushoho-warn").classList.toggle("hidden", tokushohoComplete());
  Object.values(TOKUSHO_FIELDS).forEach((id) => $(id).addEventListener("input", tokuWarn));
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
  regField("tenants", T, "phone", $("t-shop-phone"));
  regField("tenants", T, "address", $("t-shop-address"));
  regField("tenants", T, "registration_contact", $("t-registrant-name"), { get: () => ({
    name: $("t-registrant-name").value.trim(), email: $("t-registrant-email").value.trim(),
    same_as_shop: $("t-registrant-same").checked,
    phone: $("t-registrant-same").checked ? null : $("t-registrant-phone").value.trim()
  }) });
  regField("tenants", T, "contact_email", $("t-email"));
  regField("tenants", T, "order_cutoff_time", $("t-cutoff"));
  regField("tenants", T, "default_deadline_days", $("t-deadline"), { number: true });
  regField("tenants", T, "booking_window_days", $("t-booking-window"), { number: true });
  regField("tenants", T, "page_notice", $("t-page-notice"),
    { get: () => $("t-page-notice").value.trim() || null });   // 空欄=何も出さない
  regField("tenants", T, "preview_note", $("t-preview-note"),
    { get: () => $("t-preview-note").value.trim() });   // 空欄=注意書きを出さない
  regField("tenants", T, "pickup_note", $("t-pickup-note"),
    { get: () => $("t-pickup-note").value.trim() || null });   // 空欄=何も出さない
  regField("tenants", T, "cancel_policy", $("t-cancel"));
  regField("tenants", T, "customer_form", $("t-addr-enabled"), {
    get: () => ({ address: { enabled: $("t-addr-enabled").checked,
                             required: $("t-addr-enabled").checked && $("t-addr-required").checked } }),
  });
  regField("tenants", T, "tokushoho", $("t-toku-seller"), { get: tokushohoValue });
  Object.values(TOKUSHO_FIELDS).filter((id) => id !== "t-toku-seller")
    .forEach((id) => $(id).addEventListener("input", markDirty));
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
    tokushoho: tokushohoValue(),
  });
  state.tenantName = name;
  $("admin-shop-name").textContent = `${name}｜管理`;
  toast("店舗情報を保存しました");
};

// 「商品ごとの上限」は商品エディタ（products.html）の各商品ページへ移設（まりほ指摘 2026-08-25：分類が変）

function initLineSettings(t) {
  // LINE通知はStandardの機能（2026-10-03 まりほ決定）。Liteでは接続の手順を出さず、切り替えの案内だけ出す
  const lite = t.reservation_plan === 'lite';
  const card = $('settings-line');
  // 先頭の3つ（見出し・説明・状態）だけ残し、手順・ボタンは隠す
  if (card) Array.from(card.children).forEach((el, i) => { el.hidden = lite && i >= 3; });
  if (lite) {
    const st = $('line-config-status');
    if (st) st.textContent = 'LINE通知はStandardプランの機能です。「ご契約・お支払い」からStandardへ切り替えると使えます。';
    return;
  }
  if (window.loadLineConnectionSettings) window.loadLineConnectionSettings(t);
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
    $("tab-calendar").classList.toggle("hidden", state.tab !== "calendar");
    $("tab-pickup").classList.toggle("hidden", state.tab !== "pickup");
    $("tab-settings").classList.toggle("hidden", state.tab !== "settings");
    $("tab-design").classList.toggle("hidden", state.tab !== "design");
    $("tab-reports").classList.toggle("hidden", state.tab !== "reports");
    $("tab-support").classList.toggle("hidden", state.tab !== "support");
    $("tab-account").classList.toggle("hidden", state.tab !== "account");
    $("tab-billing").classList.toggle("hidden", state.tab !== "billing");
    if (state.tab === "account") openAccount();
    const editing = ["settings", "design", "account"].includes(state.tab);
    $("date-nav").classList.toggle("hidden", editing || ["calendar", "reports", "support", "account", "billing"].includes(state.tab));
    // 設定とデザインの下書きは画面を切り替えても保持し、一緒に保存する。
    $("save-bar").classList.toggle("hidden", !editing);
    if (state.tab === "design") pushThemePreview();
    if (state.tab === "calendar") window.OrderCalendar?.open();
    if (state.tab === "reports") openReports();
    if (state.tab === "support") openSupport();
    window.Onboarding?.onTab(state.tab);
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
  const picked = $("th-logo-file").files[0];
  if (!picked) return;
  // ロゴは形のまま表示されるので自由な形で切る。透過PNGは透過のまま残す
  const file = window.ImageCrop ? await ImageCrop.open(picked, { keepPng: true, allowOriginal: true, maxSide: 1000, title: "ロゴの使う範囲を決める" }) : picked;
  if (!file) { $("th-logo-file").value = ""; return; }
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

async function renderLiteUsage(t) {
  let box=document.getElementById('lite-usage');
  if(!box){box=document.createElement('div');box.id='lite-usage';box.className='confirm-box';$('billing-banner').after(box);}
  box.hidden=t.reservation_plan!=='lite';if(box.hidden)return;
  box.textContent='Lite：受取月ごとにネット予約30台まで・最大30日先まで';
  try{
    const rows=await api('POST','/rest/v1/rpc/fn_reservation_usage',{p_tenant:t.id});
    box.replaceChildren();
    for(const row of rows){const line=document.createElement('p');const month=Number(row.month.slice(5,7));
      const limit=row.limit??30;line.textContent=`${month}月受取分：残り${Math.max(0,limit-row.used_units)}台（${row.used_units}／${limit}台）${row.used_units>=limit?'・この月の新規ネット予約は停止中です':''}`;box.appendChild(line);}
    const link=document.createElement('a');link.href='?tab=billing';link.textContent='Standardプランを見る（月額4,980円）';box.appendChild(link);
    const help=document.createElement('p');help.className='small';help.textContent='Standardは月間台数の上限なし・最大90日先まで。「ご契約・お支払い」から変更料金を確認できます。';box.appendChild(help);
  }catch{box.textContent+='（利用台数を取得できません。再読み込みしてください）';}
}
