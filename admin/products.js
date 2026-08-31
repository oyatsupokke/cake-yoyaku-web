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
  current: null, fields: [],
  // 選択肢の「詳しい設定」を開いているもの。普段はたたんでおく（画面が縦に延々と続かないように）
  openOptions: new Set(),
};

/* ---------- 保存の仕組み ----------
 * 入力欄を「どのテーブルのどの項目か」と一緒に登録しておき、
 * 画面下の保存バー1つでまとめて保存する（変更があったものだけ送る）。
 * 追加・削除・公開切替・画像アップロードは押した時点で即反映（保存不要）。
 */
function regField(table, id, column, el, opts = {}) {
  const get = opts.get || (() => {
    if (el.type === "checkbox") return el.checked;
    const v = el.value.trim();
    if (opts.number) return v === "" ? null : parseInt(v, 10);
    return v === "" ? null : v;
  });
  state.fields.push({ table, id, column, el, get, original: get() });
  const evt = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(evt, markDirty);
}
function collectChanges() {
  const changes = new Map();
  for (const f of state.fields) {
    if (!document.body.contains(f.el)) continue; // 再描画で消えた欄は無視
    const v = f.get();
    if (JSON.stringify(v) === JSON.stringify(f.original)) continue;
    const key = `${f.table}:${f.id}`;
    if (!changes.has(key)) changes.set(key, { table: f.table, id: f.id, patch: {} });
    changes.get(key).patch[f.column] = v;
  }
  return [...changes.values()];
}
function markDirty() {
  const n = collectChanges().length;
  state.dirty = n > 0;
  const bar = $("save-bar");
  if (!bar) return;
  bar.classList.toggle("dirty", state.dirty);
  $("save-status").textContent = state.dirty ? "保存していない変更があります" : "変更はありません";
  $("btn-save-all").disabled = !state.dirty;
}
async function saveAll() {
  const changes = collectChanges();
  if (!changes.length) { toast("変更はありません"); return; }
  const btn = $("btn-save-all");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    for (const c of changes) {
      await api("PATCH", `/rest/v1/${c.table}?id=eq.${c.id}`, c.patch);
    }
    toast(`保存しました（${changes.length}件）`);
    state.dirty = false;
    await loadAll();
  } catch (e) {
    toast("保存できませんでした：" + e.message);
  } finally {
    btn.textContent = "保存する";
    markDirty();
  }
}

/* 未保存の入力を捨てずに再読み込みする（2026-08-29 追加）
 * この画面は「まとめて保存」方式だが、停止/削除/追加/公開切替/タブ切替などのボタンは
 * 押した瞬間にサーバーへ反映して画面を丸ごと再描画する。以前はそのとき、
 * 保存バーを押していない入力欄が黙って捨てられていた
 * （collectChanges が DOM から消えた欄を無視するため）。
 * → 再描画の前に、溜まっている変更を必ず先に保存する。 */
async function reloadAll() {
  const changes = collectChanges();
  if (changes.length) {
    try {
      for (const c of changes) {
        await api("PATCH", `/rest/v1/${c.table}?id=eq.${c.id}`, c.patch);
      }
      state.dirty = false;
      toast(`入力を保存してから更新しました（${changes.length}件）`);
    } catch (e) {
      // 保存できないまま再描画すると入力が消える。ここで止めて画面をそのまま残す
      toast("入力を保存できませんでした：" + e.message);
      return;
    }
  }
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
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
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
  // 「すべてのケーキに出す」グループ（product_id が null）は商品にぶら下がっていないので別で取る
  const [products, lists, questions, globalGroups] = await Promise.all([
    api("GET", `/rest/v1/products?tenant_id=eq.${state.tenantId}&deleted_at=is.null&order=display_order` +
      `&select=*,product_variants(*),option_groups(*,options(*,shared_list_items(*))),option_exclusions(*)`),
    api("GET", `/rest/v1/shared_lists?tenant_id=eq.${state.tenantId}&select=*,shared_list_items(*)`),
    api("GET", `/rest/v1/common_questions?tenant_id=eq.${state.tenantId}&order=display_order` +
      `&select=*,common_question_choices(*),common_question_products(product_id)`),
    api("GET", `/rest/v1/option_groups?tenant_id=eq.${state.tenantId}&product_id=is.null&order=display_order` +
      `&select=*,options(*,shared_list_items(*))`),
  ]);
  state.products = products;
  state.sharedLists = lists;
  state.questions = questions;
  state.globalGroups = globalGroups;
  if (keepCurrent && state.current) {
    state.current = products.find((p) => p.id === state.current.id) || products[0] || null;
  } else {
    state.current = products[0] || null;
  }
  state.fields = []; // 入力欄の登録をやり直す
  renderTabs();
  renderEditor();
  renderQuestions();
  renderSharedLists();
  $("save-bar").classList.remove("hidden");
  markDirty();
}

/* ---------- 商品タブ ---------- */
function renderTabs() {
  const wrap = $("prod-tabs");
  wrap.innerHTML = "";
  for (const p of state.products) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "prod-tab" + (state.current?.id === p.id ? " selected" : "") + (p.is_published ? "" : " unpublished");
    b.textContent = p.name + (p.is_published ? "" : "（非公開）");
    b.onclick = () => {
      if (!confirmLeave()) return;
      state.dirty = false;
      state.current = p; renderTabs(); renderEditor();
    };
    wrap.appendChild(b);
  }
}
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

  loadCapacityRule(p);
  renderVariants(p);
  renderGroups(p);
  renderProductStops(p);
  // 共有リストのプルダウン（グループ追加用）
  $("g-shared").innerHTML = `<option value="">共有リストを使わない</option>` +
    state.sharedLists.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}を使う</option>`).join("");
}

/* ---------- この商品の上限（capacity_rules scope=products・入力したら即保存） ---------- */
async function loadCapacityRule(p) {
  state.capRule = null;
  $("p-cap-daily").value = "";
  $("p-cap-slot").value = "";
  try {
    const rules = await api("GET",
      `/rest/v1/capacity_rules?tenant_id=eq.${state.tenantId}&scope=eq.products&is_active=eq.true` +
      `&select=*,capacity_rule_products!inner(product_id)&capacity_rule_products.product_id=eq.${p.id}`);
    if (state.current?.id !== p.id) return;  // 読み込み中に別商品へ切り替えた場合は無視
    state.capRule = rules[0] || null;
    if (state.capRule) {
      $("p-cap-daily").value = state.capRule.daily_limit ?? "";
      $("p-cap-slot").value = state.capRule.slot_limit ?? "";
    }
  } catch { /* 読めなくても他の編集は続けられる */ }
}

async function saveCapacityRule() {
  const p = state.current;
  if (!p) return;
  const dailyRaw = $("p-cap-daily").value.trim();
  const slotRaw = $("p-cap-slot").value.trim();
  const daily = dailyRaw === "" ? null : Math.max(0, parseInt(dailyRaw, 10) || 0);
  const slot = slotRaw === "" ? null : Math.max(0, parseInt(slotRaw, 10) || 0);
  try {
    if (daily == null && slot == null) {
      // 両方空欄=この商品の上限をなくす
      if (state.capRule) {
        await api("DELETE", `/rest/v1/capacity_rule_products?rule_id=eq.${state.capRule.id}`);
        await api("DELETE", `/rest/v1/capacity_rules?id=eq.${state.capRule.id}`);
        state.capRule = null;
        toast(`「${p.name}」の上限をなくしました（全体上限のみ）`);
      }
      return;
    }
    if (state.capRule) {
      await api("PATCH", `/rest/v1/capacity_rules?id=eq.${state.capRule.id}`,
        { daily_limit: daily, slot_limit: slot, name: p.name });
      state.capRule.daily_limit = daily;
      state.capRule.slot_limit = slot;
    } else {
      const rule = await api("POST", "/rest/v1/capacity_rules", [{
        tenant_id: state.tenantId, name: p.name, scope: "products",
        daily_limit: daily, slot_limit: slot,
      }]);
      await api("POST", "/rest/v1/capacity_rule_products", [{
        rule_id: rule[0].id, product_id: p.id, tenant_id: state.tenantId,
      }]);
      state.capRule = rule[0];
    }
    toast(`「${p.name}」の上限を保存しました`);
  } catch (e) {
    toast("上限を保存できませんでした：" + e.message);
  }
}
$("p-cap-daily").onchange = saveCapacityRule;
$("p-cap-slot").onchange = saveCapacityRule;

/* ---------- 基本情報 ---------- */
$("btn-save-all").onclick = saveAll;
$("btn-p-publish").onclick = async () => {
  const p = state.current;
  await api("PATCH", `/rest/v1/products?id=eq.${p.id}`, { is_published: !p.is_published });
  toast(p.is_published ? "非公開にしました" : "公開しました");
  reloadAll();
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
      await api("PATCH", `/rest/v1/product_variants?id=eq.${v.id}`, { is_available: !v.is_available });
      reloadAll();
    };
    row.querySelector(".v-del").onclick = async () => {
      try {
        await api("DELETE", `/rest/v1/product_variants?id=eq.${v.id}`);
        toast("削除しました");
      } catch {
        toast("予約で使用されているため削除できません（停止をお使いください）");
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
];
const needsChoices = (t) => t === "select" || t === "radio" || t === "checkbox";
const qChoices = (q) => [...(q?.common_question_choices || [])].sort((a, b) => a.display_order - b.display_order);
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
  return `<input type="text" disabled>`;
}

/* 質問エディタ（共通の質問・選択肢の質問で同じ部品を使う）
 * 戻り値の要素の中で、ラベル/必須/形式/回答の選択肢を編集できる。
 * ラベルと選択肢名は「まとめて保存」、形式の変更と選択肢の増減はその場で保存する。 */
function buildQuestionFields(q, view, onPaint, opts = {}) {
  const box = document.createElement("div");
  box.className = "sub q-fields";
  box.innerHTML = `
    <input type="text" class="q-label" value="${esc(q.label)}" placeholder="質問文（お客様に見えます）">
    <select class="q-type">${typeOptions(q.input_type)}</select>
    <label class="chk"><input type="checkbox" class="q-req" ${q.is_required ? "checked" : ""}>必須にする</label>
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

  box.querySelector(".q-type").addEventListener("change", async (e) => {
    const type = e.target.value;
    await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { input_type: type });
    // 選択式に変えたのに回答の選択肢が1つも無いと、お客様は何も選べない
    if (needsChoices(type) && !qChoices(q).length) {
      await api("POST", "/rest/v1/common_question_choices", [{
        tenant_id: state.tenantId, question_id: q.id, label: "", display_order: 0,
      }]);
    }
    reloadAll();
  });

  const chWrap = box.querySelector(".q-choices");
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
  }
  if (needsChoices(q.input_type)) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "pill ghost";
    add.textContent = "＋ 回答の選択肢を追加";
    add.onclick = async () => {
      await api("POST", "/rest/v1/common_question_choices", [{
        tenant_id: state.tenantId, question_id: q.id, label: "",
        display_order: qChoices(q).length,
      }]);
      reloadAll();
    };
    chWrap.appendChild(add);
  }
  return box;
}

/* ---------- 選択グループと選択肢 ---------- */
const optDisplayName = (o) => o.name || o.shared_list_items?.name || "（共有リストの項目）";
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
        <p class="cap">プレビュー</p>
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
        id: o.id, name: optDisplayName(o), price: o.price_delta, available: o.is_available,
        q: q ? {
          label: q.label, type: q.input_type, required: q.is_required,
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
    box.querySelector(".pv-opts").innerHTML = view.opts.map((o) => `
      <div class="crow ${o.available ? "" : "off"}">
        <span>${view.single ? "○" : "☐"} ${esc(o.name || "（名前なし）")}</span>
        <span>${o.price ? "+¥" + o.price.toLocaleString("ja-JP") : "無料"}</span>
      </div>
      ${o.q ? `<div class="cfield">${esc(o.q.label || "（質問文）")}${answerFieldHtml(o.q)}</div>` : ""}`).join("");
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

  box.querySelector(".gh-all").onclick = async (e) => {
    const on = e.target.checked;
    const others = Math.max(0, state.products.length - 1);
    const ask = on
      ? `「${g.name}」を すべてのケーキに出しますか？\n（${p.name} 以外の ${others}個のケーキにも出るようになります）`
      : `「${g.name}」を この商品（${p.name}）だけのグループに戻しますか？\n（他の ${others}個のケーキからは出なくなります）`;
    if (!confirm(ask)) { e.target.checked = !on; return; }
    await api("PATCH", `/rest/v1/option_groups?id=eq.${g.id}`, { product_id: on ? null : p.id });
    toast(on ? "すべてのケーキに出すようにしました" : `${p.name} だけのグループにしました`);
    reloadAll();
  };

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
  box.querySelector(".g-default-layer").appendChild(buildLayerField({
    url: g.default_layer_url,
    z: g.default_layer_z,
    label: "このグループで何も選ばれていないときのイラスト（任意）",
    hint: "透過PNG・800×800px",
    showZ: true,
    onChange: (patch) => api("PATCH", `/rest/v1/option_groups?id=eq.${g.id}`,
      patch.url !== undefined ? { default_layer_url: patch.url } : { default_layer_z: patch.z }),
  }));

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
  row.className = "opt" + (open ? " open" : "") + (o.is_available ? "" : " stopped");
  const isLinked = !!o.shared_list_item_id;
  const q = questionOf(o.id);
  row.innerHTML = `
    <div class="opt-line">
      <input type="text" class="oname inplace" value="${esc(o.name)}" aria-label="選択肢名"
        placeholder="${esc(isLinked ? optDisplayName(o) + "（共有リスト）" : "選択肢名")}" ${isLinked ? "disabled" : ""}>
      <span class="lbl">+¥</span><input type="number" class="o-price" min="0" value="${esc(o.price_delta)}">
      <span class="lbl">個数上限</span><input type="number" class="o-maxq maxq" min="1" placeholder="1" value="${esc(o.max_quantity)}">
      <span class="state-badge ${o.is_available ? "on" : ""}">${o.is_available ? "提供中" : "停止中"}</span>
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
        <button type="button" class="pill o-toggle">${o.is_available ? "停止する" : "提供を再開する"}</button>
        <button type="button" class="pill danger o-del">削除</button>
      </div>
    </div>`;

  const repaintMarks = () => { row.querySelector(".marks").innerHTML = marksHtml(o, ov); };
  const rowLight = () => row.closest(".grp").querySelectorAll(".pv-opts .crow")[index];

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
      const before = view.opts.slice(0, index).filter((x) => x.q).length;
      return grp.querySelectorAll(".pv-opts .cfield")[before];
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
function renderQuestions() {
  const wrap = $("questions-list");
  wrap.innerHTML = "";
  const common = state.questions.filter((q) => !q.option_id);
  if (!common.length) {
    wrap.innerHTML = `<p class="small">まだありません。どのケーキでも聞くこと（メッセージプレートなど）を追加してください。</p>`;
  }
  for (const q of common) wrap.appendChild(buildQuestionBox(q));
}

function buildQuestionBox(q) {
  const box = document.createElement("div");
  box.className = "q" + (q.is_active ? "" : " stopped");
  const picked = new Set((q.common_question_products || []).map((r) => r.product_id));
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
    label: q.label, required: !!q.is_required, type: q.input_type,
    choices: qChoices(q).map((c) => ({ id: c.id, label: c.label })),
  };
  const paint = () => {
    box.querySelector(".pv-label").textContent = view.label || "（質問文）";
    box.querySelector(".pv-req").classList.toggle("hidden", !view.required);
    box.querySelector(".pv-body").innerHTML = answerFieldHtml(view);
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

  box.querySelector(".sc-all").onchange = async () => {
    await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { scope: "all" });
    await api("DELETE", `/rest/v1/common_question_products?question_id=eq.${q.id}`);
    reloadAll();
  };
  box.querySelector(".sc-some").onchange = async () => {
    await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { scope: "selected" });
    reloadAll();
  };
  box.querySelectorAll(".cakes input").forEach((cb) => {
    cb.onchange = async () => {
      const pid = cb.dataset.pid;
      try {
        if (cb.checked) {
          await api("POST", "/rest/v1/common_question_products", [{
            tenant_id: state.tenantId, question_id: q.id, product_id: pid,
          }]);
        } else {
          await api("DELETE", `/rest/v1/common_question_products?question_id=eq.${q.id}&product_id=eq.${pid}`);
        }
        cb.closest("label").classList.toggle("on", cb.checked);
      } catch (e) {
        cb.checked = !cb.checked;
        toast("変更できませんでした：" + e.message);
      }
    };
  });

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
    scope: "all", display_order: state.questions.filter((q) => !q.option_id).length,
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
function confirmLeave() {
  return !state.dirty ||
    confirm("保存していない変更があります。保存せずに移動しますか？\n（画面下の「保存する」で確定できます）");
}

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
    const t = await api("GET", `/rest/v1/tenants?id=eq.${tu[0].tenant_id}&select=subdomain`);
    $("preview-link").href = `../?shop=${t[0].subdomain}`;
    await loadAll(false);
  } catch {
    showLogin();
  }
})();
