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

const { defaultState, cellKey, computeOrdinals, resolveEntryPlanDetails } = await import('../js/store.js');
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
