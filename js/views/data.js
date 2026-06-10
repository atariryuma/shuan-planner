/** データ管理ビュー: JSONバックアップ・復元・GAS同期・初期化 */

import { store } from '../store.js';
import { toast, confirmDialog, openModal } from '../ui.js';
import { esc, fmtDate } from '../utils.js';

export function renderDataView(root, ctx) {
  const state = store.state;
  const weekCount = Object.keys(state.weeks).length;
  const planCount = state.plans.length;
  const bytes = new Blob([JSON.stringify(state)]).size;
  const lastSync = state.settings.gas.lastSync;

  root.innerHTML = `
    <div class="settings-grid">
      <div class="panel">
        <h2>バックアップ(JSONファイル)</h2>
        <p class="hint">
          データはこの端末のブラウザ(localStorage)に自動保存されています。<br>
          <b>現在: ${weekCount}週分の週案 / ${planCount}件の年間指導計画 / 約${(bytes / 1024).toFixed(0)}KB</b><br>
          ブラウザのデータ消去や端末の変更に備えて、<b>長期休業の前など定期的にエクスポート</b>してください。
        </p>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn primary" id="data-export">⬇ エクスポート(保存)</button>
          <label class="btn" style="display:inline-block; cursor:pointer;">
            ⬆ インポート(復元)<input type="file" id="data-import" accept=".json" style="display:none;">
          </label>
        </div>
      </div>

      <div class="panel">
        <h2>Google同期(GAS)</h2>
        <p class="hint">
          設定画面でGAS連携を設定すると、全データをGoogleスプレッドシートに保存して端末間で共有できます。<br>
          ${lastSync ? `最終同期: ${new Date(lastSync).toLocaleString('ja-JP')}` : 'まだ同期していません。'}
        </p>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn primary" id="gas-push" ${ctx.gas.configured ? '' : 'disabled'}>☁⬆ サーバーへ送信</button>
          <button class="btn" id="gas-pull" ${ctx.gas.configured ? '' : 'disabled'}>☁⬇ サーバーから取得</button>
        </div>
        ${ctx.gas.configured ? '' : '<p class="hint" style="margin-top:8px;">→ 「設定」タブでGASのURLとトークンを入力すると使えます。</p>'}
      </div>

      <div class="panel">
        <h2>このアプリについて</h2>
        <p class="hint" style="font-size:13px;">
          <b>週案プランナー</b> — 小・中学校教員のための週指導計画作成ツール。<br>
          ・データはすべて<b>この端末のブラウザ内</b>に保存されます(サーバーには送信されません。GAS同期を設定した場合のみ、自分のGoogleアカウントへ送信)。<br>
          ・児童生徒の個人名は入力せず、イニシャル等での運用をおすすめします。<br>
          ・印刷は Chrome / Edge を推奨します。<br>
          ・標準授業時数は学校教育法施行規則 別表第一・第二(現行学習指導要領)に基づきます。
        </p>
      </div>

      <div class="panel">
        <h2 style="color:var(--danger)">危険な操作</h2>
        <p class="hint">すべての週案・計画・設定を削除して初期状態に戻します。実行前に自動でエクスポートを促します。</p>
        <button class="btn danger" id="data-reset">全データを消去して初期化</button>
      </div>
    </div>
  `;

  root.querySelector('#data-export').onclick = () => exportJSON();

  root.querySelector('#data-import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.settings || !('weeks' in data)) throw new Error('週案アプリのバックアップファイルではありません');
      const wc = Object.keys(data.weeks || {}).length;
      const pc = (data.plans || []).length;
      const ok = await confirmDialog(
        `このファイルには ${wc}週分の週案 と ${pc}件の年間指導計画 が含まれています。\n\n現在のデータ(${Object.keys(store.state.weeks).length}週分)をすべて置き換えます。よろしいですか?`,
        { okLabel: '置き換えて復元', danger: true });
      if (!ok) return;
      store.importJSON(text);
      toast('復元しました');
      ctx.rerender();
    } catch (e) {
      toast('インポート失敗: ' + e.message, 'error', 5000);
    } finally {
      ev.target.value = '';
    }
  });

  root.querySelector('#gas-push').onclick = async () => {
    try {
      toast('送信中…(数秒かかります)');
      let res = await ctx.gas.push(store.state);
      if (res.conflict) {
        const ok = await confirmDialog(
          `サーバーには別の端末から保存された新しいデータがあります。\nサーバー: ${new Date(res.serverUpdatedAt).toLocaleString('ja-JP')}\n\nこの端末の内容で上書きしますか?`,
          { okLabel: '上書き送信', danger: true });
        if (!ok) return;
        res = await ctx.gas.push(store.state, { force: true });
      }
      // サーバーが確定したupdatedAtに揃える(commitで進めると、直後のpullで
      // 「この端末の方が新しい」という誤警告が出るため)
      if (res.updatedAt) store.state.updatedAt = res.updatedAt;
      store.settings.gas.lastSync = Date.now();
      store.persist();
      store.notify();
      toast('✅ サーバーへ保存しました');
      ctx.rerender();
    } catch (e) {
      toast('送信失敗: ' + e.message, 'error', 6000);
    }
  };

  root.querySelector('#gas-pull').onclick = async () => {
    try {
      toast('取得中…(数秒かかります)');
      const res = await ctx.gas.pull();
      if (!res.exists) { toast('サーバーにはまだデータがありません'); return; }
      const wc = Object.keys(res.data.weeks || {}).length;
      const newer = (res.updatedAt || 0) >= (store.state.updatedAt || 0);
      const ok = await confirmDialog(
        `サーバーのデータ: ${wc}週分(保存: ${new Date(res.updatedAt).toLocaleString('ja-JP')})\n` +
        (newer ? '' : '⚠ この端末のデータの方が新しいようです。\n') +
        '\nこの端末のデータをサーバーの内容で置き換えますか?',
        { okLabel: '置き換える', danger: !newer });
      if (!ok) return;
      store.replaceState(res.data); // GAS設定はローカルを維持、updatedAtはサーバー値を尊重
      if (res.updatedAt) store.state.updatedAt = res.updatedAt;
      store.settings.gas.lastSync = Date.now();
      store.persist();
      toast('✅ サーバーから復元しました');
      ctx.rerender();
    } catch (e) {
      toast('取得失敗: ' + e.message, 'error', 6000);
    }
  };

  root.querySelector('#data-reset').onclick = async () => {
    const ok1 = await confirmDialog('全データを消去します。先にバックアップ(エクスポート)しましたか?', { okLabel: 'エクスポート済み・次へ', danger: true });
    if (!ok1) { exportJSON(); return; }
    const ok2 = await confirmDialog('本当にすべての週案・計画・設定を削除しますか? この操作は取り消せません。', { okLabel: 'すべて削除', danger: true });
    if (!ok2) return;
    localStorage.removeItem('shuan-planner-data');
    location.reload();
  };
}

function exportJSON() {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `週案バックアップ-${fmtDate(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('エクスポートしました');
}
