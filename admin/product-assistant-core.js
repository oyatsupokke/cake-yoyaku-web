// AI出力・確認画面で共用する商品案の形式。DBの識別子や公開フラグは含めない。
const obj = (properties) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const str = (maxLength) => ({ type: 'string', maxLength });
const list = (items, maxItems) => ({ type: 'array', items, maxItems });
const num = (maximum, minimum = 0) => ({ type: ['integer', 'null'], minimum, maximum });
const bool = { type: 'boolean' };
const question = obj({
  label: str(120), input_type: { type: 'string', enum: ['text', 'textarea', 'select', 'radio', 'checkbox', 'image'] },
  required: bool, image_max: num(3, 1),
  choices: list(obj({ label: str(100), price_delta: num(1000000) }), 20),
});
export const suggestionSchema = obj({
  name: str(120), description: str(1000), deadline_days: num(365),
  variants: list(obj({ size: str(50), price: num(1000000) }), 12),
  groups: list(obj({
    name: str(100), selection_type: { type: 'string', enum: ['single', 'multiple'] }, required: bool, max_select: num(20, 1),
    options: list(obj({
      name: str(100), price_delta: num(1000000), max_quantity: num(100, 1), deadline_days: num(365),
      requires_review: bool, questions: list(question, 10),
    }), 20),
  }), 10),
  questions: list(question, 10), review_notes: list(str(300), 20),
});

function check(value, schema, path, errors) {
  if (value === null && Array.isArray(schema.type) && schema.type.includes('null')) return;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if ((type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) ||
      (type === 'array' && !Array.isArray(value)) ||
      (type === 'string' && typeof value !== 'string') ||
      (type === 'boolean' && typeof value !== 'boolean') ||
      (type === 'integer' && !Number.isInteger(value))) {
    errors.push(`${path}の形式を確認してください`); return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}の選択を確認してください`);
  if (type === 'string' && value.length > schema.maxLength) errors.push(`${path}が長すぎます`);
  if (type === 'integer' && (value < schema.minimum || value > schema.maximum)) errors.push(`${path}の範囲を確認してください`);
  if (type === 'object') {
    for (const key of Object.keys(value)) if (!(key in schema.properties)) errors.push(`${path}に未対応の項目があります`);
    for (const [key, child] of Object.entries(schema.properties)) check(value[key], child, `${path}.${key}`, errors);
  }
  if (type === 'array') {
    if (value.length > schema.maxItems) { errors.push(`${path}の項目が多すぎます`); return; }
    value.forEach((v, i) => check(v, schema.items, `${path}[${i + 1}]`, errors));
  }
}

export function validateSuggestion(draft, forSave = false) {
  const errors = [];
  check(draft, suggestionSchema, '設定案', errors);
  if (errors.length) return errors;
  const options = draft.groups.flatMap(g => g.options);
  const questions = [...draft.questions, ...options.flatMap(o => o.questions)];
  if (options.length > 60 || questions.length > 40) errors.push('1商品につき選択肢60件・質問40件までにしてください');
  if (!forSave) return errors;
  if (!draft.name.trim()) errors.push('商品名を入力してください');
  if (!draft.variants.length) errors.push('サイズと価格を1件以上追加してください');
  const sizes = new Set();
  draft.variants.forEach((v, i) => {
    if (!v.size.trim()) errors.push(`サイズ${i + 1}の名前を入力してください`);
    if (v.price === null) errors.push(`${v.size || 'サイズ' + (i + 1)}の税込価格を入力してください`);
    if (sizes.has(v.size.trim())) errors.push('同じサイズ名が重複しています');
    sizes.add(v.size.trim());
  });
  draft.groups.forEach((g, i) => {
    if (!g.name.trim()) errors.push(`選択グループ${i + 1}の名前を入力してください`);
    if (!g.options.length) errors.push(`${g.name || '選択グループ'}に選択肢を追加してください`);
    if (g.max_select !== null && (g.selection_type === 'single' || g.max_select > g.options.length)) errors.push(`${g.name}の選べる種類数を確認してください`);
    g.options.forEach(o => {
      if (!o.name.trim()) errors.push('選択肢名を入力してください');
      if (o.price_delta === null) errors.push(`${o.name || '選択肢'}の追加料金を入力してください（無料は0円）`);
    });
  });
  questions.forEach(q => {
    if (!q.label.trim()) errors.push('質問文を入力してください');
    if (['select', 'radio', 'checkbox'].includes(q.input_type)) {
      if (!q.choices.length) errors.push(`${q.label}の回答の選択肢を追加してください`);
      q.choices.forEach(c => {
        if (!c.label.trim()) errors.push('回答の選択肢名を入力してください');
        if (c.price_delta === null) errors.push(`${c.label || '回答の選択肢'}の追加料金を入力してください（無料は0円）`);
      });
    } else if (q.choices.length) errors.push(`${q.label}の回答形式と選択肢が一致しません`);
    if (q.input_type === 'image' && q.image_max === null) errors.push(`${q.label}の画像枚数を選んでください`);
  });
  return [...new Set(errors)];
}

export const emptyQuestion = () => ({ label: '', input_type: 'text', required: false, image_max: null, choices: [] });
export const emptyOption = () => ({ name: '', price_delta: null, max_quantity: null, deadline_days: null, requires_review: false, questions: [] });
export const emptyGroup = () => ({ name: '', selection_type: 'single', required: false, max_select: null, options: [emptyOption()] });
