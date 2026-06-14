/**
 * モノクロのライン・アイコン(SF Symbols風)。
 * すべて viewBox 0 0 24 24・stroke=currentColor の線画で、文字色に追従する。
 * 使い方: icon('calendar') が <svg> 文字列を返す。サイズは CSS の .ic で調整。
 */

const PATHS = {
  // ナビ/タブ
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/>',
  layers: '<path d="M12 3.5 3 8l9 4.5L21 8 12 3.5Z"/><path d="M3.4 12.4 12 16.9l8.6-4.5M3.4 16 12 20.5 20.6 16"/>',
  chart: '<path d="M4.5 20V11M12 20V4M19.5 20v-6"/><path d="M3 20.5h18"/>',
  sliders: '<path d="M4 7h7"/><path d="M17 7h3"/><circle cx="14" cy="7" r="2.3"/><path d="M4 12h5"/><path d="M15 12h5"/><circle cx="12" cy="12" r="2.3"/><path d="M4 17h9"/><path d="M19 17h1"/><circle cx="16" cy="17" r="2.3"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',

  // 設定カテゴリ
  school: '<path d="M3.5 20.5h17M5 20.5V10l7-4.5 7 4.5v10.5M10 20.5v-5h4v5"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  swatches: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  printer: '<path d="M7 8.5V3.5h10v5"/><path d="M7 18H5.5a2 2 0 0 1-2-2v-3.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2H17"/><rect x="7" y="14.5" width="10" height="6" rx="1"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.96 5.5 5.5 0 0 0-10.6-1.2A4.2 4.2 0 0 0 7 18.5Z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8h.01"/>',
  warning: '<path d="M12 4 2.5 20.5h19L12 4Z"/><path d="M12 10v4.5M12 17.5h.01"/>',

  // 操作
  clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 5.5V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5v1Z"/><path d="M8.5 11h7M8.5 14.5h5"/>',
  flag: '<path d="M5.5 21V4"/><path d="M5.5 4.5S7 3.5 9.5 3.5s4 2 6.5 2 3.5-1 3.5-1v8.5s-1 1-3.5 1-4-2-6.5-2-3.5 1-3.5 1"/>',
  doc: '<path d="M6 3.5h7l5 5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M13 3.5V9h5M8.5 13h7M8.5 16.5h7"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M4 7.5l8 5.5 8-5.5"/>',
  trash: '<path d="M4.5 6.5h15M9 6.5V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 6.5l.9 13a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6.2 6.2l11.6 11.6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2"/>',
  memo: '<rect x="4.5" y="4" width="15" height="16" rx="2"/><path d="M8 9h8M8 12.5h8M8 16h5"/>',
  stop: '<path d="M8.3 3.5h7.4l5.3 5.3v7.4l-5.3 5.3H8.3L3 16.2V8.8Z"/>',
  pencil: '<path d="M16.5 4 20 7.5 8.5 19l-4 1 1-4L16.5 4Z"/><path d="M14.5 6 18 9.5"/>',
  download: '<path d="M12 3.5v11M7.5 10 12 14.5 16.5 10M5 19.5h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6 6.5L3.5 9M4 13a8 8 0 0 0 14 4.5L20.5 15"/><path d="M3.5 4.5V9H8M20.5 19.5V15H16"/>',
  undo: '<path d="M9 7 4.5 11.5 9 16"/><path d="M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-2.5"/>',

  // 空状態・装飾
  book: '<path d="M5 4.5h9a2.5 2.5 0 0 1 2.5 2.5v13H7.5A2.5 2.5 0 0 1 5 17.5V4.5Z"/><path d="M16.5 7H19v13H9.5"/>',
  cup: '<path d="M5 8.5h12v4.5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8.5Z"/><path d="M17 9.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5s-.5 1 0 2M11.5 3.5s-.5 1 0 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M21.5 12H19M5 12H2.5M18.4 5.6 16.6 7.4M7.4 16.6 5.6 18.4M18.4 18.4 16.6 16.6M7.4 7.4 5.6 5.6"/>',
  leaf: '<path d="M5 19s-1-9 6-13c4-2.3 8-1 8-1s1 4-1 8c-4 7-13 6-13 6Z"/><path d="M8 16c3-5 6-7 9-8"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}
