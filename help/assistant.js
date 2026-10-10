import {config} from './assistant-config.js?v=30dd2444041ea5a0';
const embedded = new URLSearchParams(location.search).get('panel') === '1' && window.parent !== window;
if (embedded) {
 document.body.classList.add('embedded');
 document.querySelectorAll('a').forEach(a=>{a.target='_blank';a.rel='noopener';});
 document.querySelector('.privacy').textContent='質問と直近3往復をAIに送信します。個人情報は入力しないでください。会話はチャットを閉じても残り、管理画面を移動・再読み込みすると消えます。';
 document.addEventListener('keydown',e=>{if(e.key==='Escape')window.parent.postMessage({type:'help-chat-close'},location.origin);});
}
const $=id=>document.getElementById(id);let session=null,busy=false,history=[],generation=0;
function stored(){try{return JSON.parse(localStorage.getItem('pokke_admin_session'));}catch{return null;}}
function updateCount(){ $('count').textContent=`${$('question').value.length} / 1,000文字`; }
function feedback(text,error=false){$('feedback').textContent=text;$('feedback').classList.toggle('error',error);}
async function api(method,body){
 const original=stored();session=original;
 if(!session?.access_token){const e=Error('管理画面にログインしてからお使いください');e.status=401;throw e;}
 const send=()=>fetch(`${config.url}/functions/v1/help-chat`,{method,headers:{apikey:config.anonKey,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(65000)});
 let r=await send();
 if(r.status===401&&session.refresh_token){
  const refreshed=await fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`,{method:'POST',headers:{apikey:config.anonKey,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token}),signal:AbortSignal.timeout(15000)});
  if(refreshed.ok&&stored()?.access_token===original.access_token){session=await refreshed.json();localStorage.setItem('pokke_admin_session',JSON.stringify(session));r=await send();}
 }
 // 他タブでログアウト／別アカウントに切り替えた場合は結果を表示しない。
 if(stored()?.access_token!==session.access_token){const e=Error('ログイン状態が変わりました。再確認してください');e.status=401;throw e;}
 let data;try{data=await r.json();}catch{throw Error('回答を読み込めませんでした。少し時間をおいてお試しください。');}
 if(typeof data.remaining==='number')$('remaining').textContent=`今日あと${data.remaining}回`;
 if(!r.ok){const e=Error(data.error||'接続できませんでした');e.status=r.status;throw e;}return data;
}
function lock(on){busy=on;$('send').disabled=on;$('clear').disabled=on;$('question').disabled=on;document.querySelectorAll('[data-question], .reply-choice').forEach(x=>x.disabled=on);$('send').textContent=on?'回答を作成中…':'質問する';}
function message(role,text,sources=[],choices=[]){const node=document.createElement('article');node.className=`message ${role}`;const name=document.createElement('strong');name.textContent=role==='user'?'あなた':'使い方AI';const content=document.createElement('div');content.className='text';content.textContent=text;node.append(name,content);if(sources.length){const ul=document.createElement('ul');ul.className='sources';for(const s of sources){if(!/^[a-z]+\.html(?:#section-\d+)?$/.test(s.url))continue;const li=document.createElement('li'),a=document.createElement('a');a.href=s.url;a.target='_blank';a.rel='noopener';a.textContent='参照：'+s.title;li.append(a);ul.append(li);}node.append(ul);}if(choices.length){const actions=document.createElement('div');actions.className='reply-choices';for(const choice of choices){if(typeof choice.label!=='string')continue;const button=document.createElement('button');button.type='button';button.className='reply-choice';button.textContent=choice.label;button.onclick=()=>submitQuestion(choice.label,choice.selection);actions.append(button);}node.append(actions);}$('messages').append(node);document.body.classList.add('has-conversation');return node;}
function reset(){++generation;history=[];$('messages').replaceChildren();document.body.classList.remove('has-conversation');$('question').value='';updateCount();feedback('');}
async function connect(){const turn=++generation;$('connection').textContent='ログインを確認しています…';$('login').hidden=true;$('chat').hidden=true;try{const r=await api('GET');if(turn!==generation)return;if(!r.available){$('connection').textContent=r.plan==='lite'?'AIヘルプは現在Standard版の操作をご案内しています。Liteについてはサポートをご利用ください。':'AIヘルプは一時休止中です。マニュアル検索やサポートをご利用ください。';return;}if(r.version!==config.version){$('connection').textContent='マニュアルを更新しています。ページを再読み込みするか、マニュアル検索をご利用ください。';return;}$('remaining').textContent=`今日あと${r.remaining}回（1店舗1日${r.limit}回）`;$('connection').textContent='';$('chat').hidden=false;}catch(e){if(turn!==generation)return;$('connection').textContent=e.message||'接続できませんでした';$('login').hidden=e.status!==401;}}
$('question').addEventListener('input',updateCount);
document.querySelectorAll('[data-question]').forEach(b=>b.onclick=()=>{$('question').value=b.dataset.question;updateCount();$('question').focus();});
$('clear').onclick=()=>{reset();$('question').focus();};$('recheck').onclick=connect;
async function submitQuestion(question,selection){
 if(busy)return;if(question.length<2){feedback('知りたいことを2文字以上で入力してください',true);return;}
 const turn=generation,pending=message('user',question);lock(true);feedback('マニュアルを確認しています…');
 try{
  const r=await api('POST',{question,history:history.slice(-6),...(selection?{selection}:{}),version:config.version});
  if(turn!==generation)return;
  const reply=message('assistant',r.answer,r.sources,r.choices||[]);
  if(['answer','clarify'].includes(r.kind))history=[...history,{role:'user',content:question},{role:'assistant',content:r.answer.slice(0,1500)}].slice(-6);else history=[];
  $('question').value='';updateCount();feedback('');reply.scrollIntoView({block:'nearest',behavior:'smooth'});
 }catch(err){if(turn!==generation)return;pending.remove();feedback(err.name==='TimeoutError'?'時間がかかっています。入力は残っています。少し待ってからお試しください。':err.message,true);if(err.status===401){reset();await connect();}}
 finally{lock(false);}
}
$('question-form').onsubmit=e=>{e.preventDefault();submitQuestion($('question').value.trim());};
window.addEventListener('storage',e=>{if(e.key==='pokke_admin_session'&&stored()?.user?.id!==session?.user?.id){reset();connect();}});
connect();
