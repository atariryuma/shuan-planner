/** 年間指導計画ビュー: 計画の一覧・編集・CSV/Excel貼り付けインポート */

import { store, normalizeLesson, VIEWPOINTS } from '../store.js';
import { parseTable, tableToUnits, unitsToCSV } from '../csv.js';
import { openModal, toast, confirmDialog, selectHTML, infoHTML } from '../ui.js';
import { esc, uid } from '../utils.js';

/** 各時(lesson)の入力状況: 指導目標が入っている時間数 */
function filledCount(u) {
  return (u.lessons || []).filter(l => (l.objective ?? l.text ?? '').trim()).length;
}

export function renderPlansView(root, ctx) {
  const state = store.state;
  const s = state.settings;

  const items = state.plans.map(p => {
    const subj = s.subjects.find(x => x.key === p.subjectKey);
    const total = p.units.reduce((a, u) => a + (Number(u.hours) || 0), 0);
    return `
      <div class="plan-item" data-id="${esc(p.id)}">
        <span class="subj-chip" style="background:${esc(subj?.color || '#767676')}">${esc(subj?.short || '?')}</span>
        <span class="p-subj">${esc(subj?.name || p.subjectKey)}${p.grade ? ` (${p.grade}年)` : ''}</span>
        <span class="p-meta">${p.textbook ? esc(p.textbook) + ' / ' : ''}${p.units.length}単元・計${total}時間${p.startOffset ? ` / 既習${p.startOffset}コマ` : ''}</span>
        <span class="spacer"></span>
        <button class="btn small" data-print title="単元指導計画を印刷">印刷</button>
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
    el.querySelector('[data-print]').onclick = async () => {
      const { buildPlanPrintDOM, printState } = await import('../print.js');
      buildPlanPrintDOM(plan.id);
      printState.prepared = true;
      requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    };
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
      // 専科は担当教科を既定に(週案の新規コマと同じ規則)
      subjectKey: (s.mode === 'senka' && s.senkaSubject) ? s.senkaSubject : (s.subjects[0]?.key || ''),
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

  // 単元は正規化済みの形(goal/criteria/lessons)で扱う
  plan.units = (plan.units || []).map(u => ({
    id: u.id || uid(), name: u.name || '', hours: Number(u.hours) || 1,
    goal: u.goal || '', criteria: { knowledge: u.criteria?.knowledge || '', thinking: u.criteria?.thinking || '', attitude: u.criteria?.attitude || '' },
    lessons: (u.lessons || []).map(normalizeLesson),
  }));

  const unitsRows = () => plan.units.map((u, i) => {
    const filled = filledCount(u);
    const hasDetail = u.goal || u.criteria.knowledge || u.criteria.thinking || u.criteria.attitude;
    return `
    <tr data-unit="${i}">
      <td class="num" style="color:var(--muted)">${i + 1}</td>
      <td><input type="text" name="name" value="${esc(u.name)}" placeholder="単元名" aria-label="単元${i + 1}の単元名"></td>
      <td class="num"><input type="number" name="hours" value="${esc(u.hours)}" min="1" step="1" aria-label="単元${i + 1}の時数"></td>
      <td style="text-align:center;"><span class="hint">指導目標 ${filled}/${u.hours}${hasDetail ? ' ・目標/評価' : ''}</span></td>
      <td class="ops">
        <button class="btn small" data-detail title="各時の指導目標・学習活動・評価規準を編集">各時・評価</button>
        <button class="btn small ghost" data-up aria-label="上へ" title="上へ">↑</button>
        <button class="btn small ghost" data-down aria-label="下へ" title="下へ">↓</button>
        <button class="btn small ghost danger" data-rm aria-label="削除" title="削除">×</button>
      </td>
    </tr>`;
  }).join('');

  openModal(`
    <h2>${isNew ? '計画の新規作成' : '計画の編集'}</h2>
    <div class="plan-form-grid">
      <div class="field"><label>教科</label>
        ${selectHTML('subjectKey', s.subjects.map(x => ({ value: x.key, label: x.name })), plan.subjectKey)}
      </div>
      <div class="field"><label>学年</label>
        ${selectHTML('grade', gradeOpts, plan.grade ?? '')}
      </div>
      <div class="field"><label>教科書・出典(任意)</label>
        <input type="text" name="textbook" value="${esc(plan.textbook || '')}" placeholder="例: 大日本図書">
      </div>
      <div class="field"><label>既習コマ数${infoHTML('年度途中から使い始める場合、すでに授業済みのコマ数。進度の数え始めがその分ずれます')}</label>
        <input type="number" name="startOffset" value="${esc(plan.startOffset || 0)}" min="0">
      </div>
    </div>
    <h3>単元一覧${infoHTML('「各時・評価」で、単元の目標・評価規準と、各時の指導目標／学習活動／評価規準を編集できます')}</h3>
    <div class="table-scroll" style="max-height:46vh; overflow-y:auto;">
      <table class="units-table">
        <thead><tr><th style="width:34px">#</th><th>単元名</th><th style="width:64px">時数</th><th style="width:140px">内容</th><th style="width:200px"></th></tr></thead>
        <tbody id="units-body">${unitsRows()}</tbody>
      </table>
    </div>
    <button class="btn small" id="unit-add" style="margin-top:8px;">＋ 単元を追加</button>
    <div class="modal-foot">
      <button class="btn left" data-export>CSV保存</button>
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-save>保存</button>
    </div>
  `, (modal, close) => {
    // インラインの単元名・時数だけ読み取る(目標・評価・各時は単元詳細エディタが直接編集する)
    const readForm = () => {
      plan.subjectKey = modal.querySelector('[name="subjectKey"]').value;
      plan.grade = Number(modal.querySelector('[name="grade"]').value) || null;
      plan.textbook = modal.querySelector('[name="textbook"]').value.trim();
      plan.startOffset = Math.max(0, Number(modal.querySelector('[name="startOffset"]').value) || 0);
      modal.querySelectorAll('#units-body tr').forEach((tr) => {
        const i = Number(tr.dataset.unit);
        if (!plan.units[i]) return;
        plan.units[i].name = tr.querySelector('[name="name"]').value.trim();
        plan.units[i].hours = Math.max(1, Number(tr.querySelector('[name="hours"]').value) || 1);
      });
    };

    const refreshKeep = () => {
      modal.querySelector('#units-body').innerHTML = unitsRows();
      wireRows();
    };

    const wireRows = () => {
      modal.querySelectorAll('#units-body tr').forEach((tr) => {
        const i = Number(tr.dataset.unit);
        tr.querySelector('[data-rm]').onclick = () => { readForm(); plan.units.splice(i, 1); refreshKeep(); };
        tr.querySelector('[data-up]').onclick = () => { if (i > 0) { readForm(); swap(plan.units, i, i - 1); refreshKeep(); } };
        tr.querySelector('[data-down]').onclick = () => { if (i < plan.units.length - 1) { readForm(); swap(plan.units, i, i + 1); refreshKeep(); } };
        tr.querySelector('[data-detail]').onclick = () => {
          readForm();
          openUnitEditor(plan.units[i], () => refreshKeep());
        };
      });
    };

    wireRows();
    modal.querySelector('#unit-add').onclick = () => {
      readForm();
      plan.units.push({ id: uid(), name: '', hours: 1, goal: '', criteria: { knowledge: '', thinking: '', attitude: '' }, lessons: [] });
      refreshKeep();
    };
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-export]').onclick = () => {
      readForm();
      downloadText(unitsToCSV(plan.units), `年間指導計画_${plan.subjectKey}.csv`);
      toast('CSVを保存しました');
    };
    modal.querySelector('[data-save]').onclick = () => {
      readForm();
      const named = plan.units.filter(u => u.name);
      if (!named.length) {
        toast('単元名が未入力です', 'error');
        modal.querySelector('#units-body [name="name"]')?.focus();
        return;
      }
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

// ---------------------------------------------------------------- 単元の詳細(目標・評価規準・各時)

/**
 * 1単元の指導計画を編集する。単元の目標・評価規準(3観点)と、
 * 各時の 指導目標 / 学習活動 / 評価規準 / 観点 を表で編集する(正式な単元指導計画の構成)。
 * 保存すると渡された unit を直接書き換え、onSave で親一覧を更新する。
 */
function openUnitEditor(unit, onSave) {
  // 編集はドラフトで行い、保存時に書き戻す
  const draft = {
    name: unit.name || '', hours: Number(unit.hours) || 1, goal: unit.goal || '',
    criteria: { knowledge: unit.criteria?.knowledge || '', thinking: unit.criteria?.thinking || '', attitude: unit.criteria?.attitude || '' },
    lessons: (unit.lessons || []).map(normalizeLesson),
  };
  // 各時の行数は時数に合わせる(不足はパディング)
  const syncLessons = (n) => { while (draft.lessons.length < n) draft.lessons.push(normalizeLesson({})); };
  syncLessons(draft.hours);

  const vpOptions = [{ value: '', label: '—' }, { value: '知', label: '知' }, { value: '思', label: '思' }, { value: '態', label: '態' }];
  const hourRows = () => draft.lessons.slice(0, Math.max(draft.hours, draft.lessons.length)).map((l, i) => `
    <tr data-h="${i}" ${i >= draft.hours ? 'style="opacity:.5;"' : ''}>
      <td class="num" style="color:var(--muted);">${i + 1}</td>
      <td><textarea name="objective" rows="2" aria-label="${i + 1}時の指導目標">${esc(l.objective)}</textarea></td>
      <td><textarea name="activity" rows="2" aria-label="${i + 1}時の学習活動">${esc(l.activity)}</textarea></td>
      <td><textarea name="assessment" rows="2" aria-label="${i + 1}時の評価規準">${esc(l.assessment)}</textarea></td>
      <td>${selectHTML('viewpoint', vpOptions, l.viewpoint, { attrs: `aria-label="${i + 1}時の観点"` })}</td>
    </tr>`).join('');

  openModal(`
    <h2>単元の詳細</h2>
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
      <div class="field" style="flex:1; min-width:180px;"><label>単元名</label>
        <input type="text" name="uname" value="${esc(draft.name)}" placeholder="単元名"></div>
      <div class="field" style="width:90px;"><label>時数</label>
        <input type="number" name="uhours" value="${esc(draft.hours)}" min="1" step="1"></div>
    </div>
    <div class="field"><label>単元の目標</label>
      <textarea name="ugoal" rows="2" placeholder="この単元で身に付けさせたい力">${esc(draft.goal)}</textarea></div>
    <h3>単元の評価規準${infoHTML('学習指導要領の3観点。国立教育政策研究所の参考資料に沿って記述します')}</h3>
    <div class="field"><label>知識・技能</label>
      <textarea name="ck" rows="2">${esc(draft.criteria.knowledge)}</textarea></div>
    <div class="field"><label>思考・判断・表現</label>
      <textarea name="ct" rows="2">${esc(draft.criteria.thinking)}</textarea></div>
    <div class="field"><label>主体的に学習に取り組む態度</label>
      <textarea name="ca" rows="2">${esc(draft.criteria.attitude)}</textarea></div>
    <h3>各時の指導計画${infoHTML('観点: 知=知識・技能 / 思=思考・判断・表現 / 態=主体的に学習に取り組む態度')}</h3>
    <div class="table-scroll" style="max-height:42vh; overflow-y:auto;">
      <table class="units-table unit-hours-table">
        <thead><tr><th style="width:28px">#</th><th>指導目標(本時のねらい)</th><th>学習活動</th><th>評価規準</th><th style="width:54px">観点</th></tr></thead>
        <tbody id="hours-body">${hourRows()}</tbody>
      </table>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-save>保存</button>
    </div>
  `, (modal, close) => {
    const readHours = () => {
      modal.querySelectorAll('#hours-body tr').forEach((tr) => {
        const i = Number(tr.dataset.h);
        draft.lessons[i] = {
          objective: tr.querySelector('[name="objective"]').value.trim(),
          activity: tr.querySelector('[name="activity"]').value.trim(),
          assessment: tr.querySelector('[name="assessment"]').value.trim(),
          viewpoint: tr.querySelector('[name="viewpoint"]').value,
        };
      });
    };
    // 時数を変えたら各時の行数を追従(入力済みは保持)
    modal.querySelector('[name="uhours"]').addEventListener('change', (ev) => {
      readHours();
      draft.hours = Math.max(1, Number(ev.target.value) || 1);
      syncLessons(draft.hours);
      modal.querySelector('#hours-body').innerHTML = hourRows();
    });
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-save]').onclick = () => {
      readHours();
      unit.name = modal.querySelector('[name="uname"]').value.trim() || unit.name;
      unit.hours = Math.max(1, Number(modal.querySelector('[name="uhours"]').value) || 1);
      unit.goal = modal.querySelector('[name="ugoal"]').value.trim();
      unit.criteria = {
        knowledge: modal.querySelector('[name="ck"]').value.trim(),
        thinking: modal.querySelector('[name="ct"]').value.trim(),
        attitude: modal.querySelector('[name="ca"]').value.trim(),
      };
      // 時数ぶんだけ各時を保存(余分な末尾は捨てる)
      unit.lessons = draft.lessons.slice(0, unit.hours).map(normalizeLesson);
      close();
      onSave?.();
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
      <label>Excelやスプレッドシートから貼り付け${infoHTML('Excel・スプレッドシートのセルを範囲コピーして貼り付け(タブ区切り)。CSVテキストも可')}</label>
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
      if (!text.trim()) { toast('データがありません', 'error'); modal.querySelector('[name="paste"]').focus(); return; }
      try {
        const rows = parseTable(text);
        const { units, warnings } = tableToUnits(rows);
        const total = units.reduce((a, u) => a + u.hours, 0);
        // 形式①/②はダイアログ側の説明に任せ、結果報告のみ(規約3・6: ダイアログの①②とAB表記を混ぜない)
        toast(`${units.length}単元・計${total}時間を読み取りました`);
        warnings.forEach(w => toast(w, 'error', 4000));
        close();
        openPlanEditor(null, ctx, units.map(u => ({ ...u, id: uid() })));
      } catch (e) {
        toast('読み取りエラー: ' + e.message, 'error', 5000);
      }
    };
  });
}
