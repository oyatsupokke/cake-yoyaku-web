import { validateSuggestion, emptyQuestion, emptyOption, emptyGroup } from './product-assistant-core.js?v=20260927220000';

const dialog = document.getElementById('ai-product-dialog');
const review = document.getElementById('ai-product-review');
const source = document.getElementById('ai-product-description');
const status = document.getElementById('ai-product-status');
const generate = document.getElementById('ai-product-generate');
const close = document.getElementById('ai-product-close');
let suggestion = null, busy = false, requestId = null, submitted = null, storageTenant = null;
const types = { text: '文字（1行）', textarea: '文字（複数行）', select: 'プルダウン', radio: '1つ選ぶ', checkbox: '複数選ぶ', image: '画像' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const get = path => path.split('.').reduce((v, part) => v[part], suggestion);
function set(path, value) {
  const parts = path.split('.'); const key = parts.pop();
  parts.reduce((v, part) => v[part], suggestion)[key] = value;
}
const storageKey = () => `cake_product_assistant:${state.tenantId}`;
function persist() {
  if (!state.tenantId) return;
  try { sessionStorage.setItem(storageKey(), JSON.stringify({ source: source.value, suggestion, requestId, submitted })); } catch { /* メモリ内の案は保持 */ }
}
function restore() {
  if (storageTenant === state.tenantId) return;
  storageTenant = state.tenantId; source.value = ''; suggestion = null; requestId = null; submitted = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey()));
    if (saved) {
      source.value = String(saved.source || '').slice(0, 6000);
      if (saved.suggestion && !validateSuggestion(saved.suggestion).length) suggestion = saved.suggestion;
      if (saved.submitted && !validateSuggestion(saved.submitted, true).length && /^[a-f0-9-]{36}$/i.test(saved.requestId || '')) {
        submitted = saved.submitted; requestId = saved.requestId;
      }
    }
  } catch { /* 古い形式は使わない */ }
}
function message(text, error = false) {
  status.textContent = text; status.classList.toggle('ai-review-error', error);
}
function lock(on) {
  busy = on;
  close.disabled = on;
  source.disabled = on || !!submitted;
  generate.disabled = on || !!submitted;
  review.querySelectorAll('input,textarea,select,button').forEach(el => {
    el.disabled = on || (!!submitted && el.id !== 'ai-product-save');
  });
}
const textField = (path, label, max = 120) => `<label class="field">${escape(label)}<input type="text" data-path="${path}" maxlength="${max}" value="${escape(get(path))}"></label>`;
const numberField = (path, label, placeholder = '', max = 1000000, min = 0) => `<label class="field">${escape(label)}<input type="number" data-path="${path}" min="${min}" max="${max}" step="1" value="${escape(get(path))}" placeholder="${escape(placeholder)}"></label>`;
const checkField = (path, label) => `<label class="ai-review-check"><input type="checkbox" data-path="${path}" ${get(path) ? 'checked' : ''}>${escape(label)}</label>`;
const action = (name, path, label) => `<button type="button" class="pill" data-action="${name}" data-list="${path}">${escape(label)}</button>`;
const remove = path => action('remove', path, '削除');

function questionsHTML(questions, path) {
  return questions.map((q, index) => {
    const p = `${path}.${index}`;
    return `<div class="ai-review-question-box"><div class="ai-review-question">
      ${textField(`${p}.label`, '質問文')}
      <label class="field">回答方法<select data-path="${p}.input_type">${Object.entries(types).map(([key, name]) => `<option value="${key}" ${q.input_type === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
      ${checkField(`${p}.required`, '必須')}${remove(p)}</div>
      ${q.input_type === 'image' ? numberField(`${p}.image_max`, '画像の上限枚数', '1〜3枚', 3, 1) : ''}
      ${['select', 'radio', 'checkbox'].includes(q.input_type) ? `<div class="ai-review-choices">${q.choices.map((c, ci) => `<div class="ai-review-row">${textField(`${p}.choices.${ci}.label`, '回答の選択肢', 100)}${numberField(`${p}.choices.${ci}.price_delta`, '追加料金（税込円）', '無料は0')}${remove(`${p}.choices.${ci}`)}</div>`).join('')}${action('choice', `${p}.choices`, '＋ 回答の選択肢')}</div>` : ''}
      </div>`;
  }).join('') + action('question', path, '＋ 質問を追加');
}

function render() {
  review.classList.toggle('hidden', !suggestion);
  if (!suggestion) { review.replaceChildren(); return; }
  const d = suggestion;
  const shared = [...(state.globalGroups || []).map(g => g.name), ...(state.questions || []).filter(q => !q.option_id && q.scope === 'all' && q.is_active !== false).map(q => q.label)].filter(Boolean);
  review.innerHTML = `<h3>設定案を確認・修正</h3>
    <p class="small">金額の空欄を埋めてください。追加料金がない項目は0円です。写真は商品を保存した後に登録できます。</p>
    ${shared.length ? `<p class="ai-review-note">既存の共通項目「${shared.map(escape).join('」「')}」もこの商品に表示されます。案の中に同じ質問や選択肢がある場合は、重複するものを削除してください。</p>` : ''}
    <section class="ai-review-section"><h3>商品</h3>${textField('name', '商品名')}
      <label class="field">商品説明<textarea data-path="description" maxlength="1000">${escape(d.description)}</textarea></label>
      ${numberField('deadline_days', '締切（受取日の何日前まで）', '空欄は店舗の基本', 365)}
      <p class="small">日数の数え方・締切時刻は店舗設定に従います。</p></section>
    <section class="ai-review-section"><h3>サイズと税込価格</h3>
      ${d.variants.map((v, i) => `<div class="ai-review-row">${textField(`variants.${i}.size`, 'サイズ名', 50)}${numberField(`variants.${i}.price`, '税込価格（円）', '要入力')}${remove(`variants.${i}`)}</div>`).join('')}
      ${action('variant', 'variants', '＋ サイズを追加')}</section>
    <section class="ai-review-section"><h3>お客様に選んでもらうもの</h3>
    ${d.groups.map((g, gi) => {
      const gp = `groups.${gi}`;
      return `<div class="ai-review-group"><div class="ai-review-group-head">${textField(`${gp}.name`, '選択グループ名', 100)}
        <label class="field">選び方<select data-path="${gp}.selection_type"><option value="single" ${g.selection_type === 'single' ? 'selected' : ''}>1つ選ぶ</option><option value="multiple" ${g.selection_type === 'multiple' ? 'selected' : ''}>複数選べる</option></select></label>
        ${checkField(`${gp}.required`, '必須')}${remove(gp)}</div>
        ${g.selection_type === 'multiple' ? numberField(`${gp}.max_select`, '選べる種類数の上限', '空欄は上限なし', 20, 1) : ''}
        ${g.options.map((o, oi) => {
          const op = `${gp}.options.${oi}`;
          return `<div class="ai-review-option"><div class="ai-review-row">${textField(`${op}.name`, '選択肢名', 100)}${numberField(`${op}.price_delta`, '追加料金（税込円）', '無料は0')}${remove(op)}</div>
            <details ${o.questions.length || o.max_quantity || o.deadline_days !== null || o.requires_review ? 'open' : ''}><summary>個数・締切・この選択肢の質問</summary>
              <div class="ai-review-two">${numberField(`${op}.max_quantity`, '注文できる個数の上限', '空欄は1個', 100, 1)}${numberField(`${op}.deadline_days`, 'この選択肢の締切（日数）', '空欄は商品と同じ', 365)}</div>
              ${checkField(`${op}.requires_review`, '見積もり・お客様の承諾後に予約確定')}
              <p class="small">この選択肢を選んだ人への質問</p>${questionsHTML(o.questions, `${op}.questions`)}</details></div>`;
        }).join('')}${action('option', `${gp}.options`, '＋ 選択肢を追加')}</div>`;
    }).join('')}${action('group', 'groups', '＋ 選択グループを追加')}</section>
    <section class="ai-review-section"><h3>この商品を注文する全員への質問</h3>${questionsHTML(d.questions, 'questions')}</section>
    ${d.review_notes.length ? `<section class="ai-review-note"><h3>確認・追加設定すること</h3><ul>${d.review_notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul><p class="small">このメモは保存後の商品画面にも残ります。</p></section>` : ''}
    <div id="ai-product-errors" class="ai-review-error" role="alert"></div>
    <div class="ai-product-actions"><button type="button" class="btn-primary" id="ai-product-save">${submitted ? '同じ内容で保存結果を確認・再試行' : '非公開で保存して予約画面を確認'}</button></div>
    <p class="small">保存すると新しい商品が1件できます。予約画面で料金や選び方を確認してから、商品画面で公開してください。</p>`;
  lock(busy);
}

review.addEventListener('input', event => {
  const el = event.target, path = el.dataset.path;
  if (!path || busy || submitted) return;
  if (el.tagName === 'SELECT' || el.type === 'checkbox') return;
  set(path, el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value);
  persist();
});
review.addEventListener('change', event => {
  const el = event.target, path = el.dataset.path;
  if (!path || busy || submitted) return;
  if (el.type === 'checkbox') set(path, el.checked);
  if (el.tagName === 'SELECT') {
    set(path, el.value);
    const parent = path.slice(0, path.lastIndexOf('.'));
    if (path.endsWith('.selection_type') && el.value === 'single') set(`${parent}.max_select`, null);
    if (path.endsWith('.input_type')) {
      if (!['select', 'radio', 'checkbox'].includes(el.value)) set(`${parent}.choices`, []);
      set(`${parent}.image_max`, el.value === 'image' ? 1 : null);
    }
    render();
  }
  persist();
});
review.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || busy) return;
  if (button.id === 'ai-product-save') { save(); return; }
  if (submitted || !button.dataset.action) return;
  const path = button.dataset.list;
  if (button.dataset.action === 'remove') {
    const parts = path.split('.'), index = Number(parts.pop());
    get(parts.join('.')).splice(index, 1);
  } else {
    const factory = { variant: () => ({ size: '', price: null }), group: emptyGroup, option: emptyOption, question: emptyQuestion, choice: () => ({ label: '', price_delta: null }) }[button.dataset.action];
    const limits = { variant: 12, group: 10, option: 20, question: 10, choice: 20 };
    if (!factory) return;
    if (get(path).length >= limits[button.dataset.action]) { message('これ以上は追加できません', true); return; }
    get(path).push(factory());
  }
  render(); persist();
});

document.getElementById('btn-ai-product').onclick = () => {
  restore(); render(); message(submitted ? '前回の保存結果を確認してください。再試行しても商品は重複しません。' : '');
  dialog.showModal(); source.focus();
};
close.onclick = () => { if (!busy) { persist(); dialog.close(); } };
dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else persist(); });
source.addEventListener('input', persist);

generate.onclick = async () => {
  if (busy || submitted) return;
  if (source.value.trim().length < 10) { message('ケーキの内容を10文字以上で入力してください', true); source.focus(); return; }
  if (suggestion && !confirm('確認画面で修正した内容を、新しい設定案に置き換えますか？')) return;
  lock(true); message('設定案を作っています…');
  try {
    const call = () => fetch(`${CONFIG.url}/functions/v1/suggest-product`, {
      method: 'POST', headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${state.session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: source.value }), signal: AbortSignal.timeout(55000),
    });
    let response = await call();
    if (response.status === 401 && await refreshSession()) response = await call();
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (response.status === 401 ? '再ログインしてください' : '設定案を作れませんでした'));
    if (validateSuggestion(body.suggestion).length) throw new Error('設定案を確認できませんでした。入力を短くしてお試しください');
    suggestion = body.suggestion; requestId = null; persist(); render();
    message('設定案ができました。下の内容を確認してください。'); review.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    message(error.name === 'TimeoutError' ? '時間がかかっています。少し待ってからもう一度お試しください。' : error.message, true);
  } finally { lock(false); }
};

async function save() {
  if (busy || !suggestion) return;
  const invalid = [...review.querySelectorAll('input')].find(el => !el.checkValidity());
  if (invalid && !submitted) { invalid.reportValidity(); return; }
  const errors = validateSuggestion(suggestion, true);
  if (errors.length) {
    document.getElementById('ai-product-errors').innerHTML = `<ul>${errors.map(error => `<li>${escape(error)}</li>`).join('')}</ul>`;
    document.getElementById('ai-product-errors').scrollIntoView({ block: 'center', behavior: 'smooth' }); return;
  }
  if (!submitted) { submitted = structuredClone(suggestion); requestId = crypto.randomUUID(); persist(); }
  lock(true); message('非公開商品を保存しています…');
  let savedId = null;
  try {
    savedId = await api('POST', '/rest/v1/rpc/fn_create_product_from_suggestion', {
      p_tenant: state.tenantId, p_request_id: requestId, p_draft: submitted,
    });
    suggestion = null; submitted = null; requestId = null; source.value = ''; persist();
    state.current = { id: savedId }; await reloadAll();
    dialog.close(); toast('非公開で保存しました。予約画面で確認してください');
    document.getElementById('draft-preview-open').click();
  } catch (error) {
    if (savedId) {
      dialog.close(); toast('商品は保存済みです。再読み込みして確認してください');
    } else {
      // DB検証エラーは全体がロールバック。通信エラーは同じリクエストで再送する。
      if (error.code === '23514' || error.code === '42501') { submitted = null; requestId = null; persist(); }
      render(); message(`${error.message}。${submitted ? '同じ内容で再試行できます。保存済みの場合も商品は重複しません。' : '内容を確認してください。'}`, true);
    }
  } finally { lock(false); }
}

// AIが自動設定しなかった条件を、次回開いたときにも管理画面に残す。
const notesBox = document.createElement('section');
notesBox.className = 'ai-review-note hidden';
document.getElementById('editor').prepend(notesBox);
let notesVersion = 0;
let availabilityTenant = null;
async function checkAvailability() {
  if (!state.session || !state.tenantId || availabilityTenant === state.tenantId) return;
  const tenant = state.tenantId;
  availabilityTenant = tenant;
  try {
    const result = await api('GET', '/functions/v1/suggest-product');
    if (state.tenantId === tenant) document.getElementById('btn-ai-product').hidden = result?.available !== true;
  } catch { /* API接続の準備が終わるまでは入口を表示しない */ }
}
async function loadNotes() {
  const product = state.current, version = ++notesVersion;
  notesBox.classList.add('hidden');
  if (!product?.id || !state.session) return;
  try {
    const rows = await api('GET', `/rest/v1/product_assistant_creations?product_id=eq.${encodeURIComponent(product.id)}&select=review_notes`);
    if (version !== notesVersion || state.current?.id !== product.id) return;
    const notes = rows[0]?.review_notes;
    if (!Array.isArray(notes) || !notes.length) return;
    notesBox.innerHTML = `<h3>設定案からの確認メモ</h3><ul>${notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul><button type="button" class="pill">設定を確認したのでメモを閉じる</button>`;
    notesBox.classList.remove('hidden');
    notesBox.querySelector('button').onclick = async event => {
      event.target.disabled = true;
      try {
        await api('PATCH', `/rest/v1/product_assistant_creations?product_id=eq.${encodeURIComponent(product.id)}`, { review_notes: [] });
        notesBox.classList.add('hidden');
      } catch { event.target.disabled = false; toast('メモを更新できませんでした'); }
    };
  } catch { /* 新機能の準備中でも既存の商品エディタを使える */ }
}
document.addEventListener('product-editor-rendered', () => { loadNotes(); checkAvailability(); });
loadNotes(); checkAvailability();
