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
 * テーブルを単元リストへ変換。
 * 戻り値: { units: [{name, hours, lessons:[{text}]}], format: 'A'|'B', warnings: [] }
 */
export function tableToUnits(rows) {
  if (!rows.length) throw new Error('データが空です');
  const warnings = [];
  let header = rows[0].map(c => String(c));
  let unitCol = findCol(header, UNIT_HEADERS);
  let hoursCol = findCol(header, HOURS_HEADERS);
  let objCol = findCol(header, OBJECTIVE_HEADERS);
  let actCol = findCol(header, ACTIVITY_HEADERS);
  let assessCol = findCol(header, ASSESS_HEADERS);
  let vpCol = findCol(header, VIEWPOINT_HEADERS);
  let contentCol = findCol(header, CONTENT_HEADERS);
  // 指導目標列が無ければ「内容/学習活動」を指導目標として使う(旧来の単一列の表)
  if (objCol === -1) objCol = contentCol !== -1 ? contentCol : actCol;
  let body = rows.slice(1);

  // ヘッダー行が無い場合: 列数から推定(1列目=単元、2列目=数値なら時数、3列目=指導目標)
  if (unitCol === -1) {
    header = null;
    body = rows;
    unitCol = 0;
    const second = rows.map(r => r[1]).filter(v => v != null && v !== '');
    const numeric = second.length > 0 && second.every(v => !isNaN(parseFloat(v)));
    hoursCol = numeric ? 1 : -1;
    objCol = numeric ? 2 : 1;
    actCol = assessCol = vpCol = -1;
    warnings.push('1列目を単元名として読み取りました');
  }

  const lessonFrom = (r, objText) => ({
    objective: (objText != null ? objText : (objCol !== -1 ? r[objCol] : '') || '').trim(),
    activity: (actCol !== -1 ? (r[actCol] || '') : '').trim(),
    assessment: (assessCol !== -1 ? (r[assessCol] || '') : '').trim(),
    viewpoint: vpCol !== -1 ? normViewpoint(r[vpCol]) : '',
  });

  const units = [];
  const formatA = hoursCol !== -1;
  if (formatA) {
    // 1行=1単元。指導目標列が「|」区切りで各時に展開される(学習活動等は単元先頭時に入る)
    for (const r of body) {
      const name = (r[unitCol] || '').trim();
      if (!name) continue;
      const hours = parseFloat(r[hoursCol]) || 1;
      const objs = splitContents(objCol !== -1 ? (r[objCol] || '') : '');
      const lessons = objs.length ? objs.map((t, idx) => idx === 0 ? lessonFrom(r, t) : { objective: t, activity: '', assessment: '', viewpoint: '' })
        : [lessonFrom(r, '')];
      units.push({ name, hours, lessons });
    }
  } else {
    // 1行=1時間。同名単元(または空欄=直前と同じ)をまとめる
    let cur = null;
    for (const r of body) {
      const name = (r[unitCol] || '').trim();
      if (name && (!cur || cur.name !== name)) {
        cur = { name, hours: 0, lessons: [] };
        units.push(cur);
      }
      if (!cur) continue;
      cur.hours += 1;
      cur.lessons.push(lessonFrom(r));
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
