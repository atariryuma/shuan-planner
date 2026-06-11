/**
 * データ層: localStorage永続化・スキーマ管理・既定値・進度計算・時数集計。
 *
 * データモデル概要:
 *   state = { schemaVersion, updatedAt, settings, plans[], weeks{} }
 *   settings.mode: 'homeroom'(学級担任) | 'senka'(専科) | 'fukushiki'(複式)
 *   週案セルは weeks[月曜日付].cells['d{曜日idx}p{校時id}'].entries[]
 *   entry.scope: 専科=学級id / 複式=学年番号 / 通常=null
 *   授業内容の自動反映は保存せず、表示時に年間指導計画と進度カウンタから毎回計算する。
 */

import { getSubjectPresets, getStandardHours } from './standards.js';
import { fmtDate, parseDate, mondayOf, addDays, uid, fiscalYearOf, fiscalYearFirstMonday, weekNumberInFiscalYear } from './utils.js';

const STORAGE_KEY = 'shuan-planner-data';
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- defaults

export function defaultPeriods(schoolType) {
  const base = schoolType === 'junior' ? 50 : 45;
  const p = [];
  p.push({ id: 'mod', label: '朝学習', type: 'module', minutes: 15, coefficient: round3(15 / base), start: '08:15', end: '08:30' });
  const times = schoolType === 'junior'
    ? [['08:50', '09:40'], ['09:50', '10:40'], ['10:50', '11:40'], ['11:50', '12:40'], ['13:30', '14:20'], ['14:30', '15:20']]
    : [['08:50', '09:35'], ['09:40', '10:25'], ['10:45', '11:30'], ['11:35', '12:20'], ['13:40', '14:25'], ['14:30', '15:15']];
  times.forEach(([s, e], i) => {
    p.push({ id: 'p' + (i + 1), label: String(i + 1), type: 'lesson', minutes: base, coefficient: 1, start: s, end: e });
  });
  return p;
}

export function defaultSubjects(schoolType) {
  return getSubjectPresets(schoolType).map(s => ({ ...s }));
}

export function defaultSettings(schoolType = 'elementary') {
  const now = new Date();
  const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    schoolName: '',
    teacherName: '',
    schoolType,
    mode: 'homeroom',
    grade: 1,
    className: '',
    fukushikiGrades: [5, 6],
    senkaClasses: [],
    fiscalYear: fy,
    saturday: false,
    periods: defaultPeriods(schoolType),
    // 日課表パターン(短縮・特別日課など)。各パターンは校時ごとの上書き(無効化/時刻/係数)を持つ
    periodPatterns: [],   // [{id, name, overrides: {[periodId]: {enabled,start,end,minutes,coefficient}}}]
    termSystem: 3,        // 3=3学期制 / 2=2学期制
    termEnds: ['07-31', '12-31'], // 学期の区切り(月-日)。3学期制=1学期末・2学期末 / 2学期制=前期末のみ使用
    showDayNotes: false,  // 日ごとのメモ欄(画面のみ・印刷されない)
    showHolidays: true,   // 祝日の表示
    subjects: defaultSubjects(schoolType),
    hoursBase: 35,            // 年間授業週数(時数の進捗目安に使用)
    senkaSubject: '',         // 専科: 担当教科(新規コマの既定教科)
    uiScale: 'normal',        // 画面の文字サイズ: normal | large
    breaks: [],               // 長期休業 [{name, from:'YYYY-MM-DD', to:'YYYY-MM-DD'}](必要ペース計算・表示に使用)
    showAttendance: false,    // 出欠メモ行(週案・印刷)
    stampBoxes: ['校長', '教頭', '担任'],
    printRole: '',            // 印刷ヘッダーの肩書(空=自動: ◯年◯組/専科/教科担任)
    printManagerBox: false,   // 印刷に管理職の指導・助言欄を出す
    printOrientation: 'landscape',
    printLayout: 'periods',   // periods=縦軸が校時(バーチカル型) | days=縦軸が曜日(Excel型)
    printShowTimes: false,
    printShowHours: true,
    printFontSize: 'normal',  // small | normal | large
    weekStartNote: '',
    gas: {
      url: '', token: '', auto: false, lastSync: null,
      calendarIds: [],      // 行事取り込み元のカレンダーID(空=メインカレンダー)
      calendarNames: {},    // 表示用 {id: name}
      mailTo: '',           // 週案のメール提出先
      senderName: '',       // メールの差出人表示名
      autoBackup: false,    // サーバー送信時にDriveへもバックアップ
    },
  };
}

export function blankWeek(startDateStr) {
  return {
    start: startDateStr,
    cells: {},
    events: ['', '', '', '', '', ''],
    dayNotes: ['', '', '', '', '', ''],
    attendance: ['', '', '', '', '', ''], // 出欠メモ(例: 欠1 遅1)
    dayPatterns: {},      // {dayIdx: patternId} 省略=通常日課
    goals: '',
    reflection: '',
  };
}

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(),
    settings: defaultSettings(),
    plans: [],
    weeks: {},
    baseTimetables: [],   // 基本時間割(名前付き・最大3件。週へワンタッチで流し込むひな形)
  };
}

function round3(x) { return Math.round(x * 1000) / 1000; }

// ---------------------------------------------------------------- store

class Store {
  constructor() {
    this.state = this.load();
    this.listeners = new Set();
    this._saveTimer = null;
    this._undo = null; // 直前の破壊的操作のスナップショット {json, label}
  }

  /** 破壊的操作の直前に呼ぶ。undo()で1回だけ巻き戻せる */
  snapshot(label) {
    this._undo = { json: JSON.stringify(this.state), label };
  }

  /** 直前のスナップショットへ巻き戻す。戻り値は操作ラベル(なければnull) */
  undo() {
    if (!this._undo) return null;
    const { json, label } = this._undo;
    this._undo = null;
    this.state = migrate(JSON.parse(json));
    this.persist();
    this.notify();
    return label;
  }

  get canUndo() { return !!this._undo; }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const data = JSON.parse(raw);
      return migrate(data);
    } catch (e) {
      console.error('データ読み込み失敗。バックアップを作成して初期化します。', e);
      try { localStorage.setItem(STORAGE_KEY + '-broken-' + Date.now(), localStorage.getItem(STORAGE_KEY) || ''); } catch {}
      return defaultState();
    }
  }

  /** 変更通知 + 遅延保存 */
  commit() {
    this.state.updatedAt = Date.now();
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.persist(), 400);
    this.listeners.forEach(fn => fn(this.state));
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.error('保存に失敗しました', e);
      alert('保存に失敗しました。容量不足の可能性があります。「データ」画面からエクスポートしてバックアップしてください。');
    }
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get settings() { return this.state.settings; }

  // -------- weeks
  weekKey(date) { return fmtDate(mondayOf(date)); }

  getWeek(startStr, create = false) {
    let w = this.state.weeks[startStr];
    if (!w && create) {
      w = blankWeek(startStr);
      this.state.weeks[startStr] = w;
    }
    return w || blankWeek(startStr);
  }

  cellKey(dayIdx, periodId) { return cellKey(dayIdx, periodId); }

  getCell(weekStart, dayIdx, periodId) {
    const w = this.state.weeks[weekStart];
    return w?.cells?.[this.cellKey(dayIdx, periodId)] || null;
  }

  setEntry(weekStart, dayIdx, periodId, entryIdx, patch) {
    const w = this.getWeek(weekStart, true);
    const key = this.cellKey(dayIdx, periodId);
    if (!w.cells[key]) w.cells[key] = { entries: [] };
    const entries = w.cells[key].entries;
    if (!entries[entryIdx]) entries[entryIdx] = newEntry();
    Object.assign(entries[entryIdx], patch);
    this.commit();
  }

  clearEntry(weekStart, dayIdx, periodId, entryIdx) {
    const w = this.state.weeks[weekStart];
    const key = this.cellKey(dayIdx, periodId);
    const cell = w?.cells?.[key];
    if (!cell) return;
    cell.entries.splice(entryIdx, 1);
    if (cell.entries.length === 0) delete w.cells[key];
    this.commit();
  }

  /**
   * 前週(または指定週)の時間割をコピー。内容テキストは自動反映に戻す。
   * コピー先に既にある行事・めあて・反省は保持する(置き換えるのはコマと日課パターン)。
   * 日課パターン(水曜=B日課など)は固定運用が多いため一緒に運ぶ。
   */
  copyWeek(fromStart, toStart, { keepText = false } = {}) {
    const src = this.state.weeks[fromStart];
    if (!src) return false;
    const dst = this.state.weeks[toStart] || blankWeek(toStart);
    dst.cells = cloneCells(src.cells, keepText);
    dst.dayPatterns = { ...(src.dayPatterns || {}) };
    this.state.weeks[toStart] = dst;
    this.commit();
    return true;
  }

  /**
   * この週の時間割を基本時間割として登録(内容・備考は持たない)。
   * 名前付きで最大3件まで(A週/B週・学期替えなどに対応)。
   * nameを省略すると先頭(基本)を上書きする。
   */
  saveAsBaseTimetable(weekStart, name = null) {
    const src = this.state.weeks[weekStart];
    if (!src || !Object.keys(src.cells).length) return false;
    const list = this.state.baseTimetables;
    const cells = cloneCells(src.cells, false);
    const dayPatterns = { ...(src.dayPatterns || {}) }; // 曜日の日課割当(水曜=B日課等)も一緒に登録
    if (name) {
      const existing = list.find(b => b.name === name);
      if (existing) { existing.cells = cells; existing.dayPatterns = dayPatterns; }
      else if (list.length < 3) list.push({ id: uid(), name, cells, dayPatterns });
      else return false;
    } else if (list.length) {
      list[0].cells = cells;
      list[0].dayPatterns = dayPatterns;
    } else {
      list.push({ id: uid(), name: '基本', cells, dayPatterns });
    }
    this.commit();
    return true;
  }

  /** 基本時間割をこの週へ流し込む(idを省略すると先頭)。日課パターンも反映する */
  applyBaseTimetable(weekStart, id = null) {
    const base = id ? this.state.baseTimetables.find(b => b.id === id) : this.state.baseTimetables[0];
    if (!base || !Object.keys(base.cells).length) return false;
    const w = this.getWeek(weekStart, true);
    w.cells = cloneCells(base.cells, false);
    w.dayPatterns = { ...(base.dayPatterns || {}) };
    this.commit();
    return true;
  }

  get hasBaseTimetable() {
    return (this.state.baseTimetables || []).length > 0;
  }

  // -------- plans
  getPlan(subjectKey, grade) {
    return this.state.plans.find(p => p.subjectKey === subjectKey && (p.grade ?? null) === (grade ?? null))
      || this.state.plans.find(p => p.subjectKey === subjectKey);
  }

  addPlan(plan) {
    plan.id = plan.id || uid();
    this.state.plans.push(plan);
    this.commit();
    return plan;
  }

  removePlan(id) {
    this.state.plans = this.state.plans.filter(p => p.id !== id);
    this.commit();
  }

  /** リスナー通知のみ(updatedAtを進めない) */
  notify() {
    this.listeners.forEach(fn => fn(this.state));
  }

  // -------- export / import
  /** バックアップ用JSON。GAS同期トークンは漏洩防止のため含めない */
  exportJSON() {
    const out = JSON.parse(JSON.stringify(this.state));
    if (out.settings?.gas) out.settings.gas.token = '';
    return JSON.stringify(out, null, 1);
  }

  importJSON(text) {
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null || !data.settings || !('weeks' in data)) {
      throw new Error('週案アプリのデータ形式ではありません');
    }
    this.replaceState(data);
  }

  /**
   * 外部由来(インポート/GAS/他タブ)のデータで置き換える。
   * updatedAtは外部データの値を尊重する(commitで進めない: 同期の競合判定を壊さないため)。
   * GAS設定はローカルの値を優先して引き継ぐ(トークンはエクスポートに含まれないため)。
   */
  replaceState(data, { keepLocalGas = true } = {}) {
    const localGas = this.state?.settings?.gas;
    this.state = migrate(data);
    if (keepLocalGas && localGas) {
      const g = this.state.settings.gas;
      if (!g.url) g.url = localGas.url;
      if (!g.token) g.token = localGas.token;
      // 端末ごとの動作設定は他端末のデータで上書きしない(自動同期が無言でOFFになる事故防止)
      g.auto = localGas.auto;
      g.autoBackup = localGas.autoBackup;
      g.lastSync = localGas.lastSync;
    }
    this.persist();
    this.notify();
  }
}

/**
 * 週セルのキー。注意: 校時IDは 'p1' のように p を含むため、
 * 生成されるキーは 'd0pp1' の形になる。必ずこの関数を使うこと(手書き禁止)。
 */
export function cellKey(dayIdx, periodId) {
  return `d${dayIdx}p${periodId}`;
}

/**
 * その日(週の日課パターン適用後)の実効校時を返す。
 * 戻り値: 校時オブジェクト(パターンの上書き反映済み) / その日は無効な校時なら null。
 */
export function effectivePeriod(settings, week, dayIdx, period) {
  const patId = week?.dayPatterns?.[dayIdx];
  if (!patId) return period;
  const pat = (settings.periodPatterns || []).find(p => p.id === patId);
  const ov = pat?.overrides?.[period.id];
  if (!ov) return period;
  if (ov.enabled === false) return null;
  return { ...period, ...ov, enabled: undefined };
}

export function newEntry() {
  return {
    id: uid(), subjectKey: '', scope: null, text: '', auto: true, note: '',
    noCount: false,    // 時数集計から除外
    advance: null,     // 進度カウント(null=校時種別の既定に従う)
    fraction: 1,       // 分数時数: このコマに占める割合(1, 2/3, 1/2, 1/3)
    cancelled: false,  // 中止・未実施(時数・進度とも除外、表示は取り消し線)
    cancelledText: '', // 中止時点の予定内容のスナップショット(提出書類に「何が中止か」を残す)
    guide: null,       // 複式: 'direct'(直接指導)|'indirect'(間接)|'guide'(ガイド学習)|null
  };
}

/** セル群を複製。keepText=falseなら手動内容・備考・中止フラグを初期化して自動反映に戻す */
function cloneCells(cells, keepText) {
  const out = {};
  for (const [k, cell] of Object.entries(cells)) {
    out[k] = {
      entries: cell.entries.map(e => ({
        ...e,
        id: uid(),
        text: keepText ? e.text : '',
        auto: keepText ? e.auto : true,
        note: keepText ? e.note : '',
        cancelled: false,
      })),
    };
  }
  return out;
}

function migrate(data) {
  if (!data.schemaVersion) data.schemaVersion = 1;
  // 将来のスキーマ変更はここに追記(schemaVersionで分岐)
  const def = defaultSettings(data.settings?.schoolType || 'elementary');
  data.settings = { ...def, ...data.settings, gas: { ...def.gas, ...(data.settings?.gas || {}) } };
  if (!Array.isArray(data.settings.periods) || !data.settings.periods.length) data.settings.periods = def.periods;
  if (!Array.isArray(data.settings.subjects) || !data.settings.subjects.length) data.settings.subjects = def.subjects;
  if (!Array.isArray(data.settings.fukushikiGrades) || data.settings.fukushikiGrades.length < 2) data.settings.fukushikiGrades = def.fukushikiGrades;
  if (!Array.isArray(data.settings.senkaClasses)) data.settings.senkaClasses = [];

  // 週・セル・エントリ・計画を深く正規化する。
  // 欠損フィールドのある外部JSON(手編集のバックアップ等)を取り込んでも描画が落ちないようにする。
  data.plans = (Array.isArray(data.plans) ? data.plans : []).filter(p => p && typeof p === 'object').map(p => ({
    ...p,
    id: p.id || uid(),
    units: (Array.isArray(p.units) ? p.units : []).filter(u => u && typeof u === 'object').map(u => ({
      ...u,
      name: String(u.name ?? ''),
      hours: Number(u.hours) || 1,
      lessons: (Array.isArray(u.lessons) ? u.lessons : []).map(l => ({ text: String(l?.text ?? '') })),
    })),
  }));
  data.weeks = (data.weeks && typeof data.weeks === 'object') ? data.weeks : {};
  for (const [key, w] of Object.entries(data.weeks)) {
    if (!w || typeof w !== 'object') { delete data.weeks[key]; continue; }
    w.start = w.start || key;
    w.cells = (w.cells && typeof w.cells === 'object') ? w.cells : {};
    for (const [ck, cell] of Object.entries(w.cells)) {
      if (!cell || !Array.isArray(cell.entries)) { delete w.cells[ck]; continue; }
      cell.entries = cell.entries.filter(e => e && typeof e === 'object').map(e => ({ ...newEntry(), ...e, id: e.id || uid() }));
      if (!cell.entries.length) delete w.cells[ck];
    }
    if (!Array.isArray(w.events)) w.events = ['', '', '', '', '', ''];
    if (!Array.isArray(w.dayNotes)) w.dayNotes = ['', '', '', '', '', ''];
    if (!Array.isArray(w.attendance)) w.attendance = ['', '', '', '', '', ''];
    if (!w.dayPatterns || typeof w.dayPatterns !== 'object') w.dayPatterns = {};
    w.goals = String(w.goals ?? '');
    w.reflection = String(w.reflection ?? '');
  }
  if (!Array.isArray(data.settings.periodPatterns)) data.settings.periodPatterns = [];
  if (!Array.isArray(data.settings.breaks)) data.settings.breaks = [];
  // 教科の合算先(parent)の正規化: 自己参照・連鎖をルート親へ解決(集計は1段しか辿らないため)
  for (const sub of data.settings.subjects) {
    if (sub.parent === sub.key) delete sub.parent;
    let p = sub.parent;
    let depth = 0;
    while (p && depth < 5) {
      const pa = data.settings.subjects.find(x => x.key === p);
      if (!pa) { delete sub.parent; p = null; break; } // 存在しない親は解除
      if (!pa.parent) break;
      p = pa.parent;
      depth++;
    }
    if (p && sub.parent && p !== sub.parent) sub.parent = p;
  }
  if (!Array.isArray(data.settings.termEnds) || !data.settings.termEnds.length) {
    data.settings.termEnds = data.settings.termSystem === 2 ? ['09-30'] : ['07-31', '12-31'];
  }
  // 旧形式(単一baseTimetable)→ 名前付き配列へ移行
  if (!Array.isArray(data.baseTimetables)) {
    const old = data.baseTimetable;
    data.baseTimetables = (old && typeof old.cells === 'object' && Object.keys(old.cells).length)
      ? [{ id: uid(), name: '基本', cells: old.cells }]
      : [];
    delete data.baseTimetable;
  }
  data.updatedAt = Number(data.updatedAt) || Date.now();
  return data;
}

// ---------------------------------------------------------------- 進度計算

/**
 * 進度スコープのキー。専科=学級id、複式=学年、通常=''。
 */
export function scopeKey(subjectKey, scope) {
  return `${subjectKey}|${scope ?? ''}`;
}

/**
 * 対象週が属する年度の [開始週, 翌年度開始週) の範囲を返す。
 * 年度判定は週の木曜日(3月末始まりの週を旧年度に含めないため)。
 */
function fiscalRangeOf(weekStart) {
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));
  return {
    from: fmtDate(fiscalYearFirstMonday(fy)),
    to: fmtDate(fiscalYearFirstMonday(fy + 1)),
  };
}

/**
 * 年度内の全週を時系列に走査し、各エントリの「その教科・スコープで何コマ目か」(0始まり)を返す。
 * 戻り値: Map<entryId, ordinal>
 * refWeekStart の属する年度のみ集計する(前年度のデータが残っていても進度・時数に混入させない)。
 * モジュール校時のエントリは既定で進度を進めない(entry.advance===trueで進める)。
 * 通常校時は entry.advance===false で進度から除外できる。
 * 曜日は土曜設定に関わらず常に7日分走査する(設定変更で過去の土曜データが消えないように)。
 */
export function computeOrdinals(state, refWeekStart) {
  const { settings, weeks } = state;
  const range = refWeekStart ? fiscalRangeOf(refWeekStart) : null;
  const counters = new Map();
  const ordinals = new Map();

  const weekKeys = Object.keys(weeks).sort();
  for (const wk of weekKeys) {
    if (range && (wk < range.from || wk >= range.to)) continue;
    const week = weeks[wk];
    for (let d = 0; d < 7; d++) {
      for (const p of settings.periods) {
        if (!effectivePeriod(settings, week, d, p)) continue; // その日は無効な校時
        const cell = week.cells[cellKey(d, p.id)];
        if (!cell) continue;
        for (const e of cell.entries) {
          if (!e.subjectKey || e.cancelled) continue;
          const isModule = p.type === 'module';
          const advances = e.advance === null || e.advance === undefined ? !isModule : !!e.advance;
          if (!advances) continue;
          const k = scopeKey(e.subjectKey, e.scope);
          const n = counters.get(k) || 0;
          ordinals.set(e.id, n);
          counters.set(k, n + 1);
        }
      }
    }
  }
  return ordinals;
}

/**
 * 年間指導計画から ordinal(0始まり) に対応する内容を取り出す。
 * 戻り値: { unitName, lessonText, nth, unitHours, exhausted } | null(計画なし)
 */
export function lessonFromPlan(plan, ordinal) {
  if (!plan || ordinal == null) return null;
  // startOffset = 年度途中導入時の既習コマ数。アプリ上の0コマ目は計画の (startOffset+1) 時間目。
  let rest = ordinal + (plan.startOffset || 0);
  if (rest < 0) return { unitName: '(既習)', lessonText: '', nth: 0, unitHours: 0, exhausted: false };
  for (const unit of plan.units) {
    const h = Math.max(1, Math.round(unit.hours || unit.lessons?.length || 1));
    if (rest < h) {
      const lesson = unit.lessons?.[rest];
      return {
        unitName: unit.name,
        lessonText: lesson?.text || '',
        nth: rest + 1,
        unitHours: h,
        exhausted: false,
      };
    }
    rest -= h;
  }
  return { unitName: '', lessonText: '', nth: 0, unitHours: 0, exhausted: true };
}

/**
 * エントリの表示テキストを解決する。
 * 手動入力(auto=false)はそのまま。自動は計画から「単元名 (n/m) 内容」を構成。
 */
export function resolveEntryText(state, entry, ordinals) {
  if (!entry.auto && entry.text) return { text: entry.text, auto: false, info: null };
  const grade = scopeGrade(state.settings, entry.scope);
  const plan = state.plans.find(p => p.subjectKey === entry.subjectKey && (p.grade == null || p.grade === grade))
    || null;
  const info = plan ? lessonFromPlan(plan, ordinals.get(entry.id)) : null;
  if (!info) return { text: entry.text || '', auto: true, info: null };
  if (info.exhausted) return { text: '(計画終了)', auto: true, info };
  const head = info.unitName ? `${info.unitName}` : '';
  const sub = info.lessonText ? ` ${info.lessonText}` : '';
  const counter = info.unitHours > 1 ? `(${info.nth}/${info.unitHours})` : '';
  return { text: `${head}${counter}${sub}`.trim(), auto: true, info };
}

/** scope(専科=classId / 複式=学年番号)から学年を解決 */
export function scopeGrade(settings, scope) {
  if (settings.mode === 'fukushiki') return typeof scope === 'number' ? scope : settings.fukushikiGrades[0];
  if (settings.mode === 'senka') {
    const cls = settings.senkaClasses.find(c => c.id === scope);
    return cls?.grade ?? settings.grade;
  }
  return settings.grade;
}

// ---------------------------------------------------------------- 時数集計

/**
 * 時数集計。係数(coefficient)は校時ごとに持つ(モジュール15分=1/3等)。
 * 戻り値: Map<scopeKey, {week: number, total: number}> と教科別集計。
 * total は年度内・指定週(を含む)までの累計。
 */
export function computeHours(state, currentWeekStart) {
  const { settings, weeks } = state;
  const range = fiscalRangeOf(currentWeekStart);
  const todayStr = fmtDate(new Date());
  const acc = new Map(); // scopeKey -> {week, total, done}

  const weekKeys = Object.keys(weeks).sort();
  for (const wk of weekKeys) {
    if (wk < range.from) continue; // 前年度以前は集計しない
    if (wk > currentWeekStart) break;
    const isCurrent = wk === currentWeekStart;
    const week = weeks[wk];
    const monday = parseDate(wk);
    for (let d = 0; d < 7; d++) {
      const dateStr = fmtDate(addDays(monday, d));
      for (const p of settings.periods) {
        const eff = effectivePeriod(settings, week, d, p);
        if (!eff) continue;
        const cell = week.cells[cellKey(d, p.id)];
        if (!cell) continue;
        for (const e of cell.entries) {
          if (!e.subjectKey || e.noCount || e.cancelled) continue;
          const k = scopeKey(e.subjectKey, e.scope);
          const cur = acc.get(k) || { week: 0, total: 0, done: 0 };
          const c = (eff.coefficient ?? 1) * (e.fraction ?? 1);
          cur.total += c;
          if (dateStr <= todayStr) cur.done += c; // 実施済み = 今日以前の日付のコマ(予定/実施の分離)
          if (isCurrent) cur.week += c;
          acc.set(k, cur);
        }
      }
    }
  }
  return acc;
}

/**
 * 残り授業週数。長期休業(settings.breaks)が設定されていれば、基準週の翌週から
 * 年度末までの「平日が休業で全て潰れていない週」を数える。未設定なら hoursBase - 経過週数。
 */
export function teachingWeeksLeft(settings, refWeekStart) {
  const refMonday = parseDate(refWeekStart);
  const weekNo = weekNumberInFiscalYear(refMonday);
  const fy = fiscalYearOf(addDays(refMonday, 3));
  const fyStart = `${fy}-04-01`;
  const fyEnd = `${fy + 1}-03-31`;
  // 対象年度と重なる休業だけを使う(前年度の休業設定を引きずらない)
  const breaks = (settings.breaks || []).filter(b => b.from && b.to && b.from <= fyEnd && b.to >= fyStart);
  if (!breaks.length) {
    return Math.max(0, (settings.hoursBase || 35) - weekNo);
  }
  const end = new Date(fy + 1, 2, 31);
  let count = 0;
  let monday = addDays(refMonday, 7);
  while (monday <= end) {
    const ws = fmtDate(monday);
    const we = fmtDate(addDays(monday, 4)); // 金曜まで
    const fullyInBreak = breaks.some(b => b.from <= ws && we <= b.to);
    if (!fullyInBreak) count++;
    monday = addDays(monday, 7);
  }
  return count;
}

/** その日付が長期休業中なら休業名を返す */
export function breakNameOf(settings, dateStr) {
  const b = (settings.breaks || []).find(b => b.from && b.to && b.from <= dateStr && dateStr <= b.to);
  return b ? b.name : null;
}

/**
 * 月別・学期別の時数集計(年度内、入力済みの全週)。
 * 月またぎの週も「コマの実際の日付」で按分するため正確。
 * 戻り値: { months: Map<月(1-12), Map<scopeKey, hours>>, terms: [{name, hours: Map<scopeKey, hours>}] }
 */
export function computeMonthlyHours(state, refWeekStart) {
  const { settings, weeks } = state;
  const range = fiscalRangeOf(refWeekStart);
  const months = new Map();
  const termRangesList = termRanges(settings, fiscalYearOf(addDays(parseDate(refWeekStart), 3)));
  const terms = termRangesList.map(t => ({ name: t.name, hours: new Map() }));

  const bump = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
  const fy = fiscalYearOf(addDays(parseDate(refWeekStart), 3));
  const fyStart = `${fy}-04-01`;
  const fyEnd = `${fy + 1}-03-31`;

  for (const wk of Object.keys(weeks).sort()) {
    if (wk < range.from || wk >= range.to) continue;
    if (wk > refWeekStart) break; // 表示中の週まで(computeHoursと同じ基準に統一)
    const week = weeks[wk];
    const monday = parseDate(wk);
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      const dateStr = fmtDate(date);
      // 年度の端の週に含まれる年度範囲外の日(3月末など)は月別・学期別に計上しない
      // (monthsとtermsの母集合を一致させるため)
      if (dateStr < fyStart || dateStr > fyEnd) continue;
      const month = date.getMonth() + 1;
      const termIdx = termRangesList.findIndex(t => dateStr >= t.from && dateStr <= t.to);
      for (const p of settings.periods) {
        const eff = effectivePeriod(settings, week, d, p);
        if (!eff) continue;
        const cell = week.cells[cellKey(d, p.id)];
        if (!cell) continue;
        for (const e of cell.entries) {
          if (!e.subjectKey || e.noCount || e.cancelled) continue;
          const k = scopeKey(e.subjectKey, e.scope);
          const c = (eff.coefficient ?? 1) * (e.fraction ?? 1);
          if (!months.has(month)) months.set(month, new Map());
          bump(months.get(month), k, c);
          if (termIdx >= 0) bump(terms[termIdx].hours, k, c);
        }
      }
    }
  }
  return { months, terms };
}

/** 学期の日付範囲リスト。termEnds(月-日)から年度内の実日付に展開する */
export function termRanges(settings, fiscalYear) {
  const md2date = (md) => {
    const [m, d] = md.split('-').map(Number);
    const y = m >= 4 ? fiscalYear : fiscalYear + 1;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const start = `${fiscalYear}-04-01`;
  const end = `${fiscalYear + 1}-03-31`;
  const ends = (settings.termEnds || []).map(md2date).filter(d => d > start && d < end).sort();
  const names = settings.termSystem === 2 ? ['前期', '後期'] : ['1学期', '2学期', '3学期'];
  const ranges = [];
  let from = start;
  for (let i = 0; i < ends.length && i < names.length - 1; i++) {
    ranges.push({ name: names[i], from, to: ends[i] });
    from = fmtDate(addDays(parseDate(ends[i]), 1));
  }
  ranges.push({ name: names[ranges.length] || `${ranges.length + 1}学期`, from, to: end });
  return ranges;
}

/**
 * 表示用の時数フォーマット。1/3系は "4⅓"、1/2系は "2½"、それ以外は小数で表示。
 * 値が本当にその単位に近いときだけ分数表記にする(0.5を⅔と誤表示しない)。
 */
export function fmtHours(x) {
  if (!isFinite(x)) return '0';
  const sign = x < 0 ? '-' : '';
  const a = Math.abs(x);
  // ほぼ整数
  if (Math.abs(a - Math.round(a)) < 0.02) return sign + String(Math.round(a));
  const whole = Math.floor(a + 1e-9);
  const frac = a - whole;
  // 1/3単位に十分近い場合のみ ⅓/⅔ 表記
  if (Math.abs(frac - 1 / 3) < 0.02) return sign + (whole || '') + '⅓';
  if (Math.abs(frac - 2 / 3) < 0.02) return sign + (whole || '') + '⅔';
  // 1/2単位
  if (Math.abs(frac - 0.5) < 0.02) return sign + (whole || '') + '½';
  return sign + (Math.round(a * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
}

/** 学年・教科の年間標準時数(設定の上書きを優先) */
export function standardHoursFor(settings, subjectKey, grade) {
  const ov = settings.standardOverrides?.[`${subjectKey}|${grade}`];
  if (ov != null) return ov;
  return getStandardHours(settings.schoolType, subjectKey, grade);
}

/** 週の開始日リスト(年度内、4月第1週〜翌3月) */
export function fiscalWeeks(fiscalYear) {
  const out = [];
  let d = mondayOf(new Date(fiscalYear, 3, 1));
  const end = new Date(fiscalYear + 1, 2, 31);
  while (d <= end) {
    out.push(fmtDate(d));
    d = addDays(d, 7);
  }
  return out;
}

export const store = new Store();
export { parseDate };
