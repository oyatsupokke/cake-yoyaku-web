/* 読み取り専用の集計画面。日付変更・読込失敗時は古い結果を出力させない。 */
const reportState = {orders: [], rows: [], summary: [], ready: false, generation: 0};
function resetReports() {
  invalidateReport();
  reportState.orders = []; reportState.rows = []; reportState.summary = [];
  for (const id of ["report-from", "report-to", "report-query"]) $(id).value = "";
  reportSelect("report-product", new Map(), "すべての商品");
  reportSelect("report-size", new Map(), "すべてのサイズ");
  $("report-status").value = "active";
  $("report-summary").replaceChildren(); $("report-detail").replaceChildren();
}
function invalidateReport(message = "期間を選んで「この期間で集計・更新」を押してください。") {
  reportState.generation++;
  reportState.ready = false;
  $("report-results").classList.add("hidden");
  $("report-message").textContent = message;
}
function openReports() {
  if (!$("report-from").value) $("report-from").value = state.date;
  if (!$("report-to").value) $("report-to").value = state.date;
  loadReport();
}
function reportSelect(id, values, placeholder) {
  const el = $(id), previous = el.value;
  el.innerHTML = `<option value="">${placeholder}</option>` + [...values].map(([value, label]) =>
    `<option value="${esc(value)}">${esc(label)}</option>`).join("");
  if (values.has(previous)) el.value = previous;
}
function reportSizes() {
  const product = $("report-product").value;
  const values = new Map();
  for (const o of reportState.orders) for (const it of o.order_items || []) {
    if (product && BookingReport.productKey(it) !== product) continue;
    if (it.variant_label_snapshot) values.set(it.variant_label_snapshot, it.variant_label_snapshot);
  }
  reportSelect("report-size", values, "すべてのサイズ");
}
async function loadReport() {
  invalidateReport("読み込み中…");
  const generation = reportState.generation, tenant = state.tenantId;
  const from = $("report-from").value, to = $("report-to").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    $("report-message").textContent = "開始日・終了日を正しい順序で選んでください。"; return;
  }
  try {
    const orders = await BookingReport.fetchOrders(path => api("GET", path), tenant, from, to);
    if (generation !== reportState.generation || tenant !== state.tenantId) return;
    reportState.orders = orders;
    reportState.from = from; reportState.to = to;
    reportState.updated = new Date().toLocaleTimeString("ja-JP");
    const products = new Map();
    for (const o of orders) for (const it of o.order_items || []) products.set(BookingReport.productKey(it), it.product_name_snapshot || "名称なし");
    reportSelect("report-product", products, "すべての商品");
    reportSizes();
    reportState.ready = true;
    renderReport();
  } catch (e) {
    if (generation !== reportState.generation) return;
    $("report-message").textContent = "読み込みに失敗しました。通信状態を確認し、もう一度更新してください。";
  }
}
const reportSummaryTable = () => [["受取日", "商品", "サイズ", "製造数"], ...reportState.summary.map(s => [s.date, s.product, s.size, s.quantity])];
const reportDetailTable = () => [["受取日", "受取時間", "予約番号", "予約状況", "お客様名", "電話番号", "商品", "サイズ", "数量", "オプション", "質問への回答"], ...reportState.rows.map(({order:o, item:it}) =>
  [o.pickup_date, o.pickup_slot_label, o.order_number, STATUS[o.status] || o.status, o.customer_name, o.customer_phone, it.product_name_snapshot, it.variant_label_snapshot, it.quantity, BookingReport.options(it), BookingReport.answers(o)])];
function reportTable(table) {
  return `<table class="kitchen-table"><thead><tr>${table[0].map(s => `<th scope="col">${esc(s)}</th>`).join("")}</tr></thead><tbody>${table.slice(1).map(row => `<tr>${row.map(s => `<td>${esc(s)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function renderReport() {
  if (!reportState.ready) return;
  reportState.rows = BookingReport.rows(reportState.orders, {product: $("report-product").value, size: $("report-size").value, status: $("report-status").value, query: $("report-query").value});
  reportState.summary = BookingReport.summary(reportState.rows);
  const count = new Set(reportState.rows.map(r => r.order.id)).size;
  const total = reportState.summary.reduce((sum, s) => sum + s.quantity, 0);
  $("report-message").textContent = `該当予約 ${count}件 ／ 製造数 ${total}台　（${reportState.updated} 時点）`;
  $("report-scope").textContent = `${reportState.from} 〜 ${reportState.to} ／ ${$("report-product").selectedOptions[0].textContent} ／ ${$("report-size").selectedOptions[0].textContent} ／ ${$("report-status").selectedOptions[0].textContent}${$("report-query").value ? ` ／ 内容「${$("report-query").value}」` : ""}`;
  $("report-summary").innerHTML = reportState.summary.length ? reportTable(reportSummaryTable()) : '<p class="empty-note">対象の製造はありません。</p>';
  $("report-detail").innerHTML = reportState.rows.length ? reportTable(reportDetailTable()) : '<p class="empty-note">条件に合う予約はありません。</p>';
  $("report-summary-csv").disabled = !reportState.summary.length;
  $("report-detail-csv").disabled = !reportState.rows.length;
  $("report-results").classList.remove("hidden");
}
function downloadReport(kind) {
  if (!reportState.ready) return;
  const table = kind === "製造数" ? reportSummaryTable() : reportDetailTable();
  if (table.length < 2) return;
  const url = URL.createObjectURL(new Blob([BookingReport.csv(table)], {type:"text/csv;charset=utf-8"}));
  const a = document.createElement("a");
  a.href = url; a.download = `${kind}_${reportState.from}_${reportState.to}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("report-load").onclick = loadReport;
for (const id of ["report-from", "report-to"]) $(id).onchange = () => invalidateReport();
$("report-product").onchange = () => { reportSizes(); renderReport(); };
$("report-size").onchange = renderReport;
$("report-status").onchange = renderReport;
$("report-query").oninput = renderReport;
$("report-summary-csv").onclick = () => downloadReport("製造数");
$("report-detail-csv").onclick = () => downloadReport("受取リスト");
