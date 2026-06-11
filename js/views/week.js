/** 週案編集ビュー(グリッド・セル編集・連続入力・前週コピー・行事・反省) */

import { store, newEntry, cellKey, effectivePeriod, computeOrdinals, resolveEntryText, computeHours, scopeKey, fmtHours } from '../store.js';
import { fmtDate, parseDate, addDays, fmtMD, weekNumberInFiscalYear, DAY_NAMES, esc, uid } from '../utils.js';
import { holidayName } from '../holidays.js';
import { openModal, toast, confirmDialog, selectHTML, openResultLink, infoHTML } from '../ui.js';

export function renderWeekView(root, ctx) {
  const state = store.state;
  const s = state.settings;
  const weekStart = ctx.getWeekStart();
  const monday = parseDate(weekStart);
  const week = store.getWeek(weekStart);
  const dayCount = s.saturday ? 6 : 5;
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);
  const todayStr = fmtDate(new Date());
  const gas = ctx.gas.configured;

  const dayHeads = [];
  for (let d = 0; d < dayCount; d++) {
    const date = addDays(monday, d);
    const hol = s.showHolidays ? holidayName(date) : null;
    const isToday = fmtDate(date) === todayStr;
    dayHeads.push(`
      <th class="day-th" data-day="${d}" title="クリックで一括操作">
        <div class="day-head ${d === 5 ? 'sat' : ''} ${hol ? 'holiday-mark' : ''} ${isToday ? 'today' : ''}">
          <span class="dow">${DAY_NAMES[d]}</span>
          <span class="date">${fmtMD(date)}</span>
          ${hol ? `<span class="hol-name">${esc(hol)}</span>` : ''}
        </div>
      </th>`);
  }
  const todayIdx = (() => {
    for (let d = 0; d < dayCount; d++) if (fmtDate(addDays(monday, d)) === todayStr) return d;
    return -1;
  })();

  // 日課パターン行(パターンが定義されているときだけ表示)
  let patternRow = '';
  if (s.periodPatterns.length) {
    const cells = [];
    for (let d = 0; d < dayCount; d++) {
      const cur = week.dayPatterns?.[d] || '';
      cells.push(`<td style="padding:2px 4px;">${selectHTML('daypat', [
        { value: '', label: '通常' },
        ...s.periodPatterns.map(p => ({ value: p.id, label: p.name })),
      ], cur, { attrs: `data-day="${d}" class="daypat-select ${cur ? 'active' : ''}"` })}</td>`);
    }
    patternRow = `<tr class="pattern-row"><th class="period-head" style="font-size:11px;">日課</th>${cells.join('')}</tr>`;
  }

  // 日ごとのメモ行(設定でON時のみ。印刷には出ない)
  let dayNotesRow = '';
  if (s.showDayNotes) {
    const cells = [];
    for (let d = 0; d < dayCount; d++) {
      cells.push(`<td style="background:#f0fdf4;"><textarea class="event-input daynote-input" data-day="${d}" rows="1"
        style="color:#166534;" placeholder="">${esc(week.dayNotes?.[d] || '')}</textarea></td>`);
    }
    dayNotesRow = `<tr><th class="period-head" style="font-size:11.5px; background:#dcfce7; color:#166534;">メモ${infoHTML('自分用のメモ欄です。印刷されません')}</th>${cells.join('')}</tr>`;
  }

  const eventCells = [];
  for (let d = 0; d < dayCount; d++) {
    eventCells.push(`<td ${d === todayIdx ? 'class="today-col"' : ''}><textarea class="event-input" data-day="${d}" rows="1"
      placeholder="">${esc(week.events?.[d] || '')}</textarea></td>`);
  }

  const bodyRows = s.periods.map(p => {
    const cells = [];
    for (let d = 0; d < dayCount; d++) {
      cells.push(renderCell(state, week, d, p, ordinals, ctx, d === todayIdx));
    }
    const coefTxt = p.type === 'module'
      ? `<span class="p-coef">${fmtHours(p.coefficient)}時間</span>` : '';
    return `
      <tr>
        <th class="period-head">
          <span class="p-label">${esc(p.label)}</span>
          ${p.start ? `<span class="p-time">${esc(p.start)}<br>${esc(p.end || '')}</span>` : ''}
          ${coefTxt}
        </th>
        ${cells.join('')}
      </tr>`;
  }).join('') + dayNotesRow;

  // 連続入力(ペイント)バー
  const paint = ctx.paint;
  let paintBar = '';
  if (paint.open) {
    const chips = s.subjects.map(x =>
      `<button class="paint-chip ${paint.subject === x.key ? 'selected' : ''}" data-paint="${esc(x.key)}"
        style="background:${esc(x.color)}">${esc(x.short || x.name)}</button>`).join('');
    let scopeChips = '';
    if (s.mode === 'senka' && s.senkaClasses.length) {
      scopeChips = `<span class="paint-sep"></span>` + s.senkaClasses.map(c =>
        `<button class="paint-scope ${paint.scope === c.id ? 'selected' : ''}" data-paint-scope="${esc(c.id)}">${esc(c.label || '?')}</button>`).join('');
    }
    paintBar = `
      <div class="paint-bar">
        <span class="paint-hint">${paint.subject ? 'コマをクリックして配置(もう一度で消去・Escで終了)' : '教科を選んでください'}</span>
        <div class="paint-chips">${chips}${scopeChips}</div>
        <button class="btn small" id="paint-close">終了</button>
      </div>`;
  }

  // 初回ガイドカード(コマ未入力かつ未消去のとき)
  const totalEntries = Object.values(week.cells || {}).reduce((a, c) => a + (c.entries?.length || 0), 0);
  const onboardCard = (totalEntries === 0 && !localStorage.getItem('shuan-card-done')) ? `
    <div class="onboard-card" id="onboard-card">
      <button class="oc-close" id="oc-close" aria-label="閉じる">×</button>
      <div class="oc-step"><span class="oc-num">1</span>コマをクリックして教科を選ぶ</div>
      <div class="oc-step"><span class="oc-num">2</span>1週間できたら <button class="btn small" id="oc-base">基本時間割に登録</button></div>
      <div class="oc-step"><span class="oc-num">3</span><button class="btn small" id="oc-print">🖨 印刷</button> して提出</div>
    </div>` : '';

  root.innerHTML = `
    <div class="week-nav">
      <button class="btn" id="wk-prev" aria-label="前の週">◀</button>
      <button class="btn" id="wk-today">今週</button>
      <button class="btn" id="wk-next" aria-label="次の週">▶</button>
      <input type="date" id="wk-date" value="${weekStart}">
      <span class="week-title">${fmtMD(monday)} 〜 ${fmtMD(addDays(monday, dayCount - 1))}
        <span class="week-no">第${weekNo}週</span>
      </span>
      <span class="spacer"></span>
      <button class="btn ${paint.open ? 'active' : ''}" id="wk-paint" title="教科を選んでコマを連続入力">🖌 連続入力</button>
      ${gas ? `<button class="btn" id="wk-calendar">📆 行事</button>` : ''}
      <button class="btn" id="wk-copy">前週コピー</button>
      <button class="btn" id="wk-apply-base" ${store.hasBaseTimetable ? '' : 'disabled'}>📋 基本時間割</button>
      ${store.hasBaseTimetable ? '' : infoHTML('1週間分を入力して「⋯ → 基本時間割に登録」すると、毎週ワンタッチで呼び出せます')}
      <details class="menu">
        <summary class="btn" aria-label="その他">⋯</summary>
        <div class="menu-items">
          <button class="btn ghost" id="wk-save-base">基本時間割に登録</button>
          ${gas ? `
          <button class="btn ghost" id="wk-cal-push">📤 カレンダーへ書き出し</button>
          <button class="btn ghost" id="wk-sheet-push">📊 シートへ書き出し</button>
          <button class="btn ghost" id="wk-mail">📧 メールで提出</button>` : ''}
          <button class="btn ghost danger" id="wk-clear">この週をクリア</button>
        </div>
      </details>
    </div>
    ${paintBar}
    ${ctx.swapSource ? `<div class="mode-banner">⇄ 移動先のコマをクリック
      <button class="btn small" id="wk-swap-cancel">キャンセル</button></div>` : ''}
    ${onboardCard}
    <div class="panel">
      <div class="week-grid-wrap">
        <table class="week-grid ${paint.subject ? 'painting' : ''}">
          <thead>
            <tr><th class="corner"></th>${dayHeads.join('')}</tr>
            ${patternRow}
            <tr class="event-row"><th class="period-head">行事</th>${eventCells.join('')}</tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      <div class="week-notes">
        <div>
          <label>今週のめあて</label>
          <textarea id="wk-goals">${esc(week.goals || '')}</textarea>
        </div>
        <div>
          <label>反省</label>
          <textarea id="wk-reflection">${esc(week.reflection || '')}</textarea>
        </div>
      </div>
    </div>
    ${renderMiniStats(state, weekStart)}
  `;

  wireNav(root, ctx, monday);
  wireWeekInputs(root, weekStart, ctx);
  wireCells(root, weekStart, ctx);
  wirePaint(root, ctx);
  wireOnboardCard(root, ctx, monday);
  wireDayMenu(root, ctx, monday, weekStart, dayCount);
}

// ---------------------------------------------------------------- セル描画

function renderCell(state, week, dayIdx, period, ordinals, ctx, isToday) {
  const s = state.settings;
  if (!effectivePeriod(s, week, dayIdx, period)) {
    return `<td class="cell off ${isToday ? 'today-col' : ''}" data-day="${dayIdx}" data-period="${esc(period.id)}"></td>`;
  }
  const cell = week.cells?.[cellKey(dayIdx, period.id)];
  const entries = cell?.entries || [];
  const isModule = period.type === 'module';
  let inner;
  if (!entries.length) {
    inner = `<div class="cell-empty">＋</div>`;
  } else {
    inner = entries.map(e => {
      const subj = subjectOf(s, e.subjectKey);
      const resolved = resolveEntryText(state, e, ordinals);
      const text = e.cancelled ? (e.cancelledText || resolved.text) : resolved.text;
      const scopeLabel = scopeLabelOf(s, e.scope);
      const frac = (e.fraction ?? 1) !== 1 ? `<span class="e-flag">${fracLabel(e.fraction)}</span>` : '';
      const guide = s.mode === 'fukushiki' && e.guide ? `<span class="guide-chip g-${e.guide}">${guideLabel(e.guide)}</span>` : '';
      const unsetClass = s.mode === 'senka' && e.subjectKey && (e.scope == null || e.scope === '')
        ? `<span class="e-flag warn">⚠学級未設定</span>` : '';
      return `
        <div class="entry ${e.cancelled ? 'cancelled' : ''}">
          <div class="e-head">
            ${subj ? `<span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>` : ''}
            ${scopeLabel ? `<span class="e-scope">${esc(scopeLabel)}</span>` : ''}
            ${guide}${frac}${unsetClass}
            ${e.cancelled ? `<span class="e-flag" style="color:#dc2626;">中止</span>` : e.noCount ? `<span class="e-flag">時数外</span>` : ''}
          </div>
          ${text ? `<div class="e-text ${resolved.auto ? '' : 'manual'}">${esc(text)}</div>` : ''}
          ${e.note ? `<div class="e-note">${esc(e.note)}</div>` : ''}
        </div>`;
    }).join('');
  }
  const draggable = entries.length > 0 && !ctx.paint.subject;
  const isSwapSrc = ctx.swapSource && ctx.swapSource.day === dayIdx && ctx.swapSource.period === period.id;
  return `
    <td class="cell ${isModule ? 'module-cell' : ''} ${isSwapSrc ? 'drag-over' : ''} ${isToday ? 'today-col' : ''}"
        data-day="${dayIdx}" data-period="${esc(period.id)}" ${draggable ? 'draggable="true"' : ''}>
      ${inner}
      ${entries.length ? `<button class="cell-clear" aria-label="クリア" data-clear>×</button>` : ''}
    </td>`;
}

export function fracLabel(f) {
  if (Math.abs(f - 1 / 3) < 0.01) return '1/3';
  if (Math.abs(f - 2 / 3) < 0.01) return '2/3';
  if (Math.abs(f - 0.5) < 0.01) return '1/2';
  return String(f);
}

export function guideLabel(g) {
  return g === 'direct' ? '直' : g === 'indirect' ? '間' : 'ガ';
}

export function subjectOf(settings, key) {
  return settings.subjects.find(x => x.key === key) || null;
}

function scopeLabelOf(s, scope) {
  if (scope == null || scope === '') return '';
  if (s.mode === 'fukushiki') return `${scope}年`;
  if (s.mode === 'senka') {
    const c = s.senkaClasses.find(c => c.id === scope);
    return c ? c.label : '';
  }
  return '';
}

// ---------------------------------------------------------------- ナビ

function wireNav(root, ctx, monday) {
  root.querySelector('#wk-prev').onclick = () => ctx.setWeekStart(fmtDate(addDays(monday, -7)));
  root.querySelector('#wk-next').onclick = () => ctx.setWeekStart(fmtDate(addDays(monday, 7)));
  root.querySelector('#wk-today').onclick = () => ctx.setWeekStart(null);
  root.querySelector('#wk-date').onchange = (ev) => {
    if (ev.target.value) ctx.setWeekStart(ev.target.value);
  };

  root.querySelector('#wk-apply-base').onclick = async () => {
    const to = fmtDate(monday);
    const bases = store.state.baseTimetables;
    const apply = async (id) => {
      const cur = store.state.weeks[to];
      if (cur && Object.keys(cur.cells).length) {
        const ok = await confirmDialog('この週の時間割を上書きしますか?', { okLabel: '上書き', danger: true });
        if (!ok) return;
      }
      store.snapshot('基本時間割の反映');
      if (store.applyBaseTimetable(to, id)) {
        toast('基本時間割を反映しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
        ctx.rerender();
      }
    };
    if (bases.length <= 1) { apply(null); return; }
    openModal(`
      <h2>どの時間割を反映しますか?</h2>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${bases.map(b => `<button class="btn" data-base="${esc(b.id)}">📋 ${esc(b.name)}</button>`).join('')}
      </div>
      <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelectorAll('[data-base]').forEach(b => {
        b.onclick = () => { close(); apply(b.dataset.base); };
      });
    });
  };

  root.querySelector('#wk-save-base').onclick = async () => {
    const from = fmtDate(monday);
    if (!store.state.weeks[from] || !Object.keys(store.state.weeks[from].cells).length) {
      toast('まだ時間割が入力されていません', 'error');
      return;
    }
    const bases = store.state.baseTimetables;
    if (!bases.length) {
      store.saveAsBaseTimetable(from);
      toast('基本時間割に登録しました');
      ctx.rerender();
      return;
    }
    // 2件目以降: 上書き or 名前を付けて追加(A週/B週など。最大3件)
    openModal(`
      <h2>基本時間割に登録</h2>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${bases.map(b => `<button class="btn" data-over="${esc(b.name)}">「${esc(b.name)}」を上書き</button>`).join('')}
        ${bases.length < 3 ? `
        <div style="display:flex; gap:8px;">
          <input type="text" id="base-name" placeholder="B週" style="flex:1; border:1px solid var(--line); border-radius:8px; padding:7px 9px;">
          <button class="btn primary" data-new>追加</button>
        </div>` : ''}
      </div>
      <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelectorAll('[data-over]').forEach(b => {
        b.onclick = () => {
          store.saveAsBaseTimetable(from, b.dataset.over);
          toast(`「${b.dataset.over}」を更新しました`);
          close(); ctx.rerender();
        };
      });
      const newBtn = modal.querySelector('[data-new]');
      if (newBtn) newBtn.onclick = () => {
        const name = modal.querySelector('#base-name').value.trim() || `${'ABC'[bases.length]}週`;
        if (store.saveAsBaseTimetable(from, name)) {
          toast(`「${name}」として登録しました`);
          close(); ctx.rerender();
        }
      };
    });
  };

  const swapCancel = root.querySelector('#wk-swap-cancel');
  if (swapCancel) swapCancel.onclick = () => { ctx.swapSource = null; ctx.rerender(); };

  root.querySelector('#wk-copy').onclick = async () => {
    const from = fmtDate(addDays(monday, -7));
    const to = fmtDate(monday);
    if (!store.state.weeks[from]) { toast('前週のデータがありません', 'error'); return; }
    const cur = store.state.weeks[to];
    if (cur && Object.keys(cur.cells).length) {
      const ok = await confirmDialog('この週の時間割を上書きしますか?', { okLabel: '上書き', danger: true });
      if (!ok) return;
    }
    store.snapshot('前週コピー');
    store.copyWeek(from, to);
    toast('前週をコピーしました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    ctx.rerender();
  };

  // 「この週をクリア」: 確認ダイアログの代わりにUndoで守る
  root.querySelector('#wk-clear').onclick = () => {
    const to = fmtDate(monday);
    if (!store.state.weeks[to]) return;
    store.snapshot('週のクリア');
    delete store.state.weeks[to];
    store.commit();
    toast('この週をクリアしました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    ctx.rerender();
  };

  // ---- Google連携(設定済みのときだけボタンが存在する)
  const calPush = root.querySelector('#wk-cal-push');
  if (calPush) calPush.onclick = async () => {
    const { buildCalendarEvents } = await import('../gws.js');
    const payload = buildCalendarEvents(fmtDate(monday));
    if (!payload.events.length) { toast('書き出せる授業がありません(校時の時刻が未設定)', 'error', 4000); return; }
    const ok = await confirmDialog(
      `${payload.events.length}件をカレンダー「週案」に登録します(再実行で置き換え)` +
      (payload.skipped ? `\n時刻未設定の${payload.skipped}コマはスキップ` : ''),
      { okLabel: '書き出す' });
    if (!ok) return;
    try {
      toast('書き出し中…');
      const res = await ctx.gas.pushWeek(payload.events, payload.from, payload.to);
      toast(`カレンダーに${res.created}件登録しました`);
    } catch (e) {
      toast('書き出し失敗: ' + e.message, 'error', 6000);
    }
  };

  const sheetPush = root.querySelector('#wk-sheet-push');
  if (sheetPush) sheetPush.onclick = async () => {
    try {
      toast('書き出し中…');
      const { buildWeekSheet } = await import('../gws.js');
      const res = await ctx.gas.sheetWeek(buildWeekSheet(fmtDate(monday)));
      openResultLink(res.url, 'スプレッドシートを開く');
    } catch (e) {
      toast('書き出し失敗: ' + e.message, 'error', 6000);
    }
  };

  const mailBtn = root.querySelector('#wk-mail');
  if (mailBtn) mailBtn.onclick = async () => {
    const s = store.settings;
    if (!s.gas.mailTo) {
      toast('設定 → Google連携 で提出先を設定してください', 'error', 5000);
      return;
    }
    if (!s.gas.senderName && !s.teacherName) {
      toast('設定で氏名を入力してください(差出人になります)', 'error', 5000);
      return;
    }
    const { buildWeekEmail, markMailed } = await import('../gws.js');
    const mail = buildWeekEmail(fmtDate(monday));
    const ok = await confirmDialog(`${s.gas.mailTo} へ送信します\n件名: ${mail.subject}\n${mail.summary}`, { okLabel: '送信' });
    if (!ok) return;
    try {
      toast('送信中…');
      const res = await ctx.gas.mailWeek({ to: s.gas.mailTo, subject: mail.subject, html: mail.html, text: mail.text, senderName: s.gas.senderName || s.teacherName });
      markMailed(fmtDate(monday));
      toast(`送信しました(残り${res.remaining}通)`);
    } catch (e) {
      toast('送信失敗: ' + e.message, 'error', 6000);
    }
  };

  const calBtn = root.querySelector('#wk-calendar');
  if (calBtn) calBtn.onclick = async () => {
    try {
      toast('取得中…');
      const dayCount = store.settings.saturday ? 6 : 5;
      const res = await ctx.gas.events(fmtDate(monday), fmtDate(addDays(monday, dayCount - 1)), store.settings.gas.calendarIds || []);
      if (res.errors?.length) {
        toast('一部のカレンダーを読めません: ' + res.errors.join(' / '), 'error', 6000);
      }
      const week = store.getWeek(fmtDate(monday), true);
      let n = 0;
      for (const ev of res.events || []) {
        const idx = Math.round((parseDate(ev.date) - monday) / 86400000);
        if (idx < 0 || idx >= dayCount) continue;
        const line = (ev.time ? ev.time + ' ' : '') + ev.title;
        if (!week.events[idx]) week.events[idx] = line;
        else if (!week.events[idx].includes(ev.title)) week.events[idx] += '\n' + line;
        n++;
      }
      store.commit();
      toast(`${n}件を取り込みました`);
      ctx.rerender();
    } catch (e) {
      toast('取得失敗: ' + e.message, 'error', 5000);
    }
  };
}

// ---------------------------------------------------------------- 週入力

function wireWeekInputs(root, weekStart, ctx) {
  root.querySelectorAll('.event-input:not(.daynote-input)').forEach(ta => {
    ta.addEventListener('input', () => {
      const w = store.getWeek(weekStart, true);
      w.events[Number(ta.dataset.day)] = ta.value;
      store.commit();
    });
  });
  root.querySelector('#wk-goals').addEventListener('input', (ev) => {
    const w = store.getWeek(weekStart, true);
    w.goals = ev.target.value;
    store.commit();
  });
  root.querySelector('#wk-reflection').addEventListener('input', (ev) => {
    const w = store.getWeek(weekStart, true);
    w.reflection = ev.target.value;
    store.commit();
  });
  root.querySelectorAll('.daypat-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const w = store.getWeek(weekStart, true);
      const d = Number(sel.dataset.day);
      if (sel.value) w.dayPatterns[d] = sel.value;
      else delete w.dayPatterns[d];
      ctx.swapSource = null;
      store.commit();
      ctx.rerender();
    });
  });
  root.querySelectorAll('.daynote-input').forEach(ta => {
    ta.addEventListener('input', () => {
      const w = store.getWeek(weekStart, true);
      if (!Array.isArray(w.dayNotes)) w.dayNotes = ['', '', '', '', '', ''];
      w.dayNotes[Number(ta.dataset.day)] = ta.value;
      store.commit();
    });
  });
}

// ---------------------------------------------------------------- 連続入力(ペイント)

function wirePaint(root, ctx) {
  root.querySelector('#wk-paint').onclick = () => {
    ctx.paint.open = !ctx.paint.open;
    if (!ctx.paint.open) ctx.paint.subject = null;
    ctx.swapSource = null;
    ctx.rerender();
  };
  const closeBtn = root.querySelector('#paint-close');
  if (closeBtn) closeBtn.onclick = () => {
    ctx.paint.open = false;
    ctx.paint.subject = null;
    ctx.rerender();
  };
  root.querySelectorAll('[data-paint]').forEach(b => {
    b.onclick = () => {
      ctx.paint.subject = ctx.paint.subject === b.dataset.paint ? null : b.dataset.paint;
      ctx.rerender();
    };
  });
  root.querySelectorAll('[data-paint-scope]').forEach(b => {
    b.onclick = () => {
      ctx.paint.scope = ctx.paint.scope === b.dataset.paintScope ? null : b.dataset.paintScope;
      ctx.rerender();
    };
  });
}

/** ペイント中のセルクリック処理。戻り値: 処理したか */
function paintCell(weekStart, dayIdx, periodId, ctx) {
  const s = store.settings;
  const paint = ctx.paint;
  if (!paint.subject) { toast('教科を選んでください', 'error'); return true; }
  const w = store.getWeek(weekStart, true);
  const key = cellKey(dayIdx, periodId);
  const cell = w.cells[key];
  const entries = cell?.entries || [];

  // 同じ教科の「きれいな」単独エントリ → トグル消去(備考・手動内容入りは壊さない)
  if (entries.length === 1 && entries[0].subjectKey === paint.subject
    && entries[0].auto && !entries[0].note && !entries[0].cancelled
    && (s.mode !== 'senka' || entries[0].scope === (paint.scope ?? entries[0].scope))) {
    delete w.cells[key];
    store.commit();
    ctx.rerender();
    return true;
  }
  // 既に何か入っているセルは通常の編集を開く(誤破壊防止)
  if (entries.length) return false;

  if (s.mode === 'fukushiki') {
    // 複式: 両学年に同じ教科を配置
    w.cells[key] = { entries: s.fukushikiGrades.map(g => Object.assign(newEntry(), { subjectKey: paint.subject, scope: g })) };
  } else {
    const e = Object.assign(newEntry(), { subjectKey: paint.subject });
    if (s.mode === 'senka') e.scope = paint.scope ?? ctx.lastScope ?? s.senkaClasses[0]?.id ?? null;
    w.cells[key] = { entries: [e] };
  }
  store.commit();
  ctx.rerender();
  return true;
}

// ---------------------------------------------------------------- 初回ガイド・日一括

function wireOnboardCard(root, ctx, monday) {
  const card = root.querySelector('#onboard-card');
  if (!card) return;
  root.querySelector('#oc-close').onclick = () => {
    localStorage.setItem('shuan-card-done', '1');
    card.remove();
  };
  root.querySelector('#oc-base').onclick = () => root.querySelector('#wk-save-base').click();
  root.querySelector('#oc-print').onclick = async () => {
    const { printWeek } = await import('../print.js');
    printWeek(fmtDate(monday));
  };
}

function wireDayMenu(root, ctx, monday, weekStart, dayCount) {
  root.querySelectorAll('.day-th').forEach(th => {
    th.addEventListener('click', () => {
      const d = Number(th.dataset.day);
      const date = addDays(monday, d);
      const label = `${fmtMD(date)}(${DAY_NAMES[d]})`;
      openModal(`
        <h2>${esc(label)} の一括操作</h2>
        <div style="display:flex; flex-direction:column; gap:8px;">
          <button class="btn" data-act="cancel-all">すべて中止にする</button>
          ${d > 0 ? `<button class="btn" data-act="copy-prev">前日をコピー</button>` : ''}
          <button class="btn danger" data-act="clear">この日をクリア</button>
        </div>
        <div class="modal-foot"><button class="btn" data-close>閉じる</button></div>
      `, (modal, close) => {
        modal.querySelector('[data-close]').onclick = close;
        modal.querySelectorAll('[data-act]').forEach(b => {
          b.onclick = () => {
            const act = b.dataset.act;
            const w = store.getWeek(weekStart, true);
            const state = store.state;
            const ordinals = computeOrdinals(state, weekStart);
            store.snapshot(`${label}の一括操作`);
            let n = 0;
            if (act === 'cancel-all') {
              for (const p of store.settings.periods) {
                const cell = w.cells[cellKey(d, p.id)];
                if (!cell) continue;
                for (const e of cell.entries) {
                  if (e.cancelled || !e.subjectKey) continue;
                  e.cancelledText = resolveEntryText(state, e, ordinals).text;
                  e.cancelled = true;
                  n++;
                }
              }
            } else if (act === 'clear') {
              for (const p of store.settings.periods) {
                if (w.cells[cellKey(d, p.id)]) { delete w.cells[cellKey(d, p.id)]; n++; }
              }
            } else if (act === 'copy-prev') {
              for (const p of store.settings.periods) {
                const src = w.cells[cellKey(d - 1, p.id)];
                if (!src) continue;
                w.cells[cellKey(d, p.id)] = {
                  entries: src.entries.map(e => ({ ...e, id: uid(), text: '', auto: true, note: '', cancelled: false, cancelledText: '' })),
                };
                n++;
              }
            }
            store.commit();
            close();
            toast(`${label}: ${n}コマを処理しました`, 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
            ctx.rerender();
          };
        });
      });
    });
  });
}

// ---------------------------------------------------------------- セル操作

function wireCells(root, weekStart, ctx) {
  root.querySelectorAll('td.cell').forEach(td => {
    td.addEventListener('click', (ev) => {
      if (td.classList.contains('off')) return;
      if (ev.target.closest('[data-clear]')) return;
      const day = Number(td.dataset.day);
      const period = td.dataset.period;
      if (ctx.swapSource) {
        const src = ctx.swapSource;
        ctx.swapSource = null;
        swapCells(weekStart, src, { day, period });
        ctx.rerender();
        return;
      }
      // 連続入力モード
      if (ctx.paint.open) {
        if (paintCell(weekStart, day, period, ctx)) return;
      }
      openCellEditor(weekStart, day, period, ctx);
    });
    const clearBtn = td.querySelector('[data-clear]');
    if (clearBtn) {
      clearBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const w = store.getWeek(weekStart, true);
        store.snapshot('コマのクリア');
        delete w.cells[cellKey(td.dataset.day, td.dataset.period)];
        store.commit();
        toast('コマをクリアしました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
        ctx.rerender();
      });
    }

    td.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', JSON.stringify({ day: td.dataset.day, period: td.dataset.period }));
      ev.dataTransfer.effectAllowed = 'move';
    });
    td.addEventListener('dragover', (ev) => { ev.preventDefault(); td.classList.add('drag-over'); });
    td.addEventListener('dragleave', () => td.classList.remove('drag-over'));
    td.addEventListener('drop', (ev) => {
      ev.preventDefault();
      td.classList.remove('drag-over');
      if (td.classList.contains('off')) return;
      let src;
      try { src = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
      if (!src || src.day == null) return;
      swapCells(weekStart, src, { day: td.dataset.day, period: td.dataset.period });
      ctx.rerender();
    });
  });
}

/** 2つのコマの中身を入れ替える(片方が空なら移動になる)。無効な校時へは移動させない */
function swapCells(weekStart, from, to) {
  const s = store.settings;
  const w = store.getWeek(weekStart, true);
  const fromP = s.periods.find(p => p.id === String(from.period));
  const toP = s.periods.find(p => p.id === String(to.period));
  if (!fromP || !toP
    || !effectivePeriod(s, w, Number(from.day), fromP)
    || !effectivePeriod(s, w, Number(to.day), toP)) {
    toast('この日の日課にない校時です', 'error');
    return;
  }
  const kFrom = cellKey(from.day, from.period);
  const kTo = cellKey(to.day, to.period);
  if (kFrom === kTo) return;
  const a = w.cells[kFrom], b = w.cells[kTo];
  if (a) w.cells[kTo] = a; else delete w.cells[kTo];
  if (b) w.cells[kFrom] = b; else delete w.cells[kFrom];
  store.commit();
}

// ---------------------------------------------------------------- セル編集モーダル

export function openCellEditor(weekStart, dayIdx, periodId, ctx) {
  const s = store.settings;
  const period = s.periods.find(p => p.id === periodId);
  const monday = parseDate(weekStart);
  const date = addDays(monday, dayIdx);
  const title = `${fmtMD(date)}(${DAY_NAMES[dayIdx]}) ${period?.label || ''}${period?.type === 'module' ? '' : '校時'}`;

  const ensure = () => {
    const w = store.getWeek(weekStart, true);
    const key = cellKey(dayIdx, periodId);
    if (!w.cells[key]) w.cells[key] = { entries: [] };
    const cell = w.cells[key];
    if (s.mode === 'fukushiki') {
      for (const g of s.fukushikiGrades) {
        if (!cell.entries.some(e => e.scope === g)) {
          const e = newEntry();
          e.scope = g;
          cell.entries.push(e);
        }
      }
      cell.entries.sort((a, b) => (a.scope || 0) - (b.scope || 0));
    } else if (!cell.entries.length) {
      const e = newEntry();
      if (s.mode === 'senka') {
        e.scope = ctx.lastScope ?? s.senkaClasses[0]?.id ?? null;
        e.subjectKey = s.senkaSubject || '';
      }
      cell.entries.push(e);
    }
    return cell;
  };

  ensure();

  const render = (modal) => {
    const state = store.state;
    const ordinals = computeOrdinals(state, weekStart);
    const cellNow = store.getCell(weekStart, dayIdx, periodId) || { entries: [] };
    // 複式: 両学年へまとめて教科をセットする共通パレット
    const commonPalette = s.mode === 'fukushiki' ? `
      <div class="field">
        <label>教科(両学年)${infoHTML('両学年に同じ教科を入れます。学年ごとに変えるときは下の各学年で選び直してください')}</label>
        <div class="subject-palette" data-common-palette>${s.subjects.map(x =>
          `<button data-subj="${esc(x.key)}" style="background:${esc(x.color)}">${esc(x.short || x.name)}</button>`).join('')}</div>
      </div>` : '';
    const body = cellNow.entries.map((e, i) => entryEditorHTML(state, e, i, period, ordinals)).join('');
    modal.querySelector('.cell-editor-body').innerHTML = commonPalette + body + `
      ${s.mode !== 'fukushiki' ? `<button class="btn small" data-add-entry>＋ 授業を追加</button>` : ''}
    `;
    wireEditor(modal);
  };

  const wireEditor = (modal) => {
    const cellNow = store.getCell(weekStart, dayIdx, periodId);
    const state = store.state;

    // 複式の共通パレット
    modal.querySelectorAll('[data-common-palette] button').forEach(b => {
      b.onclick = () => {
        for (const e of cellNow.entries) {
          e.subjectKey = b.dataset.subj;
          if (e.auto) e.text = '';
        }
        store.commit(); render(modal); ctx.rerender();
      };
    });

    modal.querySelectorAll('[data-entry]').forEach(box => {
      const idx = Number(box.dataset.entry);
      const entry = cellNow.entries[idx];

      box.querySelectorAll('.subject-palette button').forEach(b => {
        b.onclick = () => {
          entry.subjectKey = b.dataset.subj === entry.subjectKey ? '' : b.dataset.subj;
          if (entry.auto) entry.text = '';
          store.commit();
          render(modal);
          ctx.rerender();
        };
      });

      // 専科: 学級はボタンで1タップ選択。選んだ学級を次のコマの既定にする
      box.querySelectorAll('[data-scope-btn]').forEach(b => {
        b.onclick = () => {
          entry.scope = b.dataset.scopeBtn || null;
          ctx.lastScope = entry.scope;
          store.commit(); render(modal); ctx.rerender();
        };
      });

      // 複式: 直接/間接/ガイドの3択チップ(同じものを押すと解除)
      box.querySelectorAll('[data-guide]').forEach(b => {
        b.onclick = () => {
          entry.guide = entry.guide === b.dataset.guide ? null : b.dataset.guide;
          store.commit(); render(modal); ctx.rerender();
        };
      });

      const textArea = box.querySelector('[name="text"]');
      textArea.addEventListener('input', () => {
        entry.text = textArea.value;
        entry.auto = textArea.value.trim() === '';
        store.commit();
      });
      textArea.addEventListener('change', () => ctx.rerender());

      const noteInput = box.querySelector('[name="note"]');
      noteInput.addEventListener('input', () => { entry.note = noteInput.value; store.commit(); });
      noteInput.addEventListener('change', () => ctx.rerender());

      const resetBtn = box.querySelector('[data-reset-auto]');
      if (resetBtn) resetBtn.onclick = () => {
        entry.text = ''; entry.auto = true;
        store.commit(); render(modal); ctx.rerender();
      };

      const advChk = box.querySelector('[name="advance"]');
      advChk.onchange = () => {
        const def = period?.type !== 'module';
        entry.advance = advChk.checked === def ? null : advChk.checked;
        store.commit(); ctx.rerender();
      };

      const ncChk = box.querySelector('[name="noCount"]');
      ncChk.onchange = () => { entry.noCount = ncChk.checked; store.commit(); ctx.rerender(); };

      const cancelChk = box.querySelector('[name="cancelled"]');
      cancelChk.onchange = () => {
        if (cancelChk.checked) {
          // 中止前の予定内容を控えておく(印刷・画面に「何が中止か」を残す)
          const ords = computeOrdinals(state, weekStart);
          entry.cancelledText = resolveEntryText(state, entry, ords).text;
          entry.cancelled = true;
        } else {
          entry.cancelled = false;
          entry.cancelledText = '';
        }
        store.commit(); render(modal); ctx.rerender();
      };

      const fracSel = box.querySelector('[name="fraction"]');
      fracSel.onchange = () => { entry.fraction = Number(fracSel.value); store.commit(); ctx.rerender(); };

      const delBtn = box.querySelector('[data-del-entry]');
      if (delBtn) delBtn.onclick = () => {
        cellNow.entries.splice(idx, 1);
        store.commit(); render(modal); ctx.rerender();
      };
    });

    const addBtn = modal.querySelector('[data-add-entry]');
    if (addBtn) addBtn.onclick = () => {
      const e = newEntry();
      if (s.mode === 'senka') {
        e.scope = ctx.lastScope ?? s.senkaClasses[0]?.id ?? null;
        e.subjectKey = s.senkaSubject || '';
      }
      cellNow.entries.push(e);
      store.commit(); render(modal); ctx.rerender();
    };
  };

  openModal(`
    <h2>${esc(title)}</h2>
    <div class="cell-editor-body"></div>
    <div class="modal-foot">
      <button class="btn danger left" data-clear-cell>クリア</button>
      <button class="btn" data-swap>⇄ 移動</button>
      <button class="btn primary" data-close>完了</button>
    </div>
  `, (modal, close) => {
    render(modal);
    modal.querySelector('[data-close]').onclick = () => close();
    modal.querySelector('[data-swap]').onclick = () => {
      ctx.swapSource = { day: dayIdx, period: periodId };
      close();
    };
    modal.querySelector('[data-clear-cell]').onclick = () => {
      const w = store.getWeek(weekStart, true);
      store.snapshot('コマのクリア');
      delete w.cells[cellKey(dayIdx, periodId)];
      store.commit();
      close();
      toast('コマをクリアしました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    };
  }, cleanup);

  // 空のままのエントリは閉じるときに掃除する(冪等)
  function cleanup() {
    const w = store.state.weeks[weekStart];
    const key = cellKey(dayIdx, periodId);
    const c = w?.cells?.[key];
    if (c) {
      c.entries = c.entries.filter(e => e.subjectKey || (e.text && !e.auto) || e.note);
      if (!c.entries.length) delete w.cells[key];
    }
    if (w && !Object.keys(w.cells).length && !w.goals && !w.reflection
      && !(w.events || []).some(Boolean)
      && !Object.keys(w.dayPatterns || {}).length
      && !(w.dayNotes || []).some(Boolean)) {
      delete store.state.weeks[weekStart];
    }
    store.commit();
    ctx.rerender();
  }
}

function entryEditorHTML(state, entry, idx, period, ordinals) {
  const s = state.settings;
  const resolved = resolveEntryText(state, entry, ordinals);
  const isModule = period?.type === 'module';
  const effAdvance = entry.advance == null ? !isModule : !!entry.advance;

  const palette = s.subjects.map(x =>
    `<button data-subj="${esc(x.key)}" class="${x.key === entry.subjectKey ? 'selected' : ''}"
       style="background:${esc(x.color)}">${esc(x.short || x.name)}</button>`).join('');

  // 専科: 学級ボタン列(1タップ選択)
  let scopeField = '';
  if (s.mode === 'senka' && s.senkaClasses.length) {
    scopeField = `<div class="field"><label>学級</label>
      <div class="scope-palette">${s.senkaClasses.map(c =>
        `<button data-scope-btn="${esc(c.id)}" class="${entry.scope === c.id ? 'selected' : ''}">${esc(c.label || '?')}</button>`).join('')}
      </div></div>`;
  }

  const isKnownGrade = typeof entry.scope === 'number' && s.fukushikiGrades.includes(entry.scope);
  let gradeHead = '';
  if (s.mode === 'fukushiki') {
    const guideChips = ['direct', 'indirect', 'guide'].map(g =>
      `<button data-guide="${g}" class="guide-btn g-${g} ${entry.guide === g ? 'selected' : ''}">${guideLabel(g)}</button>`).join('');
    gradeHead = `<div class="grade-head">
      <span>📘 ${isKnownGrade ? `${entry.scope}年` : '学年未設定'}</span>
      <span class="guide-chips">${guideChips}${infoHTML('直=直接指導 間=間接指導(自力学習) ガ=ガイド学習。印刷に◎○△で出ます')}</span>
    </div>`;
  }

  const autoBlock = entry.auto && resolved.text
    ? `<div class="auto-preview"><span class="label">自動反映</span>${esc(resolved.text)}</div>`
    : (entry.auto && !state.plans.length && idx === 0
      ? `<div class="auto-preview muted">年間指導計画を登録すると、ここに単元・内容が自動で入ります</div>` : '');

  // 既定値から変わっている項目があるときだけ「詳細」を開いておく
  const advOpen = (entry.fraction ?? 1) !== 1 || entry.advance != null || entry.noCount || entry.cancelled;

  // 複式では学年別パレットを折りたたみ(共通パレットが主)
  const paletteBlock = s.mode === 'fukushiki'
    ? `<details ${entry.subjectKey ? '' : 'open'}><summary class="fold-label">この学年の教科を変える</summary>
        <div class="subject-palette" style="margin-top:6px;">${palette}</div></details>`
    : `<div class="field"><label>教科</label><div class="subject-palette">${palette}</div></div>`;

  return `
    <div data-entry="${idx}" class="entry-editor">
      ${gradeHead}
      ${paletteBlock}
      ${scopeField}
      ${autoBlock}
      <div class="field">
        <label>内容 ${!entry.auto ? '<button class="btn small ghost" data-reset-auto>↺ 自動に戻す</button>' : ''}</label>
        <textarea name="text" placeholder="${esc(resolved.auto && resolved.text ? resolved.text : '')}">${entry.auto ? '' : esc(entry.text)}</textarea>
      </div>
      <div class="field">
        <label>備考</label>
        <input type="text" name="note" value="${esc(entry.note || '')}">
      </div>
      <details class="adv" ${advOpen ? 'open' : ''}>
        <summary class="fold-label">詳細</summary>
        <div class="field" style="max-width:200px; margin-top:8px;">
          <label>時数${infoHTML('1コマを複数の教科で分けるときの割合(例: 国語1/3+行事2/3)')}</label>
          <select name="fraction">
            <option value="1" ${(entry.fraction ?? 1) === 1 ? 'selected' : ''}>1</option>
            <option value="0.6666666666666666" ${Math.abs((entry.fraction ?? 1) - 2 / 3) < 0.01 ? 'selected' : ''}>2/3</option>
            <option value="0.5" ${Math.abs((entry.fraction ?? 1) - 0.5) < 0.01 ? 'selected' : ''}>1/2</option>
            <option value="0.3333333333333333" ${Math.abs((entry.fraction ?? 1) - 1 / 3) < 0.01 ? 'selected' : ''}>1/3</option>
          </select>
        </div>
        <div class="checkline"><input type="checkbox" name="advance" id="adv-${idx}" ${effAdvance ? 'checked' : ''}>
          <label for="adv-${idx}">進度を進める</label>${infoHTML('年間指導計画の「何時間目か」を1つ進めます。ドリル等で単元を進めないときはオフに')}</div>
        <div class="checkline"><input type="checkbox" name="noCount" id="nc-${idx}" ${entry.noCount ? 'checked' : ''}>
          <label for="nc-${idx}">時数に数えない</label>${infoHTML('教育課程外の朝活動・テスト監督などに')}</div>
        <div class="checkline"><input type="checkbox" name="cancelled" id="cl-${idx}" ${entry.cancelled ? 'checked' : ''}>
          <label for="cl-${idx}">中止</label>${infoHTML('学級閉鎖・行事変更などで実施しなかったコマ。以降の授業内容は自動で繰り下がります')}</div>
        ${s.mode !== 'fukushiki' || !isKnownGrade ? `<button class="btn small danger" data-del-entry>この授業を削除</button>` : ''}
      </details>
    </div>`;
}

// ---------------------------------------------------------------- 週のミニ集計

function renderMiniStats(state, weekStart) {
  const s = state.settings;
  const hours = computeHours(state, weekStart);
  const bySubj = new Map();
  for (const [key, v] of hours) {
    const [subjKey, scope] = key.split('|');
    const label = subjKey + (scope ? `|${scope}` : '');
    bySubj.set(label, v);
  }
  if (!bySubj.size) return '';
  const chips = [...bySubj.entries()]
    .filter(([, v]) => v.week > 0)
    .map(([key, v]) => {
      const [subjKey, scope] = key.split('|');
      const subj = subjectOf(s, subjKey);
      if (!subj) return '';
      const scopeLabel = scope ? (s.mode === 'fukushiki' ? `${scope}年` : (s.senkaClasses.find(c => c.id === scope)?.label || '')) : '';
      return `<span style="display:inline-flex; align-items:center; gap:4px; margin:2px 6px 2px 0;">
        <span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>
        <span style="font-size:12.5px;">${scopeLabel ? esc(scopeLabel) + ' ' : ''}${fmtHours(v.week)}</span></span>`;
    }).join('');
  return `<div class="panel" style="padding:10px 16px;">
    <span style="font-size:12.5px; font-weight:700; color:#374151; margin-right:10px;">今週の時数</span>${chips}
  </div>`;
}
