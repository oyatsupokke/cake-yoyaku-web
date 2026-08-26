/* =====================================================================
 * 「？」ヘルプ（設定・商品ページ共通）
 * HTML側の <button class="tip" data-tip="説明文">？</button> をタップすると
 * すぐ下に説明が開く。もう一度タップ、または他の場所をタップで閉じる。
 * スマホにはマウスホバーが無いため、タップ式にしている（まりほ要望 2026-08-26）。
 * 説明文はマニュアル（manual/）と同じ言い回しに揃えること。
 * ===================================================================== */
document.addEventListener("click", (e) => {
  const tip = e.target.closest(".tip");
  const wasOpen = tip && tip.nextElementSibling?.classList.contains("tip-pop");
  document.querySelectorAll(".tip-pop").forEach((p) => p.remove());
  if (!tip || wasOpen) return;
  const pop = document.createElement("div");
  pop.className = "tip-pop";
  pop.textContent = tip.dataset.tip || "";
  tip.insertAdjacentElement("afterend", pop);
});
