/** アプリ本体: タブ切替・週ナビ状態・自動保存表示・印刷起動・PWA登録 */

import { store } from './store.js';
import { GasClient } from './gas.js';
import { renderWeekView } from './views/week.js';
import { renderPlansView } from './views/plans.js';
import { renderStatsView } from './views/stats.js';
import { renderSettingsView } from './views/settings.js';
import { renderDataView } from './views/data.js';
import { openPrintDialog, buildPrintDOM } from './print.js';
import { fmtDate, mondayOf, parseDate } from './utils.js';
import { toast, closeAllModals } from './ui.js';

const VIEWS = {
  week: renderWeekView,
  plans: renderPlansView,
  stats: renderStatsView,
  settings: renderSettingsView,
  data: renderDataView,
};

const ctx = {
  currentTab: 'week',
  weekStart: fmtDate(mondayOf(new Date())),
  swapSource: null,   // タップ入替モードの移動元 {day, period}
  gas: null,
  getWeekStart: () => ctx.weekStart,
  setWeekStart(dateStr) {
    ctx.weekStart = dateStr ? fmtDate(mondayOf(parseDate(dateStr))) : fmtDate(mondayOf(new Date()));
    ctx.swapSource = null;
    rerender();
  },
  rerender,
};
ctx.gas = new GasClient(() => store.settings.gas);

function rerender() {
  const main = document.getElementById('main');
  const view = VIEWS[ctx.currentTab] || renderWeekView;
  view(main, ctx);
}

// ---------------------------------------------------------------- タブ

document.getElementById('tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.tab');
  if (!btn) return;
  ctx.currentTab = btn.dataset.tab;
  ctx.swapSource = null;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
  rerender();
});

// ---------------------------------------------------------------- 印刷

document.getElementById('btn-print').addEventListener('click', () => openPrintDialog(ctx));

// Ctrl+P 直接印刷にも対応: 印刷直前に必ず最新の印刷DOMを組み立てる
window.addEventListener('beforeprint', () => {
  try { buildPrintDOM(ctx.weekStart); } catch (e) { console.error(e); }
});

// ---------------------------------------------------------------- 保存まわり

const indicator = document.getElementById('save-indicator');
let indicatorTimer = null;
store.subscribe(() => {
  indicator.classList.add('saving');
  indicator.title = '保存中…';
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => {
    indicator.classList.remove('saving');
    indicator.title = '保存済み ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }, 700);
});

// タブ非表示・ページ離脱時に即時保存(beforeunloadはモバイルで発火しないため使わない)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.persist();
});
window.addEventListener('pagehide', () => store.persist());

// 別タブでの変更を検知(last-write-wins消失防止)
window.addEventListener('storage', (ev) => {
  if (ev.key !== 'shuan-planner-data' || ev.newValue == null) return;
  try {
    const incoming = JSON.parse(ev.newValue);
    // 自タブの方が新しい変更を持っている場合は採用しない(次の自動保存で自タブ版が勝つ)
    if ((incoming.updatedAt || 0) < (store.state.updatedAt || 0)) return;
    // 開いているモーダルは旧stateのオブジェクトを参照しているため、必ず閉じてから差し替える
    closeAllModals();
    store.replaceState(incoming); // migrate(正規化)を通し、ローカルのGAS設定を維持
    rerender();
    toast('別のタブでの変更を読み込みました');
  } catch { /* 壊れた値は無視 */ }
});

// ストレージの永続化を要求(SafariのITP 7日間削除・容量逼迫時の自動削除への防御)
if (navigator.storage?.persist) {
  navigator.storage.persist().then(granted => {
    if (!granted) console.info('storage.persist: ブラウザに永続化が承認されませんでした(動作には影響なし)');
  }).catch(() => {});
}

// プライベートブラウジング等で保存できない環境の検知
try {
  localStorage.setItem('shuan-probe', '1');
  localStorage.removeItem('shuan-probe');
} catch {
  setTimeout(() => toast('⚠ このブラウザ環境ではデータを保存できません(プライベートモード?)。通常のウィンドウでご利用ください。', 'error', 8000), 500);
}

// ---------------------------------------------------------------- PWA

// localStorageに 'shuan-no-sw' を置くと登録をスキップできる(開発時のキャッシュ回避用)
if ('serviceWorker' in navigator
  && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  && !localStorage.getItem('shuan-no-sw')) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(e => console.info('SW登録スキップ:', e.message));
}

// ---------------------------------------------------------------- 初期描画

rerender();

// デバッグ・コンソール操作用フック(開発者ツールから状態を確認できる)
window.__shuan = { store, ctx, rerender };
