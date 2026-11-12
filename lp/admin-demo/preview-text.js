/* 記入欄の答えをデザインイメージに文字で出す（common_questions.preview_text）の描き方。
 * 予約ページ（app.js）と管理画面の小さな見本（admin/products.js）で同じものを使う（2026-11-12）。
 *   preview_text = { x, y, width（絵の幅に対する%）, size: l|m|s, font, color, color_question_id,
 *                    font_question_id, font_map: {回答の選択肢id: font} }
 *   x・y が無い古い設定は position（top|center|bottom）から位置を決める。
 * 字体は Google Fonts から使う字体・使う文字の分だけ読む（CSP の style-src・font-src は許可済み）。 */
(function () {
  const CANVAS = 960;
  // [キー, 管理画面での名前, CSSの字体, 太さ, Google Fonts の family 指定]
  const FONTS = [
    ["maru", "丸ゴシック", '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif', 500, "Zen+Maru+Gothic:wght@500"],
    ["gothic", "ゴシック", '"Zen Kaku Gothic New", "Hiragino Sans", sans-serif', 500, "Zen+Kaku+Gothic+New:wght@500"],
    ["mincho", "明朝", '"Shippori Mincho", "Hiragino Mincho ProN", serif', 500, "Shippori+Mincho:wght@500"],
    ["tegaki", "手書き風", '"Klee One", "Zen Maru Gothic", sans-serif', 600, "Klee+One:wght@600"],
    ["magic", "マジックで書いた風", '"Yusei Magic", "Zen Maru Gothic", sans-serif', 400, "Yusei+Magic"],
    ["pop", "ポップ", '"Hachi Maru Pop", "Zen Maru Gothic", sans-serif', 400, "Hachi+Maru+Pop"],
    // 筆記体は英字だけ。日本語は字形が無いので丸ゴシックで出る
    ["script", "筆記体（英字だけ）", '"Dancing Script", "Zen Maru Gothic", sans-serif', 600, "Dancing+Script:wght@600"],
    ["script_thin", "細い筆記体（英字だけ）", '"Great Vibes", "Zen Maru Gothic", sans-serif', 400, "Great+Vibes"],
  ];
  const byKey = Object.fromEntries(FONTS.map(([key, label, css, weight, google]) => [key, { key, label, css, weight, google }]));
  const SIZE = { l: 72, m: 56, s: 42 };
  const POSITION_Y = { top: 34.4, center: 50, bottom: 65.6 };
  const DEFAULT_COLOR = "#49352F";
  const clamp = (v, lo, hi, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };
  const font = (key) => byKey[key] || byKey.maru;

  /** 設定と答えから、描く1行分の内容を作る。text・color・font は呼ぶ側で決めて渡す */
  function item(cfg, text, color, fontKey) {
    return {
      text, color: /^#[0-9A-Fa-f]{6}$/.test(color || "") ? color : DEFAULT_COLOR,
      font: font(fontKey || cfg.font).key,
      x: clamp(cfg.x, 0, 100, 50),
      y: clamp(cfg.y, 0, 100, POSITION_Y[cfg.position] ?? 50),
      width: clamp(cfg.width, 15, 95, 50),
      size: SIZE[cfg.size] ?? SIZE.m,
    };
  }

  const linkPromises = {};
  function loadCss(f) {
    if (!f.google) return Promise.resolve();
    return linkPromises[f.key] ||= new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
      link.onload = link.onerror = resolve;
      document.head.appendChild(link);
    });
  }
  /** 描く前に字体を読み込む。日本語の字体は使う文字の分だけ読まれるので、文字を渡して待つ
   * （待たないと、予約時に保存する画像が既定の字体になる） */
  async function load(items) {
    if (!document.fonts?.load) return;
    await Promise.all(items.map(async (it) => {
      const f = font(it.font);
      await loadCss(f);
      // 筆記体の日本語は丸ゴシックで出るので、丸ゴシックも読む
      if (f.key.startsWith("script")) await loadCss(byKey.maru);
      await document.fonts.load(`${f.weight} ${it.size}px ${f.css}`, it.text).catch(() => []);
    }));
  }

  // 空白のある文は語ごと、無い文（日本語）は1文字ごとに折り返す（予約ページの messageLines と同じ考え方）
  function wrap(ctx, text, maxWidth, maxLines) {
    const out = [];
    for (const paragraph of String(text || "").split(/\r?\n/)) {
      const clean = paragraph.replace(/[\t ]+/g, " ").trim();
      if (!clean) continue;
      const words = clean.split(" "), units = words.length > 1 ? words : [...clean], joiner = words.length > 1 ? " " : "";
      let line = "";
      for (const unit of units) {
        const next = line ? line + joiner + unit : unit;
        if (line && ctx.measureText(next).width > maxWidth) { out.push(line); line = unit; } else line = next;
      }
      if (line) out.push(line);
    }
    return out.slice(0, maxLines);
  }

  /** 960px角の絵に描く（ctx は 960 基準の座標のまま）。入りきらない文は小さくして収める */
  function draw(ctx, it) {
    const f = font(it.font);
    const maxWidth = CANVAS * it.width / 100, maxHeight = it.size * 3.2;
    let size = it.size, rows = [], lineHeight = size * 1.25;
    ctx.save();
    ctx.fillStyle = it.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (; size >= 18; size -= 2) {
      ctx.font = `${f.weight} ${size}px ${f.css}`;
      rows = wrap(ctx, it.text, maxWidth, 4);
      lineHeight = size * 1.25;
      if (rows.length * lineHeight <= maxHeight && rows.every((l) => ctx.measureText(l).width <= maxWidth)) break;
    }
    const cx = CANVAS * it.x / 100, cy = CANVAS * it.y / 100;
    const firstY = cy - (rows.length - 1) * lineHeight / 2;
    rows.forEach((row, i) => ctx.fillText(row, cx, firstY + i * lineHeight, maxWidth));
    ctx.restore();
  }

  window.PreviewText = { CANVAS, FONTS: FONTS.map(([key, label]) => ({ key, label })), DEFAULT_COLOR, item, load, draw };
})();
