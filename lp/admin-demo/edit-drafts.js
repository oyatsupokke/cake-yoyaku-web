/* ページ内の下書き。保存以外の操作・再描画で確定も破棄もしない。 */
function createEditDrafts() {
  const pending = new Map();
  const key = (t, id, c) => `${t}:${id}:${c}`;
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    register(f) {
      const draft = pending.get(key(f.table, f.id, f.column));
      if (draft) f.original = draft.original;
      return f;
    },
    capture(fields) {
      for (const f of fields) {
        if (!document.body.contains(f.el)) continue;
        const k = key(f.table, f.id, f.column), value = f.get();
        if (equal(value, f.original)) pending.delete(k);
        else pending.set(k, { table: f.table, id: f.id, column: f.column,
          value: structuredClone(value), original: structuredClone(f.original) });
      }
    },
    changes(fields) {
      this.capture(fields);
      const rows = new Map();
      for (const f of pending.values()) {
        const k = `${f.table}:${f.id}`;
        if (!rows.has(k)) rows.set(k, { table: f.table, id: f.id, patch: {} });
        rows.get(k).patch[f.column] = f.value;
      }
      return [...rows.values()];
    },
    value(table, id, column, fallback) {
      const f = pending.get(key(table, id, column));
      return f ? f.value : fallback;
    },
    // RESTで取得したレコードに下書きを重ねて再描画する。サーバーには送らない。
    overlay(table, data) {
      if (Array.isArray(data)) return data.map(row => this.overlay(table, row));
      if (!data || typeof data !== 'object') return data;
      const row = { ...data };
      for (const [name, value] of Object.entries(row)) {
        if (value && typeof value === 'object') row[name] = this.overlay(name, value);
      }
      if (row.id) for (const f of pending.values()) {
        if (f.table === table && f.id === row.id) row[f.column] = structuredClone(f.value);
      }
      return row;
    },
    acknowledge(change, fields) {
      for (const [column, value] of Object.entries(change.patch)) {
        const k = key(change.table, change.id, column);
        const draft = pending.get(k);
        if (draft && equal(draft.value, value)) pending.delete(k);
        else if (draft) draft.original = structuredClone(value);
        for (const f of fields) if (key(f.table, f.id, f.column) === k)
          f.original = structuredClone(value);
      }
    },
    forget(table, ids) {
      for (const [k, f] of pending) if (f.table === table && ids.includes(f.id)) pending.delete(k);
    },
  };
}
