/** UIヘルパー: モーダル・トースト・確認ダイアログ */

import { esc } from './utils.js';

const modalLayer = () => document.getElementById('modal-layer');
const toastLayer = () => document.getElementById('toast-layer');

// 開いているモーダルのclose関数のレジストリ(他タブ同期などで一括クローズするため)
const openCloses = new Set();

/**
 * モーダルを開く。contentHTMLを差し込み、setupでイベントを配線する。
 * onClose は閉じ方(ボタン/Esc/背景クリック/closeAllModals)によらず必ず1回呼ばれる。
 * 戻り値: close関数。
 */
export function openModal(contentHTML, setup, onClose) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal" role="dialog">${contentHTML}</div>`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCloses.delete(close);
    document.removeEventListener('keydown', onKey);
    try { onClose?.(); } catch (e) { console.error(e); }
    backdrop.remove();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  modalLayer().appendChild(backdrop);
  openCloses.add(close);
  if (setup) setup(backdrop.querySelector('.modal'), close);
  return close;
}

/** 開いているモーダルをすべて閉じる(各モーダルのonCloseも呼ばれる) */
export function closeAllModals() {
  [...openCloses].forEach(close => close());
}

export function toast(msg, type = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = msg;
  toastLayer().appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/** confirm代替。Esc・背景クリックはキャンセル(false)として解決する */
export function confirmDialog(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openModal(`
      <h2>確認</h2>
      <p style="font-size:14px; line-height:1.7; white-space:pre-wrap;">${esc(message)}</p>
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
    <div class="modal-foot"><button class="btn" data-close>閉じる</button></div>
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
