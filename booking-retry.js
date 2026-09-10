/* A pending submission belongs to this tab. Keep its exact payload across reloads,
 * including uploaded image IDs; never manufacture a new request after an uncertain response. */
globalThis.BookingRetry = class {
  constructor(storage, key) { this.storage = storage; this.key = key; }
  pending() {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value?.payload?.p?.request_id || !value.slotLabel) throw new Error('送信情報を確認できません。お店へ予約状況をお問い合わせください');
    return value;
  }
  begin(payload, slotLabel) {
    const pending = this.pending();
    if (pending) return pending;
    const value = {payload: structuredClone(payload), slotLabel};
    value.payload.p.request_id = crypto.randomUUID();
    // Must persist before dispatch; if storage is unavailable, do not send.
    this.storage.setItem(this.key, JSON.stringify(value));
    return value;
  }
  clear() { this.storage.removeItem(this.key); }
};
