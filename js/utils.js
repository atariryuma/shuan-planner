/** 日付・週・年度ユーティリティ(日本の年度 = 4月始まり、週は月曜始まり) */

export const DAY_NAMES = ['月', '火', '水', '木', '金', '土', '日'];

/** ローカルタイムで YYYY-MM-DD を返す(toISOStringのUTCずれを回避) */
export function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD → Date(ローカル0時) */
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** その日を含む週の月曜日を返す */
export function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = (d.getDay() + 6) % 7; // 月=0 … 日=6
  d.setDate(d.getDate() - dow);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

/** 日付が属する年度(4/1始まり) */
export function fiscalYearOf(date) {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

/**
 * 年度の第1週の月曜。
 * 週の所属年度は「週の木曜日」で判定するため(weekNumberInFiscalYear等と整合)、
 * 4/1を含む週の木曜が3月中の年(4/1が金土日)は翌週が年度第1週になる。
 */
export function fiscalYearFirstMonday(fiscalYear) {
  const m = mondayOf(new Date(fiscalYear, 3, 1));
  return fiscalYearOf(addDays(m, 3)) === fiscalYear ? m : addDays(m, 7);
}

/** 年度内の第n週(1始まり)。月曜日付から計算 */
export function weekNumberInFiscalYear(mondayDate) {
  const fy = fiscalYearOf(addDays(mondayDate, 3)); // 週の中央(木)で年度判定
  const first = fiscalYearFirstMonday(fy);
  return Math.round((mondayDate - first) / (7 * 24 * 3600 * 1000)) + 1;
}

/** M/D 表示 */
export function fmtMD(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 6/11 14:32 形式(規約の日付形式。秒・年は出さない) */
export function fmtMDHM(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 年の表記(西暦/令和)。useEra=trueなら「令和8年」 */
export function fmtYear(year, useEra) {
  if (!useEra) return `${year}年`;
  const r = year - 2018;
  return r === 1 ? '令和元年' : `令和${r}年`;
}

/** 年度の表記(西暦/令和) */
export function fmtFiscalYear(fiscalYear, useEra) {
  if (!useEra) return `${fiscalYear}年度`;
  const r = fiscalYear - 2018;
  return r === 1 ? '令和元年度' : `令和${r}年度`;
}

/** 簡易UUID */
export function uid() {
  return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** HTMLエスケープ */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
