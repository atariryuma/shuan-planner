/** データ管理ビュー: JSONバックアップ・復元・GAS同期・初期化 */

import { store } from '../store.js';
import { toast, confirmDialog, openModal, openResultLink } from '../ui.js';
import { esc, fmtDate, fmtMDHM, fiscalYearOf } from '../utils.js';
import { icon } from '../icons.js';

export function renderDataView(root, ctx) {
  const state = store.state;
  const weekCount = Object.keys(state.weeks).length;
  const planCount = state.plans.length;
  const bytes = new Blob([JSON.stringify(state)]).size;
  const lastSync = state.settings.gas.lastSync;

  root.innerHTML = `
    <div class="data-page">
      <div class="panel">
        <h2>${icon('archive')}この端末</h2>
        <p class="hint">${weekCount}週分・計画${planCount}件・約${(bytes / 1024).toFixed(0)}KB を、この端末に自動保存しています。長期休業の前にはエクスポートでファイル保存を。</p>
        <div class="data-actions">
          <button class="btn primary" id="data-export">エクスポート</button>
          <button class="btn" id="data-import-btn">インポート</button>
          <input type="file" id="data-import" accept=".json" style="display:none;" aria-hidden="true" tabindex="-1">
        </div>
        <p class="hint data-sub">エクスポート=この端末のデータを1つのファイルに保存。インポート=そのファイルで現在のデータを置き換え。</p>
      </div>

      <div class="panel">
        <h2>${icon('undo')}復元ポイント</h2>
        <p class="hint">この端末に、最近の状態を自動で数世代だけ控えています。消し間違い・上書き・週クリアなどを後からでも巻き戻せます（ネット不要）。</p>
        <div id="bk-list" class="bk-list"></div>
        <div class="data-actions"><button class="btn" id="bk-now">今すぐ控える</button></div>
      </div>

      ${ctx.gas.configured ? `
      <div class="panel">
        <h2>${icon('cloud')}Google</h2>
        <p class="hint">最終同期: ${lastSync ? fmtMDHM(lastSync) : 'まだ同期していません'}</p>
        <div class="data-actions">
          <button class="btn primary" id="gas-push">Googleへ保存</button>
          <button class="btn" id="gas-pull">Googleから取得</button>
          <button class="btn" id="gas-drive">ドライブへバックアップ</button>
        </div>
        <ul class="hint data-sub data-explain">
          <li><b>Googleへ保存</b>: 同期用データを更新(他の端末はこれを取得して揃う)。1か所だけ保持。</li>
          <li><b>ドライブへバックアップ</b>: 日付つきの控えをドライブに残す(最新20世代)。復元用。</li>
          <li><b>自動バックアップ</b>(設定): 保存のたびに上のバックアップも自動で取る。</li>
        </ul>
      </div>` : `
      <div class="panel">
        <h2>${icon('cloud')}Google(未設定)</h2>
        <p class="hint">設定 → Google連携 を行うと、端末間の同期・ドライブへのバックアップが使えます。</p>
        <button class="btn" id="data-goto-gas">設定を開く</button>
      </div>`}

      ${ctx.gas.configured ? `
      <div class="panel">
        <h2>${icon('chart')}レポート</h2>
        <p class="hint">時数の集計をGoogleスプレッドシートに書き出します(教務・管理職への共有用)。</p>
        <div class="data-actions"><button class="btn" id="gas-report">時数レポート書き出し</button></div>
      </div>` : ''}

      <div class="panel">
        <h2>${icon('calendar')}年度の準備</h2>
        <p class="hint">昨年度の年間行事（運動会・参観日など）を、同じ時期・曜日に合わせて今年度へ写します。4月の打ち直しを省けます（日付は後で微調整できます）。</p>
        <div class="data-actions"><button class="btn" id="data-carry-events">昨年度の行事を引き継ぐ</button></div>
      </div>

      <div class="panel">
        <h2>${icon('info')}このアプリについて</h2>
        <p class="app-id"><b>ルーズリーフ</b></p>
        <p class="hint">データはこの端末内にのみ保存されます(Google連携を設定した場合のみ自分のGoogleアカウントへ)。児童生徒の個人名は入力しない運用を推奨します。</p>
      </div>

      <div class="panel data-danger">
        <h2>${icon('warning')}危険な操作</h2>
        <p class="hint">この端末の週案・計画・設定をすべて消します。取り消せません。</p>
        <button class="btn danger" id="data-reset">全データを消去</button>
      </div>
    </div>
  `;

  const gotoGas = root.querySelector('#data-goto-gas');
  if (gotoGas) gotoGas.onclick = () => { try { localStorage.setItem('shuan-settings-cat', 'sp-google'); } catch {} document.querySelector('.tab[data-tab="settings"]')?.click(); };

  root.querySelector('#data-export').onclick = () => exportJSON();

  // 復元ポイント: 自動バックアップの一覧と、ワンタップ復元・手動控え
  renderBackupList(root, ctx);
  root.querySelector('#bk-now')?.addEventListener('click', () => {
    if (store.makeBackup('手動', { force: true })) { toast('今の状態を控えました', 'info', 2400); renderBackupList(root, ctx); }
    else toast('直前と同じ内容なので控えませんでした', 'info', 2800);
  });

  // 年度はじめの軽量スタート: 昨年度の年間行事を今年度へ複製(同じ時期・曜日)
  root.querySelector('#data-carry-events')?.addEventListener('click', async () => {
    const curFY = fiscalYearOf(new Date());
    const ok = await confirmDialog(`${curFY - 1}年度の年間行事を ${curFY}年度へ引き継ぎますか？\n同じ時期・曜日に写します。今年度に既にある行事は残します。`, { okLabel: '引き継ぐ' });
    if (!ok) return;
    store.snapshot('行事の引き継ぎ');
    const n = store.carryOverEvents(curFY - 1, curFY);
    if (n) toast(`${curFY - 1}年度の行事 ${n}週分を引き継ぎました`, 'info', 3200, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    else toast(`${curFY - 1}年度の年間行事が見つかりませんでした`, 'info', 3000);
    ctx.rerender();
  });

  // ファイル選択はボタン経由で起動する(display:noneのfile inputは
  // フォーカス不能のため、label方式だとキーボードから操作できない)
  root.querySelector('#data-import-btn').onclick = () => root.querySelector('#data-import').click();

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
        { okLabel: '置き換え', danger: true });
      if (!ok) return;
      store.snapshot('インポート');
      store.importJSON(text);
      toast('インポートしました', 'info', 3000, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      ctx.rerender();
    } catch (e) {
      toast('インポート失敗: ' + e.message, 'error', 5000);
    } finally {
      ev.target.value = '';
    }
  });

  const gasPush = root.querySelector('#gas-push');
  if (gasPush) gasPush.onclick = async () => {
    try {
      toast('保存中…');
      let res = await ctx.gas.push(store.state);
      if (res.conflict) {
        const ok = await confirmDialog(
          `Googleには別の端末から保存された新しいデータがあります。\nGoogle側の保存: ${fmtMDHM(res.serverUpdatedAt)}\n\nこの端末の内容で上書きしますか?`,
          { okLabel: '上書き保存', danger: true });
        if (!ok) return;
        res = await ctx.gas.push(store.state, { force: true });
      }
      // サーバーが確定したupdatedAtに揃える(commitで進めると、直後のpullで
      // 「この端末の方が新しい」という誤警告が出るため)
      if (res.updatedAt) store.state.updatedAt = res.updatedAt;
      store.settings.gas.lastSync = Date.now();
      store.persist();
      store.notify();
      document.dispatchEvent(new CustomEvent('shuan-synced')); // 自動同期側の未解決conflictを解除
      toast('Googleへ保存しました');
      ctx.rerender();
      // 任意: ドライブへの自動バックアップ(失敗しても同期自体は成功扱い)
      if (store.settings.gas.autoBackup) {
        ctx.gas.driveBackup(store.state)
          .then(() => toast('ドライブにもバックアップしました', 'info', 3500))
          .catch(e => toast('ドライブバックアップ失敗: ' + e.message, 'error', 5000));
      }
    } catch (e) {
      toast('保存失敗: ' + e.message, 'error', 6000);
    }
  };

  const gasDrive = root.querySelector('#gas-drive');
  if (gasDrive) gasDrive.onclick = async () => {
    try {
      toast('ドライブへバックアップ中…');
      await ctx.gas.driveBackup(store.state);
      toast('ドライブへバックアップしました', 'info', 4000); // 世代保持の説明は設定の自動バックアップⓘにある(規約3)
    } catch (e) {
      toast('バックアップ失敗: ' + e.message, 'error', 6000);
    }
  };

  const gasReport = root.querySelector('#gas-report');
  if (gasReport) gasReport.onclick = async () => {
    try {
      toast('書き出し中…');
      const { buildHoursReport } = await import('../gws.js');
      const report = buildHoursReport(ctx.getWeekStart());
      if (!report.rows.length) { toast('まだ集計できる授業がありません', 'error'); return; }
      const res = await ctx.gas.sheetReport(report);
      toast('書き出しました', 'info', 3000);
      openResultLink(res.url, 'シートを開く'); // 規約1: ボタンは2〜6字。週案の「シートへ書き出し」と同じ表記
    } catch (e) {
      toast('書き出し失敗: ' + e.message, 'error', 6000);
    }
  };

  const gasPull = root.querySelector('#gas-pull');
  if (gasPull) gasPull.onclick = async () => {
    try {
      toast('取得中…');
      const res = await ctx.gas.pull();
      if (!res.exists) { toast('Googleにはまだデータがありません'); return; }
      const wc = Object.keys(res.data.weeks || {}).length;
      const newer = (res.updatedAt || 0) >= (store.state.updatedAt || 0);
      const ok = await confirmDialog(
        `Googleのデータ: ${wc}週分(保存: ${fmtMDHM(res.updatedAt)})\n` +
        (newer ? '' : 'この端末のデータの方が新しいようです。\n') +
        '\nこの端末のデータをGoogleの内容で置き換えますか?',
        { okLabel: '置き換え', danger: !newer });
      if (!ok) return;
      // インポートと同型に、置き換え前をUndoで戻せるようにする(古いサーバーデータでの誤上書き救済)
      store.snapshot('Googleから取得');
      store.replaceState(res.data); // GAS設定はローカルを維持、updatedAtはサーバー値を尊重
      if (res.updatedAt) store.state.updatedAt = res.updatedAt;
      store.settings.gas.lastSync = Date.now();
      store.persist();
      document.dispatchEvent(new CustomEvent('shuan-synced')); // 自動同期側の未解決conflictを解除
      toast('Googleから取得しました', 'info', 3000, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      ctx.rerender();
    } catch (e) {
      toast('取得失敗: ' + e.message, 'error', 6000);
    }
  };

  // 3択(キャンセルは何もしない。「キャンセルでファイルが落ちてくる」隠れ副作用は持たない)
  root.querySelector('#data-reset').onclick = () => {
    const wc = Object.keys(store.state.weeks).length;
    openModal(`
      <h2>全データを消去</h2>
      <p style="font-size:14px; line-height:1.7;">${wc}週分の週案・計画・設定をすべて削除します。この操作は取り消せません。<br>
        「保存して消去」はバックアップファイルを保存してから消します。</p>
      <div class="choice-list">
        <button class="btn" data-act="save">保存して消去</button>
        <button class="btn danger" data-act="wipe">保存せず消去</button>
        <button class="btn primary" data-act="cancel">キャンセル</button>
      </div>
    `, (modal, close) => {
      modal.querySelector('[data-act="cancel"]').onclick = close;
      const wipe = () => {
        localStorage.removeItem('shuan-planner-data');
        localStorage.removeItem('shuan-onboarded');
        localStorage.removeItem('shuan-card-done');
        localStorage.removeItem('shuan-last-scope'); // 旧データの学級IDを既定値に引きずらない
        location.reload();
      };
      modal.querySelector('[data-act="save"]').onclick = () => { exportJSON(); setTimeout(wipe, 600); };
      modal.querySelector('[data-act="wipe"]').onclick = wipe;
    });
  };
}

// 復元ポイント一覧を描画し、各行に「この時点に戻す」を付ける。復元前に今の状態も自動で控える(store側)。
function renderBackupList(root, ctx) {
  const listEl = root.querySelector('#bk-list');
  if (!listEl) return;
  const list = store.listBackups();
  if (!list.length) {
    listEl.innerHTML = '<p class="hint data-sub">まだ控えはありません（編集して少し経つと自動でできます）。</p>';
    return;
  }
  listEl.innerHTML = list.map(b => `
    <div class="bk-row">
      <span class="bk-when">${esc(fmtMDHM(b.t))}</span>
      <span class="bk-why">${esc(b.reason)}</span>
      <button class="btn small" data-bk-restore="${esc(b.key)}">この時点に戻す</button>
    </div>`).join('');
  listEl.querySelectorAll('[data-bk-restore]').forEach(btn => {
    btn.onclick = async () => {
      const key = btn.dataset.bkRestore;
      const meta = store.listBackups().find(x => x.key === key);
      const label = meta ? `${fmtMDHM(meta.t)}（${meta.reason}）` : 'この復元ポイント';
      const ok = await confirmDialog(`${label} の状態に戻しますか?\n今の状態も自動で控えるので、戻し過ぎてもまた戻せます。`, { okLabel: 'この時点に戻す' });
      if (!ok) return;
      if (store.restoreBackup(key)) { toast('復元しました', 'info', 3200); ctx.rerender(); }
      else toast('復元できませんでした', 'error', 4000);
    };
  });
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
