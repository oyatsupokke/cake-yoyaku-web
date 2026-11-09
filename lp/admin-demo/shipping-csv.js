/* =====================================================================
 * 送り状CSV（ヤマト運輸 B2クラウドの「外部データから発行」用）— 配送 2026-10-05
 * - 予約・製造の「この日」に発送する配送の予約（支払い済み・キャンセル以外）を1行ずつ
 * - 列は B2クラウドの基本レイアウトの先頭から（お客様管理番号〜品名1）。クール区分は冷凍
 * - B2クラウドは Shift_JIS のCSVを読むので、encoding-japanese（同梱・MIT）で変換する。
 *   読み込めない環境では UTF-8（BOM付き）で出す
 * - 実際のB2クラウドでの取り込みは導入店で確認する（列がずれたら B2 の「取込パターン」で合わせる）
 * ===================================================================== */
(() => {
  const TIME_CODE = { "指定なし": "", "午前中": "0812", "14〜16時": "1416", "16〜18時": "1618", "18〜20時": "1820", "19〜21時": "1921" };
  const HEADER = ["お客様管理番号", "送り状種類", "クール区分", "伝票番号", "出荷予定日", "お届け予定日", "配達時間帯",
    "お届け先コード", "お届け先電話番号", "お届け先電話番号枝番", "お届け先郵便番号", "お届け先住所", "お届け先アパートマンション名",
    "お届け先会社・部門１", "お届け先会社・部門２", "お届け先名", "お届け先名(ｶﾅ)", "敬称",
    "ご依頼主コード", "ご依頼主電話番号", "ご依頼主電話番号枝番", "ご依頼主郵便番号", "ご依頼主住所", "ご依頼主アパートマンション",
    "ご依頼主名", "ご依頼主名(ｶﾅ)", "品名コード１", "品名１"];
  const slash = (iso) => String(iso || "").replaceAll("-", "/");
  const cell = (v) => {
    const s = String(v ?? "").replace(/\r?\n/g, " ");
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const digits = (s) => String(s || "").replace(/[^0-9-]/g, "");
  /** B2クラウドは住所1欄が全角32文字まで。超えた分は「アパートマンション名」の欄へ回す */
  const splitAddress = (addr) => {
    const a = String(addr || "");
    return a.length <= 32 ? [a, ""] : [a.slice(0, 32), a.slice(32, 64)];
  };

  function rows(orders, shop) {
    const shopPostal = (String(shop.address || "").match(/〒?\s*(\d{3}-?\d{4})/) || [])[1] || "";
    const shopAddr = String(shop.address || "").replace(/〒?\s*\d{3}-?\d{4}\s*/, "");
    return orders.map((o) => {
      const item = o.order_items?.[0] || {};
      const [a1, a2] = splitAddress(`${o.ship_prefecture || ""}${o.ship_address || ""}`);
      const [s1, s2] = splitAddress(shopAddr);
      return [
        `No.${o.order_number}`, "0", "2", "", slash(o.pickup_date), slash(o.delivery_date), TIME_CODE[o.delivery_time] ?? "",
        "", digits(o.ship_phone), "", digits(o.ship_postal_code), a1, a2,
        "", "", o.ship_name || "", "", "様",
        "", digits(shop.phone), "", digits(shopPostal), s1, s2,
        shop.name || "", "", "", `${item.product_name_snapshot || "ケーキ"} ${item.variant_label_snapshot || ""}`.trim().slice(0, 25),
      ];
    });
  }

  async function loadEncoder() {
    if (window.Encoding) return window.Encoding;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/encoding-japanese-2.2.0.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.Encoding;
  }

  window.ShippingCsv = {
    targets: (orders) => orders.filter((o) => o.fulfillment === "delivery" && o.status !== "canceled" && o.payment_status === "paid"),
    async download(orders, shop, date) {
      const text = [HEADER, ...rows(orders, shop)].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
      let blob;
      try {
        const E = await loadEncoder();
        blob = new Blob([new Uint8Array(E.convert(E.stringToCode(text), { to: "SJIS", from: "UNICODE" }))], { type: "text/csv;charset=shift_jis" });
      } catch {
        blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `送り状_${date}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    _rows: rows, _header: HEADER,
  };
})();
