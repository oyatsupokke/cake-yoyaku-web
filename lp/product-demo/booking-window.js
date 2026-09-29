/* Shop-local calendar dates, independent of the customer's device timezone. */
window.BookingWindow = {
  bounds(tenant, now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone: tenant?.timezone || 'Asia/Tokyo', year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
    const part = name => parts.find(p => p.type === name).value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    const end = new Date(`${today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + (tenant?.booking_window_days ?? 90));
    return {today, end: end.toISOString().slice(0,10)};
  },
  update(tenant, month, unrestricted = false) {
    const {today,end} = this.bounds(tenant);
    const key = `${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,'0')}`;
    document.getElementById('cal-prev').disabled = key <= today.slice(0,7);
    document.getElementById('cal-next').disabled = !unrestricted && key >= end.slice(0,7);
    const note = document.getElementById('booking-window-note');
    if (note) note.textContent = unrestricted
      ? `通常の受付は${end.replaceAll('-','/')}の受取までです。代行登録では範囲外も選べます。`
      : `${end.replaceAll('-','/')}の受取まで予約できます。締切・定休日・満枠の日は選べません。`;
    return {today,end};
  }
};
