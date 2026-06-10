/** 週案編集ビュー(グリッド・セル編集・前週コピー・行事・反省) */

import { store, newEntry, cellKey, computeOrdinals, resolveEntryText, computeHours, scopeKey, fmtHours } from '../store.js';
import { fmtDate, parseDate, addDays, fmtMD, weekNumberInFiscalYear, DAY_NAMES, esc, uid } from '../utils.js';
import { openModal, toast, confirmDialog, selectHTML } from '../ui.js';

export function renderWeekView(root, ctx) {
  const state = store.state;
  const s = state.settings;
  const weekStart = ctx.getWeekStart();
  const monday = parseDate(weekStart);
  const week = store.getWeek(weekStart);
  const dayCount = s.saturday ? 6 : 5;
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);

  const dayHeads = [];
  for (let d = 0; d < dayCount; d++) {
    const date = addDays(monday, d);
    dayHeads.push(`
      <th>
        <div class="day-head ${d === 5 ? 'sat' : ''}">
          <span class="dow">${DAY_NAMES[d]}</span>
          <span class="date">${fmtMD(date)}</span>
        </div>
      </th>`);
  }

  const eventCells = [];
  for (let d = 0; d < dayCount; d++) {
    eventCells.push(`<td><textarea class="event-input" data-day="${d}" rows="1"
      placeholder="">${esc(week.events?.[d] || '')}</textarea></td>`);
  }

  const bodyRows = s.periods.map(p => {
    const cells = [];
    for (let d = 0; d < dayCount; d++) {
      cells.push(renderCell(state, week, d, p, ordinals, ctx));
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
  }).join('');

  root.innerHTML = `
    <div class="week-nav">
      <button class="btn" id="wk-prev">◀ 前週</button>
      <button class="btn" id="wk-today">今週</button>
      <button class="btn" id="wk-next">翌週 ▶</button>
      <input type="date" id="wk-date" value="${weekStart}" title="日付を選ぶとその週へ移動">
      <span class="week-title">${monday.getMonth() + 1}月${monday.getDate()}日 〜 ${fmtMD(addDays(monday, dayCount - 1))}
        <span class="week-no">第${weekNo}週・${s.fiscalYear}年度</span>
      </span>
      <span class="spacer"></span>
      <button class="btn" id="wk-calendar" title="GAS連携でGoogleカレンダーの予定を行事欄に取り込む">📆 行事を取得</button>
      <button class="btn" id="wk-copy" title="前の週の時間割をこの週へコピー">⬇ 前週をコピー</button>
      <button class="btn" id="wk-apply-base" title="登録済みの基本時間割をこの週へ流し込む" ${store.hasBaseTimetable ? '' : 'disabled'}>📋 基本時間割を反映</button>
      <details class="menu">
        <summary class="btn">その他 ▾</summary>
        <div class="menu-items">
          <button class="btn ghost" id="wk-save-base">この週を基本時間割として登録</button>
          <button class="btn ghost danger" id="wk-clear">この週をクリア</button>
        </div>
      </details>
    </div>
    ${ctx.swapSource ? `<div class="panel" style="padding:8px 16px; background:#fff7ed; border-color:#fdba74;">
      ⇄ <b>移動モード:</b> 移動先のコマをクリックすると入れ替わります
      <button class="btn small" id="wk-swap-cancel" style="margin-left:10px;">キャンセル</button></div>` : ''}

    <div class="panel">
      <div class="week-grid-wrap">
        <table class="week-grid">
          <thead>
            <tr><th class="corner"></th>${dayHeads.join('')}</tr>
            <tr class="event-row"><th class="period-head">行事</th>${eventCells.join('')}</tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      <div class="week-notes">
        <div>
          <label>今週のめあて・重点</label>
          <textarea id="wk-goals" placeholder="今週の目標、生徒指導の重点など">${esc(week.goals || '')}</textarea>
        </div>
        <div>
          <label>反省・次週への課題</label>
          <textarea id="wk-reflection" placeholder="授業の振り返り、進度の調整メモなど">${esc(week.reflection || '')}</textarea>
        </div>
      </div>
    </div>
    ${renderMiniStats(state, weekStart)}
  `;

  wireNav(root, ctx, monday);
  wireWeekInputs(root, weekStart, ctx);
  wireCells(root, weekStart, ctx);
}

// ---------------------------------------------------------------- セル描画

function renderCell(state, week, dayIdx, period, ordinals, ctx) {
  const s = state.settings;
  const cell = week.cells?.[cellKey(dayIdx, period.id)];
  const entries = cell?.entries || [];
  const isModule = period.type === 'module';
  let inner;
  if (!entries.length) {
    inner = `<div class="cell-empty">＋</div>`;
  } else {
    inner = entries.map(e => {
      const subj = subjectOf(s, e.subjectKey);
      const { text, auto } = resolveEntryText(state, e, ordinals);
      const scopeLabel = scopeLabelOf(s, e.scope);
      const frac = (e.fraction ?? 1) !== 1 ? `<span class="e-flag">${fracLabel(e.fraction)}</span>` : '';
      return `
        <div class="entry ${e.cancelled ? 'cancelled' : ''}">
          <div class="e-head">
            ${subj ? `<span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>` : ''}
            ${scopeLabel ? `<span class="e-scope">${esc(scopeLabel)}</span>` : ''}
            ${frac}
            ${e.cancelled ? `<span class="e-flag" style="color:#dc2626;">中止</span>` : e.noCount ? `<span class="e-flag">時数外</span>` : ''}
          </div>
          ${text ? `<div class="e-text ${auto ? '' : 'manual'}">${esc(text)}</div>` : ''}
          ${e.note ? `<div class="e-note">${esc(e.note)}</div>` : ''}
        </div>`;
    }).join('');
  }
  const draggable = entries.length > 0;
  const isSwapSrc = ctx.swapSource && ctx.swapSource.day === dayIdx && ctx.swapSource.period === period.id;
  return `
    <td class="cell ${isModule ? 'module-cell' : ''} ${isSwapSrc ? 'drag-over' : ''}" data-day="${dayIdx}" data-period="${esc(period.id)}"
        ${draggable ? 'draggable="true"' : ''}>
      ${inner}
      ${entries.length ? `<button class="cell-clear" title="このコマをクリア" data-clear>×</button>` : ''}
    </td>`;
}

export function fracLabel(f) {
  if (Math.abs(f - 1 / 3) < 0.01) return '1/3';
  if (Math.abs(f - 2 / 3) < 0.01) return '2/3';
  if (Math.abs(f - 0.5) < 0.01) return '1/2';
  return String(f);
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

// ---------------------------------------------------------------- ナビ・週入力

function wireNav(root, ctx, monday) {
  root.querySelector('#wk-prev').onclick = () => ctx.setWeekStart(fmtDate(addDays(monday, -7)));
  root.querySelector('#wk-next').onclick = () => ctx.setWeekStart(fmtDate(addDays(monday, 7)));
  root.querySelector('#wk-today').onclick = () => ctx.setWeekStart(null);
  root.querySelector('#wk-date').onchange = (ev) => {
    if (ev.target.value) ctx.setWeekStart(ev.target.value, true);
  };

  root.querySelector('#wk-apply-base').onclick = async () => {
    const to = fmtDate(monday);
    const cur = store.state.weeks[to];
    if (cur && Object.keys(cur.cells).length) {
      const ok = await confirmDialog('この週には既に入力があります。基本時間割で上書きしますか?', { okLabel: '上書き', danger: true });
      if (!ok) return;
    }
    if (store.applyBaseTimetable(to)) {
      toast('基本時間割を反映しました(内容は年間指導計画から自動反映)');
      ctx.rerender();
    }
  };

  root.querySelector('#wk-save-base').onclick = async () => {
    const from = fmtDate(monday);
    if (!store.state.weeks[from] || !Object.keys(store.state.weeks[from].cells).length) {
      toast('この週にはまだ時間割が入力されていません', 'error');
      return;
    }
    if (store.hasBaseTimetable) {
      const ok = await confirmDialog('登録済みの基本時間割を、この週の時間割で置き換えますか?');
      if (!ok) return;
    }
    store.saveAsBaseTimetable(from);
    toast('基本時間割として登録しました。「📋 基本時間割を反映」で毎週呼び出せます');
    ctx.rerender();
  };

  const swapCancel = root.querySelector('#wk-swap-cancel');
  if (swapCancel) swapCancel.onclick = () => { ctx.swapSource = null; ctx.rerender(); };

  root.querySelector('#wk-copy').onclick = async () => {
    const from = fmtDate(addDays(monday, -7));
    const to = fmtDate(monday);
    if (!store.state.weeks[from]) { toast('前週のデータがありません', 'error'); return; }
    const cur = store.state.weeks[to];
    if (cur && Object.keys(cur.cells).length) {
      const ok = await confirmDialog('この週には既に入力があります。前週の時間割で上書きしますか?\n(授業内容は年間指導計画から自動で再計算されます)', { okLabel: '上書きコピー', danger: true });
      if (!ok) return;
    }
    store.copyWeek(from, to);
    toast('前週の時間割をコピーしました(内容は自動反映)');
    ctx.rerender();
  };

  root.querySelector('#wk-clear').onclick = async () => {
    const to = fmtDate(monday);
    if (!store.state.weeks[to]) return;
    const ok = await confirmDialog('この週の入力をすべて削除しますか?', { okLabel: '削除', danger: true });
    if (!ok) return;
    delete store.state.weeks[to];
    store.commit();
    ctx.rerender();
  };

  root.querySelector('#wk-calendar').onclick = async () => {
    if (!ctx.gas.configured) {
      toast('設定画面でGAS連携を設定すると、Googleカレンダーから行事を取り込めます', 'error', 4000);
      return;
    }
    try {
      toast('カレンダーから取得中…');
      const dayCount = store.settings.saturday ? 6 : 5;
      const res = await ctx.gas.events(fmtDate(monday), fmtDate(addDays(monday, dayCount - 1)));
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
      toast(`${n}件の予定を取り込みました`);
      ctx.rerender();
    } catch (e) {
      toast('取得失敗: ' + e.message, 'error', 5000);
    }
  };
}

function wireWeekInputs(root, weekStart, ctx) {
  // inputイベントで即時保存(タブを閉じても・他タブ同期が走っても入力が消えないように)
  root.querySelectorAll('.event-input').forEach(ta => {
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
}

// ---------------------------------------------------------------- セル操作(クリック編集・DnD)

function wireCells(root, weekStart, ctx) {
  root.querySelectorAll('td.cell').forEach(td => {
    td.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-clear]')) return;
      // 移動モード中: タップで入替(iPad等のタッチ環境向け)
      if (ctx.swapSource) {
        const src = ctx.swapSource;
        ctx.swapSource = null;
        swapCells(weekStart, src, { day: Number(td.dataset.day), period: td.dataset.period });
        ctx.rerender();
        return;
      }
      openCellEditor(weekStart, Number(td.dataset.day), td.dataset.period, ctx);
    });
    const clearBtn = td.querySelector('[data-clear]');
    if (clearBtn) {
      clearBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const w = store.getWeek(weekStart, true);
        delete w.cells[cellKey(td.dataset.day, td.dataset.period)];
        store.commit();
        ctx.rerender();
      });
    }

    // ドラッグ&ドロップでコマを移動(入れ替え)
    td.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', JSON.stringify({ day: td.dataset.day, period: td.dataset.period }));
      ev.dataTransfer.effectAllowed = 'move';
    });
    td.addEventListener('dragover', (ev) => { ev.preventDefault(); td.classList.add('drag-over'); });
    td.addEventListener('dragleave', () => td.classList.remove('drag-over'));
    td.addEventListener('drop', (ev) => {
      ev.preventDefault();
      td.classList.remove('drag-over');
      let src;
      try { src = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
      if (!src || src.day == null) return;
      swapCells(weekStart, src, { day: td.dataset.day, period: td.dataset.period });
      ctx.rerender();
    });
  });
}

/** 2つのコマの中身を入れ替える(片方が空なら移動になる) */
function swapCells(weekStart, from, to) {
  const w = store.getWeek(weekStart, true);
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
  const title = `${date.getMonth() + 1}/${date.getDate()}(${DAY_NAMES[dayIdx]}) ${period?.label || ''}${period?.type === 'module' ? '' : '校時'}`;

  const ensure = () => {
    const w = store.getWeek(weekStart, true);
    const key = cellKey(dayIdx, periodId);
    if (!w.cells[key]) w.cells[key] = { entries: [] };
    const cell = w.cells[key];
    if (s.mode === 'fukushiki') {
      // 複式: 学年ごとに1エントリを常設
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
      if (s.mode === 'senka') e.scope = s.senkaClasses[0]?.id ?? null;
      cell.entries.push(e);
    }
    return cell;
  };

  const cell = ensure();

  const render = (modal) => {
    const state = store.state;
    const ordinals = computeOrdinals(state, weekStart);
    const cellNow = store.getCell(weekStart, dayIdx, periodId) || { entries: [] };
    const body = cellNow.entries.map((e, i) => entryEditorHTML(state, e, i, period, ordinals)).join('');
    modal.querySelector('.cell-editor-body').innerHTML = body + `
      ${s.mode !== 'fukushiki' ? `<button class="btn small" data-add-entry>＋ 同じコマに授業を追加(複数学級・分割など)</button>` : ''}
    `;
    wireEditor(modal);
  };

  const wireEditor = (modal) => {
    const cellNow = store.getCell(weekStart, dayIdx, periodId);
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

      const scopeSel = box.querySelector('[name="scope"]');
      if (scopeSel) scopeSel.onchange = () => {
        entry.scope = s.mode === 'fukushiki' ? Number(scopeSel.value) : (scopeSel.value || null);
        store.commit(); render(modal); ctx.rerender();
      };

      // 入力は即時保存(Escで閉じても消えない)。背後のグリッドのみ更新し、
      // モーダル自体はblur時にも再構築しない(直後のクリックが飲み込まれるのを防ぐ)
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
        store.commit(); render(modal); ctx.rerender();
      };

      const ncChk = box.querySelector('[name="noCount"]');
      ncChk.onchange = () => { entry.noCount = ncChk.checked; store.commit(); render(modal); ctx.rerender(); };

      const cancelChk = box.querySelector('[name="cancelled"]');
      cancelChk.onchange = () => { entry.cancelled = cancelChk.checked; store.commit(); render(modal); ctx.rerender(); };

      const fracSel = box.querySelector('[name="fraction"]');
      fracSel.onchange = () => { entry.fraction = Number(fracSel.value); store.commit(); render(modal); ctx.rerender(); };

      const delBtn = box.querySelector('[data-del-entry]');
      if (delBtn) delBtn.onclick = () => {
        cellNow.entries.splice(idx, 1);
        store.commit(); render(modal); ctx.rerender();
      };
    });

    const addBtn = modal.querySelector('[data-add-entry]');
    if (addBtn) addBtn.onclick = () => {
      const e = newEntry();
      if (s.mode === 'senka') e.scope = s.senkaClasses[0]?.id ?? null;
      cellNow.entries.push(e);
      store.commit(); render(modal); ctx.rerender();
    };
  };

  openModal(`
    <h2>${esc(title)} の授業</h2>
    <div class="cell-editor-body"></div>
    <div class="modal-foot">
      <button class="btn danger left" data-clear-cell>コマをクリア</button>
      <button class="btn" data-swap title="このコマを別の場所へ移動・入替(タッチ操作対応)">⇄ 移動・入替</button>
      <button class="btn primary" data-close>閉じる</button>
    </div>
  `, (modal, close) => {
    render(modal);
    modal.querySelector('[data-close]').onclick = () => close();
    modal.querySelector('[data-swap]').onclick = () => {
      ctx.swapSource = { day: dayIdx, period: periodId };
      close(); // onClose(cleanup)が走った後にrerenderされる
    };
    modal.querySelector('[data-clear-cell]').onclick = () => {
      const w = store.getWeek(weekStart, true);
      delete w.cells[cellKey(dayIdx, periodId)];
      store.commit();
      close();
    };
  }, cleanup); // ← Esc・背景クリックを含む全ての閉じ方で空エントリを掃除する

  // 空のままのエントリは閉じるときに掃除する(冪等)
  function cleanup() {
    const w = store.state.weeks[weekStart];
    const key = cellKey(dayIdx, periodId);
    const c = w?.cells?.[key];
    if (c) {
      c.entries = c.entries.filter(e => e.subjectKey || (e.text && !e.auto) || e.note);
      if (!c.entries.length) delete w.cells[key];
    }
    // 週全体が空(コマ・行事・めあて・反省すべて無し)ならゴースト週ごと消す
    if (w && !Object.keys(w.cells).length && !w.goals && !w.reflection && !(w.events || []).some(Boolean)) {
      delete store.state.weeks[weekStart];
    }
    store.commit();
    ctx.rerender();
  }
}

function entryEditorHTML(state, entry, idx, period, ordinals) {
  const s = state.settings;
  const subj = subjectOf(s, entry.subjectKey);
  const resolved = resolveEntryText(state, entry, ordinals);
  const isModule = period?.type === 'module';
  const effAdvance = entry.advance == null ? !isModule : !!entry.advance;

  const palette = s.subjects.map(x =>
    `<button data-subj="${esc(x.key)}" class="${x.key === entry.subjectKey ? 'selected' : ''}"
       style="background:${esc(x.color)}">${esc(x.short || x.name)}</button>`).join('');

  let scopeField = '';
  if (s.mode === 'senka') {
    scopeField = `<div class="field"><label>学級</label>
      ${selectHTML('scope', s.senkaClasses.map(c => ({ value: c.id, label: c.label })), entry.scope ?? '', { allowEmpty: '(学級なし)' })}
    </div>`;
  }
  const isKnownGrade = typeof entry.scope === 'number' && s.fukushikiGrades.includes(entry.scope);
  const scopeTitle = s.mode === 'fukushiki'
    ? `<div style="font-weight:700; font-size:13.5px; margin-bottom:6px;">📘 ${isKnownGrade ? `${entry.scope}年` : '(学年未設定: 形態切替前の入力)'}</div>`
    : '';

  const autoBlock = entry.auto
    ? (resolved.info || resolved.text
        ? `<div class="auto-preview"><span class="label">年間指導計画から自動反映</span>${esc(resolved.text || '(計画未登録)')}</div>`
        : `<div class="auto-preview"><span class="label">自動反映</span>年間指導計画を登録すると、ここに単元・内容が自動で入ります</div>`)
    : '';

  return `
    <div data-entry="${idx}" style="border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:10px;">
      ${scopeTitle}
      <div class="field">
        <label>教科</label>
        <div class="subject-palette">${palette}</div>
      </div>
      ${scopeField}
      ${autoBlock}
      <div class="field">
        <label>内容(空欄なら自動反映${subj ? '' : ''}) ${!entry.auto ? '<button class="btn small ghost" data-reset-auto>↺ 自動に戻す</button>' : ''}</label>
        <textarea name="text" placeholder="${esc(resolved.auto && resolved.text ? resolved.text : '単元名・本時の内容(手動入力)')}">${entry.auto ? '' : esc(entry.text)}</textarea>
      </div>
      <div class="field">
        <label>備考(持ち物・場所・評価メモなど)</label>
        <input type="text" name="note" value="${esc(entry.note || '')}">
      </div>
      <div class="field" style="max-width:240px;">
        <label>時数の割合(分数時数)</label>
        <select name="fraction">
          <option value="1" ${(entry.fraction ?? 1) === 1 ? 'selected' : ''}>1(コマ全部)</option>
          <option value="0.6666666666666666" ${Math.abs((entry.fraction ?? 1) - 2 / 3) < 0.01 ? 'selected' : ''}>2/3</option>
          <option value="0.5" ${Math.abs((entry.fraction ?? 1) - 0.5) < 0.01 ? 'selected' : ''}>1/2</option>
          <option value="0.3333333333333333" ${Math.abs((entry.fraction ?? 1) - 1 / 3) < 0.01 ? 'selected' : ''}>1/3</option>
        </select>
      </div>
      <div class="checkline"><input type="checkbox" name="advance" id="adv-${idx}" ${effAdvance ? 'checked' : ''}>
        <label for="adv-${idx}">年間指導計画の進度を1コマ進める${isModule ? '(モジュールは既定でオフ)' : ''}</label></div>
      <div class="checkline"><input type="checkbox" name="noCount" id="nc-${idx}" ${entry.noCount ? 'checked' : ''}>
        <label for="nc-${idx}">時数集計に含めない(教育課程外の朝活動・テスト監督など)</label></div>
      <div class="checkline"><input type="checkbox" name="cancelled" id="cl-${idx}" ${entry.cancelled ? 'checked' : ''}>
        <label for="cl-${idx}">中止・未実施(学級閉鎖・行事変更など。時数・進度から除外)</label></div>
      ${state.settings.mode !== 'fukushiki' || !isKnownGrade ? `<button class="btn small danger" data-del-entry>この授業を削除</button>` : ''}
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
    <span class="hint" style="margin-left:8px;">詳細は「時数集計」タブへ</span>
  </div>`;
}
