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
