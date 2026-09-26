/* =====================================================================
 * 「？」ヘルプ（設定・商品ページ共通）
 * HTML側の <button class="tip" data-tip="説明文">？</button> をタップすると
 * すぐ下に説明が開く。もう一度タップ、または他の場所をタップで閉じる。
 * スマホにはマウスホバーが無いため、タップ式にしている（まりほ要望 2026-08-26）。
 * 説明文はマニュアル（manual/）と同じ言い回しに揃えること。
 * ===================================================================== */
let openedTip = null;
let tipSequence = 0;
function prepareTips(root = document) {
  for (const tip of root.querySelectorAll('.tip:not([aria-expanded])')) {
    tip.setAttribute('aria-expanded', 'false');
    if (!tip.hasAttribute('aria-label')) tip.setAttribute('aria-label', '説明を開閉する');
  }
}
prepareTips();
new MutationObserver(() => prepareTips()).observe(document.body, {childList:true, subtree:true});
function closeTip() {
  document.querySelectorAll(".tip-pop").forEach((p) => p.remove());
  if (openedTip) {
    openedTip.setAttribute("aria-expanded", "false");
    openedTip.removeAttribute("aria-controls");
  }
  openedTip = null;
}
document.addEventListener("click", (e) => {
  if (e.target.closest(".tip-pop")) return;
  const tip = e.target.closest(".tip");
  const wasOpen = tip === openedTip;
  closeTip();
  if (!tip || wasOpen) return;
  const pop = document.createElement("div");
  pop.className = "tip-pop";
  pop.id = `setting-help-${++tipSequence}`;
  pop.textContent = tip.dataset.tip || "";
  tip.setAttribute("aria-expanded", "true");
  tip.setAttribute("aria-controls", pop.id);
  tip.setAttribute("aria-label", "説明を開閉する");
  tip.insertAdjacentElement("afterend", pop);
  openedTip = tip;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openedTip) {
    const tip = openedTip;
    closeTip();
    tip.focus();
  }
});
