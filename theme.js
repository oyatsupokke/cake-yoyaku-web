/* =====================================================================
 * お店ごとの見た目（予約フォーム・お客様の管理ページで共通）
 *
 * tenants.theme = { preset: "classic" | "soft" | "modern", color: "#7c5a3c" }
 *
 * お店に選ばせるのは「雰囲気の型」と「色1つ」だけ。
 * 色は1つの基準色から、面の色（--primary）・下地（--tint）まで自動で作る。
 * 以前は --primary（淡い色）だけを上書きしていたため、お店が青を設定しても
 * ボタン・価格・選択状態が使う --primary-deep はピンクのまま残っていた。
 * ===================================================================== */

const THEME_PRESETS = ["classic", "soft", "modern"];
const THEME_DEFAULT = { preset: "classic", color: "#a76b76" };

function hexToHsl(hex) {
  const m = String(hex || "").trim().replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  if (!/^[0-9a-fA-F]{6}$/.test(n)) return null;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

/* お店が明るい色を選んでも、白文字のボタンが読めなくなることがないよう明度を抑える */
function applyShopTheme(theme) {
  const t = theme || {};
  const preset = THEME_PRESETS.includes(t.preset) ? t.preset : THEME_DEFAULT.preset;
  document.documentElement.classList.add("t-" + preset);

  const hsl = hexToHsl(t.color || t.primary || THEME_DEFAULT.color);
  if (!hsl) return;
  const [h, s, l] = hsl;
  const css = (ss, ll) => `hsl(${h.toFixed(0)} ${(ss * 100).toFixed(0)}% ${(ll * 100).toFixed(0)}%)`;
  const set = (k, v) => document.documentElement.style.setProperty(k, v);
  set("--primary-deep", css(Math.max(s, 0.18), Math.min(l, 0.5)));  // ボタン・選択状態・価格
  set("--primary", css(Math.min(s, 0.55), 0.84));                   // 淡い面
  set("--tint", css(Math.min(s, 0.5), 0.968));                      // 選択中の下地・ホバー
}
