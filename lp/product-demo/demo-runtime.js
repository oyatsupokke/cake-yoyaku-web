/* Demo transport only. Original customer/admin DOM, styles and renderers are retained. */
(()=>{
const C=window.DEMO_CATALOG, KEY='cake_actual_demo_v1', clone=x=>JSON.parse(JSON.stringify(x));
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
function order(p,n){
 const product=C.products.find(x=>x.id===p.product_id),variant=product?.product_variants.find(x=>x.id===p.variant_id);
 if(!variant||!C.slots.some(x=>x.id===p.pickup_slot_id)||!/^\d{4}-\d{2}-\d{2}$/.test(p.pickup_date))throw Error('商品・サイズ・受取日時を選んでください');
 const groups=[...(product.option_groups||[]),...(C.option_groups||[])],opts=(p.options||[]).map(v=>{const g=groups.find(g=>(g.options||[]).some(o=>o.id===v.option_id)),o=g?.options.find(o=>o.id===v.option_id);if(!o)return {group_name_snapshot:'選択肢',option_name_snapshot:'選択肢',quantity:v.quantity||1,option_text:v.text||'',price_delta:0};return {group_name_snapshot:g.name,option_name_snapshot:o.name||o.shared_list_items?.name||'選択肢',quantity:v.quantity||1,option_text:v.text||'',price_delta:o.price_delta||0};});
 const amount=variant.price+opts.reduce((a,o)=>a+o.price_delta*o.quantity,0);
 return {id:'demo-order-'+n,tenant_id:C.tenant.id,order_number:n,status:'new',customer_name:'体験のお客様 '+n,customer_kana:'タイケン',customer_phone:'00000000000',customer_email:'demo@example.invalid',pickup_date:p.pickup_date,pickup_slot_id:p.pickup_slot_id,pickup_slot_label:C.slots.find(x=>x.id===p.pickup_slot_id).label,total_amount:amount,payment_method:'store',created_at:new Date().toISOString(),created_via:'customer',order_images:[],order_answers:(p.answers||[]).map(a=>({label_snapshot:C.questions.find(q=>q.id===a.question_id)?.label||'回答',answer_text:a.answer_text||'',choice_label_snapshot:C.questions.flatMap(q=>q.common_question_choices||[]).find(c=>c.id===a.choice_id)?.label||''})),order_items:[{product_id:product.id,variant_id:variant.id,product_name_snapshot:product.name,variant_label_snapshot:variant.size_label,quantity:1,unit_price:variant.price,order_item_options:opts}]};
}
function seed(){return [0,1,2].map((i)=>{const p=C.products[i%C.products.length];return {...order({product_id:p.id,variant_id:p.product_variants[0].id,pickup_slot_id:C.slots[i].id,pickup_date:today()},i+1),status:['new','confirmed','in_production'][i]};});}
let orders;try{orders=JSON.parse(sessionStorage.getItem(KEY));}catch{}if(!Array.isArray(orders))orders=seed();
const save=()=>sessionStorage.setItem(KEY,JSON.stringify(orders));save();
const tables={v_public_tenant:[C.tenant],tenants:[C.tenant],tenant_users:[{tenant_id:C.tenant.id}],products:C.products,common_questions:C.questions,pickup_time_slots:C.slots,option_groups:C.option_groups||[],option_availability_overrides:C.option_stops||[],capacity_rules:[],date_overrides:[]};
// その受取日に選べない選択肢（本番の fn_options_unavailable_on の簡易版：選べない日・選択肢ごとの締切）
function unavailableOn(productId,date){const p=C.products.find(x=>x.id===productId);if(!p)return [];const days=(new Date(date+'T12:00:00')-new Date(today()+'T12:00:00'))/864e5,rows=[];for(const g of [...(p.option_groups||[]),...(C.option_groups||[])])for(const o of g.options||[]){if((C.option_stops||[]).some(s=>s.option_id===o.id&&s.date===date))rows.push({option_id:o.id,reason:'stop'});else if(o.order_deadline_days!=null&&days<o.order_deadline_days)rows.push({option_id:o.id,reason:'deadline'});}return rows;}
function filtered(rows,u){for(const [k,v] of u.searchParams){if(v.startsWith('eq.'))rows=rows.filter(r=>String(r[k])===v.slice(3));if(v.startsWith('gte.'))rows=rows.filter(r=>String(r[k])>=v.slice(4));if(v.startsWith('lte.'))rows=rows.filter(r=>String(r[k])<=v.slice(4));if(v.startsWith('neq.'))rows=rows.filter(r=>String(r[k])!==v.slice(4));}return rows;}
const response=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,init={})=>{try{
 const u=new URL(typeof input==='string'?input:input.url,location.href),method=init.method||'GET',body=typeof init.body==='string'?JSON.parse(init.body):{};
 // No network fallback: every request is simulated or explicitly unavailable.
 if(!u.pathname.startsWith('/demo-api/'))return response({message:'デモでは外部通信・画像アップロードは行いません'},400);
 // Images (customer photos and the design snapshot) stay in the browser: accept the request, keep nothing.
 if(u.pathname.endsWith('/functions/v1/order-images')){if(body.action==='view')return response({ok:true,images:[]});return response({ok:true,id:'demo-img-'+Date.now(),upload_url:location.origin+'/demo-api/discard'});}
 if(u.pathname==='/demo-api/discard')return new Response(null,{status:200});
 if(u.pathname.includes('/functions/'))return response({message:'通知・決済はデモでは実行しません'},400);
 if(u.pathname.includes('/rpc/')){
 const name=u.pathname.split('/').pop();
 if(name==='fn_log_form_event')return response({ok:true});
 if(name==='fn_get_availability'){const rows=[],closed=C.tenant.closed_weekdays||[];for(let d=new Date(body.p_from+'T12:00:00');d<=new Date(body.p_to+'T12:00:00');d.setDate(d.getDate()+1)){const key=d.toISOString().slice(0,10),count=orders.filter(o=>o.pickup_date===key&&o.status!=='canceled').length;rows.push({d:key,status:key<=today()||closed.includes(d.getDay())?'closed':count>=10?'full':count>=7?'few':'open'});}return response(rows);}
 if(name==='fn_options_unavailable_on')return response(unavailableOn(body.p_product,body.p_date));
 if(name==='fn_get_slot_availability')return response(C.slots.map(s=>({slot_id:s.id,is_full:false})));
 if(name==='fn_place_order'||name==='fn_staff_place_order'){
 if(orders.filter(o=>o.pickup_date===body.p.pickup_date&&o.status!=='canceled').length>=10)return response({ok:false,message:'デモの1日上限10台に達しました'});
 const o=order(body.p,Math.max(0,...orders.map(x=>x.order_number))+1);orders.push(o);save();sessionStorage.setItem('cake_demo_last_date',o.pickup_date);return response({ok:true,order_number:o.order_number,total_amount:o.total_amount});}
 return response({message:'この操作はデモの対象外です'},400);
 }
 const table=u.pathname.split('/').pop();const rows=filtered(table==='orders'?orders:tables[table]||[],u);
 if(method==='GET')return response(clone(rows));
 if(method==='PATCH'&&table==='orders'&&Object.keys(body).every(k=>k==='status')&&['new','confirmed','in_production','completed','canceled'].includes(body.status)){rows.forEach(o=>o.status=body.status);save();return response(rows);}
 return response({message:'設定の保存・データ変更は、このデモでは行えません'},400);
 }catch(e){return response({message:e.message},400);}};
// Customer-only demo; no admin session is created.
window.addEventListener('DOMContentLoaded',()=>{
 const banner=document.createElement('div');banner.className='actual-demo-banner';banner.innerHTML='<strong>操作デモ</strong><span>実製品の画面です。予約・お客様情報はサンプル／送信・決済なし</span><nav><a href="/lp/product-demo/">お客様の予約画面</a><a href="/lp/">サービス紹介ページに戻る</a><button type="button" id="demo-reset">最初から</button></nav>';document.body.prepend(banner);
 document.getElementById('demo-reset').onclick=()=>{sessionStorage.removeItem(KEY);sessionStorage.removeItem('cake_demo_last_date');localStorage.removeItem('cake_form_pokke');location.reload();};
 const samples={'cust-sei':'体験','cust-mei':'サンプル','cust-sei-kana':'タイケン','cust-mei-kana':'サンプル','cust-phone':'00000000000','cust-email':'demo@example.invalid','cust-postal':'000-0000','cust-address':'サンプル県サンプル市1-2-3'};for(const [id,v]of Object.entries(samples)){const el=document.getElementById(id);if(el)el.value=v;}
 document.addEventListener('click',e=>{const a=e.target.closest('a');if(a&&(/products\.html|reset\.html|manage\.html/.test(a.getAttribute('href')||'')||(a.origin!==location.origin && !a.href.startsWith('https://cakebook.jp/')))){e.preventDefault();alert('このデモでは、お客様の予約操作を体験できます。管理機能は、お店の登録後にお試しください。');}},true);
 // 完了画面の「確認のご連絡をお待ちください」は本物と同じ文言なので、デモだと分かる1行に差し替える（pokkeのお客様が迷い込んでも本当の予約と取り違えないように）
 const pickup=document.getElementById('done-pickup');if(pickup)new MutationObserver(()=>{const t=pickup.textContent;if(t.includes('確認のご連絡をお待ちください。'))pickup.textContent=t.replace('お渡しします。確認のご連絡をお待ちください。','お渡しします（デモのため、実際の予約は入っていません）。').replace('確認のご連絡をお待ちください。','デモのため、実際の予約は入っていません。');}).observe(pickup,{childList:true,characterData:true,subtree:true});
 const done=document.querySelector('#view-done .done-box');if(done){const p=document.createElement('p');p.innerHTML='<b>こんな予約ページを、あなたのお店にも。</b><br><a class="demo-signup" href="/lp/#price">料金プランを見る →</a><small class="demo-trial-note">初期費用0円。お申し込みは準備中です。</small><a href="/lp/">サービス紹介ページに戻る</a>';done.append(p);}
});
})();
