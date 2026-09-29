/* =====================================================================
 * 画像のトリミング（2026-09-30）
 * 管理画面の写真（商品写真・見本・ロゴ・メニュー表）と、お客様が貼る参考画像で共用する。
 *
 *   const file = await ImageCrop.open(file, {
 *     aspectRatio: 4 / 3,   // 省略＝自由な形
 *     squareGuide: true,    // 4:3 の枠の中に「プレビューで見える正方形」を点線で重ねる（商品写真）
 *     keepPng: true,        // 透過を残す（ロゴ）
 *     allowOriginal: true,  // 「切らずにそのまま使う」を出す（管理画面）
 *     maxSide: 1000,        // 切った後の長い辺の上限（省略時2400）
 *   });
 *   → 切った画像の File／そのまま使うなら元の File／やめたら null
 *
 * 部品は Cropper.js（cdnjs）。使うときに初めて読み込むので、ページの表示は重くならない。
 * 読み込めなかったとき（電波・ブロック）は、切らずに元の画像で続けられるようにする。
 * 重ねるイラスト（透過PNGのレイヤー）には使わない＝切ると他の素材と位置がずれる。
 * ===================================================================== */
(function () {
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/";
  const JS_SRI = "sha384-jrOgQzBlDeUNdmQn3rUt/PZD+pdcRBdWd/HWRqRo+n2OR2QtGyjSaJC0GiCeH+ir";
  const CSS_SRI = "sha384-6LFfkTKLRlzFtgx8xsWyBdKGpcMMQTkv+dB7rAbugeJAu1Ym2q1Aji1cjHBG12Xh";
  const MAX_SIDE = 2400; // 切った後の長い辺の上限（保存時は各画面の縮小処理がさらに小さくする）

  let loading = null;
  function loadCropper() {
    if (window.Cropper) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = CDN + "cropper.min.css";
      css.integrity = CSS_SRI; css.crossOrigin = "anonymous";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = CDN + "cropper.min.js"; js.integrity = JS_SRI; js.crossOrigin = "anonymous";
      js.onload = () => resolve();
      js.onerror = () => { loading = null; reject(new Error("トリミングの部品を読み込めませんでした")); };
      document.head.appendChild(js);
    });
    return loading;
  }

  const STYLE = `
.imgcrop-back{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:12px}
.imgcrop{background:#fff;color:#2b2522;border-radius:14px;width:min(640px,100%);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;overflow:hidden;font-size:15px}
.imgcrop h2{font-size:16px;margin:0;padding:14px 16px 4px}
.imgcrop .imgcrop-help{margin:0;padding:0 16px 10px;font-size:13px;color:#6f6560;line-height:1.6}
.imgcrop .imgcrop-stage{position:relative;background:#222;height:min(56dvh,440px);min-height:220px}
.imgcrop .imgcrop-stage img{display:block;max-width:100%}
.imgcrop .imgcrop-tools{display:flex;gap:8px;justify-content:center;padding:10px 12px 0;flex-wrap:wrap}
.imgcrop .imgcrop-actions{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px 16px;flex-wrap:wrap}
.imgcrop button{font:inherit;font-size:15px;min-height:44px;padding:8px 14px;border-radius:10px;border:1px solid #cfc6c2;background:#fff;color:#2b2522;cursor:pointer}
.imgcrop button.primary{background:#2b2522;border-color:#2b2522;color:#fff;font-weight:bold}
.imgcrop button:disabled{opacity:.5;cursor:default}
.imgcrop .imgcrop-actions .spacer{flex:1}
.cropper-crop-box .imgcrop-square{position:absolute;top:0;bottom:0;left:12.5%;right:12.5%;border:2px dashed rgba(255,255,255,.95);box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none}
.cropper-crop-box .imgcrop-square span{position:absolute;left:50%;bottom:4px;transform:translateX(-50%);font-size:11px;white-space:nowrap;color:#fff;background:rgba(0,0,0,.55);padding:1px 6px;border-radius:6px}
@media (max-width:480px){.imgcrop .imgcrop-actions button{flex:1 1 auto}.imgcrop .imgcrop-actions .spacer{display:none}}
`;
  function ensureStyle() {
    if (document.getElementById("imgcrop-style")) return;
    const s = document.createElement("style");
    s.id = "imgcrop-style"; s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function toFile(canvas, type, name) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("画像を切り取れませんでした")); return; }
        const base = String(name || "image").replace(/\.[^.]+$/, "");
        resolve(new File([blob], `${base}.${type === "image/png" ? "png" : "jpg"}`, { type }));
      }, type, 0.92);
    });
  }

  async function open(file, opts = {}) {
    if (!(file instanceof Blob)) return null;
    try { await loadCropper(); }
    catch (e) {
      // 部品が無くても予約や登録は止めない。切らずに元の画像で続ける
      return opts.allowOriginal === false ? null : file;
    }
    ensureStyle();
    const url = URL.createObjectURL(file);
    const back = document.createElement("div");
    back.className = "imgcrop-back";
    back.innerHTML = `
      <div class="imgcrop" role="dialog" aria-modal="true" aria-labelledby="imgcrop-title">
        <h2 id="imgcrop-title">${opts.title || "使う範囲を決める"}</h2>
        <p class="imgcrop-help">写真を動かしたり、枠の角を引っぱったりして、使う範囲を合わせてください。${
          opts.squareGuide ? "<br>点線の内側は、ケーキを選んだあとの見本に出る範囲です。" : ""}</p>
        <div class="imgcrop-stage"><img alt=""></div>
        <div class="imgcrop-tools">
          <button type="button" data-act="out" aria-label="小さく">－ 小さく</button>
          <button type="button" data-act="in" aria-label="大きく">＋ 大きく</button>
          <button type="button" data-act="rotate">↻ 回す</button>
          <button type="button" data-act="reset">元に戻す</button>
        </div>
        <div class="imgcrop-actions">
          <button type="button" data-act="cancel">やめる</button>
          <span class="spacer"></span>
          ${opts.allowOriginal ? `<button type="button" data-act="original">切らずにそのまま使う</button>` : ""}
          <button type="button" class="primary" data-act="ok">この範囲にする</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const img = back.querySelector("img");

    return new Promise((resolve) => {
      let cropper = null;
      const finish = (result) => {
        try { cropper?.destroy(); } catch { /* 片付けの失敗は無視 */ }
        URL.revokeObjectURL(url);
        back.remove();
        document.body.style.overflow = prevOverflow;
        document.removeEventListener("keydown", onKey);
        resolve(result);
      };
      const onKey = (e) => { if (e.key === "Escape") finish(null); };
      document.addEventListener("keydown", onKey);

      img.onerror = () => {
        // iPhone以外で開けない形式（HEIC等）。切らずに元の画像で続ける
        finish(opts.allowOriginal === false ? null : file);
      };
      img.onload = () => {
        cropper = new window.Cropper(img, {
          viewMode: 1, dragMode: "move", autoCropArea: 1,
          aspectRatio: opts.aspectRatio || NaN,
          background: false, responsive: true, restore: false,
          toggleDragModeOnDblclick: false,
          ready() {
            if (opts.squareGuide) {
              const box = back.querySelector(".cropper-crop-box");
              const sq = document.createElement("div");
              sq.className = "imgcrop-square";
              sq.innerHTML = "<span>見本に出る範囲</span>";
              box?.appendChild(sq);
            }
          },
        });
      };
      img.src = url;

      back.addEventListener("click", async (e) => {
        const act = e.target.closest("button")?.dataset.act;
        if (!act) return;
        if (act === "cancel") return finish(null);
        if (act === "original") return finish(file);
        if (!cropper) return;
        if (act === "in") cropper.zoom(0.1);
        if (act === "out") cropper.zoom(-0.1);
        if (act === "rotate") cropper.rotate(90);
        if (act === "reset") cropper.reset();
        if (act === "ok") {
          const btn = e.target.closest("button");
          btn.disabled = true; btn.textContent = "切り取り中…";
          try {
            const png = opts.keepPng && file.type === "image/png";
            const canvas = cropper.getCroppedCanvas({
              maxWidth: opts.maxSide || MAX_SIDE, maxHeight: opts.maxSide || MAX_SIDE,
              fillColor: png ? "transparent" : "#fff",
              imageSmoothingQuality: "high",
            });
            finish(await toFile(canvas, png ? "image/png" : "image/jpeg", file.name));
          } catch {
            btn.disabled = false; btn.textContent = "この範囲にする";
          }
        }
      });
    });
  }

  window.ImageCrop = { open, preload: () => loadCropper().catch(() => {}) };
})();
