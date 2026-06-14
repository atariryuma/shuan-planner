/**
 * 印刷モジュール。
 * 方針(リサーチ結果に基づく):
 *  - window.print() + 印刷専用DOM(#print-root)一本。PDF生成ライブラリは使わない
 *  - @page { size: A4 <向き>; margin: 0 } を動的に注入し、ブラウザのURL/日付ヘッダーを消す
 *  - 実余白は .print-page の padding で確保。高さはA4実寸-1mm(丸め誤差の白紙ページ防止)
 *  - 列幅は colgroup で mm 指定(table-layout: fixed と組で、画面と印刷のズレをなくす)
 */

import { store, cellKey, effectivePeriod, computeOrdinals, resolveEntryPlanDetails, computeHours, computeMonthlyHours, doneRefWeek, fmtHours, scopeKey, standardHoursFor, weekDayOffsets, noSchoolReason, termRanges, isActivity } from './store.js';
import { parseDate, addDays, fmtMD, fmtDate, fmtYear, fmtFiscalYear, weekNumberInFiscalYear, fiscalYearOf, fiscalYearFirstMonday, DAY_NAMES, esc } from './utils.js';
import { holidayName } from './holidays.js';
import { openModal, toast, infoHTML } from './ui.js';
import { fracLabel, guideLabel } from './views/week.js';
import { buildPrintHoursModel, printHoursValue } from './print-hours.js';

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
 * 印刷オプションのモーダル。期間は最上段。書式(向き・レイアウト等)は既定で開いて
 * すぐ見えるようにする(折りたためる)。設定への保存は書式を変更した時のみ。
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
    <details class="adv" open>
      <summary class="fold-label">書式(設定と共通)</summary>
      <div class="print-options" style="margin-top:8px;">
        <div class="field"><label>用紙の向き</label>
          <select name="orientation">
            <option value="portrait" ${s.printOrientation === 'portrait' ? 'selected' : ''}>A4 縦(標準)</option>
            <option value="landscape" ${s.printOrientation === 'landscape' ? 'selected' : ''}>A4 横(ワイド)</option>
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
        <div class="checkline"><input type="checkbox" name="showPlanDetails" id="po-details" ${s.printShowPlanDetails ? 'checked' : ''}>
          <label for="po-details">指導計画詳細を添付</label></div>
      </div>
    </details>
    <p class="hint" style="margin-top:10px;">${isIOS()
      ? `iPadでは共有→プリントで「${s.printOrientation === 'portrait' ? '縦向き' : '横向き'}」を選んでください(Safariは向きの自動指定が効きません)`
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
        s.printShowPlanDetails = modal.querySelector('[name="showPlanDetails"]').checked;
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
  if (result.weeks > 1 || result.pages > result.weeks) {
    toast(`${result.weeks}週分・全${result.pages}ページを印刷します`, 'info', 3000);
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
  root.classList.toggle('print-portrait', !landscape);
  const pageHTML = weeks.flatMap(wk => {
    const pages = [renderPrintPage(state, wk, { innerW })];
    if (s.printShowPlanDetails) pages.push(...renderPlanDetailPages(state, wk));
    return pages;
  });
  root.innerHTML = pageHTML.join('');

  // あふれ検知: 収まらないページがあればフォントを段階的に縮小する(全ページ共通)。
  // 画面ではdisplay:noneでレイアウトされないため、画面外に一時表示して計測する。
  const setFont = (pt) => { styleEl.textContent = styleEl.textContent.replace(/--pfs:[^;]+;/, `--pfs: ${pt}pt;`); };
  const prevStyle = root.getAttribute('style') || '';
  root.setAttribute('style', 'display:block; position:fixed; left:-9999px; top:0;');
  let overflow = false, shrunk = false;
  try {
    // 授業表・時数表に加え、めあて/反省/指導助言の記録欄も対象にする。
    // これらは max-height + overflow:hidden で、はみ出すと「無言で文字が切れる」事故になるため、
    // あふれ検知に含めてフォント縮小→それでも入らなければ警告トーストを出す。
    const constrained = [...root.querySelectorAll('.pp-table-wrap, .pp-hours, .pp-goals, .pp-reflection, .pp-manager')];
    const pages = [...root.querySelectorAll('.print-page')];
    const steps = [fontPt, 8, 7.2, 6.5];
    for (let i = 0; pages.length && i < steps.length; i++) {
      setFont(steps[i]);
      // 授業表の切れと、フッターを含むページ全体の切れを両方検知する。
      overflow = constrained.some(box =>
        box.scrollHeight > box.clientHeight + 2 || box.scrollWidth > box.clientWidth + 2)
        || pages.some(page =>
          page.scrollHeight > page.clientHeight + 2 || page.scrollWidth > page.clientWidth + 2);
      if (!overflow) { shrunk = i > 0; break; }
    }
  } finally {
    root.setAttribute('style', prevStyle);
  }
  return { overflow, shrunk, pages: pageHTML.length, weeks: weeks.length };
}

// ---------------------------------------------------------------- ページ描画

function renderPrintPage(state, weekStart, { innerW }) {
  const s = state.settings;
  const monday = parseDate(weekStart);
  const week = store.getWeek(weekStart);
  const days = weekDayOffsets(s, week, monday); // 月〜金＋必要なら土/日(その週に授業・行事のある土日)
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);
  const lastDay = addDays(monday, days[days.length - 1]);

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
      <span class="pp-title">${esc(s.printTitle || '週案')}</span>
      <span class="pp-range">${fmtYear(monday.getFullYear(), s.printEra)}${monday.getMonth() + 1}月${monday.getDate()}日〜${lastDay.getMonth() + 1}月${lastDay.getDate()}日</span>
      <span class="pp-weekno">第${weekNo}週</span>
      <div class="pp-school">
        ${esc(s.schoolName || '')} ${modeLabel}${(() => { const cf = printClassFilter(s); const lb = cf ? (s.senkaClasses.find(c => c.id === cf)?.label || '') : ''; return lb ? ` ${esc(lb)}` : ''; })()}<br>
        ${esc(s.teacherName ? '氏名: ' + s.teacherName : '')}
      </div>
      ${stamps}
    </div>`;

  const table = s.printLayout === 'days'
    ? renderTableDays(state, week, monday, days, ordinals, innerW)
    : renderTablePeriods(state, week, monday, days, ordinals, innerW);

  const footer = renderFooter(state, week, weekStart);

  return `<div class="print-page">${header}<div class="pp-table-wrap">${table}</div>${footer}</div>`;
}

/** 縦=校時 × 横=曜日(週案簿型) */
function renderTablePeriods(state, week, monday, days, ordinals, innerW) {
  const s = state.settings;
  const cornerW = 13;
  const dayW = (innerW - cornerW) / days.length;
  const cols = `<colgroup><col style="width:${cornerW}mm">${days.map(() => `<col style="width:${dayW.toFixed(2)}mm">`).join('')}</colgroup>`;

  const head = `<tr><th style="width:${cornerW}mm"></th>${days.map(d => {
    const date = addDays(monday, d);
    const ds = fmtDate(date);
    const reason = noSchoolReason(s, ds);           // 振替授業日はnull(授業日)
    const hol = s.showHolidays && reason ? holidayName(date) : null;
    const makeup = (s.classDays || []).includes(ds) && (holidayName(date) || ((d === 5 || d === 6))); // 本来休みを授業日に
    return `<th><span class="dow">${DAY_NAMES[d]}</span> <span class="date">${fmtMD(date)}</span>${hol ? `<span class="hol">${esc(hol)}</span>` : makeup ? `<span class="hol" style="background:#dcfce7;color:#15803d;">授業日</span>` : ''}</th>`;
  }).join('')}</tr>`;

  const eventsRow = `<tr class="pp-events"><td class="ph">行事</td>${days.map(d =>
    `<td>${esc(week.events?.[d] || '').replace(/\n/g, '<br>')}</td>`).join('')}</tr>`;

  // 出欠メモ行(設定でON時)
  const attendanceRow = s.showAttendance
    ? `<tr class="pp-events"><td class="ph">出欠</td>${days.map(d =>
      `<td>${esc(week.attendance?.[d] || '')}</td>`).join('')}</tr>`
    : '';

  const rows = s.periods.map(p => {
    const cells = days.map(d => renderPrintCell(state, week, d, p, ordinals)).join('');
    return `<tr>
      <td class="ph"><span class="p-label">${esc(p.label)}</span>
        ${s.printShowTimes && p.start ? `<span class="p-time">${esc(p.start)}<br>${esc(p.end || '')}</span>` : ''}</td>
      ${cells}</tr>`;
  }).join('');

  return `<table class="pp-grid">${cols}<thead>${head}</thead><tbody>${eventsRow}${attendanceRow}${rows}</tbody></table>`;
}

/** 縦=曜日 × 横=校時(Excel型)。右端に行事列 */
function renderTableDays(state, week, monday, days, ordinals, innerW) {
  const s = state.settings;
  const cornerW = 14;
  const eventW = 34;
  const periodW = (innerW - cornerW - eventW) / s.periods.length;
  const cols = `<colgroup><col style="width:${cornerW}mm">${s.periods.map(() => `<col style="width:${periodW.toFixed(2)}mm">`).join('')}<col style="width:${eventW}mm"></colgroup>`;

  const head = `<tr><th></th>${s.periods.map(p =>
    `<th>${esc(p.label)}${s.printShowTimes && p.start ? `<br><span class="date">${esc(p.start)}</span>` : ''}</th>`).join('')}<th>行事・予定</th></tr>`;

  const rows = days.map(d => {
    const date = addDays(monday, d);
    const hol = s.showHolidays && noSchoolReason(s, fmtDate(date)) ? holidayName(date) : null;
    const cells = s.periods.map(p => renderPrintCell(state, week, d, p, ordinals)).join('');
    return `<tr>
      <td class="ph"><span class="p-label">${DAY_NAMES[d]}</span><span class="p-time">${fmtMD(date)}</span>${hol ? `<span class="hol">${esc(hol)}</span>` : ''}</td>
      ${cells}
      <td class="pcell" style="font-size: calc(var(--pfs) - 1pt);">${esc(week.events?.[d] || '').replace(/\n/g, '<br>')}${s.showAttendance && week.attendance?.[d] ? `<div style="color:#555;">出欠: ${esc(week.attendance[d])}</div>` : ''}</td>
    </tr>`;
  }).join('');

  return `<table class="pp-grid">${cols}<thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/** 専科の学級フィルタ(週ビューで選んだ学級)。印刷も同じ学級に絞り、学級別の週案を出す。
 *  担当に無い学級IDは無視。専科以外・未選択は '' を返す(全学級印刷)。 */
function printClassFilter(s) {
  if (s.mode !== 'senka') return '';
  try {
    const f = localStorage.getItem('shuan-class-filter') || '';
    return (s.senkaClasses || []).some(c => c.id === f) ? f : '';
  } catch { return ''; }
}

function renderPrintCell(state, week, dayIdx, period, ordinals) {
  const s = state.settings;
  if (!effectivePeriod(s, week, dayIdx, period)) return `<td class="pcell pcell-off"></td>`;
  const cell = week.cells?.[cellKey(dayIdx, period.id)];
  let entries = cell?.entries || [];
  const cf = printClassFilter(s);
  if (cf) entries = entries.filter(e => (e.scope ?? '') === cf); // 学級別印刷: 対象学級のコマだけ
  if (!entries.length) return `<td class="pcell"></td>`;

  // 複式: 両学年が完全に同じ授業(合同)なら1段に統合して印刷
  let mergedLabel = '';
  if (s.mode === 'fukushiki' && entries.length === 2) {
    const [a, b] = entries;
    const pa = resolveEntryPlanDetails(state, a, ordinals);
    const pb = resolveEntryPlanDetails(state, b, ordinals);
    const ta = a.cancelled ? (a.cancelledText || '') : pa.resolved.text;
    const tb = b.cancelled ? (b.cancelledText || '') : pb.resolved.text;
    const detailKey = detail => detail
      ? `${detail.activity}\u0000${detail.assessment}\u0000${detail.viewpoint}`
      : '';
    if (a.subjectKey && a.subjectKey === b.subjectKey && ta === tb
      && detailKey(pa.details) === detailKey(pb.details)
      && (a.note || '') === (b.note || '') && !!a.cancelled === !!b.cancelled
      && (a.guide || null) === (b.guide || null)) {
      entries = [a];
      mergedLabel = '合同';
    }
  }

  const inner = entries.map(e => {
    const subj = s.subjects.find(x => x.key === e.subjectKey);
    const { resolved, details } = resolveEntryPlanDetails(state, e, ordinals);
    // 活動(会議等)は見出し未入力でも空白にせず「予定」を出す(画面グリッドと統一)
    const text = e.cancelled ? (e.cancelledText || resolved.text) : (resolved.text || (isActivity(e) ? '予定' : ''));
    const scopeLabel = mergedLabel || (e.scope != null && e.scope !== ''
      ? (s.mode === 'fukushiki' ? `${e.scope}年` : (s.senkaClasses.find(c => c.id === e.scope)?.label || ''))
      : '');
    const frac = (e.fraction ?? 1) !== 1 ? `(${fracLabel(e.fraction)})` : '';
    // 複式の指導形態: ◎直接 ○間接 △ガイド
    const guideMark = s.mode === 'fukushiki' && e.guide
      ? (e.guide === 'direct' ? '◎' : e.guide === 'indirect' ? '○' : '△') : '';
    const cancelled = e.cancelled ? 'text-decoration: line-through; color:#555;' : '';
    const activity = compactPrintText(details?.activity || '');
    const assessment = compactPrintText(details?.assessment || '');
    return `
      <div class="pp-entry ${isActivity(e) ? 'pp-activity' : ''}" style="${cancelled}">
        <div class="e-line1">
          ${scopeLabel ? `<span class="e-scope">${esc(scopeLabel)}</span>` : ''}
          ${subj ? `<span class="e-subj" style="--subj-color:${esc(subj.color)}">${guideMark}${esc(subj.name)}${frac}</span>` : ''}
          ${e.cancelled ? `<span class="e-scope">中止</span>` : ''}
        </div>
        ${text ? `<div class="e-text">${esc(text)}</div>` : ''}
        ${!e.cancelled && activity ? `<div class="e-plan"><span class="e-plan-label">活</span><span class="e-plan-text">${esc(activity)}</span></div>` : ''}
        ${!e.cancelled && (assessment || details?.viewpoint) ? `<div class="e-plan e-eval"><span class="e-plan-label">評${details.viewpoint ? `・${esc(details.viewpoint)}` : ''}</span><span class="e-plan-text">${esc(assessment)}</span></div>` : ''}
        ${e.note ? `<div class="e-note">※${esc(e.note)}</div>` : ''}
      </div>`;
  }).join('');
  return `<td class="pcell">${inner}</td>`;
}

function compactPrintText(text, maxLength = 34) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function printScopeLabel(settings, scope) {
  if (scope == null || scope === '') return '';
  if (settings.mode === 'fukushiki') return `${scope}年`;
  if (settings.mode === 'senka') return settings.senkaClasses.find(c => c.id === scope)?.label || '学級未設定';
  return '';
}

/** その週に配置された授業を、単元ごとの全項目を持つ印刷行へ変換する。 */
export function buildWeekPlanDetailModel(state, weekStart) {
  const s = state.settings;
  const week = state.weeks[weekStart] || { cells: {} };
  const ordinals = computeOrdinals(state, weekStart);
  const monday = parseDate(weekStart);
  const days = weekDayOffsets(s, week, monday); // 土日の授業も指導計画詳細に含める
  const groups = new Map();

  for (const day of days) {
    for (const period of s.periods) {
      if (!effectivePeriod(s, week, day, period)) continue;
      const entries = week.cells?.[cellKey(day, period.id)]?.entries || [];
      for (const entry of entries) {
        const { details } = resolveEntryPlanDetails(state, entry, ordinals);
        if (!details) continue;
        const subject = s.subjects.find(x => x.key === entry.subjectKey);
        const scope = printScopeLabel(s, entry.scope) || (details.grade ? `${details.grade}年` : '');
        const key = `${details.planId || entry.subjectKey}|${details.unitId}`;
        if (!groups.has(key)) {
          groups.set(key, {
            subject: subject?.name || entry.subjectKey,
            scopes: [],
            textbook: details.textbook,
            unitName: details.unitName,
            unitHours: details.unitHours,
            unitGoal: details.unitGoal,
            unitCriteria: details.unitCriteria,
            lessons: [],
          });
        }
        if (scope && !groups.get(key).scopes.includes(scope)) groups.get(key).scopes.push(scope);
        groups.get(key).lessons.push({
          scope,
          date: fmtMD(addDays(monday, day)),
          day: DAY_NAMES[day],
          period: period.type === 'module' ? period.label : `${period.label}校時`,
          cancelled: Boolean(entry.cancelled),
          nth: details.nth,
          objective: details.objective,
          activity: details.activity,
          assessment: details.assessment,
          viewpoint: details.viewpoint,
          viewpointLabel: details.viewpointLabel,
          manualText: details.manualText,
          note: entry.note || '',
        });
      }
    }
  }
  return [...groups.values()];
}

export function splitDetailLessons(lessons, overviewChars = 0) {
  const chunks = [];
  let chunk = [];
  let weight = 0;
  // 実PDFでは単元概要+3行で紙面使用率約34%。中程度の行なら8行前後まで収められる。
  // 単元概要が長い場合だけ上限を下げ、余白の浪費と過密の両方を避ける。
  const maxWeight = Math.max(10, 16 - Math.ceil(overviewChars / 350));
  for (const lesson of lessons) {
    const chars = lesson.objective.length + lesson.activity.length + lesson.assessment.length + lesson.note.length;
    const itemWeight = Math.max(1, Math.ceil(chars / 150));
    if (chunk.length && weight + itemWeight > maxWeight) {
      chunks.push(chunk);
      chunk = [];
      weight = 0;
    }
    chunk.push(lesson);
    weight += itemWeight;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function renderUnitOverview(group, continuation) {
  const criteria = [
    ['知識・技能', group.unitCriteria.knowledge],
    ['思考・判断・表現', group.unitCriteria.thinking],
    ['主体的に学習に取り組む態度', group.unitCriteria.attitude],
  ];
  return `<section class="pd-unit">
    <h2>${esc(group.subject)}　${esc(group.unitName)}
      <span>${group.unitHours}時間${group.textbook ? ` / ${esc(group.textbook)}` : ''}${continuation ? ' / 続き' : ''}</span></h2>
    ${group.scopes.length ? `<div class="pd-target"><b>対象</b>${group.scopes.map(esc).join('・')}</div>` : ''}
    ${group.unitGoal ? `<div class="pd-goal"><b>単元の目標</b><span>${esc(group.unitGoal)}</span></div>` : ''}
    <table class="pd-criteria"><tbody>${criteria.map(([label, value]) =>
      `<tr><th>${label}</th><td>${esc(value || '—')}</td></tr>`).join('')}</tbody></table>
  </section>`;
}

function renderDetailLessonTable(lessons) {
  return `<table class="pd-lessons">
    <thead><tr><th class="pd-class">学級</th><th class="pd-when">日時</th><th class="pd-num">時</th><th>指導目標（本時のねらい）</th><th>学習活動</th><th>評価規準・観点</th></tr></thead>
    <tbody>${lessons.map(lesson => `<tr class="${lesson.cancelled ? 'pd-cancelled' : ''}">
      <td>${esc(lesson.scope || '—')}</td>
      <td>${lesson.date}(${lesson.day})<br>${esc(lesson.period)}${lesson.cancelled ? '<br><b>中止</b>' : ''}</td>
      <td>${lesson.nth}</td>
      <td>${esc(lesson.objective || '—')}${lesson.manualText ? `<div class="pd-manual">週案記載: ${esc(lesson.manualText)}</div>` : ''}</td>
      <td>${esc(lesson.activity || '—')}</td>
      <td>${lesson.viewpoint ? `<span class="pd-vp">${esc(lesson.viewpoint)} ${esc(lesson.viewpointLabel)}</span>` : ''}${esc(lesson.assessment || '—')}${lesson.note ? `<div class="pd-note">備考: ${esc(lesson.note)}</div>` : ''}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

/** 週案本紙を崩さず、年間指導計画の全項目を単元別の補足ページへ出す。 */
export function renderPlanDetailPages(state, weekStart) {
  const groups = buildWeekPlanDetailModel(state, weekStart);
  if (!groups.length) return [];
  const monday = parseDate(weekStart);
  const lastDay = addDays(monday, state.settings.saturday ? 5 : 4);
  const pageData = [];
  for (const group of groups) {
    const overviewChars = group.unitGoal.length
      + Object.values(group.unitCriteria).reduce((sum, value) => sum + value.length, 0);
    splitDetailLessons(group.lessons, overviewChars).forEach((lessons, index) => {
      pageData.push({ group, lessons, continuation: index > 0 });
    });
  }
  return pageData.map(({ group, lessons, continuation }, index) =>
    `<div class="print-page pp-detail-page">
        <header class="pd-header">
          <div><span class="pd-title">今週の指導計画詳細</span><span class="pd-range">${fmtMD(monday)}〜${fmtMD(lastDay)}</span></div>
          <div class="pd-header-meta"><span>${esc(state.settings.schoolName || '')}　${esc(state.settings.teacherName || '')}</span><b>詳細 ${index + 1}/${pageData.length}</b></div>
        </header>
        ${renderUnitOverview(group, continuation)}
        ${renderDetailLessonTable(lessons)}
      </div>`);
}

function renderFooter(state, week, weekStart) {
  const s = state.settings;
  const noteBoxes = [];
  noteBoxes.push(`<div class="pp-box pp-goals"><span class="box-label">今週のめあて・重点</span>${esc(week.goals || '').replace(/\n/g, '<br>')}</div>`);
  noteBoxes.push(`<div class="pp-box pp-reflection"><span class="box-label">反省・次週への課題</span>${esc(week.reflection || '').replace(/\n/g, '<br>')}</div>`);
  if (s.printManagerBox) {
    noteBoxes.push(`<div class="pp-box pp-manager"><span class="box-label">指導・助言</span>${esc(week.managerNote || '').replace(/\n/g, '<br>')}</div>`);
  }

  let hoursBox = '';
  if (s.printShowHours) {
    hoursBox = renderWeeklyHoursBox(state, weekStart);
  }
  return `<div class="pp-footer">
    <div class="pp-notes-row">${noteBoxes.join('')}</div>
    ${hoursBox}
  </div>`;
}

function renderSubjectHoursTable(items, label = '') {
  if (!items.length) return '';
  const head = items.map(item => `<th>${esc(item.label)}</th>`).join('');
  const row = (title, field) => `<tr><th>${title}</th>${items.map(item =>
    `<td>${printHoursValue(item, field)}</td>`).join('')}</tr>`;
  return `<div class="pp-hours-section">
    ${label ? `<div class="pp-hours-caption">${esc(label)}</div>` : ''}
    <table class="pp-hours-table">
      <thead><tr><th class="pp-hours-corner">時数</th>${head}</tr></thead>
      <tbody>
        ${row('本週', 'week')}
        ${row('累計', 'total')}
        ${row('標準', 'standard')}
        ${row('残り', 'remain')}
        ${row('進捗', 'progress')}
      </tbody>
    </table>
  </div>`;
}

function renderSenkaHoursTable(rows) {
  if (!rows.length) return '';
  const table = (part) => {
    const body = part.map(row => `<tr>
      <td class="${row.classLabel === '学級未設定' ? 'pp-hours-warn' : ''}">${esc(row.classLabel)}</td>
      <td>${esc(row.subjectLabel)}</td>
      <td>${printHoursValue(row, 'week')}</td>
      <td>${printHoursValue(row, 'total')}</td>
      <td>${printHoursValue(row, 'standard')}</td>
      <td>${printHoursValue(row, 'remain')}</td>
      <td>${printHoursValue(row, 'progress')}</td>
    </tr>`).join('');
    return `<table class="pp-hours-table pp-senka-hours">
      <thead><tr><th>学級</th><th>教科</th><th>本週</th><th>累計</th><th>標準</th><th>残り</th><th>進捗</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  };
  if (rows.length <= 8) return `<div class="pp-senka-grid">${table(rows)}</div>`;
  const split = Math.ceil(rows.length / 2);
  return `<div class="pp-senka-grid two-column">${table(rows.slice(0, split))}${table(rows.slice(split))}</div>`;
}

/** 役割ごとに正しい軸で時数表を組み立てる。 */
export function renderWeeklyHoursBox(state, weekStart) {
  const model = buildPrintHoursModel(state, weekStart, { maxSubjects: 14 });
  let content = '';
  if (model.kind === 'homeroom') {
    content = renderSubjectHoursTable(model.items);
  } else if (model.kind === 'fukushiki') {
    content = `<div class="pp-fukushiki-hours">${model.grades.map(group =>
      renderSubjectHoursTable(group.items, `${group.grade}年`)).join('')}</div>`;
  } else {
    content = renderSenkaHoursTable(model.rows);
  }
  return content ? `<div class="pp-box pp-hours">${content}</div>` : '';
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
  const days = weekDayOffsets(s, week, monday); // 土日に授業・行事のある週は土/日列も出す
  const lastDay = addDays(monday, days[days.length - 1]);

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
  const dayW = (297 - 20 - cornerW) / days.length;
  const cols = `<colgroup><col style="width:${cornerW}mm">${days.map(() => `<col style="width:${dayW.toFixed(2)}mm">`).join('')}</colgroup>`;

  const head = `<tr>${['<th></th>', ...days.map(d => {
    const date = addDays(monday, d);
    const hol = s.showHolidays && noSchoolReason(s, fmtDate(date)) ? holidayName(date) : null;
    return `<th><span class="kp-dow">${DAY_NAMES[d]}</span> <span class="kp-date">${fmtMD(date)}</span>${hol ? `<br><span class="kp-hol">${esc(hol)}</span>` : ''}</th>`;
  })].join('')}</tr>`;

  const eventsRow = `<tr><td class="kp-ph">よてい</td>${days.map(d =>
    `<td class="kp-event">${esc(week.events?.[d] || '').replace(/\n/g, '<br>')}</td>`).join('')}</tr>`;

  const rows = s.periods.map(p => {
    const cells = days.map(d => {
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
  root.classList.remove('print-portrait');
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

  // 学級横断サマリー(複数学級のときだけ。提出時に全学級の進捗を1枚で確認できる)
  let summaryTable = '';
  if (scopes.length >= 2) {
    let sumDone = 0, sumTotal = 0, sumStd = 0;
    const srows = [];
    for (const sc of scopes) {
      let done = 0, total = 0, std = 0;
      for (const subj of s.subjects) {
        if (subj.parent && keys.has(subj.parent)) continue;
        let t = 0, d = 0;
        for (const k of [subj.key, ...(childrenOf[subj.key] || [])]) {
          const v = hours.get(scopeKey(k, sc.scope));
          if (v) t += v.total;
          d += hoursDone.get(scopeKey(k, sc.scope))?.done || 0;
        }
        if (t > 0 || d > 0) {
          total += t; done += d;
          const sd = standardHoursFor(s, subj.key, sc.grade);
          if (sd != null) std += sd;
        }
      }
      if (total === 0 && done === 0) continue;
      sumDone += done; sumTotal += total; sumStd += std;
      srows.push(`<tr><td style="text-align:left; font-weight:600;">${esc(sc.label || '—')}</td>
        <td>${fmtHours(done)}</td><td>${fmtHours(total)}</td><td>${std || ''}</td><td>${std ? fmtHours(std - total) : ''}</td></tr>`);
    }
    if (srows.length >= 2) {
      const lbl = s.mode === 'fukushiki' ? '学年' : '学級';
      summaryTable = `
        <h3 class="ps-h3" style="margin-top:0;">全${lbl}の進捗</h3>
        <table class="ps-table">
          <thead><tr><th style="width:24mm;">${lbl}</th><th>実施済</th><th>予定計</th><th>標準</th><th>残り</th></tr></thead>
          <tbody>${srows.join('')}
            <tr><td style="text-align:left; font-weight:700;">合計</td><td><b>${fmtHours(sumDone)}</b></td><td>${fmtHours(sumTotal)}</td><td>${sumStd || ''}</td><td>${sumStd ? fmtHours(sumStd - sumTotal) : ''}</td></tr>
          </tbody>
        </table>`;
    }
  }

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
  root.classList.remove('print-portrait');
  root.innerHTML = `
    <div class="print-page">
      <div class="pp-header" style="margin-bottom:4mm;">
        <span class="pp-title">授業時数集計</span>
        <span class="pp-range">${fmtFiscalYear(fy, s.printEra)} 第${weekNo}週(${fmtMD(parseDate(weekStart))})まで
          <span style="font-size:8pt;">/ 実施は${fmtMD(new Date())}現在</span></span>
        <div class="pp-school">${esc(s.schoolName || '')} ${esc(s.teacherName || '')}</div>
      </div>
      ${summaryTable}
      ${sections || '<p>データがありません</p>'}
    </div>`;
}

// ---------------------------------------------------------------- 単元指導計画の印刷

/**
 * 年間指導計画(1つのplan)を「単元指導計画表」としてA4縦で印刷する。
 * 単元ごとに 単元の目標・評価規準(3観点)と、各時の 指導目標／学習活動／評価規準／観点 を表で出す。
 */
export function buildPlanPrintDOM(planId) {
  const state = store.state;
  const s = state.settings;
  const plan = state.plans.find(p => p.id === planId);

  let styleEl = document.getElementById('print-page-style');
  if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'print-page-style'; document.head.appendChild(styleEl); }
  styleEl.textContent = `
    @page { size: A4 portrait; margin: 0; }
    #print-root { --page-w: 210mm; --page-h: 296mm; --pfs: 9pt; }
    #print-root .print-page { padding: 12mm; height: auto; min-height: 200mm; overflow: visible; break-after: auto; }
  `;

  const root = document.getElementById('print-root');
  root.classList.remove('print-portrait');
  if (!plan) { root.innerHTML = '<div class="print-page"><p>計画がありません</p></div>'; return; }
  const subj = s.subjects.find(x => x.key === plan.subjectKey);
  const subjName = subj?.name || plan.subjectKey;

  const units = (plan.units || []).map(u => {
    const crit = u.criteria || {};
    const hasCrit = crit.knowledge || crit.thinking || crit.attitude;
    const n = Math.max(Number(u.hours) || 0, (u.lessons || []).length);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const l = (u.lessons || [])[i] || {};
      const obj = l.objective ?? l.text ?? '';
      const act = l.activity ?? '';
      const ass = l.assessment ?? '';
      const vp = l.viewpoint ? `<span class="pi-vp">${esc(l.viewpoint)}</span>` : '';
      if (!obj && !act && !ass) continue;
      rows.push(`<tr>
        <td class="pi-num">${i + 1}</td>
        <td>${esc(obj)}</td>
        <td>${esc(act)}</td>
        <td>${esc(ass)}</td>
        <td class="pi-num">${vp}</td>
      </tr>`);
    }
    return `
      <div class="pi-unit">
        <h3 class="pi-uname">${esc(u.name)} <span class="pi-hours">(${Number(u.hours) || rows.length}時間)</span></h3>
        ${u.goal ? `<div class="pi-goal"><b>単元の目標</b> ${esc(u.goal)}</div>` : ''}
        ${hasCrit ? `<table class="pi-crit">
          <tr><th>知識・技能</th><td>${esc(crit.knowledge || '')}</td></tr>
          <tr><th>思考・判断・表現</th><td>${esc(crit.thinking || '')}</td></tr>
          <tr><th>主体的に学習に取り組む態度</th><td>${esc(crit.attitude || '')}</td></tr>
        </table>` : ''}
        ${rows.length ? `<table class="pi-table">
          <thead><tr><th class="pi-num">時</th><th style="width:32%;">指導目標</th><th style="width:34%;">学習活動</th><th style="width:26%;">評価規準</th><th class="pi-num">観点</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>` : ''}
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="print-page">
      <div class="pp-header" style="margin-bottom:4mm;">
        <span class="pp-title">年間指導計画</span>
        <span class="pp-range">${esc(subjName)}${plan.grade ? ` 第${plan.grade}学年` : ''}${plan.textbook ? `(${esc(plan.textbook)})` : ''}</span>
        <div class="pp-school">${esc(s.schoolName || '')} ${esc(s.teacherName || '')}</div>
      </div>
      <p style="font-size:7.5pt; color:#555; margin:0 0 3mm;">観点: 知=知識・技能 / 思=思考・判断・表現 / 態=主体的に学習に取り組む態度</p>
      ${units || '<p>単元がありません</p>'}
    </div>`;
}
