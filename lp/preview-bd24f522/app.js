// 新LP（v3）の確認用ページ。2026-10 まりほ依頼。確認が済んだらこのフォルダごと削除する
// デモの場所：本番（cakebook.jp）は同じサイトの /lp/product-demo/・/lp/admin-demo/。手元のモック（8031番）では main の web/ を配信する8032番のデモを使う
(function(){
  var base='';
  document.querySelectorAll('[data-demo]').forEach(function(el){el.src=base+'/lp/product-demo/';});
  document.querySelectorAll('[data-demo-link]').forEach(function(el){el.href=base+'/lp/product-demo/';});
  // スマホ幅では管理画面のデモを埋め込まず（読み込みもしない）、別タブで開くボタンにする
  document.querySelectorAll('[data-admin-demo-link]').forEach(function(el){el.href=base+'/lp/admin-demo/';});
  // 2026-10-14：スマホでもお店の画面のデモをその場で触れるようにした（まりほ判断）
  var wide={matches:true,addEventListener:function(){}};
  function loadAdmin(){ if(!wide.matches) return; document.querySelectorAll('[data-admin-demo]').forEach(function(el){ if(el.src==='about:blank') el.src=base+'/lp/admin-demo/';}); }
  loadAdmin(); wide.addEventListener('change',loadAdmin);
})();
// 12月のカレンダー見本
(function(){
  var c=document.getElementById('cal'),h='';
  '日月火水木金土'.split('').forEach(function(d){h+='<div class="hd">'+d+'</div>'});
  var nums={1:3,2:5,3:4,4:6,5:9,6:12,7:8,8:4,9:2,10:5,11:6,12:11,13:14,14:9,15:3,16:5,17:7,18:9,19:15,20:20,21:18,22:4,23:40,24:40,25:22,26:3,27:5,28:4};
  h+='<div style="border:0;background:none"></div>';
  for(var d=1;d<=31;d++){
    var dow=(d+1)%7, off=(dow===2&&d<23);
    if(off){h+='<div class="off"><b>'+d+'</b>休</div>';continue}
    var n=nums[d]||0, lim=(d>=20&&d<=25)?40:20;
    var full=n>=lim?'<em>満枠</em>':(d===23||d===24?'':'');
    var un=(d===19||d===21||d===24)?'<em>未確認2</em>':'';
    h+='<div><b>'+d+'</b>'+n+'/'+lim+'台 '+(full||un)+'</div>';
  }
  c.innerHTML=h;
})();
