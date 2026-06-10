/**
 * 年間指導計画のインポートパーサ。
 * 教科書会社(東京書籍・光村図書・啓林館など)の年間指導計画はExcel配布が主流のため、
 * 「Excelからコピーして貼り付け(TSV)」と「CSVファイル」の両方を受け付ける。
 *
 * 対応形式(ヘッダー行から自動判定):
 *  A) 単元行形式: 単元名, 時数 [, 内容]    … 1行=1単元。内容は「|」「｜(全角)」改行区切りで各時に展開
 *  B) 時案行形式: 単元名, 内容             … 1行=1時間。連続する同名単元をグループ化
 *  ヘッダーに「月」「週」など余分な列があっても、単元/時数/内容に相当する列だけ拾う。
 */

const UNIT_HEADERS = ['単元', '単元名', '題材', '題材名', '教材', '教材名', 'unit'];
const HOURS_HEADERS = ['時数', '配当時数', '時間', '時間数', 'コマ', 'hours'];
const CONTENT_HEADERS = ['内容', '学習内容', '学習活動', '主な学習活動', 'ねらい', '本時', 'content'];

/** CSV/TSVテキストを2次元配列へ(クォート対応、区切りはタブ優先で自動判定) */
export function parseTable(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const delim = text.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function findCol(header, names) {
  return header.findIndex(h => names.some(n => h.trim().toLowerCase().includes(n)));
}

/**
 * テーブルを単元リストへ変換。
 * 戻り値: { units: [{name, hours, lessons:[{text}]}], format: 'A'|'B', warnings: [] }
 */
export function tableToUnits(rows) {
  if (!rows.length) throw new Error('データが空です');
  const warnings = [];
  let header = rows[0].map(c => String(c));
  let unitCol = findCol(header, UNIT_HEADERS);
  let hoursCol = findCol(header, HOURS_HEADERS);
  let contentCol = findCol(header, CONTENT_HEADERS);
  let body = rows.slice(1);

  // ヘッダー行が無い場合: 列数から推定(1列目=単元、2列目=数値なら時数、3列目=内容)
  if (unitCol === -1) {
    header = null;
    body = rows;
    unitCol = 0;
    const second = rows.map(r => r[1]).filter(v => v != null && v !== '');
    const numeric = second.length > 0 && second.every(v => !isNaN(parseFloat(v)));
    hoursCol = numeric ? 1 : -1;
    contentCol = numeric ? 2 : 1;
    warnings.push('ヘッダー行が見つからないため、1列目=単元名として読み込みました。');
  }

  const units = [];
  const formatA = hoursCol !== -1;
  if (formatA) {
    for (const r of body) {
      const name = (r[unitCol] || '').trim();
      if (!name) continue;
      const hours = parseFloat(r[hoursCol]) || 1;
      const contentRaw = contentCol !== -1 ? (r[contentCol] || '') : '';
      const lessons = splitContents(contentRaw).map(t => ({ text: t }));
      units.push({ name, hours, lessons });
    }
  } else {
    // 1行=1時間。同名単元(または空欄=直前と同じ)をまとめる
    let cur = null;
    for (const r of body) {
      const name = (r[unitCol] || '').trim();
      const content = contentCol !== -1 ? (r[contentCol] || '').trim() : '';
      if (name && (!cur || cur.name !== name)) {
        cur = { name, hours: 0, lessons: [] };
        units.push(cur);
      }
      if (!cur) continue;
      cur.hours += 1;
      cur.lessons.push({ text: content });
    }
  }
  if (!units.length) throw new Error('単元を読み取れませんでした。1列目に単元名があるか確認してください。');
  return { units, format: formatA ? 'A' : 'B', warnings };
}

function splitContents(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s.split(/\n|\||｜/).map(t => t.trim()).filter(Boolean);
}

/** 単元リスト→CSVテキスト(エクスポート用) */
export function unitsToCSV(units) {
  const escCsv = v => {
    v = String(v ?? '');
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = ['単元名,時数,内容'];
  for (const u of units) {
    const contents = (u.lessons || []).map(l => l.text).join('|');
    lines.push([escCsv(u.name), u.hours, escCsv(contents)].join(','));
  }
  return lines.join('\n');
}
