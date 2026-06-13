/**
 * 初回セットアップ(1画面・スキップ可)。
 * 質問は「学校種+学年」「担任のかたち」の2つだけ。完了で既定の教科・時程・標準時数が決まる。
 */

import { store, defaultSubjects, defaultPeriods } from '../store.js';
import { esc, uid } from '../utils.js';
import { openModal, toast, infoHTML } from '../ui.js';

export function renderOnboarding(root, ctx) {
  root.innerHTML = `
  <div class="onboarding">
    <div class="ob-card">
      <div class="ob-logo">📅</div>
      <h1>はじめましょう</h1>
      <p class="ob-sub">2つ選ぶだけで始められます</p>

      <div class="ob-q">
        <div class="ob-label">学校・学年</div>
        <div class="ob-row">
          <div class="ob-seg" id="ob-school">
            <button data-v="elementary" class="selected" aria-pressed="true">小学校</button>
            <button data-v="junior" aria-pressed="false">中学校</button>
          </div>
          <select id="ob-grade" aria-label="学年">${[1, 2, 3, 4, 5, 6].map(g => `<option value="${g}">${g}年</option>`).join('')}</select>
          <input id="ob-class" type="text" placeholder="組" aria-label="組" style="width:64px;">
        </div>
      </div>

      <div class="ob-q">
        <div class="ob-label">担任のかたち</div>
        <div class="ob-seg" id="ob-mode">
          <button data-v="homeroom" class="selected" aria-pressed="true">学級担任</button>
          <button data-v="senka" aria-pressed="false">専科・教科担任</button>
          <button data-v="fukushiki" aria-pressed="false">複式</button>
        </div>
      </div>

      <button class="btn primary ob-start" id="ob-start">はじめる</button>
      <button class="btn ghost ob-skip" id="ob-skip">あとで</button>
    </div>
  </div>`;

  const state = { schoolType: 'elementary', grade: 1, mode: 'homeroom' };

  const wireSeg = (id, onPick) => {
    root.querySelectorAll(`#${id} button`).forEach(b => {
      b.onclick = () => {
        root.querySelectorAll(`#${id} button`).forEach(x => {
          x.classList.toggle('selected', x === b);
          x.setAttribute('aria-pressed', String(x === b)); // 選択状態を支援技術にも伝える
        });
        onPick(b.dataset.v);
      };
    });
  };
  wireSeg('ob-school', v => {
    state.schoolType = v;
    const max = v === 'junior' ? 3 : 6;
    const sel = root.querySelector('#ob-grade');
    sel.innerHTML = Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}年</option>`).join('');
  });
  wireSeg('ob-mode', v => { state.mode = v; });

  const finish = (apply) => {
    if (apply) {
      const s = store.settings;
      s.schoolType = state.schoolType;
      s.subjects = defaultSubjects(state.schoolType);
      s.periods = defaultPeriods(state.schoolType);
      s.grade = Number(root.querySelector('#ob-grade').value) || 1;
      s.className = root.querySelector('#ob-class').value.trim();
      s.mode = state.mode;
      if (state.mode === 'senka' && !s.senkaClasses.length) {
        s.senkaClasses = [{ id: uid(), label: '', grade: s.grade }];
      }
      if (state.mode === 'fukushiki') {
        // 選んだ学年を下学年として複式の2学年を決める(既定の[5,6]のままだと
        // 中学校で範囲外になる・選んだ学年が週案に反映されない)
        const max = state.schoolType === 'junior' ? 3 : 6;
        s.fukushikiGrades = s.grade < max ? [s.grade, s.grade + 1] : [max - 1, max];
      }
      // 小1=34週/その他35週の既定を学年に追従(設定画面・年度更新ウィザードと同じ規則)
      const baseGrade = state.mode === 'fukushiki' ? s.fukushikiGrades[0] : s.grade;
      if (s.hoursBase === 34 || s.hoursBase === 35) {
        s.hoursBase = (state.schoolType === 'elementary' && state.mode !== 'senka' && baseGrade === 1) ? 34 : 35;
      }
    }
    localStorage.setItem('shuan-onboarded', '1');
    store.commit();
    store.persist();
    ctx.rerender();
  };

  root.querySelector('#ob-start').onclick = () => finish(true);
  root.querySelector('#ob-skip').onclick = () => finish(false);
}

/** 初回起動か(データ未保存かつ未完了) */
export function needsOnboarding() {
  return !localStorage.getItem('shuan-onboarded')
    && Object.keys(store.state.weeks).length === 0
    && store.state.plans.length === 0;
}

/**
 * 年度更新ウィザード。年度が進んだ最初の起動で、学年の繰り上げ・
 * 旧計画の整理・基本時間割のクリアをまとめて案内する(全項目スキップ可)。
 */
export function maybeYearRollover(ctx, oldFY, newFY) {
  const flagKey = `shuan-rollover-${newFY}`;
  if (localStorage.getItem(flagKey)) return;
  const s = store.settings;
  const gradeMax = s.schoolType === 'junior' ? 3 : 6;
  const gradeOptions = (selected) =>
    Array.from({ length: gradeMax }, (_, i) => `<option value="${i + 1}" ${i + 1 === selected ? 'selected' : ''}>${i + 1}年</option>`).join('');
  const nextGrade = Math.min(s.grade + 1, gradeMax);
  // 複式: 2学年とも繰り上げ。上学年が最高学年なら据え置き(同じ学年構成が続く想定)
  const [fg0, fg1] = s.fukushikiGrades;
  const nextFg = fg1 + 1 > gradeMax ? [fg0, fg1] : [fg0 + 1, fg1 + 1];
  const planCount = store.state.plans.length;
  const baseCount = store.state.baseTimetables.length;
  let handled = false;

  // 学級欄は担任形態ごとに変える(複式はfukushikiGradesが実体。s.gradeだけ
  // 更新しても週案・時数・印刷に反映されない。専科は学級一覧が実体)
  const classFields = s.mode === 'fukushiki' ? `
    <div style="display:flex; gap:10px;">
      <div class="field" style="flex:1;"><label>今年度の下学年</label>
        <select id="ro-fg0">${gradeOptions(nextFg[0])}</select>
      </div>
      <div class="field" style="flex:1;"><label>今年度の上学年</label>
        <select id="ro-fg1">${gradeOptions(nextFg[1])}</select>
      </div>
    </div>
    <div class="field"><label>組(任意)</label>
      <input type="text" id="ro-class" value="${esc(s.className || '')}" placeholder="" style="max-width:90px;">
    </div>`
    : s.mode === 'senka' ? `
    <div class="field" style="display:flex; align-items:center; gap:10px;">
      <span class="hint" style="margin:0;">担当する学級の一覧は「設定 → 担任形態」で見直せます。</span>
      <button class="btn small" id="ro-senka-set">設定を開く</button>
    </div>`
    : `
    <div class="field"><label>今年度の学年</label>
      <select id="ro-grade">${gradeOptions(nextGrade)}</select>
    </div>
    <div class="field"><label>組</label>
      <input type="text" id="ro-class" value="${esc(s.className || '')}" placeholder="1" style="max-width:90px;">
    </div>`;

  openModal(`
    <h2>${newFY}年度を始めますか?</h2>
    <p class="hint">昨年度(${oldFY}年度)のデータはそのまま残り、集計は年度ごとに自動で分かれます。</p>
    ${classFields}
    ${planCount ? `<div class="checkline"><input type="checkbox" id="ro-plans">
      <label for="ro-plans">年間指導計画 ${planCount}件を削除</label>${infoHTML('新学年の計画を取り込み直す場合にチェック。残しておけばそのまま使えます')}</div>` : ''}
    ${baseCount ? `<div class="checkline"><input type="checkbox" id="ro-base">
      <label for="ro-base">基本時間割 ${baseCount}件をクリア</label>${infoHTML('新しい時間割で作り直す場合にチェック')}</div>` : ''}
    ${(s.breaks || []).length ? `<div class="checkline"><input type="checkbox" id="ro-breaks" checked>
      <label for="ro-breaks">長期休業の日付を1年進めて引き継ぐ</label></div>` : ''}
    <div class="modal-foot">
      <button class="btn" data-skip>あとで</button>
      <button class="btn primary" data-apply>開始</button>
    </div>
  `, (modal, close) => {
    modal.querySelector('[data-skip]').onclick = () => {
      handled = true;
      localStorage.setItem(flagKey, '1');
      close();
    };
    const senkaSet = modal.querySelector('#ro-senka-set');
    if (senkaSet) senkaSet.onclick = () => {
      handled = true;
      localStorage.setItem(flagKey, '1');
      close();
      document.querySelector('.tab[data-tab="settings"]')?.click();
    };
    modal.querySelector('[data-apply]').onclick = () => {
      handled = true;
      if (s.mode === 'fukushiki') {
        const g0 = Number(modal.querySelector('#ro-fg0').value) || s.fukushikiGrades[0];
        const g1 = Number(modal.querySelector('#ro-fg1').value) || s.fukushikiGrades[1];
        s.fukushikiGrades = [Math.min(g0, g1), Math.max(g0, g1)];
        s.className = modal.querySelector('#ro-class').value.trim();
      } else if (s.mode !== 'senka') {
        s.grade = Number(modal.querySelector('#ro-grade').value) || s.grade;
        s.className = modal.querySelector('#ro-class').value.trim();
      }
      // 小1=34週/その他35週の既定を学年に追従(ユーザーが独自値にしている場合は触らない)
      const baseGrade = s.mode === 'fukushiki' ? s.fukushikiGrades[0] : s.grade;
      if (s.hoursBase === 34 || s.hoursBase === 35) {
        s.hoursBase = (s.schoolType === 'elementary' && s.mode !== 'senka' && baseGrade === 1) ? 34 : 35;
      }
      if (modal.querySelector('#ro-plans')?.checked) store.state.plans = [];
      if (modal.querySelector('#ro-base')?.checked) store.state.baseTimetables = [];
      if (modal.querySelector('#ro-breaks')?.checked) {
        const bump = (d) => d && /^\d{4}-/.test(d) ? `${Number(d.slice(0, 4)) + 1}${d.slice(4)}` : d;
        for (const b of s.breaks || []) { b.from = bump(b.from); b.to = bump(b.to); }
      }
      localStorage.setItem(flagKey, '1');
      store.commit();
      close();
      toast(`${newFY}年度の設定にしました`);
      ctx.rerender();
    };
  }, () => {
    // Esc・背景クリック・他処理によるクローズでも案内を残す(永久に消えないように)
    localStorage.setItem(flagKey, '1');
    if (!handled) {
      toast('あとで変更できます', 'info', 5000,
        { label: '設定を開く', onClick: () => document.querySelector('.tab[data-tab="settings"]')?.click() });
    }
  });
}
