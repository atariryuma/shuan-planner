/** 設定ビュー: 基本情報・担任形態・時程(校時)・教科・印刷・GAS連携 */

import { store, defaultPeriods, defaultSubjects, cellKey } from '../store.js';
import { openModal, toast, confirmDialog, selectHTML, infoHTML } from '../ui.js';
import { esc, uid } from '../utils.js';

export function renderSettingsView(root, ctx) {
  const s = store.settings;
  const isJunior = s.schoolType === 'junior';
  const gradeMax = isJunior ? 3 : 6;
  const gradeOpts = Array.from({ length: gradeMax }, (_, i) => ({ value: i + 1, label: `${i + 1}年` }));

  root.innerHTML = `
  <nav class="settings-nav" aria-label="設定の項目">
    <button class="set-chip" data-goto="sp-basic"><span class="chip-ic">🏫</span>基本</button>
    <button class="set-chip" data-goto="sp-mode"><span class="chip-ic">👤</span>担任形態</button>
    <button class="set-chip" data-goto="sp-schedule"><span class="chip-ic">🕒</span>時程</button>
    <button class="set-chip" data-goto="sp-year"><span class="chip-ic">📅</span>年間・学期</button>
    <button class="set-chip" data-goto="sp-display"><span class="chip-ic">👁</span>表示</button>
    <button class="set-chip" data-goto="sp-subjects"><span class="chip-ic">🎨</span>教科</button>
    <button class="set-chip" data-goto="sp-print"><span class="chip-ic">🖨</span>印刷</button>
    <button class="set-chip" data-goto="sp-google"><span class="chip-ic">☁️</span>Google連携</button>
  </nav>
  <div class="settings-grid cat-view">

    <div class="panel" id="sp-basic">
      <h2>基本情報</h2>
      <div class="field"><label>学校名</label>
        <input type="text" data-set="schoolName" value="${esc(s.schoolName)}" placeholder="○○市立○○小学校"></div>
      <div class="field"><label>氏名</label>
        <input type="text" data-set="teacherName" value="${esc(s.teacherName)}"></div>
      ${s.mode === 'homeroom' ? `
      <div class="field"><label>学年・組</label>
        <div class="inline" style="align-items:center;">
          ${selectHTML('grade', gradeOpts, s.grade, { attrs: 'data-structural="grade" style="max-width:110px;"' })}
          <input type="text" data-set="className" value="${esc(s.className)}" placeholder="1" aria-label="組" style="max-width:80px;">
          <span class="hint" id="class-preview" style="white-space:nowrap;">→ 印刷: ${s.grade}年${esc(s.className || '')}</span>
        </div>
      </div>` : ''}
      <div class="field"><label>学校種${infoHTML('変更すると教科・時程が既定値にリセットされます')}</label>
        ${selectHTML('schoolType', [
          { value: 'elementary', label: '小学校(45分授業)' },
          { value: 'junior', label: '中学校(50分授業)' },
        ], s.schoolType, { attrs: 'data-structural="schoolType"' })}
      </div>
      <div class="checkline"><input type="checkbox" id="set-sat" ${s.saturday ? 'checked' : ''}>
        <label for="set-sat">土曜授業あり</label></div>
    </div>

    <div class="panel" id="sp-mode">
      <h2>担任形態</h2>
      <div class="mode-cards">
        <button class="mode-card ${s.mode === 'homeroom' ? 'selected' : ''}" data-mode="homeroom" aria-pressed="${s.mode === 'homeroom'}">
          <span class="m-title">学級担任</span><span class="m-desc">1つの学級の全教科の週案を作る(小学校の基本形)</span>
        </button>
        <button class="mode-card ${s.mode === 'senka' ? 'selected' : ''}" data-mode="senka" aria-pressed="${s.mode === 'senka'}">
          <span class="m-title">専科・教科担任</span><span class="m-desc">複数の学級に同じ教科を教える(音楽・理科・英語専科、中学校)。学級ごとに進度を自動管理</span>
        </button>
        <button class="mode-card ${s.mode === 'fukushiki' ? 'selected' : ''}" data-mode="fukushiki" aria-pressed="${s.mode === 'fukushiki'}">
          <span class="m-title">複式学級</span><span class="m-desc">2つの学年を1枚の週案に上下併記。時数は学年別に集計</span>
        </button>
      </div>
      <div id="mode-detail" style="margin-top:14px;">${modeDetailHTML(s, gradeOpts)}</div>
    </div>

    <div class="panel" id="sp-schedule">
      <h2>時程${infoHTML('1校時〜の時間割の枠。係数は時数の数え方です')}</h2>
      <div class="table-scroll">
      <table class="edit-table">
        <thead><tr><th style="width:64px;">表示名</th><th style="width:96px;">種別</th><th style="width:78px;">開始</th><th style="width:78px;">終了</th><th style="width:56px;">分</th><th style="width:64px;">係数${infoHTML('1コマを何時間と数えるか。15分モジュール=1/3(0.333…)、教育課程外の朝活動=0')}</th><th class="ops"></th></tr></thead>
        <tbody id="periods-body">
          ${s.periods.map((p, i) => `
            <tr data-p="${i}">
              <td><input type="text" name="label" value="${esc(p.label)}" aria-label="${esc(p.label)}校時の表示名"></td>
              <td>${selectHTML('type', [{ value: 'lesson', label: '授業' }, { value: 'module', label: 'モジュール' }], p.type, { attrs: `aria-label="${esc(p.label)}校時の種別"` })}</td>
              <td><input type="time" name="start" value="${esc(p.start || '')}" aria-label="${esc(p.label)}校時の開始時刻"></td>
              <td><input type="time" name="end" value="${esc(p.end || '')}" aria-label="${esc(p.label)}校時の終了時刻"></td>
              <td><input type="number" name="minutes" value="${esc(p.minutes)}" min="5" max="120" aria-label="${esc(p.label)}校時の分"></td>
              <td><input type="number" name="coefficient" value="${esc(p.coefficient)}" min="0" max="2" step="0.001" aria-label="${esc(p.label)}校時の係数"></td>
              <td class="ops">
                <button class="btn small ghost" data-pup aria-label="上へ" title="上へ">↑</button>
                <button class="btn small ghost" data-pdown aria-label="下へ" title="下へ">↓</button>
                <button class="btn small ghost danger" data-prm aria-label="削除" title="削除">×</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
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

    <div class="panel" id="sp-year">
      <h2>年間・学期</h2>
      <div class="field"><label>年度</label>
        <div style="padding:7px 2px; font-size:14px;">${esc(s.fiscalYear)}年度 <span class="hint">(日付から自動。新年度は4月に自動で切り替わります)</span></div></div>
      <div class="field"><label>年間授業週数${infoHTML('時数の必要ペース計算に使用。小1=34週、その他35週が標準')}</label>
        <input type="number" data-set="hoursBase" value="${esc(s.hoursBase)}" min="30" max="45"></div>
      <div class="field"><label>学期制</label>
        ${selectHTML('termSystem', [
          { value: 3, label: '3学期制' },
          { value: 2, label: '2学期制(前期・後期)' },
        ], s.termSystem)}
      </div>
      <div class="field"><label>学期の区切り${infoHTML('各学期の最終日。時数集計の学期別集計に使います')}</label>
        <div class="inline" id="term-ends" style="flex-wrap:wrap; gap:10px;">
          ${(s.termEnds || []).map((md, i) => {
            const [m, d] = (md || '7-31').split('-').map(Number);
            const months = Array.from({ length: 12 }, (_, k) => ({ value: k + 1, label: `${k + 1}月` }));
            const days = Array.from({ length: 31 }, (_, k) => ({ value: k + 1, label: `${k + 1}日` }));
            const termName = s.termSystem === 2 ? '前期' : `${i + 1}学期`;
            return `<span style="display:inline-flex; align-items:center; gap:4px; white-space:nowrap;">
              <span class="hint">${termName}まで</span>
              ${selectHTML(`term-m-${i}`, months, m || 7, { attrs: `data-term-m="${i}" aria-label="${termName}の最終月" style="width:auto;"` })}
              ${selectHTML(`term-d-${i}`, days, d || 31, { attrs: `data-term-d="${i}" aria-label="${termName}の最終日" style="width:auto;"` })}
            </span>`;
          }).join('')}
        </div>
      </div>

      <h3>長期休業${infoHTML('夏休みなどを登録すると、時数の「必要ペース」が残りの授業週数で正しく計算され、休業中の週に表示が出ます')}</h3>
      <div class="table-scroll">
      <table class="edit-table">
        <thead><tr><th>名前</th><th style="width:128px;">開始</th><th style="width:128px;">終了</th><th class="ops"></th></tr></thead>
        <tbody id="breaks-body">
          ${(s.breaks || []).map((b, i) => `
            <tr data-b="${i}">
              <td><input type="text" name="bname" value="${esc(b.name)}" placeholder="夏季休業" aria-label="休業${i + 1}の名前"></td>
              <td><input type="date" name="bfrom" value="${esc(b.from || '')}" aria-label="${esc(b.name || `休業${i + 1}`)}の開始日"></td>
              <td><input type="date" name="bto" value="${esc(b.to || '')}" aria-label="${esc(b.name || `休業${i + 1}`)}の終了日"></td>
              <td class="ops"><button class="btn small ghost danger" data-brm aria-label="削除" title="削除">×</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
      <button class="btn small" id="break-add" style="margin-top:8px;">＋ 休業を追加</button>
    </div>

    <div class="panel" id="sp-display">
      <h2>表示</h2>
      <div class="field"><label>画面の文字サイズ</label>
        ${selectHTML('uiScale', [
          { value: 'normal', label: '標準' },
          { value: 'large', label: '大' },
        ], s.uiScale)}
      </div>
      <div class="checkline"><input type="checkbox" id="set-holidays" ${s.showHolidays ? 'checked' : ''}>
        <label for="set-holidays">祝日を表示</label></div>
      <div class="checkline"><input type="checkbox" id="set-daynotes" ${s.showDayNotes ? 'checked' : ''}>
        <label for="set-daynotes">日ごとのメモ欄</label>${infoHTML('自分用メモ。画面のみで印刷されません')}</div>
      <div class="checkline"><input type="checkbox" id="set-attendance" ${s.showAttendance ? 'checked' : ''}>
        <label for="set-attendance">出欠メモ欄</label>${infoHTML('欠席・遅刻などの記録欄。印刷にも出ます(週案簿の出欠欄)')}</div>
    </div>

    <div class="panel" id="sp-subjects">
      <h2>教科</h2>
      <p class="hint">色は画面・印刷の両方で使われます。学校独自の活動(「朝の会」「クラブ」等)も追加できます。</p>
      <div class="table-scroll">
      <table class="edit-table">
        <thead><tr><th>教科名</th><th style="width:64px;">略称</th><th style="width:56px;">色</th><th style="width:104px;">合算先${infoHTML('時数をこの教科に合算します(例: 書写→国語、読書タイム→国語)。集計・印刷・CSVすべてに反映')}</th><th class="ops"></th></tr></thead>
        <tbody id="subjects-body">
          ${s.subjects.map((x, i) => {
            // 合算先の候補: 自分以外で、それ自身が合算先を持たない教科。
            // さらに「自分が誰かの合算先になっている教科」には親を付けさせない(連鎖を双方向で防ぐ)
            const hasChildren = s.subjects.some(c => c.parent === x.key);
            const parentOpts = hasChildren ? [] : s.subjects.filter(p => p.key !== x.key && !p.parent)
              .map(p => ({ value: p.key, label: p.name }));
            return `
            <tr data-s="${i}">
              <td><input type="text" name="name" value="${esc(x.name)}" aria-label="教科${i + 1}の教科名"></td>
              <td><input type="text" name="short" value="${esc(x.short || '')}" maxlength="3" aria-label="${esc(x.name || `教科${i + 1}`)}の略称"></td>
              <td><input type="color" name="color" value="${esc(x.color)}" aria-label="${esc(x.name || `教科${i + 1}`)}の色"></td>
              <td>${selectHTML('parent', parentOpts, x.parent || '', { allowEmpty: '—', attrs: `aria-label="${esc(x.name || `教科${i + 1}`)}の合算先"` })}</td>
              <td class="ops">
                <button class="btn small ghost" data-sup aria-label="上へ" title="上へ">↑</button>
                <button class="btn small ghost" data-sdown aria-label="下へ" title="下へ">↓</button>
                <button class="btn small ghost danger" data-srm aria-label="削除" title="削除">×</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <button class="btn small" id="subject-add">＋ 教科を追加</button>
        <button class="btn small ghost" id="subject-reset">既定に戻す</button>
      </div>
    </div>

    <div class="panel" id="sp-print">
      <h2>印刷</h2>
      <div class="print-options">
        <div class="field"><label>用紙の向き</label>
          ${selectHTML('printOrientation', [
            { value: 'portrait', label: 'A4 縦(標準)' },
            { value: 'landscape', label: 'A4 横(ワイド)' },
          ], s.printOrientation)}
        </div>
        <div class="field"><label>文字サイズ</label>
          ${selectHTML('printFontSize', [
            { value: 'small', label: '小' }, { value: 'normal', label: '標準' }, { value: 'large', label: '大' },
          ], s.printFontSize)}
        </div>
      </div>
      <div class="checkline"><input type="checkbox" id="set-ptime" ${s.printShowTimes ? 'checked' : ''}>
        <label for="set-ptime">校時の時刻</label></div>
      <div class="checkline"><input type="checkbox" id="set-phours" ${s.printShowHours ? 'checked' : ''}>
        <label for="set-phours">週の時数表</label></div>
      <div class="checkline"><input type="checkbox" id="set-pdetails" ${s.printShowPlanDetails ? 'checked' : ''}>
        <label for="set-pdetails">指導計画詳細を添付</label>${infoHTML('週案本紙の後に、その週の単元目標・3観点評価・各時の指導目標／学習活動／評価規準を印刷します')}</div>
      <div class="checkline"><input type="checkbox" id="set-pmanager" ${s.printManagerBox ? 'checked' : ''}>
        <label for="set-pmanager">管理職の記入欄</label>${infoHTML('「指導・助言」の空欄を印刷します(押印・コメント運用の学校向け)')}</div>
      <div class="checkline"><input type="checkbox" id="set-pera" ${s.printEra ? 'checked' : ''}>
        <label for="set-pera">和暦で表示</label>${infoHTML('印刷ヘッダーの年・年度を令和表記にします')}</div>
      <div class="field"><label>肩書の表記${infoHTML('印刷ヘッダーの「5年1組」の部分。空欄なら自動(学級担任=学年組/専科=担当教科/中学=教科担任)')}</label>
        <input type="text" data-set="printRole" value="${esc(s.printRole || '')}" placeholder="自動"></div>
      <div class="field"><label>押印欄${infoHTML('「、」区切りで複数。空欄にすると非表示')}</label>
        <input type="text" data-set="stampBoxesText" value="${esc((s.stampBoxes || []).join('、'))}" placeholder="校長、教頭、担任"></div>
    </div>

    <div class="panel" id="sp-google">
      <details ${s.gas.url ? 'open' : ''}>
        <summary style="cursor:pointer;"><h2 style="display:inline;">Google連携</h2>
          <span class="hint">任意・未設定でも全機能使えます</span></summary>
        <p class="hint" style="margin-top:10px;">端末間の同期・カレンダー連携・メール提出が使えます。
          <a href="https://github.com/" id="gas-doc-link" target="_blank" rel="noopener">設定手順(約10分)</a></p>
        <div class="field"><label>接続先URL${infoHTML('設定手順の通りにデプロイすると表示される /exec で終わるURL')}</label>
          <input type="text" data-gas="url" value="${esc(s.gas.url)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="field"><label>合言葉${infoHTML('設定手順の手順2で自分で決めた合言葉(同期トークン)')}</label>
          <input type="password" data-gas="token" value="${esc(s.gas.token)}"></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn" id="gas-test">接続テスト</button>
          ${s.gas.url && s.gas.token ? `<button class="btn" id="gas-add-device">他の端末を追加${infoHTML('スマホや別のPCを、URLと合言葉を手入力せずリンクを開くだけで接続できます')}</button>` : ''}
        </div>

        <h3>行事の取り込み元</h3>
        <div id="gas-cal-list">
          ${(s.gas.calendarIds || []).length
            ? (s.gas.calendarIds || []).map(id => `<span class="subj-chip" style="background:#517b98; margin:2px 4px 2px 0;">${esc(s.gas.calendarNames?.[id] || id)}</span>`).join('')
            : '<span class="hint">メインカレンダー</span>'}
        </div>
        <button class="btn small" id="gas-cal-pick" style="margin-top:6px;">カレンダーを選ぶ</button>

        <h3>メール提出</h3>
        <div class="field"><label>提出先</label>
          <input type="text" data-gas="mailTo" value="${esc(s.gas.mailTo || '')}" placeholder="kocho@example.jp"></div>
        <div class="field"><label>差出人名</label>
          <input type="text" data-gas="senderName" value="${esc(s.gas.senderName || '')}" placeholder="${esc(s.teacherName || '')}"></div>
        <div class="checkline"><input type="checkbox" id="gas-auto" ${s.gas.auto ? 'checked' : ''}>
          <label for="gas-auto">自動で同期</label>${infoHTML('起動時に他端末の変更を取得し、編集後は15秒で自動保存します。複数端末で使う場合にON')}</div>
        <div class="checkline"><input type="checkbox" id="gas-autobackup" ${s.gas.autoBackup ? 'checked' : ''}>
          <label for="gas-autobackup">保存時にドライブへ自動バックアップ</label>${infoHTML('Googleドライブの「週案バックアップ」フォルダに最新20世代を保持します')}</div>
        <p class="hint" style="margin-top:8px;">児童生徒の個人名は入力しない運用を推奨します。</p>
      </details>
    </div>
  </div>
  `;

  wireSettings(root, ctx);
}

function modeDetailHTML(s, gradeOpts) {
  if (s.mode === 'homeroom') {
    return `<p class="hint">学年・組は「基本情報」で設定します。</p>`;
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
  const clsPlaceholder = s.schoolType === 'junior' ? '2年1組' : '5年1組';
  return `
    <div class="field"><label>担当教科${infoHTML('新しいコマに自動でこの教科が入ります')}</label>
      ${selectHTML('senkaSubject', s.subjects.map(x => ({ value: x.key, label: x.name })), s.senkaSubject || '', { allowEmpty: '(なし)' })}
    </div>
    <p class="hint">学級ごとに単元の進度を自動追跡します。</p>
    <div class="inline" style="display:flex; gap:6px; align-items:center; margin-bottom:8px;">
      ${selectHTML('bulkGrade', Array.from({ length: gradeMax }, (_, g) => ({ value: g + 1, label: `${g + 1}年` })), s.grade || 1, { attrs: 'aria-label="一括生成する学年" style="max-width:90px;"' })}
      <span style="font-size:13px;">×</span>
      <input type="number" id="bulk-count" value="2" min="1" max="8" aria-label="一括生成する組数" style="max-width:64px; border:1px solid var(--line); border-radius:8px; padding:6px;">
      <span style="font-size:13px;">組</span>
      <button class="btn small" id="senka-bulk">一括生成</button>
    </div>
    <div class="table-scroll">
    <table class="edit-table">
      <thead><tr><th>学級名</th><th style="width:90px;">学年</th><th class="ops" style="width:104px;"></th></tr></thead>
      <tbody id="senka-body">
        ${s.senkaClasses.map((c, i) => `
          <tr data-c="${i}">
            <td><input type="text" name="label" value="${esc(c.label)}" placeholder="${clsPlaceholder}" aria-label="学級${i + 1}の学級名"></td>
            <td>${selectHTML('grade', Array.from({ length: gradeMax }, (_, g) => ({ value: g + 1, label: `${g + 1}年` })), c.grade, { attrs: `aria-label="${esc(c.label || `学級${i + 1}`)}の学年"` })}</td>
            <td class="ops">
              <button class="btn small ghost" data-cup aria-label="上へ" title="上へ">↑</button>
              <button class="btn small ghost" data-cdown aria-label="下へ" title="下へ">↓</button>
              <button class="btn small ghost danger" data-crm aria-label="削除" title="削除">×</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    </div>
    <button class="btn small" id="senka-add" style="margin-top:8px;">＋ 学級を追加</button>`;
}

function wireSettings(root, ctx) {
  const s = store.settings;

  // カテゴリ単一表示: 選択したカテゴリのパネルだけを表示する
  const CAT_KEY = 'shuan-settings-cat';
  const panels = [...root.querySelectorAll('.settings-grid > .panel')];
  const validIds = panels.map(p => p.id);
  const showCategory = (id) => {
    if (!validIds.includes(id)) id = validIds[0];
    localStorage.setItem(CAT_KEY, id);
    panels.forEach(p => p.classList.toggle('active-cat', p.id === id));
    root.querySelectorAll('.set-chip').forEach(c => c.classList.toggle('active', c.dataset.goto === id));
    const det = root.querySelector('#' + id + ' details');
    if (det) det.open = true; // Google連携は開いた状態で見せる
  };
  root.querySelectorAll('.set-chip').forEach(chip => {
    chip.onclick = () => { showCategory(chip.dataset.goto); root.scrollTop = 0; window.scrollTo(0, 0); };
  });
  showCategory(localStorage.getItem(CAT_KEY) || 'sp-basic');

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
    const ok = await confirmDialog('学校種を変更すると、教科と時程が既定値にリセットされます。よろしいですか?\n(週案・年間指導計画のデータは残りますが、教科の対応を確認してください)', { okLabel: '変更', danger: true });
    if (!ok) { ev.target.value = s.schoolType; return; }
    store.snapshot('学校種の変更'); // カスタマイズ済みの教科・時程を破棄するためUndo可能にする
    s.schoolType = v;
    s.subjects = defaultSubjects(v);
    s.periods = defaultPeriods(v);
    if (s.senkaSubject && !s.subjects.some(x => x.key === s.senkaSubject)) s.senkaSubject = ''; // 教科リセットに伴う実在チェック
    if (v === 'junior') {
      if (s.grade > 3) s.grade = 1;
      // 複式の学年も範囲(1〜3年)へ補正(5・6年のままだと週案・印刷の表示と設定画面が食い違う)
      const fg = s.fukushikiGrades.map(g => Math.min(g, 3));
      if (fg[0] >= fg[1]) { fg[1] = Math.min(3, Math.max(2, fg[1])); fg[0] = fg[1] - 1; }
      s.fukushikiGrades = fg;
    }
    store.commit();
    ctx.rerender();
    toast('学校種を変更しました', 'info', 4000, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
  });

  // 学年・複式学年(再描画して標準時数等を更新)。
  // 年間週数の既定(小1=34週/その他35週)は、ユーザーが独自値にしていなければ学年に追従する。
  // 複式は下学年で判定(オンボーディング・年度更新ウィザードと同じ規則)。
  const followHoursBase = () => {
    if (s.hoursBase === 34 || s.hoursBase === 35) {
      const baseGrade = s.mode === 'fukushiki' ? s.fukushikiGrades[0] : s.grade;
      s.hoursBase = (s.schoolType === 'elementary' && baseGrade === 1) ? 34 : 35;
    }
  };
  const gradeSel = root.querySelector('[name="grade"][data-structural]');
  if (gradeSel) gradeSel.addEventListener('change', () => {
    s.grade = Number(gradeSel.value);
    followHoursBase();
    store.commit(); ctx.rerender();
  });
  const fg0 = root.querySelector('[name="fg0"]');
  if (fg0) fg0.addEventListener('change', () => { s.fukushikiGrades[0] = Number(fg0.value); followHoursBase(); store.commit(); ctx.rerender(); });
  const fg1 = root.querySelector('[name="fg1"]');
  if (fg1) fg1.addEventListener('change', () => { s.fukushikiGrades[1] = Number(fg1.value); followHoursBase(); store.commit(); ctx.rerender(); });

  // 土曜・印刷チェック
  root.querySelector('#set-sat').addEventListener('change', (ev) => { s.saturday = ev.target.checked; store.commit(); ctx.rerender(); });
  root.querySelector('#set-ptime').addEventListener('change', (ev) => { s.printShowTimes = ev.target.checked; store.commit(); });
  root.querySelector('#set-phours').addEventListener('change', (ev) => { s.printShowHours = ev.target.checked; store.commit(); });
  root.querySelector('#set-pdetails').addEventListener('change', (ev) => { s.printShowPlanDetails = ev.target.checked; store.commit(); });
  root.querySelector('#set-pmanager').addEventListener('change', (ev) => { s.printManagerBox = ev.target.checked; store.commit(); });
  root.querySelector('#set-pera').addEventListener('change', (ev) => { s.printEra = ev.target.checked; store.commit(); });
  root.querySelector('[name="uiScale"]').addEventListener('change', (ev) => {
    s.uiScale = ev.target.value;
    document.documentElement.classList.toggle('ui-large', s.uiScale === 'large');
    store.commit();
  });
  // 学級表記のライブプレビュー(「2年2年1組」の二重表記を構造的に防ぐ)
  const classInput = root.querySelector('[data-set="className"]');
  const classPreview = root.querySelector('#class-preview');
  if (classInput && classPreview) {
    classInput.addEventListener('input', () => {
      classPreview.textContent = `→ 印刷: ${s.grade}年${classInput.value.trim()}`;
    });
  }
  // 設定手順リンク(GitHub Pages配信時は同リポジトリのdocsへ。ブラウザで読めるHTML版)
  const docLink = root.querySelector('#gas-doc-link');
  if (docLink) docLink.href = new URL('docs/gas-setup.html', location.href.replace(/[^/]*$/, '')).href;
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
      followHoursBase(); // 複式↔他形態で基準学年が変わると週数の既定も追従させる
      store.commit();
      ctx.rerender();
    };
  });

  // 専科: 担当教科
  const senkaSubjSel = root.querySelector('[name="senkaSubject"]');
  if (senkaSubjSel) senkaSubjSel.addEventListener('change', () => { s.senkaSubject = senkaSubjSel.value; store.commit(); });

  // 専科学級テーブル
  const senkaBody = root.querySelector('#senka-body');
  if (senkaBody) {
    senkaBody.querySelectorAll('tr').forEach(tr => {
      const i = Number(tr.dataset.c);
      tr.querySelector('[name="label"]').addEventListener('change', (ev) => { s.senkaClasses[i].label = ev.target.value; store.commit(); });
      tr.querySelector('[name="grade"]').addEventListener('change', (ev) => { s.senkaClasses[i].grade = Number(ev.target.value); store.commit(); });
      tr.querySelector('[data-crm]').onclick = async () => {
        // 入力済みコマ数を数えて正確に伝える
        const id = s.senkaClasses[i].id;
        let count = 0;
        for (const w of Object.values(store.state.weeks)) {
          for (const cell of Object.values(w.cells || {})) {
            count += (cell.entries || []).filter(e => e.scope === id).length;
          }
        }
        const ok = await confirmDialog(
          `学級「${s.senkaClasses[i].label || '(無名)'}」を削除しますか?` +
          (count ? `\nこの学級の入力済み ${count}コマ は集計・表示されなくなります(データは残ります)` : ''),
          { okLabel: '削除', danger: true });
        if (!ok) return;
        store.snapshot('学級の削除');
        s.senkaClasses.splice(i, 1);
        // 削除した学級が「直前に選んだ学級」(新規コマの既定)なら無効化する
        // (残したままだと以後の新規コマが存在しない学級に割り当てられ、集計から消える)
        if (ctx.lastScope === id) {
          ctx.lastScope = null;
          try { localStorage.removeItem('shuan-last-scope'); } catch {}
        }
        store.commit(); ctx.rerender();
      };
      tr.querySelector('[data-cup]').onclick = () => { if (i > 0) { swap(s.senkaClasses, i, i - 1); store.commit(); ctx.rerender(); } };
      tr.querySelector('[data-cdown]').onclick = () => { if (i < s.senkaClasses.length - 1) { swap(s.senkaClasses, i, i + 1); store.commit(); ctx.rerender(); } };
    });
    root.querySelector('#senka-add').onclick = () => {
      // 直前の行の学年を引き継ぐ(12学級登録の手間を半減)
      const last = s.senkaClasses[s.senkaClasses.length - 1];
      s.senkaClasses.push({ id: uid(), label: '', grade: last?.grade ?? s.grade ?? 1 });
      store.commit(); ctx.rerender();
      // 再描画後、新しい行のラベル欄へフォーカス
      setTimeout(() => {
        const rows = document.querySelectorAll('#senka-body tr');
        rows[rows.length - 1]?.querySelector('[name="label"]')?.focus();
      }, 0);
    };
    // 「5年×3組」のような一括生成(12学級登録を数タップに)
    root.querySelector('#senka-bulk').onclick = () => {
      const g = Number(root.querySelector('[name="bulkGrade"]').value) || 1;
      const n = Math.min(8, Math.max(1, Number(root.querySelector('#bulk-count').value) || 1));
      for (let i = 1; i <= n; i++) {
        const label = `${g}年${i}組`;
        if (!s.senkaClasses.some(c => c.label === label)) {
          s.senkaClasses.push({ id: uid(), label, grade: g });
        }
      }
      store.commit(); ctx.rerender();
    };
  }

  // 時程テーブル
  root.querySelectorAll('#periods-body tr').forEach(tr => {
    const i = Number(tr.dataset.p);
    const p = s.periods[i];
    tr.querySelector('[name="label"]').addEventListener('change', (ev) => { p.label = ev.target.value; store.commit(); });
    tr.querySelector('[name="type"]').addEventListener('change', (ev) => { p.type = ev.target.value; store.commit(); ctx.rerender(); });
    tr.querySelector('[name="start"]').addEventListener('change', (ev) => {
      p.start = ev.target.value;
      // 終了時刻が空なら「開始+分」を自動補完
      if (p.start && !p.end && p.minutes) {
        const [h, m] = p.start.split(':').map(Number);
        const t = h * 60 + m + p.minutes;
        p.end = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
        tr.querySelector('[name="end"]').value = p.end;
      }
      store.commit();
    });
    tr.querySelector('[name="end"]').addEventListener('change', (ev) => { p.end = ev.target.value; store.commit(); });
    tr.querySelector('[name="minutes"]').addEventListener('change', (ev) => {
      p.minutes = Number(ev.target.value);
      // 授業種別なら係数は1のまま。モジュールなら分数から自動提案
      // (丸めずに保存する。0.333に丸めると累計が35時間に揃わない)
      if (p.type === 'module') {
        const base = s.schoolType === 'junior' ? 50 : 45;
        p.coefficient = p.minutes / base;
      }
      store.commit(); ctx.rerender();
    });
    tr.querySelector('[name="coefficient"]').addEventListener('change', (ev) => { p.coefficient = Number(ev.target.value); store.commit(); });
    tr.querySelector('[data-prm]').onclick = async () => {
      const ok = await confirmDialog(`校時「${p.label}」を削除しますか?(この校時に入力済みのコマは表示されなくなります)`, { okLabel: '削除', danger: true });
      if (!ok) return;
      store.snapshot('校時の削除');
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
    s.periods.push({ id: uid(), label: 'モ', type: 'module', minutes: 15, coefficient: 15 / base, start: '', end: '' });
    store.commit(); ctx.rerender();
  };
  root.querySelector('#period-reset').onclick = async () => {
    const ok = await confirmDialog('時程を既定値に戻しますか?', { okLabel: '戻す' });
    if (!ok) return;
    store.snapshot('時程のリセット');
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
      store.snapshot('日課表パターンの削除');
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
  // 学期の区切り: 月・日のセレクト(入力形式エラーを構造的になくす)
  const setTermEnd = (i) => {
    const m = Number(root.querySelector(`[data-term-m="${i}"]`)?.value) || 7;
    const dSel = root.querySelector(`[data-term-d="${i}"]`);
    let d = Number(dSel?.value) || 31;
    // 実在しない日付(6/31等)は月末日へ補正して保存・表示する。
    // 不正な日付のまま保存すると、その学期と次学期の間に隙間日ができ時数集計から漏れる
    const y = m >= 4 ? s.fiscalYear : s.fiscalYear + 1;
    const maxD = new Date(y, m, 0).getDate();
    if (d > maxD) {
      d = maxD;
      if (dSel) dSel.value = String(d);
    }
    s.termEnds[i] = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    store.commit();
  };
  root.querySelectorAll('[data-term-m]').forEach(sel => {
    sel.addEventListener('change', () => setTermEnd(Number(sel.dataset.termM)));
  });
  root.querySelectorAll('[data-term-d]').forEach(sel => {
    sel.addEventListener('change', () => setTermEnd(Number(sel.dataset.termD)));
  });
  root.querySelector('#set-holidays').addEventListener('change', (ev) => { s.showHolidays = ev.target.checked; store.commit(); });
  root.querySelector('#set-daynotes').addEventListener('change', (ev) => { s.showDayNotes = ev.target.checked; store.commit(); });
  root.querySelector('#set-attendance').addEventListener('change', (ev) => { s.showAttendance = ev.target.checked; store.commit(); });

  // 長期休業
  root.querySelectorAll('#breaks-body tr').forEach(tr => {
    const i = Number(tr.dataset.b);
    const b = s.breaks[i];
    tr.querySelector('[name="bname"]').addEventListener('change', (ev) => { b.name = ev.target.value; store.commit(); });
    tr.querySelector('[name="bfrom"]').addEventListener('change', (ev) => { b.from = ev.target.value; store.commit(); });
    tr.querySelector('[name="bto"]').addEventListener('change', (ev) => { b.to = ev.target.value; store.commit(); });
    tr.querySelector('[data-brm]').onclick = () => {
      store.snapshot('休業の削除');
      s.breaks.splice(i, 1);
      store.commit();
      ctx.rerender();
      // 他の行削除(確認ダイアログ)と違い1行の再追加が容易なため、Undoトーストで守る(規約9)
      toast('休業を削除しました', 'info', 2600, { label: '元に戻す', onClick: () => { store.undo(); ctx.rerender(); } });
    };
  });
  root.querySelector('#break-add').onclick = () => {
    s.breaks = s.breaks || [];
    const fy = s.fiscalYear;
    // 最初の追加は夏休みの典型期間を既定値に
    const preset = s.breaks.length === 0
      ? { name: '夏季休業', from: `${fy}-07-21`, to: `${fy}-08-31` }
      : s.breaks.length === 1
        ? { name: '冬季休業', from: `${fy}-12-26`, to: `${fy + 1}-01-07` }
        : { name: '', from: '', to: '' };
    s.breaks.push(preset);
    store.commit(); ctx.rerender();
  };

  // 教科テーブル
  root.querySelectorAll('#subjects-body tr').forEach(tr => {
    const i = Number(tr.dataset.s);
    const x = s.subjects[i];
    tr.querySelector('[name="name"]').addEventListener('change', (ev) => { x.name = ev.target.value; store.commit(); });
    tr.querySelector('[name="short"]').addEventListener('change', (ev) => { x.short = ev.target.value; store.commit(); });
    tr.querySelector('[name="color"]').addEventListener('change', (ev) => { x.color = ev.target.value; store.commit(); });
    tr.querySelector('[name="parent"]').addEventListener('change', (ev) => {
      // 二重連鎖の防止(UIでも候補から外しているが、データ整合の最終ガード)
      if (ev.target.value && s.subjects.some(c => c.parent === x.key)) {
        toast('この教科は他教科の合算先のため、さらに合算できません', 'error', 4500);
        ev.target.value = x.parent || '';
        return;
      }
      x.parent = ev.target.value || undefined;
      if (!x.parent) delete x.parent;
      store.commit(); ctx.rerender();
    });
    tr.querySelector('[data-srm]').onclick = async () => {
      const ok = await confirmDialog(`教科「${x.name}」を削除しますか?(入力済みのコマの教科表示が消えます)`, { okLabel: '削除', danger: true });
      if (!ok) return;
      store.snapshot('教科の削除');
      s.subjects.splice(i, 1);
      if (s.senkaSubject === x.key) s.senkaSubject = ''; // 死んだキーが新規コマに充填され時数が無言で消えるのを防ぐ
      store.commit(); ctx.rerender();
    };
    tr.querySelector('[data-sup]').onclick = () => { if (i > 0) { swap(s.subjects, i, i - 1); store.commit(); ctx.rerender(); } };
    tr.querySelector('[data-sdown]').onclick = () => { if (i < s.subjects.length - 1) { swap(s.subjects, i, i + 1); store.commit(); ctx.rerender(); } };
  });
  root.querySelector('#subject-add').onclick = () => {
    s.subjects.push({ key: uid(), name: '', short: '', color: '#767676' }); // 白文字で4.5:1(WCAG 1.4.3)
    store.commit(); ctx.rerender();
  };
  root.querySelector('#subject-reset').onclick = async () => {
    const ok = await confirmDialog('教科リストを既定値に戻しますか?(独自に追加した教科は消えます)', { okLabel: '戻す', danger: true });
    if (!ok) return;
    store.snapshot('教科のリセット');
    s.subjects = defaultSubjects(s.schoolType);
    if (s.senkaSubject && !s.subjects.some(x => x.key === s.senkaSubject)) s.senkaSubject = ''; // 実在チェック(教科削除と同じ)
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
    if (!ctx.gas.configured) {
      // 入力欄は同じパネルの直上にある(規約3: 結果報告のみ+フォーカス移動で誘導)
      toast('接続先が未設定です', 'error');
      root.querySelector('[data-gas="url"]')?.focus();
      return;
    }
    try {
      toast('接続テスト中…');
      await ctx.gas.ping();
      if (!s.gas.auto) {
        // 成功した流れのまま自動同期を始められるように(設定項目を探させない)
        toast('接続できました', 'info', 8000, {
          label: '自動同期ON',
          onClick: () => { s.gas.auto = true; store.commit(); ctx.rerender(); toast('自動同期をONにしました'); },
        });
      } else {
        toast('接続できました');
      }
    } catch (e) {
      // 復旧手順はトーストに書かず「手順を見る」で設定手順ドキュメントへ誘導(規約3)
      toast('接続失敗: ' + e.message, 'error', 6000, {
        label: '手順を見る',
        onClick: () => window.open(new URL('docs/gas-setup.html', location.href.replace(/[^/]*$/, '')).href, '_blank', 'noopener'),
      });
    }
  };

  // 他の端末を追加: 接続情報を載せたリンク/コードを表示する(新端末はリンクを開くだけ)
  const addDeviceBtn = root.querySelector('#gas-add-device');
  if (addDeviceBtn) addDeviceBtn.onclick = async () => {
    const { encodeConnect } = await import('../gas.js');
    const code = encodeConnect(s.gas.url, s.gas.token);
    const link = location.origin + location.pathname + '#connect=' + code;
    openModal(`
      <h2>他の端末を追加</h2>
      <p class="hint">新しい端末(スマホ・別のPC)で<b>このリンクを開くだけ</b>で、URL・合言葉の入力なしに接続され、保存済みのデータを自動で取得します。<br>
        スマホへは、自分宛のメールやGoogle Keep・LINEのKeepメモにリンクを貼って開くのが簡単です。</p>
      <div class="field"><label>接続リンク</label>
        <input type="text" id="connect-link" value="${esc(link)}" readonly style="font-size:12px;"></div>
      <div style="display:flex; gap:8px;">
        <button class="btn primary" id="connect-copy">リンクをコピー</button>
        ${navigator.share ? '<button class="btn" id="connect-share">共有</button>' : ''}
      </div>
      <p class="hint" style="margin-top:12px; color:#9a3412;">このリンクには合言葉が含まれます。自分の端末だけで使い、他人と共有しないでください。</p>
      <div class="modal-foot"><button class="btn" data-close>閉じる</button></div>
    `, (modal, close) => {
      modal.querySelector('[data-close]').onclick = close;
      const input = modal.querySelector('#connect-link');
      modal.querySelector('#connect-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(link); toast('リンクをコピーしました'); }
        catch { input.select(); document.execCommand('copy'); toast('リンクをコピーしました'); }
      };
      const shareBtn = modal.querySelector('#connect-share');
      if (shareBtn) shareBtn.onclick = () => navigator.share({ title: 'ルーズリーフ 接続リンク', url: link }).catch(() => {});
    });
  };

  root.querySelector('#gas-autobackup').addEventListener('change', (ev) => {
    s.gas.autoBackup = ev.target.checked;
    store.commit();
  });
  root.querySelector('#gas-auto').addEventListener('change', (ev) => {
    s.gas.auto = ev.target.checked;
    store.commit();
  });

  // カレンダー選択(一覧を取得してチェックボックスで選ぶ)
  root.querySelector('#gas-cal-pick').onclick = async () => {
    if (!ctx.gas.configured) {
      // 入力欄は同じパネルの直上にある(規約3: 結果報告のみ+フォーカス移動で誘導)
      toast('接続先が未設定です', 'error');
      root.querySelector('[data-gas="url"]')?.focus();
      return;
    }
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
        <p class="hint">チェックしたカレンダーの予定が、週案タブの「📆 行事」で行事欄に入ります。</p>
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
        <td style="text-align:center;"><input type="checkbox" name="enabled" ${enabled ? 'checked' : ''} title="この校時を行う" aria-label="${esc(p.label)}校時を行う"></td>
        <td style="text-align:center; font-weight:600;">${esc(p.label)}</td>
        <td><input type="time" name="start" value="${esc(ov.start ?? p.start ?? '')}" aria-label="${esc(p.label)}校時の開始時刻"></td>
        <td><input type="time" name="end" value="${esc(ov.end ?? p.end ?? '')}" aria-label="${esc(p.label)}校時の終了時刻"></td>
        <td><input type="number" name="minutes" value="${esc(ov.minutes ?? p.minutes)}" min="5" max="120" aria-label="${esc(p.label)}校時の分"></td>
        <td><input type="number" name="coefficient" value="${esc(ov.coefficient ?? p.coefficient)}" min="0" max="2" step="0.001" aria-label="${esc(p.label)}校時の係数"></td>
      </tr>`;
  }).join('');

  openModal(`
    <h2>${isNew ? '日課表パターンの追加' : '日課表パターンの編集'}</h2>
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
