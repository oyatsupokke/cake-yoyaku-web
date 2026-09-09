/* 商品情報から印刷表示を組み立てる純粋関数。予約料金そのものは変更しない。 */
(function(root) {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const color = value => /^#[a-f0-9]{6}$/i.test(value || '') ? value : '#785b4a';
  const sort = rows => [...list(rows)].sort((a,b) => (a.display_order||0)-(b.display_order||0) || String(a.id).localeCompare(String(b.id)));
  function charges(product,catalog) {
    const groups=list(catalog.groups).filter(g => !g.product_id || g.product_id===product.id);
    const options=groups.flatMap(g=>list(g.options));
    const questions=list(catalog.questions).filter(q=>q.is_active!==false && (q.label||'').trim() &&
      ((q.option_id||q.trigger_option_id) ? options.some(o=>o.id===(q.option_id||q.trigger_option_id)) :
      q.scope==='all' || list(q.common_question_products).some(cp=>cp.product_id===product.id)));
    // 日付・共有リストの休止で変わり得る選択肢も含め、加算の可能性を表示する。
    const paid = options.some(o=>Number(o.price_delta)>0) || questions.some(q=>list(q.common_question_choices).some(c=>Number(c.price_delta)>0));
    const required = groups.some(g=>g.is_required && list(g.options).length && list(g.options).every(o=>Number(o.price_delta)>0)) ||
      questions.some(q=>q.is_required && !q.option_id && !q.trigger_option_id && list(q.common_question_choices).length && list(q.common_question_choices).every(c=>Number(c.price_delta)>0));
    return {paid,required};
  }
  const dateTime = (value,tz) => new Intl.DateTimeFormat('ja-JP',{timeZone:tz||'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
  function schedule(p,t) {
    const lines=[];
    if(p.sale_start_at) lines.push(`受付開始 ${dateTime(p.sale_start_at,t.timezone)}`);
    if(p.sale_end_at) lines.push(`受付締切 ${dateTime(p.sale_end_at,t.timezone)}`);
    if(p.pickup_mode==='dates') lines.push('受取日指定あり。日程は予約ページでご確認ください');
    else if(p.pickup_start_date || p.pickup_end_date) {
      lines.push(`受取期間 ${p.pickup_start_date||'指定なし'} 〜 ${p.pickup_end_date||'指定なし'}`);
      lines.push('期間中の受取可能日は予約ページでご確認ください');
    } else lines.push('受取可能日・ご予約期限は予約ページでご確認ください');
    return lines;
  }
  function model(sheet,catalog,now=new Date()) {
    const warnings=[],errors=[],cards=[];
    if(!sheet.title?.trim()) errors.push('タイトルを入れてください');
    for(const item of list(sheet.items)) {
      const p=list(catalog.products).find(p=>p.id===item.product_id);
      if(!p) {warnings.push('削除された商品を出力から除きます');continue;}
      const vs=sort(p.product_variants).filter(v=>v.is_available!==false);
      if(!vs.length) {errors.push(`${p.name}：販売可能なサイズがありません。商品設定を直すか、掲載から外してください`);continue;}
      if(vs.some(v=>!Number.isInteger(v.price)||v.price<0)) errors.push(`${p.name}：価格の登録を確認してください`);
      if(vs.some(v=>v.price===0)) warnings.push(`${p.name}：0円のサイズがあります`);
      if(!p.is_published) warnings.push(`${p.name}：非公開のため予約ページに表示されません`);
      if(p.sale_start_at && new Date(p.sale_start_at)>now) warnings.push(`${p.name}：受付開始前です`);
      if(p.sale_end_at && new Date(p.sale_end_at)<=now) warnings.push(`${p.name}：受付期間が終了しています`);
      const desc=item.description_override ?? p.description ?? '';
      if(desc.length>160) errors.push(`${p.name}：メニュー用の説明を160文字以内に整えてください`);
      cards.push({product:p,item,description:desc,variants:vs,charges:charges(p,catalog),schedule:schedule(p,catalog.tenant)});
    }
    if(!cards.length) errors.push('掲載する商品を選んでください');
    const t=catalog.tenant;
    const active=t.is_active!==false && ['active','exempt','past_due','trialing'].includes(t.billing_status||'exempt') &&
      (t.billing_status!=='trialing' || (t.trial_ends_at && new Date(t.trial_ends_at)>now));
    if(!active) warnings.push('この店舗は現在、本予約を受け付けていません。配布前にご契約・受付状態をご確認ください');
    const scheduleKey=p=>JSON.stringify([p.sale_start_at,p.sale_end_at,p.pickup_mode,p.pickup_start_date,p.pickup_end_date,p.pickup_dates,p.pickup_holiday_dates,p.allowed_pickup_weekdays,p.order_deadline_days,p.has_availability_overrides]);
    const sharedSchedule=cards.length && cards.every(c=>scheduleKey(c.product)===scheduleKey(cards[0].product)) ? cards[0].schedule : [];
    return {cards,sharedSchedule,errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
  }
  const safeImage = (url,origin) => {try {const u=new URL(url);return u.origin===origin && u.pathname.startsWith('/storage/v1/object/public/shop-images/') ? u.href : '';} catch{return '';}};
  const photoURL=(item,product,origin) => item.photo_path
    ? (/^[a-z0-9-]+\/menus\/[0-9a-f-]{36}\.jpg$/.test(item.photo_path) ? safeImage(origin+'/storage/v1/object/public/shop-images/'+item.photo_path,origin) : '')
    : safeImage(product?.photo_url,origin);
  const footerDefaults={show_footer:true,show_shop:true,shop_text:null,show_schedule:true,schedule_text:null,show_notice:true,notice_text:null,show_date:true,date_label:'作成日',date_value:null,show_pages:true,page_format:'{page} / {pages}',show_qr:true,qr_label:'ご予約はこちら'};
  const footerSettings=sheet=>({...footerDefaults,...sheet.footer_settings});
  function footerText(sheet,catalog,menu){
    const f=footerSettings(sheet);
    return {settings:f,shop:f.shop_text??catalog.tenant.name,schedule:f.schedule_text??menu.sharedSchedule.join('\n'),notice:f.notice_text??'最新の価格・受付状況は\n予約ページでご確認ください'};
  }
  const api={escape,color,sort,charges,schedule,model,safeImage,photoURL,footerDefaults,footerSettings,footerText};
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  root.MenuSheetCore=api;
})(typeof window!=='undefined'?window:globalThis);
