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
// 指導目標(本時のねらい)・学習活動・評価規準・観点を別列で取り込めるようにする
const OBJECTIVE_HEADERS = ['指導目標', 'ねらい', '本時の目標', 'めあて', '本時', '目標'];
const ACTIVITY_HEADERS = ['学習活動', '主な学習活動', '活動', '学習内容'];
const ASSESS_HEADERS = ['評価規準', '評価基準', '評価'];
const VIEWPOINT_HEADERS = ['観点'];
// 単一列しか無い旧来の表(内容のみ)は指導目標として扱う
const CONTENT_HEADERS = ['内容', 'content'];

function normViewpoint(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/知/.test(s)) return '知';
  if (/思/.test(s)) return '思';
  if (/態|主体/.test(s)) return '態';
  return '';
}

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
 * 表の列構成を自動判定する。マッピングUIの既定値に使う。
 * 戻り値: { hasHeader, header(表示用ラベル配列), columnCount, cols:{unit,hours,objective,activity,assessment,viewpoint}, warnings }
 * 各colは0始まりの列index、無ければ -1。
 */
export function detectColumns(rows) {
  if (!rows.length) throw new Error('データが空です');
  const columnCount = Math.max(...rows.map(r => r.length));
  const headerRow = rows[0].map(c => String(c));
  let unitCol = findCol(headerRow, UNIT_HEADERS);
  const hasHeader = unitCol !== -1;
  const warnings = [];
  let cols;
  if (hasHeader) {
    let objCol = findCol(headerRow, OBJECTIVE_HEADERS);
    const contentCol = findCol(headerRow, CONTENT_HEADERS);
    const actCol = findCol(headerRow, ACTIVITY_HEADERS);
    if (objCol === -1) objCol = contentCol !== -1 ? contentCol : actCol;
    cols = {
      unit: unitCol, hours: findCol(headerRow, HOURS_HEADERS),
      objective: objCol, activity: actCol,
      assessment: findCol(headerRow, ASSESS_HEADERS), viewpoint: findCol(headerRow, VIEWPOINT_HEADERS),
    };
  } else {
    // ヘッダー無し: 1列目=単元、2列目が数値なら時数、3列目=指導目標
    const second = rows.map(r => r[1]).filter(v => v != null && v !== '');
    const numeric = second.length > 0 && second.every(v => !isNaN(parseFloat(v)));
    cols = { unit: 0, hours: numeric ? 1 : -1, objective: numeric ? 2 : 1, activity: -1, assessment: -1, viewpoint: -1 };
    warnings.push('ヘッダー行がないため、列の対応を確認してください');
  }
  const header = hasHeader ? headerRow : Array.from({ length: columnCount }, (_, i) => `列${i + 1}`);
  return { hasHeader, header, columnCount, cols, warnings };
}

/** 明示した列対応で単元リストを組み立てる(マッピングUI・自動判定の共通エンジン) */
export function buildUnitsFromColumns(rows, hasHeader, cols) {
  const body = hasHeader ? rows.slice(1) : rows;
  const at = (r, c) => (c != null && c >= 0 ? (r[c] || '') : '');
  const lessonFrom = (r, objText) => ({
    objective: (objText != null ? objText : at(r, cols.objective)).trim(),
    activity: at(r, cols.activity).trim(),
    assessment: at(r, cols.assessment).trim(),
    viewpoint: normViewpoint(at(r, cols.viewpoint)),
  });
  const units = [];
  const formatA = cols.hours != null && cols.hours >= 0;
  if (formatA) {
    for (const r of body) {
      const name = at(r, cols.unit).trim();
      if (!name) continue;
      const hours = parseFloat(at(r, cols.hours)) || 1;
      const objs = splitContents(at(r, cols.objective));
      const lessons = objs.length ? objs.map((t, idx) => idx === 0 ? lessonFrom(r, t) : { objective: t, activity: '', assessment: '', viewpoint: '' })
        : [lessonFrom(r, '')];
      units.push({ name, hours, lessons });
    }
  } else {
    let cur = null;
    for (const r of body) {
      const name = at(r, cols.unit).trim();
      if (name && (!cur || cur.name !== name)) { cur = { name, hours: 0, lessons: [] }; units.push(cur); }
      if (!cur) continue;
      cur.hours += 1;
      cur.lessons.push(lessonFrom(r));
    }
  }
  if (!units.length) throw new Error('単元を読み取れませんでした。「単元名」の列対応を確認してください。');
  return { units, format: formatA ? 'A' : 'B' };
}

/**
 * テーブルを単元リストへ変換(自動判定)。
 * 戻り値: { units, format: 'A'|'B', warnings: [] }
 */
export function tableToUnits(rows) {
  const det = detectColumns(rows);
  const { units, format } = buildUnitsFromColumns(rows, det.hasHeader, det.cols);
  return { units, format, warnings: det.warnings };
}

function splitContents(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s.split(/\n|\||｜/).map(t => t.trim()).filter(Boolean);
}

/** 単元リスト→CSVテキスト(エクスポート用)。1行=1時間で指導目標・学習活動・評価規準・観点を出す */
export function unitsToCSV(units) {
  const escCsv = v => {
    v = String(v ?? '');
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const vpName = { 知: '知識・技能', 思: '思考・判断・表現', 態: '主体的に学習に取り組む態度' };
  const lines = ['単元名,時,指導目標,学習活動,評価規準,観点'];
  for (const u of units) {
    const lessons = (u.lessons || []);
    const n = Math.max(Number(u.hours) || 0, lessons.length);
    for (let i = 0; i < n; i++) {
      const l = lessons[i] || {};
      lines.push([
        escCsv(u.name), i + 1,
        escCsv(l.objective ?? l.text ?? ''),
        escCsv(l.activity ?? ''),
        escCsv(l.assessment ?? ''),
        escCsv(vpName[l.viewpoint] || ''),
      ].join(','));
    }
  }
  return lines.join('\n');
}
