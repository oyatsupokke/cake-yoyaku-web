/* 店舗向けの送信状況。配信サービスの生エラー（宛先等を含む）は画面へ出さない。 */
globalThis.MailDelivery = (() => {
  function describe(mail) {
    const error = String(mail.last_error || "");
    const kind = String(mail.kind || "");
    const customer = kind.startsWith("customer");
    const purpose = ({ customer: "予約確認", shop: "予約通知", customer_change: "変更のお知らせ", shop_change: "変更のお知らせ",
      customer_cancel: "キャンセルのお知らせ", shop_cancel: "キャンセルのお知らせ", customer_reminder: "受取前のご案内" })[kind];
    const recipient = customer ? "お客様宛" : kind.startsWith("shop") ? "お店宛" : "通知メール";
    const target = recipient + (purpose ? `（${purpose}）` : "");
    if (mail.status === "sent") return { target, status: "送信済み", reason: "", action: "" };
    const status = ({ failed: "送信できませんでした", processing: "送信処理中", pending: "送信待ち" })[mail.status] || "状況を確認できません";
    const stopped = mail.status === "failed";
    const retry = stopped ? "時間をおいて「確認メールを再送」を押してください。" : "自動で再試行します。そのままお待ちください。";
    let reason = "", action = "";
    if (/Invalid\s+`?to`?\s+field/i.test(error)) {
      reason = "メールアドレスの形式が正しくありません。";
      action = customer ? "お客様に正しいメールアドレスをご確認ください。訂正・再送についてはサポートへご連絡ください。"
        : "「設定」の予約通知先メールアドレスをご確認のうえ、訂正・再送についてはサポートへご連絡ください。";
    } else if (/daily_quota_exceeded|monthly_quota_exceeded/i.test(error)) {
      reason = "メール配信サービスの送信上限に達しています。";
      action = "CakeBookのサポートへご連絡ください。";
    } else if (/\b429\b|rate_limit_exceeded/i.test(error)) {
      reason = "一時的な混雑で、メール配信サービスが送信を制限しています。";
      action = retry;
    } else if (/resend:\s*(401|403)\b/i.test(error)) {
      reason = "メール配信サービスの設定を確認する必要があります。";
      action = "CakeBookのサポートへご連絡ください。";
    } else if (/\b5\d\d\b|timeout|timed out|fetch failed|network|connection/i.test(error)) {
      reason = "メール配信サービスとの通信で問題が起きました。";
      action = retry;
    } else if (error || stopped) {
      reason = "メールを送信できませんでした。";
      action = stopped ? "原因の確認が必要です。CakeBookのサポートへご連絡ください。" : retry;
    } else {
      action = "送信が終わるまでお待ちください。状況を更新しても変わらない場合はサポートへご連絡ください。";
    }
    return { target, status, reason, action };
  }
  return { describe };
})();
if (typeof module !== "undefined") module.exports = globalThis.MailDelivery;
