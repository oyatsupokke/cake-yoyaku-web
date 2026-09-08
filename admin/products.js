/* =====================================================================
 * 商品エディタ v1
 * - 基本情報 / 季節設定（販売期間・受取期間・受取曜日）/ サイズと価格
 * - 選択グループ＆選択肢（追加料金・個数上限・記入欄・注意書き・排他ペア）
 * - 共有リスト（果物など）: 項目の追加は、参照している全商品のグループへ
 *   リンク行を自動作成する（設計メモ「リンク行方式」の実装）
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
  session: null, tenantId: null, products: [], sharedLists: [], questions: [], globalGroups: [],
  categories: [],
  current: null, fields: [],
  // 選択肢の「詳しい設定」を開いているもの。普段はたたんでおく（画面が縦に延々と続かないように）
  openOptions: new Set(),
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
  $("save-status").textContent = state.dirty ? "保存していない変更があります" : "変更はありません";
  $("btn-save-all").disabled = !!state.saving || !state.dirty;
}
async function saveChange(c) {
  if (c.table === "_product_capacity") return saveCapacityRule(c);
  if (c.table === "products") {
    const source = state.products.find(p => p.id === c.id) || {};
    const next = { ...source, ...c.patch };
    if (next.pickup_mode === "dates" && !(next.pickup_dates || []).length)
      throw new Error("日付で指定する場合は、受取日を1日以上追加してください");
    if (next.pickup_mode === "period" && next.pickup_start_date && next.pickup_end_date && next.pickup_start_date > next.pickup_end_date)
      throw new Error("受取期間の終了日は、開始日以降にしてください");
  }
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

async function saveAll() {
  if (state.saving) return;
  const changes = collectChanges();
  if (!changes.length) { toast("変更はありません"); return; }
  const btn = $("btn-save-all");
  state.saving = true;
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    for (const c of changes) {
      await saveChange(c);
      drafts.acknowledge(c, state.fields);
    }
    toast(`保存しました（${changes.length}件）`);
    state.dirty = false;
    await loadAll();
  } catch (e) {
    toast("保存できませんでした：" + e.message);
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
    const [ps, os, gs, qs] = await Promise.all([
      api("GET", `/rest/v1/products?or=(photo_url.eq.${u},layer_url.eq.${u})&deleted_at=is.null&select=id`),
      api("GET", `/rest/v1/options?or=(photo_url.eq.${u},layer_url.eq.${u})&select=id`),
      api("GET", `/rest/v1/option_groups?or=(default_layer_url.eq.${u},sample_image_url.eq.${u})&select=id`),
      api("GET", `/rest/v1/common_questions?sample_image_url=eq.${u}&select=id`),
    ]);
    if (ps.length + os.length + gs.length + qs.length > 0) return; // 自分の行は呼び出し前に外れている
  } catch { /* 数えられなければ従来どおり消す */ }
  const path = url.slice(i + marker.length);
  await fetch(`${CONFIG.url}/storage/v1/object/shop-images/${path}`, {
    method: "DELETE",
    headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}` },
  }).catch(() => {});
}

// イラストレイヤーの欄（素材＋重ね順）。市松模様の背景で透過が分かるようにする
function buildLayerField(opts) {
  const { url, z, label, hint, showZ, onChange } = opts;
  const box = document.createElement("div");
  box.className = "photo-field";
  box.innerHTML = `
    <span class="text-field-label">${esc(label)}</span>
    <div class="photo-body">
      <div class="photo-thumb layer-thumb ${url ? "" : "empty"}">${url ? `<img src="${esc(url)}" alt="">` : "なし"}</div>
      <div class="photo-actions">
        <label class="pill photo-pick">イラストを選ぶ<input type="file" accept="image/png" hidden></label>
        <button type="button" class="pill danger photo-del" ${url ? "" : "hidden"}>削除</button>
        ${showZ ? `<span class="mini">重ね順</span><input type="number" class="layer-z" value="${esc(z)}" placeholder="20" style="width:70px">` : ""}
        ${hint ? `<span class="mini photo-hint">${esc(hint)}</span>` : ""}
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
  return box;
}

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
        ${hint ? `<span class="mini photo-hint">${esc(hint)}</span>` : ""}
      </div>
    </div>`;
  const input = box.querySelector('input[type="file"]');
  const pick = box.querySelector(".photo-pick");
  input.onchange = async () => {
    const file = input.files?.[0];
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
  const [products, lists, questions, globalGroups, categories] = await Promise.all([
    api("GET", `/rest/v1/products?tenant_id=eq.${state.tenantId}&deleted_at=is.null&order=display_order` +
      `&select=*,product_variants(*),option_groups(*,options(*,shared_list_items(*))),option_exclusions(*)`),
    api("GET", `/rest/v1/shared_lists?tenant_id=eq.${state.tenantId}&select=*,shared_list_items(*)`),
    api("GET", `/rest/v1/common_questions?tenant_id=eq.${state.tenantId}&order=display_order` +
      `&select=*,common_question_choices(*),common_question_products(product_id)`),
    api("GET", `/rest/v1/option_groups?tenant_id=eq.${state.tenantId}&product_id=is.null&order=display_order` +
      `&select=*,options(*,shared_list_items(*))`),
    api("GET", `/rest/v1/categories?tenant_id=eq.${state.tenantId}&order=display_order`),
  ]);
  state.products = products;
  state.sharedLists = lists;
  state.questions = questions;
  state.globalGroups = globalGroups;
  state.categories = categories;
  if (keepCurrent && state.current) {
    state.current = products.find((p) => p.id === state.current.id) || products[0] || null;
  } else {
    state.current = products[0] || null;
  }
  state.fields = []; // 入力欄の登録をやり直す
  renderTabs();
  renderEditor();
  await state.capacityLoading;
  renderQuestions();
  renderCategories();
  renderSharedLists();
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
  $("editor").classList.toggle("hidden", !p);
  if (!p) return;

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

  // イラスト土台（設定するとプレビューが合成モードになる）
  const layerWrap = $("p-layer");
  layerWrap.innerHTML = "";
  layerWrap.appendChild(buildLayerField({
    url: p.layer_url,
    label: "イラスト土台（一番下に敷く絵）",
    hint: "透過PNG・800×800px",
    showZ: false,
    onChange: ({ url }) => api("PATCH", `/rest/v1/products?id=eq.${p.id}`, { layer_url: url }),
  }));

  state.capacityLoading = loadCapacityRule(p);
  renderVariants(p);
  renderGroups(p);
  renderProductStops(p);
  // 共有リストのプルダウン（グループ追加用）
  $("g-shared").innerHTML = `<option value="">共有リストを使わない</option>` +
    state.sharedLists.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}を使う</option>`).join("");
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
  { v: "select", label: "プルダウン" },
  { v: "radio", label: "ラジオボタン（1つ選ぶ）" },
  { v: "checkbox", label: "チェックボックス（複数選べる）" },
  { v: "image", label: "画像を貼ってもらう" },
];
const needsChoices = (t) => t === "select" || t === "radio" || t === "checkbox";
const imgMaxOf = (q) => Math.min(Math.max(parseInt(q?.image_max, 10) || 3, 1), 3);
const qChoices = (q) => [...(q?.common_question_choices || [])].sort((a, b) => a.display_order - b.display_order || a.id.localeCompare(b.id));
const typeOptions = (sel) => Q_TYPES.map((t) =>
  `<option value="${t.v}" ${t.v === sel ? "selected" : ""}>${t.label}</option>`).join("");
const questionOf = (optionId) => state.questions.find((q) => q.option_id === optionId) || null;

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

/* お客様側の回答欄がどう見えるか（プレビュー用・操作はできない） */
function answerFieldHtml(view) {
  const cs = view.choices;
  if (view.type === "textarea") return `<textarea rows="2" disabled></textarea>`;
  if (view.type === "select") {
    return `<select disabled>${cs.map((c) => `<option>${esc(c.label || "（未入力）")}</option>`).join("")}</select>`;
  }
  if (view.type === "radio" || view.type === "checkbox") {
    const t = view.type === "radio" ? "radio" : "checkbox";
    return cs.map((c) => `<label class="pick"><input type="${t}" disabled>${esc(c.label || "（未入力）")}</label>`).join("")
      || `<span class="mini">回答の選択肢がまだありません</span>`;
  }
  if (view.type === "image") {
    return `<span class="q-img-preview">📷 写真を選ぶ` +
      `<span class="mini">（お客様は${esc(view.imageMax || 3)}枚まで貼れます）</span></span>`;
  }
  return `<input type="text" disabled>`;
}

/* 質問エディタ（共通の質問・選択肢の質問で同じ部品を使う）
 * 戻り値の要素の中で、ラベル/必須/形式/回答の選択肢を編集できる。
 * ラベル・形式・選択肢名は「まとめて保存」、選択肢の追加・削除はその場で反映する。 */
function buildQuestionFields(q, view, onPaint, opts = {}) {
  const box = document.createElement("div");
  box.className = "sub q-fields";
  box.innerHTML = `
    <input type="text" class="q-label" value="${esc(q.label)}" placeholder="質問文（お客様に見えます）">
    <select class="q-type">${typeOptions(q.input_type)}</select>
    <label class="chk"><input type="checkbox" class="q-req" ${q.is_required ? "checked" : ""}>必須にする</label>
    <label class="chk q-imgmax ${q.input_type === "image" ? "" : "hidden"}">枚数
      <select class="q-imgmax-sel">${[1, 2, 3].map((n) =>
        `<option value="${n}" ${n === imgMaxOf(q) ? "selected" : ""}>${n}枚まで</option>`).join("")}</select>
    </label>
    <div class="sub q-choices ${needsChoices(q.input_type) ? "" : "hidden"}"></div>
    ${opts.hideHelp ? "" : `<input type="text" class="q-help" value="${esc(q.help_text)}" placeholder="補足（任意・質問の下に小さく出ます）">`}`;

  const labelEl = box.querySelector(".q-label");
  regField("common_questions", q.id, "label", labelEl);
  labelEl.addEventListener("input", () => { view.label = labelEl.value; onPaint(); });
  if (opts.lightLabel) linkLight(labelEl, opts.lightLabel);

  const helpEl = box.querySelector(".q-help");
  if (helpEl) regField("common_questions", q.id, "help_text", helpEl);

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
    onChange: (url) => api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { sample_image_url: url }),
  }));
  box.appendChild(sample);

  const maxEl = box.querySelector(".q-imgmax-sel");
  regField("common_questions", q.id, "image_max", maxEl,
    { get: () => parseInt(maxEl.value, 10) || 3 });
  maxEl.addEventListener("change", () => { view.imageMax = parseInt(maxEl.value, 10) || 3; onPaint(); });

  const typeEl = box.querySelector(".q-type");
  regField("common_questions", q.id, "input_type", typeEl);
  typeEl.addEventListener("change", () => {
    view.type = typeEl.value;
    box.querySelector(".q-choices").classList.toggle("hidden", !needsChoices(view.type));
    box.querySelector(".q-imgmax").classList.toggle("hidden", view.type !== "image");
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
      <button type="button" class="pill danger c-del">削除</button>`;
    const cl = row.querySelector(".c-label");
    regField("common_question_choices", c.id, "label", cl);
    cl.addEventListener("input", () => {
      const target = view.choices.find((x) => x.id === c.id);
      if (target) target.label = cl.value;
      onPaint();
    });
    regField("common_question_choices", c.id, "price_delta", row.querySelector(".c-price"),
      { get: () => parseInt(row.querySelector(".c-price").value || "0", 10) || 0 });
    row.querySelector(".c-del").onclick = async () => {
      try {
        await api("DELETE", `/rest/v1/common_question_choices?id=eq.${c.id}`);
      } catch {
        toast("すでに回答がある選択肢のため消せません");
      }
      reloadAll();
    };
    chWrap.appendChild(row);
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
    chWrap.prepend(note);
  }
  {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "pill ghost";
    add.textContent = "＋ 回答の選択肢を追加";
    add.onclick = async () => {
      await api("POST", "/rest/v1/common_question_choices", [{
        tenant_id: state.tenantId, question_id: q.id, label: "",
        display_order: Math.max(-1, ...qChoices(q).map(c => Number(c.display_order) || 0)) + 1,
      }]);
      reloadAll();
    };
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
  if (item?.available_from || item?.available_until) {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: state.tenantTimezone || "Asia/Tokyo" }).format(new Date());
    if ((item.available_from && today < item.available_from) || (item.available_until && today > item.available_until))
      return { available: false, label: "共有リストの提供期間外" };
  }
  return { available: true, label: "提供中" };
}
// この商品に出るグループ = その商品のグループ ＋「すべてのケーキに出す」グループ
function groupsForProduct(p) {
  return [...p.option_groups, ...state.globalGroups]
    .sort((a, b) => (a.display_order - b.display_order) || (a.product_id ? -1 : 1));
}
function renderGroups(p) {
  const wrap = $("groups-list");
  wrap.innerHTML = "";
  const groups = groupsForProduct(p);
  if (!groups.length) wrap.innerHTML = `<p class="small">グループがありません。下から追加してください。</p>`;
  for (const g of groups) wrap.appendChild(buildGroupBox(p, g));
}

function buildGroupBox(p, g) {
  const box = document.createElement("div");
  box.className = "grp";
  const isGlobal = g.product_id === null;
  const sharedNote = g.shared_list_id
    ? `<span class="tag">📎 ${esc(state.sharedLists.find((l) => l.id === g.shared_list_id)?.name || "共有リスト")}</span>`
    : "";
  box.innerHTML = `
    <div class="grp-bar">
      <input type="text" class="gname inplace" value="${esc(g.name)}" aria-label="グループ名">
      <select class="gh-type">
        <option value="single" ${g.selection_type === "single" ? "selected" : ""}>1つ選ぶ</option>
        <option value="multiple" ${g.selection_type === "multiple" ? "selected" : ""}>複数選べる</option>
      </select>
      <label class="chk"><input type="checkbox" class="gh-req" ${g.is_required ? "checked" : ""}>必須</label>
      ${isGlobal ? `<span class="tag hi">すべてのケーキに出す</span>` : ""}
      ${sharedNote}
    </div>
    <div class="grp-body">
      <div class="grp-main">
      <div class="fb"><span class="k">説明</span>
        <textarea class="gh-desc" rows="2" placeholder="例: お好きな果物をお選びください">${esc(g.description)}</textarea></div>
      <div class="fb"><span class="k">注意書き</span>
        <textarea class="gh-note" rows="2" placeholder="例: ※果物は季節により異なります">${esc(g.note)}</textarea>
        <label class="chk"><input type="checkbox" class="gh-note-accent" ${g.note_accent ? "checked" : ""}>目立たせる（赤・太字）</label></div>
      <div class="g-default-layer"></div>
      <div class="g-sample"></div>
      <p class="meta">選択肢 ${g.options.length}件</p>
      <div class="g-options"></div>
      <div class="override-add g-add-row ${g.shared_list_id ? "hidden" : ""}">
        <input type="text" class="ga-name" placeholder="選択肢名" style="width:150px">
        <input type="number" class="ga-price" placeholder="+円" min="0" style="width:80px">
        <button type="button" class="pill ga-add">＋ 選択肢を追加</button>
      </div>
      <div class="acts">
        <label class="chk"><input type="checkbox" class="gh-all" ${isGlobal ? "checked" : ""}>すべてのケーキに出す</label>
        <button type="button" class="pill danger gh-del">グループを削除</button>
      </div>
      </div>
      <div class="cust">
        <p class="cap">お客様向けプレビュー（停止中の項目は非表示）</p>
        <div class="card">
          <h4><span class="pv-name"></span><span class="req pv-req">必須</span></h4>
          <p class="desc pv-desc"></p>
          <p class="cnote pv-note"></p>
          <div class="pv-opts"></div>
        </div>
      </div>
    </div>`;

  // 画面に出す値の写し。入力のたびにここを更新してプレビューを描き直す
  const view = {
    name: g.name, required: !!g.is_required, single: g.selection_type === "single",
    desc: g.description || "", note: g.note || "", accent: !!g.note_accent,
    opts: [...g.options].sort((a, b) => a.display_order - b.display_order).map((o) => {
      const q = questionOf(o.id);
      return {
        id: o.id, name: optDisplayName(o), price: o.price_delta, available: optionAvailability(o).available,
        q: q ? {
          label: q.label, type: q.input_type, required: q.is_required, imageMax: imgMaxOf(q),
          choices: qChoices(q).map((c) => ({ id: c.id, label: c.label })),
        } : null,
      };
    }),
  };
  const paint = () => {
    box.querySelector(".pv-name").textContent = view.name || "（グループ名）";
    box.querySelector(".pv-req").classList.toggle("hidden", !view.required);
    const d = box.querySelector(".pv-desc");
    d.textContent = view.desc; d.classList.toggle("hidden", !view.desc.trim());
    const n = box.querySelector(".pv-note");
    n.textContent = view.note; n.classList.toggle("hidden", !view.note.trim());
    n.classList.toggle("accent", view.accent);
    box.querySelector(".pv-opts").innerHTML = view.opts.filter(o => o.available).map((o) => `
      <div class="crow" data-option-id="${esc(o.id)}">
        <span>${view.single ? "○" : "☐"} ${esc(o.name || "（名前なし）")}</span>
        <span>${o.price ? "+¥" + o.price.toLocaleString("ja-JP") : "無料"}</span>
      </div>
      ${o.q ? `<div class="cfield" data-option-id="${esc(o.id)}">${esc(o.q.label || "（質問文）")}${answerFieldHtml(o.q)}</div>` : ""}`).join("");
    applyLight();
  };

  const nameEl = box.querySelector(".gname");
  regField("option_groups", g.id, "name", nameEl);
  nameEl.addEventListener("input", () => { view.name = nameEl.value; paint(); });
  linkLight(nameEl, () => box.querySelector(".pv-name"));

  const typeEl = box.querySelector(".gh-type");
  regField("option_groups", g.id, "selection_type", typeEl);
  typeEl.addEventListener("change", () => { view.single = typeEl.value === "single"; paint(); });

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

  const allEl = box.querySelector(".gh-all");
  regField("option_groups", g.id, "product_id", allEl,
    { get: () => allEl.checked ? null : p.id });

  box.querySelector(".gh-del").onclick = async () => {
    const scope = isGlobal
      ? `\n（すべてのケーキに出しているグループです。${state.products.length}個のケーキ全部から消えます）` : "";
    if (!confirm(`グループ「${g.name}」を選択肢ごと削除しますか？${scope}`)) return;
    try {
      const ids = g.options.map((o) => o.id).join(",");
      if (ids) {
        await api("DELETE", `/rest/v1/option_exclusions?or=(option_a.in.(${ids}),option_b.in.(${ids}))`);
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
    onChange: (url) => api("PATCH", `/rest/v1/option_groups?id=eq.${g.id}`, { sample_image_url: url }),
  }));
  box.querySelector(".g-default-layer").appendChild(buildLayerField({
    url: g.default_layer_url,
    z: g.default_layer_z,
    label: "このグループで何も選ばれていないときのイラスト（任意）",
    hint: "透過PNG・800×800px",
    showZ: true,
    onChange: (patch) => api("PATCH", `/rest/v1/option_groups?id=eq.${g.id}`,
      patch.url !== undefined ? { default_layer_url: patch.url } : { default_layer_z: patch.z }),
  }));

  regField("option_groups", g.id, "default_layer_z", box.querySelector(".g-default-layer .layer-z"), { number: true });
  const optWrap = box.querySelector(".g-options");
  view.opts.forEach((ov, i) => {
    const o = g.options.find((x) => x.id === ov.id);
    optWrap.appendChild(buildOptionRow(p, g, o, view, ov, i, paint));
  });

  paint();
  return box;
}

/* たたんだままでも中身が分かる印（開かないと分からない状態にしない） */
function marksHtml(o, ov) {
  const mk = (on, yes, no) => `<span class="mk ${on ? "" : "off"}">${on ? yes : no}</span>`;
  return mk(!!(o.description || "").trim(), "説明あり", "説明なし")
    + mk(!!(o.note || "").trim(), "注意書きあり", "注意書きなし")
    + mk(!!ov.q, "質問あり", "質問なし")
    + mk(!!(o.photo_url || o.layer_url), "写真あり", "写真なし");
}

function buildOptionRow(p, g, o, view, ov, index, paintGroup) {
  const row = document.createElement("div");
  const open = state.openOptions.has(o.id);
  const availability = optionAvailability(o);
  row.className = "opt" + (open ? " open" : "") + (availability.available ? "" : " stopped");
  const isLinked = !!o.shared_list_item_id;
  const q = questionOf(o.id);
  row.innerHTML = `
    <div class="opt-line">
      <input type="text" class="oname inplace" value="${esc(isLinked ? optDisplayName(o) : o.name)}" aria-label="選択肢名"
        placeholder="${esc(isLinked ? optDisplayName(o) + "（共有リスト）" : "選択肢名")}" ${isLinked ? "disabled" : ""}>
      <span class="lbl">+¥</span><input type="number" class="o-price" min="0" value="${esc(o.price_delta)}">
      <span class="lbl">個数上限</span><input type="number" class="o-maxq maxq" min="1" placeholder="1" value="${esc(o.max_quantity)}">
      <span class="state-badge ${availability.available ? "on" : ""}">${availability.label}</span>
      <button type="button" class="pill o-more" aria-expanded="${open}">詳しい設定 ${open ? "▴" : "▾"}</button>
    </div>
    <div class="marks">${marksHtml(o, ov)}</div>
    <div class="more ${open ? "" : "hidden"}">
      <div class="fb"><span class="k">説明</span>
        <textarea class="o-desc" rows="2" placeholder="例: 側面のクリームが剥がれたような塗り方になります">${esc(o.description)}</textarea></div>
      <div class="fb"><span class="k">注意書き</span>
        <textarea class="o-note" rows="2" placeholder="例: ※いちごチョコは酸味があります">${esc(o.note)}</textarea>
        <label class="chk"><input type="checkbox" class="o-note-accent" ${o.note_accent ? "checked" : ""}>目立たせる（赤・太字）</label></div>
      <div class="fb">
        <label class="chk"><input type="checkbox" class="o-qon" ${q ? "checked" : ""}>この選択肢を選んだ人にだけ質問する</label>
        <div class="o-qbox"></div>
      </div>
      <div class="o-photo"></div>
      <div class="acts">
        <button type="button" class="pill o-stops">ご用意できない日を設定</button>
        <button type="button" class="pill o-excl">同時に選べないものを選ぶ</button>
        <button type="button" class="pill o-toggle">${isLinked ? (o.is_available ? "この商品だけ停止する" : "この商品の停止を解除") : (o.is_available ? "停止する" : "提供を再開する")}</button>
        ${isLinked && !o.shared_list_items?.is_available ? '<span class="small">共有リストで停止中のため、お客様には表示されません。再開はページ下の共有リストで行います。</span>' : ""}
        <button type="button" class="pill danger o-del">削除</button>
      </div>
    </div>`;

  const repaintMarks = () => { row.querySelector(".marks").innerHTML = marksHtml(o, ov); };
  const rowLight = () => row.closest(".grp").querySelector(`.pv-opts .crow[data-option-id="${o.id}"]`);

  const nameEl = row.querySelector(".oname");
  if (!isLinked) {
    regField("options", o.id, "name", nameEl);
    nameEl.addEventListener("input", () => { ov.name = nameEl.value; paintGroup(); });
  }
  linkLight(nameEl, rowLight);

  const priceEl = row.querySelector(".o-price");
  regField("options", o.id, "price_delta", priceEl, { get: () => parseInt(priceEl.value || "0", 10) || 0 });
  priceEl.addEventListener("input", () => { ov.price = parseInt(priceEl.value || "0", 10) || 0; paintGroup(); });
  linkLight(priceEl, rowLight);

  regField("options", o.id, "max_quantity", row.querySelector(".o-maxq"), { number: true });

  const descEl = row.querySelector(".o-desc");
  regField("options", o.id, "description", descEl);
  descEl.addEventListener("input", () => { o.description = descEl.value; repaintMarks(); });

  const noteEl = row.querySelector(".o-note");
  regField("options", o.id, "note", noteEl);
  noteEl.addEventListener("input", () => { o.note = noteEl.value; repaintMarks(); });
  regField("options", o.id, "note_accent", row.querySelector(".o-note-accent"));

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
  const qWrap = row.querySelector(".o-qbox");
  if (q) {
    const qLight = () => {
      const grp = row.closest(".grp");
      return grp.querySelector(`.pv-opts .cfield[data-option-id="${o.id}"]`);
    };
    qWrap.appendChild(buildQuestionFields(q, ov.q, paintGroup, { hideHelp: false, lightLabel: qLight }));
  }
  row.querySelector(".o-qon").onchange = async (e) => {
    if (e.target.checked) {
      await api("POST", "/rest/v1/common_questions", [{
        tenant_id: state.tenantId, label: "", input_type: "text",
        is_required: true, option_id: o.id, display_order: 0,
      }]);
      state.openOptions.add(o.id);
    } else {
      if (!confirm("この選択肢の質問を削除しますか？（お客様に聞かなくなります）")) {
        e.target.checked = true; return;
      }
      try {
        await api("DELETE", `/rest/v1/common_question_choices?question_id=eq.${q.id}`);
        await api("DELETE", `/rest/v1/common_questions?id=eq.${q.id}`);
      } catch {
        // すでに回答がある質問は消せない（過去の予約の記録が壊れるため）→ 止めるだけにする
        await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { is_active: false });
        toast("すでに回答がある質問のため、削除ではなく停止しました");
      }
    }
    reloadAll();
  };

  row.querySelector(".o-photo").appendChild(buildPhotoField({
    url: o.photo_url,
    kind: "options",
    label: "参考写真（任意）",
    hint: "横向き・4:3",
    onChange: (url) => api("PATCH", `/rest/v1/options?id=eq.${o.id}`, { photo_url: url }),
  }));
  row.querySelector(".o-photo").appendChild(buildLayerField({
    url: o.layer_url,
    z: o.layer_z,
    label: "イラスト（選ぶと重なる絵・任意）",
    hint: "透過PNG・800×800px",
    showZ: true,
    onChange: (patch) => api("PATCH", `/rest/v1/options?id=eq.${o.id}`,
      patch.url !== undefined ? { layer_url: patch.url } : { layer_z: patch.z }),
  }));
  const zEl = row.querySelector(".layer-z");
  if (zEl) regField("options", o.id, "layer_z", zEl, { number: true });

  row.querySelector(".o-toggle").onclick = async () => {
    await api("PATCH", `/rest/v1/options?id=eq.${o.id}`, { is_available: !o.is_available });
    reloadAll();
  };
  row.querySelector(".o-del").onclick = async () => {
    if (!confirm(`「${optDisplayName(o)}」を削除しますか？`)) return;
    try {
      await api("DELETE", `/rest/v1/option_exclusions?or=(option_a.eq.${o.id},option_b.eq.${o.id})`);
      if (q) {
        await api("DELETE", `/rest/v1/common_question_choices?question_id=eq.${q.id}`);
        await api("DELETE", `/rest/v1/common_questions?id=eq.${q.id}`);
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
    row.querySelector(".more").appendChild(panel);
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
    row.querySelector(".more").appendChild(panel);
  };
  return row;
}

/* ---------- グループ追加 ---------- */
$("btn-g-add").onclick = async () => {
  const p = state.current;
  const name = $("g-name").value.trim();
  if (!name) { toast("グループ名を入れてください"); return; }
  const sharedId = $("g-shared").value || null;
  // 追加は必ず「このケーキだけ」。全ケーキに出すかは、作ったあとグループの中で決める
  // （商品タブに立ったまま全商品に出るものを作れると、立ち位置と結果が食い違って混乱する）
  const created = await api("POST", "/rest/v1/option_groups", [{
    tenant_id: state.tenantId, product_id: p.id, name,
    selection_type: $("g-type").value, is_required: $("g-required").checked,
    shared_list_id: sharedId, display_order: groupsForProduct(p).length,
  }]);
  // 共有リスト参照グループ: リストの全項目分のリンク行を自動作成
  if (sharedId) {
    const list = state.sharedLists.find((l) => l.id === sharedId);
    const rows = (list?.shared_list_items || [])
      .sort((a, b) => a.display_order - b.display_order)
      .map((it, i) => ({
        tenant_id: state.tenantId, group_id: created[0].id,
        shared_list_item_id: it.id, display_order: i,
      }));
    if (rows.length) await api("POST", "/rest/v1/options", rows);
  }
  $("g-name").value = ""; $("g-required").checked = false;
  toast(`グループ「${name}」を追加しました`);
  reloadAll();
};

/* ---------- 共通の質問（店全体） ---------- */
// 要素を移動するだけにして、入力中の文章・開閉状態を保つ。保存は既存の保存バーで行う。
function addOrderControls(container, items, table, onMove = () => {}) {
  const entries = items.map(({ data, row, target }) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.value = data.display_order ?? 0;
    row.appendChild(input);
    regField(table, data.id, "display_order", input, { number: true });
    const controls = document.createElement("span");
    controls.className = "question-order";
    const buttons = [-1, 1].map((direction) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pill";
      button.textContent = direction < 0 ? "↑" : "↓";
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

function renderQuestions() {
  const wrap = $("questions-list");
  wrap.innerHTML = "";
  const common = state.questions.filter((q) => !q.option_id)
    .sort((a, b) => a.display_order - b.display_order || a.id.localeCompare(b.id));
  if (!common.length) {
    wrap.innerHTML = `<p class="small">まだありません。どのケーキでも聞くこと（メッセージプレートなど）を追加してください。</p>`;
  }
  const items = common.map(q => {
    const row = buildQuestionBox(q);
    wrap.appendChild(row);
    return { data: q, row, target: row.querySelector(".q-bar") };
  });
  addOrderControls(wrap, items, "common_questions");
  if (common.length) {
    const note = document.createElement("p");
    note.className = "small";
    note.textContent = "↑・↓で並べ替えて「保存する」で確定します。お客様にもこの順で表示されます。";
    wrap.prepend(note);
  }
}

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
      <button type="button" class="pill danger q-del">削除</button>
    </div>
    <div class="q-body">
      <div class="q-main">
      <div class="qrow"><div class="k">どのケーキで聞くか</div><div class="v">
        <label class="radio"><input type="radio" name="sc-${q.id}" class="sc-all" ${isAll ? "checked" : ""}>すべてのケーキ</label>
        <label class="radio"><input type="radio" name="sc-${q.id}" class="sc-some" ${isAll ? "" : "checked"}>選んだケーキだけ</label>
        <div class="cakes ${isAll ? "hidden" : ""}">${state.products.map((p) =>
          `<label class="${picked.has(p.id) ? "on" : ""}"><input type="checkbox" data-pid="${p.id}" ${picked.has(p.id) ? "checked" : ""}>${esc(p.name)}</label>`).join("")}</div>
      </div></div>
      <div class="qrow"><div class="k">質問の内容</div><div class="v q-fields-wrap"></div></div>
      </div>
      <div class="cust">
        <p class="cap">プレビュー</p>
        <div class="card">
          <h4><span class="pv-label"></span><span class="req pv-req">必須</span></h4>
          <div class="pv-body"></div>
        </div>
      </div>
    </div>`;

  const view = {
    label: q.label, required: !!q.is_required, type: q.input_type, imageMax: imgMaxOf(q),
    sample: q.sample_image_url,
    choices: qChoices(q).map((c) => ({ id: c.id, label: c.label })),
  };
  const paint = () => {
    box.querySelector(".pv-label").textContent = view.label || "（質問文）";
    box.querySelector(".pv-req").classList.toggle("hidden", !view.required);
    box.querySelector(".pv-body").innerHTML =
      (view.sample ? `<span class="pv-sample"><img src="${esc(view.sample)}" alt=""></span>` : "") +
      answerFieldHtml(view);
    applyLight();
  };

  // 見出しの質問文と、下の質問エディタのラベル欄は同じ項目。見出し側だけ出して重複させない
  const fields = buildQuestionFields(q, view, paint, { lightLabel: () => box.querySelector(".pv-label") });
  fields.querySelector(".q-label").remove();
  box.querySelector(".q-fields-wrap").appendChild(fields);

  const nameEl = box.querySelector(".qname");
  regField("common_questions", q.id, "label", nameEl);
  nameEl.addEventListener("input", () => { view.label = nameEl.value; paint(); });
  linkLight(nameEl, () => box.querySelector(".pv-label"));

  const allScope = box.querySelector(".sc-all");
  const cakes = box.querySelector(".cakes");
  regField("common_questions", q.id, "scope", allScope,
    { get: () => allScope.checked ? "all" : "selected" });
  regField("common_questions", q.id, "_product_ids", cakes, {
    get: () => [...cakes.querySelectorAll("input:checked")].map(cb => cb.dataset.pid).sort(),
  });
  for (const el of box.querySelectorAll('.sc-all, .sc-some, .cakes input')) {
    el.addEventListener("change", () => {
      cakes.classList.toggle("hidden", allScope.checked);
      cakes.querySelectorAll("label").forEach(lb => lb.classList.toggle("on", lb.querySelector("input").checked));
      markDirty();
    });
  }

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

$("btn-q-add").onclick = async () => {
  await api("POST", "/rest/v1/common_questions", [{
    tenant_id: state.tenantId, label: "", input_type: "text", is_required: false,
    scope: "all", display_order: Math.max(-1, ...state.questions.filter(q => !q.option_id).map(q => Number(q.display_order) || 0)) + 1,
  }]);
  toast("質問を追加しました（質問文を入れてください）");
  reloadAll();
};

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


/* ---------- 共有リスト ---------- */
function renderSharedLists() {
  const wrap = $("shared-lists");
  wrap.innerHTML = "";
  for (const l of state.sharedLists) {
    const box = document.createElement("div");
    box.className = "sl-box";
    box.innerHTML = `<strong>${esc(l.name)}</strong><div class="sl-items"></div>
      <div class="override-add">
        <input type="text" class="sl-new" placeholder="新しい項目（例: いちじく）" style="width:170px">
        <button type="button" class="pill sl-add">項目追加</button>
      </div>`;
    const itemsWrap = box.querySelector(".sl-items");
    for (const it of [...l.shared_list_items].sort((a, b) => a.display_order - b.display_order)) {
      const row = document.createElement("div");
      row.className = "sl-item";
      row.innerHTML = `
        <div class="sl-item-main">
          <input type="text" class="it-name" value="${esc(it.name)}">
          <span class="state-badge ${it.is_available ? "on" : ""}">${it.is_available ? "提供中" : "停止中"}</span>
          <button type="button" class="pill it-toggle">${it.is_available ? "停止する" : "提供を再開する"}</button>
        </div>
        <div class="sl-item-period">
          <span class="mini period-label">提供期間（空欄なら通年）</span>
          <span class="period-inputs">
            <input type="date" class="it-from" value="${esc(it.available_from)}">
            <span class="mini">〜</span>
            <input type="date" class="it-until" value="${esc(it.available_until)}">
          </span>
        </div>`;
      regField("shared_list_items", it.id, "name", row.querySelector(".it-name"));
      regField("shared_list_items", it.id, "available_from", row.querySelector(".it-from"));
      regField("shared_list_items", it.id, "available_until", row.querySelector(".it-until"));
      row.querySelector(".it-toggle").onclick = async () => {
        await api("PATCH", `/rest/v1/shared_list_items?id=eq.${it.id}`, { is_available: !it.is_available });
        toast(it.is_available ? "停止しました（全商品で非表示になります）" : "提供再開しました");
        reloadAll();
      };
      itemsWrap.appendChild(row);
    }
    box.querySelector(".sl-add").onclick = async () => {
      const name = box.querySelector(".sl-new").value.trim();
      if (!name) { toast("項目名を入れてください"); return; }
      const item = await api("POST", "/rest/v1/shared_list_items", [{
        tenant_id: state.tenantId, list_id: l.id, name,
        display_order: l.shared_list_items.length,
      }]);
      // このリストを使っている全グループにリンク行を自動作成
      const groups = await api("GET",
        `/rest/v1/option_groups?tenant_id=eq.${state.tenantId}&shared_list_id=eq.${l.id}&select=id,options(id)`);
      const rows = groups.map((g) => ({
        tenant_id: state.tenantId, group_id: g.id,
        shared_list_item_id: item[0].id, display_order: g.options.length,
      }));
      if (rows.length) await api("POST", "/rest/v1/options", rows);
      toast(`「${name}」を追加しました（${rows.length}商品のグループに反映）`);
      reloadAll();
    };
    wrap.appendChild(box);
  }
}
$("btn-sl-add").onclick = async () => {
  const name = $("sl-name").value.trim();
  if (!name) { toast("リスト名を入れてください"); return; }
  await api("POST", "/rest/v1/shared_lists", [{ tenant_id: state.tenantId, name }]);
  $("sl-name").value = "";
  toast(`リスト「${name}」を作りました`);
  reloadAll();
};

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
    const t = await api("GET", `/rest/v1/tenants?id=eq.${tu[0].tenant_id}&select=subdomain,timezone,closed_weekdays,billing_status,trial_ends_at`);
    state.tenantTimezone = t[0].timezone || "Asia/Tokyo";
    state.closedWeekdays = t[0].closed_weekdays || [];
    $("preview-link").href = `../?shop=${t[0].subdomain}${t[0].billing_status === "setup_trial" ? "&trial=1" : ""}`;
    await loadAll(false);
  } catch {
    showLogin();
  }
})();
