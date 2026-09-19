/* DB・入力由来の文字をHTMLに埋め込む際の共通処理。 */
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

function safeImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, location.href);
    if (["https:", "http:"].includes(url.protocol)
      || (url.protocol === "blob:" && url.origin === location.origin)) return url.href;
  } catch {}
  return "";
}

/* パステルカラー回答だけ、安全なHEXを小さな色見本として添える。 */
function answerValueHtml(value) {
  const text = String(value ?? "");
  const match = /^(#[0-9A-Fa-f]{6})(／連動：同色)?(?:／補足：([^\n]{1,200}))?$/.exec(text);
  if (!match) return esc(text);
  const shown=match[1]+(match[2]?'／連動する装飾も同色':'')+(match[3]?`／補足：${match[3]}`:'');
  return `<i class="answer-swatch" style="background:${match[1]}" aria-hidden="true"></i>${esc(shown)}`;
}
