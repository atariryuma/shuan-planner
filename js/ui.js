/** UIヘルパー: モーダル・トースト・確認ダイアログ */

import { esc } from './utils.js';

const modalLayer = () => document.getElementById('modal-layer');
const toastLayer = () => document.getElementById('toast-layer');

// 開いているモーダルのclose関数のレジストリ(他タブ同期などで一括クローズするため)
const openCloses = new Set();
let modalTitleSeq = 0;

/**
 * モーダルを開く。contentHTMLを差し込み、setupでイベントを配線する。
 * onClose は閉じ方(ボタン/Esc/背景クリック/closeAllModals)によらず必ず1回呼ばれる。
 * フォーカス管理: 開いたら最初のフォーカス可能要素へ移動し、Tabをモーダル内に
 * ループ(トラップ)、閉じたら開く前の要素へ戻す。戻り値: close関数。
 */
export function openModal(contentHTML, setup, onClose) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" tabindex="-1">${contentHTML}</div>`;
  const modal = backdrop.querySelector('.modal');
  // 見出し(h2)とダイアログを関連付ける(スクリーンリーダーに「何のダイアログか」を伝える)
  const h2 = modal.querySelector('h2');
  if (h2) {
    if (!h2.id) h2.id = `modal-title-${++modalTitleSeq}`;
    modal.setAttribute('aria-labelledby', h2.id);
  }
  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCloses.delete(close);
    document.removeEventListener('keydown', onKey);
    try { onClose?.(); } catch (e) { console.error(e); }
    backdrop.remove();
    // フォーカスを開く前の要素(トリガー)へ戻す
    if (prevFocus && document.contains(prevFocus) && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch { /* フォーカス不能でも支障なし */ }
    }
  };
  const focusables = () => [...modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )].filter(el => !el.disabled && el.offsetParent !== null);
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      // 多重モーダル時は最前面だけを閉じる(1回のEscで全部閉じると下の入力が失われる)
      if (backdrop !== modalLayer().lastElementChild) return;
      close();
      return;
    }
    if (ev.key !== 'Tab') return;
    // 多重モーダル時は最前面のモーダルだけがTabをトラップする
    if (backdrop !== modalLayer().lastElementChild) return;
    const els = focusables();
    if (!els.length) { ev.preventDefault(); modal.focus(); return; }
    const first = els[0];
    const last = els[els.length - 1];
    const inside = modal.contains(document.activeElement);
    if (ev.shiftKey && (!inside || document.activeElement === first)) {
      ev.preventDefault(); last.focus();
    } else if (!ev.shiftKey && (!inside || document.activeElement === last)) {
      ev.preventDefault(); first.focus();
    }
  };
  backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  modalLayer().appendChild(backdrop);
  openCloses.add(close);
  if (setup) setup(modal, close);
  associateLabels(modal); // ラベルと入力欄のプログラム関連付け(WCAG 1.3.1)
  // 初期フォーカス(setupの後: setupで中身を差し込むモーダルがあるため)
  if (!closed) {
    const els = focusables();
    (els[0] || modal).focus();
  }
  return close;
}

/** 開いているモーダルをすべて閉じる(各モーダルのonCloseも呼ばれる) */
export function closeAllModals() {
  [...openCloses].forEach(close => close());
}

// ---------------------------------------------------------------- ラベル関連付け

let fieldIdSeq = 0;

/**
 * <label>名前</label><input> 型の可視ラベルを入力欄へプログラム関連付けする
 * (WCAG 1.3.1 / 4.1.2)。for のない label に、同じ親要素内でラベルの後に現れる
 * 最初の入力欄を対象として連番idを振り for を付ける。ビュー描画・モーダル生成の
 * 直後に呼ぶ(委譲不可のため再描画ごとに必要)。
 */
export function associateLabels(scope) {
  scope.querySelectorAll('label:not([for])').forEach(label => {
    if (label.querySelector('input, select, textarea')) return; // ラップ型は関連付け済み
    const parent = label.parentElement;
    if (!parent) return;
    const target = [...parent.querySelectorAll('input, select, textarea')]
      .find(c => label.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!target) return;
    if (!target.id) target.id = `fld-${++fieldIdSeq}`;
    label.setAttribute('for', target.id);
  });
}

/**
 * トースト通知。action を渡すとボタン付き(例: 元に戻す)になる。
 * 文言は結果報告のみ・20字以内を原則とする(docs/ui-text-rules.md)。
 */
export function toast(msg, type = 'info', ms = 2600, action = null) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  if (type === 'error') el.setAttribute('role', 'alert'); // エラーは支援技術へ即時通知
  el.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => { el.remove(); action.onClick(); };
    el.appendChild(btn);
    ms = Math.max(ms, 8000);
  }
  toastLayer().appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

// ---------------------------------------------------------------- ⓘポップオーバー

let openPopover = null;
let openPopoverBtn = null; // 同じⓘの再タップで閉じる(開閉トグル)ための起点ボタン

/**
 * ⓘボタンのHTML。data-info属性に説明文を入れる。
 * タップで開閉・外側タップで閉じる(title属性はタッチで読めないため、必須説明はこちらを使う)。
 */
export function infoHTML(text) {
  return `<button type="button" class="info" data-info="${esc(text)}" aria-label="説明" aria-expanded="false">ⓘ</button>`;
}

/** ⓘポップオーバーの全体配線(アプリ起動時に1回呼ぶ。委譲方式なので再描画に強い) */
export function wireInfoPopovers() {
  const closePopover = () => {
    if (openPopover) { openPopover.remove(); openPopover = null; }
    if (openPopoverBtn) {
      openPopoverBtn.setAttribute('aria-expanded', 'false');
      openPopoverBtn.removeAttribute('aria-describedby');
      openPopoverBtn = null;
    }
  };
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.info[data-info]');
    const sameBtn = btn && btn === openPopoverBtn;
    closePopover();
    if (!btn || sameBtn) return; // 開いているⓘの再タップは閉じるだけ
    ev.preventDefault();
    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.id = 'info-popover';
    pop.setAttribute('role', 'status'); // 開いた説明をスクリーンリーダーへ通知
    pop.textContent = btn.dataset.info;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 12) + 'px';
    // 画面下端にかかるときは上側に出す(モーダル下部のⓘでも読める)
    const below = r.bottom + 6;
    if (below + pop.offsetHeight > window.innerHeight - 8) {
      pop.style.top = Math.max(8, r.top - pop.offsetHeight - 6) + window.scrollY + 'px';
    } else {
      pop.style.top = below + window.scrollY + 'px';
    }
    openPopover = pop;
    openPopoverBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-describedby', pop.id);
  });
  // Escでも閉じられるように(キーボード・スクリーンリーダー利用者)。
  // capture+stopPropagationで、ポップオーバーだけを閉じて下のモーダルまで閉じない
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !openPopover) return;
    ev.stopPropagation();
    closePopover();
  }, true);
  // スクロールで位置がずれたまま残らないよう閉じる(モーダル内スクロールも拾うためcapture)
  document.addEventListener('scroll', closePopover, true);
  window.addEventListener('wheel', closePopover, { passive: true });
}

/** confirm代替。Esc・背景クリックはキャンセル(false)として解決する */
export function confirmDialog(message, { okLabel = 'OK', danger = false, hint = '' } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openModal(`
      <h2>確認</h2>
      <p style="font-size:14px; line-height:1.7; white-space:pre-wrap;">${esc(message)}</p>
      ${hint ? `<p class="hint" style="margin-top:-2px;">${esc(hint)}</p>` : ''}
      <div class="modal-foot">
        <button class="btn" data-act="cancel">キャンセル</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okLabel)}</button>
      </div>
    `, (modal, close) => {
      modal.querySelector('[data-act="ok"]').onclick = () => { result = true; close(); };
      modal.querySelector('[data-act="cancel"]').onclick = () => close();
    }, () => resolve(result));
  });
}

/**
 * 処理結果のURLを開く。window.openがポップアップブロックされた場合は
 * リンク付きモーダルを出してユーザーのクリックで開けるようにする。
 */
export function openResultLink(url, label = '開く') {
  const win = window.open(url, '_blank');
  if (win) return;
  openModal(`
    <h2>書き出しが完了しました</h2>
    <p style="font-size:14px;">ブラウザにポップアップがブロックされました。下のリンクから開いてください。</p>
    <p><a href="${esc(url)}" target="_blank" rel="noopener" class="btn primary" style="display:inline-block; text-decoration:none;">${esc(label)}</a></p>
    <div class="modal-foot"><button class="btn primary" data-close>閉じる</button></div>
  `, (modal, close) => {
    modal.querySelector('[data-close]').onclick = close;
  });
}

/** select要素のHTMLを生成 */
export function selectHTML(name, options, value, { allowEmpty = null, attrs = '' } = {}) {
  const opts = [];
  if (allowEmpty !== null) opts.push(`<option value="">${esc(allowEmpty)}</option>`);
  for (const o of options) {
    const v = typeof o === 'object' ? o.value : o;
    const label = typeof o === 'object' ? o.label : o;
    opts.push(`<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(label)}</option>`);
  }
  return `<select name="${esc(name)}" ${attrs}>${opts.join('')}</select>`;
}
