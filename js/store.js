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

import { getSubjectPresets, getStandardHours, getStandardTotalHours, LEGACY_COLOR_FIXES } from './standards.js';
import { fmtDate, parseDate, mondayOf, addDays, uid, fiscalYearOf, fiscalYearFirstMonday, weekNumberInFiscalYear } from './utils.js';
import { holidayName } from './holidays.js';

const STORAGE_KEY = 'shuan-planner-data';
export const SCHEMA_VERSION = 2;

// ---------------------------------------------------------------- defaults

export function defaultPeriods(schoolType) {
  const base = schoolType === 'junior' ? 50 : 45;
  const p = [];
  // 係数は丸めずに保存する(0.333に丸めると105コマで34.965になり、累計が35時間に揃わない)
  p.push({ id: 'mod', label: '朝学習', type: 'module', minutes: 15, coefficient: 15 / base, start: '08:15', end: '08:30' });
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
    autoLayout: true,     // 基本時間割がある週を開くと、空なら自動で時間割＋計画を配置(毎週の「反映」操作を不要に)
    subjects: defaultSubjects(schoolType),
    hoursBase: 35,            // 年間授業週数(時数の進捗目安に使用)
    senkaSubject: '',         // 専科: 担当教科(新規コマの既定教科)
    uiScale: 'normal',        // 画面の文字サイズ: normal | large
    breaks: [],               // 長期休業 [{name, from:'YYYY-MM-DD', to:'YYYY-MM-DD'}](必要ペース計算・表示に使用)
    offDays: [],              // 任意の非授業日 ['YYYY-MM-DD'](開校記念日・振替・学級閉鎖など。授業を自動挿入しない)
    classDays: [],            // 任意の授業日(振替授業日) ['YYYY-MM-DD']。祝日・休業・週末でも授業日扱いにする(offDaysの対称)
    showAttendance: false,    // 出欠メモ行(週案・印刷)
    stampBoxes: ['校長', '教頭', '担任'],
    printTitle: '週案',        // 印刷ヘッダーの標目(学校の様式に合わせて変更可。例: 週ごとの指導計画)
    printRole: '',            // 印刷ヘッダーの肩書(空=自動: ◯年◯組/専科/教科担任)
    printManagerBox: false,   // 印刷に管理職の指導・助言欄を出す
    printEra: false,          // 印刷・出力の年表記を和暦(令和)にする
    printOrientation: 'portrait',
    printLayout: 'periods',   // periods=縦軸が校時(バーチカル型) | days=縦軸が曜日(Excel型)
    printShowTimes: false,
    printShowHours: true,
    printShowPlanDetails: true, // 週案本紙の後に、その週の指導計画詳細を添付
    printFontSize: 'normal',  // small | normal | large
    printPresetVersion: 2,    // v2=A4縦を標準とする週案様式
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
    managerNote: '',      // 管理職の指導・助言(押印欄と併せて印刷)
  };
}

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(),
    settingsUpdatedAt: Date.now(), // 設定だけの更新時刻。同期で設定が古いデータに巻き戻されるのを防ぐ
    settings: defaultSettings(),
    plans: [],
    weeks: {},
    baseTimetables: [],   // 基本時間割(名前付き・最大3件。週へワンタッチで流し込むひな形)
  };
}

// ---------------------------------------------------------------- store

// Undoスナップショットの有効期限。古い/遠いスナップショットへ巻き戻すと
// それ以降の編集を無警告で消してしまうため、時間と編集回数で失効させる。
const UNDO_TTL_MS = 5 * 60 * 1000; // 5分
const UNDO_MAX_COMMITS = 30;       // スナップショット後の編集(commit)回数

class Store {
  constructor() {
    this.state = this.load();
    this.listeners = new Set();
    this._saveTimer = null;
    this._undo = null; // 直前の破壊的操作のスナップショット {json, label, at, commits}
    this._lastSettingsFp = this._settingsFingerprint(); // 設定変更検知の基準(commitで比較)
  }

  /** 設定の指紋(変更検知用)。GASのlastSync等の揮発値は除外し、ユーザー設定の実体だけ見る */
  _settingsFingerprint() {
    const { gas, ...rest } = this.state?.settings || {};
    return JSON.stringify(rest);
  }

  /** 破壊的操作の直前に呼ぶ。undo()で巻き戻せる(再度のundoでやり直し) */
  snapshot(label) {
    this._undo = { json: JSON.stringify(this.state), label, at: Date.now(), commits: 0 };
  }

  /**
   * 直前のスナップショットへ巻き戻す。戻り値は操作ラベル(なければnull)。
   * 復元前の状態を退避するため、もう一度undo()すると元に戻せる(交互トグル)。
   */
  undo() {
    if (!this.canUndo) return null;
    const { json, label } = this._undo;
    this._undo = { json: JSON.stringify(this.state), label, at: Date.now(), commits: 0 };
    this.state = migrate(JSON.parse(json));
    this.persist();
    this.notify();
    return label;
  }

  get canUndo() {
    return !!this._undo
      && (Date.now() - this._undo.at) <= UNDO_TTL_MS
      && this._undo.commits <= UNDO_MAX_COMMITS;
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const data = JSON.parse(raw);
      return migrate(data);
    } catch (e) {
      console.error('データ読み込み失敗。バックアップを作成して初期化します。', e);
      try { localStorage.setItem(STORAGE_KEY + '-broken-' + Date.now(), localStorage.getItem(STORAGE_KEY) || ''); } catch {}
      this.loadError = true; // UI層が起動時に退避データの保存手段を提示する
      return defaultState();
    }
  }

  /** 破損時に退避したデータの一覧(新しい順) */
  brokenBackups() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_KEY + '-broken-')) keys.push(k);
    }
    return keys.sort().reverse();
  }

  /** 変更通知 + 遅延保存 */
  commit() {
    this.state.updatedAt = Date.now();
    // 設定が変わったときだけ settingsUpdatedAt を進める(同期で設定が古いデータに巻き戻らないように)
    const fp = this._settingsFingerprint();
    if (fp !== this._lastSettingsFp) {
      this.state.settingsUpdatedAt = this.state.updatedAt;
      this._lastSettingsFp = fp;
    }
    if (this._undo) this._undo.commits++; // 編集が重なったスナップショットは失効へ近づく
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.persist(), 400);
    this.listeners.forEach(fn => fn(this.state));
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.error('保存に失敗しました', e);
      // UI層(app.js)がアクション付きトーストで案内する(ネイティブalertは使わない)
      document.dispatchEvent(new CustomEvent('shuan-save-error'));
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
  copyWeek(fromStart, toStart, { keepText = false, preserveEdits = true } = {}) {
    const src = this.state.weeks[fromStart];
    if (!src) return { ok: false, preserved: 0 };
    const dst = this.state.weeks[toStart] || blankWeek(toStart);
    // 手を入れたコマ(●変更・全文手入力・備考・中止)は上書きせず残す
    const kept = {};
    if (preserveEdits && dst.cells) {
      for (const [k, cell] of Object.entries(dst.cells)) if (cellHasUserEdits(cell)) kept[k] = cell;
    }
    dst.cells = cloneCells(src.cells, keepText);
    let preserved = 0;
    for (const [k, cell] of Object.entries(kept)) { dst.cells[k] = cell; preserved++; }
    dst.dayPatterns = { ...(src.dayPatterns || {}) };
    this.state.weeks[toStart] = dst;
    this.commit();
    return { ok: true, preserved };
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
    const at = Date.now();
    if (name) {
      const existing = list.find(b => b.name === name);
      if (existing) { existing.cells = cells; existing.dayPatterns = dayPatterns; existing.savedAt = at; }
      else if (list.length < 3) list.push({ id: uid(), name, cells, dayPatterns, savedAt: at });
      else return false;
    } else if (list.length) {
      list[0].cells = cells;
      list[0].dayPatterns = dayPatterns;
      list[0].savedAt = at;
    } else {
      list.push({ id: uid(), name: '基本', cells, dayPatterns, savedAt: at });
    }
    this.commit();
    return true;
  }

  /** 基本時間割の名前を変更 */
  renameBaseTimetable(id, name) {
    const b = (this.state.baseTimetables || []).find(x => x.id === id);
    if (!b || !String(name || '').trim()) return false;
    b.name = String(name).trim();
    this.commit();
    return true;
  }

  /** 基本時間割を削除 */
  removeBaseTimetable(id) {
    const before = (this.state.baseTimetables || []).length;
    this.state.baseTimetables = (this.state.baseTimetables || []).filter(x => x.id !== id);
    if (this.state.baseTimetables.length !== before) this.commit();
  }

  /**
   * 基本時間割をこの週へ流し込む(idを省略すると先頭)。日課パターンも反映する。
   * 既定では祝日・長期休業・非授業日のコマは入れない(skipNoSchool)。
   * fillEmptyOnly=true なら、既に入力済みのコマは上書きしない(まとめて作成で既存を守る)。
   */
  applyBaseTimetable(weekStart, id = null, { skipNoSchool = true, fillEmptyOnly = false, commit = true, preserveEdits = true } = {}) {
    const base = id ? this.state.baseTimetables.find(b => b.id === id) : this.state.baseTimetables[0];
    if (!base || !Object.keys(base.cells).length) return { placed: 0, preserved: 0 };
    const monday = parseDate(weekStart);
    const w = this.getWeek(weekStart, true);
    // 一旦まっさらにする反映でも、手を入れたコマ(●変更・手入力・備考・中止)は守る
    const kept = {};
    if (preserveEdits && !fillEmptyOnly) {
      for (const [k, cell] of Object.entries(w.cells)) if (cellHasUserEdits(cell)) kept[k] = cell;
    }
    if (!fillEmptyOnly) { w.cells = {}; }      // 通常の反映は週を一旦まっさらにする(編集済みは後で戻す)
    w.dayPatterns = { ...(base.dayPatterns || {}) };
    const cloned = cloneCells(base.cells, false);
    let placed = 0;
    for (const [key, cell] of Object.entries(cloned)) {
      const m = /^d(\d+)p/.exec(key);
      const dayIdx = m ? Number(m[1]) : 0;
      if (skipNoSchool && isNoSchoolDay(this.settings, fmtDate(addDays(monday, dayIdx)))) continue;
      if (kept[key]) continue;                                       // 編集済みコマには置かない
      if (fillEmptyOnly && w.cells[key]?.entries?.length) continue; // 既存は守る
      w.cells[key] = cell;
      placed++;
    }
    let preserved = 0;
    for (const [k, cell] of Object.entries(kept)) { w.cells[k] = cell; preserved++; } // 編集済みを戻す
    if (commit) this.commit();
    return { placed, preserved };
  }

  /**
   * 期間内の各週へ基本時間割をまとめて流し込む(年間指導計画の進度は自動で連続する)。
   * 祝日・長期休業・非授業日は除外。既存の入力は上書きしない。
   * 戻り値: { weeks: 生成した週数, cells: 置いたコマ数 }
   */
  generateRange(fromWeekStart, toWeekStart, id = null) {
    const base = id ? this.state.baseTimetables.find(b => b.id === id) : this.state.baseTimetables[0];
    if (!base) return { weeks: 0, cells: 0 };
    let monday = mondayOf(parseDate(fromWeekStart));
    const end = mondayOf(parseDate(toWeekStart));
    let weeks = 0, cells = 0;
    let guard = 0;
    while (fmtDate(monday) <= fmtDate(end) && guard++ < 80) {
      const before = countCells(this.state.weeks[fmtDate(monday)]);
      this.applyBaseTimetable(fmtDate(monday), id, { skipNoSchool: true, fillEmptyOnly: true, commit: false });
      const after = countCells(this.state.weeks[fmtDate(monday)]);
      if (after > before) { weeks++; cells += after - before; }
      monday = addDays(monday, 7);
    }
    this.commit();
    return { weeks, cells };
  }

  get hasBaseTimetable() {
    return (this.state.baseTimetables || []).length > 0;
  }

  /** 任意の日を非授業日にする/解除する(授業を自動挿入しない日) */
  toggleOffDay(dateStr) {
    const s = this.settings;
    s.offDays = Array.isArray(s.offDays) ? s.offDays : [];
    s.classDays = Array.isArray(s.classDays) ? s.classDays : [];
    const i = s.offDays.indexOf(dateStr);
    if (i >= 0) s.offDays.splice(i, 1);
    else { s.offDays.push(dateStr); s.classDays = s.classDays.filter(d => d !== dateStr); } // 排他
    this.commit();
    return i < 0; // true=非授業日にした
  }

  /** 任意の日を授業日(振替授業日)にする/解除する。祝日・休業・週末でも授業日扱いにする(offDaysの対称) */
  toggleClassDay(dateStr) {
    const s = this.settings;
    s.classDays = Array.isArray(s.classDays) ? s.classDays : [];
    s.offDays = Array.isArray(s.offDays) ? s.offDays : [];
    const i = s.classDays.indexOf(dateStr);
    if (i >= 0) s.classDays.splice(i, 1);
    else { s.classDays.push(dateStr); s.offDays = s.offDays.filter(d => d !== dateStr); } // 排他
    this.commit();
    return i < 0; // true=振替授業日にした
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
   * mergeSettingsByTime=true: 自動同期/他タブ取込で、ローカルの設定の方が新しければ設定を巻き戻さない
   *   (設定が週案と同じ文書で後勝ち同期されるため、古い設定の端末の編集が設定を上書きする事故を防ぐ)。
   */
  replaceState(data, { keepLocalGas = true, mergeSettingsByTime = false } = {}) {
    const localGas = this.state?.settings?.gas;
    const localSettings = this.state?.settings;
    const localSettingsAt = this.state?.settingsUpdatedAt || 0;
    this.state = migrate(data);
    if (mergeSettingsByTime && localSettings && localSettingsAt > (this.state.settingsUpdatedAt || 0)) {
      // ローカルの設定の方が新しい → 同期データの古い設定で巻き戻さない(設定だけローカルを維持)
      this.state.settings = localSettings;
      this.state.settingsUpdatedAt = localSettingsAt;
    }
    if (keepLocalGas && localGas) {
      const g = this.state.settings.gas;
      if (!g.url) g.url = localGas.url;
      if (!g.token) g.token = localGas.token;
      // 端末ごとの動作設定は他端末のデータで上書きしない(自動同期が無言でOFFになる事故防止)
      g.auto = localGas.auto;
      g.autoBackup = localGas.autoBackup;
      g.lastSync = localGas.lastSync;
    }
    this._lastSettingsFp = this._settingsFingerprint(); // 取込後を基準に(直後のcommitで誤検知しない)
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
    endUnit: false,    // この時間で単元を終える(残りの計画コマを飛ばし、次のコマから次の単元へ)
    guide: null,       // 複式: 'direct'(直接指導)|'indirect'(間接)|'guide'(ガイド学習)|null
    pin: null,         // この時間だけ別の単元の本時をやる {unitId, nth}|null。自動の順番から外して差し込む(自転車操業対応)
    override: null,    // 年間計画の本時項目を「このコマだけ」上書きした差分。形 {objective?,activity?,assessment?,viewpoint?}
                       // 設定された項目のみ保持(計画全文は重複保存しない)。実施記録=計画との差分。
  };
}

/**
 * entry.override を正規化する。空文字・未知の観点は捨て、変更項目だけを残す。
 * 何も残らなければ null(=計画どおり)を返す。viewpoint の空文字は「計画に従う」扱い。
 */
export function normalizeOverride(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of ['objective', 'activity', 'assessment']) {
    const v = o[k];
    if (v != null && String(v).trim() !== '') out[k] = String(v);
  }
  const vp = String(o.viewpoint ?? '');
  if (['知', '思', '態'].includes(vp)) out.viewpoint = vp;
  return Object.keys(out).length ? out : null;
}

/**
 * 計画の本時項目(objective/activity/assessment/viewpoint)に override を項目単位で重ね、
 * 実効値・計画の元値・変更フラグをまとめて返す。week表示/編集/印刷で共通利用。
 */
export function mergeLessonOverride(planLesson, override) {
  const base = {
    objective: String(planLesson?.objective || ''),
    activity: String(planLesson?.activity || ''),
    assessment: String(planLesson?.assessment || ''),
    viewpoint: String(planLesson?.viewpoint || ''),
  };
  const o = normalizeOverride(override) || {};
  // ねらい(objective)を計画と変えたら、学習活動・評価規準は別の授業になるため計画から
  // 引き継がず自動で空にする(ずれた計画文をそのまま出さない)。各項目を明示的に上書きすればその値を優先。
  // 計画にねらいが無いコマ(自由記録)は対象外。
  const objCustom = ('objective' in o) && base.objective !== '' && o.objective !== base.objective;
  const blankActivity = objCustom && !('activity' in o) && base.activity !== '';
  const blankAssessment = objCustom && !('assessment' in o) && base.assessment !== '';
  // 評価規準を空にしたら、その観点(知/思/態)も計画から引き継がない(規準が無いのに観点だけ残さない)
  const blankViewpoint = objCustom && !('viewpoint' in o) && base.viewpoint !== '';
  const eff = {
    objective: o.objective ?? base.objective,
    activity: ('activity' in o) ? o.activity : (blankActivity ? '' : base.activity),
    assessment: ('assessment' in o) ? o.assessment : (blankAssessment ? '' : base.assessment),
    viewpoint: ('viewpoint' in o) ? o.viewpoint : (blankViewpoint ? '' : base.viewpoint),
  };
  return {
    objective: eff.objective,
    activity: eff.activity,
    assessment: eff.assessment,
    viewpoint: eff.viewpoint,
    viewpointLabel: VIEWPOINTS[eff.viewpoint] || '',
    planObjective: base.objective,
    planActivity: base.activity,
    planAssessment: base.assessment,
    planViewpoint: base.viewpoint,
    overridden: {
      objective: 'objective' in o,
      activity: 'activity' in o,
      assessment: 'assessment' in o,
      viewpoint: 'viewpoint' in o,
    },
    autoBlanked: { activity: blankActivity, assessment: blankAssessment },
  };
}

/**
 * 各時(lesson)を正規化する。旧形式 {text} は指導目標へ移行。
 * 新形式: { objective(指導目標/本時のねらい), activity(学習活動), assessment(評価規準), viewpoint(観点) }
 * viewpoint は観点別評価のタグ: ''|'知'(知識・技能)|'思'(思考・判断・表現)|'態'(主体的に学習に取り組む態度)
 */
export function normalizeLesson(l) {
  l = l && typeof l === 'object' ? l : {};
  const vp = String(l.viewpoint ?? '');
  return {
    objective: String(l.objective ?? l.text ?? ''),  // 旧 text を指導目標として引き継ぐ
    activity: String(l.activity ?? ''),
    assessment: String(l.assessment ?? ''),
    viewpoint: ['知', '思', '態'].includes(vp) ? vp : '',
  };
}

/** 観点コード→正式名称(印刷・表示用) */
export const VIEWPOINTS = { 知: '知識・技能', 思: '思考・判断・表現', 態: '主体的に学習に取り組む態度' };

/** このエントリにユーザーの手編集が入っているか(項目別上書き・全文手入力・備考・中止)。一括操作で守る判定に使う。 */
export function isEntryEdited(e) {
  if (!e) return false;
  if (normalizeOverride(e.override)) return true;               // ●変更(項目別の上書き)
  if (e.auto === false && e.text && e.text.trim()) return true; // 内容を全文手入力
  if (e.note && e.note.trim()) return true;                     // 備考
  if (e.cancelled) return true;                                 // 中止指定
  return false;
}

/** セル内のいずれかのエントリが手編集済みなら true(=破壊的な一括操作から守る) */
export function cellHasUserEdits(cell) {
  return !!cell && Array.isArray(cell.entries) && cell.entries.some(isEntryEdited);
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
  const sourceVersion = Number(data.schemaVersion) || 1;
  const oldPrint = data.settings ? {
    orientation: data.settings.printOrientation,
    layout: data.settings.printLayout,
    fontSize: data.settings.printFontSize,
    showTimes: data.settings.printShowTimes,
    showHours: data.settings.printShowHours,
    presetVersion: data.settings.printPresetVersion,
  } : {};
  if (!data.schemaVersion) data.schemaVersion = 1;
  // 将来のスキーマ変更はここに追記(schemaVersionで分岐)
  const def = defaultSettings(data.settings?.schoolType || 'elementary');
  data.settings = { ...def, ...data.settings, gas: { ...def.gas, ...(data.settings?.gas || {}) } };
  // v2: 一般的な週案簿に合わせ、旧既定のまま使われていた印刷設定だけをA4縦へ移行する。
  // 横向き等を明示的に変更していた利用者の設定は維持する。
  if (sourceVersion < 2 && oldPrint.presetVersion == null) {
    const wasLegacyDefault = (oldPrint.orientation == null || oldPrint.orientation === 'landscape')
      && (oldPrint.layout == null || oldPrint.layout === 'periods')
      && (oldPrint.fontSize == null || oldPrint.fontSize === 'normal')
      && (oldPrint.showTimes == null || oldPrint.showTimes === false)
      && (oldPrint.showHours == null || oldPrint.showHours === true);
    if (wasLegacyDefault) data.settings.printOrientation = 'portrait';
    data.settings.printPresetVersion = 2;
  }
  if (!Array.isArray(data.settings.periods) || !data.settings.periods.length) data.settings.periods = def.periods;
  if (!Array.isArray(data.settings.subjects) || !data.settings.subjects.length) data.settings.subjects = def.subjects;
  if (!Array.isArray(data.settings.fukushikiGrades) || data.settings.fukushikiGrades.length < 2) data.settings.fukushikiGrades = def.fukushikiGrades;
  // 中学校なのに複式の学年が4〜6年のまま残っていると、設定画面の表示(1年)と
  // 実データ(5年等)が食い違う。学年範囲(1〜3)へ補正する
  if (data.settings.schoolType === 'junior') {
    const fg = data.settings.fukushikiGrades.map(g => Math.min(Math.max(Number(g) || 1, 1), 3));
    if (fg[0] >= fg[1]) {
      if (fg[1] > 1) fg[0] = fg[1] - 1;
      else { fg[0] = 1; fg[1] = 2; }
    }
    data.settings.fukushikiGrades = fg;
  }
  if (!Array.isArray(data.settings.senkaClasses)) data.settings.senkaClasses = [];
  // 専科の担当教科: 削除済みの教科キーが残ると新規コマに死んだキーが充填され、
  // 時数がどの集計にも入らず無言で消えるため実在チェックで解除する(学級IDのvalidScopeと同型)
  if (data.settings.senkaSubject && !data.settings.subjects.some(x => x.key === data.settings.senkaSubject)) {
    data.settings.senkaSubject = '';
  }

  // モジュール係数の丸め誤差を救済(0.333→1/3等)。丸めた係数のまま累積すると
  // 105コマで34.965になり、表示・CSVが標準の整数時数(35)と一致しなくなる。
  // ユーザーが意図的に別値へ上書きしている場合(誤差0.002超)は触らない。
  {
    const base = data.settings.schoolType === 'junior' ? 50 : 45;
    for (const p of data.settings.periods) {
      if (p.type !== 'module' || !(p.minutes > 0)) continue;
      const exact = p.minutes / base;
      if (p.coefficient !== exact && Math.abs(p.coefficient - exact) < 0.002) p.coefficient = exact;
    }
  }

  // 週・セル・エントリ・計画を深く正規化する。
  // 欠損フィールドのある外部JSON(手編集のバックアップ等)を取り込んでも描画が落ちないようにする。
  data.plans = (Array.isArray(data.plans) ? data.plans : []).filter(p => p && typeof p === 'object').map(p => ({
    ...p,
    id: p.id || uid(),
    units: (Array.isArray(p.units) ? p.units : []).filter(u => u && typeof u === 'object').map(u => ({
      ...u,
      name: String(u.name ?? ''),
      hours: Number(u.hours) || 1,
      goal: String(u.goal ?? ''),                 // 単元の目標
      // 単元の評価規準(3観点: 知識・技能 / 思考・判断・表現 / 主体的に学習に取り組む態度)
      criteria: {
        knowledge: String(u.criteria?.knowledge ?? ''),
        thinking: String(u.criteria?.thinking ?? ''),
        attitude: String(u.criteria?.attitude ?? ''),
      },
      lessons: (Array.isArray(u.lessons) ? u.lessons : []).map(l => normalizeLesson(l)),
    })),
  }));
  data.weeks = (data.weeks && typeof data.weeks === 'object') ? data.weeks : {};
  for (const [key, w] of Object.entries(data.weeks)) {
    if (!w || typeof w !== 'object') { delete data.weeks[key]; continue; }
    w.start = w.start || key;
    w.cells = (w.cells && typeof w.cells === 'object') ? w.cells : {};
    for (const [ck, cell] of Object.entries(w.cells)) {
      if (!cell || !Array.isArray(cell.entries)) { delete w.cells[ck]; continue; }
      cell.entries = cell.entries.filter(e => e && typeof e === 'object').map(e => {
        const ne = { ...newEntry(), ...e, id: e.id || uid() };
        ne.override = normalizeOverride(ne.override); // 既存データは override 無し(=null)
        return ne;
      });
      if (!cell.entries.length) delete w.cells[ck];
    }
    if (!Array.isArray(w.events)) w.events = ['', '', '', '', '', ''];
    if (!Array.isArray(w.dayNotes)) w.dayNotes = ['', '', '', '', '', ''];
    if (!Array.isArray(w.attendance)) w.attendance = ['', '', '', '', '', ''];
    if (!w.dayPatterns || typeof w.dayPatterns !== 'object') w.dayPatterns = {};
    w.goals = String(w.goals ?? '');
    w.reflection = String(w.reflection ?? '');
    w.managerNote = String(w.managerNote ?? '');
  }
  if (!Array.isArray(data.settings.periodPatterns)) data.settings.periodPatterns = [];
  if (!Array.isArray(data.settings.breaks)) data.settings.breaks = [];
  if (!Array.isArray(data.settings.offDays)) data.settings.offDays = [];
  if (!Array.isArray(data.settings.classDays)) data.settings.classDays = [];
  // offDaysとclassDaysは排他(両方に入っているとどちらの意図か曖昧)。classDays(明示の授業日)を優先
  if (data.settings.classDays.length && data.settings.offDays.length) {
    const cd = new Set(data.settings.classDays);
    data.settings.offDays = data.settings.offDays.filter(d => !cd.has(d));
  }
  // 「道徳」→正式名称「特別の教科 道徳」へ(提出書類に略式名が出ないように。独自に改名済みなら触らない)
  for (const sub of data.settings.subjects) {
    if (sub.key === 'dotoku' && sub.name === '道徳') sub.name = '特別の教科 道徳';
  }
  // 旧既定色 → 白文字で4.5:1を満たす新既定色へ(WCAG 1.4.3)。独自に変えた色は触らない
  for (const sub of data.settings.subjects) {
    const fixed = LEGACY_COLOR_FIXES[String(sub.color || '').toLowerCase()];
    if (fixed) sub.color = fixed;
  }
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
  data.schemaVersion = SCHEMA_VERSION;
  data.updatedAt = Number(data.updatedAt) || Date.now();
  // 設定だけの更新時刻。旧データは0(=設定を編集した時点で進む)。同期の設定マージ判定に使う
  data.settingsUpdatedAt = Number(data.settingsUpdatedAt) || 0;
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
          if (e.pin) continue; // この時間だけ別単元(差し込み)は自動カウンタを動かさない=他コマの順番は不変
          const isModule = p.type === 'module';
          const advances = e.advance === null || e.advance === undefined ? !isModule : !!e.advance;
          if (!advances) continue;
          const k = scopeKey(e.subjectKey, e.scope);
          const n = counters.get(k) || 0;
          ordinals.set(e.id, n);
          let next = n + 1;
          // 「この時間で単元を終える」: 現在の単元の残りコマ分だけカウンタを飛ばし、次のコマから次の単元へ
          if (e.endUnit) {
            const grade = scopeGrade(settings, e.scope);
            const plan = state.plans.find(pl => pl.subjectKey === e.subjectKey && (pl.grade == null || pl.grade === grade));
            const info = plan ? lessonFromPlan(plan, n) : null;
            if (info && !info.exhausted && info.unitHours > 0) {
              const remaining = info.unitHours - info.nth; // info.nth は1始まり。残り=単元時数-現在の時
              if (remaining > 0) next += remaining;
            }
          }
          counters.set(k, next);
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
      // lessonText は週グリッド・印刷の1行表示に使う指導目標(旧textも吸収)
      const objective = lesson ? (lesson.objective ?? lesson.text ?? '') : '';
      return {
        unitName: unit.name,
        lessonText: objective,
        lesson: lesson || null, // 指導目標・学習活動・評価規準の全項目(編集・詳細表示用)
        unit,                   // 単元の目標・評価規準も参照できるように
        nth: rest + 1,
        unitHours: h,
        exhausted: false,
      };
    }
    rest -= h;
  }
  return { unitName: '', lessonText: '', lesson: null, unit: null, nth: 0, unitHours: 0, exhausted: true };
}

/**
 * entry.pin({unitId, nth}) で指定された単元の本時を直接取り出す(自動の順番を無視)。
 * lessonFromPlan と同じ形を返す。単元が削除済みなら null(自動/手記録へフォールバック)。
 */
export function lessonFromPin(plan, pin) {
  if (!plan || !pin || !pin.unitId) return null;
  const unit = (plan.units || []).find(u => String(u.id) === String(pin.unitId));
  if (!unit) return null;
  const h = Math.max(1, Math.round(unit.hours || unit.lessons?.length || 1));
  const nth = Math.min(Math.max(1, Math.round(pin.nth || 1)), h); // 1..h にクランプ
  const lesson = unit.lessons?.[nth - 1] || null;
  const objective = lesson ? (lesson.objective ?? lesson.text ?? '') : '';
  return { unitName: unit.name, lessonText: objective, lesson, unit, nth, unitHours: h, exhausted: false };
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
  // pin があれば自動の順番を無視して指定単元の本時を出す(この時間だけ別の単元)
  const info = plan ? (entry.pin ? lessonFromPin(plan, entry.pin) : lessonFromPlan(plan, ordinals.get(entry.id))) : null;
  if (!info) return { text: entry.text || '', auto: true, info: null };
  if (info.exhausted) return { text: '(計画終了)', auto: true, info };
  const head = info.unitName ? `${info.unitName}` : '';
  // 本時のねらいを override で差し替えていれば1行表示にも反映する(計画の元値はそのまま)
  const effObjective = normalizeOverride(entry.override)?.objective ?? info.lessonText;
  const sub = effObjective ? ` ${effObjective}` : '';
  const counter = info.unitHours > 1 ? `(${info.nth}/${info.unitHours})` : '';
  return { text: `${head}${counter}${sub}`.trim(), auto: true, info };
}

/** 年間指導計画から、週案UI・印刷で共有する全項目を取り出す。 */
export function resolveEntryPlanDetails(state, entry, ordinals) {
  const resolved = resolveEntryText(state, entry, ordinals);
  let info = resolved.info;
  let plan = null;
  if (!info && entry.subjectKey) {
    const grade = scopeGrade(state.settings, entry.scope);
    plan = state.plans.find(p => p.subjectKey === entry.subjectKey && (p.grade == null || p.grade === grade))
      || null;
    info = plan ? (entry.pin ? lessonFromPin(plan, entry.pin) : lessonFromPlan(plan, ordinals.get(entry.id))) : null;
  } else if (info) {
    const grade = scopeGrade(state.settings, entry.scope);
    plan = state.plans.find(p => p.subjectKey === entry.subjectKey && (p.grade == null || p.grade === grade))
      || null;
  }
  if (!info || info.exhausted || !info.unit) {
    // 計画が無い/終了したコマでも、override 単独で活動・評価を記録できるようにする。
    const ov = normalizeOverride(entry.override);
    if (!ov) return { resolved, details: null };
    const merged = mergeLessonOverride(null, ov);
    return {
      resolved,
      details: {
        unitName: '', unitId: '', nth: 0, unitHours: 0,
        planId: '', textbook: '',
        grade: scopeGrade(state.settings, entry.scope) || null,
        manualText: resolved.auto ? '' : resolved.text,
        unitGoal: '', unitCriteria: { knowledge: '', thinking: '', attitude: '' },
        planless: true, // 年間計画に紐づかない手記録(編集UIで見出しを変える)
        ...merged,
      },
    };
  }
  const lesson = normalizeLesson(info.lesson);
  const criteria = info.unit.criteria || {};
  const merged = mergeLessonOverride(lesson, entry.override); // override を項目単位で重ねた実効値
  return {
    resolved,
    details: {
      unitName: String(info.unitName || ''),
      unitId: String(info.unit.id || info.unitName || ''),
      nth: info.nth,
      unitHours: info.unitHours,
      planId: String(plan?.id || ''),
      textbook: String(plan?.textbook || ''),
      grade: Number(plan?.grade || scopeGrade(state.settings, entry.scope)) || null,
      manualText: resolved.auto ? '' : resolved.text,
      unitGoal: String(info.unit.goal || ''),
      unitCriteria: {
        knowledge: String(criteria.knowledge || ''),
        thinking: String(criteria.thinking || ''),
        attitude: String(criteria.attitude || ''),
      },
      planless: false,
      ...merged, // objective/activity/assessment/viewpoint(実効値)+ plan元値 + overridden フラグ
    },
  };
}

/**
 * 観点別(知/思/態)の評価場面数を集計する。年度内の全コマを走査し、進度を進める
 * (=評価機会のある)非中止コマについて、実効観点(override優先、なければ計画)を数える。
 * 戻り値: Map<scopeKey, {知, 思, 態, total}>。
 * 評定期に「思考の評価場面が足りない」等を、観点別評価の入力済みデータから事前に把握するため。
 */
export function computeViewpointTally(state, refWeekStart) {
  const { settings, weeks } = state;
  const range = refWeekStart ? fiscalRangeOf(refWeekStart) : null;
  const ordinals = computeOrdinals(state, refWeekStart);
  const tally = new Map();
  const weekKeys = Object.keys(weeks).sort();
  for (const wk of weekKeys) {
    if (range && (wk < range.from || wk >= range.to)) continue;
    const week = weeks[wk];
    for (let d = 0; d < 7; d++) {
      for (const p of settings.periods) {
        if (!effectivePeriod(settings, week, d, p)) continue;
        const cell = week.cells[cellKey(d, p.id)];
        if (!cell) continue;
        for (const e of cell.entries) {
          if (!e.subjectKey || e.cancelled) continue;
          const vp = resolveEntryPlanDetails(state, e, ordinals).details?.viewpoint;
          if (vp !== '知' && vp !== '思' && vp !== '態') continue;
          const k = scopeKey(e.subjectKey, e.scope);
          let t = tally.get(k);
          if (!t) { t = { 知: 0, 思: 0, 態: 0, total: 0 }; tally.set(k, t); }
          t[vp]++; t.total++;
        }
      }
    }
  }
  return tally;
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
 * 「実施済」を数えるための基準週。computeHoursは基準週までしか走査しないため、
 * 過去の週を表示していても実施時数(今日以前のコマ)が欠けないよう、今日を含む週を返す。
 * 表示中の年度と今日の年度が違う場合は、その年度内に収まる週に丸める。
 */
export function doneRefWeek(weekStart) {
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));
  const todayMon = mondayOf(new Date());
  const tfy = fiscalYearOf(addDays(todayMon, 3));
  if (tfy < fy) return weekStart;                                  // 未来年度の閲覧 → 実施は0で正しい
  // 過年度の閲覧 → 年度内に属する最終週まで実施扱い。
  // 3/31を含む週の月曜を返すと、その週の木曜が4月の年(3/31が月〜水曜)は
  // 木曜判定で翌年度に分類され、fiscalRangeOfが翌年度の範囲を返して実施が全て0になる。
  if (tfy > fy) return fmtDate(addDays(fiscalYearFirstMonday(fy + 1), -7));
  const t = fmtDate(todayMon);
  return t > weekStart ? t : weekStart;
}

/**
 * 時数集計。係数(coefficient)は校時ごとに持つ(モジュール15分=1/3等)。
 * 戻り値: Map<scopeKey, {week: number, total: number}> と教科別集計。
 * total は年度内・指定週(を含む)までの累計。
 */
export function computeHours(state, currentWeekStart) {
  const { settings, weeks } = state;
  const range = fiscalRangeOf(currentWeekStart);
  const todayStr = fmtDate(new Date());
  // 年度の実日付範囲(端の週に含まれる前後年度の日を除外し、月別集計と母集合を一致させる)
  const fy = fiscalYearOf(addDays(parseDate(currentWeekStart), 3));
  const fyStart = `${fy}-04-01`;
  const fyEnd = `${fy + 1}-03-31`;
  const acc = new Map(); // scopeKey -> {week, total, done}

  // 年度境界の週(4/1が木曜の年は3月末日が年度第1週に、金曜の年は4/1-2が前年度最終週に入る)の
  // コマを取りこぼさないよう、走査範囲は範囲外の隣接週まで広げ、所属年度は実日付だけで判定する。
  const scanFrom = fmtDate(addDays(parseDate(range.from), -7));
  const lastWeek = fmtDate(addDays(parseDate(range.to), -7));
  const scanTo = currentWeekStart >= lastWeek ? range.to : currentWeekStart; // 年度最終週は境界週の3月末日も累計に含める

  const weekKeys = Object.keys(weeks).sort();
  for (const wk of weekKeys) {
    if (wk < scanFrom) continue; // 前年度以前は集計しない
    if (wk > scanTo) break;
    const isCurrent = wk === currentWeekStart;
    const week = weeks[wk];
    const monday = parseDate(wk);
    for (let d = 0; d < 7; d++) {
      const dateStr = fmtDate(addDays(monday, d));
      if (dateStr < fyStart || dateStr > fyEnd) continue;
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
    // 休業未設定: 残り暦週数を年間授業週数(hoursBase)へ比例配分する近似。
    // 「hoursBase − 経過暦週数」だと夏休み以降に残り週数を過小評価し、
    // 経過暦週数がhoursBaseを超える12月頃には0へ張り付いてしまうため。
    const totalWeeks = Math.max(1, Math.round(
      (fiscalYearFirstMonday(fy + 1) - fiscalYearFirstMonday(fy)) / (7 * 24 * 3600 * 1000)));
    const calendarLeft = Math.max(0, totalWeeks - weekNo);
    return Math.round((settings.hoursBase || 35) * calendarLeft / totalWeeks);
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

/**
 * 経過授業週数(年度初週〜基準週、基準週を含む)。「見込み」の分母に使う。
 * 長期休業が設定されていれば「平日が全て休業の週」を除いて数える。
 * 未設定なら経過暦週数を年間授業週数で打ち切る近似(暦週数をそのまま使うと
 * 夏休み以降の見込みが実績を下回る矛盾が出るため)。
 */
export function teachingWeeksElapsed(settings, refWeekStart) {
  const refMonday = parseDate(refWeekStart);
  const fy = fiscalYearOf(addDays(refMonday, 3));
  const fyStart = `${fy}-04-01`;
  const fyEnd = `${fy + 1}-03-31`;
  const breaks = (settings.breaks || []).filter(b => b.from && b.to && b.from <= fyEnd && b.to >= fyStart);
  if (!breaks.length) {
    const weekNo = weekNumberInFiscalYear(refMonday);
    return Math.max(1, Math.min(weekNo, settings.hoursBase || 35));
  }
  let count = 0;
  let monday = fiscalYearFirstMonday(fy);
  while (monday <= refMonday) {
    const ws = fmtDate(monday);
    const we = fmtDate(addDays(monday, 4)); // 金曜まで
    const fullyInBreak = breaks.some(b => b.from <= ws && we <= b.to);
    if (!fullyInBreak) count++;
    monday = addDays(monday, 7);
  }
  return Math.max(1, count);
}

/** その日付が長期休業中なら休業名を返す */
export function breakNameOf(settings, dateStr) {
  const b = (settings.breaks || []).find(b => b.from && b.to && b.from <= dateStr && dateStr <= b.to);
  return b ? b.name : null;
}

/**
 * その日が「授業を入れない日」か。基本時間割の流し込み・まとめて作成で除外する。
 * 対象: 日曜(土は設定次第) / 祝日(祝日表示ONのとき) / 長期休業 / 任意の非授業日。
 */
export function isNoSchoolDay(settings, dateStr) {
  return !!noSchoolReason(settings, dateStr);
}

/**
 * その週に表示する曜日のオフセット配列(0=月..6=日)。
 * 月〜金は常に表示。土は「土曜あり」設定 or 振替授業日 or その日に授業・行事がある週。
 * 日は振替授業日 or その日に授業・行事がある週だけ。普段の週は土日を出さない。
 * 週グリッド・印刷・カレンダー出力で共通利用し、土日の授業(日曜参観・運動会等)を一貫して扱う。
 */
export function weekDayOffsets(settings, week, monday) {
  const days = [0, 1, 2, 3, 4];
  const used = (d) => {
    const ds = fmtDate(addDays(monday, d));
    if ((settings.classDays || []).includes(ds)) return true; // 振替授業日
    if (!week) return false;
    if (week.events && String(week.events[d] || '').trim()) return true;       // 行事(運動会等)
    if (week.attendance && String(week.attendance[d] || '').trim()) return true;
    for (const p of settings.periods) {
      const c = week.cells && week.cells[cellKey(d, p.id)];
      if (c && c.entries && c.entries.length) return true;                      // 授業コマ
    }
    return false;
  };
  if (settings.saturday || used(5)) days.push(5);
  if (used(6)) days.push(6);
  return days;
}

/** 非授業日の理由ラベル(なければ null)。表示にも使う */
export function noSchoolReason(settings, dateStr) {
  // 振替授業日(明示の授業日)は祝日・休業・週末より優先して「授業日」とする
  if ((settings.classDays || []).includes(dateStr)) return null;
  const d = parseDate(dateStr);
  const dow = d.getDay(); // 0=日, 6=土
  if (dow === 0) return '日曜';
  if (dow === 6 && !settings.saturday) return '土曜';
  if ((settings.offDays || []).includes(dateStr)) return '休業日';
  const brk = breakNameOf(settings, dateStr);
  if (brk) return brk;
  if (settings.showHolidays) { const h = holidayName(d); if (h) return h; }
  return null;
}

/** 週のコマ数(エントリのある data セル数)。まとめて作成の差分に使う */
function countCells(week) {
  if (!week || !week.cells) return 0;
  let n = 0;
  for (const c of Object.values(week.cells)) n += (c.entries?.length ? 1 : 0);
  return n;
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
  const monthsDone = new Map(); // 実施(今日以前の日付)のみ — 月別実施時数の報告用
  const termRangesList = termRanges(settings, fiscalYearOf(addDays(parseDate(refWeekStart), 3)));
  const terms = termRangesList.map(t => ({ name: t.name, hours: new Map() }));
  const termsDone = termRangesList.map(t => ({ name: t.name, hours: new Map() }));

  const bump = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
  const fy = fiscalYearOf(addDays(parseDate(refWeekStart), 3));
  const fyStart = `${fy}-04-01`;
  const fyEnd = `${fy + 1}-03-31`;
  const todayStr = fmtDate(new Date());

  // computeHoursと同じく境界週(年度範囲外の隣接週に入る年度内の日)を取りこぼさない走査範囲
  const scanFrom = fmtDate(addDays(parseDate(range.from), -7));
  const lastWeek = fmtDate(addDays(parseDate(range.to), -7));
  const scanTo = refWeekStart >= lastWeek ? range.to : refWeekStart;

  for (const wk of Object.keys(weeks).sort()) {
    if (wk < scanFrom) continue;
    if (wk > scanTo) break; // 表示中の週まで(computeHoursと同じ基準に統一)
    const week = weeks[wk];
    const monday = parseDate(wk);
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      const dateStr = fmtDate(date);
      // 年度の端の週に含まれる年度範囲外の日(3月末など)は月別・学期別に計上しない
      // (monthsとtermsの母集合を一致させるため)
      if (dateStr < fyStart || dateStr > fyEnd) continue;
      const month = date.getMonth() + 1;
      const isDone = dateStr <= todayStr;
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
          if (isDone) {
            if (!monthsDone.has(month)) monthsDone.set(month, new Map());
            bump(monthsDone.get(month), k, c);
            if (termIdx >= 0) bump(termsDone[termIdx].hours, k, c);
          }
        }
      }
    }
  }
  return { months, monthsDone, terms, termsDone };
}

/** 学期の日付範囲リスト。termEnds(月-日)から年度内の実日付に展開する */
export function termRanges(settings, fiscalYear) {
  const md2date = (md) => {
    const [m, d] = md.split('-').map(Number);
    const y = m >= 4 ? fiscalYear : fiscalYear + 1;
    // 実在しない日付(6/31、非うるう年の2/29等)は月末日へ丸める。
    // Dateの繰り上がり(6/31→7/1)に任せると次学期開始が7/2になり、
    // 7/1がどの学期にも属さず時数が学期計・年度計から漏れる
    const dd = Math.min(d, new Date(y, m, 0).getDate());
    return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
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

/** 学年の年間「総授業時数」(施行規則 別表の総枠。各教科標準の単純和ではない)。 */
export function standardTotalHoursFor(settings, grade) {
  return getStandardTotalHours(settings.schoolType, grade);
}

export const store = new Store();
export { parseDate };
