// Only layout classes. No replacement labels, options, images or booking logic.
(()=>{const form=document.getElementById('view-form');const preview=document.getElementById('preview-box');
const sync=()=>{form.classList.toggle('booking-layer',!!preview.querySelector('canvas'));form.classList.toggle('booking-image',!!preview.querySelector('img'));};
new MutationObserver(sync).observe(document.getElementById('preview-canvas'),{childList:true});sync();
new ResizeObserver(()=>document.documentElement.style.setProperty('--booking-preview-height',preview.offsetHeight+'px')).observe(preview);

// Enlarged view is a snapshot of the existing rendered layers, not replacement art.
const expand=document.createElement('button');
expand.type='button';expand.className='booking-expand';expand.textContent='拡大する';
expand.setAttribute('aria-haspopup','dialog');expand.setAttribute('aria-controls','booking-preview-dialog');
preview.appendChild(expand);
const dialog=document.createElement('dialog');
dialog.id='booking-preview-dialog';dialog.setAttribute('aria-labelledby','booking-dialog-title');
dialog.innerHTML='<div class="booking-dialog-heading"><h2 id="booking-dialog-title">選択中のケーキ</h2><button type="button" autofocus class="booking-dialog-close">閉じる</button></div><div class="booking-dialog-picture"></div><p class="booking-dialog-note"></p>';
document.body.appendChild(dialog);
const close=dialog.querySelector('.booking-dialog-close');
let savedScroll,oldOverflow,busy=false;
expand.onclick=async()=>{
  if(busy||dialog.open)return;
  busy=true;
  try {
    // Wait for any pending layer image loads before copying the canvas.
    await updatePreview();
    const source=document.querySelector('#preview-canvas canvas, #preview-canvas img');
    if(!source)return;
    let copy;
    if(source.tagName==='CANVAS'){
      copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height;
      copy.getContext('2d').drawImage(source,0,0);
      copy.setAttribute('role','img');copy.setAttribute('aria-label','選択中のケーキ');
    }else{copy=source.cloneNode();}
    dialog.querySelector('.booking-dialog-picture').replaceChildren(copy);
    dialog.querySelector('.booking-dialog-note').textContent=document.getElementById('preview-note').textContent;
    savedScroll={x:window.scrollX,y:window.scrollY};oldOverflow=document.documentElement.style.overflow;
    dialog.showModal();document.documentElement.style.overflow='hidden';
  }finally{busy=false;}
};
close.onclick=()=>dialog.close();
dialog.addEventListener('click',e=>{
  if(e.target!==dialog)return;
  const r=dialog.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();
});
dialog.addEventListener('close',()=>{
  document.documentElement.style.overflow=oldOverflow;
  expand.focus({preventScroll:true});
  if(savedScroll)window.scrollTo({left:savedScroll.x,top:savedScroll.y,behavior:'instant'});
});
})();
