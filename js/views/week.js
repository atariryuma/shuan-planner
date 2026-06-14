/** 週案編集ビュー(グリッド・セル編集・連続入力・前週コピー・行事・反省) */

import { store, newEntry, cellKey, effectivePeriod, computeOrdinals, resolveEntryText, resolveEntryPlanDetails, computeHours, fmtHours, breakNameOf, noSchoolReason, weekDayOffsets, termRanges, VIEWPOINTS } from '../store.js';
import { fmtDate, parseDate, addDays, fmtMD, mondayOf, weekNumberInFiscalYear, fiscalYearOf, fiscalYearFirstMonday, DAY_NAMES, esc, uid } from '../utils.js';
import { holidayName } from '../holidays.js';
import { openModal, toast, confirmDialog, selectHTML, openResultLink, infoHTML, associateLabels } from '../ui.js';
import { icon } from '../icons.js';

/**
 * 基本時間割がある週を開いたとき、その週がまだ空なら自動で時間割＋計画内容を配置する。
 * 「基本時間割を反映」を毎週押す手間を無くす。開いた週だけ・空のときだけ生成し、
 * 祝日・長期休業・非授業日は除く(skipNoSchool)。設定 autoLayout=false で無効化。
 * 通知(commit)は使わず persist 直書きで保存し、描画中の再描画ループを避ける。
 */
function autoMaterializeWeek(weekStart) {
  if (!store.hasBaseTimetable) return;
  if (store.state.settings.autoLayout === false) return;
  const existed = !!store.state.weeks[weekStart];
  const w = store.state.weeks[weekStart];
  if (w && Object.keys(w.cells).length) return; // 既に中身がある週は触らない
  const res = store.applyBaseTimetable(weekStart, null, { skipNoSchool: true, fillEmptyOnly: true, commit: false });
  if (res.placed) store.persist();
  else if (!existed) delete store.state.weeks[weekStart]; // 0コマ(全休等)なら空週を残さない
}

export function renderWeekView(root, ctx) {
  const state = store.state;
  const s = state.settings;
  const weekStart = ctx.getWeekStart();
  const monday = parseDate(weekStart);
  autoMaterializeWeek(weekStart); // 空き週なら基本時間割＋計画を自動配置(毎週の反映操作を不要に)
  const week = store.getWeek(weekStart);
  // その週に表示する曜日(月〜金＋必要なら土/日)。土日に授業・行事・振替授業日がある週だけ土日列が出る
  const days = weekDayOffsets(s, week, monday);
  const dayCount = days.length;
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);
  const todayStr = fmtDate(new Date());
  const gas = ctx.gas.configured;
  // 表示密度: compact=本時のねらいまで / detail=学習活動・評価規準も表示(既定)
  const density = localStorage.getItem('shuan-week-density') === 'compact' ? 'compact' : 'detail';

  const dayHeads = [];
  const noSchoolDays = {}; // 各曜日(d)の非授業情報 {reason,type} | null。day番号キー(土日=5,6も入るため位置配列にしない)
  let breakDays = 0;
  let breakLabel = '';
  for (const d of days) {
    const date = addDays(monday, d);
    const ds = fmtDate(date);
    const isClassDay = (s.classDays || []).includes(ds); // 振替授業日: 祝日・休業・週末を上書きして授業日に
    const rawHol = s.showHolidays ? holidayName(date) : null;
    const rawBrk = breakNameOf(s, ds);
    const isOff = !isClassDay && (s.offDays || []).includes(ds); // 任意の非授業日
    const hol = isClassDay ? null : rawHol;
    const brk = isClassDay ? null : rawBrk;
    noSchoolDays[d] = hol ? { reason: hol, type: 'holiday' } : brk ? { reason: brk, type: 'break' } : isOff ? { reason: '休業日', type: 'off' } : null;
    if (brk) { breakDays++; breakLabel = brk; }
    // 本来は休み(祝日・休業・週末)だが授業日にしている日
    const rawWeekend = d === 6 ? '日曜' : (d === 5 ? '土曜' : '');
    const makeup = isClassDay ? (rawHol || rawBrk || rawWeekend) : '';
    const isToday = ds === todayStr;
    dayHeads.push(`
      <th class="day-th" data-day="${d}" title="クリックで一括操作" tabindex="0" role="button"
          aria-label="${DAY_NAMES[d]}曜日 ${fmtMD(date)} の一括操作${makeup ? ' 振替授業日' : ''}">
        <div class="day-head ${d === 5 ? 'sat' : ''} ${d === 6 ? 'sun' : ''} ${hol ? 'holiday-mark' : ''} ${isToday ? 'today' : ''} ${brk || isOff ? 'in-break' : ''} ${makeup ? 'makeup-day' : ''}">
          <span class="dow">${DAY_NAMES[d]}<span class="day-caret">▾</span></span>
          <span class="date">${fmtMD(date)}</span>
          ${hol ? `<span class="hol-name">${esc(hol)}</span>` : brk ? `<span class="brk-name">${esc(brk)}</span>` : isOff ? `<span class="brk-name">休業日</span>` : makeup ? `<span class="makeup-name" title="本来は${esc(makeup)}">振替授業</span>` : ''}
        </div>
      </th>`);
  }
  const breakBanner = breakDays === dayCount
    ? `<div class="mode-banner" style="background:#f0f9ff; border-color:#7dd3fc; color:#075985;">${esc(breakLabel)}の週です</div>` : '';
  const todayIdx = (() => {
    for (const d of days) if (fmtDate(addDays(monday, d)) === todayStr) return d;
    return -1;
  })();

  // 表示モード: day=今日ビュー(縦リスト・すきま記録向き) / week=週グリッド。
  // 初回は狭い画面なら day(スマホでの断片入力に最適)、PCは week を既定にする。
  let viewMode = localStorage.getItem('shuan-week-view');
  if (viewMode !== 'day' && viewMode !== 'week') {
    viewMode = window.matchMedia && window.matchMedia('(max-width: 640px)').matches ? 'day' : 'week';
  }
  // 今日ビューで選択中の曜日。表示対象外/未設定なら今日、無ければ先頭。
  let dayViewIdx = ctx.dayViewIdx;
  if (typeof dayViewIdx !== 'number' || !days.includes(dayViewIdx)) {
    dayViewIdx = todayIdx >= 0 ? todayIdx : days[0];
  }
  ctx.dayViewIdx = dayViewIdx;

  // 日課パターン行(パターンが定義されているときだけ表示)
  let patternRow = '';
  if (s.periodPatterns.length) {
    const cells = [];
    for (const d of days) {
      const cur = week.dayPatterns?.[d] || '';
      cells.push(`<td style="padding:2px 4px;">${selectHTML('daypat', [
        { value: '', label: '通常' },
        ...s.periodPatterns.map(p => ({ value: p.id, label: p.name })),
      ], cur, { attrs: `data-day="${d}" class="daypat-select ${cur ? 'active' : ''}" aria-label="${DAY_NAMES[d]}曜の日課"` })}</td>`);
    }
    patternRow = `<tr class="pattern-row"><th class="period-head" style="font-size:11px;">日課</th>${cells.join('')}</tr>`;
  }

  // 日ごとのメモ行(設定でON時のみ。印刷には出ない)
  let dayNotesRow = '';
  if (s.showDayNotes) {
    const cells = [];
    for (const d of days) {
      cells.push(`<td style="background:#f0fdf4;"><textarea class="event-input daynote-input" data-day="${d}" rows="1"
        style="color:#166534;" placeholder="" aria-label="${DAY_NAMES[d]}曜のメモ">${esc(week.dayNotes?.[d] || '')}</textarea></td>`);
    }
    dayNotesRow = `<tr><th class="period-head" style="font-size:11.5px; background:#dcfce7; color:#166534;">メモ${infoHTML('自分用のメモ欄です。印刷されません')}</th>${cells.join('')}</tr>`;
  }

  const eventCells = [];
  for (const d of days) {
    eventCells.push(`<td ${d === todayIdx ? 'class="today-col"' : ''}><textarea class="event-input" data-day="${d}" rows="1"
      placeholder="" aria-label="${DAY_NAMES[d]}曜の行事">${esc(week.events?.[d] || '')}</textarea></td>`);
  }

  // 出欠メモ行(設定でON時のみ。印刷にも出る)
  let attendanceRow = '';
  if (s.showAttendance) {
    const cells = [];
    for (const d of days) {
      cells.push(`<td style="background:#fdf4ff;"><textarea class="event-input attendance-input" data-day="${d}" rows="1"
        style="color:#86198f;" placeholder="" aria-label="${DAY_NAMES[d]}曜の出欠">${esc(week.attendance?.[d] || '')}</textarea></td>`);
    }
    attendanceRow = `<tr><th class="period-head" style="font-size:11.5px; background:#fae8ff; color:#86198f;">出欠${infoHTML('欠席・遅刻・早退のメモ(例: 欠1 遅1)。個人名は書かない運用を推奨。印刷にも出ます')}</th>${cells.join('')}</tr>`;
  }

  const bodyRows = s.periods.map(p => {
    const cells = [];
    for (const d of days) {
      cells.push(renderCell(state, week, d, p, ordinals, ctx, d === todayIdx, noSchoolDays[d]));
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
        aria-pressed="${paint.subject === x.key}" style="background:${esc(x.color)}">${esc(x.short || x.name)}</button>`).join('');
    let scopeChips = '';
    if (s.mode === 'senka' && s.senkaClasses.length) {
      scopeChips = `<span class="paint-sep"></span>` + s.senkaClasses.map(c =>
        `<button class="paint-scope ${paint.scope === c.id ? 'selected' : ''}" data-paint-scope="${esc(c.id)}"
          aria-pressed="${paint.scope === c.id}">${esc(c.label || '学級未設定')}</button>`).join('');
    }
    paintBar = `
      <div class="paint-bar">
        <span class="paint-hint">${paint.subject ? 'コマをクリックして配置(もう一度で消去・Escで終了)' : '教科を選んでください'}</span>
        <div class="paint-chips">${chips}${scopeChips}</div>
        <button class="btn small" id="paint-close">終了</button>
      </div>`;
  }

  // 初回ガイドカード(基本時間割の登録まで案内する。✓で進捗が見える)
  const totalEntries = Object.values(week.cells || {}).reduce((a, c) => a + (c.entries?.length || 0), 0);
  const step1done = totalEntries > 0;
  const onboardCard = (!store.hasBaseTimetable && !localStorage.getItem('shuan-card-done')) ? `
    <div class="onboard-card" id="onboard-card">
      <button class="oc-close" id="oc-close" aria-label="閉じる">×</button>
      <div class="oc-step ${step1done ? 'done' : ''}"><span class="oc-num">${step1done ? '✓' : '1'}</span>コマをクリックして教科を選ぶ</div>
      <div class="oc-step"><span class="oc-num">2</span>1週間できたら <button class="btn small" id="oc-base">基本時間割に登録</button></div>
      <div class="oc-step"><span class="oc-num">3</span><button class="btn small" id="oc-print">印刷</button> して提出</div>
    </div>` : '';

  // 週案の「活用ループ」: 先週のめあて・反省を今週の冒頭に出し、提出物で終わらせない。
  const loopCard = renderLoopCardHTML(state, monday);

  // 週ごとのメモ(めあて・反省・管理職)。日ビュー/週ビューの両方で出す。
  const weekNotesHTML = `<div class="week-notes">
        <div>
          <label for="wk-goals">今週のめあて</label>
          <textarea id="wk-goals">${esc(week.goals || '')}</textarea>
        </div>
        <div>
          <div style="display:flex; align-items:baseline; justify-content:space-between;">
            <label for="wk-reflection">反省</label>
            <button class="btn small ghost" id="wk-review">過去の一覧</button>
          </div>
          <textarea id="wk-reflection">${esc(week.reflection || '')}</textarea>
        </div>
        ${s.printManagerBox ? `
        <div>
          <label for="wk-manager">指導・助言${infoHTML('管理職からの指導・助言を記録します。印刷の管理職欄に出ます')}</label>
          <textarea id="wk-manager" placeholder="管理職コメントを記録">${esc(week.managerNote || '')}</textarea>
        </div>` : ''}
      </div>`;

  const gridPanel = `<div class="panel">
      <div class="week-grid-wrap">
        <table class="week-grid ${paint.subject ? 'painting' : ''} ${density === 'compact' ? 'density-compact' : ''}">
          <thead>
            <tr><th class="corner"></th>${dayHeads.join('')}</tr>
            ${patternRow}
            <tr class="event-row"><th class="period-head">行事</th>${eventCells.join('')}</tr>
            ${attendanceRow}
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      ${weekNotesHTML}
    </div>`;

  const dayPanel = `<div class="panel day-panel">
      ${renderDayPanelHTML(state, week, monday, days, dayViewIdx, todayIdx, ordinals, ctx)}
    </div>
    <div class="panel">${weekNotesHTML}</div>`;

  const mainPanel = viewMode === 'day' ? dayPanel : gridPanel;

  root.innerHTML = `
    <div class="week-nav">
      <button class="btn" id="wk-prev" aria-label="前の週">◀</button>
      <button class="btn" id="wk-today">今週</button>
      <button class="btn" id="wk-next" aria-label="次の週">▶</button>
      <input type="date" id="wk-date" value="${weekStart}" aria-label="表示する週の日付">
      <span class="week-title">${fmtMD(monday)} 〜 ${fmtMD(addDays(monday, days[days.length - 1]))}
        <span class="week-no">第${weekNo}週</span>
      </span>
      <span class="view-toggle" role="group" aria-label="表示の切り替え">
        <button class="vt-btn ${viewMode === 'day' ? 'active' : ''}" id="wk-view-day" aria-pressed="${viewMode === 'day'}" title="今日の授業だけを縦に表示(スマホ・すきま記録向き)">日</button>
        <button class="vt-btn ${viewMode === 'week' ? 'active' : ''}" id="wk-view-week" aria-pressed="${viewMode === 'week'}" title="1週間をまとめて表示">週</button>
      </span>
      <span class="spacer"></span>
      ${viewMode === 'week' ? `<button class="btn" id="wk-density" aria-pressed="${density === 'detail'}" title="学習活動・評価規準の表示を切り替え">${density === 'detail' ? '詳細表示' : '簡潔表示'}</button>
      ${!store.hasBaseTimetable ? `<button class="btn ${paint.open ? 'active' : ''}" id="wk-paint" aria-pressed="${paint.open}" title="教科を選んでコマを連続入力">${icon('pencil')}連続入力</button>` : ''}` : ''}
      ${!store.hasBaseTimetable ? infoHTML('コマをクリックして1週間分を入力し「⋯ → 基本時間割に登録」すると、毎週自動で呼び出せます') : ''}
      <details class="menu">
        <summary class="btn" aria-label="その他">⋯</summary>
        <div class="menu-items">
          <div class="menu-group-label">週の操作</div>
          ${store.hasBaseTimetable && viewMode === 'week' ? `<button class="btn ghost menu-item ${paint.open ? 'active' : ''}" id="wk-paint" aria-pressed="${paint.open}">${icon('pencil')}連続入力</button>` : ''}
          <button class="btn ghost menu-item" id="wk-copy">${icon('clipboard')}前週をコピー</button>
          ${viewMode === 'week' ? `<button class="btn ghost menu-item" id="wk-weekend">${icon('calendar')}土日の列を出す${infoHTML('日曜参観・運動会など、この週に土日の授業・行事があるとき列を出します')}</button>` : ''}
          ${gas ? `<button class="btn ghost menu-item" id="wk-calendar">${icon('calendar')}この週に行事を取り込み</button>` : ''}
          <div class="menu-group-label">時間割・計画</div>
          ${store.hasBaseTimetable ? `<button class="btn ghost menu-item" id="wk-apply-base">${icon('clipboard')}基本時間割を反映${infoHTML('この週を基本時間割で埋めます。手を入れたコマ(●変更・手入力・備考・中止)はそのまま残ります')}</button>` : ''}
          ${store.hasBaseTimetable ? `<span style="display:flex; align-items:center;">
            <button class="btn ghost menu-item" id="wk-generate" style="flex:1;">${icon('calendar')}期間をまとめて作成</button>
            ${infoHTML('基本時間割と年間指導計画から、今週〜学期末などをまとめて自動作成します。祝日・長期休業・非授業日には授業を入れません。入力済みの週は上書きしません')}
          </span>` : ''}
          <button class="btn ghost menu-item" id="wk-save-base">${icon('clipboard')}基本時間割に登録</button>
          <button class="btn ghost menu-item" id="wk-import-events">${icon('flag')}年間行事の取り込み</button>
          ${s.mode !== 'senka' || gas ? '<div class="menu-group-label">書き出し・提出</div>' : ''}
          ${s.mode !== 'senka' ? `<span style="display:flex; align-items:center;">
            <button class="btn ghost menu-item" id="wk-kids-print" style="flex:1;">${icon('doc')}おたより印刷</button>
            ${infoHTML('児童・保護者向けの来週の時間割。大きな字で印刷します')}
          </span>` : ''}
          ${gas ? `
          <button class="btn ghost menu-item" id="wk-cal-push">${icon('calendar')}カレンダーへ書き出し</button>
          <button class="btn ghost menu-item" id="wk-sheet-push">${icon('chart')}シートへ書き出し</button>
          <button class="btn ghost menu-item" id="wk-mail">${icon('mail')}メールで提出</button>` : ''}
          <div class="menu-sep" role="separator"></div>
          <button class="btn ghost danger menu-item" id="wk-clear">${icon('trash')}週クリア</button>
        </div>
      </details>
    </div>
    ${breakBanner}
    ${paintBar}
    ${ctx.swapSource ? `<div class="mode-banner">⇄ 移動先のコマをクリック
      <button class="btn small" id="wk-swap-cancel">キャンセル</button></div>` : ''}
    ${onboardCard}
    ${loopCard}
    ${mainPanel}
    ${renderMiniStats(state, weekStart)}
  `;

  wireNav(root, ctx, monday);
  wireWeekInputs(root, weekStart, ctx);
  wireCells(root, weekStart, ctx);
  wireDayView(root, weekStart, ctx);
  wirePaint(root, ctx);
  wireOnboardCard(root, ctx, monday);
  wireDayMenu(root, ctx, monday, weekStart, dayCount);
}

// ---------------------------------------------------------------- セル描画

// 単元の進度を視覚化する。短単元(≦8時)は●●○ドット、長単元はミニバーで一目に。
function unitProgressHTML(nth, total) {
  if (!nth || !total || total < 2) return '';
  const n = Math.max(0, Math.min(nth, total));
  if (total <= 8) {
    let dots = '';
    for (let i = 1; i <= total; i++) dots += `<i class="${i <= n ? 'on' : ''}"></i>`;
    return `<span class="unit-dots" title="単元 ${n}/${total}時" aria-label="単元 ${n}/${total}時">${dots}</span>`;
  }
  const pct = Math.round(n / total * 100);
  return `<span class="unit-bar" title="単元 ${n}/${total}時" aria-label="単元 ${n}/${total}時"><i style="width:${pct}%"></i></span>`;
}

// 1コマ分の授業(entries)の中身HTML。週グリッドのセルと「今日ビュー」で共有する。
function renderEntriesHTML(state, entries, ordinals) {
  const s = state.settings;
  return entries.map(e => {
    const subj = subjectOf(s, e.subjectKey);
    const { resolved, details } = resolveEntryPlanDetails(state, e, ordinals);
    const text = e.cancelled ? (e.cancelledText || resolved.text) : resolved.text;
    const scopeLabel = scopeLabelOf(s, e.scope);
    const frac = (e.fraction ?? 1) !== 1 ? `<span class="e-flag">${fracLabel(e.fraction)}</span>` : '';
    const guide = s.mode === 'fukushiki' && e.guide ? `<span class="guide-chip g-${e.guide}">${guideLabel(e.guide)}</span>` : '';
    // 空scopeに加えて「設定から削除済みの学級ID」も学級未設定として警告する
    // (集計のどのスコープにも入らず時数が無言で消えるため)
    // 学級未設定は ⚠ で即伝達(色＋記号＋短い語で色覚に依存しない)
    const unsetClass = s.mode === 'senka' && e.subjectKey
      && (e.scope == null || e.scope === '' || !s.senkaClasses.some(c => c.id === e.scope))
      ? `<span class="e-flag warn" title="学級が未設定です">⚠学級</span>` : '';
    // 計画から変更ありは色付きドットのみ(語を減らし、形と色で示す)
    const changed = e.override && Object.keys(e.override).length
      ? `<span class="e-changed-dot" title="計画から変更あり" aria-label="計画から変更あり">●</span>` : '';
    // 単元の進度を●●○のドット(または長単元はミニバー)で一目に
    const progress = !e.cancelled ? unitProgressHTML(details?.nth, details?.unitHours) : '';
    return `
      <div class="entry ${e.cancelled ? 'cancelled' : ''}">
        <div class="e-head">
          ${subj ? `<span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>` : ''}
          ${scopeLabel ? `<span class="e-scope">${esc(scopeLabel)}</span>` : ''}
          ${guide}${frac}${unsetClass}${changed}
          ${e.cancelled ? `<span class="e-flag" style="color:#dc2626;">中止</span>` : e.noCount ? `<span class="e-flag">時数外</span>` : ''}
          ${progress}
        </div>
        ${text ? `<div class="e-text ${resolved.auto ? '' : 'manual'}">${esc(text)}</div>` : ''}
        ${!e.cancelled && details?.activity ? `<div class="e-plan-line e-activity"><span>活</span>${esc(details.activity)}</div>` : ''}
        ${!e.cancelled && (details?.assessment || details?.viewpoint) ? `<div class="e-plan-line e-assessment"><span>評</span>${details.viewpoint ? `<b class="e-viewpoint" data-vp="${esc(details.viewpoint)}">${esc(details.viewpoint)}</b>` : ''}${esc(details.assessment)}</div>` : ''}
        ${e.note ? `<div class="e-note">${esc(e.note)}</div>` : ''}
      </div>`;
  }).join('');
}

// 週案の「活用ループ」カード: 先週のめあて・反省を今週の冒頭に表示する。
// 週案を「書いて出すだけ(形骸化)」にせず、前週を踏まえて回すための導線。
function renderLoopCardHTML(state, monday) {
  const prevKey = fmtDate(addDays(monday, -7));
  const pw = state.weeks[prevKey];
  if (!pw) return '';
  const goals = String(pw.goals || '').trim();
  const ref = String(pw.reflection || '').trim();
  if (!goals && !ref) return '';
  return `<div class="loop-card">
    <div class="loop-head">先週のふりかえり${infoHTML('先週のめあて・反省です。今週の計画に活かして、週案を「出すだけ」で終わらせないための欄です')}</div>
    <div class="loop-body">
      ${goals ? `<div class="loop-item"><span class="loop-label">めあて</span><span class="loop-text">${esc(goals)}</span></div>` : ''}
      ${ref ? `<div class="loop-item"><span class="loop-label">反省</span><span class="loop-text">${esc(ref)}</span></div>` : ''}
    </div>
  </div>`;
}

// 今日のとき、各校時を時刻で「いま/次」に色分けする。
function periodTimeStatus(periods, isToday) {
  const status = {};
  if (!isToday) return status;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  let hasNow = false, nextId = null, nextStart = Infinity;
  for (const p of periods) {
    const st = toMin(p.start), en = toMin(p.end);
    if (st != null && en != null && cur >= st && cur < en) { status[p.id] = 'now'; hasNow = true; }
    if (st != null && st > cur && st < nextStart) { nextStart = st; nextId = p.id; }
  }
  if (!hasNow && nextId) status[nextId] = 'next';
  return status;
}

// 今日ビュー: 選択中の1日を縦リストで表示。すきま時間に1タップで記録する導線。
function renderDayPanelHTML(state, week, monday, days, dayViewIdx, todayIdx, ordinals, ctx) {
  const s = state.settings;
  const date = addDays(monday, dayViewIdx);
  const isToday = dayViewIdx === todayIdx;

  const chips = [];
  for (const d of days) {
    const dt = addDays(monday, d);
    const tag = noSchoolReason(s, fmtDate(dt)) || ''; // 振替授業日は授業日(タグなし)
    chips.push(`<button class="day-chip ${d === dayViewIdx ? 'selected' : ''} ${d === todayIdx ? 'is-today' : ''} ${d === 5 ? 'sat' : ''} ${d === 6 ? 'sun' : ''} ${tag ? 'muted' : ''}" data-daysel="${d}" role="tab" aria-selected="${d === dayViewIdx}">
      <b>${DAY_NAMES[d]}</b><span>${fmtMD(dt)}</span>${tag ? `<i>${esc(tag)}</i>` : ''}
    </button>`);
  }

  const status = periodTimeStatus(s.periods, isToday);
  const items = s.periods.map(p => {
    if (!effectivePeriod(s, week, dayViewIdx, p)) return '';
    const entries = week.cells?.[cellKey(dayViewIdx, p.id)]?.entries || [];
    const st = status[p.id] || '';
    const body = entries.length
      ? renderEntriesHTML(state, entries, ordinals)
      : `<div class="dp-empty">＋ タップして授業を入れる</div>`;
    const flag = st === 'now' ? '<span class="dp-now">いま</span>' : st === 'next' ? '<span class="dp-next">次</span>' : '';
    return `<li class="day-period ${st} ${entries.length ? '' : 'is-empty'}" data-day="${dayViewIdx}" data-period="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(p.label)} ${entries.length ? '' : '空き'}">
      <div class="dp-time"><span class="dp-label">${esc(p.label)}</span>${p.start ? `<span class="dp-clock">${esc(p.start)}</span>` : ''}${flag}</div>
      <div class="dp-body">${body}</div>
    </li>`;
  }).join('');

  const ev = String(week.events?.[dayViewIdx] || '').trim();
  const memo = esc(week.dayNotes?.[dayViewIdx] || '');
  const hol = s.showHolidays ? holidayName(date) : null;
  const brk = breakNameOf(s, fmtDate(date));
  const off = (s.offDays || []).includes(fmtDate(date));
  const nsReason = hol || brk || (off ? '休業日' : '');
  const nsType = hol ? 'holiday' : brk ? 'break' : off ? 'off' : '';
  const banner = hol ? `<div class="day-banner hol">${esc(hol)}</div>`
    : brk ? `<div class="day-banner brk">${esc(brk)}</div>`
    : off ? '<div class="day-banner brk">休業日</div>' : '';

  // 非授業日で授業が無ければ、空のコマ列でなく「休み」を明確に出す(授業がある=振替などは通常表示)
  const hasEntries = s.periods.some(p => week.cells?.[cellKey(dayViewIdx, p.id)]?.entries?.length);
  const listHTML = (nsReason && !hasEntries)
    ? `<div class="day-noschool ns-${nsType}"><span class="dn-ic">${icon(hol ? 'flag' : brk ? 'sun' : 'leaf')}</span><b>${esc(nsReason)}</b><span class="dn-sub">この日は授業がありません</span></div>`
    : `<ol class="day-list">${items || `<li class="day-empty"><span class="de-ic">${icon('cup')}</span>この日に授業はありません</li>`}</ol>`;

  return `
    <div class="day-switch" role="tablist">${chips.join('')}</div>
    <h2 class="day-title">${fmtMD(date)}（${DAY_NAMES[dayViewIdx]}）${isToday ? '<span class="day-today-badge">今日</span>' : ''}</h2>
    ${banner}
    ${ev ? `<div class="day-event"><span class="de-label">行事</span>${esc(ev)}</div>` : ''}
    ${listHTML}
    <div class="day-memo">
      <label for="dp-memo">今日のメモ${infoHTML('自分用のメモ。すきま時間の記録にどうぞ。印刷されません')}</label>
      <textarea id="dp-memo" data-day="${dayViewIdx}" placeholder="気づき・持ち物・連絡など">${memo}</textarea>
    </div>`;
}

function renderCell(state, week, dayIdx, period, ordinals, ctx, isToday, noSchool) {
  const s = state.settings;
  // 非授業日(祝日・長期休業・任意の休業日)は列をはっきり区別する
  const nsClass = noSchool ? `no-school ns-${noSchool.type}` : '';
  if (!effectivePeriod(s, week, dayIdx, period)) {
    // 日課で無効化された校時に入力済みのコマがあれば知らせる(無言で時数・印刷から消えるため)
    const hiddenCount = week.cells?.[cellKey(dayIdx, period.id)]?.entries?.length || 0;
    return `<td class="cell off ${nsClass} ${isToday ? 'today-col' : ''}" data-day="${dayIdx}" data-period="${esc(period.id)}">${
      hiddenCount ? '<span class="off-hidden">非表示の授業あり</span>' : ''}</td>`;
  }
  const cell = week.cells?.[cellKey(dayIdx, period.id)];
  const entries = cell?.entries || [];
  const isModule = period.type === 'module';
  // 非授業日の空きコマ: フラットな淡色のみ(理由=祝日名はヘッダーに1度だけ。セルでは繰り返さない)。
  // 「＋」は出さない(授業を入れる場所に見せない)。授業が入っていれば通常表示。
  const inner = entries.length
    ? renderEntriesHTML(state, entries, ordinals)
    : noSchool ? '' : `<div class="cell-empty">＋</div>`;
  const draggable = entries.length > 0 && !ctx.paint.subject;
  const isSwapSrc = ctx.swapSource && ctx.swapSource.day === dayIdx && ctx.swapSource.period === period.id;
  // キーボード操作用のアクセシブルネーム(例: 「月曜1校時 国語」)
  const subjNames = entries.map(e => subjectOf(s, e.subjectKey)?.name).filter(Boolean).join('・');
  const ariaLabel = `${DAY_NAMES[dayIdx]}曜${period.label}${isModule ? '' : '校時'}${noSchool ? ` ${noSchool.reason}` : ''} ${subjNames || '空き'}`;
  return `
    <td class="cell ${nsClass} ${isModule ? 'module-cell' : ''} ${isSwapSrc ? 'drag-over' : ''} ${isToday ? 'today-col' : ''}"
        data-day="${dayIdx}" data-period="${esc(period.id)}" ${draggable ? 'draggable="true"' : ''}
        tabindex="0" role="button" aria-label="${esc(ariaLabel)}">
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

/**
 * 専科: 学級IDが現在の設定に実在する場合のみ返す(なければundefined)。
 * 設定で削除済みの学級ID(古いlastScope等)を新規コマの既定にすると、
 * そのコマの時数がどのスコープにも入らず集計・印刷から無言で消えるため。
 */
function validScope(s, scope) {
  return s.senkaClasses.some(c => c.id === scope) ? scope : undefined;
}

// ---------------------------------------------------------------- ナビ

function wireNav(root, ctx, monday) {
  root.querySelector('#wk-prev').onclick = () => ctx.setWeekStart(fmtDate(addDays(monday, -7)));
  root.querySelector('#wk-next').onclick = () => ctx.setWeekStart(fmtDate(addDays(monday, 7)));
  root.querySelector('#wk-today').onclick = () => ctx.setWeekStart(null);
  root.querySelector('#wk-date').onchange = (ev) => {
    if (ev.target.value) ctx.setWeekStart(ev.target.value);
  };

  // 日/週ビューの切替(選択を端末に記憶し再描画)
  const setView = (mode) => () => { localStorage.setItem('shuan-week-view', mode); ctx.rerender(); };
  root.querySelector('#wk-view-day')?.addEventListener('click', setView('day'));
  root.querySelector('#wk-view-week')?.addEventListener('click', setView('week'));

  // 簡潔/詳細の表示密度切替(週ビューのみ)。再描画せずCSSで切替
  root.querySelector('#wk-density')?.addEventListener('click', (ev) => {
    const next = localStorage.getItem('shuan-week-density') === 'compact' ? 'detail' : 'compact';
    localStorage.setItem('shuan-week-density', next);
    root.querySelector('.week-grid')?.classList.toggle('density-compact', next === 'compact');
    const btn = ev.currentTarget;
    btn.textContent = next === 'detail' ? '詳細表示' : '簡潔表示';
    btn.setAttribute('aria-pressed', String(next === 'detail'));
  });

  const _applyBaseBtn = root.querySelector('#wk-apply-base');
  if (_applyBaseBtn) _applyBaseBtn.onclick = async () => {
    const to = fmtDate(monday);
    const bases = store.state.baseTimetables;
    const apply = async (id) => {
      const cur = store.state.weeks[to];
      if (cur && Object.keys(cur.cells).length) {
        const ok = await confirmDialog('この週に基本時間割を反映しますか?', { okLabel: '反映', hint: '手を入れたコマ(●変更・手入力・備考・中止)はそのまま残ります' });
        if (!ok) return;
      }
      store.snapshot('基本時間割の反映');
      const res = store.applyBaseTimetable(to, id);
      if (res.placed || res.preserved) {
        const kept = res.preserved ? `（手を入れた${res.preserved}コマは保持）` : '';
        toast(`基本時間割を反映しました${kept}`, 'info', 2800, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
        ctx.rerender();
      }
    };
    if (bases.length <= 1) { apply(null); return; }
    openModal(`
      <h2>どの時間割を反映しますか?</h2>
      <div class="choice-list">
        ${bases.map(b => `<button class="btn" data-base="${esc(b.id)}">${esc(b.name)}</button>`).join('')}
      </div>
      <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelectorAll('[data-base]').forEach(b => {
        b.onclick = () => { close(); apply(b.dataset.base); };
      });
    });
  };

  // 期間をまとめて作成(基本時間割+年間指導計画→複数週を自動生成。祝日・休業・非授業日は除外)
  const genBtn = root.querySelector('#wk-generate');
  if (genBtn) genBtn.onclick = () => {
    const fy = fiscalYearOf(addDays(monday, 3));
    const terms = termRanges(s, fy);
    const here = fmtDate(monday);
    const term = terms.find(t => t.from <= here && here <= t.to) || terms[terms.length - 1];
    const monthEnd = fmtDate(new Date(monday.getFullYear(), monday.getMonth() + 1, 0));
    const yearEnd = `${fy + 1}-03-31`;
    const bases = store.state.baseTimetables;
    const run = async (toDate, baseId) => {
      const toWeek = fmtDate(mondayOf(parseDate(toDate)));
      store.snapshot('まとめて作成');
      const res = store.generateRange(here, toWeek, baseId);
      if (!res.cells) { toast('追加できるコマがありませんでした(既に入力済みか期間外)', 'error', 4000); return; }
      toast(`${res.weeks}週・${res.cells}コマを作成しました`, 'info', 4000, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      ctx.rerender();
    };
    const pickBaseThen = async (toDate) => {
      if (bases.length <= 1) return run(toDate, null);
      openModal(`<h2>どの時間割で作成しますか?</h2>
        <div class="choice-list">
          ${bases.map(b => `<button class="btn" data-base="${esc(b.id)}">${esc(b.name)}</button>`).join('')}
        </div>
        <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>`,
        (m, close) => {
          m.querySelector('[data-cancel]').onclick = close;
          m.querySelectorAll('[data-base]').forEach(b => b.onclick = () => { close(); run(toDate, b.dataset.base); });
        });
    };
    openModal(`
      <h2>期間をまとめて作成</h2>
      <p class="hint">今週(${fmtMD(monday)})から下の期間まで、基本時間割と年間指導計画で自動作成します。<br>
        祝日・長期休業・非授業日は除き、入力済みの週はそのまま残します。</p>
      <div class="choice-list">
        <button class="btn primary" data-to="${term.to}">学期末まで(${fmtMD(parseDate(term.to))})</button>
        <button class="btn" data-to="${monthEnd}">今月末まで(${fmtMD(parseDate(monthEnd))})</button>
        <button class="btn" data-to="${yearEnd}">年度末まで(3/31)</button>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="date" id="gen-to" value="${term.to}" style="flex:1;">
          <button class="btn" data-to-input>この日まで</button>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelectorAll('[data-to]').forEach(b => b.onclick = () => { close(); pickBaseThen(b.dataset.to); });
      modal.querySelector('[data-to-input]').onclick = () => {
        const v = modal.querySelector('#gen-to').value;
        if (!v) { toast('日付を選んでください', 'error'); return; }
        close(); pickBaseThen(v);
      };
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
      <div class="choice-list">
        ${bases.map(b => `<button class="btn" data-over="${esc(b.name)}">「${esc(b.name)}」を上書き</button>`).join('')}
        ${bases.length < 3 ? `
        <div style="display:flex; gap:8px;">
          <input type="text" id="base-name" placeholder="B週" aria-label="時間割の名前" style="flex:1; border:1px solid var(--line); border-radius:8px; padding:7px 9px;">
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

  // 土日の列を出す: 日曜参観・運動会など。土/日を「振替授業日」にして、その週だけ列を出す
  const weekendBtn = root.querySelector('#wk-weekend');
  if (weekendBtn) weekendBtn.onclick = () => {
    const satDate = fmtDate(addDays(monday, 5));
    const sunDate = fmtDate(addDays(monday, 6));
    const sat = !!store.settings.saturday;
    const cls = store.settings.classDays || [];
    const sunShown = cls.includes(sunDate);
    openModal(`
      <h2>土日の列を出す</h2>
      <p class="hint">日曜参観・運動会など、この週に土日の授業や行事があるとき列を出します。出したら、コマをクリックして授業を入れたり、行事欄に記入できます。<br>振替でお休みになる平日は、その曜日の見出しをクリック →「非授業日にする」で。</p>
      <div class="choice-list">
        ${sat ? '' : `<button class="btn" data-wd="sat">${icon('calendar')}土曜の列を${cls.includes(satDate) ? '消す' : '出す'}</button>`}
        <button class="btn" data-wd="sun">${icon('calendar')}日曜の列を${sunShown ? '消す' : '出す'}</button>
        ${sat ? '<p class="hint">土曜は設定で常時表示中です。</p>' : ''}
      </div>
      <div class="modal-foot"><button class="btn" data-cancel>閉じる</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelectorAll('[data-wd]').forEach(b => b.onclick = () => {
        const dateStr = b.dataset.wd === 'sat' ? satDate : sunDate;
        const now = store.toggleClassDay(dateStr);
        close(); ctx.rerender();
        toast(now ? `${b.dataset.wd === 'sat' ? '土' : '日'}曜の列を出しました` : `${b.dataset.wd === 'sat' ? '土' : '日'}曜の列を消しました`, 'info', 2400, { label: '元に戻す', onClick: () => { store.toggleClassDay(dateStr); ctx.rerender(); } });
      });
    });
  };

  const swapCancel = root.querySelector('#wk-swap-cancel');
  if (swapCancel) swapCancel.onclick = () => { ctx.swapSource = null; ctx.rerender(); };

  root.querySelector('#wk-import-events').onclick = () => openEventsImport(ctx);
  root.querySelector('#wk-review').onclick = () => openReviewList(ctx);

  const kidsBtn = root.querySelector('#wk-kids-print');
  if (kidsBtn) kidsBtn.onclick = async () => {
    const { printKidsLetter } = await import('../print.js');
    printKidsLetter(fmtDate(monday));
  };

  root.querySelector('#wk-copy').onclick = async () => {
    const from = fmtDate(addDays(monday, -7));
    const to = fmtDate(monday);
    if (!store.state.weeks[from]) { toast('前週のデータがありません', 'error'); return; }
    const cur = store.state.weeks[to];
    if (cur && Object.keys(cur.cells).length) {
      const ok = await confirmDialog('この週に前週をコピーしますか?', { okLabel: 'コピー', hint: '手を入れたコマ(●変更・手入力・備考・中止)はそのまま残ります' });
      if (!ok) return;
    }
    store.snapshot('前週コピー');
    const res = store.copyWeek(from, to);
    const kept = res.preserved ? `（手を入れた${res.preserved}コマは保持）` : '';
    toast(`前週をコピーしました${kept}`, 'info', 2800, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    ctx.rerender();
  };

  // 「週クリア」: 破壊的なので1行確認+Undoの両方で守る
  root.querySelector('#wk-clear').onclick = async () => {
    const to = fmtDate(monday);
    if (!store.state.weeks[to]) return;
    const ok = await confirmDialog('この週の入力をすべて消しますか?', { okLabel: '週クリア', danger: true });
    if (!ok) return;
    store.snapshot('週のクリア');
    delete store.state.weeks[to];
    store.commit();
    toast('週をクリアしました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    ctx.rerender();
  };

  // ---- Google連携(設定済みのときだけボタンが存在する)
  // 設定タブの該当パネルへ誘導する(規約3: 教育文でなくactionボタン)
  const gotoSettings = (panelId) => {
    document.querySelector('.tab[data-tab="settings"]')?.click();
    setTimeout(() => {
      const target = document.getElementById(panelId);
      if (!target) return;
      const det = target.querySelector('details');
      if (det) det.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };
  const calPush = root.querySelector('#wk-cal-push');
  if (calPush) calPush.onclick = async () => {
    const { buildCalendarEvents } = await import('../gws.js');
    const payload = buildCalendarEvents(fmtDate(monday));
    if (!payload.events.length) {
      // skippedあり=入力はあるが校時の時刻が無い → 設定の時程へ誘導(規約3: actionボタン)
      if (payload.skipped) toast('校時の時刻が未設定です', 'error', 5000, { label: '設定を開く', onClick: () => gotoSettings('sp-schedule') });
      else toast('書き出せる授業がありません', 'error');
      return;
    }
    const ok = await confirmDialog(
      `${payload.events.length}件をカレンダー「週案」へ書き出します(再実行で置き換え)` +
      (payload.skipped ? `\n時刻未設定の${payload.skipped}コマはスキップ` : ''),
      { okLabel: '書き出し' });
    if (!ok) return;
    try {
      toast('書き出し中…');
      const res = await ctx.gas.pushWeek(payload.events, payload.from, payload.to);
      toast(`カレンダーへ${res.created}件書き出しました`);
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
      openResultLink(res.url, 'シートを開く'); // ボタン「シートへ書き出し」と表記を揃える(規約6)
    } catch (e) {
      toast('書き出し失敗: ' + e.message, 'error', 6000);
    }
  };

  const mailBtn = root.querySelector('#wk-mail');
  if (mailBtn) mailBtn.onclick = async () => {
    const s = store.settings;
    if (!s.gas.mailTo) {
      toast('提出先が未設定です', 'error', 5000, { label: '設定を開く', onClick: () => gotoSettings('sp-google') });
      return;
    }
    if (!s.gas.senderName && !s.teacherName) {
      toast('差出人の氏名が未設定です', 'error', 5000, { label: '設定を開く', onClick: () => gotoSettings('sp-basic') });
      return;
    }
    const { buildWeekEmail, markMailed } = await import('../gws.js');
    const mail = buildWeekEmail(fmtDate(monday));
    const ok = await confirmDialog(`${s.gas.mailTo} へ送信します\n件名: ${mail.subject}\n${mail.summary}`, { okLabel: '送信' });
    if (!ok) return;
    try {
      toast('送信中…');
      await ctx.gas.mailWeek({ to: s.gas.mailTo, subject: mail.subject, html: mail.html, text: mail.text, senderName: s.gas.senderName || s.teacherName });
      markMailed(fmtDate(monday));
      toast('送信しました');
    } catch (e) {
      toast('送信失敗: ' + e.message, 'error', 6000);
    }
  };

  const calBtn = root.querySelector('#wk-calendar');
  if (calBtn) calBtn.onclick = async () => {
    try {
      toast('取得中…');
      // 土日も取得した上で、平日は自動・土日は予定がある回だけ確認して入れる(個人予定の紛れ込み防止)
      const res = await ctx.gas.events(fmtDate(monday), fmtDate(addDays(monday, 6)), store.settings.gas.calendarIds || []);
      if (res.errors?.length) {
        toast('一部のカレンダーを読めません: ' + res.errors.join(' / '), 'error', 6000);
      }
      const all = (res.events || [])
        .map(ev => ({ ...ev, idx: Math.round((parseDate(ev.date) - monday) / 86400000) }))
        .filter(ev => ev.idx >= 0 && ev.idx <= 6);
      const weekend = all.filter(ev => ev.idx >= 5);
      let takeWeekend = false;
      if (weekend.length) {
        const names = weekend.slice(0, 4).map(ev => `${DAY_NAMES[ev.idx]} ${ev.title}`).join('\n');
        takeWeekend = await confirmDialog(
          `土日に${weekend.length}件の予定があります。週案に入れますか?\n${names}${weekend.length > 4 ? '\n…' : ''}`,
          { okLabel: '入れる', hint: '運動会・日曜参観など。入れると土/日の列が出ます(個人の予定なら「キャンセル」)' });
      }
      const target = all.filter(ev => ev.idx <= 4 || (takeWeekend && ev.idx >= 5));
      store.snapshot('行事の取得');
      const week = store.getWeek(fmtDate(monday), true);
      if (!Array.isArray(week.events)) week.events = ['', '', '', '', '', ''];
      let n = 0;
      let dup = 0; // 既に行事欄にある予定(再取り込み)は件数に数えない
      for (const ev of target) {
        const idx = ev.idx;
        const line = (ev.time ? ev.time + ' ' : '') + ev.title;
        if (!week.events[idx]) { week.events[idx] = line; n++; }
        else if (!week.events[idx].includes(ev.title)) { week.events[idx] += '\n' + line; n++; }
        else dup++;
      }
      store.commit();
      const msg = dup ? `取り込み${n}件・登録済み${dup}件` : `${n}件を取り込みました`;
      toast(msg, 'info', 3000, n ? { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } } : null);
      ctx.rerender();
    } catch (e) {
      toast('取得失敗: ' + e.message, 'error', 5000);
    }
  };
}

// ---------------------------------------------------------------- 年間行事の一括取り込み

/**
 * 年間行事予定(Excel/CSV)の貼り付け取り込み。GAS不要。
 * 日付列を自動検出し(2026/4/8・4/8・2026-04-08 に対応)、残りの列を行事名として各週の行事欄へ追記する。
 */
function openEventsImport(ctx) {
  const curFY = store.settings.fiscalYear;
  openModal(`
    <h2>年間行事を取り込み</h2>
    <p class="hint">学校の年間行事予定(Excel)から「日付」と「行事名」の列を範囲コピーして貼り付けてください。<br>
      日付は 4/8・2026/4/8・2026-04-08 のどれでも読み取れます(月日だけなら下の年度で判定)。</p>
    <div class="field" style="max-width:200px;"><label>対象年度</label>
      <select name="fy">
        <option value="${curFY}">${curFY}年度</option>
        <option value="${curFY + 1}">${curFY + 1}年度(次年度の予定)</option>
      </select></div>
    <div class="field import-area">
      <label>Excelやスプレッドシートから貼り付け${infoHTML('Excel・スプレッドシートのセルを範囲コピーして貼り付け(タブ区切り)。CSVテキストも可')}</label>
      <textarea name="paste" placeholder="4/8	入学式&#10;4/9	始業式&#10;5/20	運動会"></textarea>
    </div>
    <div class="field"><label>またはCSVファイル</label>
      <input type="file" name="file" accept=".csv,.tsv,.txt"></div>
    <div class="modal-foot">
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-next>読み取る</button>
    </div>
  `, (modal, close) => {
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-next]').onclick = async () => {
      let text = modal.querySelector('[name="paste"]').value;
      const file = modal.querySelector('[name="file"]').files[0];
      if (!text.trim() && file) text = await file.text();
      if (!text.trim()) { toast('データがありません', 'error'); modal.querySelector('[name="paste"]').focus(); return; }

      const { parseTable } = await import('../csv.js');
      const rows = parseTable(text);
      const fy = Number(modal.querySelector('[name="fy"]').value) || curFY;
      const events = [];
      for (const r of rows) {
        let date = null;
        const parts = [];
        for (const cell of r) {
          const d = !date ? parseFlexDate(String(cell).trim(), fy) : null;
          if (d) date = d;
          else if (String(cell).trim()) parts.push(String(cell).trim());
        }
        if (date && parts.length) events.push({ date, title: parts.join(' ') });
      }
      if (!events.length) { toast('日付+行事名の行が見つかりません', 'error', 4500); return; }

      // 土日の行事(運動会・日曜参観等)も取り込む。週末の行事が入ると、その週だけ土/日の列が出る
      const weekendNote = '';

      // プレビューは年込みで表示(取り込み先のズレに気づけるように)。日付はゼロ詰めなし(規約7)
      const fmtPreviewDate = (dateStr) => { const d = parseDate(dateStr); return `${d.getFullYear()}/${fmtMD(d)}`; };
      const ok = await confirmDialog(
        `${events.length}件の行事を読み取りました。${weekendNote}\n` +
        `${events.slice(0, 5).map(e => `${fmtPreviewDate(e.date)} ${e.title}`).join('\n')}${events.length > 5 ? '\n…' : ''}\n\n各週の行事欄に追記しますか?(既存の行事は消えません)`,
        { okLabel: '取り込み' });
      if (!ok) return;

      store.snapshot('年間行事の取り込み');
      let applied = 0;
      let dup = 0; // 既に行事欄にある行事(再取り込み)は件数に数えない
      for (const ev of events) {
        const d = parseDate(ev.date);
        const idx = (d.getDay() + 6) % 7; // 月=0..日=6
        const w = store.getWeek(fmtDate(mondayOf(d)), true);
        if (!w.events[idx]) { w.events[idx] = ev.title; applied++; }
        else if (!w.events[idx].includes(ev.title)) { w.events[idx] += '\n' + ev.title; applied++; }
        else dup++;
      }
      store.commit();
      close();
      const msg = dup ? `取り込み${applied}件・登録済み${dup}件` : `${applied}件を取り込みました`;
      toast(msg, 'info', 3500, applied ? { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } } : null);
      ctx.rerender();
    };
  });
}

/** 柔軟な日付パース。月日だけなら年度(4月始まり)から年を補完。日付でなければnull */
function parseFlexDate(s, fiscalYear) {
  let m = /^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?$/.exec(s);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    return validDate(y, mo, d);
  }
  m = /^(\d{1,2})[/\-月](\d{1,2})日?$/.exec(s);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]);
    const y = mo >= 4 ? fiscalYear : fiscalYear + 1;
    return validDate(y, mo, d);
  }
  return null;
}

function validDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const date = new Date(y, mo - 1, d);
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return fmtDate(date);
}

// ---------------------------------------------------------------- 振り返り一覧

/** 年度内の入力済み週のめあて・反省・行事を一覧表示(学期末の振り返り用) */
function openReviewList(ctx) {
  const state = store.state;
  // 表示中の週の年度で絞り込む(全年度を混ぜると「第1週」等が二重に並ぶ)
  const fy = fiscalYearOf(addDays(parseDate(ctx.getWeekStart()), 3));
  const from = fmtDate(fiscalYearFirstMonday(fy));
  const to = fmtDate(fiscalYearFirstMonday(fy + 1));
  const weeks = Object.keys(state.weeks).sort().filter(wk => {
    if (wk < from || wk >= to) return false;
    const w = state.weeks[wk];
    return (w.goals || w.reflection || (w.events || []).some(Boolean));
  });
  const rows = weeks.map(wk => {
    const w = state.weeks[wk];
    const monday = parseDate(wk);
    const weekNo = weekNumberInFiscalYear(monday);
    const events = (w.events || []).filter(Boolean).join(' / ');
    return `
      <tr>
        <td style="white-space:nowrap; vertical-align:top;"><button class="btn small ghost" data-goto="${esc(wk)}">第${weekNo}週<br>${fmtMD(monday)}〜</button></td>
        <td style="vertical-align:top; font-size:12.5px; color:#92400e;">${esc(events)}</td>
        <td style="vertical-align:top; font-size:12.5px;">${esc(w.goals || '')}</td>
        <td style="vertical-align:top; font-size:12.5px;">${esc(w.reflection || '')}</td>
      </tr>`;
  }).join('');

  openModal(`
    <h2>振り返り一覧 <span class="hint">${fy}年度</span></h2>
    ${rows ? `
    <div style="max-height:60vh; overflow-y:auto;">
      <table class="stats-table" style="table-layout:fixed;">
        <thead><tr><th style="width:90px;">週</th><th style="width:24%;">行事</th><th>めあて</th><th>反省</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : '<p class="hint">まだ記録がありません。</p>'}
    <div class="modal-foot"><button class="btn primary" data-close>閉じる</button></div>
  `, (modal, close) => {
    modal.querySelector('[data-close]').onclick = close;
    modal.querySelectorAll('[data-goto]').forEach(b => {
      b.onclick = () => { close(); ctx.setWeekStart(b.dataset.goto); };
    });
  });
}

// ---------------------------------------------------------------- 週入力

function wireWeekInputs(root, weekStart, ctx) {
  // 行事・メモ・出欠欄は内容に合わせて自動伸長する(2行目以降が枠外に隠れて
  // 取り込んだ予定を見落とさないように。印刷には全行出るため画面と揃える)
  const autoGrow = (ta) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  root.querySelectorAll('.event-input').forEach(ta => {
    autoGrow(ta);
    ta.addEventListener('input', () => autoGrow(ta));
  });
  root.querySelectorAll('.event-input:not(.daynote-input):not(.attendance-input)').forEach(ta => {
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
  const mgr = root.querySelector('#wk-manager');
  if (mgr) mgr.addEventListener('input', (ev) => {
    const w = store.getWeek(weekStart, true);
    w.managerNote = ev.target.value;
    store.commit();
  });
  root.querySelectorAll('.daypat-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const s = store.settings;
      const w = store.getWeek(weekStart, true);
      const d = Number(sel.dataset.day);
      store.snapshot('日課の変更');
      if (sel.value) w.dayPatterns[d] = sel.value;
      else delete w.dayPatterns[d];
      ctx.swapSource = null;
      store.commit();
      // 無効化された校時に入力済みのコマがあれば知らせる(無言で非表示・時数除外になるため)
      let hidden = 0;
      for (const p of s.periods) {
        if (effectivePeriod(s, w, d, p)) continue;
        hidden += w.cells[cellKey(d, p.id)]?.entries?.length || 0;
      }
      if (hidden) {
        // 単位は「件」: hiddenはエントリ数のため、複式で1コマ(2授業)を「2コマ」と報告しないように
        toast(`非表示の授業が${hidden}件あります`, 'info', 4000,
          { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      }
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
  // 出欠メモ
  root.querySelectorAll('.attendance-input').forEach(ta => {
    ta.addEventListener('input', () => {
      const w = store.getWeek(weekStart, true);
      if (!Array.isArray(w.attendance)) w.attendance = ['', '', '', '', '', ''];
      w.attendance[Number(ta.dataset.day)] = ta.value;
      store.commit();
    });
  });
}

// ---------------------------------------------------------------- 連続入力(ペイント)

function wirePaint(root, ctx) {
  // 連続入力ボタンは週ビューのみ(日ビューにはグリッドが無い)
  root.querySelector('#wk-paint')?.addEventListener('click', () => {
    ctx.paint.open = !ctx.paint.open;
    if (!ctx.paint.open) ctx.paint.subject = null;
    ctx.swapSource = null;
    ctx.rerender();
  });
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
  if (!paint.subject) { toast('教科が未選択です', 'error'); return true; }
  const w = store.getWeek(weekStart, true);
  const key = cellKey(dayIdx, periodId);
  const cell = w.cells[key];
  const entries = cell?.entries || [];

  // 同じ教科の「きれいな」エントリ → トグル消去(備考・手動内容入りは壊さない)。
  // 複式はペイントで全学年分のエントリを作るため、全学年そろって同教科のときにトグルする
  const clean = (e) => e.subjectKey === paint.subject && e.auto && !e.note && !e.cancelled;
  const toggleHit = s.mode === 'fukushiki'
    ? (entries.length === s.fukushikiGrades.length && entries.every(clean))
    : (entries.length === 1 && clean(entries[0])
      && (s.mode !== 'senka' || entries[0].scope === (paint.scope ?? entries[0].scope)));
  if (toggleHit) {
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
    if (s.mode === 'senka') e.scope = validScope(s, paint.scope) ?? validScope(s, ctx.lastScope) ?? s.senkaClasses[0]?.id ?? null;
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
    const open = () => {
      const d = Number(th.dataset.day);
      const date = addDays(monday, d);
      const dateStr = fmtDate(date);
      const label = `${fmtMD(date)}(${DAY_NAMES[d]})`;
      // 日種別の対称トグル: 通常日↔非授業日(offDay)、祝日/休業/週末↔振替授業日(classDay)
      const isClassDay = (store.settings.classDays || []).includes(dateStr);
      const isOff = (store.settings.offDays || []).includes(dateStr);
      const noSchoolR = noSchoolReason(store.settings, dateStr); // classDay考慮済み(振替ならnull)
      let dayToggle;
      if (isClassDay) {
        dayToggle = { act: 'classday', icon: 'refresh', title: '振替授業日を解除', desc: 'この日を本来の休み(祝日・休業など)に戻します' };
      } else if (isOff) {
        dayToggle = { act: 'offday', icon: 'refresh', title: '非授業日を解除', desc: 'この日を授業日に戻します' };
      } else if (noSchoolR) {
        dayToggle = { act: 'classday', icon: 'book', title: '授業日にする(振替)', desc: `${noSchoolR}ですが授業日として扱います。基本時間割の自動配置・時数集計の対象になります` };
      } else {
        dayToggle = { act: 'offday', icon: 'stop', title: '非授業日にする', desc: '開校記念日・振替休業・学級閉鎖など。自動配置や「まとめて作成」で授業が入りません' };
      }
      openModal(`
        <h2>${esc(label)} の一括操作</h2>
        <div class="day-ops">
          <button class="btn day-op" data-act="cancel-all"><span class="op-ic">${icon('ban')}</span><span class="op-tx"><b>休講にする（以降を繰り下げ）</b><small>行事などでこの日が潰れたとき。中止したコマの分、以降の授業が自動で後ろにずれます</small></span></button>
          ${d > 0 ? `<button class="btn day-op" data-act="copy-prev"><span class="op-ic">${icon('clipboard')}</span><span class="op-tx"><b>前日をコピー</b><small>前日の時間割をこの日に複製します</small></span></button>` : ''}
          <button class="btn day-op" data-act="${dayToggle.act}"><span class="op-ic">${icon(dayToggle.icon)}</span><span class="op-tx"><b>${dayToggle.title}</b><small>${dayToggle.desc}</small></span></button>
          <button class="btn day-op danger" data-act="clear"><span class="op-ic">${icon('trash')}</span><span class="op-tx"><b>この日をクリア</b><small>この日の入力をすべて削除します</small></span></button>
        </div>
        <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>
      `, (modal, close) => {
        modal.querySelector('[data-cancel]').onclick = close;
        modal.querySelectorAll('[data-act]').forEach(b => {
          b.onclick = () => {
            const act = b.dataset.act;
            if (act === 'offday') {
              const nowOff = store.toggleOffDay(dateStr);
              close();
              toast(nowOff ? '非授業日にしました' : '非授業日を解除しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.toggleOffDay(dateStr); ctx.rerender(); } });
              ctx.rerender();
              return;
            }
            if (act === 'classday') {
              const nowClass = store.toggleClassDay(dateStr);
              close();
              toast(nowClass ? '振替授業日にしました' : '振替授業日を解除しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.toggleClassDay(dateStr); ctx.rerender(); } });
              ctx.rerender();
              return;
            }
            const w = store.getWeek(weekStart, true);
            const state = store.state;
            const ordinals = computeOrdinals(state, weekStart);
            store.snapshot(`${label}の一括操作`);
            let n = 0;
            if (act === 'cancel-all') {
              for (const p of store.settings.periods) {
                const cell = w.cells[cellKey(d, p.id)];
                if (!cell) continue;
                let hit = false;
                for (const e of cell.entries) {
                  if (e.cancelled || !e.subjectKey) continue;
                  e.cancelledText = resolveEntryText(state, e, ordinals).text;
                  e.cancelled = true;
                  hit = true;
                }
                if (hit) n++; // コマ(セル)単位で数える。複式は1コマ2エントリのため、エントリ数だと実コマ数の2倍を報告してしまう
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
    };
    th.addEventListener('click', open);
    // キーボード操作(Enter/Space)でも一括操作メニューを開けるように
    th.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      open();
    });
  });
}

// ---------------------------------------------------------------- セルの右クリック・クイック操作

// PC向けアクセラレータ。主クリック(編集を開く)はそのまま、右クリックで頻出操作を即出しする。
function openCellContextMenu(weekStart, dayIdx, periodId, ctx, x, y) {
  closeCellContextMenu();
  const cell = store.state.weeks[weekStart]?.cells?.[cellKey(dayIdx, periodId)];
  const entries = cell?.entries || [];
  const hasEntries = entries.length > 0;
  const hasClip = Array.isArray(ctx.cellClipboard) && ctx.cellClipboard.length > 0;
  const anyCancelled = hasEntries && entries.some(e => e.cancelled);

  const acts = [{ ic: 'pencil', label: '編集', run: () => openCellEditor(weekStart, dayIdx, periodId, ctx) }];
  if (hasEntries) acts.push({ ic: 'clipboard', label: 'コピー', run: () => { ctx.cellClipboard = entries.map(e => ({ ...e })); toast('コマをコピーしました', 'info', 1800); } });
  if (hasClip) acts.push({ ic: 'download', label: '貼り付け', run: () => pasteCellQuick(weekStart, dayIdx, periodId, ctx) });
  if (hasEntries) acts.push({ ic: 'refresh', label: '移動', run: () => { ctx.swapSource = { day: dayIdx, period: periodId }; ctx.rerender(); } });
  if (hasEntries) acts.push({ ic: 'ban', label: anyCancelled ? '中止を解除' : '中止にする', run: () => toggleCancelCellQuick(weekStart, dayIdx, periodId, ctx) });
  if (hasEntries) acts.push({ ic: 'trash', label: 'クリア', danger: true, run: () => clearCellQuick(weekStart, dayIdx, periodId, ctx) });

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = acts.map((a, i) => `<button class="cm-item ${a.danger ? 'danger' : ''}" data-cm="${i}" role="menuitem">${icon(a.ic)}${a.label}</button>`).join('');
  document.body.appendChild(menu);
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - menu.offsetWidth - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - menu.offsetHeight - 6)) + 'px';
  menu.querySelectorAll('[data-cm]').forEach(b => { b.onclick = () => { const a = acts[Number(b.dataset.cm)]; closeCellContextMenu(); a.run(); }; });

  // メニュー外クリックは「閉じるだけ」。clickをキャプチャ段階で消費し、下のセルへ貫通させない
  // (mousedownで閉じると後続のclickがセルに届き編集モーダルが開いてしまうため)。
  const onClick = (ev) => {
    if (menu.contains(ev.target)) return; // メニュー項目のクリックはそのまま処理させる
    ev.preventDefault();
    ev.stopPropagation();
    closeCellContextMenu();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); closeCellContextMenu(); } };
  closeCellContextMenu._cleanup = () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', closeCellContextMenu, true);
    window.removeEventListener('resize', closeCellContextMenu);
  };
  setTimeout(() => {
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', closeCellContextMenu, true);
    window.addEventListener('resize', closeCellContextMenu);
  }, 0);
  menu.querySelector('.cm-item')?.focus();
}

function closeCellContextMenu() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
  if (closeCellContextMenu._cleanup) { closeCellContextMenu._cleanup(); closeCellContextMenu._cleanup = null; }
}

function pasteCellQuick(weekStart, dayIdx, periodId, ctx) {
  if (!Array.isArray(ctx.cellClipboard) || !ctx.cellClipboard.length) return;
  const w = store.getWeek(weekStart, true);
  store.snapshot('コマの貼り付け');
  w.cells[cellKey(dayIdx, periodId)] = { entries: ctx.cellClipboard.map(e => ({ ...e, id: uid(), cancelled: false, cancelledText: '' })) };
  store.commit();
  ctx.rerender();
  toast('貼り付けました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

function toggleCancelCellQuick(weekStart, dayIdx, periodId, ctx) {
  const w = store.getWeek(weekStart, true);
  const cell = w.cells?.[cellKey(dayIdx, periodId)];
  if (!cell?.entries?.length) return;
  const ordinals = computeOrdinals(store.state, weekStart);
  const turningOn = !cell.entries.some(e => e.cancelled);
  store.snapshot(turningOn ? 'コマの中止' : '中止の解除');
  for (const e of cell.entries) {
    if (turningOn) { if (!e.cancelled) { e.cancelledText = resolveEntryText(store.state, e, ordinals).text; e.cancelled = true; } }
    else { e.cancelled = false; e.cancelledText = ''; }
  }
  store.commit();
  ctx.rerender();
  toast(turningOn ? '中止にしました' : '中止を解除しました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

function clearCellQuick(weekStart, dayIdx, periodId, ctx) {
  const w = store.getWeek(weekStart, true);
  store.snapshot('コマのクリア');
  delete w.cells[cellKey(dayIdx, periodId)];
  store.commit();
  ctx.rerender();
  toast('コマをクリアしました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// ---------------------------------------------------------------- セル操作

function wireCells(root, weekStart, ctx) {
  closeCellContextMenu(); // 再描画で古いメニューが残らないように
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
    // キーボード操作(Enter/Space)でもコマ編集を開けるように(WCAG 2.1.1)
    td.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.target !== td) return; // セル内のボタン(×)のキー操作はそのまま
      ev.preventDefault();
      td.click();
    });
    // PC: 右クリックでクイック操作メニュー(主クリックの「編集を開く」はそのまま)
    td.addEventListener('contextmenu', (ev) => {
      if (td.classList.contains('off')) return; // 日課で無効な校時には出さない
      ev.preventDefault();
      openCellContextMenu(weekStart, Number(td.dataset.day), td.dataset.period, ctx, ev.clientX, ev.clientY);
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

// 今日ビューの操作: 曜日チップ切替・コマのタップ編集(移動モード対応)・今日のメモ。
function wireDayView(root, weekStart, ctx) {
  root.querySelectorAll('.day-chip[data-daysel]').forEach(b => {
    b.addEventListener('click', () => { ctx.dayViewIdx = Number(b.dataset.daysel); ctx.rerender(); });
  });
  root.querySelectorAll('.day-period').forEach(li => {
    const act = () => {
      const day = Number(li.dataset.day);
      const period = li.dataset.period;
      if (ctx.swapSource) {
        const src = ctx.swapSource;
        ctx.swapSource = null;
        swapCells(weekStart, src, { day, period });
        ctx.rerender();
        return;
      }
      openCellEditor(weekStart, day, period, ctx);
    };
    li.addEventListener('click', act);
    li.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.target !== li) return;
      ev.preventDefault();
      act();
    });
  });
  const memo = root.querySelector('#dp-memo');
  if (memo) {
    memo.addEventListener('input', () => {
      const w = store.getWeek(weekStart, true);
      if (!Array.isArray(w.dayNotes)) w.dayNotes = ['', '', '', '', '', ''];
      w.dayNotes[Number(memo.dataset.day)] = memo.value;
      store.commit();
    });
  }
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

  // 専科で事前充填(担当教科入り)したエントリのid。ユーザー操作がないまま
  // 閉じた場合はcleanupで除去する(開いて閉じるだけで授業が登録されないように)
  const prefilled = new Set();

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
        e.scope = validScope(s, ctx.lastScope) ?? s.senkaClasses[0]?.id ?? null;
        // 担当教科も学級ID(validScope)と同様に実在チェック。削除済みキーを充填すると
        // そのコマの時数が集計・印刷・CSV・メールから無言で消えるため
        e.subjectKey = s.subjects.some(x => x.key === s.senkaSubject) ? s.senkaSubject : '';
        if (e.subjectKey) prefilled.add(e.id);
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
    associateLabels(modal); // 内部再描画でラベル関連付けが消えないように
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
      // 何らかのユーザー操作があったエントリは事前充填扱いを解除する(閉じても残す)
      const touch = () => prefilled.delete(entry.id);

      box.querySelectorAll('.subject-palette button').forEach(b => {
        b.onclick = () => {
          touch();
          entry.subjectKey = b.dataset.subj === entry.subjectKey ? '' : b.dataset.subj;
          if (entry.auto) entry.text = '';
          store.commit();
          render(modal);
          ctx.rerender();
        };
      });

      // 専科: 学級はボタンで1タップ選択。選んだ学級を次のコマの既定にする(再起動後も)
      box.querySelectorAll('[data-scope-btn]').forEach(b => {
        b.onclick = () => {
          touch();
          entry.scope = b.dataset.scopeBtn || null;
          ctx.lastScope = entry.scope;
          try { localStorage.setItem('shuan-last-scope', entry.scope || ''); } catch {}
          store.commit(); render(modal); ctx.rerender();
        };
      });

      // 複式: 直接/間接/ガイドの3択チップ(同じものを押すと解除)。
      // 片学年に「直」を付けたら、未設定の相方には「間」を自動補完(その逆も)
      box.querySelectorAll('[data-guide]').forEach(b => {
        b.onclick = () => {
          entry.guide = entry.guide === b.dataset.guide ? null : b.dataset.guide;
          if (cellNow.entries.length === 2 && (entry.guide === 'direct' || entry.guide === 'indirect')) {
            const other = cellNow.entries.find(x => x !== entry);
            if (other && !other.guide) other.guide = entry.guide === 'direct' ? 'indirect' : 'direct';
          }
          store.commit(); render(modal); ctx.rerender();
        };
      });

      const textArea = box.querySelector('[name="text"]');
      textArea.addEventListener('input', () => {
        touch();
        entry.text = textArea.value;
        entry.auto = textArea.value.trim() === '';
        store.commit();
      });
      textArea.addEventListener('change', () => ctx.rerender());

      const noteInput = box.querySelector('[name="note"]');
      noteInput.addEventListener('input', () => { touch(); entry.note = noteInput.value; store.commit(); });
      noteInput.addEventListener('change', () => ctx.rerender());

      // 項目別オーバーライド: ねらい/学習活動/評価規準を「このコマだけ」上書き
      box.querySelectorAll('.ov-input').forEach(ta => {
        ta.addEventListener('input', () => { touch(); setOverride(entry, ta.dataset.ov, ta.value); store.commit(); });
        ta.addEventListener('change', () => { render(modal); ctx.rerender(); });
      });
      box.querySelectorAll('[data-ov-reset]').forEach(b => {
        b.onclick = () => { touch(); setOverride(entry, b.dataset.ovReset, ''); store.commit(); render(modal); ctx.rerender(); };
      });
      box.querySelectorAll('[data-ov-vp] [data-vp]').forEach(b => {
        b.onclick = () => {
          touch();
          const planVp = b.closest('[data-ov-vp]')?.dataset.planVp || '';
          setOverrideViewpoint(entry, b.dataset.vp, planVp);
          store.commit(); render(modal); ctx.rerender();
        };
      });

      const resetBtn = box.querySelector('[data-reset-auto]');
      if (resetBtn) resetBtn.onclick = () => {
        entry.text = ''; entry.auto = true;
        store.commit(); render(modal); ctx.rerender();
      };

      const advChk = box.querySelector('[name="advance"]');
      advChk.onchange = () => {
        touch();
        const def = period?.type !== 'module';
        entry.advance = advChk.checked === def ? null : advChk.checked;
        store.commit(); ctx.rerender();
      };

      const ncChk = box.querySelector('[name="noCount"]');
      ncChk.onchange = () => { touch(); entry.noCount = ncChk.checked; store.commit(); ctx.rerender(); };

      const cancelChk = box.querySelector('[name="cancelled"]');
      cancelChk.onchange = () => {
        touch();
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
      fracSel.onchange = () => { touch(); entry.fraction = Number(fracSel.value); store.commit(); ctx.rerender(); };

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
        e.scope = validScope(s, ctx.lastScope) ?? s.senkaClasses[0]?.id ?? null;
        e.subjectKey = s.subjects.some(x => x.key === s.senkaSubject) ? s.senkaSubject : ''; // 実在チェック(ensureと同じ)
        if (e.subjectKey) prefilled.add(e.id); // 追加後に何も触らず閉じたら掃除する
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
      <button class="btn primary" data-close>閉じる</button>
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

  // 空のままのエントリは閉じるときに掃除する(冪等)。
  // 専科の事前充填エントリ(担当教科入り)も、ユーザー操作がなければ除去する
  // (空セルを開いて閉じるだけで授業が時数・進度に計上されないように)
  function cleanup() {
    const w = store.state.weeks[weekStart];
    const key = cellKey(dayIdx, periodId);
    const c = w?.cells?.[key];
    if (c) {
      c.entries = c.entries.filter(e =>
        (e.subjectKey && !prefilled.has(e.id)) || (e.text && !e.auto) || e.note || e.override);
      if (!c.entries.length) delete w.cells[key];
    }
    if (w && !Object.keys(w.cells).length && !w.goals && !w.reflection
      && !(w.events || []).some(Boolean)
      && !Object.keys(w.dayPatterns || {}).length
      && !(w.dayNotes || []).some(Boolean)
      && !(w.attendance || []).some(Boolean)) {
      delete store.state.weeks[weekStart];
    }
    store.commit();
    ctx.rerender();
    // 再描画でDOMが入れ替わるため、編集していたセルへフォーカスを戻す(キーボード操作の連続性)
    document.querySelector(`td.cell[data-day="${dayIdx}"][data-period="${CSS.escape(periodId)}"]`)?.focus();
  }
}

// ねらい/学習活動/評価規準 の「このコマだけ上書き」を entry.override に反映する。
// 空文字はキー削除(=計画に復帰)。何も残らなければ override=null。
function setOverride(entry, key, value) {
  const o = { ...(entry.override || {}) };
  const v = String(value);
  if (v.trim() === '') delete o[key];
  else o[key] = v;
  entry.override = Object.keys(o).length ? o : null;
}

// 観点(知/思/態)の上書き。同じ観点 or 計画と同じ観点を選んだら解除(計画に戻す)。
function setOverrideViewpoint(entry, code, planViewpoint) {
  const o = { ...(entry.override || {}) };
  const cur = ('viewpoint' in o) ? o.viewpoint : (planViewpoint || '');
  const next = (cur === code) ? '' : code;
  if (!next || next === (planViewpoint || '')) delete o.viewpoint;
  else o.viewpoint = next;
  entry.override = Object.keys(o).length ? o : null;
}

function entryEditorHTML(state, entry, idx, period, ordinals) {
  const s = state.settings;
  const { resolved, details } = resolveEntryPlanDetails(state, entry, ordinals);
  const isModule = period?.type === 'module';
  const effAdvance = entry.advance == null ? !isModule : !!entry.advance;

  const palette = s.subjects.map(x =>
    `<button data-subj="${esc(x.key)}" class="${x.key === entry.subjectKey ? 'selected' : ''}"
       aria-pressed="${x.key === entry.subjectKey}"
       style="background:${esc(x.color)}">${esc(x.short || x.name)}</button>`).join('');

  // 専科: 学級ボタン列(1タップ選択)
  let scopeField = '';
  if (s.mode === 'senka' && s.senkaClasses.length) {
    scopeField = `<div class="field"><label>学級</label>
      <div class="scope-palette">${s.senkaClasses.map(c =>
        `<button data-scope-btn="${esc(c.id)}" class="${entry.scope === c.id ? 'selected' : ''}"
          aria-pressed="${entry.scope === c.id}">${esc(c.label || '学級未設定')}</button>`).join('')}
      </div></div>`;
  }

  const isKnownGrade = typeof entry.scope === 'number' && s.fukushikiGrades.includes(entry.scope);
  let gradeHead = '';
  if (s.mode === 'fukushiki') {
    const guideChips = ['direct', 'indirect', 'guide'].map(g =>
      `<button data-guide="${g}" class="guide-btn g-${g} ${entry.guide === g ? 'selected' : ''}"
        aria-pressed="${entry.guide === g}">${guideLabel(g)}</button>`).join('');
    gradeHead = `<div class="grade-head">
      <span>${isKnownGrade ? `${entry.scope}年` : '学年未設定'}</span>
      <span class="guide-chips">${guideChips}${infoHTML('直=直接指導 間=間接指導(自力学習) ガ=ガイド学習。印刷に◎○△で出ます')}</span>
    </div>`;
  }

  const criteriaRows = details ? [
    ['知識・技能', details.unitCriteria.knowledge],
    ['思考・判断・表現', details.unitCriteria.thinking],
    ['主体的態度', details.unitCriteria.attitude],
  ].filter(([, value]) => value).map(([label, value]) =>
    `<div class="auto-plan-row"><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('') : '';
  // 構造化編集の対象。計画があれば details、無くても教科が決まっていれば空の枠を出して記録できるようにする。
  const ed = details || (entry.subjectKey ? {
    planless: true, unitName: '', unitHours: 0, nth: 0, unitGoal: '',
    objective: '', activity: '', assessment: '', viewpoint: '',
    planObjective: '', planActivity: '', planAssessment: '', planViewpoint: '',
    overridden: { objective: false, activity: false, assessment: false, viewpoint: false },
  } : null);

  // 1項目分の編集フィールド。計画値はプレースホルダ(薄字)、上書き時のみ実値を表示＋「変更」バッジ。
  const ovField = (key, label, planVal, effVal, isOv, extra = '') => `
    <div class="ov-field${isOv ? ' is-ov' : ''}">
      <div class="ov-flabel"><b>${label}</b>
        ${isOv
          ? `<span class="ov-badge">変更</span><button type="button" class="ov-reset" data-ov-reset="${key}">↺ 計画に戻す</button>`
          : (planVal ? '<span class="ov-asplan">計画どおり</span>' : '')}
      </div>
      <textarea class="ov-input" data-ov="${key}" rows="2"
        placeholder="${esc(planVal || '（計画に記載なし・自由に記録できます）')}">${isOv ? esc(effVal) : ''}</textarea>
      ${extra}
    </div>`;

  let autoBlock = '';
  if (ed) {
    const vp = ed.viewpoint || '';
    const vpSeg = `<div class="ov-vp" data-ov-vp data-plan-vp="${esc(ed.planViewpoint || '')}" role="group" aria-label="観点">
      ${['知', '思', '態'].map(code =>
        `<button type="button" data-vp="${code}" class="${vp === code ? 'selected' : ''}" aria-pressed="${vp === code}" title="${esc(VIEWPOINTS[code])}">${code}</button>`).join('')}
      <button type="button" data-vp="" class="ov-vp-none ${vp === '' ? 'selected' : ''}" aria-pressed="${vp === ''}">なし</button>
    </div>`;
    autoBlock = `<div class="ov-block">
      <div class="ov-head">
        ${ed.planless
          ? '<span class="ov-kicker">本時の記録</span><span class="ov-sub">年間計画に未登録のコマ</span>'
          : `<span class="ov-kicker">${entry.auto ? '年間指導計画' : '年間指導計画（参照）'}</span><strong>${esc(ed.unitName)}</strong>${ed.unitHours > 1 ? `<span class="ov-nth">${ed.nth}/${ed.unitHours}時</span>` : ''}`}
        <span class="ov-help">${infoHTML('計画どおりなら触らなくてOK。実際の授業に合わせて直した項目だけが「変更」として記録されます')}</span>
      </div>
      ${ovField('objective', '本時のねらい', ed.planObjective, ed.objective, ed.overridden.objective)}
      ${ovField('activity', '学習活動', ed.planActivity, ed.activity, ed.overridden.activity)}
      ${ovField('assessment', '評価規準', ed.planAssessment, ed.assessment, ed.overridden.assessment,
        `<div class="ov-vprow"><span class="ov-vplabel">観点${ed.overridden.viewpoint ? '<span class="ov-badge">変更</span>' : ''}</span>${vpSeg}</div>`)}
      ${(details && (details.unitGoal || criteriaRows)) ? `<details class="auto-unit-details"><summary>単元全体の目標・評価規準</summary>
        ${details.unitGoal ? `<div class="auto-plan-item"><b>単元の目標</b><span>${esc(details.unitGoal)}</span></div>` : ''}
        ${criteriaRows ? `<dl class="auto-criteria">${criteriaRows}</dl>` : ''}
      </details>` : ''}
    </div>`;
  } else if (entry.auto && resolved.text) {
    autoBlock = `<div class="auto-preview"><span class="label">自動反映</span>${esc(resolved.text)}</div>`;
  } else if (entry.auto && !state.plans.length && idx === 0) {
    autoBlock = '<div class="auto-preview muted">年間指導計画を登録すると、ここに単元・内容が自動で入ります</div>';
  }

  // 既定値から変わっている項目があるときだけ「詳細」を開いておく
  const advOpen = (entry.fraction ?? 1) !== 1 || entry.advance != null || entry.noCount || entry.cancelled;

  // 選択済みの教科・学級を先頭1行に出し、パレットは「変更」で開く(編集の常用導線を短く)
  const subj = subjectOf(s, entry.subjectKey);
  const scopeLabel = s.mode === 'senka' ? scopeLabelOf(s, entry.scope) : '';
  const scopeSet = s.mode !== 'senka' || (entry.scope != null && entry.scope !== '' && s.senkaClasses.some(c => c.id === entry.scope));
  const hasSelection = !!entry.subjectKey && scopeSet;
  const selSummary = entry.subjectKey
    ? `${subj ? `<span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span><span class="sel-name">${esc(subj.name)}</span>` : ''}`
      + (s.mode === 'senka' ? (scopeLabel ? `<span class="sel-scope">${esc(scopeLabel)}</span>` : `<span class="sel-scope warn">学級未設定</span>`) : '')
    : '<span class="sel-name muted">教科を選ぶ</span>';

  // 複式では学年別パレットを折りたたみ(共通パレットが主)。担任・専科は教科+学級を「変更」で開く
  const paletteBlock = s.mode === 'fukushiki'
    ? `<details ${entry.subjectKey ? '' : 'open'}><summary class="fold-label">この学年の教科を変える</summary>
        <div class="subject-palette" style="margin-top:6px;">${palette}</div></details>`
    : `<details class="cell-select" ${hasSelection ? '' : 'open'}>
        <summary class="cell-select-summary">${selSummary}<span class="change-tag">変更</span></summary>
        <div class="field" style="margin-top:8px;"><label>教科</label><div class="subject-palette">${palette}</div></div>
        ${scopeField}
      </details>`;

  const manualField = `<div class="field">
        <label>内容 ${!entry.auto ? '<button class="btn small ghost" data-reset-auto>↺ 自動に戻す</button>' : ''}</label>
        <textarea name="text" placeholder="${esc(resolved.auto && resolved.text ? resolved.text : '')}">${entry.auto ? '' : esc(entry.text)}</textarea>
      </div>`;
  // 構造化編集がある場合、全文差し替えは「上級」として折りたたむ(主導線は項目別編集)
  const manualBlock = ed
    ? `<details class="manual-fold" ${!entry.auto ? 'open' : ''}><summary class="fold-label">1行表示を丸ごと書き換える（上級）${infoHTML('週案グリッドの1行表示を、年間計画と切り離して自由文に置き換えます。通常は上の項目編集で十分です')}</summary>${manualField}</details>`
    : manualField;

  return `
    <div data-entry="${idx}" class="entry-editor">
      ${gradeHead}
      ${paletteBlock}
      ${s.mode === 'fukushiki' ? scopeField : ''}
      ${autoBlock}
      ${manualBlock}
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
  if (!chips) return ''; // 当週が未入力なら見出しだけの空パネルを出さない
  return `<div class="panel" style="padding:10px 16px;">
    <span style="font-size:12.5px; font-weight:700; color:#374151; margin-right:10px;">今週の時数</span>${chips}
  </div>`;
}
