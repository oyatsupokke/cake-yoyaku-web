// Secrets exist only in password fields until this dedicated save request.
(() => {
 const el=id=>document.getElementById(id);
 let current=null,busy=false;
 async function request(action,data={}){
   const send=()=>fetch(`${CONFIG.url}/functions/v1/line-settings`,{method:'POST',headers:{apikey:CONFIG.anonKey,Authorization:`Bearer ${state.session?.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({action,tenant_id:state.tenantId,...data})});
   let r=await send();if(r.status===401&&await refreshSession())r=await send();
   const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.message||'LINE設定を読み込めませんでした');return j;
 }
 function paint(){
   el('line-credentials-save').disabled=busy;
   el('line-refresh').disabled=busy;
   el('line-test-login').disabled=busy||!current?.configured;
   el('line-test-send').disabled=busy||!current?.linked;
   el('line-enabled').disabled=busy||!(current?.tested||current?.legacy);
   el('line-save').disabled=busy||!current||el('line-enabled').checked===current.enabled;
 }
 async function refresh(){
   current=await request('status');
   el('line-callback').value=current.callback_url;
   el('line-channel').value=current.channel;
   el('line-enabled').checked=current.enabled;
   el('line-config-status').textContent=current.configured
     ? `${current.bot_name} ／ ${current.enabled?'利用中':current.tested?'テスト送信済み・利用開始できます':current.linked?'LINEログイン確認済み・テスト通知を送ってください':'接続情報を保存済み・LINEログインを確認してください'}`
     : current.legacy?'既存のLINE接続を利用できます。接続情報の再登録は任意です。':'未接続です。手順1から設定してください。';
   paint();
 }
 async function run(fn){if(busy)return;busy=true;paint();el('line-result').textContent='確認中…';try{await fn();}catch(e){el('line-result').textContent=e.message;}finally{busy=false;paint();}}
 window.loadLineConnectionSettings=()=>run(async()=>{await refresh();el('line-result').textContent='';});
 el('line-refresh').onclick=()=>window.loadLineConnectionSettings();
 el('line-copy-callback').onclick=()=>run(async()=>{await navigator.clipboard.writeText(el('line-callback').value);el('line-result').textContent='コピーしました';});
 el('line-credentials-save').onclick=()=>run(async()=>{
   const data={channel:el('line-channel').value,secret:el('line-secret').value,token:el('line-token').value};
   try{const j=await request('save',data);await refresh();el('line-result').textContent=j.message;}
   finally{el('line-secret').value='';el('line-token').value='';}
 });
 el('line-test-login').onclick=()=>{
   if(busy)return;
   const win=window.open('about:blank','_blank');
   run(async()=>{try{const j=await request('start_test');if(win){win.opener=null;win.location.href=j.url;}else location.href=j.url;el('line-result').textContent='LINEで許可したら、ここへ戻り「状態を更新」を押してください';}catch(e){win?.close();throw e;}});
 };
 el('line-test-send').onclick=()=>run(async()=>{const j=await request('test');await refresh();el('line-result').textContent=j.message;});
 el('line-enabled').onchange=paint;
 el('line-save').onclick=()=>run(async()=>{const j=await request('enable',{enabled:el('line-enabled').checked});await refresh();el('line-result').textContent=j.message;});
})();
