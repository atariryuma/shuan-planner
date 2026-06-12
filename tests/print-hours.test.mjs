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

const { defaultState, cellKey } = await import('../js/store.js');
const { buildPrintHoursModel, capSubjectColumns } = await import('../js/print-hours.js');
const { renderWeeklyHoursBox } = await import('../js/print.js');

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
