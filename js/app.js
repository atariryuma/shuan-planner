/** アプリ本体: タブ切替・週ナビ状態・自動保存表示・印刷起動・PWA登録 */

import { store, termRanges } from './store.js';
import { GasClient, decodeConnect } from './gas.js';
import { renderWeekView } from './views/week.js';
import { renderPlansView } from './views/plans.js';
import { renderStatsView } from './views/stats.js';
import { renderSettingsView } from './views/settings.js';
import { renderDataView } from './views/data.js';
import { renderOnboarding, needsOnboarding, maybeYearRollover } from './views/onboarding.js';
import { openPrintDialog, buildPrintDOM, buildStatsPrintDOM, printState } from './print.js';
import { fmtDate, mondayOf, parseDate, addDays, fiscalYearOf } from './utils.js';
import { icon } from './icons.js';
import { toast, closeAllModals, wireInfoPopovers, openModal, associateLabels } from './ui.js';

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
  lastScope: localStorage.getItem('shuan-last-scope') || null, // 専科: 直前に選んだ学級(再起動後も既定値に)
  gas: null,
  getWeekStart: () => ctx.weekStart,
  setWeekStart(dateStr) {
    ctx.weekStart = dateStr ? fmtDate(mondayOf(parseDate(dateStr))) : fmtDate(mondayOf(new Date()));
    // 移動(swapSource)は週をまたいで運べるよう、週移動では解除しない(解除はEsc/キャンセルボタン)
    rerender();
  },
  rerender,
};
ctx.gas = new GasClient(() => store.settings.gas);

/**
 * 再描画前のフォーカス位置を表す安定キーを作る。#main内の入力/選択要素が対象。
 * innerHTML差し替えでDOMが破棄されてもフォーカスを同じ欄へ戻すために使う(キーボード操作の連続性)。
 * 行の同定には親の data-* 行マーカー(data-p/data-s/data-c/data-b/data-day/data-term-m など)を用いる。
 */
function focusKeyOf(el) {
  if (!el || !document.getElementById('main')?.contains(el)) return null;
  const tag = el.tagName;
  if (!['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return null;
  const parts = [];
  if (el.id) parts.push(`#${el.id}`);
  const name = el.getAttribute('name');
  if (name) parts.push(`name=${name}`);
  // 行・列を一意にする祖先のdata-*属性を集める
  const rowAttrs = ['data-p', 'data-s', 'data-c', 'data-b', 'data-day', 'data-term-m', 'data-term-d', 'data-unit', 'data-pat', 'data-entry'];
  let node = el;
  while (node && node !== document.body) {
    for (const a of rowAttrs) {
      if (node.hasAttribute && node.hasAttribute(a)) parts.push(`${a}=${node.getAttribute(a)}`);
    }
    node = node.parentElement;
  }
  // data属性で直接同定する要素(set-chip以外のチェックボックス等)
  for (const a of ['data-set', 'data-gas', 'data-std', 'data-term']) {
    if (el.hasAttribute(a)) parts.push(`${a}=${el.getAttribute(a)}`);
  }
  return parts.length ? parts.join('|') : null;
}

/** focusKeyに一致する要素を#main内から探す(再描画後に呼ぶ) */
function findByFocusKey(key) {
  if (!key) return null;
  const main = document.getElementById('main');
  if (!main) return null;
  const cands = main.querySelectorAll('input, select, textarea, button');
  for (const el of cands) { if (focusKeyOf(el) === key) return el; }
  return null;
}

// 接続リンク(#connect=…)からの自動接続中フラグ。trueの間はオンボーディングの代わりに
// 「接続中…」を出す(新端末がデータ取得を終えるまで、空のセットアップ画面を見せない)。
let connecting = false;

function rerender() {
  const main = document.getElementById('main');
  document.documentElement.classList.toggle('ui-large', store.settings.uiScale === 'large');
  if (connecting) {
    document.querySelector('.topbar').style.display = 'none';
    main.innerHTML = `<div class="onboarding"><div class="ob-card">
      <div class="ob-logo">${icon('refresh')}</div><h1>他の端末と接続中…</h1>
      <p class="ob-sub">保存済みのデータを取得しています(数秒)</p></div></div>`;
    return;
  }
  if (needsOnboarding()) {
    document.querySelector('.topbar').style.display = 'none';
    renderOnboarding(main, ctx);
    return;
  }
  // 再描画でDOMが入れ替わってもフォーカスを同じ欄へ戻す(変更→再描画のたびに先頭へ飛ぶのを防ぐ)
  const prevKey = focusKeyOf(document.activeElement);
  const prevSel = (document.activeElement && 'selectionStart' in document.activeElement)
    ? document.activeElement.selectionStart : null;

  document.querySelector('.topbar').style.display = '';
  const view = VIEWS[ctx.currentTab] || renderWeekView;
  view(main, ctx);
  associateLabels(main); // ラベルと入力欄のプログラム関連付け(WCAG 1.3.1)

  if (prevKey) {
    const target = findByFocusKey(prevKey);
    if (target) {
      try {
        target.focus({ preventScroll: false });
        if (prevSel != null && 'setSelectionRange' in target && target.type !== 'number') {
          target.setSelectionRange(prevSel, prevSel);
        }
      } catch { /* フォーカス不能でも支障なし */ }
    }
  }
}

// ---------------------------------------------------------------- タブ

document.getElementById('tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.tab');
  if (!btn) return;
  ctx.currentTab = btn.dataset.tab;
  ctx.swapSource = null;
  ctx.paint.subject = null; // タブ移動で連続入力モードを自動解除(誤配置防止)
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t === btn);
    // 現在のタブを支援技術にも伝える(WCAG 4.1.2)
    if (t === btn) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  // 時数集計タブには印刷の追加設定がない: ⚙は無効化する
  // (押せるのに何も起きないコントロール・説明トーストを置かない)
  const printOpts = document.getElementById('btn-print-opts');
  const noOpts = ctx.currentTab === 'stats';
  printOpts.disabled = noOpts;
  printOpts.setAttribute('aria-disabled', String(noOpts));
  rerender();
  // タブ切替に控えめなフェード/スライド(Apple風。OSのモーション抑制は尊重)
  const main = document.getElementById('main');
  if (main && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && main.animate) {
    main.animate(
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)' }
    );
  }
});

// Escで連続入力・移動モードを終了(バーの「終了」ボタンと同じ挙動に揃える)。
// モーダルが開いているときはEscはモーダルを閉じる操作なので、連続入力は維持する
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (document.getElementById('modal-layer')?.childElementCount) return;
  if (ctx.paint.open || ctx.swapSource) {
    ctx.paint.open = false;
    ctx.paint.subject = null;
    ctx.swapSource = null;
    rerender();
  }
});

// ---------------------------------------------------------------- 印刷

// 分割ボタン: 主ボタン=前回設定で即印刷 / ⚙=オプション
// 時数集計タブでは集計表を印刷する(見ているものが印刷される、を裏切らない)
document.getElementById('btn-print').addEventListener('click', async () => {
  if (ctx.currentTab === 'stats') {
    buildStatsPrintDOM(ctx.weekStart);
    printState.prepared = true;
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    return;
  }
  const { printWeek } = await import('./print.js');
  printWeek(ctx.weekStart);
});
document.getElementById('btn-print-opts').addEventListener('click', () => {
  if (ctx.currentTab === 'stats') return; // statsタブではタブ切替時にdisabled(保険のガード)
  openPrintDialog(ctx);
});

// Ctrl+P 直接印刷にも対応: 表示中のタブに応じた印刷DOMを組み立てる。
// アプリ内ボタン経由(おたより・複数週など)は組み立て済みのため上書きしない。
window.addEventListener('beforeprint', () => {
  if (printState.prepared) return;
  try {
    if (ctx.currentTab === 'stats') buildStatsPrintDOM(ctx.weekStart);
    else buildPrintDOM(ctx.weekStart);
  } catch (e) { console.error(e); }
});
window.addEventListener('afterprint', () => { printState.prepared = false; });

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

// ←/→ で前後の週へ(週案タブのみ・入力中やモーダル表示中は無効)
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
  if (ctx.currentTab !== 'week') return;
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (document.getElementById('modal-layer')?.childElementCount) return;
  const btn = document.getElementById(ev.key === 'ArrowLeft' ? 'wk-prev' : 'wk-next');
  if (btn) { ev.preventDefault(); btn.click(); }
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
  // 自動保存の案内トーストは置かない(規約3: 結果報告でない教育文。保存インジケータが常時見える)
});

// タブ非表示・ページ離脱時に即時保存(beforeunloadはモバイルで発火しないため使わない)。
// 自動同期ONなら、閉じる直前に未送信の変更をsendBeaconで送る(編集→15秒以内に閉じても
// クラウドに上がる。fetchはunloadで中断されるためbeaconを使う)。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { store.persist(); beaconPush(); }
});
window.addEventListener('pagehide', () => { store.persist(); beaconPush(); });

// 同じ端末で複数タブを開いているときのタブ間整合(last-write-wins消失防止)。
// 同一ユーザーの同じデータを揃えるだけなので無音で行う(編集のたび通知が出ると煩い)。
// 入力中・モーダル操作中は中断しないよう、安定した瞬間にだけ適用する。
let crossTabTimer = null;
let crossTabPending = null;
window.addEventListener('storage', (ev) => {
  if (ev.key !== 'shuan-planner-data' || ev.newValue == null) return;
  crossTabPending = ev.newValue;
  clearTimeout(crossTabTimer);
  crossTabTimer = setTimeout(() => {
    const raw = crossTabPending; crossTabPending = null;
    try {
      const incoming = JSON.parse(raw);
      // 自タブの方が新しい変更を持っている場合は採用しない(次の自動保存で自タブ版が勝つ)
      if ((incoming.updatedAt || 0) <= (store.state.updatedAt || 0)) return;
      // 入力中・モーダル表示中は差し替えない(タイピングやダイアログ操作を壊さない)
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop')) return;
      store.replaceState(incoming, { mergeSettingsByTime: true }); // GAS設定維持＋設定は新しい側を採用
      rerender(); // 通知は出さない(タブ間の整合は裏方の動作)
    } catch { /* 壊れた値は無視 */ }
  }, 400); // 連続保存をまとめて1回だけ適用(通知も再描画も最小化)
});

// ストレージの永続化を要求(SafariのITP 7日間削除・容量逼迫時の自動削除への防御)
if (navigator.storage?.persist) {
  navigator.storage.persist().then(granted => {
    if (!granted) console.info('storage.persist: ブラウザに永続化が承認されませんでした(動作には影響なし)');
  }).catch(() => {});
}

// プライベートブラウジング等で保存できない環境の検知。
// 「入力が一切残らない」データ喪失級の警告のため、消えるトーストでなくモーダルで提示(loadErrorと同様式)
try {
  localStorage.setItem('shuan-probe', '1');
  localStorage.removeItem('shuan-probe');
} catch {
  setTimeout(() => {
    openModal(`
      <h2>保存できないブラウザです</h2>
      <p>プライベートモード等のため、入力した内容がこのブラウザに保存されません。<br>
        通常のウィンドウで開き直してからご利用ください。</p>
      <div class="modal-foot"><button class="btn primary" data-go>閉じる</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-go]').onclick = close;
    });
  }, 500);
}

/** 現在のデータをJSONファイルに書き出す(保存エラー時の救出用) */
function downloadStateJSON() {
  const blob = new Blob([JSON.stringify(store.state, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `週案バックアップ_${fmtDate(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// 保存失敗(容量不足など)はトーストで知らせ、その場でファイルに退避できるようにする
document.addEventListener('shuan-save-error', () => {
  toast('保存できません', 'error', 8000, { label: '書き出し', onClick: downloadStateJSON });
});
// 前回の保存失敗で退避していた未保存分を復元したとき、念のため知らせて再保存を試みる
if (store.recoveredUnsaved) {
  store.persist();
  toast('前回保存できなかった編集を復元しました', 'info', 6000);
}

// 起動時にデータが壊れていた場合: 退避データの保存手段を出してから続行してもらう
if (store.loadError) {
  setTimeout(() => {
    openModal(`
      <h2>データを読み込めませんでした</h2>
      <p>保存データが壊れている可能性があります。壊れたデータのコピーは自動で退避済みです。<br>
        念のためファイルにも保存してから続行してください。</p>
      <div class="modal-foot">
        <button class="btn" data-dump>退避を保存</button>
        <button class="btn primary" data-go>続行</button>
      </div>
    `, (modal, close) => {
      modal.querySelector('[data-dump]').onclick = () => {
        const keys = store.brokenBackups();
        const raw = keys.length ? localStorage.getItem(keys[0]) : JSON.stringify(store.state);
        const blob = new Blob([raw || '{}'], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `週案退避データ_${fmtDate(new Date())}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('退避データを保存しました');
      };
      modal.querySelector('[data-go]').onclick = close;
    });
  }, 300);
}

// ---------------------------------------------------------------- PWA

// localStorageに 'shuan-no-sw' を置くと登録をスキップできる(開発時のキャッシュ回避用)
if ('serviceWorker' in navigator
  && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  && !localStorage.getItem('shuan-no-sw')) {
  // 新しいSWが制御を取った瞬間に1回だけリロードして、全モジュールを新版で読み直す。
  // (古いモジュールが読み込まれた状態に、新版の動的importがぶつかる版混在=skewを防ぐ)
  let swReloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloading) return;
    swReloading = true;
    try { store.persist(); } catch { /* リロード前に未保存(デバウンス中)の変更を確実に書き出す */ }
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(e => console.info('SW登録スキップ:', e.message));
}

// ---------------------------------------------------------------- 年度の自動追従・自動同期

// 年度は現在日付から自動導出する(手動更新の二重管理を廃止)。
// 注意: updatedAtは進めない(進めると休眠端末の自動取得が止まり、古いデータで
// サーバーを上書きする事故につながる)。学年繰り上げ等のウィザードは
// autoPull完了後に出す(先にサーバーの新データを取り込んでから)。
const nowFY = fiscalYearOf(new Date());
const bootOldFY = store.settings.fiscalYear;
if (bootOldFY !== nowFY) {
  store.settings.fiscalYear = nowFY;
  store.persist(); // commitしない=updatedAt温存
}

// 自動同期(設定でONのとき): 起動時にサーバーの新しいデータを取得し、
// 編集後はアイドル15秒で自動送信する。競合時は上書きせず手動同期を案内。
const gotoDataTab = () => document.querySelector('.tab[data-tab="data"]')?.click();
let autoPushTimer = null;
let autoPushing = false;
let syncing = false;            // pull適用中のnotifyでautoPushを予約しない
let lastSyncedUpdatedAt = null; // 直近にサーバーと一致した時点のupdatedAt(冗長push防止)
let syncConflict = false;       // 未解決のconflict(別端末に新データ)。解決まで自動pushを止め、常時可視化する

// conflictを常時可視化(6秒で消えるトーストでなく、解決するまで出し続ける)。同期が無言で止まるのを防ぐ。
function notifyConflict() {
  if (syncConflict) return;     // 多重表示・15秒ごとの再送ループを止める
  syncConflict = true;
  toast('他の端末に新しいデータがあります。同期を止めています。「データ」画面で取り込めます（こちらの未送信の編集は保持されます）。',
    'error', 600000, { label: 'データを開く', onClick: gotoDataTab });
}
function clearConflict() { syncConflict = false; }

async function autoPull() {
  const g = store.settings.gas;
  if (connecting) return; // 接続リンクからの自動接続中は重複pullしない
  if (!g.auto || !ctx.gas.configured || !navigator.onLine) return;
  try {
    const baseAt = store.state.updatedAt || 0; // pull開始時点のローカル状態を記録
    const res = await ctx.gas.pull();
    if (!res.exists || (res.updatedAt || 0) <= baseAt) return;
    // pull中にユーザーが編集を始めていたら適用しない(入力消失・サイレント上書き防止)
    if ((store.state.updatedAt || 0) !== baseAt) {
      notifyConflict();
      return;
    }
    syncing = true;
    try {
      closeAllModals();
      store.replaceState(res.data, { mergeSettingsByTime: true }); // 設定は新しい側を採用(古い設定での巻き戻し防止)
      store.state.updatedAt = res.updatedAt;
      store.settings.fiscalYear = nowFY; // サーバー側が旧年度表示でもローカルで補正
      store.settings.gas.lastSync = Date.now();
      lastSyncedUpdatedAt = res.updatedAt;
      clearConflict();
      store.persist();
      rerender();
      toast('他の端末の変更を取得しました');
    } finally {
      syncing = false;
    }
  } catch (e) {
    console.info('自動取得スキップ:', e.message);
  }
}

// ページ離脱の直前に、未送信の変更をベストエフォートで送る。
// unload中はfetchが中断されるためsendBeaconを使う(応答は受け取れないが、サーバー側の
// 競合判定は生きているので、サーバーに新しいデータがあれば取りこぼし側で弾かれる=上書き事故にならない)。
function beaconPush() {
  try {
    const g = store.settings.gas;
    if (!g || !g.auto || !ctx.gas.configured || !navigator.sendBeacon) return;
    // 直近の同期以降に変更がなければ送らない(冗長送信の防止)
    if (lastSyncedUpdatedAt !== null && (store.state.updatedAt || 0) <= lastSyncedUpdatedAt) return;
    const url = String(g.url || '').trim();
    const token = g.token || '';
    if (!url || !token) return;
    const data = JSON.parse(JSON.stringify(store.state));
    if (data.settings?.gas) data.settings.gas.token = ''; // トークンは保存データに含めない
    const body = JSON.stringify({ token, action: 'push', key: 'default', data, updatedAt: store.state.updatedAt });
    // sendBeaconは容量超過(~64KB)等で false を返す。失敗時は lastSyncedUpdatedAt を進めず、
    // 次回起動・オンライン復帰時の autoPush で確実に再送されるようにする(離脱時の取りこぼし防止)。
    const ok = navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=utf-8' }));
    if (!ok) lastSyncedUpdatedAt = null;
  } catch { /* 離脱時のベストエフォート。失敗は無視 */ }
}

async function autoPush() {
  const g = store.settings.gas;
  if (!g.auto || !ctx.gas.configured) return;
  // オフライン・送信中は捨てずに再スケジュール(オンライン復帰後に追い付く)
  if (!navigator.onLine || autoPushing) {
    clearTimeout(autoPushTimer);
    autoPushTimer = setTimeout(autoPush, 15000);
    return;
  }
  if (syncConflict) return; // 未解決のconflict中は再送しない(同じconflictの繰り返しを止める)
  // 直近の同期以降に変更がなければ送らない(pull直後・手動送信直後の冗長push防止)
  if (lastSyncedUpdatedAt !== null && (store.state.updatedAt || 0) <= lastSyncedUpdatedAt) return;
  autoPushing = true;
  try {
    const res = await ctx.gas.push(store.state);
    if (res.conflict) {
      notifyConflict();
    } else {
      if (res.updatedAt) store.state.updatedAt = res.updatedAt;
      store.settings.gas.lastSync = Date.now();
      lastSyncedUpdatedAt = res.updatedAt || store.state.updatedAt;
      clearConflict();
      store.persist();
    }
  } catch (e) {
    console.info('自動保存スキップ:', e.message);
  } finally {
    autoPushing = false;
  }
}

store.subscribe(() => {
  if (syncing) return; // pull適用による通知では予約しない
  if (!store.settings.gas.auto || !ctx.gas.configured) return;
  clearTimeout(autoPushTimer);
  autoPushTimer = setTimeout(autoPush, 15000); // 編集が落ち着いてから送信
});
window.addEventListener('online', () => {
  clearConflict(); // 再接続時はconflict解決を試みる(まず最新を取り込み、その後送信)
  if (store.settings.gas.auto && ctx.gas.configured) { autoPull().then(autoPush); }
});
// データ画面で手動push/pullしてconflictを解決したら、自動同期を再開する
document.addEventListener('shuan-synced', () => { clearConflict(); lastSyncedUpdatedAt = store.state.updatedAt || 0; });

// 学期末の週に一度だけ「学期分まとめて印刷」を知らせる(提出時期の機能発見を助ける)
function maybeTermPrintHint() {
  if (needsOnboarding()) return;
  try {
    const s = store.settings;
    const monday = parseDate(ctx.weekStart);
    const terms = termRanges(s, s.fiscalYear);
    for (let i = 0; i < terms.length; i++) {
      const end = parseDate(terms[i].to);
      if (end >= monday && end < addDays(monday, 7)) {
        const key = `shuan-term-print-hint-${s.fiscalYear}-${i}`;
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, '1');
        toast('学期分をまとめて印刷できます', 'info', 6000, { label: '印刷設定', onClick: () => openPrintDialog(ctx) });
        return;
      }
    }
  } catch { /* ヒントは出なくても支障なし */ }
}

// 起動直後: 他端末の変更を取得 → その後に年度更新ウィザード(必要時)
setTimeout(async () => {
  await autoPull();
  if (nowFY > bootOldFY && !needsOnboarding()) maybeYearRollover(ctx, bootOldFY, nowFY);
  maybeTermPrintHint();
}, 800);

// ---------------------------------------------------------------- 新しい端末の自動接続(#connect=…)

/**
 * 接続リンクで開かれたら、接続先URL+合言葉を取り込んで自動で接続・データ取得・自動同期ONまで行う。
 * 新端末では「リンクを開くだけ」で同期が始まる(URLや合言葉を手入力しなくてよい)。
 */
function consumeConnectLink() {
  const m = /[#&]connect=([A-Za-z0-9\-_]+)/.exec(location.hash || '');
  if (!m) return;
  const creds = decodeConnect(m[1]);
  // 合言葉をアドレスバー・履歴に残さないよう、ハッシュは即座に消す
  history.replaceState(null, '', location.pathname + location.search);
  if (!creds) { toast('接続リンクが正しくありません', 'error', 5000); return; }
  connecting = true;
  rerender();
  (async () => {
    // 接続先を先に設定(replaceStateのkeepLocalGasがこの値を保持する)
    store.settings.gas.url = creds.u;
    store.settings.gas.token = creds.t;
    store.settings.gas.auto = true;
    try {
      await ctx.gas.ping();
      const res = await ctx.gas.pull();
      if (res.exists) {
        closeAllModals();
        store.replaceState(res.data); // GAS設定(URL・合言葉・auto)はローカル=今セットした値を維持
        store.state.updatedAt = res.updatedAt || store.state.updatedAt;
      }
      // サーバー側が空でも、設定した接続情報は確実に残す
      store.settings.gas.url = creds.u;
      store.settings.gas.token = creds.t;
      store.settings.gas.auto = true;
      store.settings.gas.lastSync = Date.now();
      lastSyncedUpdatedAt = store.state.updatedAt;
      store.persist();
      connecting = false;
      rerender();
      toast(res.exists ? 'この端末を接続しました(データ取得済み)' : 'この端末を接続しました', 'info', 5000);
    } catch (e) {
      connecting = false;
      store.persist();
      rerender();
      toast('接続できませんでした: ' + e.message, 'error', 8000, { label: '設定を開く', onClick: () => document.querySelector('.tab[data-tab="settings"]')?.click() });
    }
  })();
}

// ---------------------------------------------------------------- 初期描画

wireInfoPopovers();
consumeConnectLink(); // 接続リンクで開かれた場合は接続中画面に切り替える
// 既に開いているタブのアドレスバーへ接続リンクを貼られた場合(ハッシュのみ変化=再読込なし)にも対応
window.addEventListener('hashchange', consumeConnectLink);
rerender();

// デバッグ・コンソール操作用フック(開発者ツールから状態を確認できる)
window.__shuan = { store, ctx, rerender };
