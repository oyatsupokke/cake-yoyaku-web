// パスワード再設定（web/admin/reset.html）。CSP で inline script を禁止したため外部ファイルにした（2026-10-03）。
// メールのリンクから来ると URL の #hash に一時トークン（type=recovery）が付いている
const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
};
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("access_token");
history.replaceState(null, "", location.pathname + location.search);
if (!token || params.get("type") !== "recovery") {
  $("reset-form").classList.add("hidden");
  $("reset-invalid").classList.remove("hidden");
}
$("btn-reset").onclick = async () => {
  const p1 = $("new-password").value, p2 = $("new-password2").value;
  const err = $("reset-error");
  err.classList.add("hidden");
  if (p1.length < 8) { err.textContent = "8文字以上にしてください"; err.classList.remove("hidden"); return; }
  if (p1 !== p2) { err.textContent = "2つのパスワードが一致しません"; err.classList.remove("hidden"); return; }
  const button = $("btn-reset");
  if (button.disabled || !token || params.get("type") !== "recovery") return;
  button.disabled = true;
  try {
  const res = await fetch(`${CONFIG.url}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password: p1 }),
  });
  if (res.ok) {
    $("reset-form").classList.add("hidden");
    $("reset-done").classList.remove("hidden");
  } else {
    const b = await res.json().catch(() => ({}));
    err.textContent = b.msg || b.error_description || "設定に失敗しました。リンクの期限切れの可能性があります";
    err.classList.remove("hidden");
  }
  } catch {
    err.textContent = "通信できませんでした。接続を確認してもう一度お試しください";
    err.classList.remove("hidden");
  } finally { button.disabled = false; }
};
