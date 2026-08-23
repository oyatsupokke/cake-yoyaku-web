/* =====================================================================
 * 商品エディタ v1
 * - 基本情報 / 季節設定（販売期間・受取期間・受取曜日）/ サイズと価格
 * - 選択グループ＆選択肢（追加料金・個数上限・記入欄・注意書き・排他ペア）
 * - 共有リスト（果物など）: 項目の追加は、参照している全商品のグループへ
 *   リンク行を自動作成する（設計メモ「リンク行方式」の実装）
 * すべてスタッフJWT + RLS 経由（自店のデータしか読めない・書けない）
 * ===================================================================== */

const CONFIG = {
  url: "https://gcsxptynaclgazhpqamz.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdjc3hwdHluYWNsZ2F6aHBxYW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDY2NjAsImV4cCI6MjEwMDQ4MjY2MH0.VRsbfbja9xdQs4hs5DBHsOfpGB-DhnRxyeStNXAE8Ic",
};
const $ = (id) => document.getElementById(id);
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const state = { session: null, tenantId: null, products: [], sharedLists: [], current: null, fields: [] };

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
    <span class="text-field-label">${label}</span>
    <div class="photo-body">
      <div class="photo-thumb layer-thumb ${url ? "" : "empty"}">${url ? `<img src="${url}" alt="">` : "なし"}</div>
      <div class="photo-actions">
        <label class="pill photo-pick">イラストを選ぶ<input type="file" accept="image/png" hidden></label>
        <button type="button" class="pill danger photo-del" ${url ? "" : "hidden"}>削除</button>
        ${showZ ? `<span class="mini">重ね順</span><input type="number" class="layer-z" value="${z ?? ""}" placeholder="20" style="width:70px">` : ""}
        ${hint ? `<span class="mini">${hint}</span>` : ""}
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
      loadAll();
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
      loadAll();
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
    <span class="text-field-label">${label}</span>
    <div class="photo-body">
      <div class="photo-thumb ${url ? "" : "empty"}">${url ? `<img src="${url}" alt="">` : "写真なし"}</div>
      <div class="photo-actions">
        <label class="pill photo-pick">写真を選ぶ<input type="file" accept="image/*" hidden></label>
        <button type="button" class="pill danger photo-del" ${url ? "" : "hidden"}>削除</button>
        ${hint ? `<span class="mini">${hint}</span>` : ""}
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
      loadAll();
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
      loadAll();
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
  const [products, lists, questions] = await Promise.all([
    api("GET", `/rest/v1/products?tenant_id=eq.${state.tenantId}&deleted_at=is.null&order=display_order` +
      `&select=*,product_variants(*),option_groups(*,options(*,shared_list_items(*))),option_exclusions(*)`),
    api("GET", `/rest/v1/shared_lists?tenant_id=eq.${state.tenantId}&select=*,shared_list_items(*)`),
    api("GET", `/rest/v1/common_questions?tenant_id=eq.${state.tenantId}&order=display_order`),
  ]);
  state.products = products;
  state.sharedLists = lists;
  state.questions = questions;
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
  await loadAll();
};
$("btn-reload").onclick = () => loadAll();

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

  renderVariants(p);
  renderGroups(p);
  renderProductStops(p);
  // 共有リストのプルダウン（グループ追加用）
  $("g-shared").innerHTML = `<option value="">共有リストを使わない</option>` +
    state.sharedLists.map((l) => `<option value="${l.id}">${l.name}を使う</option>`).join("");
}

/* ---------- 基本情報 ---------- */
$("btn-save-all").onclick = saveAll;
$("btn-p-publish").onclick = async () => {
  const p = state.current;
  await api("PATCH", `/rest/v1/products?id=eq.${p.id}`, { is_published: !p.is_published });
  toast(p.is_published ? "非公開にしました" : "公開しました");
  loadAll();
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
    row.innerHTML = `<span style="flex:1">${s.date} は受け付けない</span>
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
      <input type="text" class="o-name" value="${v.size_label}" style="width:110px">
      ¥<input type="number" class="v-price" min="0" value="${v.price}">
      <span class="state-badge ${v.is_available ? "on" : ""}">${v.is_available ? "提供中" : "停止中"}</span>
      <button type="button" class="pill v-toggle">${v.is_available ? "停止する" : "提供を再開する"}</button>
      <button type="button" class="pill danger v-del">削除</button>`;
    regField("product_variants", v.id, "size_label", row.querySelector(".o-name"));
    regField("product_variants", v.id, "price", row.querySelector(".v-price"), { number: true });
    row.querySelector(".v-toggle").onclick = async () => {
      await api("PATCH", `/rest/v1/product_variants?id=eq.${v.id}`, { is_available: !v.is_available });
      loadAll();
    };
    row.querySelector(".v-del").onclick = async () => {
      try {
        await api("DELETE", `/rest/v1/product_variants?id=eq.${v.id}`);
        toast("削除しました");
      } catch {
        toast("予約で使用されているため削除できません（停止をお使いください）");
      }
      loadAll();
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
  loadAll();
};

/* ---------- 選択グループと選択肢 ---------- */
const optDisplayName = (o) => o.name || o.shared_list_items?.name || "（共有リストの項目）";
function renderGroups(p) {
  const wrap = $("groups-list");
  wrap.innerHTML = "";
  const groups = [...p.option_groups].sort((a, b) => a.display_order - b.display_order);
  if (!groups.length) wrap.innerHTML = `<p class="small">グループがありません。下から追加してください。</p>`;
  for (const g of groups) {
    const box = document.createElement("div");
    box.className = "group-box";
    const sharedNote = g.shared_list_id
      ? `<span class="mini">📎 ${state.sharedLists.find((l) => l.id === g.shared_list_id)?.name || "共有リスト"}参照中（項目の追加・停止は下の共有リスト欄で）</span>`
      : "";
    box.innerHTML = `
      <div class="group-head">
        <input type="text" class="gh-name" value="${g.name}">
        <select class="gh-type">
          <option value="single" ${g.selection_type === "single" ? "selected" : ""}>1つ選ぶ</option>
          <option value="multiple" ${g.selection_type === "multiple" ? "selected" : ""}>複数選べる</option>
        </select>
        <label class="radio-line" style="margin:0"><input type="checkbox" class="gh-req" ${g.is_required ? "checked" : ""}>必須</label>
        <button type="button" class="pill danger gh-del">グループ削除</button>
        ${sharedNote}
      </div>
      <div class="gh-texts">
        <div class="text-field">
          <span class="text-field-label">説明</span>
          <textarea class="gh-desc" rows="3" placeholder="例: お好きな果物をお選びください">${g.description ?? ""}</textarea>
        </div>
        <div class="text-field">
          <span class="text-field-label">注意書き</span>
          <textarea class="gh-note" rows="3" placeholder="例: ※果物は季節により異なります">${g.note ?? ""}</textarea>
          <label class="radio-line" style="margin:4px 0 0; font-size:.8rem"><input type="checkbox" class="gh-note-accent" ${g.note_accent ? "checked" : ""}>目立たせる（赤・太字）</label>
        </div>
      </div>
      <div class="g-default-layer"></div>
      <div class="g-options"></div>
      <div class="override-add g-add-row ${g.shared_list_id ? "hidden" : ""}">
        <input type="text" class="ga-name" placeholder="選択肢名" style="width:150px">
        <input type="number" class="ga-price" placeholder="+円" min="0" style="width:80px">
        <button type="button" class="pill ga-add">選択肢追加</button>
      </div>`;
    regField("option_groups", g.id, "name", box.querySelector(".gh-name"));
    regField("option_groups", g.id, "selection_type", box.querySelector(".gh-type"));
    regField("option_groups", g.id, "is_required", box.querySelector(".gh-req"));
    regField("option_groups", g.id, "description", box.querySelector(".gh-desc"));
    regField("option_groups", g.id, "note", box.querySelector(".gh-note"));
    regField("option_groups", g.id, "note_accent", box.querySelector(".gh-note-accent"));
    box.querySelector(".gh-del").onclick = async () => {
      if (!confirm(`グループ「${g.name}」を選択肢ごと削除しますか？`)) return;
      try {
        await api("DELETE", `/rest/v1/option_exclusions?or=(option_a.in.(${g.options.map(o=>o.id).join(",")}),option_b.in.(${g.options.map(o=>o.id).join(",")}))`);
        await api("DELETE", `/rest/v1/options?group_id=eq.${g.id}`);
        await api("DELETE", `/rest/v1/option_groups?id=eq.${g.id}`);
        toast("削除しました");
      } catch {
        toast("予約で使用されている選択肢があるため削除できません（各選択肢の停止をお使いください）");
      }
      loadAll();
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
      loadAll();
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
    for (const o of [...g.options].sort((a, b) => a.display_order - b.display_order)) {
      optWrap.appendChild(renderOptionRow(p, g, o));
    }
    wrap.appendChild(box);
  }
}

function renderOptionRow(p, g, o) {
  const row = document.createElement("div");
  row.className = "opt-row";
  const isLinked = !!o.shared_list_item_id;
  row.innerHTML = `
    <input type="text" class="o-name" value="${o.name ?? ""}" placeholder="${isLinked ? optDisplayName(o) + "（共有）" : "選択肢名"}" ${isLinked ? "disabled" : ""}>
    +¥<input type="number" class="o-price" min="0" value="${o.price_delta}">
    <span class="mini">個数上限</span><input type="number" class="o-maxq" min="1" placeholder="1" value="${o.max_quantity ?? ""}">
    <span class="state-badge ${o.is_available ? "on" : ""}">${o.is_available ? "提供中" : "停止中"}</span>
    <button type="button" class="pill o-toggle">${o.is_available ? "停止する" : "提供を再開する"}</button>
    <button type="button" class="pill o-excl">同時選択できないものを選ぶ</button>
    <button type="button" class="pill danger o-del">削除</button>
    <div class="opt-details">
      <div class="text-field">
        <span class="text-field-label">説明</span>
        <textarea class="o-desc" rows="2" placeholder="例: 側面のクリームが剥がれたような塗り方になります">${o.description ?? ""}</textarea>
      </div>
      <div class="text-field">
        <span class="text-field-label">注意書き</span>
        <textarea class="o-note" rows="2" placeholder="例: ※いちごチョコは酸味があります">${o.note ?? ""}</textarea>
        <label class="radio-line" style="margin:4px 0 0; font-size:.78rem"><input type="checkbox" class="o-note-accent" ${o.note_accent ? "checked" : ""}>目立たせる（赤・太字）</label>
      </div>
      <div class="text-field">
        <span class="text-field-label">お客さんに書いてもらう欄（使う場合だけ、お願い文を入力）</span>
        <input type="text" class="o-prompt" value="${o.text_prompt ?? ""}" placeholder="例: ご希望の数字をご記入ください">
      </div>
      <div class="o-photo"></div>
      <div class="opt-actions-row">
        <button type="button" class="pill o-stops">ご用意できない日を設定</button>
      </div>
    </div>`;
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
  if (!isLinked) regField("options", o.id, "name", row.querySelector(".o-name"));
  regField("options", o.id, "price_delta", row.querySelector(".o-price"),
    { get: () => parseInt(row.querySelector(".o-price").value || "0", 10) || 0 });
  regField("options", o.id, "max_quantity", row.querySelector(".o-maxq"), { number: true });
  regField("options", o.id, "text_prompt", row.querySelector(".o-prompt"));
  regField("options", o.id, "description", row.querySelector(".o-desc"));
  regField("options", o.id, "note", row.querySelector(".o-note"));
  regField("options", o.id, "note_accent", row.querySelector(".o-note-accent"));
  const zEl = row.querySelector(".layer-z");
  if (zEl) regField("options", o.id, "layer_z", zEl, { number: true });
  row.querySelector(".o-toggle").onclick = async () => {
    await api("PATCH", `/rest/v1/options?id=eq.${o.id}`, { is_available: !o.is_available });
    loadAll();
  };
  row.querySelector(".o-del").onclick = async () => {
    try {
      await api("DELETE", `/rest/v1/option_exclusions?or=(option_a.eq.${o.id},option_b.eq.${o.id})`);
      await api("DELETE", `/rest/v1/options?id=eq.${o.id}`);
      toast("削除しました");
    } catch {
      toast("予約で使用されているため削除できません（停止をお使いください）");
    }
    loadAll();
  };
  // 選択肢ごとの「できない日」（例: 犬ケーキ変更はまりほ不在日は不可）
  row.querySelector(".o-stops").onclick = async () => {
    const existing = row.querySelector(".stops-panel");
    if (existing) { existing.remove(); return; }
    const panel = document.createElement("div");
    panel.className = "excl-panel stops-panel";
    panel.innerHTML = `<span class="mini">「${optDisplayName(o)}」をご用意できない日（受取日で選べなくなります）:</span>
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
        r2.innerHTML = `<span style="flex:1">${s.date}</span><button type="button" class="pill danger">解除</button>`;
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
    row.appendChild(panel);
    renderStops();
  };
  row.querySelector(".o-excl").onclick = () => {
    const existing = row.querySelector(".excl-panel");
    if (existing) { existing.remove(); return; }
    const panel = document.createElement("div");
    panel.className = "excl-panel";
    panel.innerHTML = `<span class="mini">「${optDisplayName(o)}」と一緒に選べないものをタップ（ピンク=一緒に選べない）:</span><br>`;
    const others = p.option_groups.flatMap((gg) => gg.options.filter((oo) => oo.id !== o.id).map((oo) => ({ g: gg, o: oo })));
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
    row.insertBefore(panel, row.querySelector(".opt-details"));
  };
  return row;
}

/* ---------- グループ追加 ---------- */
$("btn-g-add").onclick = async () => {
  const p = state.current;
  const name = $("g-name").value.trim();
  if (!name) { toast("グループ名を入れてください"); return; }
  const sharedId = $("g-shared").value || null;
  const created = await api("POST", "/rest/v1/option_groups", [{
    tenant_id: state.tenantId, product_id: p.id, name,
    selection_type: $("g-type").value, is_required: $("g-required").checked,
    shared_list_id: sharedId, display_order: p.option_groups.length,
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
  loadAll();
};

/* ---------- ご記入欄（共通質問）エディタ ---------- */
function allOptionChoices() {
  // 表示条件のプルダウン用: 全商品の全選択肢
  const out = [];
  for (const p of state.products) {
    for (const g of p.option_groups) {
      for (const o of [...g.options].sort((a, b) => a.display_order - b.display_order)) {
        out.push({ id: o.id, label: `${p.name}｜${g.name}: ${optDisplayName(o)}` });
      }
    }
  }
  return out;
}
function renderQuestions() {
  const wrap = $("questions-list");
  wrap.innerHTML = "";
  const choices = allOptionChoices();
  for (const q of state.questions) {
    const row = document.createElement("div");
    row.className = "q-row" + (q.is_active ? "" : " unpublished");
    const opts = choices.map((c) =>
      `<option value="${c.id}" ${q.trigger_option_id === c.id ? "selected" : ""}>${c.label} を選んだときだけ</option>`).join("");
    row.innerHTML = `
      <div class="q-head">
        <input type="text" class="q-label" value="${q.label}" style="flex:1; min-width:200px">
        <select class="q-type">
          <option value="text" ${q.input_type === "text" ? "selected" : ""}>1行記入</option>
          <option value="textarea" ${q.input_type === "textarea" ? "selected" : ""}>複数行記入</option>
        </select>
        <label class="radio-line" style="margin:0"><input type="checkbox" class="q-req" ${q.is_required ? "checked" : ""}>必須</label>
      </div>
      <div class="q-head" style="margin-top:6px">
        <span class="mini">補足:</span>
        <input type="text" class="q-help" value="${q.help_text ?? ""}" placeholder="例: 不要の場合は「不要」とご記入ください" style="flex:1; min-width:180px">
      </div>
      <div class="q-head" style="margin-top:6px">
        <span class="mini">表示条件:</span>
        <select class="q-trigger" style="max-width:340px">
          <option value="">いつも表示</option>
          ${opts}
        </select>
        <span class="state-badge ${q.is_active ? "on" : ""}">${q.is_active ? "使用中" : "停止中"}</span>
        <button type="button" class="pill q-toggle">${q.is_active ? "停止する" : "再開する"}</button>
      </div>`;
    regField("common_questions", q.id, "label", row.querySelector(".q-label"));
    regField("common_questions", q.id, "input_type", row.querySelector(".q-type"));
    regField("common_questions", q.id, "is_required", row.querySelector(".q-req"));
    regField("common_questions", q.id, "help_text", row.querySelector(".q-help"));
    regField("common_questions", q.id, "trigger_option_id", row.querySelector(".q-trigger"));
    row.querySelector(".q-toggle").onclick = async () => {
      await api("PATCH", `/rest/v1/common_questions?id=eq.${q.id}`, { is_active: !q.is_active });
      toast(q.is_active ? "質問を停止しました（フォームに出なくなります）" : "質問を再開しました");
      loadAll();
    };
    wrap.appendChild(row);
  }
}
$("btn-q-add").onclick = async () => {
  const label = $("q-label").value.trim();
  if (!label) { toast("質問文を入れてください"); return; }
  await api("POST", "/rest/v1/common_questions", [{
    tenant_id: state.tenantId, label,
    input_type: $("q-type").value, is_required: $("q-required").checked,
    display_order: state.questions.length,
  }]);
  $("q-label").value = ""; $("q-required").checked = false;
  toast(`質問「${label}」を追加しました`);
  loadAll();
};

/* ---------- 共有リスト ---------- */
function renderSharedLists() {
  const wrap = $("shared-lists");
  wrap.innerHTML = "";
  for (const l of state.sharedLists) {
    const box = document.createElement("div");
    box.className = "sl-box";
    box.innerHTML = `<strong>${l.name}</strong><div class="sl-items"></div>
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
          <input type="text" class="it-name" value="${it.name}">
          <span class="state-badge ${it.is_available ? "on" : ""}">${it.is_available ? "提供中" : "停止中"}</span>
          <button type="button" class="pill it-toggle">${it.is_available ? "停止する" : "提供を再開する"}</button>
        </div>
        <div class="sl-item-period">
          <span class="mini period-label">提供期間（空欄なら通年）</span>
          <span class="period-inputs">
            <input type="date" class="it-from" value="${it.available_from ?? ""}">
            <span class="mini">〜</span>
            <input type="date" class="it-until" value="${it.available_until ?? ""}">
          </span>
        </div>`;
      regField("shared_list_items", it.id, "name", row.querySelector(".it-name"));
      regField("shared_list_items", it.id, "available_from", row.querySelector(".it-from"));
      regField("shared_list_items", it.id, "available_until", row.querySelector(".it-until"));
      row.querySelector(".it-toggle").onclick = async () => {
        await api("PATCH", `/rest/v1/shared_list_items?id=eq.${it.id}`, { is_available: !it.is_available });
        toast(it.is_available ? "停止しました（全商品で非表示になります）" : "提供再開しました");
        loadAll();
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
      loadAll();
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
  loadAll();
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
