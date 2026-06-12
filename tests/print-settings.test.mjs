import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.document = { dispatchEvent() {} };

const {
  SCHEMA_VERSION,
  defaultSettings,
  store,
} = await import('../js/store.js');

test('new users get the standard A4 portrait weekly-plan preset', () => {
  const settings = defaultSettings('elementary');

  assert.equal(settings.printOrientation, 'portrait');
  assert.equal(settings.printLayout, 'periods');
  assert.equal(settings.printShowHours, true);
  assert.equal(settings.printPresetVersion, 2);
});

test('legacy untouched print defaults migrate to portrait once', () => {
  store.replaceState({
    schemaVersion: 1,
    updatedAt: 1,
    settings: {
      schoolType: 'elementary',
      printOrientation: 'landscape',
      printLayout: 'periods',
      printFontSize: 'normal',
      printShowTimes: false,
      printShowHours: true,
    },
    plans: [],
    weeks: {},
    baseTimetables: [],
  }, { keepLocalGas: false });

  assert.equal(store.state.schemaVersion, SCHEMA_VERSION);
  assert.equal(store.settings.printOrientation, 'portrait');
  assert.equal(store.settings.printPresetVersion, 2);
});

test('legacy users with customized print settings keep landscape', () => {
  store.replaceState({
    schemaVersion: 1,
    updatedAt: 1,
    settings: {
      schoolType: 'elementary',
      printOrientation: 'landscape',
      printLayout: 'periods',
      printFontSize: 'large',
      printShowTimes: true,
      printShowHours: true,
    },
    plans: [],
    weeks: {},
    baseTimetables: [],
  }, { keepLocalGas: false });

  assert.equal(store.settings.printOrientation, 'landscape');
  assert.equal(store.settings.printFontSize, 'large');
  assert.equal(store.settings.printShowTimes, true);
  assert.equal(store.settings.printPresetVersion, 2);
});
