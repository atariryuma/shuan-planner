/** 年間指導計画ビュー: 一覧 ↔ 全画面編集(単元一覧+選択単元の各時カード)・CSV取込 */

import { store, normalizeLesson, VIEWPOINTS } from '../store.js';
import { parseTable, detectColumns, buildUnitsFromColumns, unitsToCSV } from '../csv.js';
import { openModal, toast, confirmDialog, selectHTML, infoHTML } from '../ui.js';
import { esc, uid } from '../utils.js';
import { icon } from '../icons.js';

// 全画面編集の状態(編集中の計画ID・選択中の単元index)。null=一覧表示
let editState = null;

/** 各時の入力状況: 指導目標が入っている時間数 */
function filledCount(u) {
  return (u.lessons || []).filter(l => (l.objective ?? l.text ?? '').trim()).length;
}

/** 単元の正規化(欠損補完)。編集対象は常にこの形にしておく */
function normUnit(u) {
  u = u && typeof u === 'object' ? u : {};
  return {
    id: u.id || uid(), name: u.name || '', hours: Math.max(1, Number(u.hours) || 1),
    goal: u.goal || '',
    criteria: { knowledge: u.criteria?.knowledge || '', thinking: u.criteria?.thinking || '', attitude: u.criteria?.attitude || '' },
    lessons: (u.lessons || []).map(normalizeLesson),
  };
}

export function renderPlansView(root, ctx) {
  if (editState && store.state.plans.some(p => p.id === editState.planId)) {
    renderPlanEditor(root, ctx);
  } else {
    editState = null;
    renderPlanList(root, ctx);
  }
}

// ---------------------------------------------------------------- 一覧

function renderPlanList(root, ctx) {
  const state = store.state;
  const s = state.settings;

  const items = state.plans.map(p => {
    const subj = s.subjects.find(x => x.key === p.subjectKey);
    const total = p.units.reduce((a, u) => a + (Number(u.hours) || 0), 0);
    const filled = p.units.reduce((a, u) => a + filledCount(u), 0);
    const pct = total ? Math.round((filled / total) * 100) : 0;
    return `
      <div class="plan-item" data-id="${esc(p.id)}">
        <span class="subj-chip" style="background:${esc(subj?.color || '#767676')}">${esc(subj?.short || '?')}</span>
        <span class="p-subj">${esc(subj?.name || p.subjectKey)}${p.grade ? ` (${p.grade}年)` : ''}</span>
        <span class="p-meta">${p.textbook ? esc(p.textbook) + ' / ' : ''}${p.units.length}単元・計${total}時間<br>
          <span class="p-fill"><span class="p-fill-bar"><span style="width:${pct}%; background:${esc(subj?.color || '#2563eb')}"></span></span>各時 ${filled}/${total}</span></span>
        <span class="spacer"></span>
        <button class="btn small" data-print title="単元指導計画を印刷">印刷</button>
        <button class="btn small primary" data-edit>編集</button>
        <button class="btn small ghost danger" data-del aria-label="削除" title="削除">×</button>
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="panel">
      <h2>年間指導計画</h2>
      <p class="hint">単元を登録すると、週案に単元名・本時のねらい・学習活動・評価規準が自動で入ります。</p>
      <div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
        <button class="btn primary" id="plan-new">${icon('plus')}作成</button>
        <button class="btn" id="plan-import">${icon('download')}取り込み</button>
      </div>
      <div class="plan-list">${items || `
        <div class="empty-state">
          <div class="empty-ic">${icon('book')}</div>
          <p class="empty-title">まだ年間指導計画がありません</p>
          <p class="empty-sub">登録すると、週案に単元名・ねらい・学習活動・評価規準が自動で入ります。<br>教科書会社サイトのExcelをコピーして「取り込み」に貼るのが早道です。</p>
          <div class="empty-actions">
            <button class="btn primary" id="plan-empty-import">${icon('download')}取り込みで始める</button>
            <button class="btn" id="plan-empty-new">${icon('plus')}手で作成</button>
          </div>
        </div>`}</div>
    </div>
  `;

  root.querySelector('#plan-new').onclick = () => {
    const s = store.settings;
    const plan = {
      id: uid(),
      subjectKey: (s.mode === 'senka' && s.senkaSubject) ? s.senkaSubject : (s.subjects[0]?.key || ''),
      grade: defaultGrade(s), textbook: '', startOffset: 0,
      units: [normUnit({ name: '' })],
    };
    store.addPlan(plan);
    editState = { planId: plan.id, unitIdx: 0 };
    ctx.rerender();
  };
  root.querySelector('#plan-import').onclick = () => openImportDialog(ctx);
  root.querySelector('#plan-empty-import')?.addEventListener('click', () => openImportDialog(ctx));
  root.querySelector('#plan-empty-new')?.addEventListener('click', () => root.querySelector('#plan-new').click());
  root.querySelectorAll('.plan-item').forEach(el => {
    const plan = state.plans.find(p => p.id === el.dataset.id);
    el.querySelector('[data-print]').onclick = async () => {
      const { buildPlanPrintDOM, printState } = await import('../print.js');
      buildPlanPrintDOM(plan.id);
      printState.prepared = true;
      requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    };
    el.querySelector('[data-edit]').onclick = () => { editState = { planId: plan.id, unitIdx: 0 }; ctx.rerender(); };
    el.querySelector('[data-del]').onclick = async () => {
      const subjName = store.settings.subjects.find(x => x.key === plan.subjectKey)?.name || plan.subjectKey;
      const affected = store.countPlanCells(plan.subjectKey, plan.grade ?? null);
      const ok = await confirmDialog(
        `${subjName}${plan.grade ? `(${plan.grade}年)` : ''} の計画(${plan.units.length}単元)を削除しますか?` +
        (affected ? `\n週案の ${affected}コマ の本時表示が空になります（進度も出なくなります）。元に戻すで復旧できます。` : ''),
        { okLabel: '削除', danger: true });
      if (!ok) return;
      store.snapshot('計画の削除');
      store.removePlan(plan.id);
      toast('計画を削除しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
      ctx.rerender();
    };
  });
}

// ---------------------------------------------------------------- 全画面エディタ

function renderPlanEditor(root, ctx) {
  const s = store.settings;
  const plan = store.state.plans.find(p => p.id === editState.planId);
  // 単元を正規化(編集中は常に新形式)
  plan.units = (plan.units.length ? plan.units : [normUnit({ name: '' })]).map(normUnit);
  if (editState.unitIdx >= plan.units.length) editState.unitIdx = plan.units.length - 1;
  if (editState.unitIdx < 0) editState.unitIdx = 0;
  const unit = plan.units[editState.unitIdx];

  const gradeMax = s.schoolType === 'junior' ? 3 : 6;
  const gradeOpts = Array.from({ length: gradeMax }, (_, i) => ({ value: i + 1, label: `${i + 1}年` }));
  const subj = s.subjects.find(x => x.key === plan.subjectKey);
  const total = plan.units.reduce((a, u) => a + u.hours, 0);

  const unitListHTML = plan.units.map((u, i) => {
    const filled = filledCount(u);
    const detail = (u.goal || u.criteria.knowledge || u.criteria.thinking || u.criteria.attitude) ? '目標◯' : '目標—';
    return `
      <li class="plan-unit-item ${i === editState.unitIdx ? 'selected' : ''}" data-unit="${i}" tabindex="0" role="button" aria-label="単元${i + 1} ${esc(u.name || '(無題)')}">
        <span class="pu-no">${i + 1}</span>
        <span class="pu-body"><span class="pu-name">${esc(u.name || '(単元名なし)')}</span>
          <span class="pu-meta">${u.hours}時 ・ 各時${filled}/${u.hours} ・ ${detail}</span></span>
        <span class="pu-ops">
          <button class="btn small ghost" data-up aria-label="上へ" title="上へ">↑</button>
          <button class="btn small ghost" data-down aria-label="下へ" title="下へ">↓</button>
          <button class="btn small ghost danger" data-rm aria-label="削除" title="削除">×</button>
        </span>
      </li>`;
  }).join('');

  root.innerHTML = `
    <div class="panel plan-editor">
      <div class="pe-header">
        <button class="btn" id="pe-back">← 一覧へ</button>
        <span class="pe-title">${esc(subj?.name || plan.subjectKey)}${plan.grade ? ` ${plan.grade}年` : ''}<span class="hint"> ・ ${plan.units.length}単元 計${total}時間</span></span>
        <span class="spacer"></span>
        <button class="btn small" id="pe-csv">CSV保存</button>
        <button class="btn small" id="pe-print">印刷</button>
      </div>

      <details class="pe-basic">
        <summary class="fold-label">計画の基本情報(教科・学年・教科書・既習)</summary>
        <div class="plan-form-grid" style="margin-top:10px;">
          <div class="field"><label>教科</label>${selectHTML('subjectKey', s.subjects.map(x => ({ value: x.key, label: x.name })), plan.subjectKey)}</div>
          <div class="field"><label>学年</label>${selectHTML('grade', gradeOpts, plan.grade ?? '', { allowEmpty: '全学年共通' })}</div>
          <div class="field"><label>教科書・出典(任意)</label><input type="text" name="textbook" value="${esc(plan.textbook || '')}" placeholder="例: 大日本図書"></div>
          <div class="field"><label>既習コマ数${infoHTML('年度途中から使い始める場合、すでに授業済みのコマ数。進度の数え始めがその分ずれます')}</label>
            <input type="number" name="startOffset" value="${esc(plan.startOffset || 0)}" min="0"></div>
        </div>
      </details>

      <div class="pe-body">
        <div class="pe-units">
          <div class="pe-units-head"><h3>単元一覧</h3></div>
          <ul class="plan-unit-list">${unitListHTML}</ul>
          <button class="btn small" id="unit-add" style="margin-top:8px;">＋ 単元を追加</button>
        </div>

        <div class="pe-unit-edit" id="pe-unit-edit">
          ${unitEditHTML(unit)}
        </div>
      </div>
    </div>
  `;

  wirePlanEditor(root, ctx, plan);
}

/** 選択中の単元の編集領域(単元名・時数・目標・評価規準・各時カード) */
function unitEditHTML(u) {
  const cards = u.lessons.slice(0, u.hours).map((l, i) => `
    <div class="hour-card" data-h="${i}">
      <div class="hc-head"><span class="hc-no">${i + 1}時</span>
        <span class="hc-ops">
          <button class="btn small ghost" data-dup title="この時を複製して下に追加">複製</button>
          <button class="btn small ghost" data-hup aria-label="上へ" title="上へ">↑</button>
          <button class="btn small ghost" data-hdown aria-label="下へ" title="下へ">↓</button>
          <button class="btn small ghost danger" data-hrm aria-label="この時を削除" title="削除">×</button>
        </span>
      </div>
      <div class="field"><label>指導目標(本時のねらい)</label>
        <textarea name="objective" rows="2" data-h="${i}">${esc(l.objective)}</textarea></div>
      <div class="field"><label>学習活動</label>
        <textarea name="activity" rows="2" data-h="${i}">${esc(l.activity)}</textarea></div>
      <div class="hc-row">
        <div class="field" style="flex:1;"><label>評価規準</label>
          <textarea name="assessment" rows="2" data-h="${i}">${esc(l.assessment)}</textarea></div>
        <div class="field hc-vp"><label>観点</label>
          <div class="ov-vp" data-h="${i}" role="group" aria-label="${i + 1}時の観点">
            ${['知', '思', '態'].map(code => `<button type="button" data-vp="${code}" class="${l.viewpoint === code ? 'selected' : ''}" aria-pressed="${l.viewpoint === code}" title="${esc(VIEWPOINTS[code])}">${code}</button>`).join('')}
            <button type="button" data-vp="" class="ov-vp-none ${l.viewpoint === '' ? 'selected' : ''}" aria-pressed="${l.viewpoint === ''}">なし</button>
          </div></div>
      </div>
    </div>`).join('');

  return `
    <div class="ue-top">
      <div class="field" style="flex:1; min-width:160px;"><label>単元名</label>
        <input type="text" name="uname" value="${esc(u.name)}" placeholder="単元名"></div>
      <div class="field ue-hours"><label>時数</label>
        <input type="number" name="uhours" value="${esc(u.hours)}" min="1" step="1"></div>
    </div>
    <div class="field"><label>単元の目標</label>
      <textarea name="ugoal" rows="2" placeholder="この単元で身に付けさせたい力">${esc(u.goal)}</textarea></div>
    <details class="ue-criteria">
      <summary class="fold-label">単元の評価規準(3観点)</summary>
      <div class="field" style="margin-top:8px;"><label>知識・技能</label><textarea name="ck" rows="2">${esc(u.criteria.knowledge)}</textarea></div>
      <div class="field"><label>思考・判断・表現</label><textarea name="ct" rows="2">${esc(u.criteria.thinking)}</textarea></div>
      <div class="field"><label>主体的に学習に取り組む態度</label><textarea name="ca" rows="2">${esc(u.criteria.attitude)}</textarea></div>
    </details>
    <h3 class="ue-hours-h">各時の指導計画${infoHTML('観点: 知=知識・技能 / 思=思考・判断・表現 / 態=主体的に学習に取り組む態度')}</h3>
    <div class="hour-cards">${cards}</div>
    <button class="btn small" id="hour-add" style="margin-top:8px;">＋ 時を追加</button>`;
}

function wirePlanEditor(root, ctx, plan) {
  const s = store.settings;
  const unit = plan.units[editState.unitIdx];
  const save = () => store.commit();
  const reRender = () => ctx.rerender();
  // 各時の行数を時数に合わせる(不足はパディング)
  const syncLessons = (u) => { while (u.lessons.length < u.hours) u.lessons.push(normalizeLesson({})); };

  root.querySelector('#pe-back').onclick = () => {
    // 空の計画(単元名が1つも無い)は破棄して一覧へ
    if (!plan.units.some(u => u.name.trim())) { store.removePlan(plan.id); }
    editState = null;
    ctx.rerender();
  };
  root.querySelector('#pe-print').onclick = async () => {
    const { buildPlanPrintDOM, printState } = await import('../print.js');
    buildPlanPrintDOM(plan.id);
    printState.prepared = true;
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  };
  root.querySelector('#pe-csv').onclick = () => {
    downloadText(unitsToCSV(plan.units), `年間指導計画_${plan.subjectKey}.csv`);
    toast('CSVを保存しました');
  };

  // 基本情報(textは即時保存。教科・学年は再描画でラベル更新)
  root.querySelector('[name="subjectKey"]').addEventListener('change', (e) => { plan.subjectKey = e.target.value; save(); reRender(); });
  root.querySelector('[name="grade"]').addEventListener('change', (e) => { plan.grade = Number(e.target.value) || null; save(); reRender(); });
  root.querySelector('[name="textbook"]').addEventListener('input', (e) => { plan.textbook = e.target.value.trim(); save(); });
  root.querySelector('[name="startOffset"]').addEventListener('change', (e) => { plan.startOffset = Math.max(0, Number(e.target.value) || 0); save(); });

  // 単元一覧: 選択・並べ替え・削除
  root.querySelectorAll('.plan-unit-item').forEach(li => {
    const i = Number(li.dataset.unit);
    const select = () => { editState.unitIdx = i; reRender(); };
    li.querySelector('.pu-body').onclick = select;
    li.querySelector('.pu-no').onclick = select;
    li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(); } });
    li.querySelector('[data-up]').onclick = (e) => { e.stopPropagation(); if (i > 0) { swap(plan.units, i, i - 1); editState.unitIdx = i - 1; save(); reRender(); } };
    li.querySelector('[data-down]').onclick = (e) => { e.stopPropagation(); if (i < plan.units.length - 1) { swap(plan.units, i, i + 1); editState.unitIdx = i + 1; save(); reRender(); } };
    li.querySelector('[data-rm]').onclick = async (e) => {
      e.stopPropagation();
      if (plan.units.length <= 1) { toast('最後の単元は削除できません', 'error'); return; }
      const ok = await confirmDialog(`単元「${plan.units[i].name || '(無題)'}」を削除しますか?`, { okLabel: '削除', danger: true });
      if (!ok) return;
      store.snapshot('単元の削除');
      plan.units.splice(i, 1);
      store.pruneDanglingPins(); // この単元を「本時を選ぶ(pin)」で差していたコマを自然進度へ戻す
      if (editState.unitIdx >= plan.units.length) editState.unitIdx = plan.units.length - 1;
      save();
      toast('単元を削除しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); reRender(); } });
      reRender();
    };
  });
  root.querySelector('#unit-add').onclick = () => {
    plan.units.push(normUnit({ name: '' }));
    editState.unitIdx = plan.units.length - 1;
    save(); reRender();
  };

  // 選択単元: 基本(即時保存)
  const ue = root.querySelector('#pe-unit-edit');
  ue.querySelector('[name="uname"]').addEventListener('input', (e) => { unit.name = e.target.value; save(); });
  ue.querySelector('[name="uname"]').addEventListener('change', () => reRender()); // 一覧の名前を更新
  ue.querySelector('[name="uhours"]').addEventListener('change', (e) => {
    unit.hours = Math.max(1, Number(e.target.value) || 1);
    syncLessons(unit);
    save(); reRender();
  });
  ue.querySelector('[name="ugoal"]').addEventListener('input', (e) => { unit.goal = e.target.value; save(); });
  ue.querySelector('[name="ck"]').addEventListener('input', (e) => { unit.criteria.knowledge = e.target.value; save(); });
  ue.querySelector('[name="ct"]').addEventListener('input', (e) => { unit.criteria.thinking = e.target.value; save(); });
  ue.querySelector('[name="ca"]').addEventListener('input', (e) => { unit.criteria.attitude = e.target.value; save(); });

  // 各時カード: テキストは即時保存、構造変更は再描画
  syncLessons(unit);
  ue.querySelectorAll('.hour-card').forEach(card => {
    const i = Number(card.dataset.h);
    const l = unit.lessons[i];
    card.querySelector('[name="objective"]').addEventListener('input', (e) => { l.objective = e.target.value; save(); });
    card.querySelector('[name="activity"]').addEventListener('input', (e) => { l.activity = e.target.value; save(); });
    card.querySelector('[name="assessment"]').addEventListener('input', (e) => { l.assessment = e.target.value; save(); });
    card.querySelectorAll('.ov-vp[data-h] [data-vp]').forEach(b => {
      b.addEventListener('click', () => {
        l.viewpoint = b.dataset.vp;
        b.closest('.ov-vp').querySelectorAll('[data-vp]').forEach(x => {
          const on = x.dataset.vp === l.viewpoint;
          x.classList.toggle('selected', on);
          x.setAttribute('aria-pressed', String(on));
        });
        save();
      });
    });
    // 充足率の数字を更新するため、textのchangeで一覧側を軽く更新
    card.querySelector('[name="objective"]').addEventListener('change', () => reRender());
    card.querySelector('[data-dup]').onclick = () => {
      unit.lessons.splice(i + 1, 0, normalizeLesson({ ...l }));
      unit.hours = Math.max(unit.hours, unit.lessons.length); // 複製で時数を増やす
      save(); reRender();
    };
    card.querySelector('[data-hup]').onclick = () => { if (i > 0) { swap(unit.lessons, i, i - 1); save(); reRender(); } };
    card.querySelector('[data-hdown]').onclick = () => { if (i < unit.lessons.length - 1) { swap(unit.lessons, i, i + 1); save(); reRender(); } };
    card.querySelector('[data-hrm]').onclick = () => {
      if (unit.hours <= 1) { toast('最後の時は削除できません', 'error'); return; }
      unit.lessons.splice(i, 1);
      unit.hours = Math.max(1, unit.hours - 1);
      save(); reRender();
    };
  });
  ue.querySelector('#hour-add').onclick = () => {
    unit.lessons.push(normalizeLesson({}));
    unit.hours = unit.lessons.length;
    save(); reRender();
  };
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
      指導目標・学習活動・評価規準・観点の列があれば、それぞれに取り込みます。
    </p>
    <div class="field import-area">
      <label>Excelやスプレッドシートから貼り付け${infoHTML('Excel・スプレッドシートのセルを範囲コピーして貼り付け(タブ区切り)。CSVテキストも可')}</label>
      <textarea name="paste" placeholder="単元名	時数	指導目標	学習活動	評価規準	観点"></textarea>
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
      let rows;
      try { rows = parseTable(text); if (!rows.length) throw new Error('データが空です'); } catch (e) { toast('読み取りエラー: ' + e.message, 'error', 5000); return; }
      let det;
      try { det = detectColumns(rows); } catch (e) { toast('読み取りエラー: ' + e.message, 'error', 5000); return; }
      close();
      openMappingDialog(ctx, rows, det);
    };
  });
}

/** 列の対応づけ(マッピング)を確認・修正して取り込む。教科書会社ごとの列構成差に対応 */
function openMappingDialog(ctx, rows, det) {
  const s = store.settings;
  // 取込先の教科・学年(専科の複数学年・複式・担任の複数教科で「どこに入れるか」を選ばせる。学年厳格一致のため必須)
  const subjOpts = s.subjects.map(x => `<option value="${esc(x.key)}" ${x.key === ((s.mode === 'senka' && s.senkaSubject) ? s.senkaSubject : s.subjects[0]?.key) ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const grades = s.mode === 'senka' ? [...new Set((s.senkaClasses || []).map(c => c.grade).filter(Boolean))].sort((a, b) => a - b)
    : s.mode === 'fukushiki' ? [...(s.fukushikiGrades || [])] : [s.grade];
  const gradeOpts = `<option value="">全学年共通</option>` + grades.map(g => `<option value="${g}" ${g === defaultGrade(s) ? 'selected' : ''}>${g}年</option>`).join('');
  const fields = [
    { key: 'unit', label: '単元名', required: true },
    { key: 'hours', label: '時数', hint: '空の場合は1行=1時間として数えます' },
    { key: 'objective', label: '指導目標(本時のねらい)' },
    { key: 'activity', label: '学習活動' },
    { key: 'assessment', label: '評価規準' },
    { key: 'viewpoint', label: '観点' },
  ];
  const colOptions = (sel) => `<option value="-1" ${sel === -1 ? 'selected' : ''}>(なし)</option>` +
    det.header.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h)}</option>`).join('');

  const sampleRows = (det.hasHeader ? rows.slice(1) : rows).slice(0, 3);
  const sampleTable = `
    <table class="units-table" style="font-size:11px;">
      <thead><tr>${det.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${sampleRows.map(r => `<tr>${det.header.map((_, i) => `<td>${esc((r[i] || '').slice(0, 24))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;

  openModal(`
    <h2>列の対応を確認</h2>
    <p class="hint">貼り付けた表の各列を、アプリの項目に対応づけます(自動で推定済み。違っていれば直してください)。</p>
    <div class="map-grid">
      <div class="field"><label>取込先の教科</label><select id="imp-subj">${subjOpts}</select></div>
      <div class="field"><label>取込先の学年${infoHTML('この計画を使う学年。専科で5年・6年を持つなら学年ごとに取り込みます。「全学年共通」はどの学年のコマにも反映します')}</label><select id="imp-grade">${gradeOpts}</select></div>
      ${fields.map(f => `
        <div class="field"><label>${f.label}${f.required ? ' <span style="color:var(--danger)">*</span>' : ''}${f.hint ? infoHTML(f.hint) : ''}</label>
          <select data-map="${f.key}">${colOptions(det.cols[f.key])}</select></div>`).join('')}
    </div>
    <h3>先頭3行のプレビュー</h3>
    <div class="table-scroll">${sampleTable}</div>
    <p class="hint" id="map-result" style="margin-top:8px;"></p>
    <div class="modal-foot">
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-import>取り込む</button>
    </div>
  `, (modal, close) => {
    const readCols = () => {
      const c = {};
      modal.querySelectorAll('[data-map]').forEach(sel => { c[sel.dataset.map] = Number(sel.value); });
      return c;
    };
    const preview = () => {
      const cols = readCols();
      const el = modal.querySelector('#map-result');
      if (cols.unit < 0) { el.textContent = '「単元名」の列を選んでください'; el.style.color = 'var(--danger)'; return null; }
      try {
        const { units } = buildUnitsFromColumns(rows, det.hasHeader, cols);
        const total = units.reduce((a, u) => a + u.hours, 0);
        el.textContent = `→ ${units.length}単元・計${total}時間 として取り込みます`;
        el.style.color = '';
        return units;
      } catch (e) { el.textContent = e.message; el.style.color = 'var(--danger)'; return null; }
    };
    modal.querySelectorAll('[data-map]').forEach(sel => sel.addEventListener('change', preview));
    preview();
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-import]').onclick = () => {
      const units = preview();
      if (!units) return;
      const gv = modal.querySelector('#imp-grade').value;
      const plan = {
        id: uid(),
        subjectKey: modal.querySelector('#imp-subj').value || (s.subjects[0]?.key || ''),
        grade: gv ? Number(gv) : null, textbook: '', startOffset: 0, // 空=全学年共通(null)
        units: units.map(normUnit),
      };
      close();
      store.addPlan(plan);
      editState = { planId: plan.id, unitIdx: 0 };
      const gl = plan.grade ? `${plan.grade}年の` : '';
      toast(`${gl}${units.length}単元を取り込みました`);
      ctx.rerender();
    };
  });
}
