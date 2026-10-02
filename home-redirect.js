// 旧リンク（https://cakebook.jp/?shop=pokke など）を予約ページへ転送する。
// CSP で inline script を禁止したため外部ファイルにした（2026-10-03）。描画前に転送したいので defer を付けずに <head> で読むこと。
if (new URLSearchParams(location.search).has("shop")) {
  location.replace("/reserve/" + location.search + location.hash);
}
