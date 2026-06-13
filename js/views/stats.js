/** 時数集計ビュー: 進度一覧(専科・複式)・教科別集計・月別/学期別・CSV/印刷 */

import { store, computeHours, computeMonthlyHours, computeOrdinals, lessonFromPlan, fmtHours, standardHoursFor, scopeKey, cellKey, teachingWeeksLeft, teachingWeeksElapsed, doneRefWeek } from '../store.js';
import { weekNumberInFiscalYear, fiscalYearOf, parseDate, addDays, fmtDate, fmtMD, esc } from '../utils.js';
import { toast, infoHTML } from '../ui.js';

const MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const DETAIL_KEY = 'shuan-stats-detail';

export function renderStatsView(root, ctx) {
  const state = store.state;
  const s = state.settings;
  const weekStart = ctx.getWeekStart();
  const hours = computeHours(state, weekStart);
  const monthly = computeMonthlyHours(state, weekStart);
  const weekNo = weekNumberInFiscalYear(parseDate(weekStart));

  // 実施済は表示中の週ではなく今日現在で数える(過去週を見ていても報告値が欠けない)
  const hoursDone = computeHours(state, doneRefWeek(weekStart));
  const detail = localStorage.getItem(DETAIL_KEY) === '1';
  // 年度表示は閲覧中の週から導出する(settings.fiscalYearは常に現在年度のため、
  // 4月以降に前年度の週を見るとデータと年度ラベルが食い違う)
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));

  const scopes = scopesOf(s, hours);
  // 複数学級(専科・複式)では、全学級の時数を1枚で見渡せる横断サマリーを先頭に出す
  const classSummary = scopes.length >= 2 ? renderClassSummary(state, hours, hoursDone, scopes) : '';
  const sections = scopes.map(sc => renderScopeTable(state, hours, hoursDone, monthly, sc, weekNo, weekStart, detail)).filter(Boolean).join('');
  const progress = renderProgress(state, weekStart);

  root.innerHTML = `
    <div class="panel">
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px;">
        <h2 style="margin:0;">時数集計</h2>
        <span class="hint">第${weekNo}週(${fmtMD(parseDate(weekStart))})まで・${fy}年度</span>
        <span class="spacer" style="flex:1;"></span>
        <label class="hint" style="display:flex; align-items:center; gap:4px; cursor:pointer;">
          <input type="checkbox" id="stats-detail" ${detail ? 'checked' : ''}> 詳細列</label>
        <button class="btn small" id="stats-csv">CSV保存</button>
        <button class="btn small" id="stats-print">印刷</button>
      </div>
      ${sections ? `<div class="hours-legend" aria-hidden="true">
        <span><i class="hl-done"></i>実施</span>
        <span><i class="hl-plan"></i>予定</span>
        <span><i class="hl-std"></i>標準</span>
        <span class="hl-note">バーが標準ラインに届けば達成</span>
      </div>` : ''}
      ${classSummary}
      ${progress}
      ${sections || `<div class="empty-state">
        <div class="empty-ic">📊</div>
        <p class="empty-title">まだ集計するコマがありません</p>
        <p class="empty-sub">週案タブでコマを入れると、ここに実施時数と標準時数への進捗が表示されます。</p>
      </div>`}
    </div>
  `;

  root.querySelector('#stats-detail').onchange = (e) => {
    localStorage.setItem(DETAIL_KEY, e.target.checked ? '1' : '0');
    ctx.rerender();
  };

  // 標準時数の上書き編集(空欄=既定に戻す、数値以外は無視)
  root.querySelectorAll('input[data-std]').forEach(inp => {
    inp.addEventListener('change', () => {
      const [subjKey, grade] = inp.dataset.std.split('@');
      if (!s.standardOverrides) s.standardOverrides = {};
      const v = inp.value.trim();
      const n = Number(v);
      if (v === '' || !isFinite(n) || n < 0) delete s.standardOverrides[`${subjKey}|${grade}`];
      else s.standardOverrides[`${subjKey}|${grade}`] = n;
      store.commit();
      ctx.rerender();
    });
  });

  root.querySelector('#stats-csv').onclick = () => downloadCSV(state, weekStart);
  root.querySelector('#stats-print').onclick = async () => {
    const { buildStatsPrintDOM, printState } = await import('../print.js');
    buildStatsPrintDOM(weekStart);
    printState.prepared = true;
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  };
}

/** 表示するスコープの一覧。専科の「学級指定なし」は実データがあるときだけ */
function scopesOf(s, hours) {
  if (s.mode === 'fukushiki') {
    return s.fukushikiGrades.map(g => ({ scope: g, label: `${g}年`, grade: g }));
  }
  if (s.mode === 'senka') {
    const list = s.senkaClasses.map(c => ({ scope: c.id, label: c.label, grade: c.grade }));
    const hasNull = [...hours.keys()].some(k => k.endsWith('|'));
    if (hasNull) list.push({ scope: '', label: '(学級指定なし)', grade: s.grade });
    return list;
  }
  return [{ scope: '', label: '', grade: s.grade }];
}

// ---------------------------------------------------------------- 学級横断サマリー(専科・複式)

/**
 * 全学級(専科)・全学年(複式)の時数を1枚で見渡す一覧。
 * 専科で12学級を担当していても、提出時に「どの学級が標準に対してどこまで進んだか」を一望できる。
 * 各学級の主要教科(合算先を持たない教科)の実施済・予定計・標準を合算して出す。
 */
/**
 * 時数の状態を一目で示すバー。標準時数を目標ラインに、実施(実線)と予定(淡色)を重ねる。
 * バーが目標ラインに届かない=標準に未達、ラインを越える=超過(淡色が赤)。数字を読まずに状態が分かる。
 * 色＋位置(ライン)＋数値ツールチップで、色覚に依存しない。
 */
function hoursBar(done, total, std) {
  if (!std) {
    const max = Math.max(total, done, 1);
    return `<div class="hbar" title="実施${fmtHours(done)} / 予定${fmtHours(total)}">
      <div class="hbar-plan" style="width:${Math.min(total / max, 1) * 100}%"></div>
      <div class="hbar-done" style="width:${Math.min(done / max, 1) * 100}%"></div>
    </div>`;
  }
  const max = Math.max(total, std);
  const stdPct = std / max * 100;
  const over = total > std;
  return `<div class="hbar ${over ? 'is-over' : ''}" title="実施${fmtHours(done)} / 予定${fmtHours(total)} / 標準${fmtHours(std)}">
    <div class="hbar-plan" style="width:${total / max * 100}%"></div>
    <div class="hbar-done" style="width:${done / max * 100}%"></div>
    <div class="hbar-std" style="left:${stdPct}%"></div>
  </div>`;
}

function renderClassSummary(state, hours, hoursDone, scopes) {
  const s = state.settings;
  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }

  let sumDone = 0, sumTotal = 0, sumStd = 0;
  const rows = [];
  for (const sc of scopes) {
    const scopeVal = sc.scope === '' ? null : sc.scope;
    let done = 0, total = 0, std = 0;
    for (const subj of s.subjects) {
      if (subj.parent && keys.has(subj.parent)) continue;
      let t = 0, d = 0;
      for (const k of [subj.key, ...(childrenOf[subj.key] || [])]) {
        const v = hours.get(scopeKey(k, scopeVal));
        if (v) t += v.total;
        d += hoursDone.get(scopeKey(k, scopeVal))?.done || 0;
      }
      if (t > 0 || d > 0) {
        total += t; done += d;
        const sd = standardHoursFor(s, subj.key, sc.grade);
        if (sd != null) std += sd;
      }
    }
    if (total === 0 && done === 0) continue; // 未入力の学級は出さない
    sumDone += done; sumTotal += total; sumStd += std;
    const pct = std ? Math.min(100, Math.round((done / std) * 100)) : 0;
    const remain = std ? std - total : null;
    rows.push(`
      <tr>
        <td class="subj">${esc(sc.label || '—')}</td>
        <td>${fmtHours(done)}</td>
        <td>${fmtHours(total)}</td>
        <td>${std || '—'}</td>
        <td>${remain != null ? fmtHours(remain) : '—'}</td>
        <td style="text-align:left;">${hoursBar(done, total, std)}</td>
      </tr>`);
  }
  if (rows.length < 2) return ''; // 1学級分しか無ければ通常テーブルで十分

  const label = s.mode === 'fukushiki' ? '学年' : '学級';
  return `
    <h3 style="margin-top:0;">全${label}の進捗${infoHTML('担当する全' + label + 'の実施済・予定計・標準時数を一覧します。提出時の確認用。バーは実施済÷標準')}</h3>
    <div class="table-scroll">
      <table class="stats-table" style="margin-bottom:18px;">
        <thead><tr>
          <th style="width:110px;">${label}</th>
          <th style="width:74px;">実施済</th>
          <th style="width:74px;">予定計</th>
          <th style="width:64px;">標準</th>
          <th style="width:64px;">残り</th>
          <th>進捗(実施)</th>
        </tr></thead>
        <tbody>
          ${rows.join('')}
          <tr style="background:#f8fafc;">
            <td class="subj">合計</td><td><b>${fmtHours(sumDone)}</b></td><td>${fmtHours(sumTotal)}</td>
            <td>${sumStd || '—'}</td><td>${sumStd ? fmtHours(sumStd - sumTotal) : '—'}</td><td></td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------- 進度一覧(専科・複式の核心ビュー)

/**
 * 学級(学年)×教科の進度マトリクス。
 * 「次の授業がどの単元の何時間目か」「前回いつやったか」を一覧する(実験準備・進度ズレ確認用)。
 */
function renderProgress(state, weekStart) {
  const s = state.settings;
  const prog = progressByScope(state, weekStart);
  if (!prog.size) return '';

  const scopes = s.mode === 'fukushiki'
    ? s.fukushikiGrades.map(g => ({ scope: g, label: `${g}年`, grade: g }))
    : s.mode === 'senka'
      ? s.senkaClasses.map(c => ({ scope: c.id, label: c.label || '学級未設定', grade: c.grade }))
      : [{ scope: null, label: `${s.grade}年${s.className || ''}`, grade: s.grade }];

  // 進度データのある教科を収集
  const subjKeys = new Set();
  for (const k of prog.keys()) subjKeys.add(k.split('|')[0]);

  const rows = [];
  for (const sc of scopes) {
    for (const subjKey of subjKeys) {
      const p = prog.get(scopeKey(subjKey, sc.scope));
      if (!p) continue;
      const subj = s.subjects.find(x => x.key === subjKey);
      const plan = state.plans.find(pl => pl.subjectKey === subjKey && (pl.grade == null || pl.grade === sc.grade));
      const next = plan ? lessonFromPlan(plan, p.count) : null;
      const nextText = next
        ? (next.exhausted ? '計画終了' : `${next.unitName}${next.unitHours > 1 ? `(${next.nth}/${next.unitHours})` : ''}${next.lessonText ? ' ' + next.lessonText : ''}`)
        : '—';
      rows.push(`
        <tr>
          <td class="subj">${esc(sc.label)}</td>
          ${subjKeys.size > 1 ? `<td>${esc(subj?.short || subjKey)}</td>` : ''}
          <td style="text-align:left;">${esc(nextText)}</td>
          <td>${p.lastDate ? fmtMD(parseDate(p.lastDate)) : '—'}</td>
          <td>${p.count}</td>
        </tr>`);
    }
  }
  if (!rows.length) return '';

  return `
    <h3 style="margin-top:0;">進度一覧${infoHTML('学級ごとに「次の授業がどの単元の何時間目か」を表示します。行事や閉鎖で進度がずれても自動で追跡されます')}</h3>
    <table class="stats-table" style="margin-bottom:18px;">
      <thead><tr>
        <th style="width:90px;">${store.settings.mode === 'fukushiki' ? '学年' : '学級'}</th>
        ${subjKeys.size > 1 ? '<th style="width:60px;">教科</th>' : ''}
        <th>次の授業</th><th style="width:70px;">前回</th><th style="width:70px;">済コマ</th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

/** 進度カウンタ(scopeKey→{count, lastDate})。computeOrdinalsと同じ規則で数える */
function progressByScope(state, refWeekStart) {
  const { settings, weeks } = state;
  const ordinals = computeOrdinals(state, refWeekStart); // 走査規則の正は store 側
  const out = new Map();
  for (const wk of Object.keys(weeks).sort()) {
    const week = weeks[wk];
    const monday = parseDate(wk);
    for (let d = 0; d < 7; d++) {
      for (const p of settings.periods) {
        const cell = week.cells?.[cellKey(d, p.id)];
        if (!cell) continue;
        for (const e of cell.entries) {
          if (!ordinals.has(e.id)) continue; // 進度を進めたエントリだけ
          const k = scopeKey(e.subjectKey, e.scope);
          const cur = out.get(k) || { count: 0, lastDate: null };
          cur.count = Math.max(cur.count, ordinals.get(e.id) + 1);
          const dateStr = fmtDate(addDays(monday, d));
          if (!cur.lastDate || dateStr > cur.lastDate) cur.lastDate = dateStr;
          out.set(k, cur);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 教科別テーブル

function renderScopeTable(state, hours, hoursDone, monthly, sc, weekNo, weekStart, detail) {
  const s = state.settings;
  const scopeVal = sc.scope === '' ? null : sc.scope;
  const get = (subjKey) => hours.get(scopeKey(subjKey, scopeVal)) || { week: 0, total: 0 };
  const getDone = (subjKey) => hoursDone.get(scopeKey(subjKey, scopeVal))?.done || 0;

  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }

  const activeRows = [];
  const zeroRows = [];
  let any = false;
  // 長期休業を設定していれば残り・経過の「授業週数」でペースと見込みを計算
  const weeksLeft = teachingWeeksLeft(s, weekStart);
  const weeksElapsed = teachingWeeksElapsed(s, weekStart);
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) continue;
    const own = get(subj.key);
    let week = own.week, total = own.total;
    const mergedFrom = [];
    for (const ck of childrenOf[subj.key] || []) {
      const c = get(ck);
      if (c.total > 0 || c.week > 0) mergedFrom.push(s.subjects.find(x => x.key === ck)?.name || ck);
      week += c.week; total += c.total;
    }
    let done = getDone(subj.key);
    for (const ck of childrenOf[subj.key] || []) done += getDone(ck);
    const std = standardHoursFor(s, subj.key, sc.grade);
    if (total === 0 && week === 0 && done === 0 && std == null) continue;
    any = true;
    const remain = std != null ? std - total : null;
    const pace = remain != null && remain > 0 && weeksLeft > 0 ? remain / weeksLeft : null;
    // 分母は経過「授業」週数(暦週数で割ると夏休み以降の着地を恒常的に過小評価する)
    const projected = total > 0 ? (total / weeksElapsed) * (s.hoursBase || 35) : null;
    const pct = std ? Math.min(100, Math.round((total / std) * 100)) : 0;
    const over = std != null && total > std;
    const row = `
      <tr class="${over ? 'over' : ''}">
        <td class="subj"><span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>
          ${esc(subj.name)}${mergedFrom.length ? `<span class="hint">(+${mergedFrom.map(esc).join('・')})</span>` : ''}</td>
        <td>${fmtHours(week)}</td>
        <td>${fmtHours(done)}</td>
        ${detail ? `<td><b>${fmtHours(total)}</b></td>` : ''}
        <td><input data-std="${esc(subj.key)}@${sc.grade}" value="${std ?? ''}" placeholder="—"
              aria-label="${esc(subj.name)}の標準時数"
              style="width:56px; border:none; background:transparent; text-align:right; font-family:inherit;"></td>
        <td>${remain != null ? fmtHours(remain) : '—'}</td>
        ${detail ? `<td>${pace != null ? fmtHours(pace) + ' /週' : '—'}</td>
        <td>${projected != null ? Math.round(projected) : '—'}</td>` : ''}
        <td style="text-align:left;">${hoursBar(done, total, std)}</td>
      </tr>`;
    // 専科・複式では「時数0で標準だけある行」を畳む(自分の教科1行を探させない)
    if (s.mode !== 'homeroom' && total === 0 && week === 0 && done === 0) zeroRows.push(row);
    else activeRows.push(row);
  }
  if (!any) return '';
  if (!activeRows.length && s.mode !== 'homeroom') return ''; // この学級は未入力

  let sumWeek = 0, sumTotal = 0, sumDone = 0;
  for (const subj of s.subjects) {
    const v = get(subj.key);
    sumWeek += v.week; sumTotal += v.total; sumDone += getDone(subj.key);
  }

  // 月別・学期別テーブル
  const subjForMonthly = s.subjects.filter(x => !(x.parent && keys.has(x.parent)));
  const getMonthly = (map, subjKey) => {
    if (!map) return 0;
    let v = map.get(scopeKey(subjKey, scopeVal)) || 0;
    for (const ck of childrenOf[subjKey] || []) v += map.get(scopeKey(ck, scopeVal)) || 0;
    return v;
  };
  const monthlyRows = subjForMonthly.map(subj => {
    const cells = MONTH_ORDER.map(m => {
      const v = getMonthly(monthly.months.get(m), subj.key);
      return `<td>${v ? fmtHours(v) : ''}</td>`;
    });
    const termCells = monthly.terms.map(t => {
      const v = getMonthly(t.hours, subj.key);
      return `<td style="background:#f8fafc;"><b>${v ? fmtHours(v) : ''}</b></td>`;
    });
    const yearTotal = monthly.terms.reduce((a, t) => a + getMonthly(t.hours, subj.key), 0);
    if (!yearTotal) return '';
    return `<tr>
      <td class="subj"><span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span></td>
      ${cells.join('')}${termCells.join('')}
      <td style="background:#eef2f7;"><b>${fmtHours(yearTotal)}</b></td>
    </tr>`;
  }).filter(Boolean).join('');

  const monthlyTable = monthlyRows ? `
    <details style="margin-bottom:18px;">
      <summary class="fold-label">月別・学期別</summary>
      <div class="table-scroll" style="margin-top:8px;">
        <table class="stats-table">
          <thead><tr><th style="width:60px;">教科</th>${MONTH_ORDER.map(m => `<th>${m}月</th>`).join('')}
            ${monthly.terms.map(t => `<th style="background:#eef2f7;">${esc(t.name)}</th>`).join('')}<th style="background:#e2e8f0;">年度計</th></tr></thead>
          <tbody>${monthlyRows}</tbody>
        </table>
      </div>
    </details>` : '';

  const zeroBlock = zeroRows.length ? `
    <details style="margin-bottom:10px;">
      <summary class="fold-label">未入力の教科 ${zeroRows.length}件</summary>
      <div class="table-scroll">
        <table class="stats-table" style="margin-top:6px;"><tbody>${zeroRows.join('')}</tbody></table>
      </div>
    </details>` : '';

  return `
    ${sc.label ? `<h3>${esc(sc.label)}</h3>` : ''}
    <div class="table-scroll">
    <table class="stats-table" style="margin-bottom:10px;">
      <thead><tr>
        <th style="width:200px;">教科</th><th style="width:64px;">今週</th>
        <th style="width:74px;">実施済${infoHTML('今日までの日付のコマ(中止を除く)。教育委員会への実施時数報告はこちらを使います')}</th>
        ${detail ? `<th style="width:74px;">予定計${infoHTML('表示中の週までに入力したコマの合計(未来日を含む)')}</th>` : ''}
        <th style="width:74px;">標準${infoHTML('学校教育法施行規則の年間標準授業時数。クリックで上書きできます(標準は下限でも上限でもありません)')}</th>
        <th style="width:64px;">残り${infoHTML('標準時数−入力済みのコマ数(未来日を含む)')}</th>
        ${detail ? `<th style="width:84px;">必要ペース${infoHTML('残り時数÷残り授業週数。長期休業を設定すると休業週を除いて計算します')}</th><th style="width:70px;">見込み${infoHTML('現在のペースが続いた場合の年度末の着地')}</th>` : ''}
        <th>進捗</th>
      </tr></thead>
      <tbody>
        ${activeRows.join('')}
        <tr style="background:#f8fafc;">
          <td class="subj">合計</td><td>${fmtHours(sumWeek)}</td><td>${fmtHours(sumDone)}</td>
          ${detail ? `<td><b>${fmtHours(sumTotal)}</b></td><td colspan="5"></td>` : '<td colspan="3"></td>'}
        </tr>
      </tbody>
    </table>
    </div>
    ${zeroBlock}
    ${monthlyTable}`;
}

// ---------------------------------------------------------------- CSV出力(教育委員会報告用・数値)

function downloadCSV(state, weekStart) {
  const s = state.settings;
  const hours = computeHours(state, weekStart);
  const monthly = computeMonthlyHours(state, weekStart);
  // 実施は今日現在で数える(過去週を表示していても報告値が欠けないように基準週を別に取る)
  const doneRef = doneRefWeek(weekStart);
  const monthlyDone = computeMonthlyHours(state, doneRef);
  const scopes = scopesOf(s, hours);
  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }
  const num = (x) => Math.round(x * 1000) / 1000;
  // CSVフィールドの引用(カンマ・引用符・改行を含む教科名や学級名でも壊れない)
  const q = (v) => {
    const str = String(v ?? '');
    return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  const row = (cells) => cells.map(q).join(',');

  const head = ['学級・学年', '教科', '区分', ...MONTH_ORDER.map(m => `${m}月`), ...MONTH_ORDER.map(m => `${m}月末累計`), '計', '標準', '標準との差'];
  const lines = [row(head)];
  for (const sc of scopes) {
    const scopeVal = sc.scope === '' ? null : sc.scope;
    const getM = (map, subjKey) => {
      if (!map) return 0;
      let v = map.get(scopeKey(subjKey, scopeVal)) || 0;
      for (const ck of childrenOf[subjKey] || []) v += map.get(scopeKey(ck, scopeVal)) || 0;
      return v;
    };
    for (const subj of s.subjects) {
      if (subj.parent && keys.has(subj.parent)) continue;
      const months = MONTH_ORDER.map(m => getM(monthly.months.get(m), subj.key));
      const total = months.reduce((a, b) => a + b, 0);
      const monthsDone = MONTH_ORDER.map(m => getM(monthlyDone.monthsDone.get(m), subj.key));
      const totalDone = monthsDone.reduce((a, b) => a + b, 0);
      if (!total && !totalDone) continue;
      const cumsOf = (arr) => { let c = 0; return arr.map(v => { c += v; return c; }); };
      const std = standardHoursFor(s, subj.key, sc.grade);
      const label = sc.label || `${s.grade}年${s.className || ''}`;
      lines.push(row([
        label, subj.name, '計画',
        ...months.map(num), ...cumsOf(months).map(num), num(total),
        std ?? '', std != null ? num(total - std) : '',
      ]));
      lines.push(row([
        label, subj.name, '実施',
        ...monthsDone.map(num), ...cumsOf(monthsDone).map(num), num(totalDone),
        std ?? '', std != null ? num(totalDone - std) : '',
      ]));
    }
  }
  if (lines.length === 1) { toast('まだ出力できる時数がありません', 'error'); return; }
  // ファイル名の年度は閲覧中の週から導出する(前年度の集計を新年度ラベルで出さない)
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `時数集計_${fy}年度_${weekStart}まで.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('CSVを保存しました');
}
