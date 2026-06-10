/** 時数集計ビュー: 教科別の週時数・年度累計・標準時数との比較、月別・学期別集計 */

import { store, computeHours, computeMonthlyHours, fmtHours, standardHoursFor, scopeKey } from '../store.js';
import { weekNumberInFiscalYear, parseDate, esc } from '../utils.js';

const MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

export function renderStatsView(root, ctx) {
  const state = store.state;
  const s = state.settings;
  const weekStart = ctx.getWeekStart();
  const hours = computeHours(state, weekStart);
  const monthly = computeMonthlyHours(state, weekStart);
  const weekNo = weekNumberInFiscalYear(parseDate(weekStart));

  // スコープ(通常='', 複式=学年, 専科=学級)ごとにセクションを分ける
  const scopes = [];
  if (s.mode === 'fukushiki') {
    for (const g of s.fukushikiGrades) scopes.push({ scope: g, label: `${g}年`, grade: g });
  } else if (s.mode === 'senka') {
    for (const c of s.senkaClasses) scopes.push({ scope: c.id, label: c.label, grade: c.grade });
    scopes.push({ scope: '', label: '(学級指定なし)', grade: s.grade });
  } else {
    scopes.push({ scope: '', label: '', grade: s.grade });
  }

  const sections = scopes.map(sc => renderScopeTable(state, hours, monthly, sc, weekNo)).filter(Boolean).join('');

  root.innerHTML = `
    <div class="panel">
      <h2>時数集計 <span class="hint" style="font-weight:normal;">第${weekNo}週(${esc(weekStart)} 週)までの累計 / ${s.fiscalYear}年度</span></h2>
      <p class="hint">
        「標準」は学校教育法施行規則 別表第一・第二の年間標準授業時数です(クリックで上書き編集可。標準時数は下限でも上限でもありません)。<br>
        モジュール校時は係数(例: 15分=1/3)で換算、「中止」「時数外」のコマは集計に含まれません。
        書写は国語に、保健は体育に合算して表示します。
      </p>
      ${sections || '<p class="hint">まだ授業の入力がありません。</p>'}
    </div>
  `;

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
}

function renderScopeTable(state, hours, monthly, sc, weekNo) {
  const s = state.settings;
  const scopeVal = sc.scope === '' ? null : sc.scope;
  const get = (subjKey) => hours.get(scopeKey(subjKey, scopeVal)) || { week: 0, total: 0 };

  // 読み替え(parent指定)の合算。親教科が削除されている場合は子を単独表示する
  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }

  const rows = [];
  let any = false;
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) continue; // 子教科は親に合算して表示
    const own = get(subj.key);
    let week = own.week, total = own.total;
    const mergedFrom = [];
    for (const ck of childrenOf[subj.key] || []) {
      const c = get(ck);
      if (c.total > 0 || c.week > 0) mergedFrom.push(s.subjects.find(x => x.key === ck)?.name || ck);
      week += c.week; total += c.total;
    }
    const std = standardHoursFor(s, subj.key, sc.grade);
    if (total === 0 && week === 0 && std == null) continue;
    any = true;
    const remain = std != null ? std - total : null;
    const weeksLeft = Math.max(0, (s.hoursBase || 35) - weekNo);
    const pace = remain != null && remain > 0 && weeksLeft > 0 ? remain / weeksLeft : null;
    // 年度末の着地見込み(現在のペースが続いた場合)
    const projected = weekNo >= 1 && total > 0 ? (total / weekNo) * (s.hoursBase || 35) : null;
    const pct = std ? Math.min(100, Math.round((total / std) * 100)) : 0;
    const over = std != null && total > std;
    rows.push(`
      <tr class="${over ? 'over' : ''}">
        <td class="subj"><span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>
          ${esc(subj.name)}${mergedFrom.length ? `<span class="hint">(+${mergedFrom.map(esc).join('・')})</span>` : ''}</td>
        <td>${fmtHours(week)}</td>
        <td><b>${fmtHours(total)}</b></td>
        <td><input data-std="${esc(subj.key)}@${sc.grade}" value="${std ?? ''}" placeholder="—"
              style="width:56px; border:none; background:transparent; text-align:right; font-family:inherit; font-size:13.5px;"></td>
        <td>${remain != null ? fmtHours(remain) : '—'}</td>
        <td>${pace != null ? fmtHours(pace) + ' /週' : '—'}</td>
        <td title="現在のペースが続いた場合の年度末見込み">${projected != null ? Math.round(projected) : '—'}</td>
        <td style="text-align:left;"><div class="bar-wrap"><div class="bar" style="width:${pct}%; background:${over ? '#dc2626' : esc(subj.color)}"></div></div></td>
      </tr>`);
  }
  if (!any) return '';

  // 合計行
  let sumWeek = 0, sumTotal = 0;
  for (const subj of s.subjects) {
    const v = get(subj.key);
    sumWeek += v.week; sumTotal += v.total;
  }

  // ---- 月別・学期別テーブル
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
      <summary style="cursor:pointer; font-size:13.5px; font-weight:700; color:#374151; padding:4px 0;">📅 月別・学期別の内訳を表示</summary>
      <div style="overflow-x:auto; margin-top:8px;">
        <table class="stats-table">
          <thead><tr><th style="width:60px;">教科</th>${MONTH_ORDER.map(m => `<th>${m}月</th>`).join('')}
            ${monthly.terms.map(t => `<th style="background:#eef2f7;">${esc(t.name)}</th>`).join('')}<th style="background:#e2e8f0;">年度計</th></tr></thead>
          <tbody>${monthlyRows}</tbody>
        </table>
        <p class="hint" style="margin-top:6px;">月をまたぐ週は、コマの実際の日付で月別に按分しています。学期の区切りは設定画面で変更できます。</p>
      </div>
    </details>` : '';

  return `
    ${sc.label ? `<h3>${esc(sc.label)}</h3>` : ''}
    <table class="stats-table" style="margin-bottom:10px;">
      <thead><tr>
        <th style="width:220px;">教科</th><th style="width:70px;">今週</th><th style="width:80px;">累計</th>
        <th style="width:80px;">標準(年)</th><th style="width:70px;">残り</th><th style="width:90px;">必要ペース</th><th style="width:80px;">年度末見込</th><th>進捗</th>
      </tr></thead>
      <tbody>
        ${rows.join('')}
        <tr style="background:#f8fafc;">
          <td class="subj">合計</td><td>${fmtHours(sumWeek)}</td><td><b>${fmtHours(sumTotal)}</b></td>
          <td colspan="5" style="text-align:left;" class="hint">参考: 年間総標準時数 小1=850 小2=910 小3=980 小4〜6/中=1015</td>
        </tr>
      </tbody>
    </table>
    ${monthlyTable}`;
}
