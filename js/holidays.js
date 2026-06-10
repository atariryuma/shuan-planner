/**
 * 日本の祝日計算(2020年以降の現行法ベース、オフライン動作)。
 * 固定祝日 + ハッピーマンデー + 春分/秋分(近似式) + 振替休日 + 国民の休日 に対応。
 * 春分・秋分の近似式は1980〜2099年で有効。
 */

import { fmtDate } from './utils.js';

const cache = new Map(); // year -> Map<'YYYY-MM-DD', name>

/** n回目の指定曜日(dow: 0=日…1=月…)の日付 */
function nthWeekday(year, month, dow, nth) {
  const first = new Date(year, month - 1, 1);
  let day = 1 + ((dow - first.getDay() + 7) % 7) + (nth - 1) * 7;
  return new Date(year, month - 1, day);
}

function shunbun(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
function shubun(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** その暦年の祝日マップを返す(振替休日・国民の休日込み) */
export function holidaysOfYear(year) {
  if (cache.has(year)) return cache.get(year);
  const base = new Map(); // Date -> name(振替計算前)
  const add = (d, name) => base.set(fmtDate(d), name);

  add(new Date(year, 0, 1), '元日');
  add(nthWeekday(year, 1, 1, 2), '成人の日');
  add(new Date(year, 1, 11), '建国記念の日');
  add(new Date(year, 1, 23), '天皇誕生日');
  add(new Date(year, 2, shunbun(year)), '春分の日');
  add(new Date(year, 3, 29), '昭和の日');
  add(new Date(year, 4, 3), '憲法記念日');
  add(new Date(year, 4, 4), 'みどりの日');
  add(new Date(year, 4, 5), 'こどもの日');
  // 五輪特例(2020・2021)
  if (year === 2020) {
    add(new Date(2020, 6, 23), '海の日');
    add(new Date(2020, 6, 24), 'スポーツの日');
    add(new Date(2020, 7, 10), '山の日');
  } else if (year === 2021) {
    add(new Date(2021, 6, 22), '海の日');
    add(new Date(2021, 6, 23), 'スポーツの日');
    add(new Date(2021, 7, 8), '山の日');
  } else {
    add(nthWeekday(year, 7, 1, 3), '海の日');
    add(new Date(year, 7, 11), '山の日');
    add(nthWeekday(year, 10, 1, 2), 'スポーツの日');
  }
  add(nthWeekday(year, 9, 1, 3), '敬老の日');
  add(new Date(year, 8, shubun(year)), '秋分の日');
  add(new Date(year, 10, 3), '文化の日');
  add(new Date(year, 10, 23), '勤労感謝の日');

  const result = new Map(base);

  // 振替休日: 祝日が日曜なら、その後の最初の「祝日でない日」が休日になる
  for (const [key] of base) {
    const d = parseKey(key);
    if (d.getDay() !== 0) continue;
    const next = new Date(d);
    do { next.setDate(next.getDate() + 1); } while (base.has(fmtDate(next)));
    result.set(fmtDate(next), '振替休日');
  }

  // 国民の休日: 前後を祝日に挟まれた平日(敬老の日と秋分の日の間で発生し得る)
  for (const [key] of base) {
    const d = parseKey(key);
    const mid = new Date(d); mid.setDate(mid.getDate() + 1);
    const after = new Date(d); after.setDate(after.getDate() + 2);
    const midKey = fmtDate(mid);
    if (base.has(fmtDate(after)) && !result.has(midKey) && mid.getDay() !== 0) {
      result.set(midKey, '国民の休日');
    }
  }

  cache.set(year, result);
  return result;
}

function parseKey(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 日付の祝日名(なければnull) */
export function holidayName(date) {
  return holidaysOfYear(date.getFullYear()).get(fmtDate(date)) || null;
}
