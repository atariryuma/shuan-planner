/**
 * Google Workspace連携のデータ組み立て(クライアント側)。
 * GAS側(gas/Code.gs)はここで組み立てた構造をそのまま書き出すだけにし、
 * 週案のドメイン知識(教科・進度・時数)はすべてフロントに置く。
 */

import { store, cellKey, effectivePeriod, computeOrdinals, resolveEntryText, computeHours, computeMonthlyHours, scopeKey, fmtHours, standardHoursFor } from './store.js';
import { parseDate, addDays, fmtMD, fmtDate, weekNumberInFiscalYear, DAY_NAMES, esc } from './utils.js';
import { subjectOf, fracLabel } from './views/week.js';

const MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

function scopeLabelOf(s, scope) {
  if (scope == null || scope === '') return '';
  if (s.mode === 'fukushiki') return `${scope}年`;
  if (s.mode === 'senka') return s.senkaClasses.find(c => c.id === scope)?.label || '';
  return '';
}

/** セル1コマぶんの表示テキスト(プレーン)を組み立てる */
function cellText(state, week, dayIdx, period, ordinals, { withNote = true } = {}) {
  const s = state.settings;
  const cell = week.cells?.[cellKey(dayIdx, period.id)];
  if (!cell?.entries?.length) return '';
  return cell.entries.map(e => {
    const subj = subjectOf(s, e.subjectKey);
    const { text } = resolveEntryText(state, e, ordinals);
    const parts = [];
    const scopeLabel = scopeLabelOf(s, e.scope);
    if (scopeLabel) parts.push(`[${scopeLabel}]`);
    if (subj) parts.push(subj.name + ((e.fraction ?? 1) !== 1 ? `(${fracLabel(e.fraction)})` : ''));
    if (text) parts.push(text);
    if (withNote && e.note) parts.push(`※${e.note}`);
    if (e.cancelled) parts.push('【中止】');
    return parts.join(' ');
  }).join('\n');
}

// ---------------------------------------------------------------- カレンダー書き出し

/**
 * 週案→カレンダーイベント配列。校時の開始・終了時刻があるコマのみ対象。
 * タイトル: 「1限 国語」 詳細: 単元・内容・備考。
 */
export function buildCalendarEvents(weekStart) {
  const state = store.state;
  const s = state.settings;
  const week = store.getWeek(weekStart);
  const monday = parseDate(weekStart);
  const dayCount = s.saturday ? 6 : 5;
  const ordinals = computeOrdinals(state, weekStart);
  const events = [];
  let skipped = 0;

  for (let d = 0; d < dayCount; d++) {
    const date = fmtDate(addDays(monday, d));
    for (const p of s.periods) {
      const eff = effectivePeriod(s, week, d, p);
      if (!eff) continue;
      const cell = week.cells?.[cellKey(d, p.id)];
      if (!cell?.entries?.length) continue;
      const active = cell.entries.filter(e => e.subjectKey && !e.cancelled);
      if (!active.length) continue;
      if (!eff.start || !eff.end) { skipped++; continue; }
      const title = `${p.label}${p.type === 'module' ? '' : '限'} ` + active.map(e => {
        const subj = subjectOf(s, e.subjectKey);
        const scopeLabel = scopeLabelOf(s, e.scope);
        return (scopeLabel ? scopeLabel + ' ' : '') + (subj?.name || '');
      }).join('・');
      const detail = active.map(e => {
        const { text } = resolveEntryText(state, e, ordinals);
        return [text, e.note ? `※${e.note}` : ''].filter(Boolean).join(' ');
      }).filter(Boolean).join('\n');
      events.push({ date, start: eff.start, end: eff.end, title, detail });
    }
  }
  return { events, skipped, from: weekStart, to: fmtDate(addDays(monday, dayCount - 1)) };
}

// ---------------------------------------------------------------- メール提出

/** 週案のHTMLメール(Gmail互換: すべてインラインスタイル・102KB未満) */
export function buildWeekEmail(weekStart) {
  const state = store.state;
  const s = state.settings;
  const week = store.getWeek(weekStart);
  const monday = parseDate(weekStart);
  const dayCount = s.saturday ? 6 : 5;
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);
  const lastDay = addDays(monday, dayCount - 1);

  const modeLabel = s.mode === 'fukushiki'
    ? `${s.fukushikiGrades[0]}・${s.fukushikiGrades[1]}年${s.className || ''}(複式)`
    : s.mode === 'senka' ? '専科' : `${s.grade}年${s.className || ''}`;

  const td = 'border:1px solid #999; padding:4px 6px; font-size:12px; vertical-align:top; background-color:#ffffff; color:#222222;';
  const th = 'border:1px solid #999; padding:4px 6px; font-size:12px; background-color:#eef2f7; color:#222222; font-weight:bold;';

  let head = `<tr><th style="${th}"></th>`;
  for (let d = 0; d < dayCount; d++) {
    head += `<th style="${th}">${DAY_NAMES[d]} ${fmtMD(addDays(monday, d))}</th>`;
  }
  head += '</tr>';

  let eventsRow = `<tr><th style="${th}">行事</th>`;
  for (let d = 0; d < dayCount; d++) {
    eventsRow += `<td style="${td} background-color:#fffbeb;">${esc(week.events?.[d] || '').replace(/\n/g, '<br>')}</td>`;
  }
  eventsRow += '</tr>';

  let body = '';
  for (const p of s.periods) {
    body += `<tr><th style="${th}">${esc(p.label)}</th>`;
    for (let d = 0; d < dayCount; d++) {
      const eff = effectivePeriod(s, week, d, p);
      const text = eff ? cellText(state, week, d, p, ordinals) : '—';
      body += `<td style="${td}">${esc(text).replace(/\n/g, '<br>')}</td>`;
    }
    body += '</tr>';
  }

  const title = `週指導計画 ${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日〜${lastDay.getMonth() + 1}月${lastDay.getDate()}日(第${weekNo}週)`;
  const html = `
  <div style="font-family:sans-serif; color:#222222; background-color:#ffffff;">
    <h2 style="font-size:16px; color:#222222;">${esc(title)}</h2>
    <p style="font-size:13px; color:#222222;">${esc(s.schoolName || '')} ${esc(modeLabel)} ${esc(s.teacherName || '')}</p>
    <table cellspacing="0" cellpadding="0" style="border-collapse:collapse; width:100%; max-width:900px;">
      ${head}${eventsRow}${body}
    </table>
    ${week.goals ? `<p style="font-size:12.5px; color:#222222;"><b>今週のめあて・重点:</b> ${esc(week.goals).replace(/\n/g, '<br>')}</p>` : ''}
    ${week.reflection ? `<p style="font-size:12.5px; color:#222222;"><b>反省・次週への課題:</b> ${esc(week.reflection).replace(/\n/g, '<br>')}</p>` : ''}
    <p style="font-size:11px; color:#888888;">週案プランナーから送信</p>
  </div>`;

  const text = `${title}\n${s.schoolName || ''} ${modeLabel} ${s.teacherName || ''}\n(HTML対応のメールソフトでご覧ください)`;
  const subject = `【週案】${monday.getMonth() + 1}/${monday.getDate()}〜 ${modeLabel} ${s.teacherName || ''}`.trim();
  return { subject, html, text };
}

// ---------------------------------------------------------------- シート書き出し

/** 1週間の週案をスプレッドシート用の2次元配列に */
export function buildWeekSheet(weekStart) {
  const state = store.state;
  const s = state.settings;
  const week = store.getWeek(weekStart);
  const monday = parseDate(weekStart);
  const dayCount = s.saturday ? 6 : 5;
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);

  const header = [''].concat(Array.from({ length: dayCount }, (_, d) => `${DAY_NAMES[d]} ${fmtMD(addDays(monday, d))}`));
  const rows = [];
  rows.push(['行事'].concat(Array.from({ length: dayCount }, (_, d) => week.events?.[d] || '')));
  for (const p of s.periods) {
    const row = [p.label];
    for (let d = 0; d < dayCount; d++) {
      const eff = effectivePeriod(s, week, d, p);
      row.push(eff ? cellText(state, week, d, p, ordinals) : '—');
    }
    rows.push(row);
  }
  const footer = [];
  if (week.goals) footer.push([`めあて・重点: ${week.goals}`]);
  if (week.reflection) footer.push([`反省: ${week.reflection}`]);

  const lastDay = addDays(monday, dayCount - 1);
  return {
    sheetName: `週案 ${monday.getMonth() + 1}.${monday.getDate()}週`,
    title: `週指導計画 ${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日〜${lastDay.getMonth() + 1}月${lastDay.getDate()}日(第${weekNo}週) ${s.schoolName || ''} ${s.teacherName || ''}`,
    header, rows, footer,
  };
}

/** 時数レポート(教科×月+学期+年度計+標準との差) */
export function buildHoursReport(weekStart) {
  const state = store.state;
  const s = state.settings;
  const monthly = computeMonthlyHours(state, weekStart);

  // 親教科に合算(画面の集計と同じ規則)
  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }
  // 画面の時数集計(stats.js)と同じスコープ集合にする(専科の「学級指定なし」も含める)
  const scopes = s.mode === 'fukushiki' ? s.fukushikiGrades.map(g => ({ scope: g, grade: g, label: `${g}年` }))
    : s.mode === 'senka'
      ? [...s.senkaClasses.map(c => ({ scope: c.id, grade: c.grade, label: c.label })), { scope: null, grade: s.grade, label: '(学級指定なし)' }]
      : [{ scope: null, grade: s.grade, label: '' }];

  const rows = [];
  for (const sc of scopes) {
    const get = (map, subjKey) => {
      if (!map) return 0;
      let v = map.get(scopeKey(subjKey, sc.scope)) || 0;
      for (const ck of childrenOf[subjKey] || []) v += map.get(scopeKey(ck, sc.scope)) || 0;
      return v;
    };
    for (const subj of s.subjects) {
      if (subj.parent && keys.has(subj.parent)) continue;
      const months = MONTH_ORDER.map(m => {
        const v = get(monthly.months.get(m), subj.key);
        return v ? fmtHours(v) : '';
      });
      const terms = monthly.terms.map(t => {
        const v = get(t.hours, subj.key);
        return v ? fmtHours(v) : '';
      });
      const total = monthly.terms.reduce((a, t) => a + get(t.hours, subj.key), 0);
      if (!total) continue;
      const std = standardHoursFor(s, subj.key, sc.grade);
      rows.push({
        subject: (sc.label ? `${sc.label} ` : '') + subj.name,
        months, terms,
        total: fmtHours(total),
        standard: std != null ? String(std) : '',
        remain: std != null ? fmtHours(std - total) : '',
      });
    }
  }
  return {
    sheetName: `時数 ${s.fiscalYear}年度`,
    monthLabels: MONTH_ORDER.map(m => `${m}月`),
    termLabels: monthly.terms.map(t => t.name),
    rows,
  };
}
