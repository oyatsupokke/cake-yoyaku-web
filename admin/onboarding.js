/* =====================================================================
 * はじめにやること（新しく登録した店向けのチェックリスト・2026-10-03）
 * まりほ「登録して管理画面に投げ出されると何からやればいいか分からない」
 * 「最初の一手がスムーズだと取り掛かりやすい。ちょっとずつ触ると散らかる」。
 * - 予約・製造（ログイン直後の画面）の一番上にだけ出す
 * - 済んだかどうかは登録済みのデータから判定する（店にチェックを付けさせない）
 * - 次にやる1つだけを大きなボタンにする。全部済んだら出さない
 *   （＝稼働中の店では何も出ない）
 * - 商品も予約もまだ無い間は、空の予約・製造の部分を隠して案内だけにする（まりほ「すっきり」）
 * - 「たたむ」は1行にするだけ（消すと戻し方が分からなくなるため）。この端末だけ覚える
 * admin.js の api / state / $ を使う（admin.js の後に読み込む）。
 * ===================================================================== */
(() => {
  const box = document.getElementById("onboarding");
  if (!box) return;
  const TOKU_KEYS = ["seller", "manager", "address", "email", "extraFees", "paymentMethod",
    "paymentTiming", "delivery", "returns", "cancellation"];
  // 有料契約がまだの状態（支払いの不調・解約などは上の課金バナーが案内する）
  const UNPAID = ["setup_trial", "none", "incomplete_expired"];
  let steps = null, stepsTenant = null, visible = true, loading = null;

  const storeKey = (name) => `cake-onboarding-${name}:${state.tenantId}`;
  const remember = (name, value) => { try { localStorage.setItem(storeKey(name), value); } catch {} };
  const recall = (name) => { try { return localStorage.getItem(storeKey(name)); } catch { return null; } };

  function tokushohoDone(toku) {
    if (!toku) return false;
    if (toku.version === 2) return TOKU_KEYS.every((k) => String(toku[k] ?? "").trim());
    return !!String(toku.text ?? "").trim();   // 項目に分ける前の書き方で保存している店
  }

  // 設定タブの該当の欄へ移動して、どこを触ればいいかを少しだけ光らせる
  function openSettings(anchor) {
    document.querySelector('.tab[data-tab="settings"]')?.click();
    const target = document.getElementById(anchor);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.remove("onboarding-flash");
    void target.offsetWidth;
    target.classList.add("onboarding-flash");
    setTimeout(() => target.classList.remove("onboarding-flash"), 2600);
  }

  async function load() {
    const t = state.tenantId;
    const one = (path) => api("GET", path).then((rows) => rows.length > 0);
    const [slots, products, orders, tenant] = await Promise.all([
      one(`/rest/v1/pickup_time_slots?tenant_id=eq.${t}&is_active=eq.true&select=id&limit=1`),
      one(`/rest/v1/products?tenant_id=eq.${t}&is_published=eq.true&deleted_at=is.null&select=id&limit=1`),
      one(`/rest/v1/orders?tenant_id=eq.${t}&select=id&limit=1`),
      api("GET", `/rest/v1/tenants?id=eq.${t}&select=cancel_policy,tokushoho,billing_status,trial_ends_at,subdomain`).then((r) => r[0] || {}),
    ]);
    const status = tenant.billing_status || "exempt";
    const trialOpen = status === "setup_trial" && tenant.trial_ends_at && new Date(tenant.trial_ends_at) > new Date();
    const list = [
      { key: "pickup", title: "受取時間を決める", time: "約5分",
        why: "お客様が選べる受取の時間です。これが無いと商品を公開できません。同じ画面で定休日・締切も確認します。",
        done: slots, label: "受取時間の設定へ", go: () => openSettings("settings-pickup") },
      { key: "product", title: "ケーキを1つ登録して公開する", time: "約10分",
        why: "まずは一番よく出るケーキを1つだけ。サイズと価格まで入れて「公開」にします。2つ目からは「この商品をコピー」が早いです。",
        // 予約が1件でもある店は稼働中（季節の入れ替えで全商品を非公開にしていても案内に戻さない）
        done: products || orders, label: "商品の設定へ", go: () => { location.href = "./products.html"; } },
      { key: "policy", title: "キャンセルポリシーと特定商取引法の表記を書く", time: "約5分",
        why: "ネットで予約を受けるときに必要です。お客様の確認画面と確認メールに出ます。",
        done: !!String(tenant.cancel_policy ?? "").trim() && tokushohoDone(tenant.tokushoho),
        label: "記入欄へ", go: () => openSettings("settings-policy") },
    ];
    // テスト予約はお試し中だけ（契約後に試すと本物の予約になる）
    if (trialOpen) list.push({ key: "test", title: "お客様の画面でテスト予約をしてみる", time: "約3分",
      why: "実際の予約ページで、選んで・確認するところまで通します。テスト予約は保存されません。",
      done: orders || recall("tested") === "1", label: "予約ページを開く",
      go: () => {
        remember("tested", "1");
        window.open(`../?shop=${encodeURIComponent(tenant.subdomain || state.subdomain)}&trial=1`, "_blank", "noopener");
        render();
      } });
    list.push({ key: "billing", title: "有料契約をして、予約の受付を始める", time: "約3分",
      why: "お支払いの手続きが済むと、すぐに本予約を受け付けます。",
      done: !UNPAID.includes(status), label: "ご契約・お支払いへ",
      go: () => document.querySelector('.tab[data-tab="billing"]')?.click() });
    return list;
  }

  function render() {
    if (!steps) return;
    for (const s of steps) if (s.key === "test" && recall("tested") === "1") s.done = true;
    const left = steps.filter((s) => !s.done);
    box.classList.toggle("hidden", !visible || left.length === 0);
    // 準備中（商品も予約もまだ無い）は、空の日付・製造数・予約一覧を隠して案内だけにする
    document.body.classList.toggle("onboarding-setup", !steps.find((s) => s.key === "product").done);
    if (!left.length) return;
    const next = left[0];
    const folded = recall("folded") === "1";
    const doneCount = steps.length - left.length;
    box.replaceChildren();
    const head = document.createElement("div");
    head.className = "onboarding-head";
    const title = document.createElement("h2");
    const count = document.createElement("span");
    count.className = "onboarding-count";
    count.textContent = `${doneCount}／${steps.length} 完了`;
    title.append("はじめにやること ", count);
    const fold = document.createElement("button");
    fold.type = "button"; fold.className = "pill";
    fold.textContent = folded ? "開く" : "たたむ";
    fold.setAttribute("aria-expanded", String(!folded));
    fold.onclick = () => { remember("folded", folded ? "0" : "1"); render(); };
    head.append(title, fold);
    box.append(head);
    if (folded) {
      const p = document.createElement("p");
      p.className = "small";
      p.textContent = `次は「${next.title}」です。`;
      box.append(p);
      return;
    }
    const lead = document.createElement("p");
    lead.className = "small";
    lead.textContent = doneCount
      ? "上から順に進めると迷いません。済んだものは自動で ✅ になります。"
      : "まずはここから。上から順に進めると、1時間ほどで予約を受けられる状態になります。済んだものは自動で ✅ になります。";
    box.append(lead);
    const ol = document.createElement("ol");
    ol.className = "onboarding-steps";
    steps.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = s.done ? "is-done" : s === next ? "is-next" : "";
      const mark = document.createElement("span");
      mark.className = "onboarding-mark"; mark.setAttribute("aria-hidden", "true");
      mark.textContent = s.done ? "✅" : String(i + 1);
      const body = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = s.title;
      const time = document.createElement("span");
      time.className = "onboarding-time";
      time.textContent = s.done ? "済み" : s.time;
      body.append(name, " ", time);
      if (s === next) {
        const why = document.createElement("p");
        why.className = "small"; why.textContent = s.why;
        const go = document.createElement("button");
        go.type = "button"; go.className = "btn-primary onboarding-go";
        go.textContent = (doneCount ? "次はこれ：" : "ここから始める：") + s.label + " →";
        go.onclick = s.go;
        body.append(why, go);
      } else if (!s.done) {
        const link = document.createElement("button");
        link.type = "button"; link.className = "onboarding-link";
        link.textContent = s.label;
        link.onclick = s.go;
        body.append(" ", link);
      }
      if (s.done) li.setAttribute("aria-label", `${s.title}（済み）`);
      li.append(mark, body);
      ol.append(li);
    });
    box.append(ol);
    const help = document.createElement("p");
    help.className = "small onboarding-help";
    help.innerHTML = '分からないところは、右下の「AIに質問」か <a href="../help/" target="_blank" rel="noopener">使い方マニュアル</a> へ。';
    box.append(help);
  }

  // ログアウト・別の店でのログインのときは、前の店の案内を残さない
  function reset() {
    steps = null; stepsTenant = null; loading = null;
    box.classList.add("hidden");
    box.replaceChildren();
    document.body.classList.remove("onboarding-setup");
  }

  async function refresh() {
    if (!state.tenantId) return;
    if (stepsTenant !== state.tenantId) reset();
    const tenant = state.tenantId;
    const run = (loading = load());
    try {
      const list = await run;
      if (run !== loading || tenant !== state.tenantId) return;   // 後から始めた読み込みを優先
      steps = list; stepsTenant = tenant;
      render();
    } catch {
      if (run !== loading) return;   // 古い読み込みの失敗で、新しい表示を消さない
      box.classList.add("hidden");   // 案内が出ないだけで、管理画面は普段どおり使える
      document.body.classList.remove("onboarding-setup");
    }
  }

  window.Onboarding = {
    refresh,
    // 予約・製造の画面だけに出す。戻ってきたら設定の変化を読み直す
    onTab(tab) {
      visible = tab === "pickup";
      if (visible) refresh(); else box.classList.add("hidden");
    },
  };
  document.getElementById("btn-logout")?.addEventListener("click", reset);
  // 別タブ（商品の設定・予約ページ）から戻ったときにも反映する
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && visible && steps && steps.some((s) => !s.done)) refresh();
  });
})();
