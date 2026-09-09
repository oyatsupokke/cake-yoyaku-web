/* 商品設定からメニュー表を作成。認証キーは既存管理画面と共通。 */
(() => {
"use strict";
const CONFIG = {
  url: "https://teqqbcsxiknwttiftzel.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlcXFiY3N4aWtud3R0aWZ0emVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDU0ODEsImV4cCI6MjEwMDQ4MTQ4MX0.KpNEUy0s4k8XGJAImdDSVpEVFVfYBdyLWcaZQMYAxDw",
};
const C=MenuSheetCore, $=id=>document.getElementById(id), esc=C.escape;
const state={session:null,tenantId:null,catalog:null,sheets:[],sheet:null,dirty:false,busy:false,renderId:0,timer:null,failedImages:[],layoutErrors:[]};
const say=text=>{$('status').textContent=text;};
async function api(method,path,body,retry=true){
 const res=await fetch(CONFIG.url+path,{method,headers:{apikey:CONFIG.anonKey,Authorization:`Bearer ${state.session?.access_token||''}`,'Content-Type':body instanceof Blob?body.type:'application/json',Prefer:'return=representation'},body:body instanceof Blob?body:body==null?undefined:JSON.stringify(body)});
 if(res.status===401 && retry && state.session?.refresh_token){
  const refresh=await fetch(CONFIG.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:CONFIG.anonKey,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:state.session.refresh_token})});
  if(refresh.ok){state.session=await refresh.json();localStorage.setItem('pokke_admin_session',JSON.stringify(state.session));return api(method,path,body,false);}
 }
 if(res.status===401){state.renderId++;state.catalog=null;$('pages').replaceChildren();$('workspace').hidden=true;$('login').hidden=false;throw Error('ログインし直してください');}
 if(!res.ok){const d=await res.json().catch(()=>({}));throw Error(['40001','P0002','42501','23514'].includes(d.code)?d.message:`操作できませんでした（${res.status}）。時間をおいて再度お試しください。`);}
 const text=await res.text();return text?JSON.parse(text):null;
}
const rpc=(name,body)=>api('POST','/rest/v1/rpc/'+name,body);
const catalog=()=>rpc('fn_menu_catalog',{p_tenant:state.tenantId});
async function loadLibrary(){
 const rows=[];let offset=0;
 for(;;){const part=await api('GET',`/rest/v1/menu_sheets?tenant_id=eq.${state.tenantId}&select=*,menu_sheet_items(*)&order=updated_at.desc,id&limit=200&offset=${offset}`);rows.push(...part);if(part.length<200)break;offset+=200;}
 state.sheets=rows;
 $('saved-menu').innerHTML='<option value="">新しいメニュー</option>'+rows.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
 $('saved-menu').value=state.sheet?.id||'';
}
function newSheet(){return {id:null,revision:null,name:'ケーキのメニュー',title:'ケーキのご案内',intro:'',template_key:'photo_cards',accent_color:C.color(state.catalog.tenant.theme?.accent),items:[],footer_settings:{}};}
function setSheet(sheet){
 state.sheet=structuredClone(sheet);state.sheet.items ||= C.sort(state.sheet.menu_sheet_items);delete state.sheet.menu_sheet_items;
 state.dirty=false;
 for(const [id,key] of [['name','name'],['title','title'],['intro','intro'],['template','template_key'],['accent','accent_color']]) $(id).value=state.sheet[key];
 $('saved-menu').value=state.sheet.id||'';
 renderPicker();renderSelected();renderFooterEditor();updateSave();schedulePreview();
}
function updateSave(){
 $('save-status').textContent=state.dirty?'保存していない変更があります':state.sheet.id?'保存済み':'新しいメニュー';
 $('delete-menu').disabled=!state.sheet.id;$('save-menu').disabled=state.busy;
}
function changed(){state.dirty=true;updateSave();document.body.classList.remove('print-ready');schedulePreview();}
function confirmLeave(){return !state.dirty || confirm('保存していない変更があります。変更を破棄して切り替えますか？');}
function visibleProducts(){return state.catalog.products.filter(p=>(p.is_published||$('include-hidden').checked)&&(!$('category').value||p.category_id===$('category').value));}
function renderPicker(){
 $('product-picker').innerHTML=visibleProducts().map(p=>`<label class="picker-row"><input type="checkbox" data-product="${esc(p.id)}" ${state.sheet.items.some(i=>i.product_id===p.id)?'checked':''}><span>${esc(p.name)}${!p.is_published?'<br><small>非公開・準備中</small>':''}</span></label>`).join('') || '<p class="hint">この条件の商品はありません。</p>';
}
function addItem(id){if(!state.sheet.items.some(i=>i.product_id===id))state.sheet.items.push({product_id:id,description_override:null,photo_note:'',photo_position:'center',photo_path:null});}
function renderSelected(){
 $('selected-count').textContent=`（${state.sheet.items.length}件）`;
 $('selected-items').innerHTML=state.sheet.items.map((i,index)=>{
  const p=state.catalog.products.find(p=>p.id===i.product_id);
  return `<div class="selected-item" data-index="${index}"><h3>${index+1}. ${esc(p?.name||'削除された商品')}</h3><div class="item-buttons"><button data-move="-1" ${index===0?'disabled':''} aria-label="${esc(p?.name)}を上へ">↑ 上へ</button><button data-move="1" ${index===state.sheet.items.length-1?'disabled':''} aria-label="${esc(p?.name)}を下へ">↓ 下へ</button><button data-remove>掲載から外す</button></div><label>メニュー用の短い説明<textarea data-field="description_override" rows="3" maxlength="160">${esc(i.description_override??p?.description??'')}</textarea></label><button data-reset class="reset-description">商品設定の説明に戻す</button><div class="menu-photo-editor"><p class="hint">${i.photo_path?'メニュー専用の写真を使用中':'商品設定の写真を使用中'}</p>${C.photoURL(i,p,CONFIG.url)?`<img class="photo-thumb" src="${esc(C.photoURL(i,p,CONFIG.url))}" alt="${esc(p?.name||'商品')}の掲載写真">`:''}<input type="file" data-photo-file accept="image/jpeg,image/png,image/webp" hidden><div class="item-buttons"><button type="button" data-photo-upload>メニュー用の写真に変更</button><button type="button" data-photo-reset ${i.photo_path?'':'disabled'}>商品設定の写真に戻す</button></div><p class="hint">予約ページの写真は変わりません。JPEG・PNG・WebPに対応。変更後は「設定を保存」を押してください。</p></div><label>写真についての注記<input data-field="photo_note" maxlength="120" value="${esc(i.photo_note)}" placeholder="写真は飾りを追加した一例です"></label><label>写真の上下位置（余白があるとき）<select data-field="photo_position">${['top','center','bottom'].map((pos,k)=>`<option value="${pos}" ${pos===i.photo_position?'selected':''}>${['上寄せ','中央','下寄せ'][k]}</option>`).join('')}</select></label></div>`;
 }).join('')||'<p class="hint">上の一覧から掲載する商品を選んでください。</p>';
}
function renderFooterEditor(){
 const f=C.footerText(state.sheet,state.catalog,C.model(state.sheet,state.catalog));
 for(const el of $('footer-editor').querySelectorAll('[data-footer]')){
  const key=el.dataset.footer;
  if(el.type==='checkbox')el.checked=f.settings[key];
  else el.value=({shop_text:f.shop,schedule_text:f.schedule,notice_text:f.notice})[key]??f.settings[key]??'';
 }
 $('footer-fields').hidden=!f.settings.show_footer;
}
$('footer-editor').addEventListener('input',e=>{
 const key=e.target.dataset.footer;if(!key)return;
 state.sheet.footer_settings={...state.sheet.footer_settings,[key]:e.target.type==='checkbox'?e.target.checked:key==='date_value'?(e.target.value||null):e.target.value};
 $('footer-fields').hidden=!C.footerSettings(state.sheet).show_footer;changed();
});
$('footer-editor').addEventListener('click',e=>{
 const key=e.target.dataset.footerAuto;if(!key)return;
 state.sheet.footer_settings={...state.sheet.footer_settings,[key]:null};renderFooterEditor();changed();
});
function schedulePreview(){clearTimeout(state.timer);state.renderId++;state.timer=setTimeout(()=>renderPreview().catch(e=>say(e.message)),150);}
const imageURL=url=>C.safeImage(url,CONFIG.url);
function bookingURL(){const u=new URL('../',location.href);u.search='';u.hash='';u.searchParams.set('shop',state.catalog.tenant.subdomain);return u.href;}
function qrSVG(){const qr=qrcode(0,'M');qr.addData(bookingURL());qr.make();return qr.createSvgTag({cellSize:2,margin:8,scalable:true});}
function cardHTML(card,includeSchedule=true){
 const {product:p,item,variants,charges}=card,url=C.photoURL(item,p,CONFIG.url);
 return `<article class="menu-card ${url?'':'no-photo'}">${url?`<img class="menu-photo" src="${esc(url)}" alt="${esc(p.name)}" data-label="${esc(p.name)}" style="object-position:${['top','center','bottom'].includes(item.photo_position)?item.photo_position:'center'}">`:''}<div><h3>${esc(p.name)}</h3>${card.description?`<p class="description">${esc(card.description)}</p>`:''}<ul class="price-list">${variants.map(v=>`<li><span>${esc(v.size_label)}</span><strong>${Number(v.price).toLocaleString('ja-JP')}円</strong></li>`).join('')}</ul><div class="card-notes"><p>${charges.paid?'基本料金（税込）':'税込価格'}</p>${charges.paid?'<p>選択内容により追加料金がかかります</p>':''}${charges.required?'<p>別途、必須の選択項目の料金がかかります</p>':''}${item.photo_note?`<p>${esc(item.photo_note)}</p>`:''}</div><div class="schedule">${includeSchedule?card.schedule.map(s=>`<p>${esc(s)}</p>`).join(''):''}</div></div></article>`;
}
async function assetsReady(container){
 const failed=[];
 await Promise.all([...container.querySelectorAll('img')].map(img=>new Promise(resolve=>{
  let timer;
  const done=()=>{clearTimeout(timer);img.onload=img.onerror=null;if(!img.naturalWidth){failed.push(img.dataset.label||'店舗ロゴ');img.classList.add('image-missing');img.closest('.menu-card')?.classList.add('no-photo');}resolve();};
  if(img.complete)return done();img.onload=img.onerror=done;timer=setTimeout(done,7000);
 })));
 await document.fonts.ready;
 return failed;
}
function fitPreview(){const wrap=$('preview-wrap'),pages=$('pages');const scale=Math.min(1,wrap.clientWidth/(210*96/25.4));pages.style.transform=`scale(${scale})`;wrap.style.height=`${pages.offsetHeight*scale}px`;}
async function renderPreview(){
 clearTimeout(state.timer);const generation=++state.renderId;
 if(!state.catalog)return;
 const m=C.model(state.sheet,state.catalog);state.layoutErrors=[];state.failedImages=[];
 const pages=$('pages');pages.replaceChildren();const qr=qrSVG();const t=state.catalog.tenant,s=state.sheet;
 const footer=C.footerText(s,state.catalog,m),f=footer.settings;
 const day=f.date_value?f.date_value.split('-').map(Number).join('/'):new Intl.DateTimeFormat('ja-JP',{timeZone:t.timezone||'Asia/Tokyo'}).format(new Date());
 const line=(show,text,cls='')=>show&&text?`<p class="footer-text ${cls}">${esc(text)}</p>`:'';
 const footerVisible=f.show_footer&&((f.show_shop&&footer.shop.trim())||(f.show_schedule&&footer.schedule.trim())||(f.show_notice&&footer.notice.trim())||f.show_date||(f.show_pages&&f.page_format.trim())||f.show_qr);
 const pageReserve='8'.repeat(String(Math.max(1,m.cards.length)).length);
 function makePage(){
  const p=document.createElement('section');p.className='menu-page '+s.template_key;p.style.setProperty('--accent',C.color(s.accent_color));
  p.innerHTML=`<header class="page-header"><div class="shop-mark">${imageURL(t.theme?.logo_url)?`<img class="shop-logo" src="${esc(imageURL(t.theme.logo_url))}" alt="店舗ロゴ" data-label="店舗ロゴ">`:''}<span>${esc(t.name)}</span></div><h2>${esc(s.title)}</h2>${s.intro?`<p class="intro">${esc(s.intro)}</p>`:''}</header><div class="page-content"></div>${footerVisible?`<footer class="page-footer"><div class="footer-copy">${line(f.show_shop,footer.shop)}${line(f.show_schedule,footer.schedule)}${line(f.show_notice,footer.notice)}${line(f.show_date,[f.date_label,day].filter(Boolean).join(' '),'page-date')}${f.show_pages?`<p class="page-index footer-text">${esc(f.page_format.replaceAll('{page}',pageReserve).replaceAll('{pages}',pageReserve))}</p>`:''}</div>${f.show_qr?`<div class="qr">${qr}<span class="footer-text">${esc(f.qr_label)}</span></div>`:''}</footer>`:''}`;
  pages.append(p);return p;
 }
 let page=makePage(),content=page.querySelector('.page-content');
 const step=s.template_key==='list'?1:s.template_key==='photo_cards_3'?3:2;
 const rows=[];
 for(let i=0;i<m.cards.length;i+=step){const row=document.createElement('div');row.className='card-row';row.innerHTML=m.cards.slice(i,i+step).map(card=>cardHTML(card,!m.sharedSchedule.length)).join('');rows.push(row);content.append(row);}
 state.failedImages=await assetsReady(pages);
 if(generation!==state.renderId)return;
 // 読込後の実寸で行単位に割り付ける。文字や価格を途中で切らない。
 rows.forEach(row=>row.remove());
 for(const row of rows){
  content.append(row);
  if(content.scrollHeight>content.clientHeight+1){
   row.remove();
   if(content.children.length){page=makePage();content=page.querySelector('.page-content');}
   content.append(row);
   if(content.scrollHeight>content.clientHeight+1)state.layoutErrors.push('1ページに収まらない商品があります。説明を短くするか「一覧」に切り替えてください');
  }
 }
 // 複数ページのロゴも読込確認する。
 const moreFailed=await assetsReady(pages);
 if(generation!==state.renderId)return;
 state.failedImages=[...new Set([...state.failedImages,...moreFailed])];
 const all=[...pages.querySelectorAll('.menu-page')];
 all.forEach((p,i)=>{const number=p.querySelector('.page-index');if(number)number.textContent=f.page_format.replaceAll('{page}',String(i+1)).replaceAll('{pages}',String(all.length));const foot=p.querySelector('.page-footer');if(foot&&!foot.textContent.trim()&&!foot.querySelector('svg'))foot.hidden=true;if(p.scrollHeight>p.clientHeight+1||p.querySelector('.page-content').scrollHeight>p.querySelector('.page-content').clientHeight+1)state.layoutErrors.push('見出しや案内文が長すぎます。短く整えてください');});
 $('page-count').textContent=`${m.cards.length}商品 ／ ${all.length}ページ`;
 const errors=[...new Set([...m.errors,...state.layoutErrors])];
 $('notices').innerHTML=errors.map(x=>`<p class="error">${esc(x)}</p>`).join('')+m.warnings.map(x=>`<p>${esc(x)}</p>`).join('')+(state.failedImages.length?`<p>写真を読み込めませんでした：${esc(state.failedImages.join('、'))}。出力時に写真なしで進めるか選べます。</p>`:'');
 fitPreview();return {...m,errors};
}
async function withBusy(fn){if(state.busy)return;state.busy=true;$('workspace').inert=true;try{await fn();}catch(e){say(e.message);}finally{state.busy=false;$('workspace').inert=false;updateSave();}}
$('product-picker').addEventListener('change',e=>{const id=e.target.dataset.product;if(!id)return;if(e.target.checked)addItem(id);else state.sheet.items=state.sheet.items.filter(i=>i.product_id!==id);renderSelected();changed();});
$('select-visible').onclick=()=>{visibleProducts().forEach(p=>addItem(p.id));renderPicker();renderSelected();changed();};
$('category').onchange=$('include-hidden').onchange=renderPicker;
$('selected-items').addEventListener('click',e=>{
 const button=e.target.closest('button'),row=button?.closest('[data-index]');if(!row)return;const index=Number(row.dataset.index);
 if(button.hasAttribute('data-photo-upload')){row.querySelector('[data-photo-file]').click();return;}
 if(button.hasAttribute('data-photo-reset'))state.sheet.items[index].photo_path=null;
 else if(button.hasAttribute('data-remove'))state.sheet.items.splice(index,1);
 else if(button.hasAttribute('data-move')){const other=index+Number(button.dataset.move);[state.sheet.items[index],state.sheet.items[other]]=[state.sheet.items[other],state.sheet.items[index]];}
 else if(button.hasAttribute('data-reset'))state.sheet.items[index].description_override=null;
 renderSelected();renderPicker();changed();
});
// 写真はメニューだけの保存領域へ。保存前や複製で共有し得るため、差替え時に元ファイルは削除しない。
async function photoBlob(file){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('JPEG・PNG・WebPの写真を選んでください');
 if(!file.size || file.size>25*1024*1024)throw Error('写真は25MB以下のファイルを選んでください');
 const source=URL.createObjectURL(file);
 try{
  const img=new Image();
  await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('写真を読み込めませんでした。別の画像を選んでください'));img.src=source;});
  if(!img.naturalWidth || !img.naturalHeight)throw Error('写真のサイズを読み取れませんでした');
  const scale=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.88));
  if(!blob || blob.size>5*1024*1024)throw Error('写真を小さくしてもう一度選んでください');
  return blob;
 }finally{URL.revokeObjectURL(source);}
}
$('selected-items').addEventListener('change',e=>{
 if(!e.target.hasAttribute('data-photo-file'))return;
 const file=e.target.files?.[0];if(!file)return;
 const item=state.sheet.items[Number(e.target.closest('[data-index]').dataset.index)];
 withBusy(async()=>{
  say('メニュー用の写真を読み込んでいます…');
  const blob=await photoBlob(file),path=`${state.tenantId}/menus/${crypto.randomUUID()}.jpg`;
  await api('POST','/storage/v1/object/shop-images/'+path,blob);
  item.photo_path=path;renderSelected();changed();say('メニュー用の写真に変更しました。「設定を保存」で確定します。');
 });
 e.target.value='';
});
$('selected-items').addEventListener('input',e=>{const key=e.target.dataset.field,row=e.target.closest('[data-index]');if(!key||!row)return;state.sheet.items[Number(row.dataset.index)][key]=e.target.value;changed();});
for(const [id,key] of [['name','name'],['title','title'],['intro','intro'],['template','template_key'],['accent','accent_color']])$(id).addEventListener('input',()=>{state.sheet[key]=$(id).value;changed();});
$('new-menu').onclick=()=>{if(confirmLeave())setSheet(newSheet());};
$('saved-menu').onchange=()=>{const s=state.sheets.find(s=>s.id===$('saved-menu').value);if(confirmLeave())setSheet(s||newSheet());else $('saved-menu').value=state.sheet.id||'';};
$('copy-menu').onclick=()=>{const s=structuredClone(state.sheet);s.id=null;s.revision=null;s.name=s.name.slice(0,74)+'（コピー）';setSheet(s);changed();say('コピーを作りました。「設定を保存」で別のメニューとして保存できます。');};
$('save-menu').onclick=()=>withBusy(async()=>{
 const s=state.sheet;
 if(!s.name.trim()||!s.title.trim())throw Error('保存する名前とタイトルを入れてください');
 if(s.items.some(i=>(i.description_override||'').length>160))throw Error('短い説明を160文字以内にしてください');
 const result=await rpc('fn_save_menu_sheet',{p_tenant:state.tenantId,p_id:s.id,p_revision:s.revision,p_sheet:{name:s.name,title:s.title,intro:s.intro,template_key:s.template_key,accent_color:s.accent_color,footer_settings:s.footer_settings||{}},p_items:s.items});
 state.sheet.id=result.id;state.sheet.revision=result.revision;state.dirty=false;updateSave();say('メニューの設定を保存しました。');
 try{await loadLibrary();}catch{say('設定は保存できました。一覧の更新に失敗したため、ページを読み直してください。');}
});
$('delete-menu').onclick=()=>{if(!state.sheet.id||!confirm('このメニューの設定を削除しますか？ 商品は削除されません。'))return;withBusy(async()=>{await rpc('fn_delete_menu_sheet',{p_tenant:state.tenantId,p_id:state.sheet.id,p_revision:state.sheet.revision});setSheet(newSheet());await loadLibrary();say('メニューを削除しました。');});};
async function prepareOutput(){
 document.body.classList.remove('print-ready');
 const previous=JSON.stringify(state.catalog);const latest=await catalog();state.catalog=latest;
 const result=await renderPreview();
 if(!result || result.errors.length)throw Error(result?.errors.join('\n')||'仕上がりをもう一度確認してください');
 $('output-notices').innerHTML=(previous!==JSON.stringify(latest)?'<p>商品情報が更新されています。仕上がりに最新の内容を反映しました。</p>':'')+result.warnings.map(x=>`<p>${esc(x)}</p>`).join('');
 $('photo-failure').hidden=!state.failedImages.length;$('retry-images').hidden=!state.failedImages.length;
 $('photo-failure').textContent=`写真を読み込めませんでした：${state.failedImages.join('、')}。写真なしで出力するか、再読み込みできます。`;
 $('continue-output').textContent=state.failedImages.length?'写真なしで出力':'確認して出力';
 $('confirm-output').showModal();
}
$('print-menu').onclick=()=>withBusy(async()=>{say('最新の商品情報と仕上がりを確認しています…');await prepareOutput();say('出力前の確認を表示しました。');});
$('cancel-output').onclick=()=>$('confirm-output').close();
$('retry-images').onclick=async()=>{
 $('confirm-output').close();await withBusy(async()=>{await prepareOutput();});
};
$('continue-output').onclick=()=>{
 $('confirm-output').close();document.body.classList.add('print-ready');
 const old=document.title;document.title=state.sheet.title;
 window.print();document.title=old;
};
window.addEventListener('afterprint',()=>document.body.classList.remove('print-ready'));
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('resize',fitPreview);
$('show-editor').onclick=()=>{document.body.classList.remove('preview-mobile');$('show-editor').setAttribute('aria-pressed','true');$('show-preview').setAttribute('aria-pressed','false');};
$('show-preview').onclick=()=>{document.body.classList.add('preview-mobile');$('show-editor').setAttribute('aria-pressed','false');$('show-preview').setAttribute('aria-pressed','true');renderPreview().catch(e=>say(e.message));};
(async()=>{
 try{state.session=JSON.parse(localStorage.getItem('pokke_admin_session'));}catch{}
 if(!state.session){$('login').hidden=false;say('');return;}
 try{
  const tenants=await api('GET','/rest/v1/tenant_users?select=tenant_id');if(!tenants.length)throw Error('店舗にアクセスできません');
  state.tenantId=tenants[0].tenant_id;state.catalog=await catalog();
  $('shop-name').textContent=state.catalog.tenant.name;
  $('category').innerHTML='<option value="">すべて</option>'+state.catalog.categories.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  await loadLibrary();$('workspace').hidden=false;setSheet(state.sheets[0]||newSheet());say('');
 }catch(e){say('読み込みに失敗しました：'+e.message);}
})();
})();
