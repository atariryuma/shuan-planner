/** 週案印刷用の時数集計モデル。DOMに依存せず、役割別の表データを作る。 */

import { computeHours, fmtHours, scopeKey, standardHoursFor } from './store.js';

function subjectTree(settings) {
  const keys = new Set(settings.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of settings.subjects) {
    if (subj.parent && keys.has(subj.parent)) {
      (childrenOf[subj.parent] ||= []).push(subj.key);
    }
  }
  return { keys, childrenOf };
}

function valuesFor(hours, settings, childrenOf, subj, scopes, grade) {
  let week = 0;
  let total = 0;
  for (const key of [subj.key, ...(childrenOf[subj.key] || [])]) {
    for (const scope of scopes) {
      const value = hours.get(scopeKey(key, scope));
      if (value) {
        week += value.week;
        total += value.total;
      }
    }
  }
  const standard = grade == null ? null : standardHoursFor(settings, subj.key, grade);
  return {
    key: subj.key,
    label: subj.short || subj.name,
    name: subj.name,
    week,
    total,
    standard,
    remain: standard == null ? null : standard - total,
    progress: standard ? Math.round(total / standard * 100) : null,
  };
}

function rootSubjects(settings, keys) {
  return settings.subjects.filter(subj => !(subj.parent && keys.has(subj.parent)));
}

function sumItems(items) {
  const sumNullable = (field) => {
    const values = items.map(item => item[field]).filter(value => value != null);
    return values.length ? values.reduce((a, value) => a + value, 0) : null;
  };
  const standard = sumNullable('standard');
  const total = items.reduce((a, item) => a + item.total, 0);
  return {
    key: 'total',
    label: '合計',
    name: '合計',
    week: items.reduce((a, item) => a + item.week, 0),
    total,
    standard,
    remain: standard == null ? null : standard - total,
    progress: standard ? Math.round(total / standard * 100) : null,
  };
}

/** 教科列が多い場合、累計の少ない教科を「ほか」にまとめる。合計列は常に末尾。 */
export function capSubjectColumns(items, maxSubjects) {
  if (!items.length) return [];
  if (items.length <= maxSubjects) return [...items, sumItems(items)];
  const ranked = [...items].sort((a, b) => b.total - a.total || b.week - a.week);
  const keepKeys = new Set(ranked.slice(0, maxSubjects - 1).map(item => item.key));
  const kept = items.filter(item => keepKeys.has(item.key));
  const rest = items.filter(item => !keepKeys.has(item.key));
  const other = sumItems(rest);
  other.key = 'other';
  other.label = 'ほか';
  other.name = 'ほか';
  return [...kept, other, sumItems(items)];
}

function subjectItems(hours, settings, childrenOf, keys, scopes, grade) {
  return rootSubjects(settings, keys)
    .map(subj => valuesFor(hours, settings, childrenOf, subj, scopes, grade))
    // 学級担任・複式の週案では、今週0時間でも標準時数のある教科は欄を残す。
    // 毎週列が出入りすると紙の週案を比較しにくく、未計画教科も見落とすため。
    .filter(item => item.week > 0 || item.total > 0 || item.standard != null);
}

/**
 * 戻り値:
 * - homeroom: { kind, items[] }
 * - fukushiki: { kind, grades:[{grade, items[]}] }
 * - senka: { kind, rows:[{classLabel, grade, ...時数}] }
 */
export function buildPrintHoursModel(state, weekStart, { maxSubjects = 12 } = {}) {
  const settings = state.settings;
  const hours = computeHours(state, weekStart);
  const { keys, childrenOf } = subjectTree(settings);

  if (settings.mode === 'fukushiki') {
    return {
      kind: 'fukushiki',
      grades: settings.fukushikiGrades.map(grade => ({
        grade,
        items: capSubjectColumns(
          subjectItems(hours, settings, childrenOf, keys, [grade], grade),
          maxSubjects,
        ),
      })),
    };
  }

  if (settings.mode === 'senka') {
    const subjects = rootSubjects(settings, keys);
    const preferred = settings.senkaSubject
      ? subjects.filter(subj => subj.key === settings.senkaSubject)
      : subjects;
    const keepConfiguredClasses = Boolean(settings.senkaSubject);
    const rows = [];
    for (const cls of settings.senkaClasses) {
      for (const subj of preferred) {
        const value = valuesFor(hours, settings, childrenOf, subj, [cls.id], cls.grade);
        // 担当教科が設定済みなら0時間の学級も残し、未計画・入力漏れを紙面で発見できるようにする。
        if (keepConfiguredClasses || value.week > 0 || value.total > 0) {
          rows.push({
            classLabel: cls.label || `${cls.grade}年`,
            grade: cls.grade,
            subjectLabel: subj.short || subj.name,
            ...value,
          });
        }
      }
    }
    // 学級未設定の授業は捨てず、標準比較なしの警告行として出す。
    for (const subj of preferred) {
      const value = valuesFor(hours, settings, childrenOf, subj, [null], null);
      if (value.week > 0 || value.total > 0) {
        rows.push({
          classLabel: '学級未設定',
          grade: null,
          subjectLabel: subj.short || subj.name,
          ...value,
        });
      }
    }
    return { kind: 'senka', rows };
  }

  return {
    kind: 'homeroom',
    items: capSubjectColumns(
      subjectItems(hours, settings, childrenOf, keys, [null], settings.grade),
      maxSubjects,
    ),
  };
}

export function printHoursValue(item, field) {
  if (field === 'progress') return item.progress == null ? '' : `${item.progress}%`;
  const value = item[field];
  return value == null ? '' : fmtHours(value);
}
