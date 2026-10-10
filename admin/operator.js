/* 運営者用の店舗一覧。読むだけ。運営者かどうかはサーバー（fn_operator_tenant_list）が確かめる。 */
(() => {
"use strict";
const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const state = {session: null, rows: []};
const say = text => { $("status").textContent = text; };

const PLAN = {standard: "Standard", lite: "Lite"};
const STATUS = {
  setup_trial: "お試し中", trialing: "お試し中（カード登録済み）", active: "有料契約中",
  past_due: "支払い遅れ", canceled: "解約", none: "未契約", exempt: "運営・無料",
};
const GROUP = {setup_trial: "trial", trialing: "trial", active: "paid", past_due: "stopped", canceled: "stopped", none: "stopped", exempt: "exempt"};
// カード不要のお試しは、期限が過ぎても状態は setup_trial のまま（設定を残して休止）。一覧では「止まっている」に数える
const trialOver = r => r.billing_status === "setup_trial" && r.trial_ends_at && new Date(r.trial_ends_at) <= Date.now();
const groupOf = r => trialOver(r) ? "stopped" : (GROUP[r.billing_status] || "stopped");
const statusLabel = r => trialOver(r) ? "お試し終了・未契約" : (STATUS[r.billing_status] || r.billing_status);

async function api(path, body, retry = true) {
  const res = await fetch(CONFIG.url + path, {
    method: "POST",
    headers: {apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session?.access_token || ""}`, "Content-Type": "application/json"},
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401 && retry && state.session?.refresh_token) {
    const refresh = await fetch(CONFIG.url + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: {apikey: CONFIG.anonKey, "Content-Type": "application/json"},
      body: JSON.stringify({refresh_token: state.session.refresh_token}),
    });
    if (refresh.ok) { state.session = await refresh.json(); localStorage.setItem("pokke_admin_session", JSON.stringify(state.session)); return api(path, body, false); }
  }
  if (res.status === 401) { $("workspace").hidden = true; $("login").hidden = false; throw Error("ログインし直してください"); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Error(data?.code === "42501" ? "この画面は運営者だけが見られます。" : `読み込めませんでした（${res.status}）。`);
  return data;
}

const day = 86400000;
function ymd(v) {
  if (!v) return "";
  return new Date(v).toLocaleDateString("ja-JP", {timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric"});
}
function ymdhm(v) {
  if (!v) return "";
  return new Date(v).toLocaleString("ja-JP", {timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"});
}
// 日本時間の日付どうしで比べる（24時間たっていなくても日付が変われば「1日前」）
const jstDay = v => Math.floor((new Date(v).getTime() + 9 * 3600000) / day);
function ago(v) {
  if (!v) return "まだ";
  const d = jstDay(Date.now()) - jstDay(v);
  return d <= 0 ? "今日" : `${d}日前`;
}
function trialCell(r) {
  if (!["setup_trial", "trialing"].includes(r.billing_status) || !r.trial_ends_at) return "—";
  const left = Math.ceil((new Date(r.trial_ends_at) - Date.now()) / day);
  const note = left > 0 ? `あと${left}日` : "期限切れ";
  return `${esc(ymdhm(r.trial_ends_at))}<br><span class="${left <= 3 ? "warn" : "muted"}">${note}</span>`;
}
function statusCell(r) {
  const g = groupOf(r);
  let extra = "";
  if (r.billing_status === "active" && r.first_paid_at) extra = `<br><span class="muted">${esc(ymd(r.first_paid_at))}から</span>`;
  if (r.billing_status === "canceled" && r.canceled_at) extra = `<br><span class="muted">${esc(ymd(r.canceled_at))}</span>`;
  return `<span class="badge ${g}">${esc(statusLabel(r))}</span>${extra}`;
}

function render() {
  const filter = $("filter").value, plan = $("plan").value, q = $("query").value.trim().toLowerCase();
  const rows = state.rows.filter(r =>
    (filter === "all" || groupOf(r) === filter) &&
    (!plan || r.reservation_plan === plan) &&
    (!q || `${r.name} ${r.subdomain}`.toLowerCase().includes(q)));
  $("count").textContent = `${rows.length}店を表示（全${state.rows.length}店）`;
  $("rows").innerHTML = rows.length ? rows.map(r => `<tr>
    <td data-label="店名"><div><strong>${esc(r.name)}</strong><br><a href="../?shop=${encodeURIComponent(r.subdomain)}" target="_blank" rel="noopener">/${esc(r.subdomain)}/</a>
      ${r.owner_email ? `<br><span class="muted">${esc(r.owner_email)}</span>` : ""}
      ${r.contact_email && r.contact_email !== r.owner_email ? `<br><span class="muted">連絡先 ${esc(r.contact_email)}</span>` : ""}</div></td>
    <td data-label="プラン"><div><span class="plan ${esc(r.reservation_plan)}">${esc(PLAN[r.reservation_plan] || r.reservation_plan)}</span></div></td>
    <td data-label="状態"><div>${statusCell(r)}</div></td>
    <td data-label="お試し期限"><div>${trialCell(r)}</div></td>
    <td data-label="登録日"><div>${esc(ymd(r.created_at))}</div></td>
    <td data-label="店主のログイン"><div>${esc(ago(r.owner_last_sign_in))}</div></td>
    <td data-label="商品（公開／全部）" class="num"><div>${r.products_published}／${r.products_total}</div></td>
    <td data-label="予約（今月受取／累計）" class="num"><div>${r.orders_this_month}／${r.orders_total}</div></td>
    <td data-label="最後の予約"><div>${r.last_order_at ? esc(ymd(r.last_order_at)) : "—"}</div></td>
  </tr>`).join("") : `<tr><td colspan="9" class="empty">条件に合う店はありません。</td></tr>`;
}

function renderSummary() {
  const count = (g, p) => state.rows.filter(r => groupOf(r) === g && (!p || r.reservation_plan === p)).length;
  const tiles = [
    ["お試し中", count("trial"), `Standard ${count("trial", "standard")}・Lite ${count("trial", "lite")}`],
    ["有料契約中", count("paid"), `Standard ${count("paid", "standard")}・Lite ${count("paid", "lite")}`],
    ["止まっている", count("stopped"), "お試し終了・解約・支払い遅れ"],
  ];
  $("summary").innerHTML = tiles.map(([label, n, sub]) =>
    `<div class="tile"><span class="label">${label}</span><strong>${n}</strong><span class="sub">${sub}</span></div>`).join("");
}

async function load() {
  say("読み込み中…");
  try {
    state.rows = await api("/rest/v1/rpc/fn_operator_tenant_list") || [];
    renderSummary(); render();
    $("workspace").hidden = false; $("reload").hidden = false;
    say(`${new Date().toLocaleTimeString("ja-JP")} 時点`);
  } catch (e) { say(e.message); }
}

for (const id of ["filter", "plan"]) $(id).addEventListener("change", render);
$("query").addEventListener("input", render);
$("reload").addEventListener("click", load);
try { state.session = JSON.parse(localStorage.getItem("pokke_admin_session")); } catch {}
if (!state.session) { $("login").hidden = false; say(""); } else load();
})();
