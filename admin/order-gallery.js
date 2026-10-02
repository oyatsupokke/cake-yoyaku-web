/* 予約の画像（デザインイメージ・お客様の添付画像）をその場で大きく見る（2026-10-02）
 * 別タブを開かず、画面の上に重ねて表示する。複数枚は ‹ › ・左右スワイプ・矢印キーで切り替え、
 * × ・背景・Esc で閉じる。openOrderGallery([{url, caption, design}], 何枚目から) で開く。
 * design: true はデザインイメージ（予約画面のプレビューと同じ台の色・影で見せる）。 */
(() => {
  let box = null, items = [], index = 0, lastFocus = null;

  function build() {
    box = document.createElement("div");
    box.className = "lightbox hidden";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "画像を大きく表示");
    box.innerHTML = `
      <button type="button" class="lb-close" aria-label="閉じる">×</button>
      <button type="button" class="lb-prev" aria-label="前の画像">‹</button>
      <figure class="lb-figure"><div class="lb-stage"><img alt=""></div><figcaption></figcaption></figure>
      <button type="button" class="lb-next" aria-label="次の画像">›</button>
      <div class="lb-foot"><span class="lb-count"></span><a class="lb-open" target="_blank" rel="noopener">別のタブで開く</a></div>`;
    document.body.appendChild(box);
    box.querySelector(".lb-close").onclick = close;
    box.querySelector(".lb-prev").onclick = () => show(index - 1);
    box.querySelector(".lb-next").onclick = () => show(index + 1);
    // 画像・ボタン以外（暗い背景）を押したら閉じる
    box.addEventListener("click", (e) => { if (e.target === box || e.target.classList.contains("lb-figure")) close(); });
    let startX = null;
    box.addEventListener("touchstart", (e) => { startX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    box.addEventListener("touchend", (e) => {
      if (startX == null) return;
      const dx = e.changedTouches[0].clientX - startX;
      startX = null;
      if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
    });
    document.addEventListener("keydown", (e) => {
      if (box.classList.contains("hidden")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") show(index - 1);
      else if (e.key === "ArrowRight") show(index + 1);
    });
  }

  function show(i) {
    if (!items.length) return;
    index = (i + items.length) % items.length;
    const it = items[index];
    const img = box.querySelector("img");
    img.src = it.url;
    box.querySelector(".lb-stage").classList.toggle("design-img", !!it.design);
    img.alt = it.caption || "予約の画像";
    box.querySelector("figcaption").textContent = it.caption || "";
    box.querySelector(".lb-open").href = it.url;
    const many = items.length > 1;
    box.querySelector(".lb-count").textContent = many ? `${index + 1} / ${items.length}` : "";
    box.querySelector(".lb-prev").classList.toggle("hidden", !many);
    box.querySelector(".lb-next").classList.toggle("hidden", !many);
  }

  function close() {
    box.classList.add("hidden");
    document.documentElement.classList.remove("lightbox-open");
    box.querySelector("img").removeAttribute("src");
    lastFocus?.focus?.();
  }

  window.openOrderGallery = (list, start = 0) => {
    items = (list || []).filter((x) => x && x.url);
    if (!items.length) return;
    if (!box) build();
    lastFocus = document.activeElement;
    box.classList.remove("hidden");
    document.documentElement.classList.add("lightbox-open");
    show(start);
    box.querySelector(".lb-close").focus();
  };
})();
