/** 時数集計ビュー: 進度一覧(専科・複式)・教科別集計・月別/学期別・CSV/印刷 */

import { store, computeHours, computeMonthlyHours, computeOrdinals, lessonFromPlan, fmtHours, standardHoursFor, scopeKey, cellKey, effectivePeriod } from '../store.js';
import { weekNumberInFiscalYear, parseDate, addDays, fmtDate, fmtMD, esc } from '../utils.js';
import { toast, infoHTML } from '../ui.js';

const MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

export function renderStatsView(root, ctx) {
  const state = store.state;
  const s = state.settings;
  const weekStart = ctx.getWeekStart();
  const hours = computeHours(state, weekStart);
  const monthly = computeMonthlyHours(state, weekStart);
  const weekNo = weekNumberInFiscalYear(parseDate(weekStart));

  const scopes = scopesOf(s, hours);
  const sections = scopes.map(sc => renderScopeTable(state, hours, monthly, sc, weekNo)).filter(Boolean).join('');
  const progress = renderProgress(state, weekStart);

  root.innerHTML = `
    <div class="panel">
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px;">
        <h2 style="margin:0;">時数集計</h2>
        <span class="hint">第${weekNo}週(${fmtMD(parseDate(weekStart))})まで・${s.fiscalYear}年度</span>
        <span class="spacer" style="flex:1;"></span>
        <button class="btn small" id="stats-csv">CSV</button>
        <button class="btn small" id="stats-print">🖨 印刷</button>
      </div>
      ${progress}
      ${sections || '<p class="hint">まだ授業の入力がありません。週案タブでコマをクリックして始めてください。</p>'}
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

  root.querySelector('#stats-csv').onclick = () => downloadCSV(state, weekStart);
  root.querySelector('#stats-print').onclick = async () => {
    const { buildStatsPrintDOM } = await import('../print.js');
    buildStatsPrintDOM(weekStart);
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

// ---------------------------------------------------------------- 進度一覧(専科・複式の核心ビュー)

/**
 * 学級(学年)×教科の進度マトリクス。
 * 「次の授業がどの単元の何時間目か」「前回いつやったか」を一覧する(実験準備・進度ズレ確認用)。
 */
function renderProgress(state, weekStart) {
  const s = state.settings;
  if (s.mode === 'homeroom') return '';
  const prog = progressByScope(state, weekStart);
  if (!prog.size) return '';

  const scopes = s.mode === 'fukushiki'
    ? s.fukushikiGrades.map(g => ({ scope: g, label: `${g}年`, grade: g }))
    : s.senkaClasses.map(c => ({ scope: c.id, label: c.label || '?', grade: c.grade }));

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

function renderScopeTable(state, hours, monthly, sc, weekNo) {
  const s = state.settings;
  const scopeVal = sc.scope === '' ? null : sc.scope;
  const get = (subjKey) => hours.get(scopeKey(subjKey, scopeVal)) || { week: 0, total: 0 };

  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }

  const activeRows = [];
  const zeroRows = [];
  let any = false;
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
    const std = standardHoursFor(s, subj.key, sc.grade);
    if (total === 0 && week === 0 && std == null) continue;
    any = true;
    const remain = std != null ? std - total : null;
    const weeksLeft = Math.max(0, (s.hoursBase || 35) - weekNo);
    const pace = remain != null && remain > 0 && weeksLeft > 0 ? remain / weeksLeft : null;
    const projected = weekNo >= 1 && total > 0 ? (total / weekNo) * (s.hoursBase || 35) : null;
    const pct = std ? Math.min(100, Math.round((total / std) * 100)) : 0;
    const over = std != null && total > std;
    const row = `
      <tr class="${over ? 'over' : ''}">
        <td class="subj"><span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>
          ${esc(subj.name)}${mergedFrom.length ? `<span class="hint">(+${mergedFrom.map(esc).join('・')})</span>` : ''}</td>
        <td>${fmtHours(week)}</td>
        <td><b>${fmtHours(total)}</b></td>
        <td><input data-std="${esc(subj.key)}@${sc.grade}" value="${std ?? ''}" placeholder="—"
              style="width:56px; border:none; background:transparent; text-align:right; font-family:inherit; font-size:13.5px;"></td>
        <td>${remain != null ? fmtHours(remain) : '—'}</td>
        <td>${pace != null ? fmtHours(pace) + ' /週' : '—'}</td>
        <td>${projected != null ? Math.round(projected) : '—'}</td>
        <td style="text-align:left;"><div class="bar-wrap"><div class="bar" style="width:${pct}%; background:${over ? '#dc2626' : esc(subj.color)}"></div></div></td>
      </tr>`;
    // 専科・複式では「時数0で標準だけある行」を畳む(自分の教科1行を探させない)
    if (s.mode !== 'homeroom' && total === 0 && week === 0) zeroRows.push(row);
    else activeRows.push(row);
  }
  if (!any) return '';
  if (!activeRows.length && s.mode !== 'homeroom') return ''; // この学級は未入力

  let sumWeek = 0, sumTotal = 0;
  for (const subj of s.subjects) {
    const v = get(subj.key);
    sumWeek += v.week; sumTotal += v.total;
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
      <summary class="fold-label">📅 月別・学期別</summary>
      <div style="overflow-x:auto; margin-top:8px;">
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
      <table class="stats-table" style="margin-top:6px;"><tbody>${zeroRows.join('')}</tbody></table>
    </details>` : '';

  return `
    ${sc.label ? `<h3>${esc(sc.label)}</h3>` : ''}
    <table class="stats-table" style="margin-bottom:10px;">
      <thead><tr>
        <th style="width:220px;">教科</th><th style="width:70px;">今週</th><th style="width:80px;">累計</th>
        <th style="width:80px;">標準${infoHTML('学校教育法施行規則の年間標準授業時数。クリックで上書きできます(標準は下限でも上限でもありません)')}</th>
        <th style="width:70px;">残り</th><th style="width:90px;">必要ペース</th><th style="width:80px;">見込み${infoHTML('現在のペースが続いた場合の年度末の着地')}</th><th>進捗</th>
      </tr></thead>
      <tbody>
        ${activeRows.join('')}
        <tr style="background:#f8fafc;">
          <td class="subj">合計</td><td>${fmtHours(sumWeek)}</td><td><b>${fmtHours(sumTotal)}</b></td>
          <td colspan="5"></td>
        </tr>
      </tbody>
    </table>
    ${zeroBlock}
    ${monthlyTable}`;
}

// ---------------------------------------------------------------- CSV出力(教育委員会報告用・数値)

function downloadCSV(state, weekStart) {
  const s = state.settings;
  const hours = computeHours(state, weekStart);
  const monthly = computeMonthlyHours(state, weekStart);
  const scopes = scopesOf(s, hours);
  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }
  const num = (x) => Math.round(x * 1000) / 1000;

  const head = ['学級・学年', '教科', ...MONTH_ORDER.map(m => `${m}月`), ...MONTH_ORDER.map(m => `${m}月末累計`), '年度計', '標準', '残り'];
  const lines = [head.join(',')];
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
      if (!total) continue;
      let cum = 0;
      const cums = months.map(v => { cum += v; return cum; });
      const std = standardHoursFor(s, subj.key, sc.grade);
      lines.push([
        sc.label || `${s.grade}年${s.className || ''}`,
        subj.name,
        ...months.map(num), ...cums.map(num),
        num(total),
        std ?? '',
        std != null ? num(std - total) : '',
      ].join(','));
    }
  }
  if (lines.length === 1) { toast('まだ出力できる時数がありません', 'error'); return; }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `時数集計_${s.fiscalYear}年度_${weekStart}まで.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('CSVを保存しました');
}
