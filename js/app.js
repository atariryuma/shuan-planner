/** アプリ本体: タブ切替・週ナビ状態・自動保存表示・印刷起動・PWA登録 */

import { store } from './store.js';
import { GasClient } from './gas.js';
import { renderWeekView } from './views/week.js';
import { renderPlansView } from './views/plans.js';
import { renderStatsView } from './views/stats.js';
import { renderSettingsView } from './views/settings.js';
import { renderDataView } from './views/data.js';
import { renderOnboarding, needsOnboarding } from './views/onboarding.js';
import { openPrintDialog, buildPrintDOM, buildStatsPrintDOM } from './print.js';
import { fmtDate, mondayOf, parseDate } from './utils.js';
import { toast, closeAllModals, wireInfoPopovers } from './ui.js';

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
  paint: { open: false, subject: null, scope: null }, // 連続入力モード
  lastScope: null,    // 専科: 直前に選んだ学級(次のコマの既定値)
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
  document.documentElement.classList.toggle('ui-large', store.settings.uiScale === 'large');
  if (needsOnboarding()) {
    document.querySelector('.topbar').style.display = 'none';
    renderOnboarding(main, ctx);
    return;
  }
  document.querySelector('.topbar').style.display = '';
  const view = VIEWS[ctx.currentTab] || renderWeekView;
  view(main, ctx);
}

// ---------------------------------------------------------------- タブ

document.getElementById('tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.tab');
  if (!btn) return;
  ctx.currentTab = btn.dataset.tab;
  ctx.swapSource = null;
  ctx.paint.subject = null; // タブ移動で連続入力モードを自動解除(誤配置防止)
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
  rerender();
});

// Escで連続入力・移動モードを解除
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (ctx.paint.subject || ctx.swapSource) {
    ctx.paint.subject = null;
    ctx.swapSource = null;
    rerender();
  }
});

// ---------------------------------------------------------------- 印刷

// 分割ボタン: 主ボタン=前回設定で即印刷 / ⚙=オプション
document.getElementById('btn-print').addEventListener('click', async () => {
  const { printWeek } = await import('./print.js');
  printWeek(ctx.weekStart);
});
document.getElementById('btn-print-opts').addEventListener('click', () => openPrintDialog(ctx));

// Ctrl+P 直接印刷にも対応: 表示中のタブに応じた印刷DOMを組み立てる
window.addEventListener('beforeprint', () => {
  try {
    if (ctx.currentTab === 'stats') buildStatsPrintDOM(ctx.weekStart);
    else buildPrintDOM(ctx.weekStart);
  } catch (e) { console.error(e); }
});

// ---------------------------------------------------------------- グローバル操作

// 「その他 ▾」メニューを外側クリックで閉じる(OS標準の挙動に揃える)
document.addEventListener('click', (ev) => {
  document.querySelectorAll('details.menu[open]').forEach(d => {
    if (!d.contains(ev.target)) d.removeAttribute('open');
  });
});

// Ctrl+Z / Cmd+Z で直前の破壊的操作を元に戻す(テキスト入力中はブラウザ標準に任せる)
document.addEventListener('keydown', (ev) => {
  if (!(ev.key === 'z' && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey)) return;
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (!store.canUndo) return;
  ev.preventDefault();
  closeAllModals(); // 開いているモーダルは旧stateを参照しているため先に閉じる
  const label = store.undo();
  if (label) { toast(`${label}を元に戻しました`); rerender(); }
});

// ---------------------------------------------------------------- 保存まわり

const indicator = document.getElementById('save-indicator');
let indicatorTimer = null;
store.subscribe(() => {
  indicator.textContent = '保存中…';
  indicator.classList.add('saving');
  clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => {
    indicator.classList.remove('saving');
    indicator.textContent = '✓ 保存済み';
  }, 700);
  // 初回入力時に一度だけ自動保存を知らせる(保存ボタンを探させない)
  if (!localStorage.getItem('shuan-save-hinted')) {
    localStorage.setItem('shuan-save-hinted', '1');
    toast('入力は自動で保存されます');
  }
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

wireInfoPopovers();
rerender();

// デバッグ・コンソール操作用フック(開発者ツールから状態を確認できる)
window.__shuan = { store, ctx, rerender };
