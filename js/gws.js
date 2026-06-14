/**
 * Google Workspace連携のデータ組み立て(クライアント側)。
 * GAS側(gas/Code.gs)はここで組み立てた構造をそのまま書き出すだけにし、
 * 週案のドメイン知識(教科・進度・時数)はすべてフロントに置く。
 */

import { store, cellKey, effectivePeriod, computeOrdinals, resolveEntryText, computeHours, computeMonthlyHours, doneRefWeek, scopeKey, fmtHours, standardHoursFor, breakNameOf, weekDayOffsets } from './store.js';
import { parseDate, addDays, fmtMD, fmtDate, weekNumberInFiscalYear, fiscalYearOf, DAY_NAMES, esc } from './utils.js';
import { holidayName } from './holidays.js';
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
    // 中止コマは進度カウント外でordinalsに無く自動反映が空になるため、中止時点の予定内容を使う
    // (画面・印刷と同じ規則。提出物に「何が中止か」を残す)
    const resolved = resolveEntryText(state, e, ordinals);
    const text = e.cancelled ? (e.cancelledText || resolved.text) : resolved.text;
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
  const days = weekDayOffsets(s, week, monday);
  const ordinals = computeOrdinals(state, weekStart);
  const events = [];
  let skipped = 0;

  for (const d of days) {
    const date = fmtDate(addDays(monday, d));
    for (const p of s.periods) {
      const eff = effectivePeriod(s, week, d, p);
      if (!eff) continue;
      const cell = week.cells?.[cellKey(d, p.id)];
      if (!cell?.entries?.length) continue;
      const active = cell.entries.filter(e => e.subjectKey && !e.cancelled);
      if (!active.length) continue;
      if (!eff.start || !eff.end) { skipped++; continue; }
      const title = `${p.label}${p.type === 'module' ? '' : '校時'} ` + active.map(e => { // 画面・印刷と同一表記(規約6)
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
  return { events, skipped, from: weekStart, to: fmtDate(addDays(monday, days[days.length - 1])) };
}

// ---------------------------------------------------------------- メール提出

/** 週案のHTMLメール(Gmail互換: すべてインラインスタイル・102KB未満) */
export function buildWeekEmail(weekStart) {
  const state = store.state;
  const s = state.settings;
  const week = store.getWeek(weekStart);
  const monday = parseDate(weekStart);
  const days = weekDayOffsets(s, week, monday);
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);
  const lastDay = addDays(monday, days[days.length - 1]);

  const modeLabel = s.mode === 'fukushiki'
    ? `${s.fukushikiGrades[0]}・${s.fukushikiGrades[1]}年${s.className || ''}(複式)`
    : s.mode === 'senka' ? '専科' : `${s.grade}年${s.className || ''}`;

  const td = 'border:1px solid #999; padding:4px 6px; font-size:12px; vertical-align:top; background-color:#ffffff; color:#222222;';
  const th = 'border:1px solid #999; padding:4px 6px; font-size:12px; background-color:#eef2f7; color:#222222; font-weight:bold;';

  let head = `<tr><th style="${th}"></th>`;
  for (const d of days) {
    const hol = s.showHolidays ? holidayName(addDays(monday, d)) : null;
    head += `<th style="${th}">${DAY_NAMES[d]} ${fmtMD(addDays(monday, d))}${hol ? `<br><span style="color:#cc0000; font-size:10px;">${esc(hol)}</span>` : ''}</th>`;
  }
  head += '</tr>';

  let eventsRow = `<tr><th style="${th}">行事</th>`;
  for (const d of days) {
    eventsRow += `<td style="${td} background-color:#fffbeb;">${esc(week.events?.[d] || '').replace(/\n/g, '<br>')}</td>`;
  }
  eventsRow += '</tr>';

  // 祝日・長期休業の日は空白サマリーの母数に入れない(授業のない日を未入力扱いで管理職に列挙しない)
  // d は実際の曜日番号(土日=5,6も入る)なので位置配列でなくday番号キーにする
  const offDay = {};
  for (const d of days) offDay[d] = !!((s.showHolidays && holidayName(addDays(monday, d))) || breakNameOf(s, fmtDate(addDays(monday, d))));

  let body = '';
  let filled = 0;
  const blanks = [];
  for (const p of s.periods) {
    body += `<tr><th style="${th}">${esc(p.label)}</th>`;
    for (const d of days) {
      const eff = effectivePeriod(s, week, d, p);
      const text = eff ? cellText(state, week, d, p, ordinals) : '—';
      if (eff && p.type === 'lesson' && !offDay[d]) {
        if (text) filled++;
        else blanks.push(`${DAY_NAMES[d]}${p.label}`);
      }
      body += `<td style="${td}">${esc(text).replace(/\n/g, '<br>')}</td>`;
    }
    body += '</tr>';
  }

  // 受け取る側(管理職)が確認しやすいサマリー: 入力済み/空白コマと週時数
  const summary = `入力済み${filled}コマ` + (blanks.length ? ` / 空白${blanks.length}コマ(${blanks.slice(0, 8).join('・')}${blanks.length > 8 ? '…' : ''})` : ' / 空白なし');

  // 週・累計の時数ミニ表(印刷フッターと同じ情報)。複式は学年别に行を分ける(合算は提出書類として誤り)
  const hours = computeHours(state, weekStart);
  const hourScopeGroups = s.mode === 'fukushiki'
    ? s.fukushikiGrades.map(g => ({ label: `${g}年`, scopes: [g] }))
    : [{ label: '', scopes: s.mode === 'senka' ? [...s.senkaClasses.map(c => c.id), null] : [null] }];

  // 合算先(parent)の実在チェック(他の集計箇所と同じ規則)。
  // 親教科を削除済みの子教科は独立行として出す(行スキップすると時数が無言で欠落する)
  const subjKeys = new Set(s.subjects.map(x => x.key));
  const hoursRowsHTML = [];
  let hourNames = null;
  for (const grp of hourScopeGroups) {
    const items = [];
    for (const subj of s.subjects) {
      if (subj.parent && subjKeys.has(subj.parent)) continue;
      let wk = 0, tt = 0;
      for (const k of [subj.key, ...s.subjects.filter(x => x.parent === subj.key).map(x => x.key)]) {
        for (const sc of grp.scopes) {
          const v = hours.get(scopeKey(k, sc));
          if (v) { wk += v.week; tt += v.total; }
        }
      }
      if (wk > 0 || tt > 0) items.push({ name: subj.short || subj.name, wk, tt });
    }
    if (!items.length) continue;
    if (!hourNames) {
      hourNames = items.map(i => i.name);
    } else {
      for (const i of items) if (!hourNames.includes(i.name)) hourNames.push(i.name);
    }
    const find = (n) => items.find(i => i.name === n);
    hoursRowsHTML.push({
      grp,
      week: (names) => names.map(n => `<td style="${td} text-align:center;">${find(n) ? fmtHours(find(n).wk) : ''}</td>`).join(''),
      total: (names) => names.map(n => `<td style="${td} text-align:center;">${find(n) ? fmtHours(find(n).tt) : ''}</td>`).join(''),
    });
  }
  const hoursTable = hoursRowsHTML.length ? `
    <table cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin-top:10px;">
      <tr><th style="${th}"></th>${hourNames.map(n => `<th style="${th}">${esc(n)}</th>`).join('')}</tr>
      ${hoursRowsHTML.map(r => `
      <tr><th style="${th}">${esc(r.grp.label)}週</th>${r.week(hourNames)}</tr>
      <tr><th style="${th}">${esc(r.grp.label)}計</th>${r.total(hourNames)}</tr>`).join('')}
    </table>` : '';

  const title = `週指導計画 ${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日〜${lastDay.getMonth() + 1}月${lastDay.getDate()}日(第${weekNo}週)`;
  const html = `
  <div style="font-family:sans-serif; color:#222222; background-color:#ffffff;">
    <h2 style="font-size:16px; color:#222222;">${esc(title)}</h2>
    <p style="font-size:13px; color:#222222;">${esc(s.schoolName || '')} ${esc(modeLabel)} ${esc(s.teacherName || '')}<br>
      <span style="color:#666666; font-size:12px;">${esc(summary)}</span></p>
    <table cellspacing="0" cellpadding="0" style="border-collapse:collapse; width:100%; max-width:900px;">
      ${head}${eventsRow}${body}
    </table>
    ${week.goals ? `<p style="font-size:12.5px; color:#222222;"><b>今週のめあて:</b> ${esc(week.goals).replace(/\n/g, '<br>')}</p>` : ''}
    ${week.reflection ? `<p style="font-size:12.5px; color:#222222;"><b>反省:</b> ${esc(week.reflection).replace(/\n/g, '<br>')}</p>` : ''}
    ${hoursTable}
    <p style="font-size:11px; color:#888888;">ルーズリーフから送信</p>
  </div>`;

  // テキスト版にもタブ区切りの表を入れる(HTML非対応メーラー対策)
  const textRows = [title, `${s.schoolName || ''} ${modeLabel} ${s.teacherName || ''}`, summary, ''];
  textRows.push(['', ...days.map(d => `${DAY_NAMES[d]}${fmtMD(addDays(monday, d))}`)].join('\t'));
  for (const p of s.periods) {
    const row = [p.label];
    for (const d of days) {
      const eff = effectivePeriod(s, week, d, p);
      row.push(eff ? cellText(state, week, d, p, ordinals, { withNote: false }).replace(/\n/g, ' / ') : '—');
    }
    textRows.push(row.join('\t'));
  }
  const text = textRows.join('\n');

  // 件名: 第n週+肩書+氏名。同週の再送には再提出マークを付ける(最新版がどれか分かるように)
  const resent = week.lastMailedAt ? `(再提出 ${new Date().getMonth() + 1}/${new Date().getDate()} ${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')})` : '';
  const subject = `【週案】第${weekNo}週 ${monday.getMonth() + 1}/${monday.getDate()}〜 ${modeLabel} ${s.teacherName || ''}${resent}`.trim();
  return { subject, html, text, summary };
}

/** メール送信成功後に呼ぶ(再送マーク用の送信記録) */
export function markMailed(weekStart) {
  const week = store.getWeek(weekStart, true);
  week.lastMailedAt = Date.now();
  store.commit();
}

// ---------------------------------------------------------------- シート書き出し

/** 1週間の週案をスプレッドシート用の2次元配列に */
export function buildWeekSheet(weekStart) {
  const state = store.state;
  const s = state.settings;
  const week = store.getWeek(weekStart);
  const monday = parseDate(weekStart);
  const days = weekDayOffsets(s, week, monday);
  const ordinals = computeOrdinals(state, weekStart);
  const weekNo = weekNumberInFiscalYear(monday);

  const header = [''].concat(days.map(d => `${DAY_NAMES[d]} ${fmtMD(addDays(monday, d))}`));
  const rows = [];
  rows.push(['行事'].concat(days.map(d => week.events?.[d] || '')));
  for (const p of s.periods) {
    const row = [p.label];
    for (const d of days) {
      const eff = effectivePeriod(s, week, d, p);
      row.push(eff ? cellText(state, week, d, p, ordinals) : '—');
    }
    rows.push(row);
  }
  const footer = [];
  if (week.goals) footer.push([`めあて・重点: ${week.goals}`]);
  if (week.reflection) footer.push([`反省: ${week.reflection}`]);

  const lastDay = addDays(monday, days[days.length - 1]);
  return {
    sheetName: `週案 ${monday.getMonth() + 1}月${monday.getDate()}日週`, // シート名に「/」は使えないため月日表記
    title: `週指導計画 ${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日〜${lastDay.getMonth() + 1}月${lastDay.getDate()}日(第${weekNo}週) ${s.schoolName || ''} ${s.teacherName || ''}`,
    header, rows, footer,
  };
}

/** 時数レポート(教科×月+学期+年度計+標準との差)。計画/実施の2行で出す */
export function buildHoursReport(weekStart) {
  const state = store.state;
  const s = state.settings;
  const monthly = computeMonthlyHours(state, weekStart);
  // 実施は表示中の週ではなく今日現在で数える(報告値が欠けない)
  const monthlyDone = computeMonthlyHours(state, doneRefWeek(weekStart));

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
      const monthsDone = MONTH_ORDER.map(m => {
        const v = get(monthlyDone.monthsDone.get(m), subj.key);
        return v ? fmtHours(v) : '';
      });
      const termsDone = monthlyDone.termsDone.map(t => {
        const v = get(t.hours, subj.key);
        return v ? fmtHours(v) : '';
      });
      const totalDone = monthlyDone.termsDone.reduce((a, t) => a + get(t.hours, subj.key), 0);
      if (!total && !totalDone) continue;
      const std = standardHoursFor(s, subj.key, sc.grade);
      const name = (sc.label ? `${sc.label} ` : '') + subj.name;
      rows.push({
        subject: `${name}(計画)`,
        months, terms,
        total: fmtHours(total),
        standard: std != null ? String(std) : '',
        remain: std != null ? fmtHours(std - total) : '',
      });
      rows.push({
        subject: `${name}(実施)`,
        months: monthsDone, terms: termsDone,
        total: fmtHours(totalDone),
        standard: std != null ? String(std) : '',
        remain: std != null ? fmtHours(std - totalDone) : '',
      });
    }
  }
  // シート名の年度は閲覧中の週から導出する(settings.fiscalYearは常に現在年度のため、
  // 4月以降に前年度の週を出力するとデータと年度ラベルが食い違う)
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));
  return {
    sheetName: `時数 ${fy}年度`,
    monthLabels: MONTH_ORDER.map(m => `${m}月`),
    termLabels: monthly.terms.map(t => t.name),
    rows,
  };
}
