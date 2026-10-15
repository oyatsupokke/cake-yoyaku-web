// CakeBook LP の動き（web/lp/index.html・トップ cakebook-home.html 共通）。cakebook.jp のCSPでインラインscriptが止まるため外部ファイル
// デモの場所：本番（cakebook.jp）は同じサイトの /lp/product-demo/・/lp/admin-demo/。手元のモック（8031番）では main の web/ を配信する8032番のデモを使う
(function(){
  var base='';
  document.querySelectorAll('[data-demo]').forEach(function(el){el.src=base+'/lp/product-demo/';});
  // 写真で選ぶお店／イラストを重ねるお店の切り替え（デモの枠の外）
  document.querySelectorAll('[data-demo-type]').forEach(function(b){
    b.addEventListener('click',function(){
      var t=b.getAttribute('data-demo-type');
      document.querySelectorAll('[data-demo]').forEach(function(el){el.src=base+'/lp/product-demo/'+(t?'?type='+t:'');});
      document.querySelectorAll('[data-demo-type]').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false');});
    });
  });
  document.querySelectorAll('[data-demo-link]').forEach(function(el){el.href=base+'/lp/product-demo/';});
  // スマホ幅では管理画面のデモを埋め込まず（読み込みもしない）、別タブで開くボタンにする
  document.querySelectorAll('[data-admin-demo-link]').forEach(function(el){el.href=base+'/lp/admin-demo/';});
  // 2026-10-14：スマホでもお店の画面のデモをその場で触れるようにした（まりほ判断）
  var wide={matches:true,addEventListener:function(){}};
  function loadAdmin(){ if(!wide.matches) return; document.querySelectorAll('[data-admin-demo]').forEach(function(el){ if(el.src==='about:blank') el.src=base+'/lp/admin-demo/';}); }
  loadAdmin(); wide.addEventListener('change',loadAdmin);
  // お店の画面のデモ：400px幅で描いた画面を、枠の内側の幅に合わせて縮小する
  function fitAdmin(){
    document.querySelectorAll('.admin-phone').forEach(function(box){
      var f=box.querySelector('iframe'); if(!f) return;
      var k=box.clientWidth/400;
      f.style.transform='scale('+k+')';
      f.style.height=(box.clientHeight/k)+'px';
    });
  }
  fitAdmin(); window.addEventListener('resize',fitAdmin);
})();
