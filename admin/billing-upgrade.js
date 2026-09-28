/* Owner-confirmed upgrade: preview -> confirmed payment -> server-verified access. */
globalThis.ReservationUpgrade = (() => {
  const el = id => document.getElementById(id);
  let tenant = null, quoteId = null, busy = false, generation = 0;
  const money = n => Number(n).toLocaleString('ja-JP') + '円';
  const date = seconds => new Date(seconds * 1000).toLocaleString('ja-JP', { timeZone:'Asia/Tokyo', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' });
  function hidden(id, value) { el(id).classList.toggle('hidden', value); }
  function waiting(value) {
    busy=value;
    for (const id of ['upgrade-preview','upgrade-confirm','upgrade-refresh','upgrade-retry']) el(id).disabled=value;
  }
  async function request(action, id) {
    const response = await fetch(`${CONFIG.url}/functions/v1/upgrade-reservation-plan`, {
      method:'POST', headers:{apikey:CONFIG.anonKey,Authorization:`Bearer ${state.session.access_token}`,'Content-Type':'application/json'},
      body:JSON.stringify({action,...(id?{quote_id:id}:{})}),
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error || '変更状況を確認できません。再度ログインしてお試しください。');
    return data;
  }
  async function show(data) {
    hidden('upgrade-quote',true);hidden('upgrade-payment',true);hidden('upgrade-retry',true);
    el('upgrade-status').textContent=data.message || '';
    if(data.state==='completed') {
      const rows=await api('GET',`/rest/v1/tenants?id=eq.${tenant.id}&select=*`);
      if(rows[0]?.reservation_plan!=='standard') throw new Error('切り替えを反映中です。変更状況をもう一度確認してください。');
      renderBillingBanner(rows[0]);
      if(el('t-booking-window')) el('t-booking-window').max='90';
      if(el('t-booking-window-help')) el('t-booking-window-help').textContent='1〜90日で設定できます。90日は約3か月です。';
      toast('Standardに切り替わりました。商品・予約はそのまま使えます。');
      return;
    }
    if(data.quote_id) quoteId=data.quote_id;
    hidden('upgrade-preview',['pending','processing'].includes(data.state));
    if(data.state==='quoted') {
      if(!Number.isInteger(data.amount_due)||data.amount_due<0||data.currency!=='jpy') throw new Error('変更料金を確認できません。');
      el('upgrade-amount').textContent=money(data.amount_due);
      el('upgrade-next').textContent=`次回請求：${date(data.next_billing_at)}・以後は月額${money(data.monthly_amount)}（税込）`;
      el('upgrade-expiry').textContent=`この料金の有効期限：${new Date(data.expires_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}`;
      el('upgrade-confirm').textContent=data.amount_due===0?'内容を確認してStandardへ切り替える':`${money(data.amount_due)}を支払ってStandardへ切り替える`;
      hidden('upgrade-quote',false);
    } else if(data.state==='pending') {
      el('upgrade-status').textContent=data.message || 'お支払いの確認待ちです。完了するまでLiteのままご利用いただけます。';
      if(data.payment_url) {
        const url=new URL(data.payment_url);
        if(url.protocol!=='https:'||url.hostname!=='invoice.stripe.com') throw new Error('お支払い先を確認できません。');
        el('upgrade-payment').href=url.href;hidden('upgrade-payment',false);
      }
    } else if(data.state==='processing') {
      el('upgrade-status').textContent='前回の切り替え結果を確認します。同じ処理を再確認するため、二重請求はされません。';
      hidden('upgrade-retry',false);
    } else if(data.state==='expired') {
      quoteId=null;el('upgrade-status').textContent=data.message || '有効期限が切れました。変更料金を確認し直してください。';
    }
  }
  async function run(action, useQuote=true) {
    if(busy || !tenant) return;
    const version=generation;
    waiting(true);el('upgrade-status').textContent='確認しています…';
    try {
      const data=await request(action,useQuote?quoteId:null);
      if(version!==generation)return;
      await show(data);
    }catch(error){
      if(version===generation){el('upgrade-status').textContent=error.message;hidden('upgrade-preview',false);}
    }finally{if(version===generation)waiting(false);}
  }
  function render(t) {
    tenant=t;quoteId=null;generation++;waiting(false);
    const available=t.reservation_plan==='lite'&&t.billing_status==='active';
    hidden('billing-upgrade',!available);
    if(!available)return;
    hidden('upgrade-quote',true);hidden('upgrade-payment',true);hidden('upgrade-retry',true);hidden('upgrade-preview',false);
    el('upgrade-status').textContent='';
    if(state.session?.access_token) void run('status',false);
  }
  el('upgrade-preview').onclick=()=>run('preview',false);
  el('upgrade-confirm').onclick=()=>run('confirm');
  el('upgrade-retry').onclick=()=>run('confirm');
  el('upgrade-refresh').onclick=()=>run('status',false);
  window.addEventListener('focus',()=>{if(tenant?.reservation_plan==='lite'&&tenant?.billing_status==='active')void run('status',false);});
  return {render};
})();
