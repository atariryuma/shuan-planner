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

// 自動バックアップ(復元ポイント): 端末内に直近の状態を数世代だけ残す安全網。
const BK_PREFIX = STORAGE_KEY + '-bk-';
const BK_MAX = 8;                     // 残す世代数(古いものから消す)
const BK_MIN_INTERVAL_MS = 5 * 60 * 1000; // この間隔より短い連続バックアップは作らない(強制を除く)

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
    submittedAt: null,    // 提出済みにした日時(null=未提出)。週案は毎週提出が義務の学校が多い
    cleared: false,       // 明示的にクリアした週=自動補完(基本時間割の流し込み)で戻さない
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
      // 前回の保存失敗で sessionStorage に退避した未保存分が、localStorageより新しければ復元する
      try {
        const unsaved = sessionStorage.getItem(STORAGE_KEY + '-unsaved');
        if (unsaved) {
          const u = JSON.parse(unsaved);
          const cur = raw ? JSON.parse(raw) : null;
          if (!cur || (u.updatedAt || 0) >= (cur.updatedAt || 0)) { this.recoveredUnsaved = true; return migrate(u); }
        }
      } catch {}
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
      try { sessionStorage.removeItem(STORAGE_KEY + '-unsaved'); } catch {} // 保存成功したら退避は不要
    } catch (e) {
      console.error('保存に失敗しました', e);
      // localStorageが書けない(容量逼迫・ITP等)とき、未保存分を sessionStorage へ自動退避する
      // (同タブ存続中は別クォータで残りやすい。次回起動時に app.js が検知して復元を提案)。
      try { sessionStorage.setItem(STORAGE_KEY + '-unsaved', JSON.stringify(this.state)); } catch {}
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
    // 🔒ロック・予定(会議等)は常に守る。手を入れたコマ(●変更・全文手入力・備考・中止)は
    // preserveEdits のとき守る(他の一括操作=applyBaseTimetableと同じ保護基準に揃える)
    const kept = {};
    if (dst.cells) {
      for (const [k, cell] of Object.entries(dst.cells)) {
        if (cellHasLock(cell) || cellHasActivity(cell) || (preserveEdits && cellHasUserEdits(cell))) kept[k] = cell;
      }
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
   * 前年度(fromFY)の年間行事(週ごとの events)を翌年度(toFY)へ複製する。4月の初期入力(行事の打ち直し)を省く。
   * 同じ「年度内の週番号」へ写すので曜日・季節がほぼ合う(運動会=10月第3週 など)。授業コマ・反省等は触らない。
   * 翌年度の同じ週・同じ曜日に既に行事があれば上書きしない(部分入力を尊重)。戻り値=引き継いだ週数。
   */
  carryOverEvents(fromFY, toFY) {
    const newFirst = fiscalYearFirstMonday(toFY);
    let n = 0;
    for (const [ws, wk] of Object.entries(this.state.weeks)) {
      const ev = wk.events || [];
      if (!ev.some(e => String(e || '').trim())) continue;          // 行事の無い週は飛ばす
      const monday = parseDate(ws);
      if (fiscalYearOf(addDays(monday, 3)) !== fromFY) continue;     // fromFY の週だけ(木曜で年度判定)
      const targetWs = fmtDate(addDays(newFirst, (weekNumberInFiscalYear(monday) - 1) * 7));
      const tw = this.getWeek(targetWs, true);
      if (!Array.isArray(tw.events) || !tw.events.length) tw.events = ['', '', '', '', '', ''];
      ev.forEach((e, i) => { const s = String(e || '').trim(); if (s && !String(tw.events[i] || '').trim()) tw.events[i] = e; });
      n++;
    }
    if (n) this.commit();
    return n;
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
    // 一旦まっさらにする反映でも、ロックしたコマは常に守る。手編集(●変更・手入力・備考・中止・計画外)は
    // preserveEdits のときだけ守る(reapply=守る / reset=ロックのみ守る)。
    const kept = {};
    if (!fillEmptyOnly) {
      for (const [k, cell] of Object.entries(w.cells)) {
        // ロック・活動(会議等の予定)は常に保護。手編集は preserveEdits のときだけ保護。
        if (cellHasLock(cell) || cellHasActivity(cell) || (preserveEdits && cellHasUserEdits(cell))) kept[k] = cell;
      }
    }
    if (!fillEmptyOnly) {
      w.cells = {};                            // 通常の反映は週を一旦まっさらにする(編集済みは後で戻す)
      w.dayPatterns = { ...(base.dayPatterns || {}) }; // 日課パターンも基本時間割に揃える(fillでは既存週の短縮日課を尊重)
    }
    const cloned = cloneCells(base.cells, false);
    let placed = 0;
    for (const [key, cell] of Object.entries(cloned)) {
      const m = /^d(\d+)p/.exec(key);
      const dayIdx = m ? Number(m[1]) : 0;
      if (skipNoSchool && isNoSchoolDay(this.settings, fmtDate(addDays(monday, dayIdx)))) continue;
      if (kept[key]) continue;                                       // 編集済みコマには置かない
      if (fillEmptyOnly && cellIsClaimed(w.cells[key])) continue;   // 既存の授業・予定(非授業)は守る
      w.cells[key] = cell;
      placed++;
    }
    let preserved = 0;
    for (const [k, cell] of Object.entries(kept)) { w.cells[k] = cell; preserved++; } // 編集済みを戻す
    if (commit) this.commit();
    return { placed, preserved };
  }

  /**
   * 「計画に合わせて更新」: 期間内の各週の設定済みコマの本時を、年間指導計画どおりに戻す
   * (本時の上書き・クリア・中止・計画外を消してauto化)。空きコマ(消したコマ)は触らない=戻さない
   * (穴埋めは restoreRangeFromBase)。🔒ロック・予定(会議等)・計画の無い教科は守る。
   * scope(任意)で対象を絞れる: { subjectKey?(教科), scopeId?(学級ID), grade?(学年) }。
   * 戻り値: { weeks: 触れた週数, conformed: 計画に戻したコマ数, kept: 守ったコマ数 }
   */
  generateRange(fromWeekStart, toWeekStart, id = null, scope = null) {
    let monday = mondayOf(parseDate(fromWeekStart));
    const end = mondayOf(parseDate(toWeekStart));
    let weeks = 0, conformed = 0, kept = 0, guard = 0;
    while (fmtDate(monday) <= fmtDate(end) && guard++ < 80) {
      const w = this.state.weeks[fmtDate(monday)];
      if (w && Object.keys(w.cells || {}).length) {
        let touched = false;
        for (const cell of Object.values(w.cells)) {
          if (cellHasLock(cell) || cellHasActivity(cell)) { kept++; continue; }
          let didConform = false;
          for (const e of cell.entries) {
            if (scope && !entryMatchesScope(this.state, e, scope)) continue; // 絞り込み対象外は触らない
            if (conformEntryToPlan(this.state, e)) didConform = true;
          }
          if (didConform) { conformed++; touched = true; } else kept++; // 計画なし・対象外は守る
        }
        if (touched) weeks++;
      }
      monday = addDays(monday, 7);
    }
    this.commit();
    return { weeks, conformed, kept };
  }

  /**
   * 「基本時間割から復元(穴埋め)」: 期間内の各週の空きコマに、基本時間割の授業(教科・学級)を入れ直す。
   * 非破壊=既に授業・予定があれば触らない。非授業日は除外。戻り値: { weeks, placed }。
   */
  restoreRangeFromBase(fromWeekStart, toWeekStart, id = null) {
    const base = id ? this.state.baseTimetables.find(b => b.id === id) : this.state.baseTimetables[0];
    if (!base) return { weeks: 0, placed: 0 };
    let monday = mondayOf(parseDate(fromWeekStart));
    const end = mondayOf(parseDate(toWeekStart));
    let weeks = 0, placed = 0, guard = 0;
    while (fmtDate(monday) <= fmtDate(end) && guard++ < 80) {
      const wk = fmtDate(monday);
      const existed = !!this.state.weeks[wk];
      const w = this.getWeek(wk, true);
      let n = 0;
      for (let d = 0; d < 7; d++) {
        if (isNoSchoolDay(this.settings, fmtDate(addDays(monday, d)))) continue; // 非授業日は入れない
        for (const p of this.settings.periods) n += this._placeBaseCell(w, base, d, p.id);
      }
      if (n) { placed += n; weeks++; }
      else if (!existed && !Object.keys(w.cells).length) delete this.state.weeks[wk]; // 空のまま作った週は残さない
      monday = addDays(monday, 7);
    }
    this.commit();
    return { weeks, placed };
  }

  get hasBaseTimetable() {
    return (this.state.baseTimetables || []).length > 0;
  }

  /** 基本時間割の特定スロットの内容を「教科 学級」ラベルにする(右クリック等の表示用)。無ければ null。 */
  baseCellLabel(dayIdx, periodId, id = null) {
    const base = id ? this.state.baseTimetables.find(b => b.id === id) : this.state.baseTimetables[0];
    const cell = base?.cells?.[cellKey(dayIdx, periodId)];
    if (!cell || !cell.entries?.length) return null;
    const s = this.settings;
    const label = (e) => {
      if (isActivity(e)) return e.unitName || '予定';
      const subj = s.subjects.find(x => x.key === e.subjectKey);
      const subjName = subj ? (subj.short || subj.name) : (e.subjectKey || '');
      const scope = s.mode === 'senka' ? (s.senkaClasses.find(c => c.id === e.scope)?.label || '')
        : (s.mode === 'fukushiki' && e.scope != null ? `${e.scope}年` : '');
      return [subjName, scope].filter(Boolean).join(' ');
    };
    return cell.entries.map(label).filter(Boolean).join('・') || null;
  }

  /** 基本時間割からそのスロットを週へ復元する=空きコマの穴埋め(非破壊)。
   * 既に授業・予定が入っているコマには重ねない(ユーザーが置いた内容を尊重)。
   * 戻り値=復元したコマの授業数(0=空きでなかった/基本に無い)。内部用(commitしない)。 */
  _placeBaseCell(w, base, dayIdx, periodId) {
    const key = cellKey(dayIdx, periodId);
    const baseCell = base?.cells?.[key];
    if (!baseCell || !baseCell.entries?.length) return 0;
    if (cellIsClaimed(w.cells[key])) return 0;            // 既に何か入っているコマは触らない(復元=空きの穴埋めだけ)
    w.cells[key] = cloneCells({ [key]: baseCell }, false)[key];
    return w.cells[key].entries.length;
  }

  /** 復元で入る授業の見出し(「理科 5年1組」等)。空きコマ かつ 基本に授業があるときだけ返す(右クリック導線の出し分け)。 */
  baseRestoreLabel(weekStart, dayIdx, periodId, id = null) {
    const base = id ? this.state.baseTimetables.find(b => b.id === id) : this.state.baseTimetables[0];
    const baseCell = base?.cells?.[cellKey(dayIdx, periodId)];
    if (!baseCell || !baseCell.entries?.length) return null;
    const wcell = this.state.weeks[weekStart]?.cells?.[cellKey(dayIdx, periodId)];
    if (cellIsClaimed(wcell)) return null;                // 既に入っているコマには復元を出さない(穴埋めだけ)
    const s = this.settings;
    const label = (e) => {
      const subj = s.subjects.find(x => x.key === e.subjectKey);
      const subjName = subj ? (subj.short || subj.name) : (e.subjectKey || '');
      const scope = s.mode === 'senka' ? (s.senkaClasses.find(c => c.id === e.scope)?.label || '')
        : (s.mode === 'fukushiki' && e.scope != null ? `${e.scope}年` : '');
      return [subjName, scope].filter(Boolean).join(' ');
    };
    const lessons = baseCell.entries.filter(be => !isActivity(be));
    return lessons.length ? (lessons.map(label).filter(Boolean).join('・') || null) : null;
  }

  /** 基本時間割からこのコマを復元する(空きコマのみ穴埋め)。復元したら true。 */
  restoreCellFromBase(weekStart, dayIdx, periodId, id = null) {
    const base = id ? this.state.baseTimetables.find(b => b.id === id) : this.state.baseTimetables[0];
    if (!base) return false;
    const w = this.getWeek(weekStart, true);
    const n = this._placeBaseCell(w, base, dayIdx, periodId);
    if (n) this.commit();
    return n > 0;
  }

  /** その日の空きコマを基本時間割から一括復元(非授業日は除外)。戻り値=復元したコマ数。 */
  restoreDayFromBase(weekStart, dayIdx, id = null, commit = true) {
    const base = id ? this.state.baseTimetables.find(b => b.id === id) : this.state.baseTimetables[0];
    if (!base) return 0;
    const dateStr = fmtDate(addDays(parseDate(weekStart), dayIdx));
    if (isNoSchoolDay(this.settings, dateStr)) return 0;  // 非授業日には入れない
    const w = this.getWeek(weekStart, true);
    let n = 0;
    for (const p of this.settings.periods) n += this._placeBaseCell(w, base, dayIdx, p.id);
    if (n && commit) this.commit();
    return n;
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
    this.pruneDanglingPins(); // 参照先を失った「本時を選ぶ(pin)」を外し、自然進度の表示に戻す
    this.commit();
  }

  /** 年間計画の単元・計画削除で参照先を失った pin(本時を選ぶ)を全週から外す。戻り値=外した数。 */
  pruneDanglingPins() {
    let n = 0;
    for (const w of Object.values(this.state.weeks || {})) {
      for (const cell of Object.values(w.cells || {})) {
        for (const e of cell.entries || []) {
          if (!e.pin) continue;
          const grade = scopeGrade(this.settings, e.scope);
          const plan = this.state.plans.find(p => p.subjectKey === e.subjectKey && (p.grade == null || p.grade === grade));
          if (!plan?.units?.some(u => String(u.id) === String(e.pin.unitId))) { e.pin = null; n++; }
        }
      }
    }
    return n;
  }

  /** 指定教科・学年の計画が反映される「設定済み授業コマ」数(計画削除の影響告知用)。 */
  countPlanCells(subjectKey, grade) {
    let n = 0;
    for (const w of Object.values(this.state.weeks || {})) {
      for (const cell of Object.values(w.cells || {})) {
        for (const e of cell.entries || []) {
          if (e.subjectKey === subjectKey && (grade == null || scopeGrade(this.settings, e.scope) === grade)) n++;
        }
      }
    }
    return n;
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
    this.makeBackup('取り込みの前', { force: true }); // 取り込みで全置換する前に今の状態を退避
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

  // -------- 自動バックアップ(復元ポイント)
  // 端末内に直近の状態を数世代だけ静かに残す安全網。誤削除・誤上書き・週クリア等をいつでも巻き戻せる。
  // 「元に戻す」(数秒で消えるトースト)を超える保険。GASのドライブ控えとは別の、ネット不要のローカル保険。
  makeBackup(reason = '自動', { force = false } = {}) {
    try {
      const now = Date.now();
      const list = this.listBackups(); // 新しい順
      const newest = list[0];
      // 直近バックアップから一定時間内なら作らない(連続編集でスパムしない)。強制時は無視。
      if (!force && newest && (now - newest.t) < BK_MIN_INTERVAL_MS) return false;
      const json = this.exportJSON(); // GASトークンは含めない
      // 直近と中身が同じなら作らない(無変更の重複世代を防ぐ)
      if (newest) {
        try { if (localStorage.getItem(newest.key) === json) return false; } catch {}
      }
      const key = `${BK_PREFIX}${now}__${encodeURIComponent(reason)}`;
      // 容量逼迫時は古い世代を削ってから再試行(保存の本体を壊さない)
      let saved = false;
      for (let attempt = 0; attempt < BK_MAX + 2 && !saved; attempt++) {
        try { localStorage.setItem(key, json); saved = true; }
        catch (e) {
          const cur = this.listBackups();
          if (!cur.length) break; // もう削るものが無い(本体だけで逼迫)→ 諦める
          try { localStorage.removeItem(cur[cur.length - 1].key); } catch {}
        }
      }
      if (saved) this._pruneBackups();
      return saved;
    } catch { return false; }
  }

  /** 復元ポイント一覧(新しい順)。重い本体は読まず、キーから日時と理由だけ取り出す。 */
  listBackups() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(BK_PREFIX)) continue;
      const rest = k.slice(BK_PREFIX.length);
      const sep = rest.indexOf('__');
      const t = Number(sep >= 0 ? rest.slice(0, sep) : rest);
      if (!t) continue;
      let reason = '自動';
      if (sep >= 0) { try { reason = decodeURIComponent(rest.slice(sep + 2)); } catch {} }
      out.push({ key: k, t, reason });
    }
    return out.sort((a, b) => b.t - a.t);
  }

  _pruneBackups() {
    const list = this.listBackups(); // 新しい順
    for (const b of list.slice(BK_MAX)) { try { localStorage.removeItem(b.key); } catch {} }
  }

  /** 復元ポイントへ戻す。戻す前に現在の状態も自動バックアップ(復元自体の誤操作も巻き戻せる)。 */
  restoreBackup(key) {
    let raw;
    try { raw = localStorage.getItem(key); } catch { return false; }
    if (!raw) return false;
    let data;
    try { data = JSON.parse(raw); } catch { return false; }
    if (typeof data !== 'object' || data === null || !data.settings || !('weeks' in data)) return false;
    this.makeBackup('復元の前', { force: true }); // 今の状態を退避してから置き換える
    this.replaceState(data); // migrate・ローカルGAS維持・保存・通知まで行う
    return true;
  }

  deleteBackup(key) { try { localStorage.removeItem(key); return true; } catch { return false; } }
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
    // 年間計画が無いコマ用の手入力の単元・進度(計画があれば計画が優先)。
    // 教科の無い活動(会議・委員会・クラブ等)は subjectKey='' + unitName + noCount で表す。
    unitName: '', nth: 0, unitHours: 0,
    noCount: false,    // 時数集計から除外
    advance: null,     // 進度カウント(null=校時種別の既定に従う)
    fraction: 1,       // 分数時数: このコマに占める割合(1, 2/3, 1/2, 1/3)
    cancelled: false,  // 中止・未実施(時数・進度とも除外、表示は取り消し線)
    cancelledText: '', // 中止時点の予定内容のスナップショット(提出書類に「何が中止か」を残す)
    cancelledReason: '', // 中止の理由(任意。学級閉鎖・行事変更など)
    endUnit: false,    // この時間で単元を終える(残りの計画コマを飛ばし、次のコマから次の単元へ)
    guide: null,       // 複式: 'direct'(直接指導)|'indirect'(間接)|'guide'(ガイド学習)|null
    pin: null,         // この時間だけ別の単元の本時をやる {unitId, nth}|null。自動の順番から外して差し込む(自転車操業対応)
    offplan: false,    // 計画外(復習・テスト・予備など)。年間計画の本時に紐づかず、進度カウンタを消費しない
    locked: false,     // ロック。「計画に合わせて更新」で上書きされず守られる(週ごとの保護。明示操作)
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
    // キーがあれば空文字も保持する(=「明示的に白紙にした」状態。計画文に自動で戻さない)。
    // 上書きを完全に解除したいときは、そのキー自体を消す(↺ 計画に戻す)。
    if (k in o && o[k] != null) out[k] = String(o[k]);
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
  // 各項目は独立。ねらいを直しても学習活動・評価規準は自動では消さない(意図しない削除を防ぐ)。
  // 中身を消したいときは明示的に空にする(「内容をクリア」または各欄で消す)。空文字も保持される。
  const eff = {
    objective: ('objective' in o) ? o.objective : base.objective,
    activity: ('activity' in o) ? o.activity : base.activity,
    assessment: ('assessment' in o) ? o.assessment : base.assessment,
    viewpoint: ('viewpoint' in o) ? o.viewpoint : base.viewpoint,
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

/** このエントリにユーザーの手編集が入っているか(上書き・手入力・備考・中止・差し込み等)。一括操作で守る判定に使う。 */
export function isEntryEdited(e) {
  if (!e) return false;
  if (normalizeOverride(e.override)) return true;               // ●変更(項目別の上書き)
  if (e.auto === false && e.text && e.text.trim()) return true; // 内容を全文手入力
  if (e.note && e.note.trim()) return true;                     // 備考
  if (e.cancelled) return true;                                 // 中止指定
  if (e.offplan) return true;                                   // 計画外(復習・テスト等。一括再反映で自動コマに戻さない)
  if (e.pin) return true;                                       // 別単元の差し込み
  if (e.endUnit) return true;                                   // この時間で単元を切り上げ
  if ((e.fraction ?? 1) !== 1) return true;                     // 分数時数(0.5コマ等)
  if (e.guide) return true;                                     // 複式の指導形態
  if (e.subjectKey && e.noCount) return true;                   // 授業を時数外にした
  if (isActivity(e)) return true;                               // 活動(会議・委員会等。手で入れたもの)
  if ((e.unitName && e.unitName.trim()) || e.nth || e.unitHours) return true; // 計画なしの手入力(単元・時数)
  return false;
}

/** セル内のいずれかのエントリが手編集済みなら true(=破壊的な一括操作から守る) */
export function cellHasUserEdits(cell) {
  return !!cell && Array.isArray(cell.entries) && cell.entries.some(isEntryEdited);
}

/** セル内のいずれかのエントリがロックされているか。「計画に合わせて更新」で常に守る判定。 */
export function cellHasLock(cell) {
  return !!cell && Array.isArray(cell.entries) && cell.entries.some(e => e && e.locked);
}

/** 「活動」entry = 教科の無いコマ(会議・委員会・クラブ・出張など)。unitName を見出しに表示し時数に数えない。
 * 旧「予定(blocked)」をこの形に統一(コマ=授業か空きの2状態に簡素化)。 */
export function isActivity(entry) {
  return !!entry && !entry.subjectKey && entry.noCount === true;
}

/** セル内に活動(会議・委員会・自習・授業なし等)があるか。基本時間割に無い週限定の予定を「計画に合わせて更新」で常に守る判定。 */
export function cellHasActivity(cell) {
  return !!cell && Array.isArray(cell.entries) && cell.entries.some(isActivity);
}

/** 授業entryの「本時」を計画どおりに戻す(上書き・手入力・別の本時(pin)・計画外・単元切上げ・進度上書きを消してauto化)。
 * 中止・分数時数・時数外は「実施・時数の事実記録」で本時の内容ではないので保持する。
 * 教科・学級は残す。計画の無い教科(手入力で記録するコマ)は戻す先が無いので触らない。実際に変わったら true。 */
export function conformEntryToPlan(state, entry) {
  if (!entry || !entry.subjectKey) return false;       // 空き・活動は対象外
  const grade = scopeGrade(state.settings, entry.scope);
  const hasPlan = state.plans.some(p => p.subjectKey === entry.subjectKey && (p.grade == null || p.grade === grade));
  if (!hasPlan) return false;                            // 計画なし=手入力で記録 → 残す
  // 既に計画どおり(本時に手を入れていない)なら何も変えない=「計画に戻した件数」を水増ししない
  const changed = !!normalizeOverride(entry.override) || (entry.auto === false && !!(entry.text && entry.text.trim()))
    || entry.offplan || !!entry.pin || entry.endUnit || (entry.advance != null);
  entry.override = null; entry.text = ''; entry.auto = true;
  entry.offplan = false; entry.pin = null; entry.endUnit = false; entry.advance = null;
  return changed;
}

/** entryが絞り込み条件 scope({subjectKey?, scopeId?(学級ID), grade?(学年)}) に合致するか。「計画に合わせて更新」の対象判定。 */
export function entryMatchesScope(state, entry, scope) {
  if (!scope) return true;
  if (scope.subjectKey && entry.subjectKey !== scope.subjectKey) return false;
  if (scope.scopeId != null && scope.scopeId !== '' && String(entry.scope ?? '') !== String(scope.scopeId)) return false;
  if (scope.grade != null && scopeGrade(state.settings, entry.scope) !== scope.grade) return false;
  return true;
}

/** このコマが「占有済み」=entryがある(授業 or 活動)。流し込みで埋める対象から外す判定。 */
export function cellIsClaimed(cell) {
  return !!cell && Array.isArray(cell.entries) && cell.entries.length > 0;
}

/** セル群を複製。keepText=falseなら週ごとの実施記録(本時内容・備考・中止・差し込み・単元切上げ・分数時数・進度上書き・上書き)を
 * 初期化して自動反映に戻す。教科・学級・活動(会議等の unitName/noCount)・複式の指導形態は枠組みなので keepText に関わらず引き継ぐ。 */
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
        cancelledText: keepText ? e.cancelledText : '',
        cancelledReason: keepText ? e.cancelledReason : '',
        override: keepText ? e.override : null,   // ●変更(項目別上書き)は週ごとの実施記録
        locked: false,                      // ロックは複製しない(週ごとの保護。ひな形・前週コピーには持ち込まない)
        pin: keepText ? e.pin : null,       // 別単元・計画外・単元切上げ・分数時数・進度上書きは週ごとの状態。
        offplan: keepText ? e.offplan : false, // ひな形(keepText=false)には持ち込まない
        endUnit: keepText ? e.endUnit : false,
        fraction: keepText ? e.fraction : 1,
        advance: keepText ? e.advance : null,
      })),
    };
  }
  return out;
}

/** 1コマを正規化する(週・基本時間割で共用)。entryを整え、旧「予定(blocked)」を
 * 「活動entry(会議・委員会等。教科なし＋見出し＋時数に数えない)」へ移行する。
 * 戻り値: このコマを残すか(=授業 or 活動のentryがあるか)。 */
function migrateCell(cell) {
  if (!cell || !Array.isArray(cell.entries)) return false;
  cell.entries = cell.entries.filter(e => e && typeof e === 'object').map(e => {
    const ne = { ...newEntry(), ...e, id: e.id || uid() };
    ne.override = normalizeOverride(ne.override);
    return ne;
  });
  // 旧「予定(blocked)」コマ → 時数に数えない活動entry(会議・委員会など)へ
  const note = typeof cell.note === 'string' ? cell.note.trim() : '';
  const wasBlocked = cell.blocked === true || note !== '';
  if (wasBlocked && !cell.entries.length) {
    const a = newEntry();
    a.unitName = note || '予定';
    a.noCount = true;
    cell.entries.push(a);
  }
  delete cell.blocked; delete cell.note; // セルからは撤廃(状態はentryに集約)
  return cell.entries.length > 0;
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
      if (!migrateCell(cell)) delete w.cells[ck];
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
  // 基本時間割のコマも正規化(旧「予定(blocked)」→活動entryへ移行)
  for (const base of data.baseTimetables) {
    if (!base || typeof base.cells !== 'object') { if (base) base.cells = {}; continue; }
    for (const [ck, cell] of Object.entries(base.cells)) {
      if (!migrateCell(cell)) delete base.cells[ck];
    }
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
  // 母集合を時数集計(computeHours)と厳密に一致: 境界週まで走査し、所属年度は実日付で判定する(振替授業日の年度跨ぎ対策)
  const fy = refWeekStart ? fiscalYearOf(addDays(parseDate(refWeekStart), 3)) : 0;
  const fyStart = `${fy}-04-01`, fyEnd = `${fy + 1}-03-31`;
  const scanFrom = range ? fmtDate(addDays(parseDate(range.from), -7)) : '';
  const counters = new Map();
  const ordinals = new Map();

  const weekKeys = Object.keys(weeks).sort();
  for (const wk of weekKeys) {
    if (range && (wk < scanFrom || wk > range.to)) continue;
    const week = weeks[wk];
    const monday = parseDate(wk);
    for (let d = 0; d < 7; d++) {
      if (range) { const ds = fmtDate(addDays(monday, d)); if (ds < fyStart || ds > fyEnd) continue; }
      for (const p of settings.periods) {
        if (!effectivePeriod(settings, week, d, p)) continue; // その日は無効な校時
        const cell = week.cells[cellKey(d, p.id)];
        if (!cell) continue;
        for (const e of cell.entries) {
          if (!e.subjectKey || e.cancelled || e.noCount) continue; // 中止・時数外は進度を進めない(指導計画は時数で測るため)
          if (e.pin || e.offplan) continue; // 別単元(差し込み)・計画外は自動カウンタを動かさない=他コマの順番は不変
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
  // 計画外(復習・テスト・予備): 年間計画は引かず、自由ねらい(override.objective)/手入力を1行表示にする
  if (entry.offplan) {
    const ov = normalizeOverride(entry.override);
    return { text: ov?.objective || entry.text || '', auto: true, info: null };
  }
  const grade = scopeGrade(state.settings, entry.scope);
  const plan = state.plans.find(p => p.subjectKey === entry.subjectKey && (p.grade == null || p.grade === grade))
    || null;
  // pin があれば自動の順番を無視して指定単元の本時を出す(この時間だけ別の単元)
  const info = plan ? (entry.pin ? lessonFromPin(plan, entry.pin) : lessonFromPlan(plan, ordinals.get(entry.id))) : null;
  if (!info) {
    // 計画なし(手記録・活動): 手入力の単元名(n/m) + ねらい(override)/手入力 を1行に組む
    // (auto=false&&text の手入力は冒頭で return 済みなので、ここは auto のケースのみ)
    const uName = String(entry.unitName || '');
    const nth = Number(entry.nth) || 0, uHours = Number(entry.unitHours) || 0;
    const obj = normalizeOverride(entry.override)?.objective || entry.text || '';
    const counter = (uHours > 1 && nth) ? `(${nth}/${uHours})` : '';
    return { text: `${uName}${counter}${obj ? ` ${obj}` : ''}`.trim(), auto: true, info: null };
  }
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
  if (!info && entry.subjectKey && !entry.offplan) {
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
    // 計画が無い/終了したコマ。手入力の単元・時数(nth/総時数)と override で記録する。
    // 教科の無い活動(会議・委員会等)もここ(unitName を見出しに、時数に数えない)。
    const ov = normalizeOverride(entry.override);
    const uName = String(entry.unitName || '');
    // 手入力(単元名・override)が何も無ければ details なし(表示は空。計画外も計画本文を引かない)
    if (!ov && !uName) return { resolved, details: null };
    const merged = mergeLessonOverride(null, ov);
    return {
      resolved,
      details: {
        unitName: uName, unitId: '', nth: Number(entry.nth) || 0, unitHours: Number(entry.unitHours) || 0,
        planId: '', textbook: '',
        grade: scopeGrade(state.settings, entry.scope) || null,
        manualText: resolved.auto ? '' : resolved.text,
        unitGoal: '', unitCriteria: { knowledge: '', thinking: '', attitude: '' },
        planless: true,           // 年間計画に紐づかない手記録(編集UIで単元・時数も変える)
        ...merged,                // objective/activity/assessment/viewpoint(学習活動はここ)
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
 * 観点別(知/思/態)の評価場面数を集計する。年度内・今日までに実施した、時数に数える非中止の授業コマについて、
 * 実効観点(override優先、なければ計画)を数える。戻り値: Map<scopeKey, {知, 思, 態, total}>。
 * 評定期に「思考の評価場面が足りない」等を、観点別評価の入力済みデータから事前に把握するため。
 */
export function computeViewpointTally(state, refWeekStart) {
  const { settings, weeks } = state;
  const range = refWeekStart ? fiscalRangeOf(refWeekStart) : null;
  const ordinals = computeOrdinals(state, refWeekStart);
  const todayStr = fmtDate(new Date());
  // 母集合を時数集計・進度と一致(境界週・実日付判定)
  const fy = refWeekStart ? fiscalYearOf(addDays(parseDate(refWeekStart), 3)) : 0;
  const fyStart = `${fy}-04-01`, fyEnd = `${fy + 1}-03-31`;
  const scanFrom = range ? fmtDate(addDays(parseDate(range.from), -7)) : '';
  const tally = new Map();
  const weekKeys = Object.keys(weeks).sort();
  for (const wk of weekKeys) {
    if (range && (wk < scanFrom || wk > range.to)) continue;
    const week = weeks[wk];
    const monday = parseDate(wk);
    for (let d = 0; d < 7; d++) {
      const ds = fmtDate(addDays(monday, d));
      if (ds > todayStr) continue;             // 今日より後の未実施コマは数えない
      if (range && (ds < fyStart || ds > fyEnd)) continue; // 年度外の日(境界週の前後年度)は数えない
      for (const p of settings.periods) {
        if (!effectivePeriod(settings, week, d, p)) continue;
        const cell = week.cells[cellKey(d, p.id)];
        if (!cell) continue;
        for (const e of cell.entries) {
          if (!e.subjectKey || e.noCount || e.cancelled) continue; // 時数外(noCount)は評価場面にも数えない
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

/**
 * 授業マネジメント用の進度予測。教科×スコープ(学級/学年)ごとに、年間指導計画に対する
 * 「実施済/残り」「計画通り/遅れ/先行」「年度末の完了見込み」「単元ごとの進み」を、
 * 追加入力なしで既存データ(週案・計画・授業週)から算出する。戻り値: Map<scopeKey, Forecast>。
 *  - 基準: 計画を年度内に均した理想線(バーンダウンの理想線)と実績の差で 遅れ/先行 を出す。
 *  - 見込み: 今のペース(実施済÷経過授業週)×残り授業週 が計画総時数に届くか。
 *  長期休業は teachingWeeks* が既に除外するので見込みは過大にならない。
 */
export function computeProgressForecast(state, refWeekStart) {
  const { settings, weeks } = state;
  const ordinals = computeOrdinals(state, refWeekStart);
  const todayStr = fmtDate(new Date());
  const range = refWeekStart ? fiscalRangeOf(refWeekStart) : null;
  const fy = refWeekStart ? fiscalYearOf(addDays(parseDate(refWeekStart), 3)) : 0;
  const fyStart = `${fy}-04-01`, fyEnd = `${fy + 1}-03-31`;
  const scanFrom = range ? fmtDate(addDays(parseDate(range.from), -7)) : '';
  const planFor = (subjectKey, scope) => {
    const grade = scopeGrade(settings, scope);
    return state.plans.find(p => p.subjectKey === subjectKey && (p.grade == null || p.grade === grade)) || null;
  };

  // 1パス: スコープごとに 実施済(今日以前) を単元別に集計し、次の授業ordinal(今日より後の最小)を拾う
  const acc = new Map();
  const ensure = (subjectKey, scope) => {
    const k = scopeKey(subjectKey, scope);
    let a = acc.get(k);
    if (!a) { a = { subjectKey, scope, doneByUnit: new Map(), doneTotal: 0, cut: new Set(), nextOrd: null }; acc.set(k, a); }
    return a;
  };
  for (const wk of Object.keys(weeks).sort()) {
    if (range && (wk < scanFrom || wk > range.to)) continue;
    const week = weeks[wk];
    const monday = parseDate(wk);
    for (let d = 0; d < 7; d++) {
      const dateStr = fmtDate(addDays(monday, d));
      if (range && (dateStr < fyStart || dateStr > fyEnd)) continue;
      for (const p of settings.periods) {
        if (!effectivePeriod(settings, week, d, p)) continue;
        const cell = week.cells[cellKey(d, p.id)];
        if (!cell) continue;
        for (const e of cell.entries) {
          if (!e.subjectKey || e.cancelled || e.noCount || e.pin || e.offplan) continue; // 時数外も進度に数えない(時数と一致)
          const advances = e.advance == null ? p.type !== 'module' : !!e.advance;
          if (!advances) continue;
          const o = ordinals.get(e.id);
          if (o == null || !planFor(e.subjectKey, e.scope)) continue;
          const a = ensure(e.subjectKey, e.scope);
          if (dateStr <= todayStr) {
            a.doneTotal++;
            const info = lessonFromPlan(planFor(e.subjectKey, e.scope), o);
            if (info && info.unit) {
              a.doneByUnit.set(info.unit.id, (a.doneByUnit.get(info.unit.id) || 0) + 1);
              if (e.endUnit) a.cut.add(info.unit.id); // 切り上げた単元は「済」扱い
            }
          } else if (a.nextOrd == null || o < a.nextOrd) {
            a.nextOrd = o; // 次に教えるコマ
          }
        }
      }
    }
  }

  const elapsed = teachingWeeksElapsed(settings, refWeekStart);
  const left = teachingWeeksLeft(settings, refWeekStart);
  const total = elapsed + left;
  // 残りの「枠」を実カウントするため、基本時間割の週あたりコマ数を出す(モジュール=進度に数えないので除外)。
  // これと「残り授業週数(休業除外済み)」を掛けると、平均ペースの外挿より実態に近い完了見込みになる。
  const base = state.baseTimetables?.[0];
  const weeklyRateOf = (k) => {
    if (!base?.cells) return null;                              // 基本時間割なし→平均ペースで概算
    let n = 0;
    for (const [key, cell] of Object.entries(base.cells)) {
      const pid = key.replace(/^d\d+p/, '');
      if (settings.periods.find(p => p.id === pid)?.type === 'module') continue;
      for (const e of (cell.entries || [])) if (!e.noCount && scopeKey(e.subjectKey, e.scope) === k) n++;
    }
    return n;
  };
  const out = new Map();
  for (const [k, a] of acc) {
    const plan = planFor(a.subjectKey, a.scope);
    if (!plan || !plan.units?.length) continue;
    const unitHours = plan.units.map(u => Math.max(1, Math.round(u.hours || u.lessons?.length || 1)));
    const planTotal = unitHours.reduce((s, h) => s + h, 0);
    if (!planTotal) continue;
    const taught = a.doneTotal;
    const remaining = Math.max(0, planTotal - taught);
    const expected = total > 0 ? planTotal * elapsed / total : 0;
    const behind = Math.round(expected - taught);              // + 遅れ / - 先行
    const pace = elapsed > 0 ? taught / elapsed : 0;
    const requiredPace = left > 0 ? remaining / left : (remaining > 0 ? Infinity : 0);
    const weeklyRate = weeklyRateOf(k);                        // 週あたりコマ数(基本時間割) | null
    // 完了見込み = 実施済 ＋ 残りの枠(週あたり × 残り授業週の実数)。枠が無ければ平均ペースで外挿。
    const capacityLeft = weeklyRate != null ? weeklyRate * left : Math.round(pace * left);
    const projected = taught + capacityLeft;
    const shortfall = Math.max(0, Math.round(planTotal - projected));
    const feasible = projected >= planTotal || remaining === 0;
    let status;
    if (taught >= planTotal) status = 'done';
    else if (behind >= 1) status = 'behind';
    else if (behind <= -1) status = 'ahead';
    else status = 'ontrack';

    let currentIdx = -1;
    const units = plan.units.map((u, i) => {
      const hours = unitHours[i];
      const done = Math.min(hours, a.doneByUnit.get(u.id) || 0);
      const full = a.cut.has(u.id) || done >= hours;
      if (!full && currentIdx === -1) currentIdx = i;
      return { id: u.id, name: u.name || `単元${i + 1}`, hours, done, cut: a.cut.has(u.id), _full: full };
    });
    units.forEach((u, i) => { u.status = u._full ? 'done' : (i === currentIdx ? 'current' : 'todo'); delete u._full; });
    const next = a.nextOrd != null ? lessonFromPlan(plan, a.nextOrd) : null;

    out.set(k, {
      subjectKey: a.subjectKey, scope: a.scope, grade: scopeGrade(settings, a.scope),
      planTotal, taught, remaining, pct: Math.round((taught / planTotal) * 100),
      elapsed, left, expected: Math.round(expected), behind, status,
      pace: Math.round(pace * 10) / 10,
      requiredPace: requiredPace === Infinity ? Infinity : Math.round(requiredPace * 10) / 10,
      weeklyRate, capacityLeft: Math.round(capacityLeft),
      projected: Math.round(projected), shortfall, feasible,
      next: next && !next.exhausted ? { unitName: next.unitName, nth: next.nth, unitHours: next.unitHours, objective: next.lessonText } : null,
      units,
    });
  }
  return out;
}

/**
 * 出欠メモ(週ごと・日ごとのフリーテキスト)から「欠席/遅刻/早退」の数を拾い、月別に合計する。
 * 形式は自由だが「欠2 遅1 早1」「欠席2」等のラベル+数字を best-effort で読む(出席簿への転記を1段省く)。
 * 戻り値: { months: Map<monthNum, {abs,late,early}>, total: {abs,late,early}, any: boolean }
 */
export function computeAttendance(state, refWeekStart) {
  const { weeks } = state;
  const fy = refWeekStart ? fiscalYearOf(addDays(parseDate(refWeekStart), 3)) : fiscalYearOf(new Date());
  const fyStart = `${fy}-04-01`, fyEnd = `${fy + 1}-03-31`;
  const g = (txt, re) => { const m = String(txt || '').match(re); return m ? Number(m[1]) : 0; };
  const months = new Map();
  const total = { abs: 0, late: 0, early: 0 };
  let any = false;
  for (const [ws, wk] of Object.entries(weeks)) {
    const att = wk.attendance || [];
    if (!att.some(a => String(a || '').trim())) continue;
    const monday = parseDate(ws);
    for (let d = 0; d < att.length; d++) {
      const a = String(att[d] || '').trim();
      if (!a) continue;
      const dateStr = fmtDate(addDays(monday, d));
      if (dateStr < fyStart || dateStr > fyEnd) continue;
      const rec = { abs: g(a, /欠(?:席)?\s*(\d+)/), late: g(a, /遅(?:刻)?\s*(\d+)/), early: g(a, /早(?:退)?\s*(\d+)/) };
      if (!rec.abs && !rec.late && !rec.early) continue;
      any = true;
      const month = Number(dateStr.slice(5, 7));
      const cur = months.get(month) || { abs: 0, late: 0, early: 0 };
      cur.abs += rec.abs; cur.late += rec.late; cur.early += rec.early;
      months.set(month, cur);
      total.abs += rec.abs; total.late += rec.late; total.early += rec.early;
    }
  }
  return { months, total, any };
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
    if (wk > range.to) break;    // 年度末まで走査(yearTotal=年間の入力済み総数を出すため)
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
          const cur = acc.get(k) || { week: 0, total: 0, done: 0, yearTotal: 0 };
          const c = (eff.coefficient ?? 1) * (e.fraction ?? 1);
          cur.yearTotal += c;                  // 年間の入力済み総数(残り・進捗率の母数)
          if (wk <= scanTo) cur.total += c;     // 予定計=表示週までの累計(週ナビで累計が増える表示用)
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
