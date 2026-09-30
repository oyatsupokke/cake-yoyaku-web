/* =====================================================================
 * 商品エディタ v1
 * - 基本情報 / 季節設定（販売期間・受取期間・受取曜日）/ サイズと価格
 * - 選択グループ＆選択肢（追加料金・個数上限・記入欄・注意書き・排他ペア）
 * すべてスタッフJWT + RLS 経由（自店のデータしか読めない・書けない）
 * ===================================================================== */

const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
};
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[ch]);
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const state = {
  session: null, tenantId: null, tenantSubdomain: null, products: [], questions: [], globalGroups: [],
  categories: [],
  closedDates: new Set(),
  current: null, fields: [],
  // 選択肢の「詳しい設定」を開いているもの。普段はたたんでおく（画面が縦に延々と続かないように）
  openOptions: new Set(),
  openSizeLayers: new Set(), // 「サイズ別のイラスト」を開いている欄（再描画しても開いたまま）
};

/* ---------- 入力欄をスクロールから守る（2026-09-06） ----------
 * ブラウザの仕様で、数値・日時の入力欄はフォーカスされているとホイールで値が変わる。
 * 空の datetime-local はそれだけで「いまの日時」が入る。
 * 実際に本番で「受付開始」に身に覚えのない日時（保存の86秒前・秒は00）が入っていた。
 * 価格や台数でも同じ事故が起きるので、ホイールが来たらフォーカスを外して値を守る。 */
const SPINNABLE = /^(number|date|datetime-local|time|month|week)$/;
document.addEventListener("wheel", (e) => {
  const el = document.activeElement;
  if (!el || el !== e.target || !SPINNABLE.test(el.type)) return;
  e.preventDefault();   // 値を動かさない（passiveだと止められないので、この監視は非passive）
  el.blur();
  // 日付欄はblurしても中の桁にフォーカスが残る（Chrome）。
  // そのままだとページが動かず固まって見えるので、代わりに自分でスクロールする
  if (document.activeElement === el) window.scrollBy(0, e.deltaY);
}, { passive: false });

/* ---------- 保存の仕組み ----------
 * 入力欄を「どのテーブルのどの項目か」と一緒に登録しておき、
 * 画面下の保存バー1つでまとめて保存する（変更があったものだけ送る）。
 * 追加・削除・公開切替・画像アップロードは押した時点で即反映（保存不要）。
 */
const drafts = createEditDrafts();
function regField(table, id, column, el, opts = {}) {
  const get = opts.get || (() => {
    if (el.type === "checkbox") return el.checked;
    const v = el.value.trim();
    if (opts.number) return v === "" ? null : parseInt(v, 10);
    return v === "" ? null : v;
  });
  state.fields.push(drafts.register({ table, id, column, el, get, original: get() }));
  const evt = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(evt, markDirty);
}
function collectChanges() {
  return drafts.changes(state.fields);
}

function markDirty() {
  const n = collectChanges().length;
  state.dirty = n > 0;
  const bar = $("save-bar");
  if (!bar) return;
  bar.classList.toggle("dirty", state.dirty);
  $("save-status").textContent = state.dirty ? "未保存の変更があります" : "変更はありません";
  $("btn-save-all").disabled = !!state.saving || !state.dirty;
}
function validateChange(c) {
  if (c.table === "options" && ("pickup_from" in c.patch || "pickup_until" in c.patch)) {
    const source = [...state.products.flatMap(p => p.option_groups || []), ...state.globalGroups]
      .flatMap(g => g.options || []).find(o => o.id === c.id) || {};
    const next = { ...source, ...c.patch };
    if (next.pickup_from && next.pickup_until && next.pickup_from > next.pickup_until)
      throw new Error("提供期間の終了日は、開始日以降にしてください");
  }
  if (c.table === "common_question_choices") {
    const source = state.questions.flatMap(q => q.common_question_choices || []).find(x => x.id === c.id) || {};
    const next = { ...source, ...c.patch };
    if (next.pickup_from && next.pickup_until && next.pickup_from > next.pickup_until)
      throw new Error("提供期間の終了日は、開始日以降にしてください");
  }
  if (c.table === "options" && c.patch.size_prices && Object.values(c.patch.size_prices).some(n =>
      !Number.isInteger(n) || n < 0 || n > 1000000)) throw new Error("サイズ別追加料金は0〜1,000,000円の整数で入力してください");
  if (c.table === "options" && c.patch.order_deadline_days != null &&
      (!Number.isInteger(c.patch.order_deadline_days) || c.patch.order_deadline_days < 0 || c.patch.order_deadline_days > 365)) {
    throw new Error("選択肢の締切は0〜365の整数で入力してください");
  }

  if (c.table === "products") {
    const source = state.products.find(p => p.id === c.id) || {};
    const next = { ...source, ...c.patch };
    if (next.pickup_mode === "dates" && !(next.pickup_dates || []).length)
      throw new Error("日付で指定する場合は、受取日を1日以上追加してください");
    if (next.pickup_mode === "period" && next.pickup_start_date && next.pickup_end_date && next.pickup_start_date > next.pickup_end_date)
      throw new Error("受取期間の終了日は、開始日以降にしてください");
  }
  if (c.table === "option_groups" && c.patch.max_select != null && (!Number.isInteger(c.patch.max_select) || c.patch.max_select < 1))
    throw new Error("選べる種類数は1以上の整数で入力してください");
  if (c.table === "common_question_choices" && "label" in c.patch && !String(c.patch.label || "").trim())
    throw new Error("回答の名前を入力してください");
}
async function saveChange(c) {
  validateChange(c);
  if (c.table === "_product_capacity") return saveCapacityRule(c);
  const { _product_ids: productIds, ...patch } = c.patch;
  if (Object.keys(patch).length) {
    const rows = await api("PATCH", `/rest/v1/${c.table}?id=eq.${c.id}`, patch);
    if (!rows?.length) throw new Error("対象が見つからないか、変更する権限がありません");
  }
  if (c.table === "common_questions" && productIds) {
    const rows = await api("GET", `/rest/v1/common_question_products?question_id=eq.${c.id}`);
    const existing = new Set(rows.map(r => r.product_id));
    for (const pid of productIds) if (!existing.has(pid)) {
      await api("POST", "/rest/v1/common_question_products", [{
        tenant_id: state.tenantId, question_id: c.id, product_id: pid,
      }]);
    }
    for (const r of rows) if (!productIds.includes(r.product_id)) {
      await api("DELETE", `/rest/v1/common_question_products?question_id=eq.${c.id}&product_id=eq.${r.product_id}`);
    }
  }
}

function validateQuestionFlow(changes) {
  drafts.capture(state.fields);
  const groups = drafts.overlay('option_groups',[...state.products.flatMap(p => p.option_groups || []),...state.globalGroups]);
  const questions = drafts.overlay('common_questions',state.questions);
  for (const item of [...groups,...questions]) {
    if (item.condition_mode && item.condition_mode !== 'always' && !item.condition_option_id)
      throw new Error('表示条件にする選択肢を選んでください');
    if (item.target_product_ids && !item.target_product_ids.length)
      throw new Error('表示するケーキを1つ以上選んでください');
    if (item.scope === 'selected' && changes.some(c => c.id === item.id && ('scope' in c.patch || '_product_ids' in c.patch)) && !(item._product_ids || item.common_question_products || []).length)
      throw new Error('表示するケーキを1つ以上選んでください');
  }
  const optionGroups = new Map(groups.flatMap(g => (g.options || []).map(o => [o.id,g])));
  for (const g of groups) {
    const seen = new Set([g.id]); let next = g;
    while (next.condition_mode && next.condition_mode !== 'always' && next.condition_option_id) {
      next = optionGroups.get(next.condition_option_id);
      if (!next) break;
      if (seen.has(next.id)) throw new Error('質問の表示条件が循環しています。条件にする選択肢を変更してください');
      seen.add(next.id);
    }
  }
}

async function saveAll() {
  if (state.saving) return;
  const invalidDeadline = [...document.querySelectorAll(".o-deadline, .o-size-price, .o-maxq")].find(el => !el.checkValidity());
  if (invalidDeadline) {
    const row = invalidDeadline.closest(".opt");
    if (!row.classList.contains("open")) row.querySelector(".o-more").click();
    invalidDeadline.reportValidity();
    toast("締切・追加料金・個数上限の入力値を確認してください");
    return;
  }
  const changes = collectChanges();
  if (!changes.length) { toast("変更はありません"); return; }
  try { changes.forEach(validateChange); validateQuestionFlow(changes); }
  catch (e) { toast(e.message); return; }
  const btn = $("btn-save-all");
  state.saving = true;
  btn.disabled = true;
  btn.textContent = "保存中…";
  let savedCount = 0;
  try {
    for (const c of changes) {
      await saveChange(c);
      drafts.acknowledge(c, state.fields);
      savedCount++;
    }
    toast(`保存しました（${changes.length}件）`);
    state.dirty = false;
    await loadAll();
  } catch (e) {
    toast(`保存済み ${savedCount}件／未保存 ${changes.length - savedCount}件。未保存の変更は画面に残っています：${e.message}`);
  } finally {
    state.saving = false;
    btn.textContent = "保存する";
    markDirty();
  }
}

/* 再読み込みは下書きを保持する。確定するのは保存ボタンだけ。 */
async function reloadAll() {
  await loadAll();
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  t.style.opacity = 1;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.classList.add("hidden"), 400); }, 2600);
}

/* ---------- 認証（admin.jsと同じ保存キーを共用） ---------- */
function loadSession() {
  try { state.session = JSON.parse(localStorage.getItem("pokke_admin_session")); } catch { state.session = null; }
}
async function refreshSession() {
  if (!state.session?.refresh_token) return false;
  const res = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: state.session.refresh_token }),
  });
  if (!res.ok) return false;
  state.session = await res.json();
  localStorage.setItem("pokke_admin_session", JSON.stringify(state.session));
  return true;
}
async function api(method, path, body) {
  const doFetch = () => fetch(CONFIG.url + path, {
    method,
    headers: {
      apikey: CONFIG.anonKey,
      Authorization: `Bearer ${state.session.access_token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch();
  if (res.status === 401 && await refreshSession()) res = await doFetch();
  if (res.status === 401) { showLogin(); throw new Error("再ログインしてください"); }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const error = new Error(detail.code === "23514" ? detail.message : `操作できませんでした（${res.status}）`);
    error.code = detail.code;
    throw error;
  }
  const t = await res.text();
  const data = t ? JSON.parse(t) : null;
  const table = path.match(/^\/rest\/v1\/([a-z_]+)(?:\?|$)/)?.[1];
  if (method === "DELETE" && table && Array.isArray(data)) {
    const ids = data.map(row => row.id);
    drafts.forget(table, ids);
    state.fields = state.fields.filter(f => f.table !== table || !ids.includes(f.id));
  }
  return method === "GET" && table ? drafts.overlay(table, data) : data;
}
function showLogin() {
  $("view-login").classList.remove("hidden");
  $("view-app").classList.add("hidden");
}

/* ---------- 画像アップロード ---------- */
// スマホ写真をそのまま上げると重いので、長辺1200pxのJPEGに自動縮小してから送る
function shrinkImage(file, maxSide = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // 透過PNG対策（白背景で塗る）
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("変換に失敗しました"))),
        "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")); };
    img.src = url;
  });
}

async function uploadImage(file, kind /* 'products' | 'options' */) {
  if (!file.type.startsWith("image/")) throw new Error("画像ファイルを選んでください");
  const blob = await shrinkImage(file);
  const name = `${state.tenantId}/${kind}/${crypto.randomUUID()}.jpg`;
  const res = await fetch(`${CONFIG.url}/storage/v1/object/shop-images/${name}`, {
    method: "POST",
    headers: {
      apikey: CONFIG.anonKey,
      Authorization: `Bearer ${state.session.access_token}`,
      "Content-Type": "image/jpeg",
      "x-upsert": "true",
    },
    body: blob,
  });
  if (!res.ok) throw new Error(`アップロードに失敗しました (${res.status})`);
  return `${CONFIG.url}/storage/v1/object/public/shop-images/${name}`;
}

// イラストレイヤー用: 透過を保つため PNG のまま送る（縮小・JPEG化しない）
const LAYER_SIZE = 800; // 現行フォームと同じキャンバス
async function uploadLayer(file) {
  if (file.type !== "image/png") throw new Error("イラストは透過PNGでお願いします");
  // サイズ確認（違っても止めないが、案内を出す）
  const dim = await new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.width, h: img.height }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
  const name = `${state.tenantId}/layers/${crypto.randomUUID()}.png`;
  const res = await fetch(`${CONFIG.url}/storage/v1/object/shop-images/${name}`, {
    method: "POST",
    headers: {
      apikey: CONFIG.anonKey,
      Authorization: `Bearer ${state.session.access_token}`,
      "Content-Type": "image/png",
      "x-upsert": "true",
    },
    body: file,
  });
  if (!res.ok) throw new Error(`アップロードに失敗しました (${res.status})`);
  if (dim && (dim.w !== dim.h)) {
    toast(`正方形の画像をおすすめします（今の画像は ${dim.w}×${dim.h}px）`);
  }
  return `${CONFIG.url}/storage/v1/object/public/shop-images/${name}`;
}

async function deleteImageFile(url) {
  if (!url) return;
  const marker = "/object/public/shop-images/";
  const i = url.indexOf(marker);
  if (i < 0) return;
  // コピーした商品は元の商品と同じ画像ファイルを指す。他の行からまだ参照されていれば
  // ファイルは消さない（欄からは外れるが、元の商品の写真が突然消える事故を防ぐ）
  try {
    const u = encodeURIComponent(url);
    const [ps, os, gs, qs, cs] = await Promise.all([
      api("GET", `/rest/v1/products?or=(photo_url.eq.${u},layer_url.eq.${u})&deleted_at=is.null&select=id`),
      api("GET", `/rest/v1/options?or=(photo_url.eq.${u},layer_url.eq.${u})&select=id`),
      api("GET", `/rest/v1/option_groups?or=(default_layer_url.eq.${u},sample_image_url.eq.${u})&select=id`),
      api("GET", `/rest/v1/common_questions?sample_image_url=eq.${u}&select=id`),
      api("GET", `/rest/v1/common_question_choices?or=(photo_url.eq.${u},layer_url.eq.${u})&select=id`),
    ]);
    if (ps.length + os.length + gs.length + qs.length + cs.length > 0) return;
  } catch { return; /* 参照を確認できなければファイルを残す */ }
  const path = url.slice(i + marker.length);
  await fetch(`${CONFIG.url}/storage/v1/object/shop-images/${path}`, {
    method: "DELETE",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}` },
  }).catch(() => {});
}

// イラストレイヤーの欄（素材＋重ね順）。市松模様の背景で透過が分かるようにする
const PREVIEW_LAYER_HELP = "お客様の予約画面で、選んだ内容をケーキの上に重ねて表示するための透過PNGです。商品画像や見本画像とは別のものです。プレビュー合成を使わない場合は設定不要です。推奨サイズは800×800pxです。";
function buildLayerField(opts) {
  const { url, z, label, hint, showZ, orderKey, onChange } = opts;
  const box = document.createElement("div");
  box.className = "photo-field";
  if (orderKey) box.dataset.layerOrderKey = orderKey;
  box.innerHTML = `
    <span class="text-field-label">${esc(label)}<button type="button" class="tip" data-tip="${esc(PREVIEW_LAYER_HELP)}">？</button></span>
    <div class="photo-body">
      <div class="photo-thumb layer-thumb ${url ? "" : "empty"}">${url ? `<img src="${esc(url)}" alt="">` : "なし"}</div>
      <div class="photo-actions">
        <label class="pill photo-pick">イラストを選ぶ<input type="file" accept="image/png" hidden></label>
        <button type="button" class="pill danger photo-del" ${url ? "" : "hidden"}>削除</button>
        ${showZ ? `<input type="hidden" class="layer-z" value="${esc(z ?? 20)}"><span class="mini">重ね順は上の一覧で変更できます</span>` : ""}
        ${hint ? `<span class="mini photo-hint">${esc(hint)}</span>` : ""}<span class="mini">画像の変更・削除はその場で反映されます。</span>
      </div>
    </div>`;
  const input = box.querySelector('input[type="file"]');
  const pick = box.querySelector(".photo-pick");
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    pick.textContent = "アップロード中…";
    try {
      const newUrl = await uploadLayer(file);
      await onChange({ url: newUrl });
      await deleteImageFile(url);
      toast("イラストを保存しました");
      reloadAll();
    } catch (e) {
      toast(e.message);
      pick.textContent = "イラストを選ぶ";
    }
  };
  // 画像の削除は確認ダイアログを出さない（入れ直せる操作のため。
  // またダイアログ多用でブラウザにブロックされると無反応になる問題を避ける）
  box.querySelector(".photo-del").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "削除中…";
    try {
      await onChange({ url: null });
      await deleteImageFile(url);
      toast("イラストを削除しました");
      reloadAll();
    } catch (err) {
      toast("削除できませんでした：" + err.message);
      btn.disabled = false;
      btn.textContent = "削除";
    }
  };
  if (opts.sizes?.length > 1 && opts.onSizeChange) box.appendChild(buildSizeLayerFields(opts));
  return box;
}

/* サイズ別のイラスト（2026-09-30）。空欄のサイズは上の共通の1枚を使う。
 * 保存は {"サイズ名":"URL"} をそのまま書き換える（その場で反映・保存バー不要）。
 * 差し替え・削除しても元のファイルは消さない（コピーした商品と共有していることがあるため） */
function buildSizeLayerFields({ sizes, sizeUrls, onSizeChange, sizeKey }) {
  const map = sizeUrls && typeof sizeUrls === "object" ? { ...sizeUrls } : {};
  const count = sizes.filter((size) => map[size]).length;
  const details = document.createElement("details");
  details.className = "size-layers";
  // 開け閉めできると一目で分かるよう、閉じているときはボタンの見た目にする（まりほ指摘 2026-09-30）。
  // 1つでも登録済みなら最初から開いて、何が入っているか見えるようにする
  details.open = count > 0 || state.openSizeLayers.has(sizeKey);
  const summaryText = () => details.open
    ? `▴ サイズ別${count ? `（${count}サイズ登録済み）` : ""}`
    : "＋ サイズ別で登録する";
  details.innerHTML = `<summary class="size-layers-toggle"></summary>
    <p class="mini">サイズによって絵を変えたいときだけ登録します。空欄のサイズは上の共通のイラストを使います。サイズ名が同じなら、ほかの商品でも同じ絵になります。</p>
    <div class="size-layer-rows"></div>`;
  const summary = details.querySelector("summary");
  summary.textContent = summaryText();
  details.ontoggle = () => {
    if (details.open) state.openSizeLayers.add(sizeKey); else state.openSizeLayers.delete(sizeKey);
    summary.textContent = summaryText();
  };
  const rows = details.querySelector(".size-layer-rows");
  for (const size of sizes) {
    const url = map[size] || "";
    const row = document.createElement("div");
    row.className = "size-layer-row";
    row.innerHTML = `<span class="size-layer-label">${esc(size)}</span>
      <span class="photo-thumb layer-thumb small ${url ? "" : "empty"}">${url ? `<img src="${esc(url)}" alt="">` : "共通"}</span>
      <label class="pill photo-pick">${url ? "差し替える" : "イラストを選ぶ"}<input type="file" accept="image/png" hidden></label>
      <button type="button" class="pill danger size-layer-del" ${url ? "" : "hidden"}>削除</button>`;
    const pick = row.querySelector(".photo-pick");
    row.querySelector('input[type="file"]').onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      pick.textContent = "アップロード中…";
      try {
        const newUrl = await uploadLayer(file);
        await onSizeChange({ ...map, [size]: newUrl });
        toast(`${size}のイラストを保存しました`);
        reloadAll();
      } catch (err) {
        toast(err.message);
        pick.textContent = url ? "差し替える" : "イラストを選ぶ";
      }
    };
    row.querySelector(".size-layer-del").onclick = async (e) => {
      e.currentTarget.disabled = true;
      const next = { ...map };
      delete next[size];
      try {
        await onSizeChange(next);
        toast(`${size}のイラストを外しました（共通のイラストに戻ります）`);
        reloadAll();
      } catch (err) {
        toast("削除できませんでした：" + err.message);
        e.currentTarget.disabled = false;
      }
    };
    rows.appendChild(row);
  }
  return details;
}
/* 組み合わせ別のイラスト（2026-09-30）。例：「フルーツ1周」の絵を、果物（いちじく等）ごとに替える。
 * 飾り方の側に「この選択肢を一緒に選んでいる時はこの絵」を持たせる。保存はその場で反映。
 * rules = [{when: 選択肢ID, url, sizes: {サイズ名: URL}}] */
function buildComboLayerFields({ groups, rules, sizes, comboKey, onComboChange }) {
  const list = Array.isArray(rules) ? rules.map((r) => ({ ...r, sizes: { ...(r.sizes || {}) } })) : [];
  const live = list.filter((r) => r.url || Object.keys(r.sizes).length);
  const details = document.createElement("details");
  details.className = "size-layers combo-layers";
  details.open = live.length > 0 || state.openSizeLayers.has(comboKey);
  const summaryText = () => details.open
    ? `▴ 組み合わせ${live.length ? `（${live.length}件登録済み）` : ""}`
    : "＋ 組み合わせで絵を変える";
  details.innerHTML = `<summary class="size-layers-toggle"></summary>
    <p class="mini">ほかの選択肢と一緒に選ばれた時だけ、別の絵にします（例：いちじく×フルーツ1周）。登録のない組み合わせは上の絵のままです。</p>
    <label class="combo-group-pick">どの選択肢で絵を変える？<select></select></label>
    <div class="size-layer-rows combo-rows"></div>`;
  const summary = details.querySelector("summary");
  summary.textContent = summaryText();
  details.ontoggle = () => {
    if (details.open) state.openSizeLayers.add(comboKey); else state.openSizeLayers.delete(comboKey);
    summary.textContent = summaryText();
  };
  const candidates = groups.filter((g) => (g.options || []).length);
  const select = details.querySelector("select");
  const groupOf = (id) => candidates.find((g) => g.options.some((o) => o.id === id));
  const initial = groupOf(live[0]?.when) || candidates.find((g) => /フルーツ|果物/.test(g.name || "")) || candidates[0];
  select.innerHTML = candidates.map((g) => {
    const n = live.filter((r) => g.options.some((o) => o.id === r.when)).length;
    return `<option value="${esc(g.id)}" ${g === initial ? "selected" : ""}>${esc(g.name || "名称未設定のグループ")}${n ? `（${n}件登録済み）` : ""}</option>`;
  }).join("");
  const save = async (next, message) => {
    const cleaned = next.filter((r) => r.url || Object.keys(r.sizes || {}).length);
    await onComboChange(cleaned);
    toast(message);
    reloadAll();
  };
  const upsert = (when, patch) => {
    const next = list.map((r) => ({ ...r, sizes: { ...r.sizes } }));
    let rule = next.find((r) => r.when === when);
    if (!rule) { rule = { when, url: null, sizes: {} }; next.push(rule); }
    patch(rule);
    return next;
  };
  const rowsWrap = details.querySelector(".combo-rows");
  const paint = () => {
    rowsWrap.innerHTML = "";
    const g = candidates.find((x) => x.id === select.value);
    for (const o of [...(g?.options || [])].sort((a, b) => a.display_order - b.display_order)) {
      const rule = list.find((r) => r.when === o.id);
      const url = rule?.url || "";
      const row = document.createElement("div");
      row.className = "combo-row";
      row.innerHTML = `<div class="size-layer-row"><span class="size-layer-label combo-label">${esc(optDisplayName(o))}</span>
        <span class="photo-thumb layer-thumb small ${url ? "" : "empty"}">${url ? `<img src="${esc(url)}" alt="">` : "なし"}</span>
        <label class="pill photo-pick">${url ? "差し替える" : "イラストを選ぶ"}<input type="file" accept="image/png" hidden></label>
        <button type="button" class="pill danger combo-del" ${rule ? "" : "hidden"}>削除</button></div>`;
      const pick = row.querySelector(".photo-pick");
      row.querySelector('input[type="file"]').onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        pick.textContent = "アップロード中…";
        try {
          const newUrl = await uploadLayer(file);
          await save(upsert(o.id, (r) => { r.url = newUrl; }), `「${optDisplayName(o)}」の時の絵を保存しました`);
        } catch (err) { toast(err.message); pick.textContent = url ? "差し替える" : "イラストを選ぶ"; }
      };
      row.querySelector(".combo-del").onclick = async (e) => {
        e.currentTarget.disabled = true;
        try {
          await save(list.filter((r) => r.when !== o.id), `「${optDisplayName(o)}」の時の絵を外しました`);
        } catch (err) { toast("削除できませんでした：" + err.message); e.currentTarget.disabled = false; }
      };
      // 組み合わせごとのサイズ別（例：いちじく×12cm）
      if (sizes.length > 1) row.appendChild(buildSizeLayerFields({
        sizes, sizeUrls: rule?.sizes || {}, sizeKey: `${comboKey}:${o.id}`,
        onSizeChange: (map) => onComboChange(upsert(o.id, (r) => { r.sizes = map; }).filter((r) => r.url || Object.keys(r.sizes || {}).length)),
      }));
      rowsWrap.appendChild(row);
    }
  };
  select.onchange = paint;
  paint();
  if (!candidates.length) {
    details.querySelector(".combo-group-pick").remove();
    rowsWrap.innerHTML = `<p class="mini">組み合わせに使えるほかのグループがありません。</p>`;
  }
  return details;
}

// 商品のサイズ名（表示順）。質問の回答のように店全体で使う欄は、全商品のサイズ名をまとめる
const productSizeLabels = (p) => [...(p?.product_variants || [])]
  .sort((a, b) => a.display_order - b.display_order).map((v) => v.size_label).filter(Boolean);
const allSizeLabels = () => [...new Set(state.products.flatMap(productSizeLabels))];

// 画像アップロード欄を組み立てる（表示・選択・削除）
function buildPhotoField(opts) {
  const { url, kind, label, hint, onChange } = opts;
  const box = document.createElement("div");
  box.className = "photo-field";
  box.innerHTML = `
    <span class="text-field-label">${esc(label)}</span>
    <div class="photo-body">
      <div class="photo-thumb ${url ? "" : "empty"}">${url ? `<img src="${esc(url)}" alt="">` : "写真なし"}</div>
      <div class="photo-actions">
        <label class="pill photo-pick">写真を選ぶ<input type="file" accept="image/*" hidden></label>
        <button type="button" class="pill danger photo-del" ${url ? "" : "hidden"}>削除</button>
        ${hint ? `<span class="mini photo-hint">${esc(hint)}</span>` : ""}<span class="mini">画像の変更・削除はその場で反映されます。</span>
      </div>
    </div>`;
  const input = box.querySelector('input[type="file"]');
  const pick = box.querySelector(".photo-pick");
  input.onchange = async () => {
    const picked = input.files?.[0];
    input.value = ""; // 同じ写真をもう一度選べるように
    if (!picked) return;
    // 商品写真は予約ページで横長4:3（一覧のカード・選択中のケーキの枠とも）に出るので、その形で切ってもらう
    const file = window.ImageCrop ? await ImageCrop.open(picked, kind === "products"
      ? { aspectRatio: 4 / 3, allowOriginal: true }
      : { allowOriginal: true }) : picked;
    if (!file) return;
    pick.textContent = "アップロード中…";
    try {
      const newUrl = await uploadImage(file, kind);
      await onChange(newUrl);
      await deleteImageFile(url); // 差し替え時は古い画像を消す
      toast("写真を保存しました");
      reloadAll();
    } catch (e) {
      toast(e.message);
      pick.textContent = "写真を選ぶ";
    }
  };
  box.querySelector(".photo-del").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "削除中…";
    try {
      await onChange(null);
      await deleteImageFile(url);
      toast("写真を削除しました");
      reloadAll();
    } catch (err) {
      toast("削除できませんでした：" + err.message);
      btn.disabled = false;
      btn.textContent = "削除";
    }
  };
  return box;
}

/* ---------- データロード ---------- */
async function loadAll(keepCurrent = true) {
  drafts.capture(state.fields);
  // 「すべてのケーキに出す」グループ（product_id が null）は商品にぶら下がっていないので別で取る
  const [products, questions, globalGroups, categories] = await Promise.all([
    api("GET", `/rest/v1/products?tenant_id=eq.${state.tenantId}&deleted_at=is.null&order=display_order` +
      `&select=*,product_variants(*),option_groups(*,options!options_group_id_fkey(*,shared_list_items(*))),option_exclusions(*)`),
    api("GET", `/rest/v1/common_questions?tenant_id=eq.${state.tenantId}&order=display_order` +
      `&select=*,common_question_choices(*),common_question_products(product_id)`),
    api("GET", `/rest/v1/option_groups?tenant_id=eq.${state.tenantId}&product_id=is.null&order=display_order` +
      `&select=*,options!options_group_id_fkey(*,shared_list_items(*))`),
    api("GET", `/rest/v1/categories?tenant_id=eq.${state.tenantId}&order=display_order`),
  ]);
  state.products = products;
  state.questions = questions;
  state.globalGroups = globalGroups;
  state.categories = categories;
  if (keepCurrent && state.current) {
    state.current = products.find((p) => p.id === state.current.id) || products[0] || null;
  } else {
    let lastProductId = null;
    try { lastProductId = localStorage.getItem(`pokke_admin_last_product:${state.tenantId}`); } catch {}
    state.current = products.find((p) => p.id === lastProductId) || products[0] || null;
  }
  state.fields = []; // 入力欄の登録をやり直す
  renderTabs();
  renderEditor();
  await state.capacityLoading;
  renderCategories();
  $("save-bar").classList.remove("hidden");
  markDirty();
}

/* ---------- 商品タブ（2026-09-06：カテゴリで畳む＋名前で絞る） ----------
 * 商品が10を超えたあたりからタブが3行以上になり、いまどれを編集しているか
 * 分からなくなる（導入手順書の「わかっていること」3）。
 *   ・カテゴリを1つも作っていない店は、今までどおり平らに並ぶ
 *   ・絞り込み欄は商品が増えてから出す（少ない店の画面を余計にしない）
 * 畳んだ状態はこのブラウザに覚えさせる（店ごとの好みなのでサーバーには持たない）。
 */
const CLOSED_CATS_KEY = "pokke_admin_closed_cats";
function closedCats() {
  try { return new Set(JSON.parse(localStorage.getItem(CLOSED_CATS_KEY)) || []); } catch { return new Set(); }
}
function saveClosedCats(set) {
  try { localStorage.setItem(CLOSED_CATS_KEY, JSON.stringify([...set])); } catch { /* 使えなくても畳めるだけ */ }
}

function makeProdTab(p) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "prod-tab" + (state.current?.id === p.id ? " selected" : "") + (p.is_published ? "" : " unpublished");
  b.textContent = p.name + (p.is_published ? "" : "（非公開）");
  b.onclick = () => {
    drafts.capture(state.fields);
    state.current = p;
    reloadAll();
  };
  return b;
}

// ひらがなで打ってもカタカナの商品名に当たるようにする（「くりすます」→「クリスマス」）
const forMatch = (s) => String(s || "").toLowerCase()
  .replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

function renderTabs() {
  const wrap = $("prod-tabs");
  wrap.innerHTML = "";
  const raw = ($("prod-filter")?.value || "").trim();
  const q = forMatch(raw);
  const shown = state.products.filter((p) => !q || forMatch(p.name).includes(q));

  const needFilter = state.products.length > 8;
  $("prod-filter-row").classList.toggle("hidden", !needFilter);
  $("prod-hits").textContent = raw ? `${shown.length}件` : `${state.products.length}商品`;

  const rowOf = (items) => {
    const row = document.createElement("div");
    row.className = "tab-row";
    items.forEach((p) => row.appendChild(makeProdTab(p)));
    return row;
  };

  if (!state.categories.length) {
    wrap.appendChild(rowOf(shown));
  } else {
    const closed = closedCats();
    const bands = [...state.categories, { id: null, name: "未分類" }];
    for (const c of bands) {
      const items = shown.filter((p) => (p.category_id || null) === (c.id || null));
      if (!items.length) continue;
      const band = document.createElement("details");
      band.className = "cat-band";
      const key = c.id || "none";
      // 絞り込み中と、いま編集している商品が入っている帯は必ず開く
      band.open = !!q || items.some((p) => p.id === state.current?.id) || !closed.has(key);
      const sum = document.createElement("summary");
      sum.innerHTML = `<span class="cat-name">${esc(c.name)}</span><span class="cat-count">${items.length}</span>`;
      band.appendChild(sum);
      band.appendChild(rowOf(items));
      band.addEventListener("toggle", () => {
        const now = closedCats();
        band.open ? now.delete(key) : now.add(key);
        saveClosedCats(now);
      });
      wrap.appendChild(band);
    }
  }
  if (!shown.length) {
    wrap.insertAdjacentHTML("beforeend", `<p class="small">「${esc(raw)}」に合う商品はありません</p>`);
  }
}
$("prod-filter").addEventListener("input", () => renderTabs());

/* ---------- カテゴリ（商品タブのまとめ方・お客様の画面には出ない） ---------- */
// URLに使う名前。お客様に出るものではないので店には聞かず、こちらで作る
function makeCatSlug(name) {
  const taken = new Set(state.categories.map((c) => c.slug));
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!base) base = "cat";
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}


function renderCategories() {
  const wrap = $("cat-list");
  wrap.innerHTML = "";
  if (!state.categories.length) {
    wrap.innerHTML = `<p class="small">まだカテゴリはありません（商品タブは今までどおり並びます）。</p>`;
  }
  state.categories.forEach((c, i) => {
    const n = state.products.filter((p) => p.category_id === c.id).length;
    const row = document.createElement("div");
    row.className = "cat-row";
    row.innerHTML = `
      <input type="text" class="cat-rename inplace" value="${esc(c.name)}" aria-label="カテゴリ名">
      <span class="mini">${n}商品</span>
      <button type="button" class="pill cat-up" ${i === 0 ? "disabled" : ""} aria-label="上へ">↑</button>
      <button type="button" class="pill cat-down" ${i === state.categories.length - 1 ? "disabled" : ""} aria-label="下へ">↓</button>
      <button type="button" class="pill danger cat-del">削除</button>`;
    regField("categories", c.id, "name", row.querySelector(".cat-rename"));
    const swap = async (j) => {
      const other = state.categories[j];
      await api("PATCH", `/rest/v1/categories?id=eq.${c.id}`, { display_order: other.display_order });
      await api("PATCH", `/rest/v1/categories?id=eq.${other.id}`, { display_order: c.display_order });
      reloadAll();
    };
    row.querySelector(".cat-up").onclick = () => swap(i - 1);
    row.querySelector(".cat-down").onclick = () => swap(i + 1);
    row.querySelector(".cat-del").onclick = async () => {
      if (!confirm(`カテゴリ「${c.name}」を削除しますか？\n` +
        (n ? `この中の${n}商品は「未分類」に移ります（商品は消えません）。` : "")))
        return;
      try {
        if (n) await api("PATCH", `/rest/v1/products?category_id=eq.${c.id}`, { category_id: null });
        await api("DELETE", `/rest/v1/categories?id=eq.${c.id}`);
        toast(`「${c.name}」を削除しました`);
      } catch {
        toast("このカテゴリは上限の設定などで使われているため削除できません");
      }
      reloadAll();
    };
    wrap.appendChild(row);
  });
}
$("cat-panel").addEventListener("toggle", () => { $("cat-panel").dataset.touched = "1"; });
$("btn-new-product").onclick = async () => {
  const name = prompt("新しい商品の名前を入力してください");
  if (!name || !name.trim()) return;
  const created = await api("POST", "/rest/v1/products", [{
    tenant_id: state.tenantId, name: name.trim(), is_published: false,
    display_order: state.products.length, order_deadline_days: 3,
  }]);
  toast(`「${name.trim()}」を追加しました（非公開の状態です）`);
  state.current = created[0];
  await reloadAll();
};
$("btn-reload").onclick = () => reloadAll();

/* ---------- 日時ヘルパー（JSTのdatetime-local ↔ ISO） ---------- */
const isoToLocal = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const localToIso = (v) => (v ? new Date(v).toISOString() : null);

/* ---------- エディタ描画 ---------- */
function renderEditor() {
  $("p-publish-error").classList.add("hidden");
  const p = state.current;
  if (p && state.tenantId) {
    try { localStorage.setItem(`pokke_admin_last_product:${state.tenantId}`, p.id); } catch {}
  }
  $("editor").classList.toggle("hidden", !p);
  $("product-visual-editor").classList.toggle("hidden", !p);
  document.dispatchEvent(new Event("product-editor-rendered"));
  if (!p) return;
  const lite = state.tenant?.reservation_plan === 'lite';
  for (const id of ['p-deadline','p-cap-daily']) $(id).closest('.field').classList.toggle('hidden',lite);
  const saleCard = $('p-sale-start').closest('.confirm-box');
  if (saleCard) saleCard.classList.toggle("hidden",lite);
  $('product-visual-editor').classList.toggle('hidden',lite);
  (lite ? $('editor') : $('product-visual-editor')).appendChild($('btn-p-delete').closest('.product-delete-action'));
  for (const option of $('g-type').options) option.hidden = lite && !['select','text','textarea'].includes(option.value);
  if (lite && !['select','text','textarea'].includes($('g-type').value)) $('g-type').value='select';

  $("p-name").value = p.name;
  $("p-desc").value = p.description || "";
  $("p-note").value = p.note || "";
  $("p-note-accent").checked = !!p.note_accent;
  $("p-deadline").value = p.order_deadline_days ?? "";
  // 状態の表示と、押したらどうなるかのボタンを分ける（兼用は分かりにくいため）
  const stateEl = $("p-publish-state");
  stateEl.textContent = p.is_published ? "公開中" : "非公開";
  stateEl.classList.toggle("on", p.is_published);
  $("btn-p-publish").textContent = p.is_published ? "非公開にする" : "公開する";

  $("p-sale-start").value = isoToLocal(p.sale_start_at);
  $("p-sale-end").value = isoToLocal(p.sale_end_at);
  $("p-pickup-start").value = p.pickup_start_date || "";
  $("p-pickup-end").value = p.pickup_end_date || "";
  initPickupSchedule(p);
  const w = $("p-weekdays");
  w.innerHTML = "";
  WEEKDAYS.forEach((name, i) => {
    const on = (p.allowed_pickup_weekdays || []).includes(i);
    const lb = document.createElement("label");
    lb.className = on ? "on" : "";
    lb.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}>${name}`;
    lb.querySelector("input").onchange = (e) => { lb.classList.toggle("on", e.target.checked); markDirty(); };
    w.appendChild(lb);
  });

  // 保存バーで一括保存する項目を登録
  regField("products", p.id, "name", $("p-name"));
  regField("products", p.id, "description", $("p-desc"));
  regField("products", p.id, "note", $("p-note"));
  regField("products", p.id, "note_accent", $("p-note-accent"));
  regField("products", p.id, "order_deadline_days", $("p-deadline"), { number: true });
  regField("products", p.id, "sale_start_at", $("p-sale-start"),
    { get: () => localToIso($("p-sale-start").value) });
  regField("products", p.id, "sale_end_at", $("p-sale-end"),
    { get: () => localToIso($("p-sale-end").value) });
  regField("products", p.id, "pickup_start_date", $("p-pickup-start"));
  regField("products", p.id, "pickup_end_date", $("p-pickup-end"));
  regField("products", p.id, "allowed_pickup_weekdays", w, {
    get: () => {
      const wd = [...w.querySelectorAll("input")].map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0);
      return wd.length ? wd : null;
    },
  });

  // カテゴリ（商品タブのまとめ方であってお客様には出ない）。
  // 商品を見ながら「これはクリスマス用」と決めるので、商品名の下に常に出す。
  // その場で新しいカテゴリを作ってこの商品に入れられる（まりほ指摘 2026-09-07）
  const catSel = $("p-category");
  catSel.innerHTML = `<option value="">未分類</option>` +
    state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("") +
    `<option value="__new__">＋ 新しいカテゴリを作る</option>`;
  catSel.value = p.category_id || "";
  regField("products", p.id, "category_id", catSel,
    { get: () => (catSel.value === "__new__" ? (p.category_id || null) : (catSel.value || null)) });
  const newName = $("p-category-new");
  const newBtn = $("btn-p-category-create");
  const paintNew = () => {
    const making = catSel.value === "__new__";
    newName.classList.toggle("hidden", !making);
    newBtn.classList.toggle("hidden", !making);
    if (making) newName.focus();
  };
  paintNew();
  catSel.onchange = () => {
    paintNew();
    markDirty();
  };
  newBtn.onclick = async () => {
    const name = newName.value.trim();
    if (!name) { toast("カテゴリ名を入れてください"); return; }
    newBtn.disabled = true;
    let category = state.categories.find(c => c.name === name);
    try {
      if (!category) {
        const created = await api("POST", "/rest/v1/categories", [{
          tenant_id: state.tenantId, name, slug: makeCatSlug(name), display_order: state.categories.length,
        }]);
        category = created[0];
        state.categories.push(category); // 分類に失敗して再試行しても重複作成しない
      }
      await api("PATCH", `/rest/v1/products?id=eq.${p.id}`, { category_id: category.id });
      const option = new Option(category.name, category.id);
      catSel.add(option); catSel.value = category.id;
      drafts.capture(state.fields);
      drafts.acknowledge({ table: "products", id: p.id, patch: { category_id: category.id } }, state.fields);
      toast(`「${p.name}」をカテゴリ「${category.name}」に設定しました`);
      newName.value = "";
      await reloadAll();
    } catch {
      toast(category ? "カテゴリは作成済みですが、商品の分類を完了できませんでした。もう一度押してください。" : "カテゴリを作成できませんでした。通信状態を確認してください。");
    } finally { newBtn.disabled = false; }
  };

  // 商品写真
  const photoWrap = $("p-photo");
  photoWrap.innerHTML = "";
  photoWrap.appendChild(buildPhotoField({
    url: p.photo_url,
    kind: "products",
    label: "商品写真",
    hint: "横向き・4:3（1200×900px程度）",
    onChange: (url) => api("PATCH", `/rest/v1/products?id=eq.${p.id}`, { photo_url: url }),
  }));

  state.capacityLoading = loadCapacityRule(p);
  renderVariants(p);
  renderGroups(p);
  renderPreviewLayerSettings(p);
  renderProductStops(p);
}

/* ---------- この商品の上限（ほかの入力欄と同じ保存ボタンで確定） ---------- */
const capacityRules = new Map();
async function loadCapacityRule(p) {
  const dailyEl = $("p-cap-daily"), slotEl = $("p-cap-slot");
  dailyEl.disabled = slotEl.disabled = true;
  dailyEl.value = slotEl.value = "";
  try {
    const rules = await api("GET",
      `/rest/v1/capacity_rules?tenant_id=eq.${state.tenantId}&scope=eq.products&is_active=eq.true` +
      `&select=*,capacity_rule_products!inner(product_id)&capacity_rule_products.product_id=eq.${p.id}`);
    if (state.current?.id !== p.id) return;
    if (rules.length > 1) throw new Error("複数の上限ルールがあります。個別の確認が必要です");
    const rule = rules[0] || null;
    capacityRules.set(p.id, rule);
    for (const [column, el] of [["daily_limit", dailyEl], ["slot_limit", slotEl]]) {
      el.value = drafts.value("_product_capacity", p.id, column, rule?.[column] ?? null) ?? "";
      el.disabled = false;
      regField("_product_capacity", p.id, column, el, { number: true });
    }
    markDirty();
  } catch (e) {
    if (state.current?.id === p.id) toast("商品の上限を読み込めませんでした：" + e.message);
  }
}
async function saveCapacityRule(c) {
  const rule = capacityRules.get(c.id);
  if (!capacityRules.has(c.id)) throw new Error("商品の上限を読み直してください");
  const values = { daily_limit: rule?.daily_limit ?? null, slot_limit: rule?.slot_limit ?? null, ...c.patch };
  for (const v of Object.values(values)) {
    if (v !== null && (!Number.isInteger(v) || v < 0)) throw new Error("上限は0以上の整数、または空欄にしてください");
  }
  if (rule) {
    // 空欄もPATCHで扱う。削除→作成の途中状態を作らない。
    await api("PATCH", `/rest/v1/capacity_rules?id=eq.${rule.id}`, values);
    capacityRules.set(c.id, { ...rule, ...values });
  } else if (values.daily_limit !== null || values.slot_limit !== null) {
    const created = await api("POST", "/rest/v1/capacity_rules", [{
      tenant_id: state.tenantId, name: state.products.find(p => p.id === c.id)?.name || "商品上限",
      scope: "products", ...values,
    }]);
    try {
      await api("POST", "/rest/v1/capacity_rule_products", [{
        rule_id: created[0].id, product_id: c.id, tenant_id: state.tenantId,
      }]);
    } catch (e) {
      await api("DELETE", `/rest/v1/capacity_rules?id=eq.${created[0].id}`);
      throw e;
    }
    capacityRules.set(c.id, created[0]);
  }
}

/* ---------- 基本情報 ---------- */
$("btn-save-all").onclick = saveAll;
$("btn-p-publish").onclick = async () => {
  const p = state.current;
  const message = $("p-publish-error");
  message.classList.add("hidden");
  if (!p.is_published && state.dirty) {
    message.textContent = "入力内容を「保存する」で保存してから、公開してください。";
    message.classList.remove("hidden");
    return;
  }
  const btn = $("btn-p-publish");
  btn.disabled = true;
  try {
    await api("PATCH", `/rest/v1/products?id=eq.${p.id}`, { is_published: !p.is_published });
    toast(p.is_published ? "非公開にしました" : "公開しました");
    await reloadAll();
  } catch (e) {
    message.textContent = e.message;
    message.classList.remove("hidden");
  } finally { btn.disabled = false; }
};
/* ---------- この商品をコピー（サーバー側 fn_duplicate_product が丸ごと写す） ---------- */
$("btn-p-copy").onclick = async () => {
  const p = state.current;
  if (state.dirty) { toast("コピーする前に入力内容を保存してください"); return; }
  if (!confirm(`「${p.name}」をコピーして新しい商品を作りますか？\n（名前は「${p.name}（コピー）」・非公開の状態で作られます）`)) return;
  try {
    const newId = await api("POST", "/rest/v1/rpc/fn_duplicate_product", { p_product: p.id });
    toast(`「${p.name}（コピー）」を作りました（非公開の状態です）`);
    state.dirty = false;
    await loadAll(false);
    state.current = state.products.find((x) => x.id === newId) || null;
    await loadAll();
  } catch (e) {
    toast("コピーできませんでした：" + e.message);
  }
};

$("btn-p-delete").onclick = async () => {
  const p = state.current;
  if (!confirm(`「${p.name}」を削除しますか？\n（過去の予約データはそのまま残ります。削除後は一覧から消えます）`)) return;
  await api("PATCH", `/rest/v1/products?id=eq.${p.id}`, {
    deleted_at: new Date().toISOString(), is_published: false,
  });
  toast("削除しました");
  state.current = null;
  loadAll(false);
};

/* ---------- この商品だけ受け付けない日 ---------- */
async function renderProductStops(p) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const stops = await api("GET",
    `/rest/v1/availability_overrides?product_id=eq.${p.id}&variant_id=is.null&is_available=eq.false&date=gte.${todayStr}&order=date`);
  const wrap = $("p-stops-list");
  wrap.innerHTML = stops.length ? "" : `<p class="small">登録なし</p>`;
  for (const s of stops) {
    const row = document.createElement("div");
    row.className = "sl-item";
    row.innerHTML = `<span style="flex:1">${esc(s.date)} は受け付けない</span>
      <button type="button" class="pill danger">解除</button>`;
    row.querySelector("button").onclick = async () => {
      await api("DELETE", `/rest/v1/availability_overrides?id=eq.${s.id}`);
      toast("解除しました");
      renderProductStops(p);
    };
    wrap.appendChild(row);
  }
}
$("btn-p-stop-add").onclick = async () => {
  const p = state.current;
  const date = $("p-stop-date").value;
  if (!date) { toast("日付を選んでください"); return; }
  await api("POST", "/rest/v1/availability_overrides", [{
    tenant_id: state.tenantId, product_id: p.id, date, is_available: false,
  }]);
  $("p-stop-date").value = "";
  toast(`${date} はこの商品を受け付けません`);
  renderProductStops(p);
};

/* ---------- サイズと価格 ---------- */
function renderVariants(p) {
  const wrap = $("variants-list");
  wrap.innerHTML = "";
  const vs = [...p.product_variants].sort((a, b) => a.display_order - b.display_order);
  for (const v of vs) {
    const row = document.createElement("div");
    row.className = "opt-row";
    row.innerHTML = `
      <input type="text" class="o-name" value="${esc(v.size_label)}" style="width:110px">
      ¥<input type="number" class="v-price" min="0" value="${esc(v.price)}">
      <span class="state-badge ${v.is_available ? "on" : ""}">${v.is_available ? "提供中" : "停止中"}</span>
      <button type="button" class="pill v-toggle">${v.is_available ? "停止する" : "提供を再開する"}</button>
      <button type="button" class="pill danger v-del">削除</button>`;
    regField("product_variants", v.id, "size_label", row.querySelector(".o-name"));
    regField("product_variants", v.id, "price", row.querySelector(".v-price"), { number: true });
    row.querySelector(".v-toggle").onclick = async () => {
      try {
        await api("PATCH", `/rest/v1/product_variants?id=eq.${v.id}`, { is_available: !v.is_available });
        await reloadAll();
      } catch (e) { toast(e.message); }
    };
    row.querySelector(".v-del").onclick = async () => {
      try {
        await api("DELETE", `/rest/v1/product_variants?id=eq.${v.id}`);
        toast("削除しました");
      } catch (e) {
        toast(e.code === "23503" ? "予約で使用されているため削除できません（停止をお使いください）" : e.message);
      }
      reloadAll();
    };
    wrap.appendChild(row);
  }
}
$("btn-v-add").onclick = async () => {
  const p = state.current;
  const label = $("v-label").value.trim();
  const price = parseInt($("v-price").value, 10);
  if (!label || isNaN(price) || price < 0) { toast("サイズ名と価格を入れてください"); return; }
  await api("POST", "/rest/v1/product_variants", [{
    tenant_id: state.tenantId, product_id: p.id, size_label: label, price,
    display_order: p.product_variants.length,
  }]);
  $("v-label").value = ""; $("v-price").value = "";
  toast("サイズを追加しました");
  reloadAll();
};

/* ---------- 質問（共通の質問／選択肢の質問）の共通部品 ----------
 * 覚える概念は「質問」1つだけ。置き場所が2つあるだけにする（2026-08-30 作り直し）:
 *   ・共通の質問   = common_questions.option_id が null（どのケーキで聞くかを選ぶ）
 *   ・選択肢の質問 = option_id にその選択肢（選んだ人にだけ出るので条件は要らない）
 * どちらも回答のしかたは同じ5形式、選択式なら回答の選択肢を持てる。
 */
const Q_TYPES = [
  { v: "text", label: "入力欄（1行）" },
  { v: "textarea", label: "入力欄（複数行）" },
  { v: "date", label: "日付を選んでもらう" },
  { v: "select", label: "プルダウン" },
  { v: "radio", label: "ラジオボタン（1つ選ぶ）" },
  { v: "checkbox", label: "チェックボックス（複数選べる）" },
  { v: "image", label: "画像を貼ってもらう" },
  { v: "pastel_color", label: "パステルカラー＋補足" },
  { v: "color", label: "通常カラー＋補足" },
];
const isColorQuestion = (type) => type === "pastel_color" || type === "color";
const needsChoices = (t) => t === "select" || t === "radio" || t === "checkbox";
const imgMaxOf = (q) => Math.min(Math.max(parseInt(q?.image_max, 10) || 3, 1), 3);
const qChoices = (q) => [...(q?.common_question_choices || [])].sort((a, b) => a.display_order - b.display_order || a.id.localeCompare(b.id));
const typeOptions = (sel) => Q_TYPES.map((t) =>
  `<option value="${t.v}" ${t.v === sel ? "selected" : ""}>${t.label}</option>`).join("");
const questionsOf = (optionId) => drafts.overlay("common_questions", state.questions)
  .filter((q) => q.option_id === optionId)
  .sort((a, b) => a.display_order - b.display_order || a.id.localeCompare(b.id));

/* ---------- フォーカスした欄に対応するプレビュー箇所を光らせる ----------
 * 「お客様に見えます」というバッジや説明文の代わり（まりほ指摘：説明はUIでカバーできる）。
 * プレビューは入力のたびに描き直すので、描き直したあとに必ず光を戻す。
 */
let activeLight = null;
function applyLight() {
  document.querySelectorAll(".lit").forEach((x) => x.classList.remove("lit"));
  if (!activeLight) return;
  const t = typeof activeLight === "function" ? activeLight() : activeLight;
  if (t) t.classList.add("lit");
}
function linkLight(el, target) {
  if (!el) return el;
  el.addEventListener("focus", () => { activeLight = target; applyLight(); });
  el.addEventListener("blur", () => { activeLight = null; applyLight(); });
  return el;
}

function openAdminSamplePhoto(url, name) {
  const dialog = document.createElement("dialog");
  dialog.className = "option-sample-dialog";
  dialog.setAttribute("aria-label", `${name || "選択肢"}の見本写真`);
  dialog.innerHTML = '<button type="button" class="option-sample-close" aria-label="閉じる">×</button><p class="option-sample-title"></p><img alt="">';
  dialog.querySelector(".option-sample-title").textContent = `${name || "選択肢"}の見本`;
  const img = dialog.querySelector("img");
  img.src = url; img.alt = `${name || "選択肢"}の見本写真`;
  dialog.querySelector("button").onclick = () => dialog.close();
  dialog.onclick = e => { if (e.target === dialog) dialog.close(); };
  dialog.addEventListener("close", () => dialog.remove());
  document.body.appendChild(dialog); dialog.showModal();
}

/* お客様側の回答欄がどう見えるか（プレビュー用・操作はできない） */
function answerFieldHtml(view) {
  const cs = view.choices.filter(c => c.is_available !== false);
  const caption = c => esc(c.label || "（未入力）") + (c.price_delta ? `（+¥${Number(c.price_delta).toLocaleString("ja-JP")}）` : "")
    + (c.pickup_from || c.pickup_until ? `（受取日：${esc(c.pickup_from || "制限なし")}〜${esc(c.pickup_until || "制限なし")}）` : "");
  const photos = cs.filter(c => c.photo_url).map(c => `<span class="cfield-help">${esc(c.label)}の見本</span><span class="pv-sample"><img src="${esc(c.photo_url)}" alt="見本"></span>`).join("");
  if (view.type === "textarea") return `<textarea rows="2" disabled></textarea>`;
  if (view.type === "date") return `<input type="date" disabled>`;
  if (view.type === "select") {
    return `<select disabled>${cs.map((c) => `<option>${caption(c)}</option>`).join("")}</select>${photos}`;
  }
  if (view.type === "radio" || view.type === "checkbox") {
    const t = view.type === "radio" ? "radio" : "checkbox";
    return (cs.map((c) => `<label class="pick"><input type="${t}" disabled>${caption(c)}</label>`).join("")
      || `<span class="mini">回答の選択肢がまだありません</span>`) + photos;
  }
  if (view.type === "image") {
    return `<span class="q-img-preview">📷 写真を選ぶ` +
      `<span class="mini">（お客様は${esc(view.imageMax || 3)}枚まで貼れます）</span></span>`;
  }
  if (view.type === "pastel_color") {
    return `<span class="pastel-preview"><i></i>色相と淡さを選ぶ<span class="mini">＋補足を自由記入</span></span>`+
      (view.linkLabel?`<label class="pick"><input type="checkbox" disabled>${esc(view.linkLabel)}</label>`:'');
  }
  if (view.type === "color") {
    return `<span class="pastel-preview normal-color-preview"><i></i>通常のカラーチャートから選ぶ<span class="mini">＋補足を自由記入</span></span>`+
      (view.linkLabel?`<label class="pick"><input type="checkbox" disabled>${esc(view.linkLabel)}</label>`:'');
  }
  return `<input type="text" disabled>`;
}

/* 選択肢に追加した質問も、実際のお客様画面と同じ情報量で見せる。 */
function optionQuestionPreviewHtml(optionId, view) {
  return `<div class="cfield" data-option-id="${esc(optionId)}" data-question-id="${esc(view.id)}">
    <span class="cfield-question-title">${esc(view.label || "（質問文）")}${view.required ? '<span class="req">必須</span>' : ""}</span>
    ${view.help ? `<span class="cfield-help ${view.helpAccent ? "note-accent" : ""}">${esc(view.help)}</span>` : ""}
    ${view.sample ? `<span class="pv-sample"><img src="${esc(view.sample)}" alt=""></span>` : ""}
    ${answerFieldHtml(view)}
  </div>`;
}

/* 質問エディタ（共通の質問・選択肢の質問で同じ部品を使う）
 * 戻り値の要素の中で、ラベル/必須/形式/回答の選択肢を編集できる。
 * ラベル・形式・選択肢名は「まとめて保存」、選択肢の追加・削除はその場で反映する。 */
function buildQuestionFields(q, view, onPaint, opts = {}) {
  const box = document.createElement("div");
  box.className = "sub q-fields";
  const linkOptions = [...state.products.flatMap(p => p.option_groups.flatMap(g => g.options.map(o => ({...o, context: `${p.name} / ${g.name}`})))),
    ...state.globalGroups.flatMap(g => g.options.map(o => ({...o, context: `全商品 / ${g.name}`})))];
  const legacyMatches = linkOptions.filter(o => optDisplayName(o) === q.pastel_link_option_name);
  const linkId = q.pastel_link_option_id || (legacyMatches.length === 1 ? legacyMatches[0].id : "");
  const legacyLink = !linkId && !!q.pastel_link_option_name;

  box.innerHTML = `
    <input type="text" class="q-label" value="${esc(q.label)}" placeholder="質問文（お客様に見えます）">
    <label class="question-answer-type">回答方法<select class="q-type">${typeOptions(q.input_type)}</select></label>
    <label class="chk"><input type="checkbox" class="q-req" ${q.is_required ? "checked" : ""}>必須にする</label>
    <label class="chk q-imgmax ${q.input_type === "image" ? "" : "hidden"}">枚数
      <select class="q-imgmax-sel">${[1, 2, 3].map((n) =>
        `<option value="${n}" ${n === imgMaxOf(q) ? "selected" : ""}>${n}枚まで</option>`).join("")}</select>
    </label>
    <div class="sub q-pastel-link ${isColorQuestion(q.input_type) ? "" : "hidden"}">
      <label>同じ色にできる選択肢
        <select class="q-pastel-link-option"><option value="">連動なし</option>${legacyLink ? `<option value="legacy" selected>以前の連動先：${esc(q.pastel_link_option_name)}（選び直すと固定できます）</option>` : ""}${linkOptions.map(o=>`<option value="${esc(o.id)}" ${o.id===linkId?'selected':''}>${esc(o.context)}：${esc(optDisplayName(o))}</option>`).join('')}</select>
      </label>
      <label>お客様に見せる文言
        <input type="text" class="q-pastel-link-label" maxlength="120" value="${esc(q.pastel_link_label)}" placeholder="例：上の丸絞りも土台と同じ色にする">
      </label>
      <p class="small">選んだ装飾が注文に含まれるときだけ、同色にするチェック欄を表示します。</p>
    </div>
    <div class="sub q-choices ${needsChoices(q.input_type) ? "" : "hidden"}">
      <span class="q-choices-title">この質問の回答選択肢</span>
    </div>
    ${opts.hideHelp ? "" : `<input type="text" class="q-help" value="${esc(q.help_text)}" placeholder="補足（任意・質問の下に出ます）"><label class="chk"><input type="checkbox" class="q-help-accent" ${q.help_accent ? "checked" : ""}>目立たせる（赤・太字）</label>`}`;

  const labelEl = box.querySelector(".q-label");
  regField("common_questions", q.id, "label", labelEl);
  labelEl.addEventListener("input", () => { view.label = labelEl.value; onPaint(); });
  if (opts.lightLabel) linkLight(labelEl, opts.lightLabel);

  const helpEl = box.querySelector(".q-help");
  if (helpEl) {
    regField("common_questions", q.id, "help_text", helpEl);
    helpEl.addEventListener("input", () => { view.help = helpEl.value; onPaint(); });
  }

  const helpAccentEl = box.querySelector(".q-help-accent");
  if (helpAccentEl) {
    regField("common_questions", q.id, "help_accent", helpAccentEl);
    helpAccentEl.addEventListener("change", () => { view.helpAccent = helpAccentEl.checked; onPaint(); });
  }

  const reqEl = box.querySelector(".q-req");
  regField("common_questions", q.id, "is_required", reqEl);
  reqEl.addEventListener("change", () => { view.required = reqEl.checked; onPaint(); });

  // 見本の画像（色見本・仕上がりの例など。プレビュー合成には使わない）
  const sample = document.createElement("div");
  sample.className = "q-sample-field";
  sample.appendChild(buildPhotoField({
    url: q.sample_image_url,
    kind: "samples",
    label: "見本の画像（任意）",
    hint: "色見本・仕上がりの例など。お客様の画面で質問の下に出ます",
    onChange: async (url) => {
      await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { sample_image_url: url });
      view.sample = url;
      onPaint();
    },
  }));
  box.insertBefore(sample, box.querySelector(".q-choices"));
  if (helpEl) box.insertBefore(helpEl, sample);
  if (helpAccentEl) box.insertBefore(helpAccentEl.closest("label"), sample);

  const maxEl = box.querySelector(".q-imgmax-sel");
  regField("common_questions", q.id, "image_max", maxEl,
    { get: () => parseInt(maxEl.value, 10) || 3 });
  maxEl.addEventListener("change", () => { view.imageMax = parseInt(maxEl.value, 10) || 3; onPaint(); });

  const linkOptionEl=box.querySelector('.q-pastel-link-option'),linkLabelEl=box.querySelector('.q-pastel-link-label');
  regField('common_questions',q.id,'pastel_link_option_id',linkOptionEl,{get:()=>linkOptionEl.value === 'legacy' ? null : linkOptionEl.value||null});
  regField('common_questions',q.id,'pastel_link_option_name',linkOptionEl,{get:()=>linkOptionEl.value === 'legacy' ? q.pastel_link_option_name : linkOptions.find(o=>o.id===linkOptionEl.value)?.name||null});
  regField('common_questions',q.id,'pastel_link_label',linkLabelEl,{get:()=>linkLabelEl.value.trim()||null});
  const updateLinkPreview=()=>{view.linkLabel=linkOptionEl.value?(linkLabelEl.value.trim()||`${optDisplayName(linkOptions.find(o=>o.id===linkOptionEl.value)||{})}も同じ色にする`):'';onPaint();};
  linkOptionEl.addEventListener('change',updateLinkPreview);linkLabelEl.addEventListener('input',updateLinkPreview);

  const typeEl = box.querySelector(".q-type");
  regField("common_questions", q.id, "input_type", typeEl);
  typeEl.addEventListener("change", () => {
    view.type = typeEl.value;
    box.querySelector(".q-choices").classList.toggle("hidden", !needsChoices(view.type));
    box.querySelector(".q-imgmax").classList.toggle("hidden", view.type !== "image");
    box.querySelector(".q-pastel-link").classList.toggle("hidden", !isColorQuestion(view.type));
    onPaint();
  });

  const chWrap = box.querySelector(".q-choices");
  const choiceRows = [];
  for (const c of qChoices(q)) {
    const row = document.createElement("div");
    row.className = "choice";
    row.innerHTML = `
      <input type="text" class="c-label" value="${esc(c.label)}" placeholder="回答の選択肢">
      <span class="lbl">+¥</span><input type="number" class="c-price" min="0" value="${esc(c.price_delta)}">
      <button type="button" class="pill danger c-del">回答を削除</button>`;
    const cl = row.querySelector(".c-label");
    regField("common_question_choices", c.id, "label", cl);
    cl.addEventListener("input", () => {
      const target = view.choices.find((x) => x.id === c.id);
      if (target) target.label = cl.value;
      onPaint();
    });
    regField("common_question_choices", c.id, "price_delta", row.querySelector(".c-price"),
      { get: () => parseInt(row.querySelector(".c-price").value || "0", 10) || 0 });
    row.querySelector(".c-price").addEventListener("input", () => {
      const target = view.choices.find(x => x.id === c.id);
      if (target) target.price_delta = Number(row.querySelector(".c-price").value) || 0;
      onPaint();
    });
    row.querySelector(".c-del").onclick = async () => {
      try {
        await api("DELETE", `/rest/v1/common_question_choices?id=eq.${c.id}`);
      } catch {
        toast("すでに回答がある選択肢のため消せません");
      }
      reloadAll();
    };
    chWrap.appendChild(row);
    const details = document.createElement("details");
    details.className = "answer-choice-details";
    details.innerHTML = `<summary>詳しい設定${c.pickup_from || c.pickup_until ? "・提供期間あり" : ""}</summary>
      <strong>提供できる期間（任意）</strong>
      <p class="small">ケーキの受取日がこの期間内なら、この回答を選べます。開始日・終了日も含みます。空欄は制限なしです。</p>
      <div class="answer-choice-period"><label>開始日<input type="date" class="c-from" value="${esc(c.pickup_from || "")}"></label><label>終了日<input type="date" class="c-until" value="${esc(c.pickup_until || "")}"></label></div>
      <label class="period-hide"><input type="checkbox" class="c-hide-outside" ${c.hide_outside_period ? "checked" : ""}> 期間外はお客様に表示しない</label>`;
    regField("common_question_choices", c.id, "hide_outside_period", details.querySelector(".c-hide-outside"));
    for (const [column, selector] of [["pickup_from", ".c-from"], ["pickup_until", ".c-until"]]) {
      const input = details.querySelector(selector);
      regField("common_question_choices", c.id, column, input, { get: () => input.value || null });
      input.addEventListener("input", () => {
        const target = view.choices.find(x => x.id === c.id);
        if (target) target[column] = input.value || null;
        onPaint();
      });
    }
    details.appendChild(buildPhotoField({
      url: c.photo_url, kind: "samples", label: "見本写真（任意）",
      hint: "この回答の見本として、お客様の質問欄に表示します",
      onChange: async url => {
        await api("PATCH", `/rest/v1/common_question_choices?id=eq.${c.id}`, { photo_url: url });
        const target = view.choices.find(x => x.id === c.id);
        if (target) target.photo_url = url;
        onPaint();
      },
    }));
    const layer = buildLayerField({
      url: c.layer_url, z: c.layer_z, showZ: true,
      orderKey: `common_question_choices:${c.id}`,
      label: "プレビュー用イラスト（この回答を選んだ時・任意）",
      onChange: patch => api("PATCH", `/rest/v1/common_question_choices?id=eq.${c.id}`,
        patch.url !== undefined ? { layer_url: patch.url } : { layer_z: patch.z }),
      sizes: allSizeLabels(), sizeUrls: c.size_layer_urls, sizeKey: `common_question_choices:${c.id}`,
      onSizeChange: (map) => api("PATCH", `/rest/v1/common_question_choices?id=eq.${c.id}`, { size_layer_urls: map }),
    });
    details.appendChild(layer);
    regField("common_question_choices", c.id, "layer_z", layer.querySelector(".layer-z"), { number: true });
    row.appendChild(details);
    choiceRows.push({ data: c, row, target: row });
  }
  addOrderControls(chWrap, choiceRows, "common_question_choices", ids => {
    view.choices.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    onPaint();
  });
  if (choiceRows.length) {
    const note = document.createElement("p");
    note.className = "small";
    note.textContent = "↑・↓で回答の選択肢を並べ替え、「保存する」で確定します。";
    const title = chWrap.querySelector(".q-choices-title");
    chWrap.insertBefore(note, title?.nextSibling || chWrap.firstChild);
  }
  {
    const name = document.createElement("input");
    name.type = "text";
    name.className = "answer-choice-new-name";
    name.placeholder = "回答の名前を入力";
    name.maxLength = 120;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "pill ghost";
    add.textContent = "＋ 回答の選択肢を追加";
    add.onclick = async () => {
      const label = name.value.trim();
      if (!label) { name.focus(); toast("回答の名前を入力してください"); return; }
      await api("POST", "/rest/v1/common_question_choices", [{
        tenant_id: state.tenantId, question_id: q.id, label,
        display_order: Math.max(-1, ...qChoices(q).map(c => Number(c.display_order) || 0)) + 1,
      }]);
      reloadAll();
    };
    chWrap.appendChild(name);
    chWrap.appendChild(add);
  }
  return box;
}

/* ---------- 選択グループと選択肢 ---------- */
const optDisplayName = (o) => o.name || o.shared_list_items?.name || "（共有リストの項目）";
function optionAvailability(o) {
  if (o.shared_list_item_id && !o.shared_list_items?.is_available)
    return { available: false, label: "共有リストで停止中" };
  if (!o.is_available) return { available: false, label: o.shared_list_item_id ? "この商品で停止中" : "停止中" };
  const item = o.shared_list_items;
  return { available: true, label: o.pickup_from || o.pickup_until || item?.available_from || item?.available_until ? "提供期間あり" : "提供中" };
}
// この商品に出るグループ = その商品のグループ ＋「すべてのケーキに出す」グループ
function groupsForProduct(p) {
  return QuestionFlow.ordered(p, [...p.option_groups, ...state.globalGroups], [])
    .map(entry => entry.data);
}

const ADMIN_ANIMAL_NAMES = new Set(["ねこクッキー", "うさぎメレンゲ", "くまメレンゲ", "わんこメレンゲ"]);
const ADMIN_ANIMAL_LAYOUTS = {
  round: {
    "ねこクッキー": { cx: 235, cy: 185, h: 230 }, "うさぎメレンゲ": { cx: 600, cy: 165, h: 205 },
    "くまメレンゲ": { cx: 215, cy: 420, h: 205 }, "わんこメレンゲ": { cx: 595, cy: 440, h: 190 },
  },
  tart: {
    "ねこクッキー": { cx: 245, cy: 375, h: 210 }, "うさぎメレンゲ": { cx: 550, cy: 510, h: 200 },
    "くまメレンゲ": { cx: 165, cy: 510, h: 210 }, "わんこメレンゲ": { cx: 635, cy: 375, h: 195 },
  },
  basque: {
    "ねこクッキー": { cx: 285, cy: 200, h: 210 }, "うさぎメレンゲ": { cx: 565, cy: 390, h: 170 },
    "くまメレンゲ": { cx: 185, cy: 405, h: 185 }, "わんこメレンゲ": { cx: 585, cy: 205, h: 180 },
  },
};
function adminAnimalLayout(productName) {
  if (productName === "フルーツタルト") return ADMIN_ANIMAL_LAYOUTS.tart;
  if (productName === "バスクチーズケーキ") return ADMIN_ANIMAL_LAYOUTS.basque;
  return ADMIN_ANIMAL_LAYOUTS.round;
}
function adminAnimalIsBack(name, productName) {
  if (productName === "フルーツタルト") return name === "わんこメレンゲ";
  if (productName === "バスクチーズケーキ") return name === "ねこクッキー" || name === "わんこメレンゲ";
  return name === "ねこクッキー" || name === "うさぎメレンゲ";
}

// 商品内のプレビュー用イラストを、土台を含めて1つの一覧で確認・並べ替えられるようにする。
// 数値の重ね順は内部値として残し、画面では「全何枚のうち何番目」と前後ボタンだけを見せる。
function previewLayerEntries(p) {
  const entries = [];
  if (p.layer_url) entries.push({
    key: `products:${p.id}`, label: `土台：${p.name || "商品"}`, url: p.layer_url,
    fixed: true, z: Number.NEGATIVE_INFINITY, stable: -1,
  });
  let stable = 0;
  for (const g of groupsForProduct(p)) {
    const groupName = g.name || "名称未設定のグループ";
    if (g.default_layer_url) entries.push({
      key: `option_groups:${g.id}`, label: `${groupName}：何も選ばれていない時`,
      url: g.default_layer_url, z: Number(g.default_layer_z ?? 20), stable: stable++,
      record: g, column: "default_layer_z",
    });
    for (const o of [...(g.options || [])].sort((a, b) => a.display_order - b.display_order)) {
      if (!o.layer_url) continue;
      const optionName = optDisplayName(o);
      const animalName = state.tenantSubdomain === "pokke" && ADMIN_ANIMAL_NAMES.has(optionName) ? optionName : null;
      entries.push({
        key: `options:${o.id}`, label: `${groupName}：${optionName}`,
        url: o.layer_url, z: animalName ? (adminAnimalIsBack(animalName, p.name) ? 64 : 70) : Number(o.layer_z ?? 20), stable: stable++,
        record: o, column: "layer_z",
        animalName, automatic: !!animalName,
      });
    }
  }
  const optionIds = new Set(groupsForProduct(p).flatMap(g => (g.options || []).map(o => o.id)));
  for (const q of state.questions) {
    if (q.option_id || q.trigger_option_id) {
      if (!optionIds.has(q.option_id || q.trigger_option_id)) continue;
    } else if (q.scope !== "all" && !(q.common_question_products || []).some(x => x.product_id === p.id)) continue;
    for (const c of qChoices(q)) if (c.layer_url) entries.push({
      key: `common_question_choices:${c.id}`, label: `${q.label}：${c.label}`,
      url: c.layer_url, z: Number(c.layer_z ?? 50), stable: stable++, record: c, column: "layer_z",
    });
  }
  const base = entries.filter((entry) => entry.fixed);
  const movable = entries.filter((entry) => !entry.fixed)
    .sort((a, b) => (a.z - b.z) || (a.stable - b.stable));
  return [...base, ...movable];
}

function setPreviewLayerOrder(entries) {
  const movable = entries.filter((entry) => !entry.fixed && !entry.automatic);
  const zValues = movable.map((entry) => Number(entry.z) || 20).sort((a, b) => a - b);
  movable.forEach((entry, index) => {
    const z = zValues[index];
    entry.z = z;
    entry.record[entry.column] = z;
    const field = [...document.querySelectorAll("[data-layer-order-key]")]
      .find((el) => el.dataset.layerOrderKey === entry.key);
    const input = field?.querySelector(".layer-z");
    if (!input) return;
    input.value = String(z);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function loadAdminLayerImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url.includes("{digit}") ? url.replace("{digit}", "1") : url;
  });
}
function adminImageAlphaBounds(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  try {
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!data[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
    if (right > left && bottom > top) return { x: left, y: top, w: right - left, h: bottom - top };
  } catch { /* 外部画像で画素を読めない場合は画像全体を使う */ }
  return { x: 0, y: 0, w: canvas.width, h: canvas.height };
}
async function paintAdminLayerComposite(canvas, entries, productName) {
  const token = String(Date.now()) + Math.random();
  canvas.dataset.paintToken = token;
  const images = await Promise.all(entries.map((entry) => loadAdminLayerImage(entry.url)));
  if (canvas.dataset.paintToken !== token) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 800, 800);
  entries.forEach((entry, index) => {
    const image = images[index];
    if (!image) return;
    if (!entry.animalName) {
      ctx.drawImage(image, 0, 0, 800, 800);
      return;
    }
    const bounds = adminImageAlphaBounds(image);
    const placement = adminAnimalLayout(productName)[entry.animalName];
    const height = placement.h, width = height * bounds.w / bounds.h;
    ctx.drawImage(image, bounds.x, bounds.y, bounds.w, bounds.h,
      placement.cx - width / 2, placement.cy - height / 2, width, height);
  });
}

function renderLayerOrder(p) {
  const wrap = $("p-layer-order");
  const entries = previewLayerEntries(p);
  if (!entries.length) {
    wrap.className = "";
    wrap.innerHTML = "";
    return;
  }
  if (state.layerPreviewProductId !== p.id) {
    state.layerPreviewProductId = p.id;
    state.hiddenPreviewLayers = new Set();
  }
  const hidden = state.hiddenPreviewLayers || (state.hiddenPreviewLayers = new Set());
  const visibleEntries = entries.filter((entry) => !hidden.has(entry.key));
  wrap.className = "layer-order-panel";
  wrap.innerHTML = `
    <div class="layer-order-heading">
      <span class="text-field-label">イラストの重ね順</span>
      <span class="layer-count">全部で${entries.length}枚</span>
    </div>
    <p class="small">左の完成イメージを見ながら調整できます。一覧の上が後ろ、下が手前です。</p>
    <div class="layer-order-workspace">
      <div class="layer-composite-wrap">
        <canvas class="layer-composite" width="800" height="800" aria-label="現在の重なり"></canvas>
        <div class="layer-preview-controls">
          <span class="mini">${visibleEntries.length}枚を表示中</span>
          <button type="button" class="pill layer-show-all">すべて表示</button>
          <button type="button" class="pill layer-show-base">土台だけ</button>
        </div>
        <p class="small">確認したいイラストだけ右の「表示」をオンにできます。</p>
      </div>
      <div class="layer-order-list"></div>
    </div>
    <p class="small layer-save-note">順番を変更したら、画面下の「保存する」で確定します。</p>`;
  wrap.querySelector(".layer-show-all").onclick = () => {
    hidden.clear();
    renderLayerOrder(p);
  };
  paintAdminLayerComposite(wrap.querySelector(".layer-composite"), visibleEntries, p.name);
  wrap.querySelector(".layer-show-base").onclick = () => {
    hidden.clear();
    entries.filter((entry) => !entry.fixed).forEach((entry) => hidden.add(entry.key));
    renderLayerOrder(p);
  };
  const list = wrap.querySelector(".layer-order-list");
  entries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "layer-order-row";
    row.innerHTML = `
      <img src="${esc(entry.url)}" alt="">
      <div class="layer-order-name"><strong>${esc(entry.label)}</strong><span>後ろから${index + 1}番目／全${entries.length}枚</span></div>
      <div class="layer-order-actions">
        <label class="layer-visible"><input type="checkbox" ${hidden.has(entry.key) ? "" : "checked"}>表示</label>
        ${entry.fixed ? `<span class="tag">一番後ろに固定</span>` : entry.automatic
          ? `<span class="tag hi">位置・前後は自動調整</span>${POKKE_ONLY_TAG}` : `
          <button type="button" class="pill layer-back" ${index <= (entries[0]?.fixed ? 1 : 0) || entries[index - 1]?.automatic ? "disabled" : ""}>1つ後ろへ</button>
          <button type="button" class="pill layer-front" ${index === entries.length - 1 || entries[index + 1]?.automatic ? "disabled" : ""}>1つ前へ</button>`}
      </div>`;
    row.querySelector(".layer-visible input").addEventListener("change", (event) => {
      if (event.currentTarget.checked) hidden.delete(entry.key);
      else hidden.add(entry.key);
      renderLayerOrder(p);
    });
    row.querySelector(".layer-back")?.addEventListener("click", () => {
      [entries[index - 1], entries[index]] = [entries[index], entries[index - 1]];
      setPreviewLayerOrder(entries);
      renderLayerOrder(p);
    });
    row.querySelector(".layer-front")?.addEventListener("click", () => {
      [entries[index], entries[index + 1]] = [entries[index + 1], entries[index]];
      setPreviewLayerOrder(entries);
      renderLayerOrder(p);
    });
    list.appendChild(row);
  });
}

// 商品写真や見本画像とは分け、合成に使う透過PNGだけを1か所で設定する。
function renderPreviewLayerSettings(p) {
  const baseWrap = $("p-layer");
  const fieldsWrap = $("p-layer-fields");
  baseWrap.innerHTML = "";
  fieldsWrap.innerHTML = "";
  const sizes = productSizeLabels(p);
  baseWrap.appendChild(buildLayerField({
    url: p.layer_url,
    label: "ケーキの土台",
    hint: "透過PNG・800×800px",
    showZ: false,
    onChange: ({ url }) => api("PATCH", `/rest/v1/products?id=eq.${p.id}`, { layer_url: url }),
    sizes, sizeUrls: p.size_layer_urls, sizeKey: `products:${p.id}`,
    onSizeChange: (map) => api("PATCH", `/rest/v1/products?id=eq.${p.id}`, { size_layer_urls: map }),
  }));

  for (const g of groupsForProduct(p)) {
    const details = document.createElement("details");
    details.className = "preview-layer-group";
    const currentCount = (g.default_layer_url ? 1 : 0) + (g.options || []).filter((o) => o.layer_url).length;
    details.innerHTML = `<summary>${esc(g.name || "名称未設定のグループ")}<span class="tag">設定済み ${currentCount}枚</span></summary><div class="preview-layer-group-fields"></div>`;
    const body = details.querySelector(".preview-layer-group-fields");
    const groupField = buildLayerField({
      url: g.default_layer_url,
      z: g.default_layer_z,
      label: "何も選ばれていない時",
      hint: "このグループで未選択の時に表示する場合だけ設定します",
      showZ: true,
      orderKey: `option_groups:${g.id}`,
      onChange: (patch) => api("PATCH", `/rest/v1/option_groups?id=eq.${g.id}`,
        patch.url !== undefined ? { default_layer_url: patch.url } : { default_layer_z: patch.z }),
      sizes, sizeUrls: g.default_size_layer_urls, sizeKey: `option_groups:${g.id}`,
      onSizeChange: (map) => api("PATCH", `/rest/v1/option_groups?id=eq.${g.id}`, { default_size_layer_urls: map }),
    });
    body.appendChild(groupField);
    regField("option_groups", g.id, "default_layer_z", groupField.querySelector(".layer-z"), { number: true });

    for (const o of [...(g.options || [])].sort((a, b) => a.display_order - b.display_order)) {
      const optionField = buildLayerField({
        url: o.layer_url,
        z: o.layer_z,
        label: optDisplayName(o),
        hint: "この選択肢を選んだ時に重ねるイラスト",
        showZ: true,
        orderKey: `options:${o.id}`,
        onChange: (patch) => api("PATCH", `/rest/v1/options?id=eq.${o.id}`,
          patch.url !== undefined ? { layer_url: patch.url } : { layer_z: patch.z }),
        sizes, sizeUrls: o.size_layer_urls, sizeKey: `options:${o.id}`,
        onSizeChange: (map) => api("PATCH", `/rest/v1/options?id=eq.${o.id}`, { size_layer_urls: map }),
      });
      optionField.appendChild(buildComboLayerFields({
        groups: groupsForProduct(p).filter((x) => x.id !== g.id),
        rules: o.combo_layers, sizes, comboKey: `combo:${o.id}`,
        onComboChange: (rules) => api("PATCH", `/rest/v1/options?id=eq.${o.id}`, { combo_layers: rules }),
      }));
      body.appendChild(optionField);
      regField("options", o.id, "layer_z", optionField.querySelector(".layer-z"), { number: true });
    }
    fieldsWrap.appendChild(details);
  }
  renderLayerOrder(p);
}

function renderGroups(p) {
  if (!p) return;
  if (state.tenant?.reservation_plan === 'lite') return renderLiteQuestions(p);
  drafts.capture(state.fields);
  p = drafts.overlay("products",p);
  const wrap = $("groups-list"), other = $("questions-list");
  state.fields = state.fields.filter(f => !wrap.contains(f.el) && !other.contains(f.el));
  wrap.replaceChildren(); other.replaceChildren();
  const allGroups = drafts.overlay("option_groups", [...state.products.flatMap(x => x.option_groups || []), ...state.globalGroups]);
  const groups = [...new Map(allGroups.map(g => [g.id, g])).values()];
  const questions = drafts.overlay("common_questions",state.questions).filter(q => !q.option_id);
  const entries = QuestionFlow.ordered(p, groups, questions);
  const included = new Set(entries.map(e => e.key));
  const excluded = [...groups.map(data => ({kind:"group", key:`group:${data.id}`, data})),
    ...questions.map(data => ({kind:"question", key:`question:${data.id}`, data}))].filter(e => !included.has(e.key));
  const items = entries.map(entry => {
    const row = entry.kind === "group" ? buildGroupBox(p, entry.data) : buildQuestionBox(entry.data);
    row.dataset.questionKey = entry.key;
    wrap.appendChild(row);
    return {data:{...entry.data, id:entry.key}, row, target:row.querySelector(".grp-bar, .q-bar")};
  });
  for (const entry of excluded) {
    const owner = state.products.find(x => x.id === entry.data.product_id) || p;
    const row = entry.kind === "group" ? buildGroupBox(owner, entry.data) : buildQuestionBox(entry.data);
    row.dataset.questionKey = entry.key;
    other.appendChild(row);
  }
  $("other-questions").hidden = !excluded.length;
  const order = document.createElement("input"); order.type = "hidden";
  order.value = JSON.stringify(p.question_order || []); wrap.appendChild(order);
  regField("products", p.id, "question_order", order, {get:() => JSON.parse(order.value)});
  addOrderControls(wrap, items, "questions", ids => { order.value = JSON.stringify(ids); }, false);
  if (!items.length) wrap.insertAdjacentHTML("afterbegin", '<p class="small">このケーキの質問はまだありません。</p>');
}

function renderLiteQuestions(p) {
  drafts.capture(state.fields);
  const wrap=$('groups-list'), other=$('questions-list');
  state.fields=state.fields.filter(f=>!wrap.contains(f.el)&&!other.contains(f.el));
  wrap.replaceChildren(); other.replaceChildren(); $('other-questions').hidden=true;
  const qs=drafts.overlay('common_questions',state.questions).filter(q=>q.scope==='all'||(q.common_question_products||[]).some(x=>x.product_id===p.id));
  const standard=document.createElement('div'); standard.className='q';
  const plate=qs.find(q=>q.lite_standard_kind==='plate'), candles=qs.find(q=>q.lite_standard_kind==='candles');
  const max=candles?.is_active ? Math.max(0,...candles.common_question_choices.filter(c=>c.is_available).map(c=>parseInt(c.label)||0)) : 0;
  standard.innerHTML=`<h4>標準の質問</h4><label><input class="lite-plate" type="checkbox" ${plate?.is_active?'checked':''}>プレートの文字を聞く</label>
    <label class="field">無料ろうそくの上限（0本で非表示）<input class="lite-candles" type="number" min="0" max="30" value="${max}"></label>
    <button type="button" class="pill lite-standard-save">標準の質問を保存</button><p class="small">備考も表示します。標準の質問は追加質問３つに含みません。</p>`;
  standard.querySelector('button').onclick=async(e)=>{e.currentTarget.disabled=true;try{
    const n=Number(standard.querySelector('.lite-candles').value);
    if(!Number.isInteger(n)||n<0||n>30) throw new Error('無料ろうそくは0〜30本で設定してください');
    await api('POST','/rest/v1/rpc/fn_lite_standard_questions',{p_product:p.id,p_plate:standard.querySelector('.lite-plate').checked,p_candles:n,p_notes:true});
    toast('標準の質問を保存しました');await reloadAll();
  }catch(err){toast(err.message);e.target.disabled=false;}};
  wrap.appendChild(standard);
  const additional=qs.filter(q=>!q.lite_standard_kind);
  $('btn-g-add').disabled=additional.length>=3;
  const count=document.createElement('p');count.textContent=`追加質問 ${additional.length}／３つ（無料）`;wrap.appendChild(count);
  for(const q of additional){
    const box=document.createElement('div');box.className='q';
    box.innerHTML=`<label class="field">質問文<input class="lite-label" value="${esc(q.label)}"></label>
      <label>回答方法<select class="lite-type">${[['text','文字入力（1行）'],['textarea','文字入力（複数行）'],['select','選択式']].map(([v,l])=>`<option value="${v}" ${q.input_type===v?'selected':''}>${l}</option>`).join('')}</select></label>
      <label><input class="lite-required" type="checkbox" ${q.is_required?'checked':''}>必須</label>
      <div class="lite-choices"></div><button type="button" class="pill lite-choice-add">選択肢を追加</button>
      <button type="button" class="pill danger lite-question-delete">質問を削除</button>`;
    regField('common_questions',q.id,'label',box.querySelector('.lite-label'));
    regField('common_questions',q.id,'input_type',box.querySelector('.lite-type'));
    regField('common_questions',q.id,'is_required',box.querySelector('.lite-required'));
    const choices=box.querySelector('.lite-choices'),add=box.querySelector('.lite-choice-add');
    const updateVisibility=()=>{choices.hidden=add.hidden=box.querySelector('.lite-type').value!=='select';};
    box.querySelector('.lite-type').addEventListener('change',updateVisibility);updateVisibility();
    for(const c of drafts.overlay('common_question_choices',qChoices(q))){
      const row=document.createElement('label');row.className='field';row.innerHTML=`選択肢<input value="${esc(c.label)}"><span><input type="checkbox" ${c.is_available?'checked':''}>表示する</span>`;
      regField('common_question_choices',c.id,'label',row.querySelector('input'));
      regField('common_question_choices',c.id,'is_available',row.querySelector('[type=checkbox]'));choices.appendChild(row);
    }
    add.onclick=async()=>{try{await api('POST','/rest/v1/common_question_choices',[{tenant_id:state.tenantId,question_id:q.id,label:'新しい選択肢',price_delta:0,display_order:qChoices(q).length}]);await reloadAll();}catch(e){toast(e.message);}};
    box.querySelector('.lite-question-delete').onclick=async()=>{try{await api('DELETE',`/rest/v1/common_questions?id=eq.${q.id}`);await reloadAll();}catch(e){toast('予約で使われている質問は削除できません：'+e.message);}};
    wrap.appendChild(box);
  }
}

// Both storage formats use the same product scope and condition editor.
function buildQuestionSettings(item, kind, header, main) {
  const group = kind === "group", table = group ? "option_groups" : "common_questions";
  const currentProductId = state.current.id;
  const selectedIds = group ? (item.product_id ? [item.product_id] : item.target_product_ids)
    : (item.scope === "selected" ? item._product_ids || (item.common_question_products || []).map(x => x.product_id) : null);
  const initialMode = !selectedIds ? "all" : selectedIds.length === 1 && selectedIds[0] === currentProductId ? "this" : "some";
  const scope = document.createElement("div"); scope.className = "question-scope";
  scope.innerHTML = `<span class="k">表示するケーキ</span><div class="scope-buttons">${[
    ["all","すべてのケーキに出す"], ["this","このケーキだけに出す"], ["some","指定したケーキに出す"]
  ].map(([value,label]) => `<label><input type="radio" name="scope-${item.id}" value="${value}" class="${group ? 'gh-' : 'sc-'}${value === 'some' ? 'some' : value === 'this' ? 'only' : 'all'}" ${initialMode === value ? 'checked' : ''}>${label}</label>`).join("")}</div>
    <div class="cakes">${state.products.map(p => `<label><input type="checkbox" data-pid="${p.id}" ${(selectedIds || [currentProductId]).includes(p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join("")}</div>
    <p class="small scope-note"></p>`;
  header.appendChild(scope);
  const mode = () => scope.querySelector('input[type=radio]:checked').value;
  const ids = () => mode() === 'all' ? null : mode() === 'this' ? [currentProductId]
    : [...scope.querySelectorAll('.cakes input:checked')].map(el => el.dataset.pid).sort();
  if (group) {
    regField(table,item.id,'product_id',scope,{get:() => ids()?.length === 1 ? ids()[0] : null});
    regField(table,item.id,'target_product_ids',scope,{get:() => ids()?.length === 1 ? null : ids()});
  } else {
    regField(table,item.id,'scope',scope,{get:() => mode() === 'all' ? 'all' : 'selected'});
    regField(table,item.id,'_product_ids',scope,{get:() => ids() || []});
  }
  const paintScope = () => {
    scope.querySelector('.cakes').classList.toggle('hidden',mode() !== 'some');
    scope.dataset.shared = String(!ids() || ids().length > 1);
    scope.querySelector('.scope-note').textContent = scope.dataset.shared === 'true'
      ? '内容の変更は対象のケーキすべてに反映されます。並び順はケーキごとです。' : '';
    const appliesNow = !ids() || ids().includes(currentProductId);
    if (scope.closest('#questions-list') && appliesNow) scope.querySelector('.scope-note').textContent += ' 保存すると、このケーキの質問一覧に移動します。';
    if (scope.closest('#groups-list') && !appliesNow) scope.querySelector('.scope-note').textContent += ' 保存すると、このケーキの質問一覧から外れます。';
  };
  scope.addEventListener('change',() => {paintScope();markDirty();}); paintScope();
  const allGroups = [...state.products.flatMap(p => p.option_groups || []),...state.globalGroups];
  const candidates = [...new Map(allGroups.filter(g => !group || g.id !== item.id)
    .flatMap(g => (g.options || []).map(o => [o.id,{...o,groupName:g.name}]))).values()];
  const condition = document.createElement('div'); condition.className = 'question-condition';
  condition.innerHTML = `<label>表示条件<select class="condition-mode"><option value="always">いつも表示する</option><option value="selected">次の選択肢を選んだときに表示</option><option value="not_selected">次の選択肢を選んだら非表示</option></select></label>
    <label class="condition-target-label">条件にする選択肢<select class="condition-option"><option value="">選択肢を選んでください</option>${candidates.map(o => `<option value="${o.id}">${esc(o.groupName)} ／ ${esc(optDisplayName(o))}</option>`).join('')}</select></label>
    <p class="small">非表示の質問とその回答は、料金・必須チェック・予約内容に含めません。</p>`;
  main.prepend(condition);
  const conditionMode = condition.querySelector('.condition-mode'), option = condition.querySelector('.condition-option');
  conditionMode.value = item.condition_mode || 'always'; option.value = item.condition_option_id || '';
  regField(table,item.id,'condition_mode',conditionMode);
  regField(table,item.id,'condition_option_id',option,{get:() => conditionMode.value === 'always' ? null : option.value || null});
  const previewNote = document.createElement('p'); previewNote.className = 'small preview-condition';
  main.parentElement.querySelector('.cust .cap').after(previewNote);
  const paint = () => {
    condition.querySelector('.condition-target-label').classList.toggle('hidden',conditionMode.value === 'always');
    previewNote.textContent = conditionMode.value === 'always' ? '' : `表示条件：「${option.selectedOptions[0]?.textContent || '未選択'}」を選んだ${conditionMode.value === 'selected' ? 'ときに表示' : 'ら非表示'}`;
    previewNote.hidden = conditionMode.value === 'always';
  };
  conditionMode.addEventListener('change',paint); option.addEventListener('change',paint); paint();
}

function conditionDependents(optionIds, excludedGroupId = null) {
  const ids = new Set(optionIds);
  return [...state.products.flatMap(p => p.option_groups || []),...state.globalGroups,...state.questions]
    .filter(x => x.id !== excludedGroupId && !ids.has(x.option_id) && ids.has(x.condition_option_id))
    .map(x => x.name || x.label || '名前未入力の質問');
}

function buildGroupBox(p, g) {
  const box = document.createElement("div");
  box.className = "grp";
  const isGlobal = g.product_id === null;
  box.innerHTML = `
    <div class="grp-bar">
      <input type="text" class="gname inplace" value="${esc(g.name)}" aria-label="質問文">
      <label class="question-answer-type">回答方法<select class="gh-type">
        <option value="single" ${g.selection_type === "single" ? "selected" : ""}>1つ選ぶ</option>
        <option value="multiple" ${g.selection_type === "multiple" ? "selected" : ""}>複数選べる</option>
      </select></label>
      <label class="chk"><input type="checkbox" class="gh-req" ${g.is_required ? "checked" : ""}>必須</label>
      <label class="gh-max-wrap ${g.selection_type === "single" ? "hidden" : ""}">選べる種類数の上限 <input type="number" class="gh-max" min="1" step="1" placeholder="制限なし" value="${esc(g.max_select)}"></label>

      <details class="group-delete-panel">
        <summary>質問を削除…</summary>
        <div class="group-delete-content">
        <p class="group-delete-target">対象：<strong class="gh-delete-name">${esc(g.name)}</strong></p>
        <p>中の選択肢と、それぞれの質問・回答の選択肢もまとめて削除されます。</p>
        ${isGlobal ? '<p class="group-delete-scope">すべてのケーキから、このグループが消えます。</p>' : ''}
        <button type="button" class="pill danger gh-del">この質問全体を削除</button>
        </div>
      </details>
    </div>
    <div class="grp-body">
      <div class="grp-main">
      <div class="fb"><span class="k">説明</span>
        <textarea class="gh-desc" rows="2" placeholder="例: お好きな果物をお選びください">${esc(g.description)}</textarea></div>
      <div class="fb"><span class="k">注意書き</span>
        <textarea class="gh-note" rows="2" placeholder="例: ※果物は季節により異なります">${esc(g.note)}</textarea>
        <label class="chk"><input type="checkbox" class="gh-note-accent" ${g.note_accent ? "checked" : ""}>目立たせる（赤・太字）</label></div>
      <div class="g-sample"></div>
      <p class="meta">選択肢 ${g.options.length}件</p>
      <div class="g-options"></div>
      <p class="small">追加・削除・提供停止は、その場で反映されます。</p>
      <div class="override-add g-add-row">
        <input type="text" class="ga-name" placeholder="選択肢名" style="width:150px">
        <input type="number" class="ga-price" placeholder="+円" min="0" style="width:80px">
        <button type="button" class="pill ga-add">＋ 選択肢を追加</button>
      </div>

      </div>
      <div class="cust">
        <p class="cap">お客様に見える内容</p>
        <button type="button" class="pill preview-try">予約画面で選択を試す</button>
        <div class="card">
          <h4><span class="pv-name"></span><span class="req pv-req">必須</span></h4>
          <p class="desc pv-desc"></p>
          <p class="cnote pv-note"></p>
          <p class="desc pv-max"></p>
          <label class="pv-size-label">料金を確認するサイズ <select class="pv-size"></select></label>
          <div class="pv-group-sample"></div>
          <div class="pv-opts"></div>
        </div>
      </div>
    </div>`;

  // 画面に出す値の写し。入力のたびにここを更新してプレビューを描き直す
  const view = {
    maxSelect:g.max_select, size:"", name: g.name, required: !!g.is_required, single: g.selection_type === "single",
    desc: g.description || "", note: g.note || "", accent: !!g.note_accent, sample: g.sample_image_url || "",
    opts: [...g.options].sort((a, b) => a.display_order - b.display_order).map((o) => {
      const qs = questionsOf(o.id);
      return {
        sharedNote:o.shared_list_items?.note || "", sharedFrom:o.shared_list_items?.available_from || "", sharedUntil:o.shared_list_items?.available_until || "",
        photo:o.photo_url || "", accent:!!o.note_accent, sizePrices:{...o.size_prices}, deadline:o.order_deadline_days, from:o.pickup_from || "", until:o.pickup_until || "", review:!!o.requires_review, maxQty:o.max_quantity,
        id: o.id, description:o.description || "", note:o.note || "", name: optDisplayName(o), price: o.price_delta, available: optionAvailability(o).available,
        qs: qs.map((q) => ({ id: q.id,
          label: q.label, type: q.input_type, required: q.is_required, active: q.is_active !== false, imageMax: imgMaxOf(q),
          help: q.help_text || "", helpAccent: !!q.help_accent, sample: q.sample_image_url || "",
          linkLabel:q.pastel_link_option_name?(q.pastel_link_label||`${q.pastel_link_option_name}も同じ色にする`):'',
          choices: qChoices(q).map((c) => ({ ...c })),
        })),
      };
    }),
  };
  const paint = () => {
    box.querySelector(".pv-name").textContent = view.name || "（グループ名）";
    box.querySelector(".gh-delete-name").textContent = view.name || "（グループ名）";
    box.querySelector(".pv-req").classList.toggle("hidden", !view.required);
    let capacity=box.querySelector('.pv-meringue-capacity');
    if(state.tenantSubdomain==='pokke' && view.opts.some(o=>['わんこメレンゲ','うさぎメレンゲ','くまメレンゲ'].includes(o.name))){
      if(!capacity){capacity=document.createElement('p');capacity.className='desc pv-meringue-capacity';box.querySelector('.pv-desc').after(capacity);}
      capacity.textContent='メレンゲは合計4個まで。ナンバークッキー大・カレンダー使用時に載せる動物は合計2個まで（別添えは除く）。';
    }
    const d = box.querySelector(".pv-desc");
    d.textContent = view.desc; d.classList.toggle("hidden", !view.desc.trim());
    const n = box.querySelector(".pv-note");
    n.textContent = view.note; n.classList.toggle("hidden", !view.note.trim());
    n.classList.toggle("accent", view.accent);
    const sample = box.querySelector(".pv-group-sample");
    sample.hidden = !view.sample;
    sample.innerHTML = view.sample ? `<span class="pv-sample"><img src="${esc(view.sample)}" alt="${esc(view.name || '質問')}の見本"></span>` : "";
    box.querySelector(".pv-max").textContent = !view.single && view.maxSelect != null ? `${view.maxSelect}種類まで選べます` : "";
    box.querySelector(".pv-opts").innerHTML = view.opts.filter(o => o.available).map((o) => {
      const from = [o.from, o.sharedFrom].filter(Boolean).sort().at(-1);
      const until = [o.until, o.sharedUntil].filter(Boolean).sort()[0];
      const note = o.note || o.sharedNote;
      const price = Number(o.sizePrices?.[view.size] ?? o.price) || 0;
      const priceText = (price ? "+¥" + price.toLocaleString("ja-JP") : "") + (o.review ? (price ? "・" : "") + "別途見積もり" : (price ? "" : "無料"));
      return `<div class="pv-option">
        <div class="crow" data-option-id="${esc(o.id)}">
          <span class="pv-option-name">${view.single ? "○" : "☐"} ${esc(o.name || "（名前なし）")}</span>
          ${o.photo ? `<button type="button" class="opt-sample-button" data-sample-option="${esc(o.id)}">見本を見る</button>` : ""}
          <span class="pv-price">${priceText}</span>
        </div>
        ${o.deadline != null ? `<p class="desc">受取日の${esc(o.deadline)}日前締切（受付可能日はカレンダーで確認）</p>` : ""}
        ${o.description ? `<p class="desc">${esc(o.description)}</p>` : ""}${note ? `<p class="cnote${o.accent ? " accent" : ""}">${esc(note)}</p>` : ""}
        ${from || until ? `<p class="desc">受取日：${esc(from || "制限なし")}〜${esc(until || "制限なし")}</p>` : ""}
        ${o.maxQty > 1 ? `<p class="desc">数量：1〜${esc(o.maxQty)}個</p>` : ""}
        ${(o.qs || []).filter(q => q.active !== false).map(q => optionQuestionPreviewHtml(o.id, q)).join("")}
      </div>`;
    }).join("");
    box.querySelectorAll("[data-sample-option]").forEach(button => {
      button.onclick = () => {
        const option = view.opts.find(o => o.id === button.dataset.sampleOption);
        openAdminSamplePhoto(option.photo, option.name);
      };
    });
    applyLight();
  };

  const sizeSelect = box.querySelector(".pv-size");
  sizeSelect.innerHTML = '<option value="">共通の追加料金</option>' + (p.product_variants || []).map(v => `<option value="${esc(v.size_label)}">${esc(v.size_label)}</option>`).join("");
  sizeSelect.onchange = () => { view.size = sizeSelect.value; paint(); };
  box.querySelector(".gh-max").addEventListener("input", e => { view.maxSelect = e.target.value === "" ? null : Number(e.target.value); paint(); });

  const nameEl = box.querySelector(".gname");
  regField("option_groups", g.id, "name", nameEl);
  nameEl.addEventListener("input", () => { view.name = nameEl.value; paint(); });
  linkLight(nameEl, () => box.querySelector(".pv-name"));

  const typeEl = box.querySelector(".gh-type");
  regField("option_groups", g.id, "selection_type", typeEl);
  typeEl.addEventListener("change", () => { view.single = typeEl.value === "single";
    box.querySelector(".gh-max-wrap").classList.toggle("hidden", view.single); paint(); });
  regField("option_groups", g.id, "max_select", box.querySelector(".gh-max"), {get:()=>box.querySelector(".gh-max").value === "" ? null : Number(box.querySelector(".gh-max").value)});

  const reqEl = box.querySelector(".gh-req");
  regField("option_groups", g.id, "is_required", reqEl);
  reqEl.addEventListener("change", () => { view.required = reqEl.checked; paint(); });

  const descEl = box.querySelector(".gh-desc");
  regField("option_groups", g.id, "description", descEl);
  descEl.addEventListener("input", () => { view.desc = descEl.value; paint(); });
  linkLight(descEl, () => box.querySelector(".pv-desc"));

  const noteEl = box.querySelector(".gh-note");
  regField("option_groups", g.id, "note", noteEl);
  noteEl.addEventListener("input", () => { view.note = noteEl.value; paint(); });
  linkLight(noteEl, () => box.querySelector(".pv-note"));

  const accentEl = box.querySelector(".gh-note-accent");
  regField("option_groups", g.id, "note_accent", accentEl);
  accentEl.addEventListener("change", () => { view.accent = accentEl.checked; paint(); });

  buildQuestionSettings(g, "group", box.querySelector(".grp-bar"), box.querySelector(".grp-main"));

  box.querySelector(".gh-del").onclick = async () => {
    const dependents = conditionDependents(g.options.map(o => o.id),g.id);
    if (dependents.length) { toast(`「${dependents.join('」「')}」の表示条件に使われています。先にその条件を変更してください。`); return; }
    const scope = isGlobal
      ? `\n（共通で使っている質問です。対象のケーキすべてから消えます）` : "";
    if (!confirm(`質問「${nameEl.value.trim() || g.name}」と中の選択肢を削除しますか？\n中の選択肢${g.options.length}件と、それぞれの質問・回答の選択肢も削除されます。${scope}`)) return;
    try {
      const ids = g.options.map((o) => o.id).join(",");
      if (ids) {
        await api("DELETE", `/rest/v1/option_exclusions?or=(option_a.in.(${ids}),option_b.in.(${ids}))`);
        const questionIds = g.options.flatMap((option) => questionsOf(option.id)).map((q) => q.id).join(",");
        if (questionIds) await api("DELETE", `/rest/v1/common_question_choices?question_id=in.(${questionIds})`);
        await api("DELETE", `/rest/v1/common_questions?option_id=in.(${ids})`);
      }
      await api("DELETE", `/rest/v1/options?group_id=eq.${g.id}`);
      await api("DELETE", `/rest/v1/option_groups?id=eq.${g.id}`);
      toast("削除しました");
    } catch {
      toast("予約で使用されている選択肢があるため削除できません（各選択肢の停止をお使いください）");
    }
    reloadAll();
  };

  box.querySelector(".ga-add")?.addEventListener("click", async () => {
    const name = box.querySelector(".ga-name").value.trim();
    const price = parseInt(box.querySelector(".ga-price").value || "0", 10);
    if (!name) { toast("選択肢名を入れてください"); return; }
    await api("POST", "/rest/v1/options", [{
      tenant_id: state.tenantId, group_id: g.id, name,
      price_delta: isNaN(price) ? 0 : price, display_order: g.options.length,
    }]);
    toast("選択肢を追加しました");
    reloadAll();
  });

  // グループの既定イラスト（何も選ばれていないときに重ねる絵）
  box.querySelector(".g-sample").appendChild(buildPhotoField({
    url: g.sample_image_url,
    kind: "samples",
    label: "見本の画像（任意）",
    hint: "色見本・仕上がりの例など。お客様の画面で説明の下に出ます",
    onChange: async (url) => {
      await api("PATCH", `/rest/v1/option_groups?id=eq.${g.id}`, { sample_image_url: url });
      view.sample = url;
      paint();
    },
  }));
  const optWrap = box.querySelector(".g-options");
  const optRows = view.opts.map((ov, i) => {
    const o = g.options.find((x) => x.id === ov.id);
    const row = buildOptionRow(p, g, o, view, ov, i, paint);
    optWrap.appendChild(row);
    // 印の行（.marks）は入力のたびに描き直されるので、並べ替えボタンは別の置き場所に置く
    const holder = document.createElement("div");
    holder.className = "opt-order";
    row.querySelector(".marks").after(holder);
    return { data: o, row, target: holder };
  });
  // 選択肢の並べ替え（2026-09-30）。↑↓で画面の中だけ動かし、保存バーで表示順を確定する
  if (optRows.length > 1) addOrderControls(optWrap, optRows, "options", (ids) => {
    view.opts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    paint();
  });

  paint();
  return box;
}

/* たたんだままでも中身が分かる印（開かないと分からない状態にしない） */
function marksHtml(o, ov) {
  const mk = (on, yes, no) => `<span class="mk ${on ? "" : "off"}">${on ? yes : no}</span>`;
  return mk(!!(o.description || "").trim(), "説明あり", "説明なし")
    + mk(!!(o.note || "").trim(), "注意書きあり", "注意書きなし")
    + mk(!!ov.qs?.length, ov.qs?.length > 1 ? `質問${ov.qs.length}件` : "質問あり", "質問なし")
    + mk(!!o.photo_url, "見本写真あり", "見本写真なし")
    + (o.order_deadline_days != null ? `<span class="mk">${esc(o.order_deadline_days)}日前締切</span>` : "")
    + (o.requires_review ? '<span class="mk">見積もり・承諾が必要</span>' : "")
    + (Object.keys(o.size_prices || {}).length ? '<span class="mk">サイズ別料金あり</span>' : "");
}

// oyatsupokkeだけに出る特別な設定の目印（他店の画面にはこの設定自体が出ない）
const POKKE_ONLY_TAG = `<span class="tag pokke-only" title="oyatsupokkeだけの特別な設定です。他のお店の画面には出ません">oyatsupokke専用</span>`;

function buildOptionRow(p, g, o, view, ov, index, paintGroup) {
  const row = document.createElement("div");
  const open = state.openOptions.has(o.id);
  const availability = optionAvailability(o);
  row.className = "opt" + (open ? " open" : "") + (availability.available ? "" : " stopped");
  const qs = questionsOf(o.id);
  const physicalLimit = state.tenantSubdomain === "pokke" && ["フルーツタルト", "バスクチーズケーキ"].includes(p.name) && optDisplayName(o) === "ナンバークッキー大" ? 2 : null;
  row.innerHTML = `
    <div class="opt-line">
      <input type="text" class="oname inplace" value="${esc(optDisplayName(o))}" aria-label="選択肢名"
        placeholder="選択肢名">
      <label class="option-price-field"><span class="lbl">+¥</span><input type="number" class="o-price" aria-label="追加料金（税込・円）" min="0" value="${esc(o.price_delta)}"></label>
      <label class="option-quantity-field"><span class="lbl">個数上限</span><input type="number" class="o-maxq maxq" min="1" placeholder="1" ${physicalLimit ? `max="${physicalLimit}"` : ""} value="${esc(physicalLimit ? Math.min(o.max_quantity || 1, physicalLimit) : o.max_quantity)}"></label>
      <span class="state-badge ${availability.available ? "on" : ""}">${availability.label}</span>
      <button type="button" class="pill o-more" aria-expanded="${open}">詳しい設定 ${open ? "▴" : "▾"}</button>
      ${physicalLimit ? `<span class="mini option-quantity-note">実物の配置上、最大${physicalLimit}枚です ${POKKE_ONLY_TAG}</span>` : ""}
    </div>
    <div class="marks">${marksHtml(o, ov)}</div>
    <div class="more ${open ? "" : "hidden"}">
      <section class="option-detail-section option-detail-content">
      <h4>お客様に見える内容</h4>
      <div class="fb"><span class="k">説明</span>
        <textarea class="o-desc" rows="2" placeholder="例: 側面のクリームが剥がれたような塗り方になります">${esc(o.description)}</textarea></div>
      <div class="fb"><span class="k">注意書き</span>
        <textarea class="o-note" rows="2" placeholder="例: ※いちごチョコは酸味があります">${esc(o.note)}</textarea>
        <label class="chk"><input type="checkbox" class="o-note-accent" ${o.note_accent ? "checked" : ""}>目立たせる（赤・太字）</label></div>
      <div class="o-photo fb"></div>
      <div class="fb o-questions">
        <span class="k">この選択肢を選んだ人への質問</span>
        <p class="small">選択式と記載欄など、複数の質問を順番に表示できます。</p>
        <p class="small">質問・回答の追加、削除、停止はその場で反映されます。</p><div class="o-qbox"></div>
        <button type="button" class="pill ghost o-qadd">＋ 質問を追加</button>
      </div>
      </section>
      <section class="option-detail-section option-detail-pricing">
      <div class="fb o-size-prices"><span class="k">サイズ別の追加料金（税込）</span>
        <p class="small">空欄のサイズは上の追加料金を使います。同じサイズ名には同じ金額を適用します。</p></div>
      </section>
      <section class="option-detail-section option-detail-availability">
      <div class="fb"><span class="k">提供できる期間（任意）</span>
        <p class="small">ケーキの受取日がこの期間内なら選べます。開始日・終了日も含みます。空欄は制限なしです。</p>
        <div class="answer-choice-period"><label>開始日<input type="date" class="o-from" value="${esc(o.pickup_from || "")}"></label><label>終了日<input type="date" class="o-until" value="${esc(o.pickup_until || "")}"></label></div>
        <label class="period-hide"><input type="checkbox" class="o-hide-outside" ${o.hide_outside_period ? "checked" : ""}> 期間外はお客様に表示しない</label>
        <p class="small">チェックなし：期間外の受取日では「期間外」と表示して選べないようにします。チェックあり：期間外は予約ページに出しません。</p>
      </div>

      <div class="fb"><label class="k" for="deadline-${esc(o.id)}">この選択肢の締切（受取日の何日前まで）</label>
        <input id="deadline-${esc(o.id)}" class="o-deadline" type="number" min="0" max="365" step="1" placeholder="商品と同じ" value="${esc(o.order_deadline_days)}">
        <p class="small">空欄は商品と同じ。例：デザイン指定は7日前。商品やほかの選択肢より準備期間が長い場合に適用します。定休日の数え方・締切時刻はお店の設定に従います。</p></div>
      <div class="option-detail-rule-actions">
        <button type="button" class="pill o-stops">ご用意できない日を設定</button>
        <button type="button" class="pill o-excl">同時に選べないものを選ぶ</button>
      </div>
      </section>
      <section class="option-detail-section option-detail-actions">
      <h4>この選択肢の管理</h4>
      <div class="fb option-detail-feature"><label class="chk"><input type="checkbox" class="o-review" ${o.requires_review ? "checked" : ""}>この選択肢は見積もり・お客様の承諾後に予約確定</label>
        <p class="small">追加のデザイン希望などに使います。承諾前は枠を仮押さえし、製造数には含めません。写真必須にする場合は、この選択肢の質問で「画像を貼ってもらう」を必須にしてください。</p></div>
      <div class="acts">
        <button type="button" class="pill o-toggle">${o.is_available ? "停止する" : "提供を再開する"}</button>
        <button type="button" class="pill danger o-del">選択肢を削除</button>
      </div>
      </section>
    </div>`;

  const repaintMarks = () => { row.querySelector(".marks").innerHTML = marksHtml(o, ov); };
  for (const [column, selector] of [["pickup_from", ".o-from"], ["pickup_until", ".o-until"]]) {
    const input = row.querySelector(selector);
    regField("options", o.id, column, input, { get: () => input.value || null });
    input.addEventListener("input", () => { ov[column === "pickup_from" ? "from" : "until"] = input.value; paintGroup(); });
  }
  regField("options", o.id, "hide_outside_period", row.querySelector(".o-hide-outside"));
  const reviewEl = row.querySelector(".o-review");
  regField("options", o.id, "requires_review", reviewEl);
  reviewEl.addEventListener("change", () => { o.requires_review = reviewEl.checked; ov.review = reviewEl.checked; repaintMarks(); paintGroup(); });
  const sizeBox = row.querySelector(".o-size-prices");
  const sizeNames = [...new Set([
    ...(g.product_id == null ? state.products : [p]).flatMap(product => (product.product_variants || []).map(v => v.size_label)),
    ...Object.keys(o.size_prices || {}),
  ])];
  const priceInputs = sizeNames.map(name => {
    const label = document.createElement("label");
    label.textContent = `${name}：`;
    const currency = document.createElement("span"); currency.className = "lbl"; currency.textContent = "+¥";
    const input = document.createElement("input");
    input.type = "number"; input.className = "o-size-price";
    input.min = "0"; input.max = "1000000"; input.step = "1";
    input.placeholder = "共通"; input.setAttribute("aria-label", `${name}の追加料金（税込・円）`); input.value = o.size_prices?.[name] ?? "";
    label.append(currency, input); sizeBox.appendChild(label);
    input.addEventListener("input", () => {
      o.size_prices = Object.fromEntries(priceInputs.filter(x => x.input.value !== "").map(x => [x.name, Number(x.input.value)]));
      ov.sizePrices = {...o.size_prices}; markDirty(); repaintMarks(); paintGroup();
    });
    return {name, input};
  });
  regField("options", o.id, "size_prices", sizeBox, { get: () => Object.fromEntries(
    priceInputs.filter(x => x.input.value !== "").map(x => [x.name, Number(x.input.value)])) });
  const rowLight = () => row.closest(".grp").querySelector(`.pv-opts .crow[data-option-id="${o.id}"]`);

  const nameEl = row.querySelector(".oname");
  regField("options", o.id, "name", nameEl);
  nameEl.addEventListener("input", () => { ov.name = nameEl.value; paintGroup(); });
  linkLight(nameEl, rowLight);

  const priceEl = row.querySelector(".o-price");
  regField("options", o.id, "price_delta", priceEl, { get: () => parseInt(priceEl.value || "0", 10) || 0 });
  priceEl.addEventListener("input", () => { ov.price = parseInt(priceEl.value || "0", 10) || 0; paintGroup(); });
  linkLight(priceEl, rowLight);

  regField("options", o.id, "max_quantity", row.querySelector(".o-maxq"), { number: true });
  row.querySelector(".o-maxq").addEventListener("input", e => { ov.maxQty = Number(e.target.value); paintGroup(); });

  const deadlineEl = row.querySelector(".o-deadline");
  regField("options", o.id, "order_deadline_days", deadlineEl, {
    get: () => deadlineEl.value === "" ? null : Number(deadlineEl.value),
  });
  deadlineEl.addEventListener("input", () => {
    o.order_deadline_days = deadlineEl.value === "" ? null : Number(deadlineEl.value);
    ov.deadline = o.order_deadline_days; repaintMarks(); paintGroup();
  });

  const descEl = row.querySelector(".o-desc");
  regField("options", o.id, "description", descEl);
  descEl.addEventListener("input", () => { o.description = descEl.value; ov.description = descEl.value; repaintMarks(); paintGroup(); });

  const noteEl = row.querySelector(".o-note");
  regField("options", o.id, "note", noteEl);
  noteEl.addEventListener("input", () => { o.note = noteEl.value; ov.note = noteEl.value; repaintMarks(); paintGroup(); });
  regField("options", o.id, "note_accent", row.querySelector(".o-note-accent"));
  row.querySelector(".o-note-accent").addEventListener("change", e => { ov.accent = e.target.checked; paintGroup(); });

  // 開け閉めは画面の中だけで完結させる（保存も再描画も走らせない＝入力中でも安全）
  const moreBtn = row.querySelector(".o-more");
  moreBtn.onclick = () => {
    const open = !row.classList.contains("open");
    row.classList.toggle("open", open);
    row.querySelector(".more").classList.toggle("hidden", !open);
    moreBtn.textContent = `詳しい設定 ${open ? "▴" : "▾"}`;
    moreBtn.setAttribute("aria-expanded", String(open));
    if (open) state.openOptions.add(o.id); else state.openOptions.delete(o.id);
  };

  /* 選択肢の質問（この選択肢を選んだ人にだけ聞く） */
  const calendarAnswer = /カレンダー/.test(optDisplayName(o));
  const customAnswer = state.tenantSubdomain === "pokke" && (calendarAnswer || ["クッキープレート", "メッセージをケーキに直書き"].includes(optDisplayName(o)));
  if (qs.length && (customAnswer || o.preview_question_id || o.layer_url?.includes("{digit}"))) {
    const binding = document.createElement("label");
    binding.className = "sub";
    binding.textContent = "イラストに使う回答";
    if (customAnswer || o.layer_url?.includes("{digit}")) binding.insertAdjacentHTML("beforeend", " " + POKKE_ONLY_TAG);
    const select = document.createElement("select");
    select.className = "o-preview-question";
    select.innerHTML = `<option value="">自動判定（候補が1つのとき）</option>` + qs.filter(q => calendarAnswer ? q.input_type === "date" : ["text", "textarea"].includes(q.input_type)).map(q =>
      `<option value="${esc(q.id)}" ${q.id === o.preview_question_id ? "selected" : ""}>${esc(q.label || "質問文未入力")}</option>`).join("");
    binding.appendChild(select);
    row.querySelector(".o-qbox").before(binding);
    regField("options", o.id, "preview_question_id", select);
  }
  const qWrap = row.querySelector(".o-qbox");
  const questionRows = [];
  for (const q of qs) {
    const qView = ov.qs?.find((x) => x.id === q.id) || {
      id: q.id, label: q.label, type: q.input_type, required: q.is_required,
      active: q.is_active !== false, imageMax: imgMaxOf(q),
      help: q.help_text || "", helpAccent: !!q.help_accent, sample: q.sample_image_url || "",
      linkLabel: q.pastel_link_option_name ? (q.pastel_link_label || `${q.pastel_link_option_name}も同じ色にする`) : "",
      choices: qChoices(q).map((c) => ({ ...c })),
    };
    const item = document.createElement("div");
    item.className = "sub o-question-item" + (q.is_active === false ? " stopped" : "");
    item.innerHTML = `<p class="small">表示するケーキ：親の質問と同じ ／ 表示条件：「${esc(optDisplayName(o))}」を選んだとき</p><div class="o-question-bar"><span class="o-question-number">質問 ${questionRows.length + 1}</span><strong>${esc(q.label || "（質問文を入力してください）")}</strong>
      <span class="state-badge ${q.is_active === false ? "" : "on"}">${q.is_active === false ? "停止中" : "使用中"}</span>
      <button type="button" class="pill o-qtoggle">${q.is_active === false ? "再開する" : "停止する"}</button>
      <button type="button" class="pill danger o-qdel">質問を削除</button></div>`;
    const qLight = () => row.closest(".grp")?.querySelector(`.pv-opts .cfield[data-question-id="${q.id}"]`);
    const questionFields = buildQuestionFields(q, qView, paintGroup, { hideHelp: false, lightLabel: qLight });
    item.appendChild(questionFields);
    questionFields.querySelector(".q-label").addEventListener("input", (event) => {
      item.querySelector(".o-question-bar strong").textContent = event.currentTarget.value || "（質問文を入力してください）";
    });
    item.querySelector(".o-qtoggle").onclick = async () => {
      await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { is_active: q.is_active === false });
      reloadAll();
    };
    item.querySelector(".o-qdel").onclick = async () => {
      if (!confirm(`質問「${q.label || "（未入力）"}」を削除しますか？`)) return;
      try {
        await api("DELETE", `/rest/v1/common_question_choices?question_id=eq.${q.id}`);
        await api("DELETE", `/rest/v1/common_questions?id=eq.${q.id}`);
      } catch {
        await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { is_active: false });
        toast("すでに回答がある質問のため、削除ではなく停止しました");
      }
      reloadAll();
    };
    qWrap.appendChild(item);
    questionRows.push({ data: q, row: item, target: item.querySelector(".o-question-bar") });
  }
  addOrderControls(qWrap, questionRows, "common_questions", (ids) => {
    if (ov.qs) ov.qs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    [...qWrap.querySelectorAll(".o-question-number")].forEach((el, index) => { el.textContent = `質問 ${index + 1}`; });
    paintGroup();
  });
  row.querySelector(".o-qadd").onclick = async () => {
    await api("POST", "/rest/v1/common_questions", [{
      tenant_id: state.tenantId, label: "", input_type: "text",
      is_required: false, option_id: o.id,
      display_order: Math.max(-1, ...qs.map(q => Number(q.display_order) || 0)) + 1,
    }]);
    state.openOptions.add(o.id);
    toast("質問を追加しました（質問文と回答方法を設定してください）");
    await reloadAll();
  };

  row.querySelector(".o-photo").appendChild(buildPhotoField({
    url: o.photo_url,
    kind: "options",
    label: "見本写真（任意）",
    hint: "登録すると、お客様画面のオプションに「見本を見る」が表示されます",
    onChange: async (url) => {
      await api("PATCH", `/rest/v1/options?id=eq.${o.id}`, { photo_url: url });
      o.photo_url = url; ov.photo = url; repaintMarks(); paintGroup();
    },
  }));

  row.querySelector(".o-toggle").onclick = async () => {
    await api("PATCH", `/rest/v1/options?id=eq.${o.id}`, { is_available: !o.is_available });
    reloadAll();
  };
  row.querySelector(".o-del").onclick = async () => {
    const dependents = conditionDependents([o.id]);
    if (dependents.length) { toast(`「${dependents.join('」「')}」の表示条件に使われています。先にその条件を変更してください。`); return; }
    if (!confirm(`「${optDisplayName(o)}」を削除しますか？`)) return;
    try {
      await api("DELETE", `/rest/v1/option_exclusions?or=(option_a.eq.${o.id},option_b.eq.${o.id})`);
      for (const question of qs) {
        await api("DELETE", `/rest/v1/common_question_choices?question_id=eq.${question.id}`);
        await api("DELETE", `/rest/v1/common_questions?id=eq.${question.id}`);
      }
      await api("DELETE", `/rest/v1/options?id=eq.${o.id}`);
      toast("削除しました");
    } catch {
      toast("予約で使用されているため削除できません（停止をお使いください）");
    }
    reloadAll();
  };

  // 選択肢ごとの「できない日」（例: 犬ケーキ変更はまりほ不在日は不可）
  row.querySelector(".o-stops").onclick = async () => {
    const existing = row.querySelector(".stops-panel");
    if (existing) { existing.remove(); return; }
    const panel = document.createElement("div");
    panel.className = "excl-panel stops-panel";
    panel.innerHTML = `<span class="mini">「${esc(optDisplayName(o))}」をご用意できない日（受取日で選べなくなります）:</span>
      <div class="override-add" style="margin-top:6px">
        <input type="date" class="st-date">
        <button type="button" class="pill st-add">追加</button>
      </div>
      <div class="st-list"></div>`;
    const renderStops = async () => {
      const stops = await api("GET",
        `/rest/v1/option_availability_overrides?option_id=eq.${o.id}&order=date`);
      const lw = panel.querySelector(".st-list");
      lw.innerHTML = stops.length ? "" : `<span class="mini">登録なし</span>`;
      for (const s of stops) {
        const r2 = document.createElement("div");
        r2.className = "sl-item";
        r2.innerHTML = `<span style="flex:1">${esc(s.date)}</span><button type="button" class="pill danger">解除</button>`;
        r2.querySelector("button").onclick = async () => {
          await api("DELETE", `/rest/v1/option_availability_overrides?id=eq.${s.id}`);
          renderStops();
        };
        lw.appendChild(r2);
      }
    };
    panel.querySelector(".st-add").onclick = async () => {
      const date = panel.querySelector(".st-date").value;
      if (!date) { toast("日付を選んでください"); return; }
      await api("POST", "/rest/v1/option_availability_overrides", [{
        tenant_id: state.tenantId, option_id: o.id, date,
      }]);
      panel.querySelector(".st-date").value = "";
      toast(`${date} は「${optDisplayName(o)}」を受け付けません`);
      renderStops();
    };
    row.querySelector(".option-detail-rule-actions").appendChild(panel);
    renderStops();
  };

  row.querySelector(".o-excl").onclick = () => {
    const existing = row.querySelector(".excl-panel:not(.stops-panel)");
    if (existing) { existing.remove(); return; }
    const panel = document.createElement("div");
    panel.className = "excl-panel";
    panel.innerHTML = `<span class="mini">「${esc(optDisplayName(o))}」と一緒に選べないものをタップ（ピンク=一緒に選べない）:</span><br>`;
    const others = groupsForProduct(p)
      .flatMap((gg) => gg.options.filter((oo) => oo.id !== o.id).map((oo) => ({ g: gg, o: oo })));
    for (const { g: gg, o: oo } of others) {
      const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);
      const [pa, pb] = pairKey(o.id, oo.id);
      const has = p.option_exclusions.some((e) => e.option_a === pa && e.option_b === pb);
      const chip = document.createElement("span");
      chip.className = "chip" + (has ? " on" : "");
      chip.textContent = `${gg.name}: ${optDisplayName(oo)}`;
      // 連続して選べるよう、パネルは閉じずにその場で切り替える（画面全体は再描画しない）
      chip.onclick = async () => {
        const wasOn = chip.classList.contains("on");
        chip.classList.toggle("on", !wasOn); // 先に見た目を変える（待たされない）
        try {
          if (wasOn) {
            await api("DELETE", `/rest/v1/option_exclusions?product_id=eq.${p.id}&option_a=eq.${pa}&option_b=eq.${pb}`);
            const i = p.option_exclusions.findIndex((e) => e.option_a === pa && e.option_b === pb);
            if (i >= 0) p.option_exclusions.splice(i, 1);
            toast(`「${optDisplayName(oo)}」との組み合わせを解除しました`);
          } else {
            await api("POST", "/rest/v1/option_exclusions", [{
              tenant_id: state.tenantId, product_id: p.id, option_a: pa, option_b: pb,
            }]);
            p.option_exclusions.push({ product_id: p.id, option_a: pa, option_b: pb });
            toast(`「${optDisplayName(oo)}」と一緒に選べないようにしました`);
          }
        } catch (e) {
          chip.classList.toggle("on", wasOn); // 失敗したら戻す
          toast("設定できませんでした：" + e.message);
        }
      };
      panel.appendChild(chip);
    }
    // ボタンのすぐ下に出す（離れた場所に出ると気づけないため）
    row.querySelector(".option-detail-rule-actions").appendChild(panel);
  };
  return row;
}

/* ---------- グループ追加 ---------- */
$("btn-g-add").onclick = async () => {
  const p = state.current, name = $("g-name").value.trim(), type = $("g-type").value;
  if (!p || !name) { toast("質問文を入れてください"); return; }
  try {
    await api("POST", "/rest/v1/rpc/fn_add_product_question", {
      p_product:p.id,p_label:name,p_type:type,p_required:$("g-required").checked,
    });
    $("g-name").value = ""; $("g-required").checked = false;
    toast(`質問「${name}」を追加しました`); await reloadAll();
  } catch (e) { toast(`追加できませんでした：${e.message}`); }
};

/* ---------- 質問・回答の並べ替え ---------- */
// 要素を移動するだけにして、入力中の文章・開閉状態を保つ。保存は既存の保存バーで行う。
function addOrderControls(container, items, table, onMove = () => {}, persistOrder = true) {
  const compact = table === "common_question_choices" || table === "options";
  const entries = items.map(({ data, row, target }) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.value = data.display_order ?? 0;
    row.appendChild(input);
    if (persistOrder) regField(table, data.id, "display_order", input, { number: true });
    const controls = document.createElement("span");
    controls.className = "question-order" + (compact ? " compact" : "");
    if (!compact) {
      const label = document.createElement("span");
      label.className = "question-order-label";
      label.textContent = "表示順";
      controls.appendChild(label);
    }
    const buttons = [-1, 1].map((direction) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pill";
      button.textContent = compact ? (direction < 0 ? "↑" : "↓") : (direction < 0 ? "↑ 上へ" : "↓ 下へ");
      button.setAttribute("aria-label", direction < 0 ? "上へ移動" : "下へ移動");
      button.onclick = () => {
        if (state.saving) return;
        const index = entries.findIndex(e => e.data.id === data.id), next = index + direction;
        if (next < 0 || next >= entries.length) return;
        const a = entries[index], b = entries[next];
        if (direction < 0) container.insertBefore(a.row, b.row);
        else container.insertBefore(b.row, a.row);
        [entries[index], entries[next]] = [b, a];
        entries.forEach((entry, order) => { entry.input.value = order; });
        update();
        onMove(entries.map(entry => entry.data.id));
        markDirty();
      };
      controls.appendChild(button);
      return button;
    });
    target.appendChild(controls);
    return { data, row, input, buttons };
  });
  function update() {
    entries.forEach((entry, index) => {
      entry.buttons[0].disabled = index === 0;
      entry.buttons[1].disabled = index === entries.length - 1;
    });
  }
  update();
}

function renderQuestions() { renderGroups(state.current); }

function buildQuestionBox(q) {
  const box = document.createElement("div");
  box.className = "q" + (q.is_active ? "" : " stopped");
  const picked = new Set(q._product_ids ?? (q.common_question_products || []).map((r) => r.product_id));
  const isAll = q.scope !== "selected";
  box.innerHTML = `
    <div class="q-bar">
      <input type="text" class="qname inplace" value="${esc(q.label)}" aria-label="質問文" placeholder="質問文">
      <span class="state-badge ${q.is_active ? "on" : ""}">${q.is_active ? "使用中" : "停止中"}</span>
      <button type="button" class="pill q-toggle">${q.is_active ? "停止する" : "再開する"}</button>
      <button type="button" class="pill danger q-del">質問を削除</button>
    </div>
    <div class="q-body">
      <div class="q-main">
      <div class="qrow"><div class="k">質問の内容</div><div class="v q-fields-wrap"></div></div>
      </div>
      <div class="cust">
        <p class="cap">お客様に見える内容</p>
        <button type="button" class="pill preview-try">予約画面で選択を試す</button>
        <div class="card">
          <h4><span class="pv-label"></span><span class="req pv-req">必須</span></h4>
          <div class="pv-body"></div>
        </div>
      </div>
    </div>`;

  const view = {
    label: q.label, required: !!q.is_required, type: q.input_type, imageMax: imgMaxOf(q),
    help: q.help_text || "", helpAccent: !!q.help_accent,
    linkLabel:q.pastel_link_option_name?(q.pastel_link_label||`${q.pastel_link_option_name}も同じ色にする`):'',
    sample: q.sample_image_url,
    choices: qChoices(q).map((c) => ({ ...c })),
  };
  const paint = () => {
    box.querySelector(".pv-label").textContent = view.label || "（質問文）";
    box.querySelector(".pv-req").classList.toggle("hidden", !view.required);
    box.querySelector(".pv-body").innerHTML =
      (view.help ? `<span class="cfield-help ${view.helpAccent ? "note-accent" : ""}">${esc(view.help)}</span>` : "") +
      (view.sample ? `<span class="pv-sample"><img src="${esc(view.sample)}" alt=""></span>` : "") +
      answerFieldHtml(view);
    applyLight();
  };

  // 見出しの質問文と、下の質問エディタのラベル欄は同じ項目。見出し側だけ出して重複させない
  const fields = buildQuestionFields(q, view, paint, { lightLabel: () => box.querySelector(".pv-label") });
  fields.querySelector(".q-label").remove();
  box.querySelector(".q-fields-wrap").appendChild(fields);
  box.querySelector(".q-bar").append(fields.querySelector('.question-answer-type'), fields.querySelector('.q-req').closest('label'));

  const nameEl = box.querySelector(".qname");
  regField("common_questions", q.id, "label", nameEl);
  nameEl.addEventListener("input", () => { view.label = nameEl.value; paint(); });
  linkLight(nameEl, () => box.querySelector(".pv-label"));

  buildQuestionSettings(q, "question", box.querySelector(".q-bar"), box.querySelector(".q-main"));

  box.querySelector(".q-toggle").onclick = async () => {
    await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { is_active: !q.is_active });
    toast(q.is_active ? "質問を停止しました（フォームに出なくなります）" : "質問を再開しました");
    reloadAll();
  };
  box.querySelector(".q-del").onclick = async () => {
    if (!confirm(`質問「${q.label}」を削除しますか？`)) return;
    try {
      await api("DELETE", `/rest/v1/common_question_choices?question_id=eq.${q.id}`);
      await api("DELETE", `/rest/v1/common_question_products?question_id=eq.${q.id}`);
      await api("DELETE", `/rest/v1/common_questions?id=eq.${q.id}`);
      toast("削除しました");
    } catch {
      await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { is_active: false });
      toast("すでに回答がある質問のため、削除ではなく停止しました");
    }
    reloadAll();
  };

  paint();
  return box;
}

/* ---------- プレビューの出し入れ（狭い画面） ----------
 * 入力しながら常時見るのではなく、見たいときに全面で出す。
 * 画面のどこにいても押せるボタンを1つ置き、プレビューまで探しに行かなくていいようにする。 */
const narrowScreen = () => window.matchMedia("(max-width: 919px)").matches;
function nearestPreview() {
  const mid = window.innerHeight / 2;
  let best = null, bestD = Infinity;
  document.querySelectorAll(".grp, .q").forEach((sec) => {
    const r = sec.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bestD) { bestD = d; best = sec; }
  });
  return (best || document.querySelector(".grp, .q"))?.querySelector(".cust") || null;
}
function closePreview() {
  document.querySelectorAll(".cust.peeking").forEach((c) => c.classList.remove("peeking"));
  document.body.style.overflow = "";
  syncFab();
}
function openPreview() {
  const c = nearestPreview();
  if (!c) { toast("プレビューできるものがありません"); return; }
  document.querySelectorAll(".cust.peeking").forEach((x) => x.classList.remove("peeking"));
  c.classList.add("peeking");
  document.body.style.overflow = "hidden"; // 後ろのページが一緒に動かないように
  syncFab();
}
function syncFab() {
  const on = !!document.querySelector(".cust.peeking");
  $("fab").textContent = on ? "✕ 閉じる" : "プレビュー";
  $("fab").setAttribute("aria-pressed", String(on));
}
$("fab").onclick = () => (document.querySelector(".cust.peeking") ? closePreview() : openPreview());
window.addEventListener("resize", () => { if (!narrowScreen()) closePreview(); });
syncFab();


/* ---------- 保存忘れ警告 ---------- */
state.dirty = false;
window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- 起動 ---------- */
(async () => {
  loadSession();
  if (!state.session) { showLogin(); return; }
  try {
    const tu = await api("GET", "/rest/v1/tenant_users?select=tenant_id");
    if (!tu.length) { showLogin(); return; }
    state.tenantId = tu[0].tenant_id;
    $("view-app").classList.remove("hidden");
    // お客様画面プレビューリンク
    const [t, closedOverrides] = await Promise.all([
      api("GET", `/rest/v1/tenants?id=eq.${tu[0].tenant_id}&select=id,name,subdomain,timezone,closed_weekdays,billing_status,trial_ends_at,theme,customer_form,preview_note,reservation_plan,booking_window_days,cancel_policy,tokushoho`),
      api("GET", `/rest/v1/date_overrides?tenant_id=eq.${tu[0].tenant_id}&kind=eq.closed&select=date`),
    ]);
    state.tenant = t[0];
    state.tenantTimezone = t[0].timezone || "Asia/Tokyo";
    state.tenantSubdomain = t[0].subdomain;
    state.closedWeekdays = t[0].closed_weekdays || [];
    state.closedDates = new Set(closedOverrides.map((row) => row.date));
    $("preview-link").href = `../?shop=${t[0].subdomain}${t[0].billing_status === "setup_trial" ? "&trial=1" : ""}`;
    await loadAll(false);
  } catch {
    showLogin();
  }
})();


// Use the real customer renderer with a snapshot of unsaved fields.
$("draft-preview-open").onclick = async () => {
  if (!state.tenant || !state.current) { toast("プレビューする商品を選んでください"); return; }
  const button = $("draft-preview-open");
  button.disabled = true;
  try {
    drafts.capture(state.fields);
    const product = drafts.overlay("products", state.current);
    const allGroups = drafts.overlay("option_groups", [...state.products.flatMap(p => p.option_groups || []), ...state.globalGroups]);
    product.option_groups = allGroups.filter(g => g.product_id === product.id);
    const groups = allGroups.filter(g => g.product_id === null);
    const questions = drafts.overlay("common_questions", state.questions).map(q => q._product_ids ? {...q,
      common_question_products:q._product_ids.map(product_id=>({product_id}))} : q);
    const slots = await api("GET", `/rest/v1/pickup_time_slots?tenant_id=eq.${state.tenantId}&order=display_order&select=*`);
    const catalog = {tenant:state.tenant, products:[product], globalGroups:groups, questions, slots};
    const dialog = document.createElement("dialog");
    dialog.className = "draft-preview-dialog";
    dialog.innerHTML = `<div class="draft-preview-toolbar"><strong>編集内容の確認</strong>
      <label>画面幅 <select><option value="100%">パソコン</option><option value="390px">スマホ</option></select></label>
      <button type="button" class="pill">閉じる</button></div><iframe title="編集内容を使った予約画面"></iframe>`;
    const frame = dialog.querySelector("iframe");
    const sendCatalog = e => {
      if (e.origin === location.origin && e.source === frame.contentWindow && e.data?.type === "cake-editor-ready")
        frame.contentWindow.postMessage({type:"cake-editor-catalog",catalog}, location.origin);
    };
    window.addEventListener("message", sendCatalog);
    dialog.addEventListener("close", () => { window.removeEventListener("message",sendCatalog); dialog.remove(); button.focus(); });
    dialog.querySelector("button").onclick = () => dialog.close();
    dialog.querySelector("select").onchange = e => { frame.style.width = e.target.value; };
    document.body.appendChild(dialog);
    dialog.showModal();
    frame.src = `../index.html?shop=${encodeURIComponent(state.tenantSubdomain)}&preview=editor`;
  } catch (e) { toast(`プレビューを開けませんでした：${e.message}`); }
  finally { button.disabled = false; }
};

// 見た目のプレビューから、その場で操作できる予約画面へ進める。
document.addEventListener("click", event => {
  if (!event.target.closest(".preview-try")) return;
  closePreview();
  $("draft-preview-open").click();
});
