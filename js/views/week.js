/** 週案編集ビュー(グリッド・セル編集・連続入力・前週コピー・行事・反省) */

import { store, newEntry, cellKey, effectivePeriod, computeOrdinals, resolveEntryText, resolveEntryPlanDetails, computeHours, fmtHours, breakNameOf, noSchoolReason, weekDayOffsets, termRanges, VIEWPOINTS, scopeGrade, isActivity, cellHasUserEdits, cellHasLock, cellHasActivity, entryMatchesScope } from '../store.js';
import { fmtDate, parseDate, addDays, fmtMD, mondayOf, weekNumberInFiscalYear, fiscalYearOf, fiscalYearFirstMonday, DAY_NAMES, esc, uid } from '../utils.js';
import { holidayName } from '../holidays.js';
import { openModal, toast, confirmDialog, selectHTML, openResultLink, infoHTML, associateLabels } from '../ui.js';
import { icon } from '../icons.js';

/**
 * 基本時間割がある週を開いたとき、その週がまだ空なら自動で時間割＋計画内容を配置する。
 * 毎週の反映操作を不要にする。開いた週だけ・授業が無いときだけ生成し、
 * 祝日・長期休業・非授業日は除く(skipNoSchool)。設定 autoLayout=false で無効化。
 * 通知(commit)は使わず persist 直書きで保存し、描画中の再描画ループを避ける。
 */
function autoMaterializeWeek(weekStart) {
  if (!store.hasBaseTimetable) return false;
  if (store.state.settings.autoLayout === false) return false;
  const existed = !!store.state.weeks[weekStart];
  const w = store.state.weeks[weekStart];
  if (w?.cleared) return false; // 明示的にクリアした週は自動補完で戻さない(週クリア・日クリアが効くように)
  // 授業が1つでも入っていれば触らない。予定(会議・自習・授業なし等)だけの週は他の空きを自動で埋める
  // (=「状況によって自動判断」: まっさら/予定だけ→空きを埋める、授業あり→そのまま)。既存の予定は流し込みが避ける。
  if (w && Object.values(w.cells).some(c => c?.entries?.some(e => !isActivity(e)))) return false;
  const res = store.applyBaseTimetable(weekStart, null, { skipNoSchool: true, fillEmptyOnly: true, commit: false });
  if (res.placed) { store.persist(); return true; } // 自動作成した
  if (!existed) delete store.state.weeks[weekStart]; // 0コマ(全休等)なら空週を残さない
  return false;
}

export function renderWeekView(root, ctx) {
  const state = store.state;
  const s = state.settings;
  const weekStart = ctx.getWeekStart();
  const monday = parseDate(weekStart);
  const justMaterialized = autoMaterializeWeek(weekStart); // 空き週なら基本時間割＋計画を自動配置(毎週の反映操作を不要に)
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
  // 専科: 表示する学級の絞り込み(グリッド・印刷で1学級だけ見る/出す)。担当に無い学級IDは無視。
  const classFilter = (s.mode === 'senka' && s.senkaClasses.length > 1
    && s.senkaClasses.some(c => c.id === localStorage.getItem('shuan-class-filter')))
    ? localStorage.getItem('shuan-class-filter') : '';
  ctx.classFilter = classFilter; // renderCell が読む(グリッドの絞り込み)

  // 提出トラッキング: 週案は毎週提出が義務の学校が多い。今週以前で授業があるのに未提出なら注意を促す。
  const wkObj = store.state.weeks[weekStart];
  const hasLessons = !!wkObj && Object.values(wkObj.cells).some(c => c.entries?.some(e => e.subjectKey));
  const submittedAt = wkObj?.submittedAt;
  const submitDue = hasLessons && weekStart <= fmtDate(mondayOf(new Date())); // 今週以前で授業あり
  const submitChip = submittedAt
    ? `<button class="submit-chip done" id="wk-submit" title="週案を提出したかの目印です（時数・印刷は変わりません）。クリックで「未提出」に戻す">✓ 提出済 ${fmtMD(new Date(submittedAt))}</button>`
    : submitDue
      ? `<button class="submit-chip due" id="wk-submit" title="週案を提出したかの目印です（時数・印刷は変わりません）。まだの週は赤く出ます。クリックで「提出済み」に">未提出</button>`
      : '';

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
          aria-label="${DAY_NAMES[d]}曜日 ${fmtMD(date)} の一括操作${makeup ? ' 授業日' : ''}">
        <div class="day-head ${d === 5 ? 'sat' : ''} ${d === 6 ? 'sun' : ''} ${hol ? 'holiday-mark' : ''} ${isToday ? 'today' : ''} ${brk || isOff ? 'in-break' : ''} ${makeup ? 'makeup-day' : ''}">
          <span class="dow">${DAY_NAMES[d]}<span class="day-caret">▾</span></span>
          <span class="date">${fmtMD(date)}</span>
          ${hol ? `<span class="hol-name">${esc(hol)}</span>` : brk ? `<span class="brk-name">${esc(brk)}</span>` : isOff ? `<span class="brk-name">休業日</span>` : makeup ? `<span class="makeup-name" title="本来は${esc(makeup)}(授業日に設定)">授業日</span>` : ''}
        </div>
      </th>`);
  }
  const breakBanner = breakDays === dayCount
    ? `<div class="mode-banner" style="background:#f0f9ff; border-color:#7dd3fc; color:#075985;">${esc(breakLabel)}の週です</div>` : '';
  // この週が基本時間割＋計画から自動作成されたとき、初回だけ仕組みを説明する
  const autoFillHint = (justMaterialized && localStorage.getItem('shuan-seen-autofill') !== '1')
    ? `<div class="mode-banner auto-fill-hint">${icon('refresh')}<span>この週は<b>基本時間割と年間指導計画から自動作成</b>しました。授業に合わせて直し、ずれたら「⋯ → 計画に合わせて更新」。骨組みは「設定 → 基本時間割」で変えられます。</span><button class="btn small" id="wk-autofill-ok">わかった</button></div>` : '';
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
          <span class="p-label" data-rename-period="${esc(p.id)}" role="button" tabindex="0" title="クリックで名前を変更(朝学習→朝の会 など)">${esc(p.label)}</span>
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
      <div class="oc-step"><span class="oc-num">2</span>1週間できたら <button class="btn small" id="oc-base">基本時間割に登録</button>（次の週から自動で並びます）</div>
      <div class="oc-step"><span class="oc-num">3</span><button class="btn small" id="oc-plans">年間計画</button> を入れると本時（ねらい等）が自動表示</div>
      <div class="oc-step"><span class="oc-num">4</span><button class="btn small" id="oc-print">印刷</button> して提出</div>
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
            <button class="btn small ghost" id="wk-review">振り返り一覧</button>
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

  // 専科の学級フィルタ(週グリッド・印刷を1学級に絞る)。週ビューでのみ操作。
  const classFilterBar = (s.mode === 'senka' && s.senkaClasses.length > 1 && viewMode === 'week') ? `
    <div class="class-filter" role="group" aria-label="表示する学級">
      <span class="cf-label">学級で絞る</span>
      <button class="cf-chip ${!classFilter ? 'selected' : ''}" data-cf="" aria-pressed="${!classFilter}">全学級</button>
      ${s.senkaClasses.map(c => `<button class="cf-chip ${classFilter === c.id ? 'selected' : ''}" data-cf="${esc(c.id)}" aria-pressed="${classFilter === c.id}">${esc(c.label || c.id)}</button>`).join('')}
      ${classFilter ? infoHTML('選んだ学級だけをグリッドと印刷に表示します。印刷すると学級別の週案になります。「全学級」で解除') : ''}
    </div>` : '';

  root.innerHTML = `
    <div class="week-nav">
      <div class="wn-move">
        <button class="btn" id="wk-prev" aria-label="前の週">◀</button>
        <button class="btn" id="wk-today">今週</button>
        <button class="btn" id="wk-next" aria-label="次の週">▶</button>
      </div>
      <span class="week-title">${fmtMD(monday)} 〜 ${fmtMD(addDays(monday, days[days.length - 1]))}
        <span class="week-no">第${weekNo}週</span>
      </span>
      ${submitChip}
      <input type="date" id="wk-date" value="${weekStart}" aria-label="表示する週の日付">
      <span class="spacer"></span>
      <div class="wn-actions">
        <span class="view-toggle" role="group" aria-label="表示の切り替え">
          <button class="vt-btn ${viewMode === 'day' ? 'active' : ''}" id="wk-view-day" aria-pressed="${viewMode === 'day'}" title="今日の授業だけを縦に表示(スマホ・すきま記録向き)">日</button>
          <button class="vt-btn ${viewMode === 'week' ? 'active' : ''}" id="wk-view-week" aria-pressed="${viewMode === 'week'}" title="1週間をまとめて表示">週</button>
        </span>
        ${viewMode === 'week' ? `<button class="btn" id="wk-density" aria-pressed="${density === 'detail'}" title="学習活動・評価規準の表示を切り替え">${density === 'detail' ? '詳細表示' : '簡潔表示'}</button>
        ${!store.hasBaseTimetable ? `<button class="btn ${paint.open ? 'active' : ''}" id="wk-paint" aria-pressed="${paint.open}" title="教科を選び、コマを次々クリックして同じ教科を配置(もう一度で消去・Escで終了)">${icon('pencil')}まとめて配置</button>` : ''}` : ''}
        ${!store.hasBaseTimetable ? infoHTML('まず「設定 → 基本時間割」で骨組み（毎週の教科の並び）を作ると、週を開くだけで前週からの進度を引き継いで自動で流し込みます') : ''}
        <details class="menu">
        <summary class="btn" aria-label="その他">⋯</summary>
        <div class="menu-items">
          <div class="menu-group-label">週の操作</div>
          <button class="btn ghost menu-item" id="wk-copy">${icon('clipboard')}前週をコピー</button>
          ${viewMode === 'week' ? `<span style="display:flex; align-items:center;">
            <button class="btn ghost menu-item" id="wk-weekend" style="flex:1;">${icon('calendar')}土日の列を出す</button>
            ${infoHTML('日曜参観・運動会など、この週に土日の授業・行事があるとき列を出します')}
          </span>` : ''}
          <button class="btn ghost menu-item" id="wk-import">${icon('flag')}行事を取り込み…</button>
          ${store.hasBaseTimetable ? `<div class="menu-group-label">計画から</div>
          <span style="display:flex; align-items:center;">
            <button class="btn ghost menu-item" id="wk-restore" style="flex:1;">${icon('calendar')}基本時間割から復元…</button>
            ${infoHTML('空きコマ（消したコマ）に、基本時間割の授業（教科・学級）を入れ直します。入力済み・予定・ロックには触れません')}
          </span>
          <span style="display:flex; align-items:center;">
            <button class="btn ghost menu-item" id="wk-generate" style="flex:1;">${icon('refresh')}計画に合わせて更新…</button>
            ${infoHTML('設定済みのコマの本時を、年間指導計画どおりに戻します。教科や学年で絞れます。入力済みも計画に戻ります（守るには🔒ロック）')}
          </span>` : ''}
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
    </div>
    ${autoFillHint}
    ${breakBanner}
    ${classFilterBar}
    ${paintBar}
    ${ctx.swapSource ? `<div class="mode-banner">⇄ 移動中${ctx.swapSource.weekStart && ctx.swapSource.weekStart !== weekStart ? `（${fmtMD(parseDate(ctx.swapSource.weekStart))}の週から）` : ''} — ${ctx.swapSource.weekStart && ctx.swapSource.weekStart !== weekStart ? 'この週' : '他の週へも移せます。'}移動先のコマをクリック
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
    // 活動(会議・委員会・クラブ等。教科なし・時数に数えない)は淡色のメモ表示で授業と区別する
    if (isActivity(e)) {
      return `<div class="entry activity">${icon('memo')}<span class="e-activity-name">${esc(e.unitName || '予定')}</span>${e.note ? `<div class="e-note">${esc(e.note)}</div>` : ''}</div>`;
    }
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
    const pinned = e.pin ? `<span class="e-flag" style="color:#7c3aed;" title="この時間にやる本時を選んで指定(進度は進めない・同じ本時の再実施も可)">本時指定</span>` : '';
    const offplan = e.offplan ? `<span class="e-flag" style="color:#0369a1;" title="計画外(復習・テスト・予備など。進度は進みません)">計画外</span>` : '';
    const lockFlag = e.locked ? `<span class="e-flag e-lock" title="ロック中: 計画に合わせて更新しても守られます">${icon('lock')}</span>` : '';
    // この学年の年間計画が無い授業コマ(本時が空のまま)に気づけるよう控えめに示す
    const noPlan = e.subjectKey && !details && !e.cancelled && !e.pin && !e.offplan
      ? `<span class="e-flag warn" title="この学年の年間指導計画が未登録です。本時を手入力するか、年間計画で取り込んでください">計画なし</span>` : '';
    // 単元の進度を●●○のドット(または長単元はミニバー)で一目に
    const progress = !e.cancelled ? unitProgressHTML(details?.nth, details?.unitHours) : '';
    return `
      <div class="entry ${e.cancelled ? 'cancelled' : ''} ${e.locked ? 'locked' : ''}">
        <div class="e-head">
          ${subj ? `<span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>` : ''}
          ${scopeLabel ? `<span class="e-scope">${esc(scopeLabel)}</span>` : ''}
          ${guide}${frac}${unsetClass}${changed}${pinned}${offplan}${lockFlag}${noPlan}
          ${e.cancelled ? `<span class="e-flag" style="color:#dc2626;" title="${e.cancelledReason ? '中止: ' + esc(e.cancelledReason) : '中止'}">中止${e.cancelledReason ? '・' + esc(e.cancelledReason) : ''}</span>` : e.noCount ? `<span class="e-flag">時数外</span>` : ''}
          ${!e.cancelled && e.endUnit ? `<span class="e-flag" style="color:#15803d;" title="この時間で単元を終え、次のコマから次の単元へ">単元終</span>` : ''}
          ${progress}
        </div>
        ${text ? `<div class="e-text ${resolved.auto ? '' : 'manual'}">${esc(text)}</div>` : ''}
        ${!e.cancelled && details?.activity ? `<div class="e-plan-line"><span>活</span>${esc(details.activity)}</div>` : ''}
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

  // 非授業日の判定。振替授業日(classDays)は授業日扱い(週グリッドと統一)。
  const ds = fmtDate(date);
  const isClassDay = (s.classDays || []).includes(ds);
  const hol = (!isClassDay && s.showHolidays) ? holidayName(date) : null;
  const brk = isClassDay ? null : breakNameOf(s, ds);
  const off = !isClassDay && (s.offDays || []).includes(ds);
  const nsReason = hol || brk || (off ? '休業日' : '');
  const nsType = hol ? 'holiday' : brk ? 'break' : off ? 'off' : '';
  const noSchool = !!nsReason;

  const status = periodTimeStatus(s.periods, isToday);
  const items = s.periods.map(p => {
    if (!effectivePeriod(s, week, dayViewIdx, p)) return '';
    const cell = week.cells?.[cellKey(dayViewIdx, p.id)];
    const entries = cell?.entries || [];
    const st = status[p.id] || '';
    // 非授業日の空きコマは「＋」を出さない(週グリッドと統一。授業を入れる場所に見せない)
    const body = entries.length
      ? renderEntriesHTML(state, entries, ordinals)
      : (noSchool ? '' : `<div class="dp-empty">＋ タップして授業を入れる</div>`);
    const flag = st === 'now' ? '<span class="dp-now">いま</span>' : st === 'next' ? '<span class="dp-next">次</span>' : '';
    return `<li class="day-period ${st} ${entries.length ? '' : 'is-empty'}" data-day="${dayViewIdx}" data-period="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(p.label)} ${entries.length ? '' : '空き'}">
      <div class="dp-time"><span class="dp-label">${esc(p.label)}</span>${p.start ? `<span class="dp-clock">${esc(p.start)}</span>` : ''}${flag}</div>
      <div class="dp-body">${body}</div>
    </li>`;
  }).join('');

  const ev = String(week.events?.[dayViewIdx] || '').trim();
  const memo = esc(week.dayNotes?.[dayViewIdx] || '');
  const banner = hol ? `<div class="day-banner hol">${esc(hol)}</div>`
    : brk ? `<div class="day-banner brk">${esc(brk)}</div>`
    : off ? '<div class="day-banner brk">休業日</div>' : '';

  // 非授業日で授業が無ければ、空のコマ列でなく「休み」を明確に出す(授業がある=振替などは通常表示)
  const hasEntries = s.periods.some(p => week.cells?.[cellKey(dayViewIdx, p.id)]?.entries?.length);
  const listHTML = (nsReason && !hasEntries)
    ? `<div class="day-noschool ns-${nsType}"><span class="dn-ic">${icon(hol ? 'flag' : brk ? 'sun' : 'leaf')}</span><b>${esc(nsReason)}</b><span class="dn-sub">この日は授業がありません</span></div>`
    : `<ol class="day-list">${items || `<li class="day-empty"><span class="de-ic">${icon('cup')}</span>この日は授業がありません</li>`}</ol>`;

  return `
    <div class="day-switch" role="tablist">${chips.join('')}</div>
    <div class="day-title-row">
      <h2 class="day-title">${fmtMD(date)}（${DAY_NAMES[dayViewIdx]}）${isToday ? '<span class="day-today-badge">今日</span>' : ''}</h2>
      <button class="btn small ghost" data-day-ops="${dayViewIdx}" aria-label="この日の操作">⋯ この日の操作</button>
    </div>
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
  const allEntries = cell?.entries || [];
  // 学級フィルタ中は対象学級のコマだけ表示(他学級のコマは隠す。データは消さない)
  const entries = ctx.classFilter ? allEntries.filter(e => (e.scope ?? '') === ctx.classFilter) : allEntries;
  const hiddenOther = ctx.classFilter && allEntries.length && !entries.length; // 他学級だけが入っている
  const isModule = period.type === 'module';
  // 非授業日の空きコマ: フラットな淡色のみ(理由=祝日名はヘッダーに1度だけ。セルでは繰り返さない)。
  // 「＋」は出さない(授業を入れる場所に見せない)。授業・活動が入っていれば通常表示。
  // フィルタで隠れた他学級のコマがある場合も「＋」は出さない(空きと誤認させない)。
  const inner = entries.length
    ? renderEntriesHTML(state, entries, ordinals)
    : (noSchool || hiddenOther) ? '' : `<div class="cell-empty">＋</div>`;
  const onlyActivity = entries.length > 0 && entries.every(isActivity); // 会議・委員会・自習・授業なし等のみ=淡い面で表示
  const draggable = entries.length > 0 && !ctx.paint.subject;
  const isSwapSrc = ctx.swapSource && (ctx.swapSource.weekStart == null || ctx.swapSource.weekStart === week.start) && ctx.swapSource.day === dayIdx && ctx.swapSource.period === period.id;
  // キーボード操作用のアクセシブルネーム(例: 「月曜1校時 国語」)
  const subjNames = entries.map(e => isActivity(e) ? e.unitName : subjectOf(s, e.subjectKey)?.name).filter(Boolean).join('・');
  const ariaLabel = `${DAY_NAMES[dayIdx]}曜${period.label}${isModule ? '' : '校時'}${noSchool ? ` ${noSchool.reason}` : ''} ${subjNames || '空き'}`;
  return `
    <td class="cell ${nsClass} ${onlyActivity ? 'activity-cell' : ''} ${isModule ? 'module-cell' : ''} ${isSwapSrc ? 'drag-over' : ''} ${isToday ? 'today-col' : ''}"
        data-day="${dayIdx}" data-period="${esc(period.id)}" ${draggable ? 'draggable="true"' : ''}
        tabindex="0" role="button" aria-label="${esc(ariaLabel)}">
      ${inner}
      ${entries.length ? `<button class="cell-clear" aria-label="削除" data-clear>×</button>` : ''}
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
  // 提出トラッキング: この週の週案を提出済み/未提出に切り替える(印刷=提出が多いので印刷後にも押せる位置)
  root.querySelector('#wk-submit')?.addEventListener('click', () => {
    const w = store.getWeek(fmtDate(monday), true);
    const on = !w.submittedAt;
    w.submittedAt = on ? Date.now() : null;
    store.commit(); ctx.rerender();
    toast(on ? '提出済みにしました' : '提出を取り消しました', 'info', 2200);
  });
  const dateInput = root.querySelector('#wk-date');
  dateInput.onchange = (ev) => {
    if (ev.target.value) ctx.setWeekStart(ev.target.value);
  };
  // 狭い画面では日付入力を隠し、週タイトルのタップで日付ピッカーを開く(ヘッダー圧迫を避ける)
  root.querySelector('.week-title')?.addEventListener('click', () => {
    try { dateInput.showPicker(); } catch { dateInput.focus(); }
  });

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

  // 専科の学級フィルタ(チップ): 選んだ学級だけをグリッド・印刷に表示
  root.querySelectorAll('.class-filter [data-cf]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.cf || '';
      if (v) localStorage.setItem('shuan-class-filter', v);
      else localStorage.removeItem('shuan-class-filter');
      ctx.rerender();
    });
  });

  // 計画から(基本時間割からの穴埋め／計画に合わせて更新)の共通部品
  const periodTargets = () => {
    const fy = fiscalYearOf(addDays(monday, 3));
    const terms = termRanges(store.settings, fy);
    const here = fmtDate(monday);
    const term = terms.find(t => t.from <= here && here <= t.to) || terms[terms.length - 1];
    const monthEnd = fmtDate(new Date(monday.getFullYear(), monday.getMonth() + 1, 0));
    return { here, term, monthEnd, yearEnd: `${fy + 1}-03-31` };
  };
  const targetButtonsHTML = (t) => `
    <div class="field"><label>対象</label>
    <div class="choice-list">
      <button class="btn primary" data-to="${t.here}">この週だけ</button>
      <button class="btn" data-to="${t.term.to}">今週〜学期末(${fmtMD(parseDate(t.term.to))})</button>
      <button class="btn" data-to="${t.monthEnd}">今週〜今月末(${fmtMD(parseDate(t.monthEnd))})</button>
      <button class="btn" data-to="${t.yearEnd}">今週〜年度末(3/31)</button>
      <div style="display:flex; gap:8px; align-items:center;">
        <input type="date" id="gen-to" value="${t.term.to}" style="flex:1;">
        <button class="btn" data-to-input>この日まで</button>
      </div>
    </div></div>`;
  // 基本時間割が複数あれば「どの時間割で?」を挟んでから run(toDate, baseId)
  const pickBaseAndRun = (toDate, run) => {
    const bases = store.state.baseTimetables;
    if (bases.length <= 1) return run(toDate, null);
    openModal(`<h2>どの時間割で?</h2>
      <div class="choice-list">${bases.map(b => `<button class="btn" data-base="${esc(b.id)}">${esc(b.name)}</button>`).join('')}</div>
      <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>`,
      (m, close) => { m.querySelector('[data-cancel]').onclick = close; m.querySelectorAll('[data-base]').forEach(b => b.onclick = () => { close(); run(toDate, b.dataset.base); }); });
  };

  // 基本時間割から復元(穴埋め): 空きコマに教科・学級を入れ直す
  const restoreBtn = root.querySelector('#wk-restore');
  if (restoreBtn) restoreBtn.onclick = () => {
    const t = periodTargets();
    const run = (toDate, baseId) => {
      store.snapshot('基本時間割から復元');
      const res = store.restoreRangeFromBase(t.here, fmtDate(mondayOf(parseDate(toDate))), baseId);
      if (!res.placed) { toast('入れ直せる空きコマがありませんでした', 'info', 3500); return; }
      toast(`${res.weeks}週・${res.placed}コマを基本時間割から入れました`, 'info', 4000, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      ctx.rerender();
    };
    openModal(`
      <h2>基本時間割から復元</h2>
      <p class="hint">空きコマ（消したコマ）に、基本時間割の授業（教科・学級）を入れ直します。<br><b>入力済み・予定（会議など）・🔒ロックには触れません。</b></p>
      ${targetButtonsHTML(t)}
      <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelectorAll('[data-to]').forEach(b => b.onclick = () => { close(); pickBaseAndRun(b.dataset.to, run); });
      modal.querySelector('[data-to-input]').onclick = () => {
        const v = modal.querySelector('#gen-to').value;
        if (!v) { toast('日付を選んでください', 'error'); return; }
        close(); pickBaseAndRun(v, run);
      };
    });
  };

  // 計画に合わせて更新: 設定済みコマの本時を年間計画に戻す(教科/学年/学級で絞れる)
  const genBtn = root.querySelector('#wk-generate');
  if (genBtn) genBtn.onclick = () => {
    const t = periodTargets();
    const s2 = store.settings;
    // 絞り込みセレクタ(担任=教科 / 専科=学年・学級 / 複式=学年)
    const scopeOpts = (() => {
      if (s2.mode === 'fukushiki') return '<option value="">全学年</option>' + (s2.fukushikiGrades || []).map(g => `<option value="grade:${g}">${g}年</option>`).join('');
      if (s2.mode === 'senka') {
        const grades = [...new Set((s2.senkaClasses || []).map(c => scopeGrade(s2, c.id)).filter(Boolean))].sort((a, b) => a - b);
        return '<option value="">全学級</option>' + grades.map(g => `<optgroup label="${g}年"><option value="grade:${g}">${g}年すべて</option>${(s2.senkaClasses || []).filter(c => scopeGrade(s2, c.id) === g).map(c => `<option value="scope:${esc(c.id)}">${esc(c.label || c.id)}</option>`).join('')}</optgroup>`).join('');
      }
      return '<option value="">全教科</option>' + (s2.subjects || []).map(x => `<option value="subj:${esc(x.key)}">${esc(x.name)}</option>`).join('');
    })();
    const parseScope = (val) => { if (!val) return null; const [k, v] = val.split(':'); return k === 'subj' ? { subjectKey: v } : k === 'scope' ? { scopeId: v } : k === 'grade' ? { grade: Number(v) } : null; };
    // 計画に戻ると中身が変わる「手を入れた授業コマ(絞り込み内)」と守る「ロック・予定」を数える
    const countAffected = (toWeek, scope) => {
      let edits = 0, kept = 0;
      const hasPlan = (e) => store.state.plans.some(p => p.subjectKey === e.subjectKey && (p.grade == null || p.grade === scopeGrade(s2, e.scope)));
      for (let m = mondayOf(parseDate(t.here)); fmtDate(m) <= toWeek; m = addDays(m, 7)) {
        const w = store.state.weeks[fmtDate(m)];
        if (!w) continue;
        for (const cell of Object.values(w.cells || {})) {
          if (cellHasLock(cell) || cellHasActivity(cell)) kept++;
          else if (cellHasUserEdits(cell) && cell.entries.some(e => e.subjectKey && hasPlan(e) && entryMatchesScope(store.state, e, scope))) edits++;
        }
      }
      return { edits, kept };
    };
    const run = async (toDate, baseId, scope) => {
      const toWeek = fmtDate(mondayOf(parseDate(toDate)));
      const { edits, kept } = countAffected(toWeek, scope);
      if (edits > 0) {
        const tail = kept ? `🔒ロック・予定の ${kept}コマと、空きコマは触りません。` : '🔒ロック・予定・空きコマは触りません。';
        const ok = await confirmDialog(`手を入れた ${edits}コマ(●変更・手入力・中止など)も計画に戻します。${tail}よろしいですか?`, { okLabel: '計画に戻す', danger: true });
        if (!ok) return;
      }
      store.snapshot('計画に合わせて更新');
      const res = store.generateRange(t.here, toWeek, baseId, scope);
      if (!res.weeks) { toast('対象のコマがありませんでした', 'info', 3500); return; }
      toast(`${res.weeks}週・${res.conformed}コマを計画に戻しました`, 'info', 4000, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      ctx.rerender();
    };
    openModal(`
      <h2>計画に合わせて更新</h2>
      <p class="hint">設定済みのコマの本時を、年間指導計画どおりに戻します。<br><b>空きコマ（消したコマ）・予定（会議など）・🔒ロックは触りません。</b>手を入れたコマも計画に戻ります（戻したくないコマは🔒ロック）。</p>
      <div class="field"><label>対象を絞る（任意）</label><select id="gen-scope" style="width:100%;">${scopeOpts}</select></div>
      ${targetButtonsHTML(t)}
      <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>
    `, (modal, close) => {
      // 「計画に合わせて更新」は年間指導計画ベース=基本時間割に依存しないので、時間割選択は挟まない
      const go = (toDate) => { const scope = parseScope(modal.querySelector('#gen-scope')?.value || ''); close(); run(toDate, null, scope); };
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelectorAll('[data-to]').forEach(b => b.onclick = () => go(b.dataset.to));
      modal.querySelector('[data-to-input]').onclick = () => {
        const v = modal.querySelector('#gen-to').value;
        if (!v) { toast('日付を選んでください', 'error'); return; }
        go(v);
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

  // 行事を取り込み: 年間行事(一覧/CSV)とGoogleカレンダー(今週)を1つの入口に統合。
  root.querySelector('#wk-import').onclick = () => {
    if (!ctx.gas.configured) { openEventsImport(ctx); return; } // GAS未設定なら年間行事の取り込みへ直行
    openModal(`
      <h2>行事を取り込み</h2>
      <p class="hint">どこから取り込みますか？</p>
      <div class="choice-list">
        <button class="btn" data-imp="annual">${icon('flag')}年間行事から（一覧で選ぶ）</button>
        <button class="btn" data-imp="gcal">${icon('calendar')}Googleカレンダーから（今週）</button>
      </div>
      <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-cancel]').onclick = close;
      modal.querySelector('[data-imp="annual"]').onclick = () => { close(); openEventsImport(ctx); };
      modal.querySelector('[data-imp="gcal"]').onclick = () => { close(); importGoogleWeekEvents(); };
    });
  };
  root.querySelector('#wk-review').onclick = () => openReviewList(ctx);

  const kidsBtn = root.querySelector('#wk-kids-print');
  if (kidsBtn) kidsBtn.onclick = async () => {
    const { printKidsLetter } = await import('../print.js');
    printKidsLetter(fmtDate(monday));
  };

  root.querySelector('#wk-autofill-ok')?.addEventListener('click', () => {
    try { localStorage.setItem('shuan-seen-autofill', '1'); } catch {}
    root.querySelector('.auto-fill-hint')?.remove();
  });

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
    store.makeBackup('週クリアの前', { force: true }); // 後で気づいても復元できるよう、消す前に控える
    store.snapshot('週のクリア');
    // 週を消すと自動補完で戻ってしまうため、空にして「クリア済み」印を付ける(自動補完が避ける)
    const w = store.state.weeks[to];
    w.cells = {}; w.events = ['', '', '', '', '', '']; w.dayNotes = ['', '', '', '', '', '']; w.attendance = ['', '', '', '', '', ''];
    w.dayPatterns = {}; w.goals = ''; w.reflection = ''; w.managerNote = ''; w.submittedAt = null;
    w.cleared = true;
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

  const importGoogleWeekEvents = async () => {
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
      // 終日の行事(運動会・遠足など)で授業が潰れた日は、日付の⋯→「この日を中止」で1タップ繰り下げできる。
      // 取り込み時に一括中止を問うのはやめた:「終日でも授業はある」行事(読書週間・教育相談旬間など)にも
      // 誤って中止を勧めてしまうため。判断は教員に委ね、潰れた日だけ静かに案内する。
      const allDayHit = [...new Set(target.filter(ev => !ev.time).map(ev => ev.idx))].some(idx =>
        store.settings.periods.some(p => (week.cells[cellKey(idx, p.id)]?.entries || []).some(e => e.subjectKey && !e.cancelled)));
      const msg = (dup ? `取り込み${n}件・登録済み${dup}件` : `${n}件を取り込みました`)
        + (allDayHit ? '（終日の行事で潰れた日は、日付の⋯→「この日を中止」で繰り下げできます）' : '');
      toast(msg, 'info', allDayHit ? 5600 : 3200, n ? { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } } : null);
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
    store.snapshot('まとめて配置の消去');
    delete w.cells[key];
    store.commit();
    ctx.rerender();
    toast('配置を消しました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    return true;
  }
  // 既に何か入っているセルは通常の編集を開く(誤破壊防止)
  if (entries.length) return false;

  store.snapshot('まとめて配置'); // 配置にも復元点を残す(Ctrl+Z/⌘Zで戻せるように。配置前は戻せなかった)
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
  root.querySelector('#oc-base').onclick = () => saveWeekAsBase(fmtDate(monday), ctx);
  root.querySelector('#oc-plans')?.addEventListener('click', () => document.querySelector('.tab[data-tab="plans"]')?.click());
  root.querySelector('#oc-print').onclick = async () => {
    const { printWeek } = await import('../print.js');
    printWeek(fmtDate(monday));
  };
}

function wireDayMenu(root, ctx, monday, weekStart, dayCount) {
  // 日単位の一括操作。週グリッドの曜日見出し と 日ビューの「この日の操作」ボタンの両方から開く。
  const open = (d) => {
      const date = addDays(monday, d);
      const dateStr = fmtDate(date);
      const label = `${fmtMD(date)}(${DAY_NAMES[d]})`;
      // 日種別の対称トグル: 通常日↔非授業日(offDay)、祝日/休業/週末↔振替授業日(classDay)
      const isClassDay = (store.settings.classDays || []).includes(dateStr);
      const isOff = (store.settings.offDays || []).includes(dateStr);
      const noSchoolR = noSchoolReason(store.settings, dateStr); // classDay考慮済み(振替ならnull)
      let dayToggle;
      if (isClassDay) {
        dayToggle = { act: 'classday', icon: 'refresh', title: '授業日を解除(休みに戻す)', desc: 'この日を本来の休み(祝日・休業など)に戻します' };
      } else if (isOff) {
        dayToggle = { act: 'offday', icon: 'refresh', title: '非授業日を解除', desc: 'この日を授業日に戻します' };
      } else if (noSchoolR) {
        dayToggle = { act: 'classday', icon: 'book', title: '授業日にする', desc: `${noSchoolR}ですが授業日として扱います(日曜参観・運動会など)。基本時間割の自動配置・時数集計の対象になります` };
      } else {
        dayToggle = { act: 'offday', icon: 'stop', title: '非授業日にする', desc: '開校記念日・振替休業・学級閉鎖など。自動配置や「計画に合わせて更新」で授業が入りません' };
      }
      const dayLocked = store.settings.periods.some(p => (store.state.weeks[weekStart]?.cells?.[cellKey(d, p.id)]?.entries || []).some(e => e.locked));
      openModal(`
        <h2>${esc(label)} の一括操作</h2>
        <div class="day-ops">
          <button class="btn day-op" data-act="cancel-all"><span class="op-ic">${icon('ban')}</span><span class="op-tx"><b>この日を中止（以降を繰り下げ）</b><small>行事などでこの日が潰れたとき。計画どおりのコマは自動で後ろにずれます（手入力・別の本時にしたコマはそのまま）</small></span></button>
          <button class="btn day-op" data-act="cancel-from"><span class="op-ic">${icon('ban')}</span><span class="op-tx"><b>○校時以降を中止…</b><small>午後だけ・特定の校時から潰れたとき。選んだ校時から後ろを中止し繰り下げます</small></span></button>
          ${d > 0 ? `<button class="btn day-op" data-act="copy-prev"><span class="op-ic">${icon('clipboard')}</span><span class="op-tx"><b>前日をコピー</b><small>前日の時間割をこの日に複製します</small></span></button>` : ''}
          ${store.hasBaseTimetable ? `<button class="btn day-op" data-act="restore-base"><span class="op-ic">${icon('calendar')}</span><span class="op-tx"><b>基本時間割から復元</b><small>この日の空きコマに、基本時間割の授業を入れ直します（入力済みは触りません）</small></span></button>` : ''}
          <button class="btn day-op" data-act="${dayLocked ? 'unlock-day' : 'lock-day'}"><span class="op-ic">${icon('lock')}</span><span class="op-tx"><b>${dayLocked ? 'この日のロックを解除' : 'この日をロック'}</b><small>「計画に合わせて更新」しても、この日のコマは上書きされず守られます</small></span></button>
          <button class="btn day-op" data-act="${dayToggle.act}"><span class="op-ic">${icon(dayToggle.icon)}</span><span class="op-tx"><b>${dayToggle.title}</b><small>${dayToggle.desc}</small></span></button>
          <button class="btn day-op danger" data-act="clear"><span class="op-ic">${icon('trash')}</span><span class="op-tx"><b>この日を削除</b><small>この日の入力をすべて削除します</small></span></button>
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
              toast(nowClass ? '授業日にしました' : '授業日を解除しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.toggleClassDay(dateStr); ctx.rerender(); } });
              ctx.rerender();
              return;
            }
            if (act === 'cancel-from') {
              // どの校時から中止するかを選ぶ(午後だけ潰れた等)。選んだ校時から後ろを中止し、以降の計画コマが繰り下がる
              const ws = store.getWeek(weekStart, true);
              const valid = store.settings.periods.filter(p => effectivePeriod(store.settings, ws, d, p) && p.type !== 'module');
              modal.querySelector('h2').textContent = `${label}：どの校時から中止しますか?`;
              modal.querySelector('.day-ops').innerHTML = valid.length
                ? valid.map(p => `<button class="btn day-op" data-from="${esc(p.id)}"><span class="op-ic">${icon('ban')}</span><span class="op-tx"><b>${esc(p.label)}校時 以降を中止</b></span></button>`).join('')
                : '<p class="hint">中止できる校時がありません</p>';
              modal.querySelectorAll('[data-from]').forEach(fb => {
                fb.onclick = () => {
                  const fromIdx = store.settings.periods.findIndex(p => p.id === fb.dataset.from);
                  const state = store.state;
                  const ordinals = computeOrdinals(state, weekStart);
                  store.snapshot(`${label}の途中中止`);
                  let n = 0;
                  for (let pi = fromIdx; pi < store.settings.periods.length; pi++) {
                    const cell = ws.cells[cellKey(d, store.settings.periods[pi].id)];
                    if (!cell) continue;
                    let hit = false;
                    for (const e of cell.entries) {
                      if (e.cancelled || !e.subjectKey) continue;
                      e.cancelledText = resolveEntryText(state, e, ordinals).text;
                      e.cancelled = true; hit = true;
                    }
                    if (hit) n++;
                  }
                  store.commit(); close();
                  toast(`${label}: ${n}コマを中止しました（以降を繰り下げ）`, 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
                  ctx.rerender();
                };
              });
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
              w.cleared = true; // この日を消した=明示クリア。全曜日消しても自動補完で戻さない
            } else if (act === 'copy-prev') {
              for (const p of store.settings.periods) {
                const src = w.cells[cellKey(d - 1, p.id)];
                if (!src) continue;
                const dst = w.cells[cellKey(d, p.id)];
                if (cellHasLock(dst) || cellHasActivity(dst) || cellHasUserEdits(dst)) continue; // ロック・予定・手編集は守る
                w.cells[cellKey(d, p.id)] = {
                  entries: src.entries.map(e => ({ ...e, id: uid(), text: '', auto: true, note: '', cancelled: false, cancelledText: '', cancelledReason: '', locked: false })),
                };
                n++;
              }
            } else if (act === 'lock-day' || act === 'unlock-day') {
              const on = act === 'lock-day';
              for (const p of store.settings.periods) {
                const cell = w.cells[cellKey(d, p.id)];
                if (!cell?.entries?.length) continue;
                for (const e of cell.entries) e.locked = on;
                n++;
              }
            } else if (act === 'restore-base') {
              n = store.restoreDayFromBase(weekStart, d, null, false); // 空きコマだけ復元(commitは下で1回)
            }
            // 復元で0コマなら commit せず終了(無駄な保存・無意味な「元に戻す」を出さない)
            if (act === 'restore-base' && n === 0) { close(); toast('入れ直せる空きコマがありませんでした', 'info', 3000); return; }
            store.commit();
            close();
            toast(act === 'restore-base' ? `${label}: ${n}コマを基本時間割から入れました` : `${label}: ${n}コマを処理しました`,
              'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
            ctx.rerender();
          };
        });
      });
  };
  root.querySelectorAll('.day-th').forEach(th => {
    const d = Number(th.dataset.day);
    th.addEventListener('click', () => open(d));
    // キーボード操作(Enter/Space)でも一括操作メニューを開けるように
    th.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      open(d);
    });
  });
  // 日ビュー(スマホ既定)の「この日の操作」ボタン → 同じ一括操作メニュー
  const dayOpsBtn = root.querySelector('[data-day-ops]');
  if (dayOpsBtn) dayOpsBtn.addEventListener('click', () => open(Number(dayOpsBtn.dataset.dayOps)));
}

// ---------------------------------------------------------------- セルの右クリック・クイック操作

// PC向けアクセラレータ。主クリック(編集を開く)はそのまま、右クリックで頻出操作を即出しする。
function openCellContextMenu(weekStart, dayIdx, periodId, ctx, x, y) {
  closeCellContextMenu();
  const cell = store.state.weeks[weekStart]?.cells?.[cellKey(dayIdx, periodId)];
  const entries = cell?.entries || [];
  const hasEntries = entries.length > 0;
  const onlyActivity = hasEntries && entries.every(isActivity); // 会議・委員会等のみ
  const hasClip = Array.isArray(ctx.cellClipboard) && ctx.cellClipboard.length > 0;
  const anyCancelled = hasEntries && entries.some(e => e.cancelled);
  const anyLocked = hasEntries && entries.some(e => e.locked);

  const s = store.settings;
  const state = store.state;
  const lessonEntries = entries.filter(e => e.subjectKey && !isActivity(e));
  // 「計画どおりに戻す」を出すか: 手直し(override)・別本時(pin)・計画外(offplan)・切り上げ(endUnit)のうち
  // どれかがあり、かつ戻れる計画がある授業コマのときだけ(planlessな手書きはクリアと役割が被るので出さない)。
  const hasPlanFor = (e) => state.plans.some(p => p.subjectKey === e.subjectKey && (p.grade == null || p.grade === scopeGrade(s, e.scope)));
  const canResetToPlan = lessonEntries.some(e => (e.override || e.pin || e.offplan || e.endUnit) && hasPlanFor(e));
  // 「ここで単元を切り上げる」: 計画どおりモードの単元途中(モジュール以外)の1コマだけ。残りコマ数を添える(自転車操業のズレ調整)。
  const period = s.periods.find(p => p.id === periodId);
  let endUnitRemain = 0;
  if (lessonEntries.length === 1) {
    const e0 = lessonEntries[0];
    if (!e0.offplan && !e0.pin && !e0.endUnit && period && period.type !== 'module') {
      const { details } = resolveEntryPlanDetails(state, e0, computeOrdinals(state, weekStart));
      if (details && details.unitHours > 1 && details.nth < details.unitHours) endUnitRemain = details.unitHours - details.nth;
    }
  }
  // 時数外トグルの現在状態(全コマが時数外なら「時数に含める」を出す)
  const allNoCount = lessonEntries.length > 0 && lessonEntries.every(e => e.noCount);

  const acts = [{ ic: 'pencil', label: '編集', run: () => openCellEditor(weekStart, dayIdx, periodId, ctx) }];
  // 空きコマ: 会議・委員会などの予定をその場でドロップ(担任/専科のみ。エディタが開いて名前を入れられる)。
  if (!hasEntries && s.mode !== 'fukushiki') acts.push({ ic: 'memo', label: '予定・活動にする…', run: () => openCellEditor(weekStart, dayIdx, periodId, ctx, { asActivity: true }) });
  // 基本時間割から復元(削除の逆): 空きはまるごと、設定済みは不足学級だけ。追加対象があるときだけ出す。
  if (store.hasBaseTimetable && !onlyActivity) {
    const blabel = store.baseRestoreLabel(weekStart, dayIdx, periodId);
    if (blabel) acts.push({ ic: 'calendar', label: `基本時間割から入れる（${blabel}）`, run: () => restoreCellFromBaseQuick(weekStart, dayIdx, periodId, ctx) });
  }
  if (hasEntries) acts.push({ ic: 'clipboard', label: 'コピー', run: () => { ctx.cellClipboard = entries.map(e => ({ ...e })); toast('コマをコピーしました', 'info', 1800); } });
  if (hasClip) acts.push({ ic: 'download', label: '貼り付け', run: () => pasteCellQuick(weekStart, dayIdx, periodId, ctx) });
  if (hasEntries) acts.push({ ic: 'refresh', label: '移動', run: () => { ctx.swapSource = { weekStart, day: dayIdx, period: periodId }; ctx.rerender(); } });
  // 授業コマ(1コマ): この時間にやる本時を選ぶ(別の単元の本時・同じ本時の再実施。進度は進めない)
  if (lessonEntries.length === 1) acts.push({ ic: 'book', label: '本時を選ぶ…', run: () => openPinPicker(weekStart, dayIdx, periodId, ctx) });
  // 単元途中で予定より早く終わったとき、ここで単元を締めて残りを飛ばす(1タップ)
  if (endUnitRemain > 0) acts.push({ ic: 'flag', label: `ここで単元を切り上げる（残り${endUnitRemain}コマ）`, run: () => endUnitHereQuick(weekStart, dayIdx, periodId, ctx) });
  // 手直し/別本時/計画外/切り上げを一括で計画どおりへ(ズレ調整の核。1タップで戻せる)
  if (canResetToPlan) acts.push({ ic: 'undo', label: '計画どおりに戻す', run: () => resetCellToPlanQuick(weekStart, dayIdx, periodId, ctx) });
  // 予定・活動コマ: 会議などを授業に戻す(担任/専科のみ。エディタで教科を選べる)
  if (onlyActivity && s.mode !== 'fukushiki') acts.push({ ic: 'book', label: '授業に変える…', run: () => openCellEditor(weekStart, dayIdx, periodId, ctx, { asLesson: true }) });
  // 時数外トグル: テスト監督・自習監督などこの時間を授業時数に数えないコマに(授業コマのみ。中止中は無意味なので出さない)
  if (lessonEntries.length && !anyCancelled) acts.push({ ic: 'clock', label: allNoCount ? '時数に含める' : '時数外にする', run: () => toggleNoCountCellQuick(weekStart, dayIdx, periodId, ctx) });
  if (hasEntries) acts.push({ ic: 'lock', label: anyLocked ? 'ロック解除' : 'ロック', run: () => toggleLockCellQuick(weekStart, dayIdx, periodId, ctx) });
  if (hasEntries && !onlyActivity) acts.push({ ic: 'ban', label: anyCancelled ? '中止を解除' : '中止にする', run: () => toggleCancelCellQuick(weekStart, dayIdx, periodId, ctx) });
  // 破壊系は下にまとめて区切り線で分ける。語彙はエディタと統一(クリア=中身を空に / 削除=コマごと消す)。赤は「削除」だけ。
  if (hasEntries) acts.push({ sep: true });
  if (hasEntries && !onlyActivity) acts.push({ ic: 'eraser', label: 'クリア', run: () => clearCellContentQuick(weekStart, dayIdx, periodId, ctx) });
  if (hasEntries) acts.push({ ic: 'trash', label: '削除', danger: true, run: () => deleteCellQuick(weekStart, dayIdx, periodId, ctx) });

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = acts.map((a, i) => a.sep
    ? '<div class="cm-sep" role="separator"></div>'
    : `<button class="cm-item ${a.danger ? 'danger' : ''}" data-cm="${i}" role="menuitem">${icon(a.ic)}${a.label}</button>`).join('');
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
  // キーボードだけで操作できるように: ↑↓で項目移動(循環)・Home/Endで端へ・Escで閉じる(Enter/Spaceはボタン既定)。
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeCellContextMenu(); return; }
    const items = [...menu.querySelectorAll('.cm-item')];
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(cur + 1 + items.length) % items.length].focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(cur - 1 + items.length) % items.length].focus(); }
    else if (ev.key === 'Home') { ev.preventDefault(); items[0].focus(); }
    else if (ev.key === 'End') { ev.preventDefault(); items[items.length - 1].focus(); }
  };
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

// 基本時間割からこの空きコマを復元する(削除の逆操作)。
function restoreCellFromBaseQuick(weekStart, dayIdx, periodId, ctx) {
  store.snapshot('基本時間割から復元');
  if (!store.restoreCellFromBase(weekStart, dayIdx, periodId)) { toast('基本時間割にこのコマはありません', 'error', 2600); return; }
  ctx.rerender();
  toast('基本時間割から入れました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// この時間にやる本時を選ぶ(別単元の本時・同じ本時の再実施)。pinを設定。進度は進めない。
function openPinPicker(weekStart, dayIdx, periodId, ctx) {
  const cell = store.getCell(weekStart, dayIdx, periodId);
  const entry = (cell?.entries || []).find(e => e.subjectKey && !isActivity(e));
  if (!entry) return;
  const grade = scopeGrade(store.settings, entry.scope);
  const plan = store.state.plans.find(p => p.subjectKey === entry.subjectKey && (p.grade == null || p.grade === grade));
  const units = plan?.units || [];
  if (!units.length) { toast('この教科の年間指導計画に単元がありません', 'error', 3000); return; }
  const curUnit = entry.pin ? String(entry.pin.unitId) : '';
  const unitOpts = '<option value="">単元を選ぶ…</option>'
    + units.map(u => `<option value="${esc(u.id)}" ${curUnit === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  openModal(`
    <h2>本時を選ぶ</h2>
    <p class="hint">この時間にやる本時を選びます。年間計画の順番（他コマ）は変わりません。同じ本時をもう一度でもOK。</p>
    <div class="up-body"><label class="up-label">単元</label><select id="pp-unit">${unitOpts}</select>
      <label class="up-label">本時</label><select id="pp-lesson"></select></div>
    <div class="modal-foot"><button class="btn" data-cancel>キャンセル</button><button class="btn primary" data-ok disabled>この本時にする</button></div>
  `, (modal, close) => {
    const unitSel = modal.querySelector('#pp-unit');
    const lessonSel = modal.querySelector('#pp-lesson');
    const okBtn = modal.querySelector('[data-ok]');
    const fillLessons = () => {
      const u = units.find(x => String(x.id) === unitSel.value);
      if (!u) { lessonSel.innerHTML = ''; okBtn.disabled = true; return; }
      const h = Math.max(1, Math.round(u.hours || u.lessons?.length || 1));
      const curNth = entry.pin && String(entry.pin.unitId) === String(u.id) ? (entry.pin.nth || 1) : 1;
      lessonSel.innerHTML = Array.from({ length: h }, (_, i) => {
        const o = u.lessons?.[i]?.objective || u.lessons?.[i]?.text || '';
        return `<option value="${i + 1}" ${curNth === i + 1 ? 'selected' : ''}>${i + 1}時${o ? '：' + esc(String(o).slice(0, 20)) : ''}</option>`;
      }).join('');
      okBtn.disabled = false;
    };
    if (unitSel.value) fillLessons();
    unitSel.onchange = fillLessons;
    modal.querySelector('[data-cancel]').onclick = close;
    okBtn.onclick = () => {
      if (!unitSel.value) return;
      store.snapshot('本時を選ぶ');
      entry.pin = { unitId: unitSel.value, nth: Number(lessonSel.value) || 1 };
      entry.offplan = false;
      store.commit(); close(); ctx.rerender();
      toast('本時を指定しました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    };
  });
}

function pasteCellQuick(weekStart, dayIdx, periodId, ctx) {
  if (!Array.isArray(ctx.cellClipboard) || !ctx.cellClipboard.length) return;
  const s = store.settings;
  const w = store.getWeek(weekStart, true);
  const key = cellKey(dayIdx, periodId);
  const isMulti = s.mode === 'senka' || s.mode === 'fukushiki';
  // ロック=「更新で守る」約束に従い、貼り付けでも守る(担任=コマ全体／専科・複式=学級単位は下でスキップ)
  if (!isMulti && cellHasLock(w.cells[key])) { toast('ロック中のコマには貼り付けできません（先にロック解除を）', 'info', 3000); return; }
  store.snapshot('コマの貼り付け');
  const fresh = ctx.cellClipboard.map(e => ({ ...e, id: uid(), cancelled: false, cancelledText: '', cancelledReason: '', locked: false }));
  // 専科・複式は学級/学年(scope)でコマを区別する。貼り付けはセル全体を上書きせず、
  // 同じscopeのコマだけ置き換えて他学級のコマは残す(専科で「貼り付けたら別クラスが消えた」事故を防ぐ)。
  if (isMulti) {
    const cell = w.cells[key] || (w.cells[key] = { entries: [] });
    if (!Array.isArray(cell.entries)) cell.entries = [];
    for (const e of fresh) {
      const i = cell.entries.findIndex(x => (x.scope ?? null) === (e.scope ?? null));
      if (i >= 0) { if (cell.entries[i].locked) continue; cell.entries[i] = e; } else cell.entries.push(e); // ロック中の学級は据え置き
    }
  } else {
    w.cells[key] = { entries: fresh };
  }
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
    else { e.cancelled = false; e.cancelledText = ''; e.cancelledReason = ''; }
  }
  store.commit();
  ctx.rerender();
  toast(turningOn ? '中止にしました' : '中止を解除しました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// 今週を基本時間割(骨組み)に登録。設定→基本時間割「今週から作る」と同じ操作。
// 初回オンボーディング(1週間できたら登録)から呼ぶ。2件目以降は上書き/名前付き追加を聞く。
function saveWeekAsBase(weekStart, ctx) {
  if (!store.state.weeks[weekStart] || !Object.keys(store.state.weeks[weekStart].cells).length) {
    toast('まだ時間割が入力されていません', 'error');
    return;
  }
  const bases = store.state.baseTimetables;
  if (!bases.length) {
    store.saveAsBaseTimetable(weekStart);
    toast('基本時間割に登録しました');
    ctx.rerender();
    return;
  }
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
      b.onclick = () => { store.saveAsBaseTimetable(weekStart, b.dataset.over); toast(`「${b.dataset.over}」を更新しました`); close(); ctx.rerender(); };
    });
    const newBtn = modal.querySelector('[data-new]');
    if (newBtn) newBtn.onclick = () => {
      const name = modal.querySelector('#base-name').value.trim() || `${'ABC'[bases.length]}週`;
      if (store.saveAsBaseTimetable(weekStart, name)) { toast(`「${name}」として登録しました`); close(); ctx.rerender(); }
    };
  });
}

// 削除=このコマ(授業・活動)を消して空きに戻す(また流し込みで埋まりうる)。× ボタン・右クリック「削除」用。
function deleteCellQuick(weekStart, dayIdx, periodId, ctx) {
  const w = store.getWeek(weekStart, true);
  store.snapshot('コマを削除');
  delete w.cells[cellKey(dayIdx, periodId)];
  store.commit(); ctx.rerender();
  toast('削除しました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// 手直し(override)・別本時(pin)・計画外(offplan)・切り上げ(endUnit)を一括で解除し、
// 年間指導計画どおりへ戻す(教科・学級・時数・中止・ロックは触らない=「内容のズレだけ計画に戻す」)。
function resetCellToPlanQuick(weekStart, dayIdx, periodId, ctx) {
  const cell = store.getCell(weekStart, dayIdx, periodId);
  const targets = (cell?.entries || []).filter(e => e.subjectKey && !isActivity(e) && (e.override || e.pin || e.offplan || e.endUnit));
  if (!targets.length) return;
  store.snapshot('計画どおりに戻す');
  for (const e of targets) { e.override = null; e.pin = null; e.offplan = false; e.endUnit = false; }
  store.commit();
  ctx.rerender();
  toast('計画どおりに戻しました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// 単元を予定より早く終えたとき、このコマで締めて残りの計画コマを飛ばす(endUnit)。右クリック用。
function endUnitHereQuick(weekStart, dayIdx, periodId, ctx) {
  const cell = store.getCell(weekStart, dayIdx, periodId);
  const e = (cell?.entries || []).find(x => x.subjectKey && !isActivity(x) && !x.offplan && !x.pin);
  if (!e) return;
  store.snapshot('単元を切り上げる');
  e.endUnit = true;
  store.commit();
  ctx.rerender();
  toast('この時間で単元を切り上げました（残りのコマを飛ばします）', 'info', 2800, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// 授業コマを「時数外」にする/戻す(テスト監督・自習監督などこの時間を授業時数に数えないとき)。右クリック用。
function toggleNoCountCellQuick(weekStart, dayIdx, periodId, ctx) {
  const cell = store.getCell(weekStart, dayIdx, periodId);
  const targets = (cell?.entries || []).filter(e => e.subjectKey && !isActivity(e));
  if (!targets.length) return;
  const turningOn = !targets.every(e => e.noCount); // 一部でも時数内ならまず全部を時数外へ
  store.snapshot(turningOn ? '時数外にする' : '時数に含める');
  for (const e of targets) e.noCount = turningOn;
  store.commit();
  ctx.rerender();
  toast(turningOn ? '時数外にしました（この時間は時数に数えません）' : '時数に含めました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// 本時の中身を空にする(教科・学級は残す)。右クリック「クリア」用。
function clearCellContentQuick(weekStart, dayIdx, periodId, ctx) {
  const cell = store.getCell(weekStart, dayIdx, periodId);
  if (!cell?.entries?.length) return;
  store.snapshot('本時の中身をクリア');
  clearCellContent(cell);
  store.commit(); ctx.rerender();
  toast('本時の中身を空にしました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// このコマをロック/解除(「計画に合わせて更新」で守られる)
function toggleLockCellQuick(weekStart, dayIdx, periodId, ctx) {
  const w = store.getWeek(weekStart, true);
  const cell = w.cells?.[cellKey(dayIdx, periodId)];
  if (!cell?.entries?.length) return;
  const turningOn = !cell.entries.some(e => e.locked);
  store.snapshot(turningOn ? 'コマをロック' : 'ロック解除');
  for (const e of cell.entries) e.locked = turningOn;
  store.commit();
  ctx.rerender();
  toast(turningOn ? 'ロックしました(更新で守られます)' : 'ロックを解除しました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
}

// 校時の表示名を変更する(朝学習・朝の会・朝読書など学校の呼び方に合わせる)。
// labelは週案・印刷の表示すべてを駆動するので、ここを変えれば全画面に反映される。
function openRenamePeriod(periodId, ctx) {
  const s = store.settings;
  const p = s.periods.find(x => x.id === periodId);
  if (!p) return;
  openModal(`
    <h2>表示名を変更</h2>
    <p class="hint">${p.type === 'module'
      ? '朝学習・朝の会・朝読書・モジュールなど、学校の呼び方に合わせて自由に変えられます。'
      : 'この校時の表示名を変えます(例: 1 / 1限 / 朝)。'}週案・印刷の表示に反映されます。</p>
    <div class="field"><label>表示名</label>
      <input type="text" id="rn-label" value="${esc(p.label)}" maxlength="12" autocomplete="off"></div>
    <div class="modal-foot">
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-save>保存</button>
    </div>
  `, (modal, close) => {
    const input = modal.querySelector('#rn-label');
    input.focus(); input.select();
    const save = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      if (v === p.label) { close(); return; }
      p.label = v;
      store.commit();
      close();
      ctx.rerender();
      toast('表示名を変更しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    };
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-save]').onclick = save;
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
  });
}

// ---------------------------------------------------------------- セル操作

function wireCells(root, weekStart, ctx) {
  closeCellContextMenu(); // 再描画で古いメニューが残らないように
  // 校時ラベル(左端「朝学習」等)をクリック→その場で表示名を変更(学校ごとの呼び名に対応)
  root.querySelectorAll('.p-label[data-rename-period]').forEach(el => {
    const open = () => openRenamePeriod(el.dataset.renamePeriod, ctx);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
  });
  root.querySelectorAll('td.cell').forEach(td => {
    td.addEventListener('click', (ev) => {
      if (td.classList.contains('off')) return;
      if (ev.target.closest('[data-clear]')) return;
      const day = Number(td.dataset.day);
      const period = td.dataset.period;
      if (ctx.swapSource) {
        const src = ctx.swapSource;
        const crossWeek = src.weekStart && src.weekStart !== weekStart;
        ctx.swapSource = null;
        const ok = swapCells(src.weekStart || weekStart, src, weekStart, { day, period });
        ctx.rerender();
        if (ok && crossWeek) toast(`${fmtMD(parseDate(src.weekStart))}の週から移動しました`, 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
        return;
      }
      // 連続入力モード
      if (ctx.paint.open) {
        if (paintCell(weekStart, day, period, ctx)) return;
      }
      openCellEditor(weekStart, day, period, ctx);
    });
    // キーボード操作: Enter/Space で編集を開く(WCAG 2.1.1)。矢印キーでグリッド内のセルを移動する。
    // 左右端まで来たら preventDefault せずグローバルの週送り(←/→)へ委ねる=端から隣の週へ自然につながる。
    // 上下端はスクロール抑止のみ。これで「セルにフォーカス→矢印で隣のコマ」が素直に効く(週が飛ばない)。
    const ARROW_DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    td.addEventListener('keydown', (ev) => {
      if (ev.target !== td) return; // セル内のボタン(×等)のキー操作はそのまま
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); td.click(); return; }
      const d = ARROW_DIRS[ev.key];
      if (!d || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
      const table = td.closest('table');
      const periods = store.settings.periods.map(p => String(p.id));
      let day = Number(td.dataset.day);
      let pi = periods.indexOf(String(td.dataset.period));
      const [dx, dy] = d;
      // 最大ステップで次のフォーカス可能セルを探す(日課で無効な校時=offは飛ばす)
      for (let step = 0; step < periods.length + 7; step++) {
        day += dx; pi += dy;
        if (pi < 0 || pi >= periods.length || day < 0 || day > 6) break;
        const cand = table && table.querySelector(`td.cell[tabindex="0"][data-day="${day}"][data-period="${CSS.escape(periods[pi])}"]`);
        if (cand) { ev.preventDefault(); ev.stopPropagation(); cand.focus(); return; }
      }
      if (dy !== 0) ev.preventDefault(); // 上下端: スクロール抑止のみ(週送りは左右だけ)
    });
    // コピー/カット/貼り付け(Ctrl/⌘ + C/X/V): フォーカス中のコマを対象に。右クリックメニューと同じ仕組み(ctx.cellClipboard)。
    td.addEventListener('keydown', (ev) => {
      if (ev.target !== td) return;
      if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k !== 'c' && k !== 'x' && k !== 'v') return;
      const day = Number(td.dataset.day), period = td.dataset.period;
      const cell = store.getCell(weekStart, day, period);
      const hasEntries = !!cell?.entries?.length;
      const refocus = () => requestAnimationFrame(() => document.querySelector(`td.cell[data-day="${day}"][data-period="${CSS.escape(period)}"]`)?.focus());
      if (k === 'c') {
        if (!hasEntries) return;
        ev.preventDefault();
        ctx.cellClipboard = cell.entries.map(e => ({ ...e }));
        toast('コマをコピーしました', 'info', 1600);
      } else if (k === 'x') {
        if (!hasEntries) return;
        ev.preventDefault();
        ctx.cellClipboard = cell.entries.map(e => ({ ...e }));
        const w = store.getWeek(weekStart, true);
        store.snapshot('コマを切り取り');
        delete w.cells[cellKey(day, period)];
        store.commit(); ctx.rerender(); refocus();
        toast('切り取りました（別のコマに貼り付けできます）', 'info', 2200, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      } else if (k === 'v') {
        if (!Array.isArray(ctx.cellClipboard) || !ctx.cellClipboard.length) return;
        ev.preventDefault();
        pasteCellQuick(weekStart, day, period, ctx); refocus();
      }
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
        deleteCellQuick(weekStart, Number(td.dataset.day), td.dataset.period, ctx);
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
      swapCells(weekStart, src, weekStart, { day: td.dataset.day, period: td.dataset.period }); // ドラッグは週内のみ
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
        const crossWeek = src.weekStart && src.weekStart !== weekStart;
        ctx.swapSource = null;
        const ok = swapCells(src.weekStart || weekStart, src, weekStart, { day, period });
        ctx.rerender();
        if (ok && crossWeek) toast(`${fmtMD(parseDate(src.weekStart))}の週から移動しました`, 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
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
// コマの中身を入れ替える(空の移動先なら実質「移動」)。他の週へも移動できる(fromとtoの週が違ってよい)。
function swapCells(fromWeekStart, from, toWeekStart, to) {
  const s = store.settings;
  const wFrom = store.getWeek(fromWeekStart, true);
  const wTo = store.getWeek(toWeekStart, true);
  const fromP = s.periods.find(p => p.id === String(from.period));
  const toP = s.periods.find(p => p.id === String(to.period));
  if (!fromP || !toP
    || !effectivePeriod(s, wFrom, Number(from.day), fromP)
    || !effectivePeriod(s, wTo, Number(to.day), toP)) {
    toast('この日の日課にない校時です', 'error');
    return false;
  }
  const kFrom = cellKey(from.day, from.period);
  const kTo = cellKey(to.day, to.period);
  if (fromWeekStart === toWeekStart && kFrom === kTo) return false;
  store.snapshot('コマの移動');
  const a = wFrom.cells[kFrom], b = wTo.cells[kTo];
  if (a) wTo.cells[kTo] = a; else delete wTo.cells[kTo];   // 移動元 → 移動先
  if (b) wFrom.cells[kFrom] = b; else delete wFrom.cells[kFrom]; // 移動先にあった分 → 移動元(空なら移動元は空に)
  store.commit();
  return true;
}

// ---------------------------------------------------------------- セル編集モーダル

// 予定・活動(会議・委員会・クラブ・自習など)でよく使うもの。ワンタップで入れられる(自由入力も可)。
// 「授業なし」は廃止: 空けたい校時は「削除(空きに戻す)」で十分(自動展開は空の週だけが対象なので、
// 一度埋まった週で1コマ消しても入れ直されない)。予定=会議等の実体があるものだけに絞る。
const MEMO_PRESETS = ['会議', '委員会', 'クラブ', '面談', '出張', '研修', '自習'];

export function openCellEditor(weekStart, dayIdx, periodId, ctx, opts = {}) {
  const s = store.settings;
  const period = s.periods.find(p => p.id === periodId);
  const monday = parseDate(weekStart);
  const date = addDays(monday, dayIdx);
  const title = `${fmtMD(date)}(${DAY_NAMES[dayIdx]}) ${period?.label || ''}${period?.type === 'module' ? '' : '校時'}`;

  // 「取り消す」用に、開いた時点のセル状態を控える(編集を破棄してこの状態へ戻せる)
  const editKey = cellKey(dayIdx, periodId);
  const openCellJSON = JSON.stringify(store.state.weeks[weekStart]?.cells?.[editKey] ?? null);
  let discarded = false;
  let closeModal = null; // 本文内ボタン(移動など)から閉じるために setup で受け取る

  // 専科で事前充填(担当教科入り)したエントリのid。ユーザー操作がないまま
  // 閉じた場合はcleanupで除去する(開いて閉じるだけで授業が登録されないように)
  const prefilled = new Set();

  const ensureLesson = () => {
    const w = store.getWeek(weekStart, true);
    const key = cellKey(dayIdx, periodId);
    if (!w.cells[key]) w.cells[key] = { entries: [] };
    const cell = w.cells[key];
    // 既定の源は「その曜日・校時の基本時間割」。本来そこにある教科・学級を入れる(消して再追加でも正しく戻る・
    // 担任=その校時の教科/専科=正しい学級/複式=両学年の教科。モードに自動で適合)。
    // 基本時間割に無い校時(専科の担当外など)は、従来の推測(直前に触った学級)へフォールバック。
    const baseLessons = (store.state.baseTimetables?.[0]?.cells?.[key]?.entries || []).filter(e => e.subjectKey && !isActivity(e));
    if (s.mode === 'fukushiki') {
      for (const g of s.fukushikiGrades) {
        if (cell.entries.some(e => e.scope === g)) continue;
        const e = newEntry();
        e.scope = g;
        const bl = baseLessons.find(b => b.scope === g);
        if (bl?.subjectKey) { e.subjectKey = bl.subjectKey; prefilled.add(e.id); }
        cell.entries.push(e);
      }
      cell.entries.sort((a, b) => (a.scope || 0) - (b.scope || 0));
    } else if (!cell.entries.length) {
      if (baseLessons.length) {
        for (const bl of baseLessons) {                  // 基本時間割の授業をそのまま既定に(正しい教科・学級)
          const e = newEntry();
          e.subjectKey = bl.subjectKey; e.scope = bl.scope ?? null;
          prefilled.add(e.id);
          cell.entries.push(e);
        }
      } else {
        const e = newEntry();
        if (s.mode === 'senka') {
          // 基本時間割に無い校時(朝の時間・担当外など)は教科を決め打ちしない。
          // 学級だけ直前の値を仮置きし、教科・学級パレットを開いた状態で「ちゃんと選べる」ようにする
          // (ここで理科を充填すると毎回「変更」を開く手間になり、朝学習など別教科のとき不便)。
          e.scope = validScope(s, ctx.lastScope) ?? s.senkaClasses[0]?.id ?? null;
        }
        cell.entries.push(e);
      }
    }
    return cell;
  };

  // 予定・活動(会議・委員会・クラブ等)にする: 先頭entryを「教科なし・時数に数えない活動」へ。
  // 授業固有の状態(中止/差し込み/単元切上げ/分数時数/複式指導形態など)は活動では意味を持たないので全て初期化する。
  const makeActivity = () => {
    const w = store.getWeek(weekStart, true);
    const key = cellKey(dayIdx, periodId);
    const cell = w.cells[key] || (w.cells[key] = { entries: [] });
    let e = cell.entries[0];
    if (!e) e = newEntry();
    cell.entries = [e];                     // 2件目以降(他学級)は活動化で畳む
    prefilled.delete(e.id);
    e.subjectKey = ''; e.scope = null; e.pin = null; e.offplan = false;
    e.noCount = true; e.override = null; e.text = ''; e.auto = true;
    e.unitName = e.unitName || ''; e.nth = 0; e.unitHours = 0;
    e.cancelled = false; e.cancelledText = ''; e.cancelledReason = ''; e.endUnit = false; e.fraction = 1; e.guide = null; e.advance = null;
    return e;
  };

  // 活動→授業に戻す: 先頭entryの活動属性を外し、教科を選べる授業entryへ(専科は既定教科を充填=ensureと同じ)。
  const makeLesson = () => {
    const e = store.getCell(weekStart, dayIdx, periodId)?.entries?.[0];
    if (!e) return;
    e.noCount = false; e.unitName = ''; e.nth = 0; e.unitHours = 0;
    if (s.mode === 'senka') {
      e.subjectKey = s.subjects.some(x => x.key === s.senkaSubject) ? s.senkaSubject : '';
      if (e.scope == null) e.scope = validScope(s, ctx.lastScope) ?? s.senkaClasses[0]?.id ?? null;
      if (e.subjectKey) prefilled.add(e.id);
    }
  };

  // 空きコマもタップで授業エディタを直接開く(タップ＝すぐ授業入力)。会議等は⋯の「予定・活動にする」で切替。
  ensureLesson();
  // 右クリックの「予定・活動にする…」「授業に変える…」から開いたときは、開いた直後に種類を変えておく
  // (このあとエディタで名前・教科を入れてもらう。fukushikiの活動化は学年別で破綻するため担任/専科のみ)。
  if (opts.asActivity && s.mode !== 'fukushiki') { makeActivity(); store.commit(); }
  else if (opts.asLesson) { makeLesson(); store.commit(); }

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
    // コマ=授業(教科あり) or 活動(会議・委員会・自習・授業なし等。教科なし)の entry を並べる。会議も「授業」の一種。
    const hasActivity = cellNow.entries.some(e => isActivity(e));
    const body = cellNow.entries.map((e, i) => entryEditorHTML(state, e, i, period, ordinals, cellNow.entries.length)).join('');
    const inner = commonPalette + body
      + (s.mode !== 'fukushiki' && !hasActivity ? `<button class="btn small" data-add-entry>＋ 授業を追加</button>` : '');
    modal.querySelector('.cell-editor-body').innerHTML = inner;
    // フッター左の「削除」(授業ごと消す→空き・赤)はフッター静的HTMLで固定。
    // 右上「⋯」=このコマの操作。コマの種類で項目を出し分け(授業/活動の切替・クリアは授業のみ)。
    const ocMenu = modal.querySelector('.oc-menu');
    if (ocMenu) {
      ocMenu.style.display = cellNow.entries.length ? '' : 'none';
      const lockItem = ocMenu.querySelector('[data-oc-lock]');
      if (lockItem) lockItem.innerHTML = `${icon('lock')}${cellNow.entries.some(e => e.locked) ? 'ロック解除' : 'ロック'}`;
      const ocToggle = (sel, show) => { const el = ocMenu.querySelector(sel); if (el) el.style.display = show ? '' : 'none'; };
      ocToggle('[data-oc-make-activity]', s.mode !== 'fukushiki' && !hasActivity); // 授業→予定・活動
      ocToggle('[data-oc-make-lesson]', hasActivity);                              // 活動→授業
      ocToggle('[data-oc-clear]', !hasActivity);                                   // 活動には本時が無いのでクリア非表示
    }
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
          // 教科を変えたら別単元/計画外/上書き/単元切上げ/手入力単元はリセット(別教科に持ち越さない)
          entry.pin = null; entry.offplan = false; entry.override = null; entry.endUnit = false;
          entry.unitName = ''; entry.nth = 0; entry.unitHours = 0;
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
      if (textArea) {
        textArea.addEventListener('input', () => {
          touch();
          entry.text = textArea.value;
          entry.auto = textArea.value.trim() === '';
          store.commit();
        });
        textArea.addEventListener('change', () => ctx.rerender());
      }

      const noteInput = box.querySelector('[name="note"]');
      noteInput.addEventListener('input', () => { touch(); entry.note = noteInput.value; store.commit(); });
      noteInput.addEventListener('change', () => ctx.rerender());

      // 項目別オーバーライド: ねらい/学習活動/評価規準を「このコマだけ」上書き
      box.querySelectorAll('.ov-input').forEach(ta => {
        const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, 36) + 'px'; };
        grow();
        ta.addEventListener('input', () => { grow(); touch(); setOverride(entry, ta.dataset.ov, ta.value, ta.dataset.plan); store.commit(); });
        ta.addEventListener('change', () => { render(modal); ctx.rerender(); });
      });
      box.querySelectorAll('[data-ov-reset]').forEach(b => {
        b.onclick = () => { touch(); clearOverrideKey(entry, b.dataset.ovReset); store.commit(); render(modal); ctx.rerender(); };
      });
      box.querySelectorAll('[data-ov-vp] [data-vp]').forEach(b => {
        b.onclick = () => {
          touch();
          const planVp = b.closest('[data-ov-vp]')?.dataset.planVp || '';
          setOverrideViewpoint(entry, b.dataset.vp, planVp);
          store.commit(); render(modal); ctx.rerender();
        };
      });

      // この時間だけ別の単元の本時をやる(pin)
      const pinUnitSel = box.querySelector('[name="pinUnit"]');
      if (pinUnitSel) pinUnitSel.onchange = () => {
        touch();
        entry.pin = pinUnitSel.value ? { unitId: pinUnitSel.value, nth: 1 } : null;
        store.commit(); render(modal); ctx.rerender();
      };
      const pinLessonSel = box.querySelector('[name="pinLesson"]');
      if (pinLessonSel) pinLessonSel.onchange = () => {
        touch();
        if (entry.pin) { entry.pin = { ...entry.pin, nth: Number(pinLessonSel.value) || 1 }; store.commit(); render(modal); ctx.rerender(); }
      };

      const resetBtn = box.querySelector('[data-reset-auto]');
      if (resetBtn) resetBtn.onclick = () => {
        entry.text = ''; entry.auto = true;
        store.commit(); render(modal); ctx.rerender();
      };

      // 計画が無いコマの単元・時数の手入力
      const unitInp = box.querySelector('[name="unitName"]');
      if (unitInp) { unitInp.addEventListener('input', () => { touch(); entry.unitName = unitInp.value; store.commit(); }); unitInp.addEventListener('change', () => ctx.rerender()); }
      const nthInp = box.querySelector('[name="nth"]');
      if (nthInp) nthInp.addEventListener('change', () => { touch(); entry.nth = Math.max(0, Number(nthInp.value) || 0); store.commit(); ctx.rerender(); });
      const uhInp = box.querySelector('[name="unitHours"]');
      if (uhInp) uhInp.addEventListener('change', () => { touch(); entry.unitHours = Math.max(0, Number(uhInp.value) || 0); store.commit(); ctx.rerender(); });

      // 「この時間にやること」3択(計画どおり/別の単元/計画外)。advance+pin+計画外 を統合。
      box.querySelectorAll('[data-lm]').forEach(b => {
        b.onclick = () => {
          touch();
          const m = b.dataset.lm;
          if (m === 'plan') { entry.pin = null; entry.offplan = false; entry.advance = null; }
          else if (m === 'pin') {
            entry.offplan = false;
            if (!entry.pin) {
              const grade = scopeGrade(store.settings, entry.scope);
              const plan = store.state.plans.find(p => p.subjectKey === entry.subjectKey && (p.grade == null || p.grade === grade));
              const u = plan?.units?.[0];
              entry.pin = u ? { unitId: String(u.id), nth: 1 } : null;
            }
          } else if (m === 'offplan') { entry.offplan = true; entry.pin = null; entry.advance = null; }
          store.commit(); render(modal); ctx.rerender();
        };
      });

      // 実施の記録(詳細から昇格): 時数の割合・時数外・中止 を常時表示のチップで1タップ
      box.querySelectorAll('[data-frac]').forEach(b => {
        b.onclick = () => { touch(); entry.fraction = Number(b.dataset.frac); store.commit(); render(modal); ctx.rerender(); };
      });
      const ncChip = box.querySelector('[data-chip-nocount]');
      if (ncChip) ncChip.onclick = () => { touch(); entry.noCount = !entry.noCount; store.commit(); render(modal); ctx.rerender(); };

      // この時間で単元を終える(残りの計画コマを飛ばして次の単元へ)
      const euChk = box.querySelector('[name="endUnit"]');
      if (euChk) euChk.onchange = () => { touch(); entry.endUnit = euChk.checked; store.commit(); ctx.rerender(); };

      const cancelChip = box.querySelector('[data-chip-cancel]');
      if (cancelChip) cancelChip.onclick = () => {
        touch();
        if (!entry.cancelled) {
          // 中止前の予定内容を控えておく(印刷・画面に「何が中止か」を残す)
          const ords = computeOrdinals(state, weekStart);
          entry.cancelledText = resolveEntryText(state, entry, ords).text;
          entry.cancelled = true;
        } else {
          entry.cancelled = false; entry.cancelledText = ''; entry.cancelledReason = '';
        }
        store.commit(); render(modal); ctx.rerender();
      };
      // 中止の理由(任意): 学級閉鎖・行事変更など。再描画は確定時のみ(入力中はcommitだけ)
      const reasonInp = box.querySelector('[name="cancelReason"]');
      if (reasonInp) {
        reasonInp.oninput = () => { entry.cancelledReason = reasonInp.value; store.commit(); };
        reasonInp.onchange = () => ctx.rerender();
      }

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

    // 授業⇄活動の切替は右上「⋯」(data-oc-make-activity/lesson)へ集約済み。
    // 活動(会議・委員会等)の名前 ＋ よく使うプリセット ＋ 備考
    const actName = modal.querySelector('[name="activityName"]');
    if (actName) {
      const e0 = () => store.getCell(weekStart, dayIdx, periodId)?.entries?.[0];
      actName.addEventListener('input', () => { const e = e0(); if (e) { e.unitName = actName.value; store.commit(); } });
      actName.addEventListener('change', () => ctx.rerender());
      modal.querySelectorAll('.memo-preset').forEach(b => b.onclick = () => {
        const e = e0(); if (!e) return; e.unitName = b.dataset.preset; actName.value = b.dataset.preset; store.commit(); ctx.rerender();
      });
      const actNote = modal.querySelector('[name="actNote"]');
      if (actNote) { actNote.addEventListener('input', () => { const e = e0(); if (e) { e.note = actNote.value; store.commit(); } }); actNote.addEventListener('change', () => ctx.rerender()); }
    }
  };

  openModal(`
    <div class="oc-titlebar">
      <h2>${esc(title)}</h2>
      <details class="menu oc-menu">
        <summary class="btn small ghost" aria-label="このコマの操作">⋯</summary>
        <div class="menu-items">
          <button class="btn ghost menu-item" data-oc-lock title="「計画に合わせて更新」しても上書きされません">${icon('lock')}ロック</button>
          <button class="btn ghost menu-item" data-oc-make-activity title="この時間を会議・自習・授業なしなどの予定にする（時数に数えません）">${icon('memo')}予定・活動にする</button>
          <button class="btn ghost menu-item" data-oc-make-lesson title="予定をやめて授業に戻す">${icon('book')}授業に変える</button>
          <button class="btn ghost menu-item" data-oc-clear title="本時のねらい・活動・評価を空に。教科・学級は残ります">${icon('eraser')}クリア</button>
          <button class="btn ghost menu-item" data-oc-move>${icon('refresh')}別の時間へ移動</button>
        </div>
      </details>
    </div>
    <div class="cell-editor-body"></div>
    <div class="modal-foot">
      <button class="btn danger left" data-clear-cell title="このコマを削除して空きに戻します">${icon('trash')}削除</button>
      <button class="btn ghost" data-revert>取り消す</button>
      <button class="btn primary" data-close>閉じる</button>
    </div>
  `, (modal, close) => {
    closeModal = close;
    render(modal);
    modal.querySelector('[data-close]').onclick = () => close();
    // 右上「⋯」: このコマへの操作(ロック/クリア/移動)。Apple流に二次操作を畳む。
    const ocMenu = modal.querySelector('.oc-menu');
    const closeOcMenu = () => { if (ocMenu) ocMenu.open = false; };
    modal.querySelector('[data-oc-lock]').onclick = () => {
      closeOcMenu();
      const c = store.getCell(weekStart, dayIdx, periodId);
      if (!c?.entries?.length) return;
      const on = !c.entries.some(e => e.locked);
      store.snapshot(on ? 'コマをロック' : 'ロック解除');
      c.entries.forEach(e => { e.locked = on; });
      store.commit(); render(modal); ctx.rerender();
    };
    modal.querySelector('[data-oc-clear]').onclick = () => {
      closeOcMenu();
      const c = store.getCell(weekStart, dayIdx, periodId);
      if (!c?.entries?.length) return;
      store.snapshot('本時の中身をクリア');
      clearCellContent(c); // 教科・学級は残し、本時の中身(ねらい/活動/評価/全文)を空に
      store.commit(); render(modal); ctx.rerender();
      toast('本時の中身を空にしました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); render(modal); ctx.rerender(); } });
    };
    modal.querySelector('[data-oc-make-activity]').onclick = async () => {
      closeOcMenu();
      // 専科で1コマに複数学級があると活動化で2件目以降が畳まれる→明示確認＋スナップショットで安全に
      const folded = (store.getCell(weekStart, dayIdx, periodId)?.entries?.length || 0) - 1;
      if (folded >= 1 && !await confirmDialog(`他の学級（${folded}件）の授業も消えます。予定・活動にしますか?`, { okLabel: '予定・活動にする', danger: true })) return;
      store.snapshot('予定・活動にする');
      makeActivity(); store.commit(); render(modal); ctx.rerender();
      if (folded >= 1) toast('他の学級のコマを畳んで予定にしました', 'info', 2800, { label: '元に戻す', onClick: () => { store.undo(); render(modal); ctx.rerender(); } });
    };
    modal.querySelector('[data-oc-make-lesson]').onclick = () => {
      closeOcMenu();
      makeLesson(); store.commit(); render(modal); ctx.rerender();
    };
    modal.querySelector('[data-oc-move]').onclick = () => {
      closeOcMenu();
      ctx.swapSource = { weekStart, day: dayIdx, period: periodId };
      close();
    };
    // 取り消す: 開いた時点のセル状態へ戻して閉じる(編集を破棄)
    modal.querySelector('[data-revert]').onclick = () => {
      discarded = true;
      const w = store.getWeek(weekStart, true);
      const before = JSON.parse(openCellJSON);
      if (before) w.cells[editKey] = before; else delete w.cells[editKey];
      store.commit();
      close(); // cleanup は discarded を見て何もしない
      toast('変更を取り消しました', 'info', 2000);
      ctx.rerender();
    };
    // 削除=このコマを消す→空きに戻す(また流し込みで埋まりうる)。
    modal.querySelector('[data-clear-cell]').onclick = () => {
      const w = store.getWeek(weekStart, true);
      store.snapshot('コマを削除');
      delete w.cells[editKey];
      discarded = true; // 削除後の cleanup で再生成しない
      store.commit(); close();
      toast('削除しました', 'info', 2400, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    };
  }, cleanup);

  // 空のままのエントリは閉じるときに掃除する(冪等)。
  // 専科の事前充填エントリ(担当教科入り)も、ユーザー操作がなければ除去する
  // (空セルを開いて閉じるだけで授業が時数・進度に計上されないように)
  function cleanup() {
    if (discarded) return; // 「取り消す」で既に開いた時点へ復元済み。掃除はしない。
    const w = store.state.weeks[weekStart];
    const key = cellKey(dayIdx, periodId);
    const c = w?.cells?.[key];
    if (c) {
      // 備考・上書きは授業or活動を伴うときだけ意味を持つ(教科なし非活動の note/override だけのコマは幽霊なので掃除)
      c.entries = c.entries.filter(e => {
        const lesson = e.subjectKey && !prefilled.has(e.id);
        return lesson || isActivity(e) || (e.text && !e.auto) || ((e.note || e.override) && (e.subjectKey || isActivity(e)));
      });
      if (!c.entries.length) delete w.cells[key]; // 授業も活動も無ければ空き(コマ削除)
    }
    if (w && !w.cleared && !w.submittedAt && !Object.keys(w.cells).length && !w.goals && !w.reflection
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
// 計画と同じ値に戻したら上書き解除(計画どおりへ)。空にした場合は「白紙」として保持し、
// 計画文へ自動では戻さない(意図しない復活を防ぐ)。完全に解除したいときは ↺ で行う。
function setOverride(entry, key, value, planVal = '') {
  const o = { ...(entry.override || {}) };
  const v = String(value);
  if (v.trim() === String(planVal).trim()) delete o[key]; // 計画と同じ=上書きなし
  else o[key] = v;                                         // 空文字('')も白紙として保持
  entry.override = Object.keys(o).length ? o : null;
}

// 上書きを完全に解除して計画どおりへ戻す(↺ ボタン用)。
function clearOverrideKey(entry, key) {
  if (!entry.override) return;
  const o = { ...entry.override };
  delete o[key];
  entry.override = Object.keys(o).length ? o : null;
}

// このコマの「本時の中身」を空にする(教科・学級・モードは残す)。複数授業ぶん一括。
function clearCellContent(cell) {
  for (const e of cell.entries || []) {
    const o = { ...(e.override || {}) };
    o.objective = ''; o.activity = ''; o.assessment = '';
    e.override = o;
    e.text = ''; e.auto = true; // 全文手入力も消す
  }
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

// 年間計画が無いコマの入力欄に出す「書き方の型」。白紙に放り出される初任者を助ける、
// 著作物ではない一般的な雛形(教科書の本文ではない)。
const OV_PLACEHOLDERS = {
  objective: '（例）〜について、〜が分かる／〜できる。',
  activity: '（例）〜を観察・実験し、気づいたことを交流する。',
  assessment: '（例）〜を理解している／〜を考えている。（観点は下で選ぶ）',
};

function entryEditorHTML(state, entry, idx, period, ordinals, entriesCount = 1) {
  const s = state.settings;
  // 活動(会議・委員会・クラブ等。教科なし・時数に数えない)は名前だけのシンプル編集。
  if (isActivity(entry)) {
    return `<div class="entry-editor activity-editor">
      <div class="field">
        <label>予定・活動（会議・委員会・クラブなど）${infoHTML('授業ではない予定。時数に数えず、流し込みでも埋め直されません')}</label>
        <div class="memo-presets">${MEMO_PRESETS.map(x => `<button type="button" class="btn small ghost memo-preset" data-preset="${esc(x)}">${esc(x)}</button>`).join('')}</div>
        <input type="text" class="act-name" name="activityName" value="${esc(entry.unitName || '')}" placeholder="会議・委員会・クラブ・面談 など" aria-label="予定・活動の名前">
      </div>
      <div class="field"><label>備考</label><input type="text" name="actNote" value="${esc(entry.note || '')}"></div>
    </div>`;
  }
  const { resolved, details } = resolveEntryPlanDetails(state, entry, ordinals);
  // この時間だけ別の単元の本時をやる(pin)用: 教科・学年に対応する計画と、pin中の単元
  const planForPick = entry.subjectKey
    ? state.plans.find(p => p.subjectKey === entry.subjectKey && (p.grade == null || p.grade === scopeGrade(s, entry.scope)))
    : null;
  const pinUnit = entry.pin && planForPick ? (planForPick.units || []).find(u => String(u.id) === String(entry.pin.unitId)) : null;

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

  // 1項目分の編集フィールド。計画どおりなら欄に計画文が濃く出て、直接書き換えられる。
  // 空にすると白紙のまま定着(計画文へ自動では戻さない)。「↺ 計画に戻す」で元の計画文へ。
  const ovField = (key, label, planVal, effVal, isOv, extra = '') => `
    <div class="ov-field${isOv ? ' is-ov' : ''}">
      <div class="ov-flabel"><b>${label}</b>
        ${isOv
          ? `<span class="ov-badge">変更</span><button type="button" class="ov-reset" data-ov-reset="${key}">↺ 計画に戻す</button>`
          : (planVal ? '<span class="ov-asplan">計画どおり</span>' : '')}
      </div>
      <textarea class="ov-input" data-ov="${key}" data-plan="${esc(planVal || '')}" rows="2"
        placeholder="${esc(OV_PLACEHOLDERS[key] || '（自由に記録できます）')}">${esc(effVal)}</textarea>
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
    // 本時の内容(ねらい・学習活動・評価規準・観点)。計画どおりなら欄に計画文が濃く出て、
    // そのまま直接書き換えられる(開く=編集なので別の「編集」ボタンは置かない)。計画と同じに戻すと記録は消える。
    const vprow = `<div class="ov-vprow"><span class="ov-vplabel">観点${infoHTML('評価規準は「何を見取るか」の文。観点はその3区分のどれか:　知=知識・技能　思=思考・判断・表現　態=主体的に学習に取り組む態度')}</span>${vpSeg}${ed.overridden.viewpoint ? '<span class="ov-badge ov-vp-badge">変更</span>' : ''}</div>`;
    // 「この時間だけ別の単元の本時をやる」ピッカー(自転車操業対応)。計画に単元があるときだけ出す。
    const pinUnits = planForPick?.units || [];
    const lessonMode = entry.offplan ? 'offplan' : entry.pin ? 'pin' : 'plan';
    // 「別の単元」用の単元×本時セレクト(pinモードのときだけ表示)
    const pinSelects = (() => {
      if (!pinUnits.length) return '';
      const unitOpts = `<option value="">単元を選ぶ…</option>`
        + pinUnits.map(u => `<option value="${esc(u.id)}" ${entry.pin && String(entry.pin.unitId) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
      let lessonSel = '';
      if (pinUnit) {
        const h = Math.max(1, Math.round(pinUnit.hours || pinUnit.lessons?.length || 1));
        const opts = Array.from({ length: h }, (_, i) => {
          const o = pinUnit.lessons?.[i]?.objective || pinUnit.lessons?.[i]?.text || '';
          return `<option value="${i + 1}" ${(entry.pin.nth || 1) === i + 1 ? 'selected' : ''}>${i + 1}時${o ? '：' + esc(String(o).slice(0, 16)) : ''}</option>`;
        }).join('');
        lessonSel = `<label class="up-label">本時</label><select name="pinLesson">${opts}</select>`;
      }
      return `<div class="up-body"><label class="up-label">単元</label><select name="pinUnit">${unitOpts}</select>${lessonSel}</div>`;
    })();
    // 「この時間にやること」3択(計画どおり/別の単元/計画外)。advance+pin+計画外 を統合し「詳細」から昇格。
    const lmBtn = (val, label) => `<button type="button" class="lm-btn ${lessonMode === val ? 'selected' : ''}" data-lm="${val}" aria-pressed="${lessonMode === val}">${label}</button>`;
    const lessonModeSelector = planForPick ? `
      <div class="field"><label>この時間にやること${infoHTML('計画どおり＝年間計画の順番。本時を選ぶ＝この時間だけ指定の本時をやる(他コマの順番は不変。同じ本時の再実施も可)。計画外＝復習・テスト・予備など計画に紐づかない授業で、進度は進みません')}</label>
        <div class="lesson-mode" role="group">${lmBtn('plan', '計画どおり')}${pinUnits.length ? lmBtn('pin', '本時を選ぶ') : ''}${lmBtn('offplan', '計画外')}</div>
        ${lessonMode === 'pin' ? pinSelects : ''}
      </div>` : '';
    // 単元途中で切り上げる(計画どおりモードかつ単元途中のときだけ、単元見出しの近くに出す)
    // モジュール校時は既定で進度を進めないため単元切上げが効かない→チェックを出さない(無言で無視されるのを防ぐ)
    const endUnitInline = (lessonMode === 'plan' && details && details.unitHours > 1 && details.nth < details.unitHours && period.type !== 'module')
      ? `<label class="eu-inline"><input type="checkbox" name="endUnit" ${entry.endUnit ? 'checked' : ''}>この時間で単元を切り上げる（残り${details.unitHours - details.nth}コマを飛ばす）</label>` : '';
    const modeHeader = lessonMode === 'offplan'
      ? `<div class="ov-head"><span class="ov-kicker">計画外</span><span class="ov-sub">復習・テスト・予備など（進度は進みません）</span></div>`
      : ed.planless
        ? `<div class="ov-head"><span class="ov-kicker">本時の記録</span><span class="ov-sub">年間計画に未登録のコマ（単元・時数も手入力できます）</span></div>
           <div class="planless-unit">
             <label class="pu-field"><span>単元</span><input type="text" name="unitName" value="${esc(ed.unitName || '')}" placeholder="（例）ごんぎつね"></label>
             <label class="pu-field pu-num"><span>何時間目</span><input type="number" name="nth" min="0" inputmode="numeric" value="${ed.nth || ''}"></label>
             <label class="pu-field pu-num"><span>／総時数</span><input type="number" name="unitHours" min="0" inputmode="numeric" value="${ed.unitHours || ''}"></label>
           </div>`
        : `<div class="ov-head"><span class="ov-kicker">${entry.auto ? '年間指導計画' : '年間指導計画（参照）'}</span><strong>${esc(ed.unitName)}</strong>${ed.unitHours > 1 ? `<span class="ov-nth">${ed.nth}/${ed.unitHours}時</span>` : ''}${endUnitInline}<span class="ov-help">${infoHTML('計画どおりなら触らなくてOK。実際の授業に合わせて直した項目だけが「変更」として記録されます')}</span></div>`;
    autoBlock = `<div class="ov-block">
      ${lessonModeSelector}
      ${modeHeader}
      ${ovField('objective', '本時のねらい', ed.planObjective, ed.objective, ed.overridden.objective)}
      ${ovField('activity', '学習活動', ed.planActivity, ed.activity, ed.overridden.activity)}
      ${ovField('assessment', '評価規準', ed.planAssessment, ed.assessment, ed.overridden.assessment, vprow)}
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
  // 「内容(1行丸ごと手書き)」は本時のねらいと役割が重複するため、入力欄としては廃止。
  // 既に手書きが入っているコマ(auto=false)だけ、編集・解除できるよう表示する(既存データ保護)。
  const manualBlock = !entry.auto ? manualField : '';

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
      <div class="lesson-state">
        <div class="ls-row">
          <span class="ls-label">時数${infoHTML('1コマを複数で分けるときの割合(例: 国語½+行事½)。ふつうは1のままでOK')}</span>
          <div class="frac-seg" role="group" aria-label="時数の割合">
            ${[['1', '1'], ['0.6666666666666666', '⅔'], ['0.5', '½'], ['0.3333333333333333', '⅓']].map(([v, l]) => {
              const on = Math.abs((entry.fraction ?? 1) - Number(v)) < 0.01;
              return `<button type="button" class="frac-btn ${on ? 'selected' : ''}" data-frac="${v}" aria-pressed="${on}">${l}</button>`;
            }).join('')}
          </div>
          <span class="ls-grow"></span>
          <button type="button" class="state-chip ${entry.noCount ? 'on' : ''}" data-chip-nocount aria-pressed="${!!entry.noCount}" title="朝活動・テスト監督など授業時数に含めないコマに。進度とは別の「時数」の話です">時数外</button>
          <button type="button" class="state-chip cancel ${entry.cancelled ? 'on' : ''}" data-chip-cancel aria-pressed="${!!entry.cancelled}" title="学級閉鎖・行事変更などで実施しなかったコマ。以降の授業内容は自動で繰り下がります">中止</button>
        </div>
        ${entry.cancelled ? `<input type="text" class="cancel-reason" name="cancelReason" value="${esc(entry.cancelledReason || '')}" placeholder="中止の理由（学級閉鎖・行事変更など・任意）" aria-label="中止の理由">` : ''}
      </div>
      ${entriesCount > 1 ? `<button class="btn small danger block-del" data-del-entry>${s.mode === 'fukushiki' ? 'この学年だけ削除' : 'この学級だけ削除'}</button>` : ''}
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
  // 数字を主役に: 教科チップ(色=識別)＋大きな等幅数字。最後に合計。色は状態に使わず静かに。
  let total = 0;
  const chips = [...bySubj.entries()]
    .filter(([, v]) => v.week > 0)
    .map(([key, v]) => {
      const [subjKey, scope] = key.split('|');
      const subj = subjectOf(s, subjKey);
      if (!subj) return '';
      total += v.week;
      const scopeLabel = scope ? (s.mode === 'fukushiki' ? `${scope}年` : (s.senkaClasses.find(c => c.id === scope)?.label || '')) : '';
      return `<span class="ms-chip">
        <span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>
        ${scopeLabel ? `<span class="ms-scope">${esc(scopeLabel)}</span>` : ''}
        <b class="ms-num">${fmtHours(v.week)}</b></span>`;
    }).join('');
  if (!chips) return ''; // 当週が未入力なら見出しだけの空パネルを出さない
  return `<div class="panel mini-stats">
    <span class="ms-title">今週の時数</span>
    <div class="ms-chips">${chips}</div>
    <span class="ms-total">計 <b>${fmtHours(total)}</b><span class="ms-unit">時</span></span>
  </div>`;
}
