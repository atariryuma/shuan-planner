import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  key(index) { return [...this.values.keys()][index] ?? null; }
}

globalThis.localStorage = new MemoryStorage();
globalThis.document = { dispatchEvent() {} };

const { defaultState, cellKey, computeOrdinals, resolveEntryPlanDetails, cellHasLock, isActivity, isEntryEdited, conformEntryToPlan, store, mergeLessonOverride, normalizeOverride } = await import('../js/store.js');

// 活動(会議・委員会等)entry: 教科なし＋見出し＋時数に数えない
const activityEntry = (name) => ({ id: `act-${name}`, subjectKey: '', scope: null, unitName: name, nth: 0, unitHours: 0, noCount: true, fraction: 1, cancelled: false, auto: true, override: null });
const { buildPrintHoursModel, capSubjectColumns } = await import('../js/print-hours.js');
const { renderWeeklyHoursBox, buildWeekPlanDetailModel, splitDetailLessons, renderPlanDetailPages } = await import('../js/print.js');

const WEEK = '2026-06-08';

function addEntry(state, day, periodId, subjectKey, scope = null, patch = {}) {
  state.weeks[WEEK] ||= {
    start: WEEK,
    cells: {},
    events: ['', '', '', '', '', ''],
    dayNotes: ['', '', '', '', '', ''],
    attendance: ['', '', '', '', '', ''],
    dayPatterns: {},
    goals: '',
    reflection: '',
  };
  const key = cellKey(day, periodId);
  state.weeks[WEEK].cells[key] ||= { entries: [] };
  state.weeks[WEEK].cells[key].entries.push({
    id: `${day}-${periodId}-${subjectKey}-${scope ?? ''}`,
    subjectKey,
    scope,
    fraction: 1,
    noCount: false,
    cancelled: false,
    ...patch,
  });
}

test('homeroom model uses subjects as columns and adds totals', () => {
  const state = defaultState();
  state.settings.grade = 4;
  addEntry(state, 0, 'p1', 'kokugo');
  addEntry(state, 0, 'p2', 'sansu');
  addEntry(state, 1, 'p1', 'kokugo');

  const model = buildPrintHoursModel(state, WEEK);

  assert.equal(model.kind, 'homeroom');
  assert.ok(model.items.some(item => item.label === '国'));
  assert.ok(model.items.some(item => item.label === '算'));
  assert.equal(model.items.find(item => item.label === '国').week, 2);
  assert.equal(model.items.find(item => item.label === '国').standard, 245);
  assert.equal(model.items.at(-1).week, 3);
  assert.equal(model.items.at(-1).standard, 1015);
});

test('senka model uses classes as rows and never combines class standards', () => {
  const state = defaultState();
  state.settings.mode = 'senka';
  state.settings.senkaSubject = 'rika';
  state.settings.senkaClasses = [
    { id: '3-1', label: '3年1組', grade: 3 },
    { id: '4-1', label: '4年1組', grade: 4 },
  ];
  addEntry(state, 0, 'p1', 'rika', '3-1');
  addEntry(state, 1, 'p1', 'rika', '3-1');
  addEntry(state, 0, 'p2', 'rika', '4-1');

  const model = buildPrintHoursModel(state, WEEK);

  assert.equal(model.kind, 'senka');
  assert.equal(model.rows.length, 2);
  assert.deepEqual(model.rows.map(row => row.classLabel), ['3年1組', '4年1組']);
  assert.deepEqual(model.rows.map(row => row.week), [2, 1]);
  assert.deepEqual(model.rows.map(row => row.standard), [90, 105]);
});

test('senka model keeps configured classes visible when their count is zero', () => {
  const state = defaultState();
  state.settings.mode = 'senka';
  state.settings.senkaSubject = 'rika';
  state.settings.senkaClasses = [
    { id: '3-1', label: '3年1組', grade: 3 },
    { id: '3-2', label: '3年2組', grade: 3 },
  ];
  addEntry(state, 0, 'p1', 'rika', '3-1');

  const model = buildPrintHoursModel(state, WEEK);

  assert.equal(model.rows.length, 2);
  assert.equal(model.rows[1].classLabel, '3年2組');
  assert.equal(model.rows[1].week, 0);
  assert.equal(model.rows[1].standard, 90);
});

test('fukushiki model keeps each grade in an independent subject table', () => {
  const state = defaultState();
  state.settings.mode = 'fukushiki';
  state.settings.fukushikiGrades = [3, 4];
  addEntry(state, 0, 'p1', 'rika', 3);
  addEntry(state, 0, 'p1', 'rika', 4);
  addEntry(state, 1, 'p1', 'sansu', 4);

  const model = buildPrintHoursModel(state, WEEK);

  assert.equal(model.kind, 'fukushiki');
  assert.deepEqual(model.grades.map(group => group.grade), [3, 4]);
  assert.ok(model.grades[0].items.some(item => item.label === '理'));
  assert.ok(model.grades[1].items.some(item => item.label === '算'));
  assert.equal(
    model.grades[0].items.find((item) => item.label === '理').standard,
    90,
  );
  assert.equal(model.grades[1].items.find(item => item.label === '理').standard, 105);
});

test('column cap preserves a visible total and combines minor subjects', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    key: `s${index}`,
    label: `S${index}`,
    name: `S${index}`,
    week: index + 1,
    total: (index + 1) * 10,
    standard: 35,
    remain: 35 - (index + 1) * 10,
    progress: 10,
  }));

  const capped = capSubjectColumns(items, 3);

  assert.deepEqual(capped.map(item => item.label), ['S3', 'S4', 'ほか', '合計']);
  assert.equal(capped.find(item => item.label === 'ほか').week, 6);
  assert.equal(capped.at(-1).week, 15);
});

test('senka print with many classes renders two complete bordered tables', () => {
  const state = defaultState();
  state.settings.mode = 'senka';
  state.settings.senkaSubject = 'rika';
  state.settings.senkaClasses = Array.from({ length: 10 }, (_, index) => ({
    id: `c${index + 1}`,
    label: `3年${index + 1}組`,
    grade: 3,
  }));
  state.settings.senkaClasses.forEach((cls, index) => {
    addEntry(state, index % 5, 'p1', 'rika', cls.id);
  });

  const html = renderWeeklyHoursBox(state, WEEK);

  assert.equal((html.match(/<table class="pp-hours-table pp-senka-hours">/g) || []).length, 2);
  assert.equal((html.match(/<thead><tr><th>学級<\/th>/g) || []).length, 2);
  assert.match(html, /3年10組/);
  assert.match(html, /標準/);
  assert.match(html, /進捗/);
});

test('weekly plan details preserve every annual-plan field', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.plans.push({
    id: 'plan-rika-4',
    subjectKey: 'rika',
    grade: 4,
    textbook: 'テスト出版',
    startOffset: 0,
    units: [{
      id: 'unit-air',
      name: '空気と水',
      hours: 1,
      goal: '空気と水の性質を理解する。',
      criteria: {
        knowledge: '性質を理解している。',
        thinking: '実験結果から考察している。',
        attitude: '進んで実験に取り組んでいる。',
      },
      lessons: [{
        objective: '閉じ込めた空気の性質を調べる。',
        activity: '注射器を使って体積の変化を比較する。',
        assessment: '空気を押したときの変化を説明できる。',
        viewpoint: '思',
      }],
    }],
  });
  addEntry(state, 0, 'p1', 'rika');

  const entry = state.weeks[WEEK].cells[cellKey(0, 'p1')].entries[0];
  const detail = resolveEntryPlanDetails(state, entry, computeOrdinals(state, WEEK)).details;
  const model = buildWeekPlanDetailModel(state, WEEK);

  assert.equal(detail.unitGoal, '空気と水の性質を理解する。');
  assert.equal(detail.unitCriteria.knowledge, '性質を理解している。');
  assert.equal(detail.activity, '注射器を使って体積の変化を比較する。');
  assert.equal(detail.assessment, '空気を押したときの変化を説明できる。');
  assert.equal(detail.viewpointLabel, '思考・判断・表現');
  assert.equal(model.length, 1);
  assert.equal(model[0].textbook, 'テスト出版');
  assert.deepEqual(model[0].scopes, ['4年']);
  assert.equal(model[0].lessons[0].objective, '閉じ込めた空気の性質を調べる。');
});

test('manual weekly text keeps its linked annual-plan details', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.plans.push({
    id: 'plan-rika-manual',
    subjectKey: 'rika',
    grade: 4,
    units: [{
      id: 'unit-manual',
      name: '天気',
      hours: 1,
      goal: '天気の変化を理解する。',
      criteria: { knowledge: '', thinking: '', attitude: '' },
      lessons: [{ objective: '雲を観察する。', activity: '空を見る。', assessment: '記録できる。', viewpoint: '知' }],
    }],
  });
  addEntry(state, 0, 'p1', 'rika', null, { auto: false, text: '雨天のため映像資料で確認' });

  const entry = state.weeks[WEEK].cells[cellKey(0, 'p1')].entries[0];
  const detail = resolveEntryPlanDetails(state, entry, computeOrdinals(state, WEEK)).details;

  assert.equal(detail.objective, '雲を観察する。');
  assert.equal(detail.manualText, '雨天のため映像資料で確認');
});

test('long lesson details are divided before they overflow one page', () => {
  const long = '長い指導内容を具体的に記載する。'.repeat(12);
  const lessons = Array.from({ length: 8 }, () => ({
    objective: long,
    activity: long,
    assessment: long,
    note: '',
  }));

  const chunks = splitDetailLessons(lessons);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.flat().length, lessons.length);
});

test('senka detail print shares one unit overview across classes', () => {
  const state = defaultState();
  state.settings.mode = 'senka';
  state.settings.senkaSubject = 'rika';
  state.settings.senkaClasses = [
    { id: '5-1', label: '5年1組', grade: 5 },
    { id: '5-2', label: '5年2組', grade: 5 },
  ];
  state.plans.push({
    id: 'plan-rika-5',
    subjectKey: 'rika',
    grade: 5,
    units: [{
      id: 'unit-growth',
      name: '植物の発芽と成長',
      hours: 2,
      goal: '発芽と成長の条件を理解する。',
      criteria: { knowledge: '理解している。', thinking: '考察している。', attitude: '進んで取り組む。' },
      lessons: [
        { objective: '条件を予想する。', activity: '話し合う。', assessment: '予想を表現する。', viewpoint: '思' },
        { objective: '結果をまとめる。', activity: '比較する。', assessment: '関係付けている。', viewpoint: '知' },
      ],
    }],
  });
  addEntry(state, 0, 'p1', 'rika', '5-1');
  addEntry(state, 0, 'p2', 'rika', '5-2');

  const model = buildWeekPlanDetailModel(state, WEEK);
  const pages = renderPlanDetailPages(state, WEEK);

  assert.equal(model.length, 1);
  assert.deepEqual(model[0].scopes, ['5年1組', '5年2組']);
  assert.equal(model[0].lessons.length, 2);
  assert.equal(pages.length, 1);
  assert.match(pages[0], /5年1組/);
  assert.match(pages[0], /5年2組/);
  assert.match(pages[0], /詳細 1\/1/);
  assert.equal((pages[0].match(/単元の目標/g) || []).length, 1);
});

test('offplan cells do not consume the annual-plan progression counter', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.plans = [{
    id: 'pl', subjectKey: 'kokugo', grade: 4, startOffset: 0,
    units: [{
      id: 'u1', name: '物語', hours: 4, goal: '', criteria: { knowledge: '', thinking: '', attitude: '' },
      lessons: [
        { objective: 'L1', activity: '', assessment: '', viewpoint: '' },
        { objective: 'L2', activity: '', assessment: '', viewpoint: '' },
        { objective: 'L3', activity: '', assessment: '', viewpoint: '' },
        { objective: 'L4', activity: '', assessment: '', viewpoint: '' },
      ],
    }],
  }];
  addEntry(state, 0, 'p1', 'kokugo', null, { auto: true });
  addEntry(state, 1, 'p1', 'kokugo', null, { auto: true });
  addEntry(state, 2, 'p1', 'kokugo', null, { auto: true });
  const id = (d) => `${d}-p1-kokugo-`;

  let ords = computeOrdinals(state, WEEK);
  assert.equal(ords.get(id(0)), 0); // L1
  assert.equal(ords.get(id(1)), 1); // L2
  assert.equal(ords.get(id(2)), 2); // L3

  // 火曜を計画外にすると、カウンタを消費せず水曜が前にずれる(advance の効果が見える)
  state.weeks[WEEK].cells[cellKey(1, 'p1')].entries[0].offplan = true;
  ords = computeOrdinals(state, WEEK);
  assert.equal(ords.get(id(0)), 0);
  assert.equal(ords.has(id(1)), false); // 計画外はordinalsに含まれない
  assert.equal(ords.get(id(2)), 1);     // 水曜が L3→L2 にずれる

  // 計画外コマは resolveEntryPlanDetails で計画を引かない(本時が出ない)
  const offEntry = state.weeks[WEEK].cells[cellKey(1, 'p1')].entries[0];
  const { details } = resolveEntryPlanDetails(state, offEntry, ords);
  assert.equal(details, null); // override も無いので details なし
});

test('locked cells survive a destructive reapply (reset); unlocked user edits do not', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.baseTimetables = [{
    id: 'base-1', name: '基本', dayPatterns: {}, savedAt: 1,
    cells: {
      [cellKey(0, 'p1')]: { entries: [{ id: 'b0', subjectKey: 'kokugo', scope: null, fraction: 1, noCount: false, cancelled: false }] },
      [cellKey(1, 'p1')]: { entries: [{ id: 'b1', subjectKey: 'sansu', scope: null, fraction: 1, noCount: false, cancelled: false }] },
    },
  }];
  store.state = state;

  // まず基本時間割を週へ流し込む
  store.applyBaseTimetable(WEEK, 'base-1', { fillEmptyOnly: false, preserveEdits: true, commit: false });
  const week = store.state.weeks[WEEK];
  // 月曜=ロック＋手編集(中止)、火曜=手編集(中止)のみ
  week.cells[cellKey(0, 'p1')].entries[0].locked = true;
  week.cells[cellKey(0, 'p1')].entries[0].cancelled = true;
  week.cells[cellKey(1, 'p1')].entries[0].cancelled = true;

  // reset(まっさらに作り直す): ロックしたコマだけ守る
  store.applyBaseTimetable(WEEK, 'base-1', { fillEmptyOnly: false, preserveEdits: false, commit: false });
  const after = store.state.weeks[WEEK];

  // 月曜=ロックされていたので中身(中止指定)ごと残る
  assert.equal(cellHasLock(after.cells[cellKey(0, 'p1')]), true);
  assert.equal(after.cells[cellKey(0, 'p1')].entries[0].cancelled, true);
  // 火曜=ロックなしの手編集はresetで消える(計画どおりに作り直される)
  assert.equal(cellHasLock(after.cells[cellKey(1, 'p1')]), false);
  assert.equal(after.cells[cellKey(1, 'p1')].entries[0].cancelled, false);
});

test('activity (会議/委員会) entries survive flow-in and consume neither hours nor progression', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.plans = [{
    id: 'pl', subjectKey: 'kokugo', grade: 4, startOffset: 0,
    units: [{
      id: 'u1', name: '物語', hours: 3, goal: '', criteria: { knowledge: '', thinking: '', attitude: '' },
      lessons: [
        { objective: 'L1', activity: '', assessment: '', viewpoint: '' },
        { objective: 'L2', activity: '', assessment: '', viewpoint: '' },
        { objective: 'L3', activity: '', assessment: '', viewpoint: '' },
      ],
    }],
  }];
  state.baseTimetables = [{
    id: 'base-1', name: '基本', dayPatterns: {}, savedAt: 1,
    cells: {
      [cellKey(0, 'p1')]: { entries: [{ id: 'b0', subjectKey: 'kokugo', scope: null, fraction: 1, noCount: false, cancelled: false, auto: true }] },
      [cellKey(1, 'p1')]: { entries: [{ id: 'b1', subjectKey: 'kokugo', scope: null, fraction: 1, noCount: false, cancelled: false, auto: true }] },
    },
  }];
  store.state = state;

  // 火曜を「活動(会議)」にする = 教科なしのentry・占有
  state.weeks[WEEK] = state.weeks[WEEK] || { start: WEEK, cells: {}, events: [], dayNotes: [], attendance: [], dayPatterns: {}, goals: '', reflection: '' };
  state.weeks[WEEK].cells[cellKey(1, 'p1')] = { entries: [activityEntry('職員会議')] };

  // 空きを埋める(fill): 活動コマは埋め直されない、月曜だけ授業が入る
  store.applyBaseTimetable(WEEK, 'base-1', { fillEmptyOnly: true, commit: false });
  const w = store.state.weeks[WEEK];
  assert.equal(isActivity(w.cells[cellKey(1, 'p1')].entries[0]), true);
  assert.equal(w.cells[cellKey(1, 'p1')].entries[0].unitName, '職員会議');
  assert.equal(w.cells[cellKey(0, 'p1')].entries[0].subjectKey, 'kokugo'); // 月曜は埋まった

  // 進度: 活動コマは教科が無いので ordinals に現れず、カウンタも消費しない(月曜=L1)
  const ords = computeOrdinals(state, WEEK);
  const mondayId = w.cells[cellKey(0, 'p1')].entries[0].id;
  assert.equal(ords.get(mondayId), 0); // 月曜=L1
  assert.equal(ords.has(w.cells[cellKey(1, 'p1')].entries[0].id), false); // 火曜の活動は進度に出ない

  // reapply(計画どおりに作り直す)でも活動コマは「手で入れたもの」として残る
  store.applyBaseTimetable(WEEK, 'base-1', { fillEmptyOnly: false, preserveEdits: true, commit: false });
  assert.equal(isActivity(store.state.weeks[WEEK].cells[cellKey(1, 'p1')].entries[0]), true);
});

test('editing the objective does not auto-blank activity/assessment; explicit blanks persist', () => {
  const plan = { objective: 'O', activity: 'A', assessment: 'S', viewpoint: '知' };
  // ねらいだけ変更 → 学習活動・評価規準は計画のまま(自動空白を廃止)
  const m1 = mergeLessonOverride(plan, { objective: '新ねらい' });
  assert.equal(m1.objective, '新ねらい');
  assert.equal(m1.activity, 'A');
  assert.equal(m1.assessment, 'S');
  // 明示的に空にした項目は「白紙」のまま定着し、計画文へ自動では戻らない
  const m2 = mergeLessonOverride(plan, { activity: '' });
  assert.equal(m2.activity, '');
  assert.equal(m2.overridden.activity, true);
  // normalizeOverride は空文字を保持(=明示的な白紙)。キーを消すと計画へ復帰(=null)
  assert.deepEqual(normalizeOverride({ activity: '' }), { activity: '' });
  assert.equal(normalizeOverride({}), null);
});

test('a recurring meeting set in the base timetable flows into the week', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.baseTimetables = [{
    id: 'base-1', name: '基本', dayPatterns: {}, savedAt: 1,
    cells: {
      [cellKey(0, 'p1')]: { entries: [{ id: 'b0', subjectKey: 'kokugo', scope: null, fraction: 1, noCount: false, cancelled: false, auto: true }] },
      [cellKey(2, 'p3')]: { entries: [activityEntry('職員会議')] }, // 毎週水3校時=会議
    },
  }];
  store.state = state;

  // 空の週へ流し込む(自動材料化と同じ fillEmptyOnly)
  store.applyBaseTimetable(WEEK, 'base-1', { fillEmptyOnly: true, commit: false });
  const w = store.state.weeks[WEEK];
  // 会議の活動コマが週に入っている(教科なし・見出し保持)
  assert.equal(isActivity(w.cells[cellKey(2, 'p3')].entries[0]), true);
  assert.equal(w.cells[cellKey(2, 'p3')].entries[0].unitName, '職員会議');
  // 月曜の授業も入っている
  assert.equal(w.cells[cellKey(0, 'p1')].entries[0].subjectKey, 'kokugo');
});

test('migration converts an old blocked cell to a noCount activity entry', () => {
  // 旧データ: cell.blocked + note。persist→load(migrate) で活動entryへ移行されるはず
  const raw = { ...defaultState(), schemaVersion: 1 };
  raw.weeks = { [WEEK]: { start: WEEK, cells: { [cellKey(0, 'p1')]: { entries: [], blocked: true, note: '委員会' } }, events: [], dayNotes: [], attendance: [], dayPatterns: {}, goals: '', reflection: '' } };
  // store.state にセット → 一度 persist して migrate 経由で読み直す
  store.state = raw;
  store.persist();
  store.state = store.load();
  const cell = store.state.weeks[WEEK].cells[cellKey(0, 'p1')];
  assert.ok(cell, '移行後もコマが残る');
  assert.equal(isActivity(cell.entries[0]), true);
  assert.equal(cell.entries[0].unitName, '委員会');
  assert.equal(cell.entries[0].noCount, true);
  assert.equal('blocked' in cell, false); // セルからは撤廃
});

test('isEntryEdited treats pin/endUnit/fraction/guide/教科noCount as manual edits (protected on reapply)', () => {
  const base = { id: 'x', subjectKey: 'kokugo', scope: null, fraction: 1, noCount: false, cancelled: false, auto: true };
  assert.equal(isEntryEdited(base), false);                                   // 素の自動授業は未編集
  assert.equal(isEntryEdited({ ...base, pin: { unitId: 'u', nth: 1 } }), true); // 別単元の差し込み
  assert.equal(isEntryEdited({ ...base, endUnit: true }), true);              // 単元切り上げ
  assert.equal(isEntryEdited({ ...base, fraction: 0.5 }), true);              // 分数時数
  assert.equal(isEntryEdited({ ...base, guide: 'direct' }), true);           // 複式の指導形態
  assert.equal(isEntryEdited({ ...base, noCount: true }), true);             // 授業を時数外にした
});

test('reset keeps week-only activities (会議) even without a lock', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.baseTimetables = [{
    id: 'base-1', name: '基本', dayPatterns: {}, savedAt: 1,
    cells: { [cellKey(0, 'p1')]: { entries: [{ id: 'b0', subjectKey: 'kokugo', scope: null, fraction: 1, noCount: false, cancelled: false, auto: true }] } },
  }];
  store.state = state;
  // その週だけ手で入れた活動(基本時間割には無い)
  state.weeks[WEEK] = { start: WEEK, cells: { [cellKey(2, 'p3')]: { entries: [activityEntry('保護者面談')] } }, events: [], dayNotes: [], attendance: [], dayPatterns: {}, goals: '', reflection: '' };

  // reset(まっさらに作り直す): ロックが無くても活動は残す(UI・コメントの約束どおり)
  store.applyBaseTimetable(WEEK, 'base-1', { fillEmptyOnly: false, preserveEdits: false, commit: false });
  const w = store.state.weeks[WEEK];
  assert.equal(isActivity(w.cells[cellKey(2, 'p3')].entries[0]), true);
  assert.equal(w.cells[cellKey(2, 'p3')].entries[0].unitName, '保護者面談');
  assert.equal(w.cells[cellKey(0, 'p1')].entries[0].subjectKey, 'kokugo'); // 月曜は計画どおり作り直し
});

test('計画に合わせて更新: 設定済みは計画に戻す/空きは触らない/ロック・予定は守る', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.plans = [{
    id: 'pl', subjectKey: 'kokugo', grade: 4, startOffset: 0,
    units: [{ id: 'u1', name: '物語', hours: 5, goal: '', criteria: { knowledge: '', thinking: '', attitude: '' },
      lessons: [0,1,2,3,4].map(i => ({ objective: `L${i+1}`, activity: '', assessment: '', viewpoint: '' })) }],
  }];
  state.baseTimetables = [{ id: 'b', name: '基本', dayPatterns: {}, savedAt: 1, cells: {
    [cellKey(0,'p1')]: { entries: [{ id:'b0', subjectKey:'kokugo', scope:null, fraction:1, noCount:false, cancelled:false, auto:true }] },
    [cellKey(1,'p1')]: { entries: [{ id:'b1', subjectKey:'kokugo', scope:null, fraction:1, noCount:false, cancelled:false, auto:true }] },
    [cellKey(2,'p1')]: { entries: [{ id:'b2', subjectKey:'kokugo', scope:null, fraction:1, noCount:false, cancelled:false, auto:true }] },
  } }];
  store.state = state;
  store.applyBaseTimetable(WEEK, 'b', { fillEmptyOnly: true, commit: false }); // 骨組みを作る
  const w = store.state.weeks[WEEK];
  // 月=手編集(中止), 火=削除(空きに), 水=ロック, さらに木に予定を手で追加
  w.cells[cellKey(0,'p1')].entries[0].cancelled = true;
  w.cells[cellKey(0,'p1')].entries[0].override = { objective: '自前ねらい' };
  delete w.cells[cellKey(1,'p1')];
  w.cells[cellKey(2,'p1')].entries[0].locked = true;
  w.cells[cellKey(2,'p1')].entries[0].override = { objective: 'ロックねらい' };
  w.cells[cellKey(3,'p3')] = { entries: [activityEntry('学年会')] };

  const res = store.generateRange(WEEK, WEEK, 'b');

  const after = store.state.weeks[WEEK];
  // 月=手編集 → 計画に戻る(中止解除・override消滅)
  assert.equal(after.cells[cellKey(0,'p1')].entries[0].cancelled, false);
  assert.equal(after.cells[cellKey(0,'p1')].entries[0].override, null);
  // 火=削除した空きは戻らない(消したものは戻さない)
  assert.equal(after.cells[cellKey(1,'p1')], undefined);
  // 水=ロックは守られ、override も残る
  assert.equal(cellHasLock(after.cells[cellKey(2,'p1')]), true);
  assert.deepEqual(after.cells[cellKey(2,'p1')].entries[0].override, { objective: 'ロックねらい' });
  // 木=予定(会議)は守られる
  assert.equal(isActivity(after.cells[cellKey(3,'p3')].entries[0]), true);
  assert.ok(res.conformed >= 1 && res.kept >= 2);
});

test('conformEntryToPlan: 計画のある教科だけ戻す/計画なし手入力は守る', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.plans = [{ id:'pl', subjectKey:'kokugo', grade:4, startOffset:0, units:[{ id:'u', name:'U', hours:1, goal:'', criteria:{knowledge:'',thinking:'',attitude:''}, lessons:[{objective:'L1',activity:'',assessment:'',viewpoint:''}] }] }];
  store.state = state;
  const planned = { id:'a', subjectKey:'kokugo', scope:null, auto:true, override:{objective:'x'}, cancelled:true, fraction:0.5, noCount:false };
  const planless = { id:'b', subjectKey:'rika', scope:null, auto:true, override:{objective:'手入力'}, unitName:'実験', nth:1, unitHours:3, noCount:false };
  assert.equal(conformEntryToPlan(state, planned), true);   // 計画あり → 戻す
  assert.equal(planned.override, null);
  assert.equal(planned.cancelled, false);
  assert.equal(planned.fraction, 1);
  assert.equal(conformEntryToPlan(state, planless), false); // 計画なし → 触らない
  assert.deepEqual(planless.override, { objective: '手入力' });
  assert.equal(planless.unitName, '実験');
});

test('flow-in resets per-week implementation flags (endUnit/fraction) to auto defaults', () => {
  const state = defaultState();
  state.settings.grade = 4;
  state.baseTimetables = [{
    id: 'base-1', name: '基本', dayPatterns: {}, savedAt: 1,
    // 万一ひな形に週固有フラグが混じっても、流し込み時に自動既定へ戻す
    cells: { [cellKey(0, 'p1')]: { entries: [{ id: 'b0', subjectKey: 'kokugo', scope: null, fraction: 0.5, noCount: false, cancelled: false, auto: true, endUnit: true }] } },
  }];
  store.state = state;
  store.applyBaseTimetable(WEEK, 'base-1', { fillEmptyOnly: false, preserveEdits: false, commit: false });
  const e = store.state.weeks[WEEK].cells[cellKey(0, 'p1')].entries[0];
  assert.equal(e.endUnit, false);
  assert.equal(e.fraction, 1);
});
