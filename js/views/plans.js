/** 年間指導計画ビュー: 計画の一覧・編集・CSV/Excel貼り付けインポート */

import { store } from '../store.js';
import { parseTable, tableToUnits, unitsToCSV } from '../csv.js';
import { openModal, toast, confirmDialog, selectHTML } from '../ui.js';
import { esc, uid } from '../utils.js';

export function renderPlansView(root, ctx) {
  const state = store.state;
  const s = state.settings;

  const items = state.plans.map(p => {
    const subj = s.subjects.find(x => x.key === p.subjectKey);
    const total = p.units.reduce((a, u) => a + (Number(u.hours) || 0), 0);
    return `
      <div class="plan-item" data-id="${esc(p.id)}">
        <span class="subj-chip" style="background:${esc(subj?.color || '#888')}">${esc(subj?.short || '?')}</span>
        <span class="p-subj">${esc(subj?.name || p.subjectKey)}${p.grade ? ` (${p.grade}年)` : ''}</span>
        <span class="p-meta">${esc(p.textbook || '')} / ${p.units.length}単元・計${total}時間${p.startOffset ? ` / 既習${p.startOffset}コマ` : ''}</span>
        <span class="spacer"></span>
        <button class="btn small" data-edit>編集</button>
        <button class="btn small danger" data-del>削除</button>
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="panel">
      <h2>年間指導計画</h2>
      <p class="hint">単元を登録すると、週案のコマに単元名・内容が自動で入ります。</p>
      <div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
        <button class="btn primary" id="plan-new">＋ 作成</button>
        <button class="btn" id="plan-import">📥 取り込み</button>
      </div>
      <div class="plan-list">${items || '<p class="hint">教科書会社サイトの年間指導計画(Excel)をコピーして「📥 取り込み」に貼り付けるのが早道です。</p>'}</div>
    </div>
  `;

  root.querySelector('#plan-new').onclick = () => openPlanEditor(null, ctx);
  root.querySelector('#plan-import').onclick = () => openImportDialog(ctx);
  root.querySelectorAll('.plan-item').forEach(el => {
    const plan = state.plans.find(p => p.id === el.dataset.id);
    el.querySelector('[data-edit]').onclick = () => openPlanEditor(plan, ctx);
    el.querySelector('[data-del]').onclick = async () => {
      const subjName = store.settings.subjects.find(x => x.key === plan.subjectKey)?.name || plan.subjectKey;
      const ok = await confirmDialog(
        `${subjName}${plan.grade ? `(${plan.grade}年)` : ''} の計画(${plan.units.length}単元)を削除しますか?\n週案の自動反映が消えます。`,
        { okLabel: '削除', danger: true });
      if (!ok) return;
      store.snapshot('計画の削除');
      store.removePlan(plan.id);
      toast('計画を削除しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      ctx.rerender();
    };
  });
}

// ---------------------------------------------------------------- 計画エディタ

function openPlanEditor(plan, ctx, presetUnits = null) {
  const s = store.settings;
  const isNew = !plan;
  const original = plan;
  if (isNew) {
    plan = {
      id: uid(),
      subjectKey: s.subjects[0]?.key || '',
      grade: defaultGrade(s),
      textbook: '',
      startOffset: 0,
      units: presetUnits || [],
    };
  } else {
    // ドラフト(ディープコピー)を編集し、保存時にのみ書き戻す(キャンセルで確実にロールバック)
    plan = JSON.parse(JSON.stringify(plan));
  }

  const gradeMax = s.schoolType === 'junior' ? 3 : 6;
  const gradeOpts = Array.from({ length: gradeMax }, (_, i) => ({ value: i + 1, label: `${i + 1}年` }));

  const unitsRows = () => plan.units.map((u, i) => `
    <tr data-unit="${i}">
      <td class="num" style="color:var(--muted)">${i + 1}</td>
      <td><input type="text" name="name" value="${esc(u.name)}" placeholder="単元名"></td>
      <td class="num"><input type="number" name="hours" value="${esc(u.hours)}" min="1" step="1"></td>
      <td><textarea name="lessons" rows="1" placeholder="各時の内容(1行=1時間。空欄可)">${esc((u.lessons || []).map(l => l.text).join('\n'))}</textarea></td>
      <td class="ops">
        <button class="btn small ghost" data-up title="上へ">↑</button>
        <button class="btn small ghost" data-down title="下へ">↓</button>
        <button class="btn small ghost danger" data-rm title="削除">×</button>
      </td>
    </tr>`).join('');

  openModal(`
    <h2>${isNew ? '計画の新規作成' : '計画の編集'}</h2>
    <div style="display:grid; grid-template-columns: 1fr 110px 1fr 130px; gap:10px;">
      <div class="field"><label>教科</label>
        ${selectHTML('subjectKey', s.subjects.map(x => ({ value: x.key, label: x.name })), plan.subjectKey)}
      </div>
      <div class="field"><label>学年</label>
        ${selectHTML('grade', gradeOpts, plan.grade ?? '')}
      </div>
      <div class="field"><label>教科書・出典(任意)</label>
        <input type="text" name="textbook" value="${esc(plan.textbook || '')}" placeholder="例: 東京書籍">
      </div>
      <div class="field"><label>既習コマ数 <span title="年度途中から使い始める場合、すでに授業済みのコマ数">ⓘ</span></label>
        <input type="number" name="startOffset" value="${esc(plan.startOffset || 0)}" min="0">
      </div>
    </div>
    <h3>単元一覧</h3>
    <div style="max-height:46vh; overflow-y:auto;">
      <table class="units-table">
        <thead><tr><th style="width:34px">#</th><th>単元名</th><th style="width:70px">時数</th><th>各時の内容</th><th style="width:100px"></th></tr></thead>
        <tbody id="units-body">${unitsRows()}</tbody>
      </table>
    </div>
    <button class="btn small" id="unit-add" style="margin-top:8px;">＋ 単元を追加</button>
    <div class="modal-foot">
      <button class="btn left" data-export>CSVエクスポート</button>
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-save>保存</button>
    </div>
  `, (modal, close) => {
    const readForm = () => {
      plan.subjectKey = modal.querySelector('[name="subjectKey"]').value;
      plan.grade = Number(modal.querySelector('[name="grade"]').value) || null;
      plan.textbook = modal.querySelector('[name="textbook"]').value.trim();
      plan.startOffset = Math.max(0, Number(modal.querySelector('[name="startOffset"]').value) || 0);
      // DOMの行を正として単元リストを組み直す(行数とのズレによる参照エラーを防ぐ)
      plan.units = [...modal.querySelectorAll('#units-body tr')].map((tr, i) => {
        const u = plan.units[i] || { id: uid() };
        u.name = tr.querySelector('[name="name"]').value.trim();
        u.hours = Math.max(1, Number(tr.querySelector('[name="hours"]').value) || 1);
        // 「1行=1時間」の位置対応を守るため、途中の空行は{text:''}として保持(末尾の空行のみ除去)
        const lines = tr.querySelector('[name="lessons"]').value.split('\n').map(t => t.trim());
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        u.lessons = lines.map(t => ({ text: t }));
        return u;
      });
    };

    const refresh = () => {
      readForm();
      modal.querySelector('#units-body').innerHTML = unitsRows();
      wireRows();
    };

    const wireRows = () => {
      modal.querySelectorAll('#units-body tr').forEach((tr) => {
        const i = Number(tr.dataset.unit);
        tr.querySelector('[data-rm]').onclick = () => { readForm(); plan.units.splice(i, 1); refreshKeep(); };
        tr.querySelector('[data-up]').onclick = () => { if (i > 0) { readForm(); swap(plan.units, i, i - 1); refreshKeep(); } };
        tr.querySelector('[data-down]').onclick = () => { if (i < plan.units.length - 1) { readForm(); swap(plan.units, i, i + 1); refreshKeep(); } };
      });
    };
    const refreshKeep = () => {
      modal.querySelector('#units-body').innerHTML = unitsRows();
      wireRows();
    };

    wireRows();
    modal.querySelector('#unit-add').onclick = () => {
      readForm();
      plan.units.push({ id: uid(), name: '', hours: 1, lessons: [] });
      refreshKeep();
    };
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-export]').onclick = () => {
      readForm();
      downloadText(unitsToCSV(plan.units), `年間指導計画_${plan.subjectKey}.csv`);
    };
    modal.querySelector('[data-save]').onclick = () => {
      readForm();
      const named = plan.units.filter(u => u.name);
      if (!named.length) { toast('単元が1つもありません(単元名を入力してください)', 'error'); return; }
      plan.units = named;
      if (isNew) {
        store.addPlan(plan);
      } else {
        Object.assign(original, plan); // ドラフトを書き戻す
        store.commit();
      }
      toast('計画を保存しました');
      close();
      ctx.rerender();
    };
  });
}

function defaultGrade(s) {
  if (s.mode === 'fukushiki') return s.fukushikiGrades[0];
  return s.grade || 1;
}

function swap(arr, i, j) { [arr[i], arr[j]] = [arr[j], arr[i]]; }

function downloadText(text, filename) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------- インポート

function openImportDialog(ctx) {
  openModal(`
    <h2>年間指導計画の取り込み</h2>
    <p class="hint">
      対応形式(自動判定):<br>
      ① <b>単元名, 時数, 内容</b> の列を持つ表(1行=1単元。内容は「|」か改行区切りで各時に展開)<br>
      ② <b>単元名, 内容</b> の表(1行=1時間。同じ単元名の行をまとめて時数を数えます)<br>
      ExcelやWebページの表は、範囲選択してコピー → 下の欄に貼り付けでOKです。
    </p>
    <div class="field import-area">
      <label>Excel/スプレッドシートから貼り付け(タブ区切り) または CSVテキスト</label>
      <textarea name="paste" placeholder="単元名	時数	内容&#10;たし算とひき算	8	筆算のしかた|くり上がり…"></textarea>
    </div>
    <div class="field">
      <label>またはCSVファイルを選択</label>
      <input type="file" name="file" accept=".csv,.tsv,.txt">
    </div>
    <div class="modal-foot">
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-next>読み取る</button>
    </div>
  `, (modal, close) => {
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-next]').onclick = async () => {
      let text = modal.querySelector('[name="paste"]').value;
      const file = modal.querySelector('[name="file"]').files[0];
      if (!text.trim() && file) text = await file.text();
      if (!text.trim()) { toast('データを貼り付けるかファイルを選択してください', 'error'); return; }
      try {
        const rows = parseTable(text);
        const { units, format, warnings } = tableToUnits(rows);
        const total = units.reduce((a, u) => a + u.hours, 0);
        toast(`${units.length}単元・計${total}時間を読み取りました(形式${format})`);
        warnings.forEach(w => toast(w, 'error', 4000));
        close();
        openPlanEditor(null, ctx, units.map(u => ({ ...u, id: uid() })));
      } catch (e) {
        toast('読み取りエラー: ' + e.message, 'error', 5000);
      }
    };
  });
}
