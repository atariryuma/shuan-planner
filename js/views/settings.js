/** 設定ビュー: 基本情報・担任形態・時程(校時)・教科・印刷・GAS連携 */

import { store, defaultPeriods, defaultSubjects } from '../store.js';
import { openModal, toast, confirmDialog, selectHTML } from '../ui.js';
import { esc, uid } from '../utils.js';

export function renderSettingsView(root, ctx) {
  const s = store.settings;
  const isJunior = s.schoolType === 'junior';
  const gradeMax = isJunior ? 3 : 6;
  const gradeOpts = Array.from({ length: gradeMax }, (_, i) => ({ value: i + 1, label: `${i + 1}年` }));

  root.innerHTML = `
  <div class="settings-grid">

    <div class="panel">
      <h2>基本情報</h2>
      <div class="field"><label>学校名(印刷時に表示)</label>
        <input type="text" data-set="schoolName" value="${esc(s.schoolName)}" placeholder="○○市立○○小学校"></div>
      <div class="field"><label>氏名(印刷時に表示)</label>
        <input type="text" data-set="teacherName" value="${esc(s.teacherName)}" placeholder=""></div>
      <div class="field"><label>年度</label>
        <input type="number" data-set="fiscalYear" value="${esc(s.fiscalYear)}" min="2020" max="2099"></div>
      <div class="field"><label>学校種</label>
        ${selectHTML('schoolType', [
          { value: 'elementary', label: '小学校(45分授業)' },
          { value: 'junior', label: '中学校(50分授業)' },
        ], s.schoolType, { attrs: 'data-structural="schoolType"' })}
        <p class="hint">変更すると教科・時程が既定値にリセットされます。</p>
      </div>
      <div class="checkline"><input type="checkbox" id="set-sat" ${s.saturday ? 'checked' : ''}>
        <label for="set-sat">土曜授業あり(週6日表示)</label></div>
      <div class="field"><label>年間授業週数(時数の必要ペース計算に使用)</label>
        <input type="number" data-set="hoursBase" value="${esc(s.hoursBase)}" min="30" max="45">
        <p class="hint">小1は34週、その他は35週が標準。実際の運用(約40週)に合わせてもOK。</p></div>
    </div>

    <div class="panel">
      <h2>担任形態</h2>
      <div class="mode-cards">
        <button class="mode-card ${s.mode === 'homeroom' ? 'selected' : ''}" data-mode="homeroom">
          <span class="m-title">🏫 学級担任</span><span class="m-desc">1つの学級の全教科の週案を作る(小学校の基本形)</span>
        </button>
        <button class="mode-card ${s.mode === 'senka' ? 'selected' : ''}" data-mode="senka">
          <span class="m-title">🎵 専科・教科担任</span><span class="m-desc">複数の学級に同じ教科を教える(音楽・理科・英語専科、中学校)。学級ごとに進度を自動管理</span>
        </button>
        <button class="mode-card ${s.mode === 'fukushiki' ? 'selected' : ''}" data-mode="fukushiki">
          <span class="m-title">👥 複式学級</span><span class="m-desc">2つの学年を1枚の週案に上下併記。時数は学年別に集計</span>
        </button>
      </div>
      <div id="mode-detail" style="margin-top:14px;">${modeDetailHTML(s, gradeOpts)}</div>
    </div>

    <div class="panel">
      <h2>時程(校時)</h2>
      <p class="hint">「モジュール」は朝学習などの短時間学習の枠です。係数は1コマを何単位時間として数えるか
        (15分モジュール=1/3 → 0.333、教育課程外の朝活動なら 0)。</p>
      <table class="edit-table">
        <thead><tr><th style="width:64px;">表示名</th><th style="width:96px;">種別</th><th style="width:78px;">開始</th><th style="width:78px;">終了</th><th style="width:56px;">分</th><th style="width:64px;">係数</th><th class="ops"></th></tr></thead>
        <tbody id="periods-body">
          ${s.periods.map((p, i) => `
            <tr data-p="${i}">
              <td><input type="text" name="label" value="${esc(p.label)}"></td>
              <td>${selectHTML('type', [{ value: 'lesson', label: '授業' }, { value: 'module', label: 'モジュール' }], p.type)}</td>
              <td><input type="time" name="start" value="${esc(p.start || '')}"></td>
              <td><input type="time" name="end" value="${esc(p.end || '')}"></td>
              <td><input type="number" name="minutes" value="${esc(p.minutes)}" min="5" max="120"></td>
              <td><input type="number" name="coefficient" value="${esc(p.coefficient)}" min="0" max="2" step="0.001"></td>
              <td class="ops">
                <button class="btn small ghost" data-pup>↑</button>
                <button class="btn small ghost" data-pdown>↓</button>
                <button class="btn small ghost danger" data-prm>×</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <button class="btn small" id="period-add">＋ 校時を追加</button>
        <button class="btn small" id="period-add-mod">＋ モジュール枠を追加</button>
        <button class="btn small ghost" id="period-reset">既定に戻す</button>
      </div>

      <h3>日課表パターン(短縮・特別日課など)</h3>
      <p class="hint">通常と異なる時程のパターンを登録すると、週案の各曜日に割り当てられます(例: 水曜=B日課、テスト週=短縮40分)。</p>
      <div id="pattern-list" style="display:flex; flex-direction:column; gap:6px;">
        ${(s.periodPatterns || []).map((pat, i) => `
          <div class="plan-item" data-pat="${i}" style="padding:7px 12px;">
            <span class="p-subj">${esc(pat.name)}</span>
            <span class="p-meta">${Object.values(pat.overrides || {}).filter(o => o.enabled === false).length ? Object.values(pat.overrides).filter(o => o.enabled === false).length + '校時カット' : '時刻変更'}</span>
            <span class="spacer"></span>
            <button class="btn small" data-pat-edit>編集</button>
            <button class="btn small danger" data-pat-del>削除</button>
          </div>`).join('')}
      </div>
      <button class="btn small" id="pattern-add" style="margin-top:8px;">＋ パターンを追加</button>
    </div>

    <div class="panel">
      <h2>学期・表示</h2>
      <div class="field"><label>学期制</label>
        ${selectHTML('termSystem', [
          { value: 3, label: '3学期制' },
          { value: 2, label: '2学期制(前期・後期)' },
        ], s.termSystem)}
      </div>
      <div class="field"><label>学期の区切り(終了日)</label>
        <div class="inline" id="term-ends">
          ${(s.termEnds || []).map((md, i) => `<input type="text" data-term="${i}" value="${esc(md)}" placeholder="07-31" style="max-width:110px;" title="月-日(例: 07-31)">`).join('')}
        </div>
        <p class="hint">${s.termSystem === 2 ? '前期の最終日' : '1学期・2学期の最終日'}を「月-日」で入力(時数集計の学期別集計に使用)。</p>
      </div>
      <div class="checkline"><input type="checkbox" id="set-holidays" ${s.showHolidays ? 'checked' : ''}>
        <label for="set-holidays">祝日を表示する(自動計算)</label></div>
      <div class="checkline"><input type="checkbox" id="set-daynotes" ${s.showDayNotes ? 'checked' : ''}>
        <label for="set-daynotes">日ごとのメモ欄を表示する(画面のみ・印刷されません)</label></div>
    </div>

    <div class="panel">
      <h2>教科</h2>
      <p class="hint">色は画面・印刷の両方で使われます。学校独自の活動(「朝の会」「クラブ」等)も追加できます。</p>
      <table class="edit-table">
        <thead><tr><th>教科名</th><th style="width:64px;">略称</th><th style="width:56px;">色</th><th class="ops"></th></tr></thead>
        <tbody id="subjects-body">
          ${s.subjects.map((x, i) => `
            <tr data-s="${i}">
              <td><input type="text" name="name" value="${esc(x.name)}"></td>
              <td><input type="text" name="short" value="${esc(x.short || '')}" maxlength="3"></td>
              <td><input type="color" name="color" value="${esc(x.color)}"></td>
              <td class="ops">
                <button class="btn small ghost" data-sup>↑</button>
                <button class="btn small ghost danger" data-srm>×</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <button class="btn small" id="subject-add">＋ 教科を追加</button>
        <button class="btn small ghost" id="subject-reset">既定に戻す</button>
      </div>
    </div>

    <div class="panel">
      <h2>印刷</h2>
      <div class="print-options">
        <div class="field"><label>用紙の向き</label>
          ${selectHTML('printOrientation', [
            { value: 'landscape', label: 'A4 横(推奨)' },
            { value: 'portrait', label: 'A4 縦' },
          ], s.printOrientation)}
        </div>
        <div class="field"><label>文字サイズ</label>
          ${selectHTML('printFontSize', [
            { value: 'small', label: '小' }, { value: 'normal', label: '標準' }, { value: 'large', label: '大' },
          ], s.printFontSize)}
        </div>
      </div>
      <div class="checkline"><input type="checkbox" id="set-ptime" ${s.printShowTimes ? 'checked' : ''}>
        <label for="set-ptime">校時の時刻を印刷する</label></div>
      <div class="checkline"><input type="checkbox" id="set-phours" ${s.printShowHours ? 'checked' : ''}>
        <label for="set-phours">週の時数集計表を印刷する</label></div>
      <div class="field"><label>押印欄(空欄にすると非表示。「、」区切りで複数)</label>
        <input type="text" data-set="stampBoxesText" value="${esc((s.stampBoxes || []).join('、'))}" placeholder="校長、教頭、担任"></div>
      <p class="hint">印刷プレビューは画面右上の「🖨 印刷 / PDF」から。PDF保存はブラウザの印刷ダイアログで「PDFに保存」を選びます。</p>
    </div>

    <div class="panel">
      <h2>Google連携(GAS) <span class="hint" style="font-weight:normal;">任意</span></h2>
      <p class="hint">
        Google Apps Script(無料)をバックエンドにすると、<b>複数端末での同期</b>と<b>Googleカレンダーからの行事取り込み</b>が使えます。
        セットアップ手順は配布物の <code>docs/gas-setup.md</code>(リポジトリ内)を参照してください。設定しなくても全機能オフラインで動作します。
      </p>
      <div class="field"><label>GAS WebアプリURL(/exec で終わるURL)</label>
        <input type="text" data-gas="url" value="${esc(s.gas.url)}" placeholder="https://script.google.com/macros/s/XXXX/exec"></div>
      <div class="field"><label>同期トークン(GAS側のスクリプトプロパティ TOKEN と同じ値)</label>
        <input type="password" data-gas="token" value="${esc(s.gas.token)}"></div>
      <div style="display:flex; gap:8px;">
        <button class="btn" id="gas-test">接続テスト</button>
      </div>

      <h3>行事の取り込み元カレンダー</h3>
      <p class="hint">「📆 行事を取得」で読むカレンダーを選びます(未設定ならメインカレンダー)。学校行事用の共有カレンダーを追加するのがおすすめ。</p>
      <div id="gas-cal-list">
        ${(s.gas.calendarIds || []).length
          ? (s.gas.calendarIds || []).map(id => `<span class="subj-chip" style="background:#5d8aa8; margin:2px 4px 2px 0;">${esc(s.gas.calendarNames?.[id] || id)}</span>`).join('')
          : '<span class="hint">メインカレンダー(既定)</span>'}
      </div>
      <button class="btn small" id="gas-cal-pick" style="margin-top:6px;">カレンダーを選ぶ…</button>

      <h3>メール提出・バックアップ</h3>
      <div class="field"><label>週案のメール提出先(管理職など)</label>
        <input type="text" data-gas="mailTo" value="${esc(s.gas.mailTo || '')}" placeholder="kocho@example.jp"></div>
      <div class="field"><label>メールの差出人表示名(任意)</label>
        <input type="text" data-gas="senderName" value="${esc(s.gas.senderName || '')}" placeholder="${esc(s.teacherName || '○○')}"></div>
      <div class="checkline"><input type="checkbox" id="gas-autobackup" ${s.gas.autoBackup ? 'checked' : ''}>
        <label for="gas-autobackup">「サーバーへ送信」時にGoogleドライブへもバックアップする(最新20世代を保持)</label></div>

      <p class="hint" style="margin-top:8px;">⚠ 児童生徒の個人名などの個人情報は同期データに含めない運用を推奨します(備考はイニシャル等で)。</p>
    </div>
  </div>
  `;

  wireSettings(root, ctx);
}

function modeDetailHTML(s, gradeOpts) {
  if (s.mode === 'homeroom') {
    return `
      <div style="display:flex; gap:10px;">
        <div class="field" style="flex:1;"><label>学年</label>${selectHTML('grade', gradeOpts, s.grade, { attrs: 'data-structural="grade"' })}</div>
        <div class="field" style="flex:1;"><label>組(任意)</label><input type="text" data-set="className" value="${esc(s.className)}" placeholder="1組"></div>
      </div>`;
  }
  if (s.mode === 'fukushiki') {
    return `
      <div style="display:flex; gap:10px;">
        <div class="field" style="flex:1;"><label>下学年</label>${selectHTML('fg0', gradeOpts, s.fukushikiGrades[0], { attrs: 'data-structural="fg0"' })}</div>
        <div class="field" style="flex:1;"><label>上学年</label>${selectHTML('fg1', gradeOpts, s.fukushikiGrades[1], { attrs: 'data-structural="fg1"' })}</div>
        <div class="field" style="flex:1;"><label>組(任意)</label><input type="text" data-set="className" value="${esc(s.className)}" placeholder=""></div>
      </div>
      <p class="hint">各コマに2学年分の欄が表示され、時数は学年別に集計されます。年間指導計画は学年ごとに登録してください。</p>`;
  }
  // senka
  const gradeMax = s.schoolType === 'junior' ? 3 : 6;
  return `
    <p class="hint">担当する学級を登録すると、コマごとに学級を選べるようになり、<b>学級ごとに単元の進度を自動追跡</b>します(行事などで学級間の進度がずれてもOK)。</p>
    <table class="edit-table">
      <thead><tr><th>学級名</th><th style="width:90px;">学年</th><th class="ops"></th></tr></thead>
      <tbody id="senka-body">
        ${s.senkaClasses.map((c, i) => `
          <tr data-c="${i}">
            <td><input type="text" name="label" value="${esc(c.label)}" placeholder="5年1組"></td>
            <td>${selectHTML('grade', Array.from({ length: gradeMax }, (_, g) => ({ value: g + 1, label: `${g + 1}年` })), c.grade)}</td>
            <td class="ops"><button class="btn small ghost danger" data-crm>×</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <button class="btn small" id="senka-add" style="margin-top:8px;">＋ 学級を追加</button>`;
}

function wireSettings(root, ctx) {
  const s = store.settings;

  // 単純テキスト/数値(再描画不要)
  root.querySelectorAll('[data-set]').forEach(inp => {
    inp.addEventListener('change', () => {
      const key = inp.dataset.set;
      if (key === 'stampBoxesText') {
        s.stampBoxes = inp.value.split(/[、,]/).map(t => t.trim()).filter(Boolean);
      } else if (inp.type === 'number') {
        s[key] = Number(inp.value);
      } else {
        s[key] = inp.value;
      }
      store.commit();
    });
  });

  // 学校種(リセットを伴う)
  root.querySelector('[name="schoolType"]').addEventListener('change', async (ev) => {
    const v = ev.target.value;
    if (v === s.schoolType) return;
    const ok = await confirmDialog('学校種を変更すると、教科と時程が既定値にリセットされます。よろしいですか?\n(週案・年間指導計画のデータは残りますが、教科の対応を確認してください)', { okLabel: '変更する', danger: true });
    if (!ok) { ev.target.value = s.schoolType; return; }
    s.schoolType = v;
    s.subjects = defaultSubjects(v);
    s.periods = defaultPeriods(v);
    if (v === 'junior' && s.grade > 3) s.grade = 1;
    store.commit();
    ctx.rerender();
  });

  // 学年・複式学年(再描画して標準時数等を更新)
  const gradeSel = root.querySelector('[name="grade"][data-structural]');
  if (gradeSel) gradeSel.addEventListener('change', () => { s.grade = Number(gradeSel.value); store.commit(); ctx.rerender(); });
  const fg0 = root.querySelector('[name="fg0"]');
  if (fg0) fg0.addEventListener('change', () => { s.fukushikiGrades[0] = Number(fg0.value); store.commit(); ctx.rerender(); });
  const fg1 = root.querySelector('[name="fg1"]');
  if (fg1) fg1.addEventListener('change', () => { s.fukushikiGrades[1] = Number(fg1.value); store.commit(); ctx.rerender(); });

  // 土曜・印刷チェック
  root.querySelector('#set-sat').addEventListener('change', (ev) => { s.saturday = ev.target.checked; store.commit(); ctx.rerender(); });
  root.querySelector('#set-ptime').addEventListener('change', (ev) => { s.printShowTimes = ev.target.checked; store.commit(); });
  root.querySelector('#set-phours').addEventListener('change', (ev) => { s.printShowHours = ev.target.checked; store.commit(); });
  root.querySelector('[name="printOrientation"]').addEventListener('change', (ev) => { s.printOrientation = ev.target.value; store.commit(); });
  root.querySelector('[name="printFontSize"]').addEventListener('change', (ev) => { s.printFontSize = ev.target.value; store.commit(); });

  // 担任形態
  root.querySelectorAll('.mode-card').forEach(card => {
    card.onclick = () => {
      if (s.mode === card.dataset.mode) return;
      s.mode = card.dataset.mode;
      if (s.mode === 'senka' && !s.senkaClasses.length) {
        s.senkaClasses = [{ id: uid(), label: '', grade: s.grade || 1 }];
      }
      store.commit();
      ctx.rerender();
    };
  });

  // 専科学級テーブル
  const senkaBody = root.querySelector('#senka-body');
  if (senkaBody) {
    senkaBody.querySelectorAll('tr').forEach(tr => {
      const i = Number(tr.dataset.c);
      tr.querySelector('[name="label"]').addEventListener('change', (ev) => { s.senkaClasses[i].label = ev.target.value; store.commit(); });
      tr.querySelector('[name="grade"]').addEventListener('change', (ev) => { s.senkaClasses[i].grade = Number(ev.target.value); store.commit(); });
      tr.querySelector('[data-crm]').onclick = async () => {
        const ok = await confirmDialog(`学級「${s.senkaClasses[i].label || '(無名)'}」を削除しますか?\n(入力済みの週案のコマは残ります)`, { okLabel: '削除', danger: true });
        if (!ok) return;
        s.senkaClasses.splice(i, 1);
        store.commit(); ctx.rerender();
      };
    });
    root.querySelector('#senka-add').onclick = () => {
      s.senkaClasses.push({ id: uid(), label: '', grade: s.grade || 1 });
      store.commit(); ctx.rerender();
    };
  }

  // 時程テーブル
  root.querySelectorAll('#periods-body tr').forEach(tr => {
    const i = Number(tr.dataset.p);
    const p = s.periods[i];
    tr.querySelector('[name="label"]').addEventListener('change', (ev) => { p.label = ev.target.value; store.commit(); });
    tr.querySelector('[name="type"]').addEventListener('change', (ev) => { p.type = ev.target.value; store.commit(); ctx.rerender(); });
    tr.querySelector('[name="start"]').addEventListener('change', (ev) => { p.start = ev.target.value; store.commit(); });
    tr.querySelector('[name="end"]').addEventListener('change', (ev) => { p.end = ev.target.value; store.commit(); });
    tr.querySelector('[name="minutes"]').addEventListener('change', (ev) => {
      p.minutes = Number(ev.target.value);
      // 授業種別なら係数は1のまま。モジュールなら分数から自動提案
      if (p.type === 'module') {
        const base = s.schoolType === 'junior' ? 50 : 45;
        p.coefficient = Math.round((p.minutes / base) * 1000) / 1000;
      }
      store.commit(); ctx.rerender();
    });
    tr.querySelector('[name="coefficient"]').addEventListener('change', (ev) => { p.coefficient = Number(ev.target.value); store.commit(); });
    tr.querySelector('[data-prm]').onclick = async () => {
      const ok = await confirmDialog(`校時「${p.label}」を削除しますか?(この校時に入力済みのコマは表示されなくなります)`, { okLabel: '削除', danger: true });
      if (!ok) return;
      s.periods.splice(i, 1); store.commit(); ctx.rerender();
    };
    tr.querySelector('[data-pup]').onclick = () => { if (i > 0) { swap(s.periods, i, i - 1); store.commit(); ctx.rerender(); } };
    tr.querySelector('[data-pdown]').onclick = () => { if (i < s.periods.length - 1) { swap(s.periods, i, i + 1); store.commit(); ctx.rerender(); } };
  });
  root.querySelector('#period-add').onclick = () => {
    const base = s.schoolType === 'junior' ? 50 : 45;
    const n = s.periods.filter(p => p.type === 'lesson').length + 1;
    s.periods.push({ id: uid(), label: String(n), type: 'lesson', minutes: base, coefficient: 1, start: '', end: '' });
    store.commit(); ctx.rerender();
  };
  root.querySelector('#period-add-mod').onclick = () => {
    const base = s.schoolType === 'junior' ? 50 : 45;
    s.periods.push({ id: uid(), label: 'モ', type: 'module', minutes: 15, coefficient: Math.round((15 / base) * 1000) / 1000, start: '', end: '' });
    store.commit(); ctx.rerender();
  };
  root.querySelector('#period-reset').onclick = async () => {
    const ok = await confirmDialog('時程を既定値に戻しますか?', { okLabel: '戻す' });
    if (!ok) return;
    s.periods = defaultPeriods(s.schoolType);
    store.commit(); ctx.rerender();
  };

  // 日課表パターン(新規はドラフトで開き、保存時にのみ追加する=キャンセルでゴミが残らない)
  root.querySelector('#pattern-add').onclick = () => {
    const pat = { id: uid(), name: `パターン${(s.periodPatterns?.length || 0) + 1}`, overrides: {} };
    openPatternEditor(pat, ctx, { isNew: true });
  };
  root.querySelectorAll('[data-pat]').forEach(el => {
    const pat = s.periodPatterns[Number(el.dataset.pat)];
    el.querySelector('[data-pat-edit]').onclick = () => openPatternEditor(pat, ctx);
    el.querySelector('[data-pat-del]').onclick = async () => {
      const ok = await confirmDialog(`日課表パターン「${pat.name}」を削除しますか?\n(このパターンを割り当てていた曜日は通常日課に戻ります)`, { okLabel: '削除', danger: true });
      if (!ok) return;
      s.periodPatterns = s.periodPatterns.filter(p => p.id !== pat.id);
      store.commit(); ctx.rerender();
    };
  });

  // 学期
  root.querySelector('[name="termSystem"]').addEventListener('change', (ev) => {
    s.termSystem = Number(ev.target.value);
    s.termEnds = s.termSystem === 2 ? ['09-30'] : ['07-31', '12-31'];
    store.commit(); ctx.rerender();
  });
  root.querySelectorAll('#term-ends input').forEach(inp => {
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      const match = /^(\d{1,2})-(\d{1,2})$/.exec(v);
      const m = match ? Number(match[1]) : 0;
      const d = match ? Number(match[2]) : 0;
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        s.termEnds[Number(inp.dataset.term)] = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        store.commit();
      } else {
        toast('「月-日」の形式で入力してください(例: 07-31)', 'error');
        inp.value = s.termEnds[Number(inp.dataset.term)];
      }
    });
  });
  root.querySelector('#set-holidays').addEventListener('change', (ev) => { s.showHolidays = ev.target.checked; store.commit(); });
  root.querySelector('#set-daynotes').addEventListener('change', (ev) => { s.showDayNotes = ev.target.checked; store.commit(); });

  // 教科テーブル
  root.querySelectorAll('#subjects-body tr').forEach(tr => {
    const i = Number(tr.dataset.s);
    const x = s.subjects[i];
    tr.querySelector('[name="name"]').addEventListener('change', (ev) => { x.name = ev.target.value; store.commit(); });
    tr.querySelector('[name="short"]').addEventListener('change', (ev) => { x.short = ev.target.value; store.commit(); });
    tr.querySelector('[name="color"]').addEventListener('change', (ev) => { x.color = ev.target.value; store.commit(); });
    tr.querySelector('[data-srm]').onclick = async () => {
      const ok = await confirmDialog(`教科「${x.name}」を削除しますか?(入力済みのコマの教科表示が消えます)`, { okLabel: '削除', danger: true });
      if (!ok) return;
      s.subjects.splice(i, 1); store.commit(); ctx.rerender();
    };
    tr.querySelector('[data-sup]').onclick = () => { if (i > 0) { swap(s.subjects, i, i - 1); store.commit(); ctx.rerender(); } };
  });
  root.querySelector('#subject-add').onclick = () => {
    s.subjects.push({ key: uid(), name: '', short: '', color: '#888888' });
    store.commit(); ctx.rerender();
  };
  root.querySelector('#subject-reset').onclick = async () => {
    const ok = await confirmDialog('教科リストを既定値に戻しますか?(独自に追加した教科は消えます)', { okLabel: '戻す', danger: true });
    if (!ok) return;
    s.subjects = defaultSubjects(s.schoolType);
    store.commit(); ctx.rerender();
  };

  // GAS
  root.querySelectorAll('[data-gas]').forEach(inp => {
    inp.addEventListener('change', () => {
      s.gas[inp.dataset.gas] = inp.value.trim();
      store.commit();
    });
  });
  root.querySelector('#gas-test').onclick = async () => {
    try {
      toast('接続テスト中…');
      const res = await ctx.gas.ping();
      toast(`✅ 接続成功 (${res.time || 'pong'})`);
    } catch (e) {
      toast('❌ 接続失敗: ' + e.message, 'error', 6000);
    }
  };

  root.querySelector('#gas-autobackup').addEventListener('change', (ev) => {
    s.gas.autoBackup = ev.target.checked;
    store.commit();
  });

  // カレンダー選択(一覧を取得してチェックボックスで選ぶ)
  root.querySelector('#gas-cal-pick').onclick = async () => {
    if (!ctx.gas.configured) { toast('先にGASのURLとトークンを設定してください', 'error', 4000); return; }
    try {
      toast('カレンダー一覧を取得中…');
      const res = await ctx.gas.calendars();
      const selected = new Set(s.gas.calendarIds || []);
      const items = (res.calendars || []).map((c, i) => `
        <div class="checkline">
          <input type="checkbox" id="calpick-${i}" value="${esc(c.id)}" data-name="${esc(c.name)}"
            ${selected.has(c.id) || (!selected.size && c.primary) ? 'checked' : ''}>
          <label for="calpick-${i}">${esc(c.name)}${c.primary ? '(メイン)' : ''}</label>
        </div>`).join('');
      openModal(`
        <h2>行事の取り込み元カレンダー</h2>
        <p class="hint">チェックしたカレンダーの予定が「📆 行事を取得」で行事欄に入ります。</p>
        <div style="max-height:50vh; overflow-y:auto;">${items || '<p class="hint">カレンダーが見つかりません</p>'}</div>
        <div class="modal-foot">
          <button class="btn" data-cancel>キャンセル</button>
          <button class="btn primary" data-save>保存</button>
        </div>
      `, (modal, close) => {
        modal.querySelector('[data-cancel]').onclick = close;
        modal.querySelector('[data-save]').onclick = () => {
          const ids = [];
          const names = {};
          modal.querySelectorAll('input[type="checkbox"]:checked').forEach(chk => {
            ids.push(chk.value);
            names[chk.value] = chk.dataset.name;
          });
          s.gas.calendarIds = ids;
          s.gas.calendarNames = names;
          store.commit();
          close();
          ctx.rerender();
        };
      });
    } catch (e) {
      toast('取得失敗: ' + e.message, 'error', 6000);
    }
  };
}

function swap(arr, i, j) { [arr[i], arr[j]] = [arr[j], arr[i]]; }

/** 日課表パターンの編集モーダル。校時ごとに有効/時刻/分/係数を上書きできる */
function openPatternEditor(pat, ctx, { isNew = false } = {}) {
  const s = store.settings;
  const rows = s.periods.map(p => {
    const ov = pat.overrides?.[p.id] || {};
    const enabled = ov.enabled !== false;
    return `
      <tr data-period="${esc(p.id)}">
        <td style="text-align:center;"><input type="checkbox" name="enabled" ${enabled ? 'checked' : ''} title="この校時を行う"></td>
        <td style="text-align:center; font-weight:600;">${esc(p.label)}</td>
        <td><input type="time" name="start" value="${esc(ov.start ?? p.start ?? '')}"></td>
        <td><input type="time" name="end" value="${esc(ov.end ?? p.end ?? '')}"></td>
        <td><input type="number" name="minutes" value="${esc(ov.minutes ?? p.minutes)}" min="5" max="120"></td>
        <td><input type="number" name="coefficient" value="${esc(ov.coefficient ?? p.coefficient)}" min="0" max="2" step="0.001"></td>
      </tr>`;
  }).join('');

  openModal(`
    <h2>日課表パターンの編集</h2>
    <div class="field"><label>パターン名</label>
      <input type="text" name="patname" value="${esc(pat.name)}" placeholder="例: 短縮日課 / B日課 / テスト時程"></div>
    <p class="hint">チェックを外した校時はその日課の日に表示されません。分・係数は時数集計に反映されます(40分授業でも1時数と数える運用なら係数は1のまま)。</p>
    <table class="edit-table">
      <thead><tr><th style="width:44px;">実施</th><th style="width:54px;">校時</th><th>開始</th><th>終了</th><th style="width:60px;">分</th><th style="width:70px;">係数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="modal-foot">
      <button class="btn" data-cancel>キャンセル</button>
      <button class="btn primary" data-save>保存</button>
    </div>
  `, (modal, close) => {
    modal.querySelector('[data-cancel]').onclick = close;
    modal.querySelector('[data-save]').onclick = () => {
      pat.name = modal.querySelector('[name="patname"]').value.trim() || pat.name;
      const overrides = {};
      modal.querySelectorAll('tbody tr').forEach(tr => {
        const pid = tr.dataset.period;
        const master = s.periods.find(p => p.id === pid);
        if (!master) return;
        const ov = {};
        if (!tr.querySelector('[name="enabled"]').checked) ov.enabled = false;
        const start = tr.querySelector('[name="start"]').value;
        const end = tr.querySelector('[name="end"]').value;
        const minutes = Number(tr.querySelector('[name="minutes"]').value);
        // 空欄は「変更なし」。Number('')=0 が係数0として保存されるのを防ぐ
        const rawCoef = tr.querySelector('[name="coefficient"]').value.trim();
        const coefficient = Number(rawCoef);
        if (start && start !== master.start) ov.start = start;
        if (end && end !== master.end) ov.end = end;
        if (minutes && minutes !== master.minutes) ov.minutes = minutes;
        if (rawCoef !== '' && isFinite(coefficient) && coefficient >= 0 && coefficient !== master.coefficient) ov.coefficient = coefficient;
        if (Object.keys(ov).length) overrides[pid] = ov;
      });
      pat.overrides = overrides;
      if (isNew) {
        s.periodPatterns = s.periodPatterns || [];
        s.periodPatterns.push(pat);
      }
      store.commit();
      close();
      ctx.rerender();
    };
  });
}
