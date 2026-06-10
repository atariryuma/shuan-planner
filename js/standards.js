/**
 * 標準授業時数(学校教育法施行規則 別表第一・別表第二)と教科プリセット。
 * 数値は年間の標準授業時数(1単位時間 = 小学校45分 / 中学校50分)。
 */

export const SCHOOL_TYPES = {
  elementary: '小学校',
  junior: '中学校',
};

// 小学校 別表第一(平成29年改訂・令和2年度全面実施)
export const ELEMENTARY_STANDARD_HOURS = {
  // subjectKey: [1年, 2年, 3年, 4年, 5年, 6年]  (null = 設定なし)
  kokugo:   [306, 315, 245, 245, 175, 175],
  shakai:   [null, null, 70, 90, 100, 105],
  sansu:    [136, 175, 175, 175, 175, 175],
  rika:     [null, null, 90, 105, 105, 105],
  seikatsu: [102, 105, null, null, null, null],
  ongaku:   [68, 70, 60, 60, 50, 50],
  zuko:     [68, 70, 60, 60, 50, 50],
  katei:    [null, null, null, null, 60, 55],
  taiiku:   [102, 105, 105, 105, 90, 90],
  gaikokugo: [null, null, null, null, 70, 70],
  dotoku:   [34, 35, 35, 35, 35, 35],
  gaikokugokatsudo: [null, null, 35, 35, null, null],
  sogo:     [null, null, 70, 70, 70, 70],
  tokkatsu: [34, 35, 35, 35, 35, 35],
};

export const ELEMENTARY_TOTAL_HOURS = [850, 910, 980, 1015, 1015, 1015];

// 中学校 別表第二
export const JUNIOR_STANDARD_HOURS = {
  // subjectKey: [1年, 2年, 3年]
  kokugo:  [140, 140, 105],
  shakai:  [105, 105, 140],
  sugaku:  [140, 105, 140],
  rika:    [105, 140, 140],
  ongaku:  [45, 35, 35],
  bijutsu: [45, 35, 35],
  hotai:   [105, 105, 105],
  gika:    [70, 70, 35],
  gaikokugo: [140, 140, 140],
  dotoku:  [35, 35, 35],
  sogo:    [50, 70, 70],
  tokkatsu: [35, 35, 35],
};

export const JUNIOR_TOTAL_HOURS = [1015, 1015, 1015];

// 教科プリセット(表示名・略称・印刷時にも使う色)
export const ELEMENTARY_SUBJECTS = [
  { key: 'kokugo',   name: '国語',           short: '国', color: '#e8505b' },
  { key: 'shosha',   name: '書写',           short: '書', color: '#d4756b', parent: 'kokugo' },
  { key: 'shakai',   name: '社会',           short: '社', color: '#f08a24' },
  { key: 'sansu',    name: '算数',           short: '算', color: '#1f7ac2' },
  { key: 'rika',     name: '理科',           short: '理', color: '#2ba84a' },
  { key: 'seikatsu', name: '生活',           short: '生', color: '#7fb069' },
  { key: 'ongaku',   name: '音楽',           short: '音', color: '#b86bc9' },
  { key: 'zuko',     name: '図画工作',       short: '図', color: '#e85f99' },
  { key: 'katei',    name: '家庭',           short: '家', color: '#c2913a' },
  { key: 'taiiku',   name: '体育',           short: '体', color: '#16a3a5' },
  { key: 'hoken',    name: '保健',           short: '保', color: '#3aa6a8', parent: 'taiiku' },
  { key: 'gaikokugo', name: '外国語',        short: '外', color: '#6577d6' },
  { key: 'gaikokugokatsudo', name: '外国語活動', short: '外活', color: '#8a93dd' },
  { key: 'dotoku',   name: '道徳',           short: '道', color: '#8d6e63' },
  { key: 'sogo',     name: '総合的な学習の時間', short: '総', color: '#5d8aa8' },
  { key: 'tokkatsu', name: '特別活動',       short: '特活', color: '#9aa05e' },
  { key: 'gakkatsu', name: '学級活動',       short: '学活', color: '#a3a86b', parent: 'tokkatsu' },
  { key: 'gyoji',    name: '学校行事',       short: '行事', color: '#888888' },
  { key: 'module',   name: 'モジュール学習', short: 'モ', color: '#64748b' },
  { key: 'sonota',   name: 'その他',         short: '他', color: '#999999' },
];

export const JUNIOR_SUBJECTS = [
  { key: 'kokugo',  name: '国語',     short: '国', color: '#e8505b' },
  { key: 'shakai',  name: '社会',     short: '社', color: '#f08a24' },
  { key: 'sugaku',  name: '数学',     short: '数', color: '#1f7ac2' },
  { key: 'rika',    name: '理科',     short: '理', color: '#2ba84a' },
  { key: 'ongaku',  name: '音楽',     short: '音', color: '#b86bc9' },
  { key: 'bijutsu', name: '美術',     short: '美', color: '#e85f99' },
  { key: 'hotai',   name: '保健体育', short: '保体', color: '#16a3a5' },
  { key: 'gika',    name: '技術・家庭', short: '技家', color: '#c2913a' },
  { key: 'gaikokugo', name: '外国語(英語)', short: '英', color: '#6577d6' },
  { key: 'dotoku',  name: '道徳',     short: '道', color: '#8d6e63' },
  { key: 'sogo',    name: '総合的な学習の時間', short: '総', color: '#5d8aa8' },
  { key: 'tokkatsu', name: '特別活動', short: '特活', color: '#9aa05e' },
  { key: 'gyoji',   name: '学校行事', short: '行事', color: '#888888' },
  { key: 'sonota',  name: 'その他',   short: '他', color: '#999999' },
];

/** 学年に応じた標準時数を返す(grade: 1始まり)。設定が無い教科は null。 */
export function getStandardHours(schoolType, subjectKey, grade) {
  const table = schoolType === 'junior' ? JUNIOR_STANDARD_HOURS : ELEMENTARY_STANDARD_HOURS;
  const row = table[subjectKey];
  if (!row) return null;
  return row[grade - 1] ?? null;
}

export function getSubjectPresets(schoolType) {
  return schoolType === 'junior' ? JUNIOR_SUBJECTS : ELEMENTARY_SUBJECTS;
}
