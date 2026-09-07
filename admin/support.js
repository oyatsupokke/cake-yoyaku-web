/* Initial setup requests use the published support mailbox; never send or charge automatically. */
const SUPPORT_EMAIL = 'info@oyatsupokke.com';
const SUPPORT_TYPES = {
 guided: { label: '初期設定サポート（60分）', price: '5,500円（税込）／1回' },
 setup: { label: '初期設定代行', price: '12,000円（税込）／1店舗（範囲外は事前見積もり）' },
 illustration: { label: 'イラスト作成のご相談', price: '商品点数・必要なイラストの内容に応じて個別見積もり' },
 question: { label: '通常のお問い合わせ・不具合報告', price: 'お問い合わせの送信は無料です' },
};
let supportTenant = null;
let supportTenantId = null;
let supportLoading = false;
let supportPrepared = '';
function supportMessage(values) {
 const type = SUPPORT_TYPES[values.kind];
 if (!type) throw new Error('依頼内容を選んでください。');
 if (!values.shop.trim() || !values.email.trim() || !values.details.trim()) throw new Error('店舗名・連絡先・相談内容を入力してください。');
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) throw new Error('連絡先メールアドレスを確認してください。');
 if (values.details.length > 1500 || values.dates.length > 300) throw new Error('入力内容が長すぎます。相談内容は1,500文字、希望日時は300文字までにしてください。');
 if (values.kind === 'guided' && !values.dates.trim()) throw new Error('希望日時を入力してください。');
 if (values.kind === 'illustration' && (!Number.isInteger(Number(values.productCount)) || Number(values.productCount) < 1 || Number(values.productCount) > 1000)) throw new Error('イラストを作りたい商品点数を1〜1,000で入力してください。');
 return [`【${type.label}】`, `店舗名：${values.shop.trim()}`, `店舗ID：${values.tenantId}`, `返信先：${values.email.trim()}`, `料金：${type.price}`, '', '相談・依頼内容：', values.details.trim(), '', ...(values.kind === 'illustration' ? ['対象商品数：' + values.productCount + '点', ''] : []), ...(values.kind === 'guided' ? ['希望日時（日本時間）：', values.dates.trim(), ''] : []), '料金・対応範囲・日程の確認後に正式依頼します。'].join('\n');
}
async function openSupport() {
 if (supportLoading) return;
 if (supportTenantId !== state.tenantId) {
  $('support-form').reset(); supportTenant = null; supportTenantId = state.tenantId;
  $('support-preview').classList.add('hidden'); $('support-feedback').textContent = '';
 }
 $('support-shop').value = state.tenantName;
 if (!supportTenant) {
  supportLoading = true;
  try {
   const id = state.tenantId;
   const rows = await api('GET', `/rest/v1/tenants?id=eq.${id}&select=name,contact_email`);
   if (id !== state.tenantId) return;
   supportTenant = rows[0];
   if (!$('support-email').value) $('support-email').value = supportTenant?.contact_email || state.session?.user?.email || '';
  } catch { $('support-feedback').textContent = '登録情報を読み込めませんでした。連絡先を入力してください。'; }
  finally { supportLoading = false; }
 }
 updateSupportType();
}
function updateSupportType() {
 const kind = $('support-kind').value;
 $('support-dates-field').classList.toggle('hidden', kind !== 'guided');
 $('support-dates').required = kind === 'guided';
 $('support-illustration-field').classList.toggle('hidden', kind !== 'illustration');
 $('support-product-count').required = kind === 'illustration';
 $('support-price').textContent = SUPPORT_TYPES[kind].price;
}
$('support-kind').onchange = updateSupportType;
$('support-form').addEventListener('input', () => {
 $('support-preview').classList.add('hidden'); supportPrepared = ''; $('support-feedback').textContent = '';
});
$('support-form').onsubmit = (event) => {
 event.preventDefault();
 try {
  const values = {kind: $('support-kind').value, shop: $('support-shop').value, email: $('support-email').value.trim(), details: $('support-details').value, dates: $('support-dates').value, tenantId: state.tenantId, productCount: $('support-product-count').value};
  supportPrepared = supportMessage(values);
  $('support-mail-text').value = supportPrepared;
  $('support-mail-link').href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('ケーキ屋さんの予約帳：' + SUPPORT_TYPES[values.kind].label)}&body=${encodeURIComponent(supportPrepared)}`;
  $('support-preview').classList.remove('hidden');
  $('support-preview-title').focus();
 } catch(e) { $('support-feedback').textContent = e.message; }
};
$('support-mail-link').addEventListener('click', () => {
 $('support-feedback').textContent = 'まだ依頼は送信されていません。メールアプリで内容を確認し、送信してください。開かない場合は下の「本文をコピー」をご利用ください。';
});
$('support-copy').onclick = async () => {
 try { await navigator.clipboard.writeText(supportPrepared); $('support-feedback').textContent = '本文をコピーしました。宛先 info@oyatsupokke.com に貼り付けて送信してください。'; }
 catch { $('support-mail-text').focus(); $('support-mail-text').select(); $('support-feedback').textContent = '本文を選択しました。コピーしてメールに貼り付けてください。'; }
};
