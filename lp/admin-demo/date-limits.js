/* ---------- 特定の日だけの上限（2026-10-10） ----------
 * 上限に、日付ごとの台数を持たせる部品。設定ページ（全体の1日の上限・受取時間の枠）と商品ページ（商品ごとの上限）で共用。
 *   全体・商品の上限＝capacity_rule_date_overrides（rule_id × date → daily_limit）。判定は fn_rule_limit
 *   受取時間の枠　　＝slot_capacity_date_overrides（slot_id × date → capacity）。判定は fn_slot_capacity
 * どちらも予約・お客様の変更・予約ページの表示すべてに効く。登録は1日1行の upsert（同じ日は置き換え）。
 * 続いた日・同じ台数は1行にまとめて見せ、まとめてやめられる。
 *   DateLimits.mount(el, {
 *     api, toast, esc, tenantId, label,
 *     table, key, value,            // 例 "capacity_rule_date_overrides", "rule_id", "daily_limit"
 *     targets,                      // () => [{id, label}]  対象（ルール1つ、または枠の一覧）
 *     pick,                         // true なら対象を選ぶプルダウンを出す（「すべての時間」つき）
 *     note,                         // 見出しの下の説明（HTML可・固定の文だけ渡す）
 *     ensureTargets,                // async (選んだid|"") => [id]  対象が無ければ作って返す
 *     warn,                         // async () => 注意のHTML（上限の食い違い・limit-check.js）。一覧を描いた後に出す
 *   }) → { reload } */
(() => {
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const next = (s) => { const d = parse(s); d.setDate(d.getDate() + 1); return ymd(d); };
  const label = (s) => { const d = parse(s); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };

  // PostgREST は1回の応答の行数に上限があるので、空のページまで取りに行く（並びは id で固定）
  async function getAll(api, path) {
    const rows = [];
    for (;;) {
      const page = await api("GET", `${path}&order=date,id&limit=1000&offset=${rows.length}`);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }
  function mount(el, o) {
    el.classList.add("date-limit-box");
    el.innerHTML = `
      <h4>${o.esc(o.label)}<button type="button" class="tip" data-tip="クリスマスなど、その日だけ受ける台数を増やしたり減らしたりできます。&#10;登録した日は、普段の上限の代わりにこの台数で受付を止めます。&#10;0台にすると、その日はネット予約を受けません。">？</button></h4>
      <div class="override-add">
        <input type="date" class="dl-from" aria-label="開始日">
        <span>〜</span>
        <input type="date" class="dl-to" aria-label="終了日（1日だけなら空欄）">
        ${o.pick ? `<select class="dl-target" aria-label="受取時間"></select>` : ""}
        <input type="number" class="dl-limit" min="0" style="width:90px" placeholder="${o.pick ? "3" : "40"}" aria-label="台数">
        <span>${o.pick ? "台" : "台/日"}</span>
        <button type="button" class="pill dl-add">この日の上限にする</button>
      </div>
      ${o.note ? `<p class="small">${o.note}</p>` : ""}
      <p class="small">終了日が空欄なら1日だけ。すでに登録した日は、新しい台数に置き換わります。</p>
      <div class="dl-list"></div>
      <div class="dl-warn"></div>`;
    const $ = (s) => el.querySelector(s);
    let generation = 0;

    function fillTargets() {
      if (!o.pick) return;
      const sel = $(".dl-target"), keep = sel.value;
      sel.innerHTML = `<option value="">すべての時間</option>` +
        o.targets().map((t) => `<option value="${o.esc(t.id)}">${o.esc(t.label)}</option>`).join("");
      if ([...sel.options].some((x) => x.value === keep)) sel.value = keep;
    }

    async function reload() {
      const g = ++generation, list = $(".dl-list"), targets = o.targets();
      fillTargets();
      if (!targets.length) { list.innerHTML = `<p class="small">登録なし</p>`; await paintWarn(g); return; }
      let rows;
      try {
        rows = await getAll(o.api,
          `/rest/v1/${o.table}?tenant_id=eq.${o.tenantId()}&${o.key}=in.(${targets.map((t) => t.id).join(",")})` +
          `&date=gte.${ymd(new Date())}&select=id,date,${o.key},${o.value}`);
      } catch (e) {
        if (g === generation) list.innerHTML = `<p class="small">読み込めませんでした。画面を読み込み直してください。</p>`;
        return;
      }
      if (g !== generation) return; // 商品を切り替えた後に古い応答で描かない
      const order = new Map(targets.map((t, i) => [t.id, i]));
      rows.sort((a, b) => (order.get(a[o.key]) - order.get(b[o.key])) || a.date.localeCompare(b.date));
      const groups = [];
      for (const r of rows) {
        const last = groups[groups.length - 1];
        if (last && last.key === r[o.key] && last.limit === r[o.value] && next(last.to) === r.date) { last.to = r.date; last.ids.push(r.id); }
        else groups.push({ key: r[o.key], from: r.date, to: r.date, limit: r[o.value], ids: [r.id] });
      }
      list.innerHTML = groups.length ? "" : `<p class="small">登録なし</p>`;
      const name = new Map(targets.map((t) => [t.id, t.label]));
      for (const gr of groups) {
        const row = document.createElement("div");
        row.className = "ov-row";
        const span = gr.from === gr.to ? label(gr.from) : `${label(gr.from)}〜${label(gr.to).replace(/^\d+\//, "")}（${gr.ids.length}日）`;
        const who = o.pick ? `${name.get(gr.key) || ""}　` : "";
        const count = gr.limit === 0 ? "ネット予約を受けない" : `${gr.limit}${o.pick ? "台" : "台/日"}`;
        row.innerHTML = `<span style="flex:1">${o.esc(span)}　${o.esc(who)}${count}</span>
          <button type="button" class="pill danger">やめる</button>`;
        row.querySelector("button").onclick = async (e) => {
          e.currentTarget.disabled = true;
          try {
            // 1年分まとめても URL が長くなりすぎないよう、50件ずつ消す
            for (let i = 0; i < gr.ids.length; i += 50)
              await o.api("DELETE", `/rest/v1/${o.table}?tenant_id=eq.${o.tenantId()}&id=in.(${gr.ids.slice(i, i + 50).join(",")})`);
            o.toast("特定の日の上限をやめました");
          } catch (err) {
            o.toast("やめられませんでした：" + err.message);
          }
          reload();
        };
        list.appendChild(row);
      }
      await paintWarn(g);
    }
    async function paintWarn(g) {
      if (!o.warn) return;
      let h = "";
      try { h = await o.warn(); } catch { /* 注意が出せなくても設定はできる */ }
      if (g === generation) $(".dl-warn").innerHTML = h;
    }

    $(".dl-add").onclick = async () => {
      const from = $(".dl-from").value, to = $(".dl-to").value || from;
      const raw = $(".dl-limit").value.trim(), n = Number(raw);
      if (!from) { o.toast("日付を選んでください"); return; }
      if (to < from) { o.toast("終了日は開始日より後にしてください"); return; }
      // 小数（0.5 など）は 0 に丸めず、入力のまちがいとして止める
      if (raw === "" || !Number.isInteger(n) || n < 0) { o.toast("その日に受ける台数を、0以上の整数で入れてください"); return; }
      const dates = [];
      for (let d = from; d <= to; d = next(d)) {
        dates.push(d);
        if (dates.length > 366) { o.toast("1年分までにしてください"); return; }  // 遠い終了日でも作りながら止める
      }
      const btn = $(".dl-add");
      btn.disabled = true;
      try {
        const keys = await o.ensureTargets(o.pick ? $(".dl-target").value : "");
        if (!keys.length) { o.toast("受取時間の枠がありません。先に枠を追加してください"); return; }
        await o.api("POST", `/rest/v1/${o.table}?on_conflict=${o.key},date`,
          keys.flatMap((k) => dates.map((date) => ({ tenant_id: o.tenantId(), [o.key]: k, date, [o.value]: n }))),
          { prefer: "resolution=merge-duplicates,return=minimal" });
        $(".dl-from").value = ""; $(".dl-to").value = ""; $(".dl-limit").value = "";
        o.toast(dates.length === 1 ? `${label(from)} を${n}台にしました` : `${dates.length}日分を${n}台にしました`);
        await reload();
      } catch (e) {
        o.toast("登録できませんでした：" + e.message);
      } finally { btn.disabled = false; }
    };
    // 対象（商品など）を切り替えた瞬間に前の一覧を消し、古い応答も捨てる（前の商品の行を「やめる」できないように）
    function clear() {
      generation++;
      $(".dl-list").innerHTML = `<p class="small">読み込み中…</p>`;
      $(".dl-warn").innerHTML = "";
    }
    return { reload, clear };
  }
  window.DateLimits = { mount };
})();
