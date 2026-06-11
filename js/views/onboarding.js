/**
 * 初回セットアップ(1画面・スキップ可)。
 * 質問は「学校種+学年」「担任のかたち」の2つだけ。完了で既定の教科・時程・標準時数が決まる。
 */

import { store, defaultSubjects, defaultPeriods } from '../store.js';
import { esc, uid } from '../utils.js';

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
            <button data-v="elementary" class="selected">小学校</button>
            <button data-v="junior">中学校</button>
          </div>
          <select id="ob-grade">${[1, 2, 3, 4, 5, 6].map(g => `<option value="${g}">${g}年</option>`).join('')}</select>
          <input id="ob-class" type="text" placeholder="組" style="width:64px;">
        </div>
      </div>

      <div class="ob-q">
        <div class="ob-label">担任のかたち</div>
        <div class="ob-seg" id="ob-mode">
          <button data-v="homeroom" class="selected">学級担任</button>
          <button data-v="senka">専科・教科担任</button>
          <button data-v="fukushiki">複式</button>
        </div>
      </div>

      <button class="btn primary ob-start" id="ob-start">はじめる</button>
      <button class="btn ghost ob-skip" id="ob-skip">あとで設定する</button>
    </div>
  </div>`;

  const state = { schoolType: 'elementary', grade: 1, mode: 'homeroom' };

  const wireSeg = (id, onPick) => {
    root.querySelectorAll(`#${id} button`).forEach(b => {
      b.onclick = () => {
        root.querySelectorAll(`#${id} button`).forEach(x => x.classList.toggle('selected', x === b));
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
