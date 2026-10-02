// LP の動き（motion.css・motion.js）の安全装置。動きを減らす設定の端末・古いブラウザでは何もしない。
// motion.js が読めなかったとき（通信失敗など）に中身が隠れたままにならないよう、3秒で動きの指定を外す。
// CSP で inline script を禁止したため外部ファイルにした（2026-10-03）。描画前に効かせたいので defer を付けずに <head> で読むこと。
(function () {
  var d = document.documentElement;
  if (!window.matchMedia || matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  d.classList.add("cb-motion");
  setTimeout(function () { if (!window.__cbMotion) d.classList.remove("cb-motion"); }, 3000);
})();
