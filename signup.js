/* =====================================================================
 * 新規登録（SaaSセルフサーブ）
 * 流れ：①アカウント作成（Supabase Auth）→ ②fn_signup_tenantで店舗作成
 *       → ③カード不要の7日間お試し（setup_trial・一般公開なし）
 * 有料契約は管理画面から別途申込。決済完了で本受注開始。
 * メール確認がONのプロジェクトでは、確認リンクで本ページに戻ってから②③を続行
 * （入力内容は localStorage に退避しておく）
 * ===================================================================== */

const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
};

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "pokke_admin_session"; // 管理画面と共有（登録後そのままログイン状態に）
const PENDING_KEY = "cyb_signup_pending";

let session = null;
let registrationAuthenticated = false;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { /* noop */ }

/* ---------- 表示切り替え ---------- */
function show(step) {
  ["account", "verify", "billing", "done"].forEach((s) =>
    $(`view-${s}`).classList.toggle("hidden", s !== step));
  const barStep = step === "verify" ? "account" : step;
  document.querySelectorAll("#steps-bar li").forEach((li) =>
    li.classList.toggle("current", li.dataset.step === barStep));
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove("hidden");
}

/* ---------- API ---------- */
async function authFetch(path, body, query = "") {
  const res = await fetch(`${CONFIG.url}/auth/v1/${path}${query}`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = json.error_description || json.msg || json.message || "";
    if (/already registered/i.test(raw)) throw new Error("このメールアドレスは登録済みです。下の「ログイン」からお入りください");
    if (/at least 6|password/i.test(raw)) throw new Error("パスワードが短すぎます");
    throw new Error(raw || "登録に失敗しました");
  }
  return json;
}

async function rpcSignupTenant(info) {
  const res = await fetch(`${CONFIG.url}/rest/v1/rpc/fn_signup_tenant`, {
    method: "POST",
    headers: {
      apikey: CONFIG.anonKey,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_name: info.name, p_subdomain: info.subdomain,
      p_address: info.address, p_phone: info.phone || null,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || "店舗の作成に失敗しました");
  return json;
}

async function gotoCheckout() {
  const res = await fetch(`${CONFIG.url}/functions/v1/create-checkout-session`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${session.access_token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 409) { // 既に契約中 → 完了扱い
    location.href = "signup.html?step=done";
    return;
  }
  if (!res.ok || !json.url) throw new Error(json.error || "お支払いページに進めませんでした");
  location.href = json.url;
}

/* ---------- 店舗ID空きチェック（入力が止まって400ms後） ---------- */
const SUB_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
let subTimer = null;
async function checkSubdomain() {
  const v = $("s-subdomain").value.trim().toLowerCase();
  $("subdomain-echo").textContent = v || "○○○";
  const st = $("subdomain-status");
  if (!v) { st.classList.add("hidden"); return; }
  if (!SUB_RE.test(v) || v.includes("--")) {
    st.className = "small subdomain-ng";
    st.textContent = "✗ 英小文字・数字・ハイフンで3〜30文字（先頭末尾は英数字）";
    return;
  }
  const res = await fetch(`${CONFIG.url}/rest/v1/rpc/fn_subdomain_available`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ p_sub: v }),
  });
  const ok = await res.json().catch(() => false);
  st.className = "small " + (ok === true ? "subdomain-ok" : "subdomain-ng");
  st.textContent = ok === true ? "✓ この店舗IDは使えます" : "✗ この店舗IDは使えません（使用済みか予約語です）";
}

/* ---------- 登録本体 ---------- */
function collectForm() {
  return {
    name: $("s-name").value.trim(),
    subdomain: $("s-subdomain").value.trim().toLowerCase(),
    address: $("s-address").value.trim(),
    phone: $("s-phone").value.trim(),
  };
}

function validate(info) {
  if (!info.name) return "店名を入力してください";
  if (!SUB_RE.test(info.subdomain) || info.subdomain.includes("--")) return "店舗IDの形式を確認してください";
  if (!info.address) return "住所を入力してください";
  if (!registrationAuthenticated && !$("s-email").value.trim()) return "メールアドレスを入力してください";
  if (!registrationAuthenticated && $("s-password").value.length < 8) return "パスワードは8文字以上にしてください";
  if (!$("s-agree").checked) return "利用規約・プライバシーポリシーへの同意が必要です";
  return null;
}

async function onSignup() {
  const info = collectForm();
  const err = validate(info);
  if (err) { showError("signup-error", err); return; }
  $("signup-error").classList.add("hidden");
  $("btn-signup").disabled = true;
  try {
    if (registrationAuthenticated) {
      await rpcSignupTenant(info); localStorage.removeItem(PENDING_KEY); location.href = "admin/"; return;
    }
    const redirect = encodeURIComponent(location.origin + location.pathname);
    const body = await authFetch("signup", {
      email: $("s-email").value.trim(),
      password: $("s-password").value,
      data: { registration: info },
    }, `?redirect_to=${redirect}`);

    if (body.access_token) {
      // メール確認OFF：そのまま続行
      registrationAuthenticated = true;
      session = body;
      localStorage.setItem(SESSION_KEY, JSON.stringify(body));
      await rpcSignupTenant(info);
      location.href = "admin/";
    } else {
      // メール確認ON：入力内容を退避して確認待ち画面
      localStorage.setItem(PENDING_KEY, JSON.stringify(info));
      show("verify");
    }
  } catch (e) {
    showError("signup-error", e.message);
    $("btn-signup").disabled = false;
  }
}

/* ---------- メール確認から戻ってきたとき（URLハッシュにトークン） ---------- */
async function resumeFromEmailConfirm() {
  const params = new URLSearchParams(location.hash.slice(1));
  const at = params.get("access_token");
  if (!at) return false;
  session = {
    access_token: at,
    refresh_token: params.get("refresh_token"),
    token_type: params.get("token_type") || "bearer",
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  history.replaceState(null, "", location.pathname); // トークンをURLから消す
  let pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
  if (!pending) {
    const r = await fetch(`${CONFIG.url}/auth/v1/user`, { headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${at}` } });
    if (r.ok) pending = (await r.json()).user_metadata?.registration;
  }
  if (!pending) { location.href = "admin/"; return true; }
  try {
    await rpcSignupTenant(pending);
    localStorage.removeItem(PENDING_KEY);
    location.href = "admin/";
  } catch (e) {
    registrationAuthenticated = true;
    for (const field of ["name", "subdomain", "address", "phone"]) $("s-" + field).value = pending[field] || "";
    $("s-email").closest(".confirm-box").classList.add("hidden");
    $("s-agree").checked = true;
    show("account");
    showError("signup-error", e.message + "。内容を確認して、もう一度お試しください。");
  }
  return true;
}

/* ---------- 初期化 ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  $("btn-signup").addEventListener("click", onSignup);
  $("btn-checkout").addEventListener("click", async () => {
    if (!session?.access_token) {
      showError("billing-error", "ログインが切れています。管理画面からログイン後、もう一度お試しください");
      return;
    }
    $("btn-checkout").disabled = true;
    try { await gotoCheckout(); }
    catch (e) { showError("billing-error", e.message); $("btn-checkout").disabled = false; }
  });
  $("s-subdomain").addEventListener("input", () => {
    clearTimeout(subTimer);
    subTimer = setTimeout(checkSubdomain, 400);
  });

  if (await resumeFromEmailConfirm()) return;
  const step = new URLSearchParams(location.search).get("step");
  if (step === "done") show("done");
  else if (step === "billing") show("billing");
  else show("account");
});
