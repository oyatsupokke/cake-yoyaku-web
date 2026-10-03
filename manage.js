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

/* Squareの支払い画面からの戻り（?r=<戻り用の印>）を、元の ?t=<トークン>&paid=1 のURLに戻す（2026-10-03 監査対応）。
 * 戻りURLに予約の操作トークンを載せると、Squareの管理画面やログに「キャンセル・変更ができるURL」が残る。
 * そこで払う前に、使い捨ての印（nonce）→トークンの対応をこのタブの sessionStorage に置き、
 * 戻り先は印だけにする。戻ってきたら印からトークンを引いて（1回で消す）、以降は従来どおり動かす。
 * 別のブラウザで戻ってきた等で印が引けないときは、予約の中身は出さず「確認メールのリンクから」と案内する。 */
const PREPAY_RETURN_KEY = (nonce) => `prepay_return_${nonce}`;
let PREPAY_RETURN_LOST = false;   // 印はあったが、このタブに対応するトークンが無かった
(function resolvePrepayReturn() {
  const q = new URLSearchParams(location.search);
  const nonce = q.get("r");
  if (q.get("t") || !nonce) return;
  let token = null;
  try {
    token = sessionStorage.getItem(PREPAY_RETURN_KEY(nonce));
    if (token) sessionStorage.removeItem(PREPAY_RETURN_KEY(nonce));
  } catch { /* ストレージが使えない環境＝下の案内へ */ }
  q.delete("r");
  if (!/^[0-9a-f-]{36}$/i.test(token || "")) {
    PREPAY_RETURN_LOST = true;
    q.delete("paid");
    history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : ""));
    return;
  }
  q.set("t", token);
  q.set("paid", "1");   // Edge側も付けるが、古い戻りURLでも支払いの確認（syncAfterPayment）が走るように
  history.replaceState(null, "", `${location.pathname}?${q}`);
})();
const TOKEN = new URLSearchParams(location.search).get("t");

/** 戻り用の使い捨ての印。crypto.randomUUID が無い環境（古いブラウザ）では乱数から作る */
function makeNonce() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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

/* 内容変更はお店の予約ページを変更モードで開く（2026-09-30）。
 * cakebook.jp ではトップ（index.html）がサービス紹介ページで、予約ページは /<店舗ID>/。
 * 以前の index.html?edit= だと紹介ページに飛んでしまっていた。
 * 旧URL（github.io）はトップが予約ページのままなので ?shop= で店を渡す */
async function openEditForm() {
  const token = encodeURIComponent(TOKEN);
  let shop = "";
  try {
    const [t] = await api(`/rest/v1/v_public_tenant?select=subdomain&id=eq.${encodeURIComponent(state.data.tenant.id)}`);
    shop = t?.subdomain || "";
  } catch { /* 取れなければ下で旧来の飛び先へ */ }
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(shop)) { location.href = `index.html?edit=${token}`; return; }
  location.href = location.hostname.endsWith("github.io")
    ? `index.html?shop=${shop}&edit=${token}`
    : `/${shop === "pokke" ? "oyatsupokke" : shop}/?edit=${token}`;
}

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

/* ---------- Squareでの事前払い（任意・2026-10-02） ----------
 * 予約は先に成立している。払いたい人だけ Square の支払い画面へ移り、終わるとここへ戻る。
 * あとで金額が上がった分は当日払い、下がった分・キャンセル分はお店が返金する。 */
function paymentRows(pay) {
  if (!pay?.enabled || !(pay.paid_amount > 0)) return [];
  const out = [`<div class="confirm-row"><span class="k">事前のお支払い</span><span>${yen(pay.paid_amount)}（お支払い済み）</span></div>`];
  if (pay.due_amount > 0)
    out.push(`<div class="confirm-row"><span class="k">当日のお支払い</span><span>${yen(pay.due_amount)}（差額）</span></div>`);
  else if (pay.over_amount > 0)
    out.push(`<div class="confirm-row"><span class="k">当日のお支払い</span><span>なし（${yen(pay.over_amount)} はお店から返金いたします）</span></div>`);
  else
    out.push(`<div class="confirm-row"><span class="k">当日のお支払い</span><span>なし</span></div>`);
  return out;
}
async function squarePayments(body) {
  const res = await fetch(`${CONFIG.url}/functions/v1/square-payments`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${CONFIG.anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false }));
}
async function startPrepay(e) {
  const b = e?.currentTarget;
  if (b) { b.disabled = true; b.textContent = "お支払い画面を準備しています…"; }
  // 戻り先にはトークンを載せない（印だけ）。印→トークンはこのタブにだけ置く
  const nonce = makeNonce();
  try { sessionStorage.setItem(PREPAY_RETURN_KEY(nonce), TOKEN); }
  catch { /* 置けない環境では、戻ったあと「確認メールのリンクから」の案内になる */ }
  const back = `${location.origin}${location.pathname}?r=${encodeURIComponent(nonce)}`;
  const r = await squarePayments({ action: "create", manage_token: TOKEN, return_url: back });
  if (r.ok && r.url) { location.href = r.url; return; }
  toast(r.message || "お支払い画面を開けませんでした。時間をおいてもう一度お試しください");
  if (r.paid) await load();
  else if (b) { b.disabled = false; b.textContent = "事前にカードでお支払いする"; }
}
/** Squareの画面から戻ってきた時（?paid=1）。通知より先に戻ることがあるので、こちらからも確かめる */
async function syncAfterPayment() {
  const q = new URLSearchParams(location.search);
  if (q.get("paid") !== "1") return false;
  try { await squarePayments({ action: "sync", manage_token: TOKEN }); } catch { /* 通知で記録される */ }
  q.delete("paid");
  history.replaceState(null, "", `${location.pathname}?${q}`);
  return true;
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
  chip.textContent = o.status === 'canceled' ? STATUS_LABEL[o.status] : ({requested:'追加希望の確認待ち・予約未確定',quoted:'見積もりへの承諾待ち・予約未確定',accepted:'追加希望・予約確定'}[o.review_state] || STATUS_LABEL[o.status] || o.status);
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
      `<span class="k">${esc(a.label)}</span><span class="v">${answerValueHtml(v)}</span></div>`);
  }
  row("受取日時", fmtPickup(o.pickup_date, o.pickup_slot_label));
  row("お名前", `${o.customer.name} 様`);
  rows.push(`<div class="confirm-row total"><span class="k">${['requested','quoted'].includes(o.review_state) ? '選択分（税込・仮）' : '合計（税込）'}</span><span>${yen(o.total_amount)}</span></div>`);
  rows.push(...paymentRows(o.payment));
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
  if (o.payment?.can_prepay)
    btn(`事前にカードでお支払いする（${yen(o.payment.due_amount)}）`, "btn-primary",
      "ご希望の方だけ。Squareのお支払い画面に移ります。お支払いがなければ、これまでどおり店頭でのお支払いです。", startPrepay);
  if (allowed.slot)
    btn("受取日時を変更する", "btn-secondary", `${deadlines.slot}受け付けています`, openSlotView);
  if (allowed.content)
    btn("ご注文内容を変更する", "btn-secondary", `${deadlines.content}受け付けています`, openEditForm);
  if (allowed.cancel)
    btn("このご予約をキャンセルする", "btn-danger", `${deadlines.cancel}受け付けています`, openCancelView);
  if (o.quote) {
    const q=o.quote,box=document.createElement('div');box.className='confirm-box';
    box.style.whiteSpace='pre-wrap';
    box.textContent=`お見積もり ${q.revision}\n\n${q.description}\n\nケーキ全体の税込総額：${yen(q.amount)}\n回答期限：${new Date(q.expires_at).toLocaleString('ja-JP')}`;
    list.prepend(box);
    if (q.can_accept) btn('この内容と金額に同意して予約を確定する','btn-primary','承諾後は、上の対応内容・税込総額で予約が確定します。', async () => {
      if (!confirm(`${q.description}\n\n税込総額 ${yen(q.amount)}\nこの内容と金額に同意して予約を確定しますか？`)) return;
      await quoteAction('fn_accept_order_quote',{p_token:TOKEN,p_quote:q.id});
    });
    else if(o.review_state==='quoted' && o.status!=='canceled') {
      const p=document.createElement('p');p.textContent='回答期限を過ぎています。お店へご連絡ください。';list.appendChild(p);
    }
  }
  if (['requested','quoted'].includes(o.review_state) && o.status!=='canceled') {
    btn('この依頼を取り下げる','btn-danger','予約確定前のご依頼を取り下げます。',async()=>{
      if(confirm('この依頼を取り下げますか？')) await quoteAction('fn_decline_custom_order',{p_token:TOKEN});
    });
  }

  // 選択肢ごとの期限（例：写真付きのデザインは7日前まで）を過ぎた時の案内
  const oc = o.option_cutoff;
  const cutoffMsg = oc?.passed && ["new", "confirmed"].includes(o.status) && !["requested", "quoted"].includes(o.review_state)
    ? `「${oc.option_names.join("」「")}」をお選びのご予約は、受取日の${oc.days}日前（${oc.label}）を過ぎると、この画面からキャンセル・内容変更できません。ご希望の場合は、お手数ですがお店まで直接ご連絡ください。`
    : "";

  // 操作できない場合の案内
  const note = $("locked-note");
  if (cutoffMsg && (allowed.slot || allowed.content || allowed.cancel)) {
    const p = document.createElement("p");
    p.className = "action-hint"; p.textContent = cutoffMsg;
    list.appendChild(p);
  }
  if (!allowed.slot && !allowed.content && !allowed.cancel) {
    let msg;
    if (o.status === "canceled") {
      msg = "このご予約はキャンセル済みです。";
    } else if (o.status === "completed") {
      msg = "このご予約はお渡し済みです。ご利用ありがとうございました。";
    } else if (o.status === "in_production") {
      msg = "ご予約のケーキのご用意を進めております。ご変更・キャンセルをご希望の場合は、お手数ですがお店まで直接ご連絡ください。";
    } else if (cutoffMsg) {
      msg = cutoffMsg;
    } else if (o.review_state && o.review_state !== 'none') {
      msg = o.review_state === 'requested' ? 'お店が追加希望の対応内容と金額を確認しています。予約はまだ確定していません。' : '追加希望のあるご注文の内容・日時の変更は、お店へご連絡ください。';
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
async function quoteAction(name,args) {
  const buttons=[...$("action-list").querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try {const r=await rpc(name,args);if(!r.ok)throw new Error(r.message);kickMailWorker();await load();}
  catch(e){toast(e.message);buttons.forEach(b=>b.disabled=false);}
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
  const bounds = BookingWindow.bounds(t);
  const now = new Date(bounds.today + "T00:00:00");
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
      if (state.avail[o.pickup_date] === "full" || o.pickup_date > BookingWindow.bounds(t).end) state.avail[o.pickup_date] = "few";
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
  BookingWindow.update(state.data.tenant, m);
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
    $("done-emoji").classList.remove("hidden");
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
  if (o.payment?.paid_amount > 0)
    rows.push(`<p class="small">キャンセルすると、事前にお支払いいただいた ${yen(o.payment.paid_amount)} は、お支払いに使われたカードへ自動で全額返金されます（カード会社により、反映まで日数がかかる場合があります）。</p>`);
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
    $("done-emoji").classList.add("hidden"); // 絵文字（しおれたバラ）は出さない（2026-10-02 まりほ）
    $("done-title").textContent = "ご予約をキャンセルしました";
    $("done-text").textContent = (r.refund_amount > 0
      ? `事前にお支払いいただいた ${yen(r.refund_amount)} は、お支払いに使われたカードへ返金いたします（カード会社により、反映まで日数がかかる場合があります）。`
      : "") + "確認メールをお送りしますのでご確認ください。またのご利用をお待ちしております。";
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
  if (!TOKEN && PREPAY_RETURN_LOST) {
    // 支払いは済んでいる（はず）が、このタブでは予約を特定できない。エラーではなく案内として出す
    $("shop-name").textContent = "お支払いありがとうございます";
    $("error-message").textContent = "ご予約の内容は、確認メールのリンクからご確認ください。";
    show("view-error");
    return;
  }
  if (!TOKEN) {
    $("shop-name").textContent = "ご予約の管理";
    $("error-message").textContent = "URLが正しくありません。ご予約時の確認メールに記載のリンクからお開きください。";
    show("view-error");
    return;
  }
  try {
    const returned = await syncAfterPayment();
    const r = await rpc("fn_manage_get_order", { p_token: TOKEN });
    if (!r.ok) throw new Error(r.message || "ご予約が見つかりません");
    state.data = r;
    renderOrder();
    const q = new URLSearchParams(location.search);
    if (q.get("pay") === "1") {
      q.delete("pay");
      history.replaceState(null, "", `${location.pathname}?${q}`);
      if (r.order.payment?.can_prepay) { startPrepay(); return; }
    }
    if (returned) toast(r.order.payment?.paid_amount > 0 ? "お支払いを確認しました。ありがとうございます" : "お支払いの確認に少し時間がかかっています。しばらくしてから開き直してください");
  } catch (e) {
    $("shop-name").textContent = "ご予約の管理";
    $("error-message").textContent =
      e.message.includes("見つかりません") ? e.message
      : "読み込みに失敗しました。時間をおいて再度お試しください。";
    show("view-error");
  }
}
load();
// Squareの画面からブラウザの「戻る」で戻ってきたとき、前の表示のまま復元されることがある（iPhoneのSafari等）。
// 「お支払い画面を準備しています…」のまま止まらないよう、また支払いの状態を最新にするため読み直す。
window.addEventListener("pageshow", (e) => { if (e.persisted) load(); });
