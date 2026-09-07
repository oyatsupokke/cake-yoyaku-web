/* =====================================================================
 * ご予約の確認・変更・キャンセル（お客様セルフ操作ページ）
 * - 入口: 確認メールに載る専用URL manage.html?t=<manage_token>
 * - できること（それぞれ店側設定の期限内のみ）:
 *     受取日時の変更 / ご注文内容の変更（フォームを開き直す） / キャンセル
 * - 期限・キャパ・整合性の最終判定はすべてサーバー側RPC
 * ===================================================================== */

const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
};

const TOKEN = new URLSearchParams(location.search).get("t");

const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + n.toLocaleString("ja-JP");
const DOW = ["日", "月", "火", "水", "木", "金", "土"];

const state = {
  data: null,       // fn_manage_get_order の結果
  sel: { date: null, slot: null },
  calMonth: null,
  avail: {},
  slots: [],
  slotFull: {},
};

async function api(path) {
  const res = await fetch(CONFIG.url + path, {
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
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
  if (!res.ok) throw new Error(`RPC ${name} ${res.status}`);
  return res.json();
}
function kickMailWorker() {
  fetch(`${CONFIG.url}/functions/v1/send-order-emails`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}` },
  }).catch(() => {});
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 4000);
}
function show(viewId) {
  for (const v of ["view-error", "view-order", "view-slot", "view-cancel", "view-done"])
    $(v).classList.toggle("hidden", v !== viewId);
  window.scrollTo({ top: 0 });
}
function fmtPickup(dateStr, slotLabel) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日（${dow}） ${slotLabel}`;
}

/* ---------- 添付いただいた画像（2026-09-04） ----------
 * 実体は非公開バケットにあり、Edge Function が manage_token を確かめて
 * 1時間だけ有効な署名付きURLを返す（メールには画像を添付しない方針）。 */
async function loadOrderImages() {
  try {
    const res = await fetch(`${CONFIG.url}/functions/v1/order-images`, {
      method: "POST",
      headers: {
        apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "view", manage_token: TOKEN }),
    });
    const j = await res.json();
    if (!j?.ok || !j.images?.length) return;
    const thumbs = (list) => `<span class="manage-thumbs">` + list.map((x) =>
      `<span class="manage-thumb"><a href="${esc(safeImageUrl(x.url))}" target="_blank" rel="noopener">` +
      `<img src="${esc(safeImageUrl(x.url))}" alt="添付画像"></a>` +
      (x.note ? `<span class="cap">${esc(x.note)}</span>` : "") + `</span>`).join("") + `</span>`;
    // 質問ごとにまとめて、その質問の行（「2枚」と出ている行）を画像そのものに置き換える
    const rest = [];
    const byQ = new Map();
    for (const x of j.images) {
      if (!x.question_id) { rest.push(x); continue; }
      byQ.set(x.question_id, [...(byQ.get(x.question_id) || []), x]);
    }
    for (const [qid, list] of byQ) {
      const cell = $("order-detail").querySelector(`[data-q="${qid}"] .v`);
      if (cell) cell.outerHTML = thumbs(list);
      else rest.push(...list);
    }
    if (rest.length) {
      const box = document.createElement("div");
      box.className = "confirm-row";
      box.innerHTML = `<span class="k">添付画像</span>` + thumbs(rest);
      $("order-detail").appendChild(box);
    }
  } catch { /* 画像が出せなくても、予約内容の確認・変更は使える */ }
}

/* ---------- 予約内容の表示 ---------- */

const STATUS_LABEL = {
  new: "受付済み", confirmed: "受付済み", in_production: "ご用意中",
  completed: "お渡し済み", canceled: "キャンセル済み",
};

function renderOrder() {
  const { order: o, tenant: t, allowed, deadlines } = state.data;
  $("shop-name").textContent = t.name;
  document.title = `ご予約の確認・変更・キャンセル | ${t.name}`;

  const chip = $("status-chip");
  chip.textContent = STATUS_LABEL[o.status] || o.status;
  chip.classList.toggle("canceled", o.status === "canceled");

  const rows = [];
  const row = (k, v) => rows.push(`<div class="confirm-row"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`);
  row("予約番号", `No.${o.order_number}`);
  row("ケーキ", `${o.product_name}（${o.variant_label}）`);
  for (const op of o.options) {
    const text = op.text ? `「${op.text}」` : "";
    row(op.group_name, `${op.option_name}${op.quantity > 1 ? ` ×${op.quantity}` : ""}${text}`);
  }
  for (const a of o.answers) {
    const v = a.choice_label || a.answer_text;
    // 画像の回答は、あとで loadOrderImages がこの行にサムネイルを入れる
    if (v) rows.push(`<div class="confirm-row" data-q="${esc(a.question_id || "")}">` +
      `<span class="k">${esc(a.label)}</span><span class="v">${esc(v)}</span></div>`);
  }
  row("受取日時", fmtPickup(o.pickup_date, o.pickup_slot_label));
  row("お名前", `${o.customer.name} 様`);
  rows.push(`<div class="confirm-row total"><span class="k">合計（税込）</span><span>${yen(o.total_amount)}</span></div>`);
  $("order-detail").innerHTML = rows.join("");
  loadOrderImages();

  // 操作ボタン
  const list = $("action-list");
  list.innerHTML = "";
  const btn = (label, cls, hint, onclick) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = cls; b.textContent = label; b.onclick = onclick;
    list.appendChild(b);
    if (hint) {
      const p = document.createElement("p");
      p.className = "action-hint"; p.textContent = hint;
      list.appendChild(p);
    }
  };
  if (allowed.slot)
    btn("受取日時を変更する", "btn-secondary", `${deadlines.slot}受け付けています`, openSlotView);
  if (allowed.content)
    btn("ご注文内容を変更する", "btn-secondary", `${deadlines.content}受け付けています`, () => {
      location.href = `index.html?edit=${encodeURIComponent(TOKEN)}`;
    });
  if (allowed.cancel)
    btn("このご予約をキャンセルする", "btn-danger", `${deadlines.cancel}受け付けています`, openCancelView);

  // 操作できない場合の案内
  const note = $("locked-note");
  if (!allowed.slot && !allowed.content && !allowed.cancel) {
    let msg;
    if (o.status === "canceled") {
      msg = "このご予約はキャンセル済みです。";
    } else if (o.status === "completed") {
      msg = "このご予約はお渡し済みです。ご利用ありがとうございました。";
    } else if (o.status === "in_production") {
      msg = "ご予約のケーキのご用意を進めております。ご変更・キャンセルをご希望の場合は、お手数ですがお店まで直接ご連絡ください。";
    } else {
      msg = "この画面からのお手続きの受付期限を過ぎています。ご変更・キャンセルをご希望の場合は、お手数ですがお店まで直接ご連絡ください。";
    }
    note.textContent = msg;
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }

  renderLineArea();

  $("policy-box").classList.toggle("hidden", !t.cancel_policy);
  $("cancel-policy").textContent = t.cancel_policy || "";
  show("view-order");
}

/* ---------- LINE通知（店側でONのときだけ表示。メールは変わらず届く） ---------- */

function renderLineArea() {
  const { order: o, tenant: t } = state.data;
  const area = $("line-area");
  const result = new URLSearchParams(location.search).get("line"); // linked / error（連携画面からの戻り）
  if (!t.line_notify_enabled) { area.classList.add("hidden"); return; }

  if (o.line_linked) {
    area.innerHTML =
      `<p class="line-linked">✓ LINE通知を設定済みです</p>` +
      (result === "linked"
        ? `<p class="small">設定が完了しました。ご予約の控えがLINEに届きます。</p>`
        : `<p class="small">ご予約に関するお知らせがLINEにも届きます。</p>`);
  } else if (o.status === "canceled" || o.status === "completed") {
    area.classList.add("hidden");
    return;
  } else {
    area.innerHTML =
      (result === "error"
        ? `<p class="error">LINE連携がうまくいきませんでした。お手数ですがもう一度お試しください。</p>`
        : "") +
      `<a class="line-btn" href="${CONFIG.url}/functions/v1/line-link?t=${encodeURIComponent(TOKEN)}">LINEで通知を受け取る</a>` +
      `<p class="small">ご予約の控えやお知らせがLINEにも届きます（メールも変わらず届きます）</p>`;
  }
  area.classList.remove("hidden");
}

/* ---------- 受取日時の変更 ---------- */

const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function openSlotView() {
  const { order: o, tenant: t } = state.data;
  state.sel = { date: null, slot: null };
  $("slot-current").textContent = `現在のご予約：${fmtPickup(o.pickup_date, o.pickup_slot_label)}`;
  $("btn-slot-save").disabled = true;
  $("slot-error").classList.add("hidden");
  $("slot-area").classList.add("hidden");
  if (!state.slots.length) {
    try {
      state.slots = await api(`/rest/v1/pickup_time_slots?tenant_id=eq.${t.id}&is_active=eq.true&select=id,label,start_time&order=start_time.asc`);
    } catch { state.slots = []; }
  }
  const [y, m] = o.pickup_date.split("-").map(Number);
  const now = new Date();
  // 今月より前は出さない（受取日の月か今月の遅いほうから）
  state.calMonth = new Date(Math.max(new Date(y, m - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1)));
  show("view-slot");
  loadCalendar();
}

async function loadCalendar() {
  const { order: o, tenant: t } = state.data;
  const m = state.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
  $("cal-title").textContent = `${m.getFullYear()}年${m.getMonth() + 1}月`;
  $("cal-grid").innerHTML = '<div class="dow">読み込み中…</div>';
  try {
    const optIds = o.options.map((x) => x.option_id).filter(Boolean);
    const rows = await rpc("fn_get_availability", {
      p_tenant: t.id,
      p_product: o.product_id,
      p_variant: o.variant_id,
      p_from: fmtDate(first),
      p_to: fmtDate(last),
      p_options: optIds.length ? optIds : null,
    });
    state.avail = Object.fromEntries(rows.map((r) => [r.d, r.status]));
    // いまの受取日は「戻す」選択肢として選べるようにする（満枠表示でも自分の枠があるため）
    if (o.pickup_date.startsWith(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`)) {
      if (state.avail[o.pickup_date] === "full") state.avail[o.pickup_date] = "few";
    }
    renderCalendar();
  } catch {
    $("cal-grid").innerHTML = '<div class="dow">読み込みに失敗しました</div>';
  }
}

function renderCalendar() {
  const grid = $("cal-grid");
  grid.innerHTML = "";
  for (const d of DOW) {
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
  const now = new Date();
  $("cal-prev").disabled = m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth();
}

async function selectDate(key) {
  const { order: o, tenant: t } = state.data;
  state.sel.date = key;
  state.sel.slot = null;
  $("btn-slot-save").disabled = true;
  renderCalendar();
  try {
    const rows = await rpc("fn_get_slot_availability", {
      p_tenant: t.id, p_date: key,
      p_product: o.product_id, p_variant: o.variant_id,
    });
    state.slotFull = Object.fromEntries(rows.map((r) => [r.slot_id, r.is_full]));
    // 同じ日なら、いまの自分の枠は選べる扱いにする（自分の分を除けば空くため）
    if (key === o.pickup_date) state.slotFull[o.pickup_slot_id] = false;
  } catch { state.slotFull = {}; }
  renderSlots();
  $("slot-area").classList.remove("hidden");
  $("slot-area").scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderSlots() {
  const { order: o } = state.data;
  const wrap = $("slot-pills");
  wrap.innerHTML = "";
  for (const s of state.slots) {
    const isCurrent = state.sel.date === o.pickup_date && s.id === o.pickup_slot_id;
    const full = state.slotFull?.[s.id] && !isCurrent;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "pill" + (state.sel.slot?.id === s.id ? " selected" : "") + (full ? " full" : "");
    el.textContent = s.label + (isCurrent ? "（現在）" : full ? "（満員）" : "");
    if (full) el.disabled = true;
    else el.onclick = () => {
      state.sel.slot = s;
      renderSlots();
      const same = state.sel.date === o.pickup_date && s.id === o.pickup_slot_id;
      $("btn-slot-save").disabled = same;
      if (same) toast("現在と同じ受取日時です");
    };
    wrap.appendChild(el);
  }
}

$("cal-prev").onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); loadCalendar(); };
$("cal-next").onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); loadCalendar(); };
$("btn-slot-back").onclick = () => show("view-order");

$("btn-slot-save").onclick = async () => {
  const btn = $("btn-slot-save");
  btn.disabled = true;
  btn.textContent = "変更中…";
  $("slot-error").classList.add("hidden");
  try {
    const r = await rpc("fn_manage_change_slot", {
      p_token: TOKEN, p_date: state.sel.date, p_slot: state.sel.slot.id,
    });
    if (!r.ok) throw new Error(r.message || "変更できませんでした");
    kickMailWorker();
    $("done-emoji").textContent = "✅";
    $("done-title").textContent = "受取日時を変更しました";
    $("done-text").textContent =
      `新しい受取日時：${fmtPickup(state.sel.date, state.sel.slot.label)}\n確認メールをお送りしますのでご確認ください。`;
    show("view-done");
  } catch (e) {
    $("slot-error").textContent = e.message;
    $("slot-error").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "この日時に変更する";
  }
};

/* ---------- キャンセル ---------- */

function openCancelView() {
  const { order: o } = state.data;
  const rows = [];
  const row = (k, v) => rows.push(`<div class="confirm-row"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`);
  row("予約番号", `No.${o.order_number}`);
  row("ケーキ", `${o.product_name}（${o.variant_label}）`);
  row("受取日時", fmtPickup(o.pickup_date, o.pickup_slot_label));
  rows.push(`<div class="confirm-row total"><span class="k">合計（税込）</span><span>${yen(o.total_amount)}</span></div>`);
  $("cancel-detail").innerHTML = rows.join("");
  $("cancel-error").classList.add("hidden");
  show("view-cancel");
}

$("btn-cancel-back").onclick = () => show("view-order");

$("btn-cancel-confirm").onclick = async () => {
  const btn = $("btn-cancel-confirm");
  btn.disabled = true;
  btn.textContent = "処理中…";
  $("cancel-error").classList.add("hidden");
  try {
    const r = await rpc("fn_manage_cancel", { p_token: TOKEN });
    if (!r.ok) throw new Error(r.message || "キャンセルできませんでした");
    kickMailWorker();
    $("done-emoji").textContent = "🥀";
    $("done-title").textContent = "ご予約をキャンセルしました";
    $("done-text").textContent = "確認メールをお送りしますのでご確認ください。またのご利用をお待ちしております。";
    show("view-done");
  } catch (e) {
    $("cancel-error").textContent = e.message;
    $("cancel-error").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "キャンセルを確定する";
  }
};

/* ---------- 初期ロード ---------- */

async function load() {
  if (!TOKEN) {
    $("shop-name").textContent = "ご予約の管理";
    $("error-message").textContent = "URLが正しくありません。ご予約時の確認メールに記載のリンクからお開きください。";
    show("view-error");
    return;
  }
  try {
    const r = await rpc("fn_manage_get_order", { p_token: TOKEN });
    if (!r.ok) throw new Error(r.message || "ご予約が見つかりません");
    state.data = r;
    renderOrder();
  } catch (e) {
    $("shop-name").textContent = "ご予約の管理";
    $("error-message").textContent =
      e.message.includes("見つかりません") ? e.message
      : "読み込みに失敗しました。時間をおいて再度お試しください。";
    show("view-error");
  }
}
load();
