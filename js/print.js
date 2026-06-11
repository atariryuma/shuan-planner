/**
 * 印刷モジュール。
 * 方針(リサーチ結果に基づく):
 *  - window.print() + 印刷専用DOM(#print-root)一本。PDF生成ライブラリは使わない
 *  - @page { size: A4 <向き>; margin: 0 } を動的に注入し、ブラウザのURL/日付ヘッダーを消す
 *  - 実余白は .print-page の padding で確保。高さはA4実寸-1mm(丸め誤差の白紙ページ防止)
 *  - 列幅は colgroup で mm 指定(table-layout: fixed と組で、画面と印刷のズレをなくす)
 */

import { store, cellKey, effectivePeriod, computeOrdinals, resolveEntryText, computeHours, computeMonthlyHours, doneRefWeek, fmtHours, scopeKey, standardHoursFor, termRanges } from './store.js';
import { parseDate, addDays, fmtMD, fmtDate, fmtYear, fmtFiscalYear, weekNumberInFiscalYear, fiscalYearOf, fiscalYearFirstMonday, DAY_NAMES, esc } from './utils.js';
import { holidayName } from './holidays.js';
import { openModal, toast, infoHTML } from './ui.js';
import { fracLabel, guideLabel } from './views/week.js';

const FONT_PT = { small: 8, normal: 9, large: 10.5 };

/**
 * アプリ内ボタンからの印刷中フラグ。
 * beforeprintハンドラ(Ctrl+P用の再構築)が、ダイアログで組み立てた
 * おたより・複数週DOMを上書きしないようにする。afterprintで解除。
 */
export const printState = { prepared: false };

/** iPad/iPhone判定(SafariはCSSの用紙向き指定が効かないため案内を出す) */
function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * 印刷オプションのモーダル。毎週変えるのは「期間」だけなので、
 * 書式(向き・レイアウト等)は折りたたみに収める。設定への保存は書式を変更した時のみ。
 */
export function openPrintDialog(ctx) {
  const s = store.settings;
  openModal(`
    <h2>印刷 / PDF保存</h2>
    <div class="field"><label>期間${infoHTML('「今月」以降は入力済みの週をまとめて1つの印刷/PDFにします(学期末の綴り提出用)')}</label>
      <select name="range">
        <option value="week">この週</option>
        <option value="month">今月</option>
        <option value="term">学期</option>
        <option value="year">年度(入力済みの全週)</option>
      </select></div>
    <details class="adv">
      <summary class="fold-label">書式(設定と共通)</summary>
      <div class="print-options" style="margin-top:8px;">
        <div class="field"><label>用紙の向き</label>
          <select name="orientation">
            <option value="landscape" ${s.printOrientation === 'landscape' ? 'selected' : ''}>A4 横(推奨)</option>
            <option value="portrait" ${s.printOrientation === 'portrait' ? 'selected' : ''}>A4 縦</option>
          </select></div>
        <div class="field"><label>レイアウト</label>
          <select name="layout">
            <option value="periods" ${s.printLayout === 'periods' ? 'selected' : ''}>縦=校時(週案簿型)</option>
            <option value="days" ${s.printLayout === 'days' ? 'selected' : ''}>縦=曜日(Excel型)</option>
          </select></div>
        <div class="field"><label>文字サイズ</label>
          <select name="fontSize">
            <option value="small" ${s.printFontSize === 'small' ? 'selected' : ''}>小</option>
            <option value="normal" ${s.printFontSize === 'normal' ? 'selected' : ''}>標準</option>
            <option value="large" ${s.printFontSize === 'large' ? 'selected' : ''}>大</option>
          </select></div>
        <div></div>
        <div class="checkline"><input type="checkbox" name="showTimes" id="po-times" ${s.printShowTimes ? 'checked' : ''}>
          <label for="po-times">校時の時刻</label></div>
        <div class="checkline"><input type="checkbox" name="showHours" id="po-hours" ${s.printShowHours ? 'checked' : ''}>
          <label for="po-hours">週の時数表</label></div>
      </div>
    </details>
    <p class="hint" style="margin-top:10px;">${isIOS()
      ? 'iPadでは共有→プリントで「横向き」を選んでください(Safariは向きの自動指定が効きません)'
      : 'Chrome / Edge 推奨・倍率100%。PDF保存は印刷画面で「PDFに保存」を選びます。'}</p>
    <div class="modal-foot">
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-print>印刷</button>
    </div>
  `, (modal, close) => {
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-print]').onclick = () => {
      // 書式detailsを開いて変更した時だけ設定へ保存(黙った恒久上書きを避ける)
      const adv = modal.querySelector('details.adv');
      if (adv.open) {
        s.printOrientation = modal.querySelector('[name="orientation"]').value;
        s.printLayout = modal.querySelector('[name="layout"]').value;
        s.printFontSize = modal.querySelector('[name="fontSize"]').value;
        s.printShowTimes = modal.querySelector('[name="showTimes"]').checked;
        s.printShowHours = modal.querySelector('[name="showHours"]').checked;
        store.commit();
      }
      close();
      printWeek(ctx.getWeekStart(), modal.querySelector('[name="range"]').value);
    };
  });
}

/** 児童向けおたよりを印刷する(書式固定: A4横・1週。⋯メニューから呼ばれる) */
export function printKidsLetter(weekStart) {
  if (store.settings.mode === 'senka') {
    toast('おたよりは学級担任・複式向けの様式です', 'error', 4500);
    return;
  }
  buildKidsPrintDOM(weekStart);
  printState.prepared = true;
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}

/** 期間からまとめ印刷の対象週リストを作る(入力のある週のみ。無ければ表示中の週) */
function weeksForRange(state, weekStart, range) {
  if (!range || range === 'week') return [weekStart];
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));
  const fyFrom = fmtDate(fiscalYearFirstMonday(fy));
  const fyTo = fmtDate(fiscalYearFirstMonday(fy + 1));
  let from = fyFrom, to = fyTo;
  if (range === 'month') {
    const m = parseDate(weekStart);
    const ym = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    const keys = Object.keys(state.weeks).sort().filter(k => k.startsWith(ym) && hasContent(state.weeks[k]));
    return keys.length ? keys : [weekStart];
  }
  if (range === 'term') {
    const term = termRanges(state.settings, fy).find(t => t.from <= weekStart && weekStart <= t.to);
    // toは排他的境界として使うため学期末日+1日にする(学期末が月曜の週の脱落を防ぐ)
    if (term) { from = term.from; to = fmtDate(addDays(parseDate(term.to), 1)); }
  }
  const keys = Object.keys(state.weeks).sort()
    .filter(k => k >= from && k < to && k >= fyFrom && k < fyTo && hasContent(state.weeks[k]));
  return keys.length ? keys : [weekStart];
}

function hasContent(w) {
  return w && (Object.keys(w.cells || {}).length || (w.events || []).some(Boolean) || w.goals || w.reflection);
}

/** 指定週(または期間)を印刷する */
export function printWeek(weekStart, range = 'week') {
  const result = buildPrintDOM(weekStart, { range });
  if (result.pages > 1) {
    toast(`${result.pages}週分をまとめて印刷します`, 'info', 3000);
  }
  if (result.shrunk) {
    toast('文字サイズを縮小しました', 'info', 3500);
  } else if (result.overflow) {
    // 文字サイズ「小」への変更は印刷設定から(教育文をトーストに書かずボタンで誘導)
    toast('内容が入りきらない可能性があります', 'error', 6000,
      { label: '印刷設定', onClick: () => openPrintDialog({ getWeekStart: () => weekStart }) });
  }
  printState.prepared = true;
  // DOM反映後に印刷(Chromeはstyle注入直後でも問題ないが、念のため次フレームで)
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}

/** #print-root に印刷専用DOMを構築し、@pageルールを注入。複数週は1ページ1週で連結 */
export function buildPrintDOM(weekStart, { range = 'week' } = {}) {
  const state = store.state;
  const s = state.settings;
  const landscape = s.printOrientation !== 'portrait';
  // A4実寸から1mm引く(丸め誤差による白紙2ページ目を防ぐ)
  const pageW = landscape ? 297 : 210;
  const pageH = (landscape ? 210 : 297) - 1;
  const pad = 8; // 実余白(プリンタ非印字領域3〜5mmより大きく)
  const innerW = pageW - pad * 2;
  const fontPt = FONT_PT[s.printFontSize] || 9;

  let styleEl = document.getElementById('print-page-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'print-page-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 0; }
    #print-root {
      --page-w: ${pageW}mm;
      --page-h: ${pageH}mm;
      --pfs: ${fontPt}pt;
    }
    #print-root .print-page { padding: ${pad}mm; }
  `;

  const weeks = weeksForRange(state, weekStart, range);
  const root = document.getElementById('print-root');
  root.innerHTML = weeks.map(wk => renderPrintPage(state, wk, { innerW })).join('');

  // あふれ検知: 収まらないページがあればフォントを段階的に縮小する(全ページ共通)。
  // 画面ではdisplay:noneでレイアウトされないため、画面外に一時表示して計測する。
  const setFont = (pt) => { styleEl.textContent = styleEl.textContent.replace(/--pfs:[^;]+;/, `--pfs: ${pt}pt;`); };
  const prevStyle = root.getAttribute('style') || '';
  root.setAttribute('style', 'display:block; position:fixed; left:-9999px; top:0;');
  let overflow = false, shrunk = false;
  try {
    const wraps = [...root.querySelectorAll('.pp-table-wrap')];
    const steps = [fontPt, 8, 7.2, 6.5];
    for (let i = 0; wraps.length && i < steps.length; i++) {
      setFont(steps[i]);
      // 強制リフロー後に全ページを計測
      overflow = wraps.some(w => w.scrollHeight > w.clientHeight + 2);
      if (!overflow) { shrunk = i > 0; break; }
    }
  } finally {
    root.setAttribute('style', prevStyle);
  }
  return { overflow, shrunk, pages: weeks.length };
}

// ---------------------------------------------------------------- ページ描画

function renderPrintPage(state, weekStart, { innerW }) {
  const s = state.settings;
  const monday = parseDate(weekStart);
  const week = store.getWeek(weekStart);
  const dayCount = s.saturday ? 6 : 5;
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);
  const lastDay = addDays(monday, dayCount - 1);

  // 肩書: 自由入力があれば最優先。なければ形態・学校種から自動
  const senkaSubjName = s.subjects.find(x => x.key === s.senkaSubject)?.name || '';
  const modeLabel = s.printRole
    ? esc(s.printRole)
    : s.mode === 'fukushiki'
      ? `${s.fukushikiGrades[0]}・${s.fukushikiGrades[1]}年${esc(s.className || '')}(複式)`
      : s.mode === 'senka'
        ? (s.schoolType === 'junior' ? `教科担任${senkaSubjName ? `(${esc(senkaSubjName)})` : ''}` : `${senkaSubjName ? esc(senkaSubjName) : ''}専科`)
        : `${s.grade}年${esc(s.className || '')}`;

  const stamps = (s.stampBoxes || []).length
    ? `<div class="pp-stamps">${s.stampBoxes.map(t => `<div class="stamp">${esc(t)}</div>`).join('')}</div>`
    : '';

  const header = `
    <div class="pp-header">
      <span class="pp-title">週指導計画</span>
      <span class="pp-range">${fmtYear(monday.getFullYear(), s.printEra)}${monday.getMonth() + 1}月${monday.getDate()}日〜${lastDay.getMonth() + 1}月${lastDay.getDate()}日</span>
      <span class="pp-weekno">第${weekNo}週</span>
      <div class="pp-school">
        ${esc(s.schoolName || '')} ${modeLabel}<br>
        ${esc(s.teacherName ? '氏名: ' + s.teacherName : '')}
      </div>
      ${stamps}
    </div>`;

  const table = s.printLayout === 'days'
    ? renderTableDays(state, week, monday, dayCount, ordinals, innerW)
    : renderTablePeriods(state, week, monday, dayCount, ordinals, innerW);

  const footer = renderFooter(state, week, weekStart);

  return `<div class="print-page">${header}<div class="pp-table-wrap">${table}</div>${footer}</div>`;
}

/** 縦=校時 × 横=曜日(週案簿型) */
function renderTablePeriods(state, week, monday, dayCount, ordinals, innerW) {
  const s = state.settings;
  const cornerW = 13;
  const dayW = (innerW - cornerW) / dayCount;
  const cols = `<colgroup><col style="width:${cornerW}mm">${Array.from({ length: dayCount }, () => `<col style="width:${dayW.toFixed(2)}mm">`).join('')}</colgroup>`;

  const head = `<tr><th style="width:${cornerW}mm"></th>${Array.from({ length: dayCount }, (_, d) => {
    const date = addDays(monday, d);
    const hol = s.showHolidays ? holidayName(date) : null;
    return `<th><span class="dow">${DAY_NAMES[d]}</span> <span class="date">${fmtMD(date)}</span>${hol ? `<span class="hol">${esc(hol)}</span>` : ''}</th>`;
  }).join('')}</tr>`;

  const eventsRow = `<tr class="pp-events"><td class="ph">行事</td>${Array.from({ length: dayCount }, (_, d) =>
    `<td>${esc(week.events?.[d] || '').replace(/\n/g, '<br>')}</td>`).join('')}</tr>`;

  // 出欠メモ行(設定でON時)
  const attendanceRow = s.showAttendance
    ? `<tr class="pp-events"><td class="ph">出欠</td>${Array.from({ length: dayCount }, (_, d) =>
      `<td>${esc(week.attendance?.[d] || '')}</td>`).join('')}</tr>`
    : '';

  const rows = s.periods.map(p => {
    const cells = Array.from({ length: dayCount }, (_, d) => renderPrintCell(state, week, d, p, ordinals)).join('');
    return `<tr>
      <td class="ph"><span class="p-label">${esc(p.label)}</span>
        ${s.printShowTimes && p.start ? `<span class="p-time">${esc(p.start)}<br>${esc(p.end || '')}</span>` : ''}</td>
      ${cells}</tr>`;
  }).join('');

  return `<table class="pp-grid">${cols}<thead>${head}</thead><tbody>${eventsRow}${attendanceRow}${rows}</tbody></table>`;
}

/** 縦=曜日 × 横=校時(Excel型)。右端に行事列 */
function renderTableDays(state, week, monday, dayCount, ordinals, innerW) {
  const s = state.settings;
  const cornerW = 14;
  const eventW = 34;
  const periodW = (innerW - cornerW - eventW) / s.periods.length;
  const cols = `<colgroup><col style="width:${cornerW}mm">${s.periods.map(() => `<col style="width:${periodW.toFixed(2)}mm">`).join('')}<col style="width:${eventW}mm"></colgroup>`;

  const head = `<tr><th></th>${s.periods.map(p =>
    `<th>${esc(p.label)}${s.printShowTimes && p.start ? `<br><span class="date">${esc(p.start)}</span>` : ''}</th>`).join('')}<th>行事・予定</th></tr>`;

  const rows = Array.from({ length: dayCount }, (_, d) => {
    const date = addDays(monday, d);
    const hol = s.showHolidays ? holidayName(date) : null;
    const cells = s.periods.map(p => renderPrintCell(state, week, d, p, ordinals)).join('');
    return `<tr>
      <td class="ph"><span class="p-label">${DAY_NAMES[d]}</span><span class="p-time">${fmtMD(date)}</span>${hol ? `<span class="hol">${esc(hol)}</span>` : ''}</td>
      ${cells}
      <td class="pcell" style="font-size: calc(var(--pfs) - 1pt);">${esc(week.events?.[d] || '').replace(/\n/g, '<br>')}${s.showAttendance && week.attendance?.[d] ? `<div style="color:#555;">出欠: ${esc(week.attendance[d])}</div>` : ''}</td>
    </tr>`;
  }).join('');

  return `<table class="pp-grid">${cols}<thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function renderPrintCell(state, week, dayIdx, period, ordinals) {
  const s = state.settings;
  if (!effectivePeriod(s, week, dayIdx, period)) return `<td class="pcell pcell-off"></td>`;
  const cell = week.cells?.[cellKey(dayIdx, period.id)];
  let entries = cell?.entries || [];
  if (!entries.length) return `<td class="pcell"></td>`;

  // 複式: 両学年が完全に同じ授業(合同)なら1段に統合して印刷
  let mergedLabel = '';
  if (s.mode === 'fukushiki' && entries.length === 2) {
    const [a, b] = entries;
    const ta = a.cancelled ? (a.cancelledText || '') : resolveEntryText(state, a, ordinals).text;
    const tb = b.cancelled ? (b.cancelledText || '') : resolveEntryText(state, b, ordinals).text;
    if (a.subjectKey && a.subjectKey === b.subjectKey && ta === tb
      && (a.note || '') === (b.note || '') && !!a.cancelled === !!b.cancelled
      && (a.guide || null) === (b.guide || null)) {
      entries = [a];
      mergedLabel = '合同';
    }
  }

  const inner = entries.map(e => {
    const subj = s.subjects.find(x => x.key === e.subjectKey);
    const resolved = resolveEntryText(state, e, ordinals);
    const text = e.cancelled ? (e.cancelledText || resolved.text) : resolved.text;
    const scopeLabel = mergedLabel || (e.scope != null && e.scope !== ''
      ? (s.mode === 'fukushiki' ? `${e.scope}年` : (s.senkaClasses.find(c => c.id === e.scope)?.label || ''))
      : '');
    const frac = (e.fraction ?? 1) !== 1 ? `(${fracLabel(e.fraction)})` : '';
    // 複式の指導形態: ◎直接 ○間接 △ガイド
    const guideMark = s.mode === 'fukushiki' && e.guide
      ? (e.guide === 'direct' ? '◎' : e.guide === 'indirect' ? '○' : '△') : '';
    const cancelled = e.cancelled ? 'text-decoration: line-through; color:#555;' : '';
    return `
      <div class="pp-entry" style="${cancelled}">
        <div class="e-line1">
          ${scopeLabel ? `<span class="e-scope">${esc(scopeLabel)}</span>` : ''}
          ${subj ? `<span class="e-subj" style="--subj-color:${esc(subj.color)}">${guideMark}${esc(subj.name)}${frac}</span>` : ''}
          ${e.cancelled ? `<span class="e-scope">中止</span>` : ''}
        </div>
        ${text ? `<div class="e-text">${esc(text)}</div>` : ''}
        ${e.note ? `<div class="e-note">※${esc(e.note)}</div>` : ''}
      </div>`;
  }).join('');
  return `<td class="pcell">${inner}</td>`;
}

function renderFooter(state, week, weekStart) {
  const s = state.settings;
  const boxes = [];
  boxes.push(`<div class="pp-box pp-goals"><span class="box-label">今週のめあて・重点</span>${esc(week.goals || '').replace(/\n/g, '<br>')}</div>`);
  boxes.push(`<div class="pp-box pp-reflection"><span class="box-label">反省・次週への課題</span>${esc(week.reflection || '').replace(/\n/g, '<br>')}</div>`);
  if (s.printManagerBox) {
    boxes.push(`<div class="pp-box pp-manager"><span class="box-label">指導・助言</span></div>`);
  }

  if (s.printShowHours) {
    const hours = computeHours(state, weekStart);
    const keys = new Set(s.subjects.map(x => x.key));
    const childrenOf = {};
    for (const subj of s.subjects) if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);

    /** 1スコープ分の {name, wk, tt} リスト(親教科へ合算) */
    const itemsFor = (scopesToSum) => {
      const items = [];
      for (const subj of s.subjects) {
        if (subj.parent && keys.has(subj.parent)) continue;
        let wk = 0, tt = 0;
        for (const k of [subj.key, ...(childrenOf[subj.key] || [])]) {
          for (const sc of scopesToSum) {
            const v = hours.get(scopeKey(k, sc));
            if (v) { wk += v.week; tt += v.total; }
          }
        }
        if (wk > 0 || tt > 0) items.push({ name: subj.short || subj.name, wk, tt });
      }
      return items;
    };
    /** 14列を超える分は時数の少ない順に「ほか」へ合算(5pt縮小は読めないため廃止) */
    const capCols = (items) => {
      if (items.length <= 14) return items;
      const sorted = [...items].sort((a, b) => b.tt - a.tt);
      const keep = new Set(sorted.slice(0, 13).map(i => i.name));
      const head = items.filter(i => keep.has(i.name));
      const rest = items.filter(i => !keep.has(i.name));
      head.push({ name: 'ほか', wk: rest.reduce((a, i) => a + i.wk, 0), tt: rest.reduce((a, i) => a + i.tt, 0) });
      return head;
    };

    if (s.mode === 'fukushiki') {
      // 学年ごとに別の行で出す(合算すると提出書類として誤りになる)。
      // 週案は週単位の提出物なので、他形態・メールと同じく学年ごとに「週」「計」の両方を出す。
      const perGrade = s.fukushikiGrades.map(g => ({ g, items: itemsFor([g]) }));
      const names = [];
      for (const pg of perGrade) for (const i of pg.items) if (!names.includes(i.name)) names.push(i.name);
      // 14列超過の「ほか」判定は全学年合算の週・累計で行う(列の取捨は両学年で揃える)
      const merged = names.map(n => ({
        name: n,
        wk: perGrade.reduce((a, pg) => a + (pg.items.find(i => i.name === n)?.wk || 0), 0),
        tt: perGrade.reduce((a, pg) => a + (pg.items.find(i => i.name === n)?.tt || 0), 0),
      }));
      const cols = capCols(merged).map(i => i.name);
      if (cols.length) {
        const headRow = cols.map(n => `<th>${esc(n)}</th>`).join('');
        const gradeRows = perGrade.map(pg => {
          const find = (n) => pg.items.find(i => i.name === n);
          const others = pg.items.filter(i => !cols.includes(i.name));
          const cellWk = (n) => n === 'ほか' ? fmtHours(others.reduce((a, i) => a + i.wk, 0)) : (find(n) ? fmtHours(find(n).wk) : '');
          const cellTt = (n) => n === 'ほか' ? fmtHours(others.reduce((a, i) => a + i.tt, 0)) : (find(n) ? fmtHours(find(n).tt) : '');
          return `<tr><th>${pg.g}年週</th>${cols.map(n => `<td>${cellWk(n)}</td>`).join('')}</tr>`
            + `<tr><th>${pg.g}年計</th>${cols.map(n => `<td>${cellTt(n)}</td>`).join('')}</tr>`;
        }).join('');
        boxes.push(`<div class="pp-box pp-hours">
          <table class="pp-hours-table">
            <tr><th style="width:10mm;"></th>${headRow}</tr>
            ${gradeRows}
          </table>
        </div>`);
      }
    } else {
      const scopesToSum = s.mode === 'senka' ? [...s.senkaClasses.map(c => c.id), null] : [null];
      const items = capCols(itemsFor(scopesToSum));
      if (items.length) {
        const headRow = items.map(i => `<th>${esc(i.name)}</th>`).join('');
        const weekRow = items.map(i => `<td>${fmtHours(i.wk)}</td>`).join('');
        const totalRow = items.map(i => `<td>${fmtHours(i.tt)}</td>`).join('');
        boxes.push(`<div class="pp-box pp-hours">
          <table class="pp-hours-table">
            <tr><th style="width:8mm;"></th>${headRow}</tr>
            <tr><th>週</th>${weekRow}</tr>
            <tr><th>計</th>${totalRow}</tr>
          </table>
        </div>`);
      }
    }
  }
  return `<div class="pp-footer">${boxes.join('')}</div>`;
}

// ---------------------------------------------------------------- 児童向け時間割おたより

/**
 * 児童・保護者向けの時間割おたより(A4横1枚)。
 * 教科名を大きく、進度・備考(教師用メモ)・押印欄・時数表は出さない。
 * 下部に「もちもの・れんらく」の手書きスペースを確保する。
 */
export function buildKidsPrintDOM(weekStart) {
  const state = store.state;
  const s = state.settings;
  const monday = parseDate(weekStart);
  const week = store.getWeek(weekStart);
  const dayCount = s.saturday ? 6 : 5;
  const lastDay = addDays(monday, dayCount - 1);

  let styleEl = document.getElementById('print-page-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'print-page-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    @page { size: A4 landscape; margin: 0; }
    #print-root { --page-w: 297mm; --page-h: 209mm; --pfs: 11pt; }
    #print-root .print-page { padding: 10mm; }
  `;

  const cornerW = 14;
  const dayW = (297 - 20 - cornerW) / dayCount;
  const cols = `<colgroup><col style="width:${cornerW}mm">${Array.from({ length: dayCount }, () => `<col style="width:${dayW.toFixed(2)}mm">`).join('')}</colgroup>`;

  const head = `<tr>${['<th></th>', ...Array.from({ length: dayCount }, (_, d) => {
    const date = addDays(monday, d);
    const hol = s.showHolidays ? holidayName(date) : null;
    return `<th><span class="kp-dow">${DAY_NAMES[d]}</span> <span class="kp-date">${fmtMD(date)}</span>${hol ? `<br><span class="kp-hol">${esc(hol)}</span>` : ''}</th>`;
  })].join('')}</tr>`;

  const eventsRow = `<tr><td class="kp-ph">よてい</td>${Array.from({ length: dayCount }, (_, d) =>
    `<td class="kp-event">${esc(week.events?.[d] || '').replace(/\n/g, '<br>')}</td>`).join('')}</tr>`;

  const rows = s.periods.map(p => {
    const cells = Array.from({ length: dayCount }, (_, d) => {
      if (!effectivePeriod(s, week, d, p)) return `<td class="kp-cell kp-off"></td>`;
      const cell = week.cells?.[cellKey(d, p.id)];
      let entries = (cell?.entries || []).filter(e => e.subjectKey && !e.cancelled);
      if (!entries.length) return `<td class="kp-cell"></td>`;
      // 複式: 両学年が同じ教科なら1段に統合。違う場合は学年ラベルを付けて区別
      let merged = false;
      if (s.mode === 'fukushiki' && entries.length === 2 && entries[0].subjectKey === entries[1].subjectKey) {
        entries = [entries[0]];
        merged = true;
      }
      // 備考(教師用メモ)は配付物に出さない(配慮事項等の流出防止)
      const inner = entries.map(e => {
        const subj = s.subjects.find(x => x.key === e.subjectKey);
        // 児童向けは読みやすい短い名前(正式名称はおたよりには硬すぎる)
        const kidsName = (subj?.name || '')
          .replace('特別の教科 ', '')
          .replace('総合的な学習の時間', '総合');
        const gradeLabel = s.mode === 'fukushiki' && !merged && typeof e.scope === 'number'
          ? `<div class="kp-grade">${e.scope}年</div>` : '';
        return `${gradeLabel}<div class="kp-subj">${esc(kidsName)}</div>`;
      }).join('<div class="kp-sep"></div>');
      return `<td class="kp-cell">${inner}</td>`;
    }).join('');
    return `<tr><td class="kp-ph">${esc(p.label)}</td>${cells}</tr>`;
  }).join('');

  const className = s.mode === 'fukushiki'
    ? `${s.fukushikiGrades[0]}・${s.fukushikiGrades[1]}年${esc(s.className || '')}`
    : `${s.grade}年${esc(s.className || '')}`;

  const root = document.getElementById('print-root');
  root.innerHTML = `
    <div class="print-page kp-page">
      <div class="kp-header">
        <span class="kp-title">${className} じかんわり</span>
        <span class="kp-range">${monday.getMonth() + 1}/${monday.getDate()} 〜 ${lastDay.getMonth() + 1}/${lastDay.getDate()}</span>
      </div>
      <div class="pp-table-wrap">
        <table class="pp-grid kp-grid">${cols}<thead>${head}</thead><tbody>${eventsRow}${rows}</tbody></table>
      </div>
      <div class="kp-bring">
        <span class="kp-bring-label">もちもの・れんらく</span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 時数集計の印刷

/**
 * 時数集計タブ用の印刷DOM(A4縦)。教科別の累計・標準・残りと月別内訳。
 * 時数集計タブを開いた状態のCtrl+P/印刷ボタンで使われる。
 */
export function buildStatsPrintDOM(weekStart) {
  const state = store.state;
  const s = state.settings;
  const hours = computeHours(state, weekStart);
  const monthly = computeMonthlyHours(state, weekStart);
  // 実施は表示中の週ではなく今日現在で数える(過去週からの印刷でも報告値が欠けない)
  const doneRef = doneRefWeek(weekStart);
  const hoursDone = computeHours(state, doneRef);
  const monthlyDone = computeMonthlyHours(state, doneRef);
  const weekNo = weekNumberInFiscalYear(parseDate(weekStart));
  const MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

  let styleEl = document.getElementById('print-page-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'print-page-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    @page { size: A4 portrait; margin: 0; }
    #print-root { --page-w: 210mm; --page-h: 296mm; --pfs: 9pt; }
    #print-root .print-page { padding: 12mm; height: auto; min-height: 200mm; overflow: visible; break-after: auto; }
  `;

  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);

  const scopes = s.mode === 'fukushiki'
    ? s.fukushikiGrades.map(g => ({ scope: g, label: `${g}年`, grade: g }))
    : s.mode === 'senka'
      ? [...s.senkaClasses.map(c => ({ scope: c.id, label: c.label, grade: c.grade })), { scope: null, label: '(学級指定なし)', grade: s.grade }]
      : [{ scope: null, label: '', grade: s.grade }];

  const sections = scopes.map(sc => {
    const get = (map, subjKey) => {
      if (!map) return 0;
      let v = map.get(scopeKey(subjKey, sc.scope)) || 0;
      for (const ck of childrenOf[subjKey] || []) v += map.get(scopeKey(ck, sc.scope)) || 0;
      return v;
    };
    // 計画(入力済み)と実施(今日以前)を行で分けて出す — 実施時数の報告にそのまま使えるように
    const rows = [];
    for (const subj of s.subjects) {
      if (subj.parent && keys.has(subj.parent)) continue;
      let tt = 0, dd = 0;
      for (const k of [subj.key, ...(childrenOf[subj.key] || [])]) {
        const v = hours.get(scopeKey(k, sc.scope));
        if (v) tt += v.total;
        dd += hoursDone.get(scopeKey(k, sc.scope))?.done || 0;
      }
      if (!tt && !dd) continue;
      const std = standardHoursFor(s, subj.key, sc.grade);
      const planCells = MONTHS.map(m => {
        const v = get(monthly.months.get(m), subj.key);
        return `<td>${v ? fmtHours(v) : ''}</td>`;
      }).join('');
      const doneCells = MONTHS.map(m => {
        const v = get(monthlyDone.monthsDone.get(m), subj.key);
        return `<td>${v ? fmtHours(v) : ''}</td>`;
      }).join('');
      rows.push(`<tr>
        <td rowspan="2" style="text-align:left; font-weight:600;">${esc(subj.name)}</td>
        <td class="ps-kind">計画</td>
        ${planCells}
        <td><b>${fmtHours(tt)}</b></td>
        <td rowspan="2">${std ?? ''}</td>
        <td rowspan="2">${std != null ? fmtHours(std - tt) : ''}</td>
      </tr>
      <tr>
        <td class="ps-kind">実施</td>
        ${doneCells}
        <td><b>${fmtHours(dd)}</b></td>
      </tr>`);
    }
    if (!rows.length) return '';
    return `
      ${sc.label ? `<h3 class="ps-h3">${esc(sc.label)}</h3>` : ''}
      <table class="ps-table">
        <thead><tr><th style="width:22mm;">教科</th><th style="width:8mm;">区分</th>${MONTHS.map(m => `<th>${m}月</th>`).join('')}
          <th>計</th><th>標準</th><th>残り</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>`;
  }).filter(Boolean).join('');

  // 見出しの年度は閲覧中の週から導出する(settings.fiscalYearは常に現在年度のため、
  // 4月以降に前年度の集計を印刷するとデータと年度ラベルが食い違う)
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));
  const root = document.getElementById('print-root');
  root.innerHTML = `
    <div class="print-page">
      <div class="pp-header" style="margin-bottom:4mm;">
        <span class="pp-title">授業時数集計</span>
        <span class="pp-range">${fmtFiscalYear(fy, s.printEra)} 第${weekNo}週(${fmtMD(parseDate(weekStart))})まで
          <span style="font-size:8pt;">/ 実施は${fmtMD(new Date())}現在</span></span>
        <div class="pp-school">${esc(s.schoolName || '')} ${esc(s.teacherName || '')}</div>
      </div>
      ${sections || '<p>データがありません</p>'}
    </div>`;
}
