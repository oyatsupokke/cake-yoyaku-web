// 旧リンク（?shop=pokke など）を、店の公開URL（/oyatsupokke/ など）へ転送する。
// CSP で inline script を禁止したため、scripts/build_reserve_page.mjs が <head> から読み込む外部ファイルにした（2026-10-03）。
// 描画前に転送したいので defer/async を付けずに読み込むこと。
(function () {
  const bookingParams = new URLSearchParams(location.search);
  if (bookingParams.has("shop") && !["preview", "staff", "trial", "edit"].some(key => bookingParams.has(key))) {
    const internalShop = bookingParams.get("shop") || "";
    const slug = internalShop === "pokke" ? "oyatsupokke" : internalShop;
    if (/^[a-z0-9][a-z0-9-]{0,48}$/.test(slug)) {
      bookingParams.delete("shop");
      // URLSearchParams.size は古い Safari（17未満）に無く undefined＝残すべきパラメータが消えていた（2026-10-03 点検指摘）
      const rest = bookingParams.toString();
      location.replace("/" + slug + "/" + (rest ? "?" + rest : "") + location.hash);
    }
  }
})();
