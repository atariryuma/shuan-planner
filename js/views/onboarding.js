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
      <h1>週案プランナー</h1>
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
  const nextGrade = Math.min(s.grade + 1, gradeMax);
  const planCount = store.state.plans.length;
  const baseCount = store.state.baseTimetables.length;
  let handled = false;

  openModal(`
    <h2>${newFY}年度を始めますか?</h2>
    <p class="hint">昨年度(${oldFY}年度)のデータはそのまま残り、集計は年度ごとに自動で分かれます。</p>
    <div class="field"><label>今年度の学年</label>
      <select id="ro-grade">
        ${Array.from({ length: gradeMax }, (_, i) => `<option value="${i + 1}" ${i + 1 === nextGrade ? 'selected' : ''}>${i + 1}年</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>組</label>
      <input type="text" id="ro-class" value="${esc(s.className || '')}" placeholder="1" style="max-width:90px;">
    </div>
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
    modal.querySelector('[data-apply]').onclick = () => {
      handled = true;
      s.grade = Number(modal.querySelector('#ro-grade').value) || s.grade;
      s.className = modal.querySelector('#ro-class').value.trim();
      // 小1=34週/その他35週の既定を学年に追従(ユーザーが独自値にしている場合は触らない)
      if (s.hoursBase === 34 || s.hoursBase === 35) {
        s.hoursBase = (s.schoolType === 'elementary' && s.grade === 1) ? 34 : 35;
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
