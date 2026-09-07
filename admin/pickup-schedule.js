// Product-only schedule. Dates and holiday permissions are saved with the product draft.
function initPickupSchedule(p) {
  const mode = document.getElementById('p-pickup-mode');
  const input = document.getElementById('p-pickup-date');
  const list = document.getElementById('p-pickup-date-list');
  const add = document.getElementById('btn-pickup-date-add');
  let dates = [...(p.pickup_dates || [])], holidays = [...(p.pickup_holiday_dates || [])];
  mode.value = p.pickup_mode || (p.pickup_start_date || p.pickup_end_date || p.allowed_pickup_weekdays ? 'period' : 'normal');
  function paint() {
    document.getElementById('p-pickup-period').classList.toggle('hidden', mode.value !== 'period');
    document.getElementById('p-pickup-dates').classList.toggle('hidden', mode.value !== 'dates');
    list.replaceChildren();
    if (!dates.length) { const note=document.createElement('p');note.className='small';note.textContent='日付はまだありません。日付指定では1日以上追加してください。';list.append(note); }
    for (const date of dates) {
      const row=document.createElement('div');row.className='override-add';
      const label=document.createElement('span');label.textContent=date+(holidays.includes(date)?'（定休日も受付）':'');
      const remove=document.createElement('button');remove.type='button';remove.className='pill';remove.textContent='外す';remove.setAttribute('aria-label',date+'を外す');
      remove.onclick=()=>{dates=dates.filter(d=>d!==date);holidays=holidays.filter(d=>d!==date);paint();markDirty();};
      row.append(label,remove);list.append(row);
    }
  }
  mode.onchange=()=>{paint();markDirty();};
  add.onclick=()=>{
    const date=input.value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){toast('日付を選んでください');return;}
    if(dates.includes(date)){toast('この日付は追加済みです');return;}
    const weekday=new Date(date+'T12:00:00Z').getUTCDay();
    if((state.closedWeekdays||[]).includes(weekday)) {
      if(!confirm(`${date}は定休日です。この商品だけ受け付けますか？\n店舗の臨時休業・商品別の受付停止は優先されます。`))return;
      holidays.push(date);
    }
    dates.push(date);dates.sort();holidays.sort();input.value='';paint();markDirty();
  };
  regField('products',p.id,'pickup_mode',mode);
  regField('products',p.id,'pickup_dates',list,{get:()=>[...dates]});
  regField('products',p.id,'pickup_holiday_dates',list,{get:()=>[...holidays]});
  paint();
}
