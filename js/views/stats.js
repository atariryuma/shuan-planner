/** 時数集計ビュー: 進度一覧(専科・複式)・教科別集計・月別/学期別・CSV/印刷 */

import { store, computeHours, computeMonthlyHours, computeOrdinals, computeViewpointTally, computeProgressForecast, computeAttendance, lessonFromPlan, fmtHours, standardHoursFor, standardTotalHoursFor, scopeKey, cellKey, teachingWeeksLeft, teachingWeeksElapsed, doneRefWeek } from '../store.js';
import { weekNumberInFiscalYear, fiscalYearOf, parseDate, addDays, fmtDate, fmtMD, esc } from '../utils.js';
import { toast, infoHTML } from '../ui.js';
import { icon } from '../icons.js';

const MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const DETAIL_KEY = 'shuan-stats-detail';

export function renderStatsView(root, ctx) {
  const state = store.state;
  const s = state.settings;
  const weekStart = ctx.getWeekStart();
  const hours = computeHours(state, weekStart);
  const monthly = computeMonthlyHours(state, weekStart);
  const weekNo = weekNumberInFiscalYear(parseDate(weekStart));

  // 実施済は表示中の週ではなく今日現在で数える(過去週を見ていても報告値が欠けない)
  const hoursDone = computeHours(state, doneRefWeek(weekStart));
  const detail = localStorage.getItem(DETAIL_KEY) === '1';
  // 年度表示は閲覧中の週から導出する(settings.fiscalYearは常に現在年度のため、
  // 4月以降に前年度の週を見るとデータと年度ラベルが食い違う)
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));

  const scopes = scopesOf(s, hours);
  // 複数学級(専科・複式)では、全学級の時数を1枚で見渡せる横断サマリーを先頭に出す
  const classSummary = scopes.length >= 2 ? renderClassSummary(state, hours, hoursDone, scopes) : '';
  const sections = scopes.map(sc => renderScopeTable(state, hours, hoursDone, monthly, sc, weekNo, weekStart, detail)).filter(Boolean).join('');
  const management = renderManagement(state, weekStart);
  const viewpoints = renderViewpointSummary(state, scopes, weekStart);
  const attendance = renderAttendance(state, weekStart);

  // 番号だらけの表は「教育委員会への報告用」として畳む(普段は上の見通しでパッと分かる)。
  const legend = sections ? `<div class="hours-legend" aria-hidden="true">
        <span><i class="hl-done"></i>実施</span>
        <span><i class="hl-plan"></i>予定</span>
        <span><i class="hl-std"></i>標準</span>
        <span class="hl-note">バーが標準ラインに届けば達成</span>
      </div>` : '';
  const tables = `${classSummary}${sections}`;
  const emptyState = `<div class="empty-state">
        <div class="empty-ic">${icon('chart')}</div>
        <p class="empty-title">まだ集計するコマがありません</p>
        <p class="empty-sub">週案タブでコマを入れると、ここに進度と標準時数の見通しが表示されます。</p>
      </div>`;
  // 見通し(management)があれば、表はその下に「詳しい数値」として畳む。無ければ表を主役に出す。
  const numbersBlock = (classSummary || sections)
    ? (management
        ? `<details class="stats-numbers"><summary class="fold-label">詳しい数値（月別・標準時数・教育委員会への報告用）</summary>
            <div class="stats-numbers-body">${legend}${tables}</div></details>`
        : `${legend}${tables}`)
    : (management ? '' : emptyState);

  root.innerHTML = `
    <div class="panel">
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px;">
        <h2 style="margin:0;">時数集計</h2>
        <span class="hint">第${weekNo}週(${fmtMD(parseDate(weekStart))})まで・${fy}年度</span>
        <span class="spacer" style="flex:1;"></span>
        <label class="hint" style="display:flex; align-items:center; gap:4px; cursor:pointer;">
          <input type="checkbox" id="stats-detail" ${detail ? 'checked' : ''}> 詳細列</label>
        <button class="btn small" id="stats-csv">CSV保存</button>
        <button class="btn small" id="stats-print">印刷</button>
      </div>
      ${management}
      ${numbersBlock}
      ${viewpoints}
      ${attendance}
    </div>
  `;

  root.querySelector('#stats-detail').onchange = (e) => {
    localStorage.setItem(DETAIL_KEY, e.target.checked ? '1' : '0');
    ctx.rerender();
  };

  // 標準時数の上書き編集(空欄=既定に戻す、数値以外は無視)
  root.querySelectorAll('input[data-std]').forEach(inp => {
    inp.addEventListener('change', () => {
      const [subjKey, grade] = inp.dataset.std.split('@');
      if (!s.standardOverrides) s.standardOverrides = {};
      const v = inp.value.trim();
      const n = Number(v);
      if (v === '' || !isFinite(n) || n < 0) delete s.standardOverrides[`${subjKey}|${grade}`];
      else s.standardOverrides[`${subjKey}|${grade}`] = n;
      store.commit();
      ctx.rerender();
    });
  });

  // 授業マネジメントの「週案を開く」: 遅れを切り上げ/補充で巻き返す動線
  root.querySelectorAll('[data-goweek]').forEach(b => b.addEventListener('click', (ev) => {
    ev.preventDefault();
    document.querySelector('.tab[data-tab="week"]')?.click();
  }));

  root.querySelector('#stats-csv').onclick = () => downloadCSV(state, weekStart);
  root.querySelector('#stats-print').onclick = async () => {
    const { buildStatsPrintDOM, printState } = await import('../print.js');
    buildStatsPrintDOM(weekStart);
    printState.prepared = true;
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  };
}

/** 表示するスコープの一覧。専科の「学級指定なし」は実データがあるときだけ */
function scopesOf(s, hours) {
  if (s.mode === 'fukushiki') {
    return s.fukushikiGrades.map(g => ({ scope: g, label: `${g}年`, grade: g }));
  }
  if (s.mode === 'senka') {
    const list = s.senkaClasses.map(c => ({ scope: c.id, label: c.label, grade: c.grade }));
    const hasNull = [...hours.keys()].some(k => k.endsWith('|'));
    if (hasNull) list.push({ scope: '', label: '(学級指定なし)', grade: s.grade });
    return list;
  }
  return [{ scope: '', label: '', grade: s.grade }];
}

// ---------------------------------------------------------------- 学級横断サマリー(専科・複式)

/**
 * 全学級(専科)・全学年(複式)の時数を1枚で見渡す一覧。
 * 専科で12学級を担当していても、提出時に「どの学級が標準に対してどこまで進んだか」を一望できる。
 * 各学級の主要教科(合算先を持たない教科)の実施済・予定計・標準を合算して出す。
 */
/**
 * 時数の状態を一目で示すバー。標準時数を目標ラインに、実施(実線)と予定(淡色)を重ねる。
 * バーが目標ラインに届かない=標準に未達。標準を多少上回るのは差し支えないため、
 * 過度な超過(標準の115%超)のときだけ淡色を警告色にする。色＋位置(ライン)＋数値で色覚に依存しない。
 */
function hoursBar(done, total, std) {
  if (!std) {
    const max = Math.max(total, done, 1);
    return `<div class="hbar" title="実施${fmtHours(done)} / 予定${fmtHours(total)}">
      <div class="hbar-plan" style="width:${Math.min(total / max, 1) * 100}%"></div>
      <div class="hbar-done" style="width:${Math.min(done / max, 1) * 100}%"></div>
    </div>`;
  }
  const max = Math.max(total, std);
  const stdPct = std / max * 100;
  const over = total > std * 1.15; // 標準を多少超える程度は警告しない(超過は原則差し支えない)
  return `<div class="hbar ${over ? 'is-over' : ''}" title="実施${fmtHours(done)} / 予定${fmtHours(total)} / 標準${fmtHours(std)}">
    <div class="hbar-plan" style="width:${total / max * 100}%"></div>
    <div class="hbar-done" style="width:${done / max * 100}%"></div>
    <div class="hbar-std" style="left:${stdPct}%"></div>
  </div>`;
}

function renderClassSummary(state, hours, hoursDone, scopes) {
  const s = state.settings;
  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }

  let sumDone = 0, sumYear = 0, sumStd = 0;
  const rows = [];
  for (const sc of scopes) {
    const scopeVal = sc.scope === '' ? null : sc.scope;
    let done = 0, yearTotal = 0, std = 0;       // 予定計=年間の入力済み(実施済≦予定計を保証・過去週でも矛盾しない)
    for (const subj of s.subjects) {
      if (subj.parent && keys.has(subj.parent)) continue;
      let t = 0, d = 0;
      for (const k of [subj.key, ...(childrenOf[subj.key] || [])]) {
        const v = hours.get(scopeKey(k, scopeVal));
        if (v) t += (v.yearTotal || 0);
        d += hoursDone.get(scopeKey(k, scopeVal))?.done || 0;
      }
      if (t > 0 || d > 0) {
        yearTotal += t; done += d;
        const sd = standardHoursFor(s, subj.key, sc.grade);
        if (sd != null) std += sd;
      }
    }
    if (yearTotal === 0 && done === 0) continue; // 未入力の学級は出さない
    sumDone += done; sumYear += yearTotal; sumStd += std;
    const remain = std ? std - yearTotal : null;
    const totalStd = standardTotalHoursFor(s, sc.grade); // 施行規則 別表の年間総授業時数(法定の総枠)
    rows.push(`
      <tr>
        <td class="subj">${esc(sc.label || '—')}</td>
        <td>${fmtHours(done)}</td>
        <td>${fmtHours(yearTotal)}</td>
        <td>${std || '—'}</td>
        <td>${totalStd || '—'}</td>
        <td>${remain != null ? fmtHours(remain) : '—'}</td>
        <td style="text-align:left;">${hoursBar(done, yearTotal, std)}</td>
      </tr>`);
  }
  if (rows.length < 2) return ''; // 1学級分しか無ければ通常テーブルで十分

  const label = s.mode === 'fukushiki' ? '学年' : '学級';
  return `
    <h3 style="margin-top:0;">全${label}の進捗${infoHTML('担当する全' + label + 'の実施済・予定計・標準時数を一覧します。提出時の確認用。バーは実施済÷標準')}</h3>
    <div class="table-scroll">
      <table class="stats-table" style="margin-bottom:18px;">
        <thead><tr>
          <th style="width:110px;">${label}</th>
          <th style="width:70px;">実施済</th>
          <th style="width:70px;">予定計</th>
          <th style="width:60px;">教科計${infoHTML('開設する各教科の標準時数の合計。下の「総授業時数」(法定の総枠)とは別物です')}</th>
          <th style="width:78px;">総授業時数${infoHTML('学校教育法施行規則 別表の年間総授業時数(法定の総枠)。予定計がこれに達するかで確保状況を見ます')}</th>
          <th style="width:60px;">残り</th>
          <th>進捗(実施)</th>
        </tr></thead>
        <tbody>
          ${rows.join('')}
          <tr style="background:#f8fafc;">
            <td class="subj">合計</td><td><b>${fmtHours(sumDone)}</b></td><td>${fmtHours(sumYear)}</td>
            <td>${sumStd || '—'}</td><td></td><td>${sumStd ? fmtHours(sumStd - sumYear) : '—'}</td><td></td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------- 観点別の評価場面

/**
 * 観点別評価(知/思/態)のタグを付けたコマを、実施済の範囲で学級×教科ごとに数える。
 * 観点を入力させておきながら集計しない問題への対応。評定期の偏り(例: 思考の評価場面が少ない)を可視化する。
 */
function renderViewpointSummary(state, scopes, weekStart) {
  const s = state.settings;
  const tally = computeViewpointTally(state, doneRefWeek(weekStart)); // 今日までに実施したコマで数える
  if (!tally.size) return '';
  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }
  const rows = [];
  for (const sc of scopes) {
    const scopeVal = sc.scope === '' ? null : sc.scope;
    for (const subj of s.subjects) {
      if (subj.parent && keys.has(subj.parent)) continue;
      let k = 0, t = 0, a = 0;
      for (const key of [subj.key, ...(childrenOf[subj.key] || [])]) {
        const v = tally.get(scopeKey(key, scopeVal));
        if (v) { k += v['知']; t += v['思']; a += v['態']; }
      }
      const sum = k + t + a;
      if (!sum) continue;
      rows.push(`<tr>
        <td class="subj">${esc(sc.label || '—')}</td>
        <td style="text-align:left;">${esc(subj.short || subj.name)}</td>
        <td>${k || ''}</td><td>${t || ''}</td><td>${a || ''}</td><td><b>${sum}</b></td>
      </tr>`);
    }
  }
  if (!rows.length) return '';
  const label = s.mode === 'fukushiki' ? '学年' : '学級';
  return `
    <h3>観点別の評価場面${infoHTML('観点(知/思/態)のタグを付けたコマを、実施済の範囲で学級×教科ごとに数えます。評定期に「思考の評価場面が少ない」等の偏りを事前に把握できます')}</h3>
    <div class="table-scroll">
      <table class="stats-table" style="margin-bottom:18px;">
        <thead><tr>
          <th style="width:110px;">${label}</th>
          <th style="text-align:left;">教科</th>
          <th style="width:54px;"><span class="vp-badge" data-vp="知">知</span></th>
          <th style="width:54px;"><span class="vp-badge" data-vp="思">思</span></th>
          <th style="width:54px;"><span class="vp-badge" data-vp="態">態</span></th>
          <th style="width:48px;">計</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------- 進度一覧(専科・複式の核心ビュー)

/** 出欠の月別集計: 日々の出欠メモから「欠N/遅N/早N」を読み取り月別に合計(出席簿への転記の目安)。データが無ければ非表示。 */
function renderAttendance(state, weekStart) {
  const att = computeAttendance(state, weekStart);
  if (!att.any) return '';
  const rows = MONTH_ORDER.filter(m => att.months.has(m)).map(m => {
    const r = att.months.get(m);
    return `<tr><td>${m}月</td><td>${r.abs || ''}</td><td>${r.late || ''}</td><td>${r.early || ''}</td></tr>`;
  }).join('');
  return `
    <h3>出欠（月別）${infoHTML('日々の「出欠」メモから「欠2 遅1 早1」のような数字を読み取って合計します。出席簿への転記の目安に。個人名は数字に反映されません')}</h3>
    <table class="stats-table" style="max-width:340px; margin-bottom:18px;">
      <thead><tr><th style="width:64px;">月</th><th>欠席</th><th>遅刻</th><th>早退</th></tr></thead>
      <tbody>${rows}
        <tr style="font-weight:700; background:#f8fafc;"><td>計</td><td>${att.total.abs || ''}</td><td>${att.total.late || ''}</td><td>${att.total.early || ''}</td></tr>
      </tbody>
    </table>`;
}

/**
 * 授業マネジメント: 教科×学級ごとに、計画に対する進み(実施/残り)・計画通り/遅れ/先行・
 * 年度末の完了見込み・単元ごとの進みをカードで示す。遅れは切り上げ/補充への動線に繋ぐ。
 * 追加入力なし(computeProgressForecast が既存データから算出)。遅れているカードは既定で開く。
 */
function renderManagement(state, weekStart) {
  const s = state.settings;
  const fc = computeProgressForecast(state, weekStart);
  if (!fc.size) return '';
  const subjIdx = (key) => { const i = s.subjects.findIndex(x => x.key === key); return i < 0 ? 99 : i; };
  const labelOf = (f) => {
    const subj = s.subjects.find(x => x.key === f.subjectKey);
    const subjName = subj ? (subj.name || subj.short) : f.subjectKey;
    const cls = s.mode === 'senka' ? (s.senkaClasses.find(c => c.id === f.scope)?.label || '')
      : s.mode === 'fukushiki' ? `${f.grade}年`
        : (s.className ? `${f.grade}年${s.className}` : '');
    return { subjName, cls };
  };
  const items = [...fc.values()].sort((a, b) =>
    subjIdx(a.subjectKey) - subjIdx(b.subjectKey) || String(a.scope).localeCompare(String(b.scope)));

  // チップは「年度内に終わるか」の一語(遅れ=要対策/先行=余裕/順調/完了)。位置は下のバー・単元リストが示す。
  const chip = (f) => f.status === 'done' ? '<span class="mng-chip done">完了</span>'
    : f.status === 'behind' ? '<span class="mng-chip behind">遅れ</span>'
      : f.status === 'ahead' ? '<span class="mng-chip ahead">先行</span>'
        : '<span class="mng-chip ontrack">順調</span>';
  // 数字3つの箱の代わりに「言い切り＋次の一手」を1文で。遅れは具体的な巻き返し方を添える。
  const verdict = (f) => {
    if (f.status === 'done') return '';
    const rate = f.weeklyRate != null ? f.weeklyRate : f.rate;
    if (f.status === 'behind') {
      if (f.left <= 0 || f.requiredPace === Infinity) {
        return `<div class="mng-verdict warn">残りの授業週がありません。<b>${f.shortfall}コマ分</b>を切り上げるか、計画の見直しを。<button class="btn small" data-goweek>週案を開く</button></div>`;
      }
      const extra = Math.max(1, Math.ceil(f.requiredPace - rate));
      return `<div class="mng-verdict warn">このままだと<b>${f.shortfall}コマ不足</b>の見込み。<b>週あと${extra}コマ</b>増やすか、<b>${f.shortfall}コマ分</b>を切り上げると間に合います。<button class="btn small" data-goweek>週案を開く</button></div>`;
    }
    if (f.status === 'ahead') {
      const wk = rate > 0 ? Math.round(f.marginKoma / rate) : 0;
      return `<div class="mng-verdict ok">余裕あり。約<b>${wk}週分</b>の貯金で、このペースで<b>完了見込み</b>。</div>`;
    }
    return `<div class="mng-verdict ok">このペースで年度内に<b>完了見込み</b>（残り${f.remaining}コマ・週${rate}）。</div>`;
  };
  const unitRow = (u) => {
    const lbl = u.status === 'done' ? (u.cut ? '切上げ' : '済') : u.status === 'current' ? 'いま' : 'これから';
    return `<div class="mng-unit ${u.status}">
        <span class="mng-uname">${esc(u.name)}</span>
        <span class="mng-ubar"><span class="mng-ubar-fill ${u.status}" style="width:${Math.round(u.done / u.hours * 100)}%"></span></span>
        <span class="mng-ufrac">${u.done}/${u.hours}</span>
        <span class="mng-ustat ${u.status}">${lbl}</span>
      </div>`;
  };
  const card = (f) => {
    const { subjName, cls } = labelOf(f);
    const nextLine = f.next ? `<div class="mng-next"><span class="muted">次の授業 ▸</span> ${esc(f.next.unitName)}${f.next.unitHours > 1 ? `(${f.next.nth}/${f.next.unitHours})` : ''}${f.next.objective ? ' ' + esc(f.next.objective) : ''}</div>` : '';
    return `<details class="mng-card ${f.status}" ${f.status === 'behind' ? 'open' : ''}>
        <summary class="mng-head">
          <span class="mng-title">${esc(subjName)}${cls ? ` <span class="muted">${esc(cls)}</span>` : ''}</span>
          ${chip(f)}
          <span class="mng-bar"><span class="mng-bar-fill ${f.status}" style="width:${Math.min(100, f.pct)}%"></span></span>
          <span class="mng-frac">${f.taught}/${f.planTotal}<small>時</small></span>
        </summary>
        <div class="mng-cardbody">
          ${verdict(f)}${nextLine}
          <div class="mng-units">${f.units.map(unitRow).join('')}</div>
        </div>
      </details>`;
  };
  return `
    <h3 style="margin-top:0;">進度と時数の見通し${infoHTML('大事なのは2つ: ①今どこまで進んだか(バー・単元リスト)、②このまま行くと年度内に終わるか(チップ)。「遅れ」は、今のペースだと標準時数までに終わらない見込みのこと。週案で切り上げ・補充して巻き返せます。追加入力は不要です')}</h3>
    <p class="mng-legend hint"><b>バー・単元リスト</b>＝今どこまで進んだか。<b>チップ</b>＝このまま行くと年度内に終わるか（順調／先行＝余裕／遅れ＝対策を）。下の一文に「あと何をすれば間に合うか」が出ます。</p>
    <div class="mng-list">${items.map(card).join('')}</div>`;
}

// ---------------------------------------------------------------- 教科別テーブル

function renderScopeTable(state, hours, hoursDone, monthly, sc, weekNo, weekStart, detail) {
  const s = state.settings;
  const scopeVal = sc.scope === '' ? null : sc.scope;
  const get = (subjKey) => hours.get(scopeKey(subjKey, scopeVal)) || { week: 0, total: 0, yearTotal: 0 };
  const getDone = (subjKey) => hoursDone.get(scopeKey(subjKey, scopeVal))?.done || 0;

  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }

  const activeRows = [];
  const zeroRows = [];
  let any = false;
  // 長期休業を設定していれば残り・経過の「授業週数」でペースと見込みを計算
  const weeksLeft = teachingWeeksLeft(s, weekStart);
  const weeksElapsed = teachingWeeksElapsed(s, weekStart);
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) continue;
    const own = get(subj.key);
    let week = own.week, total = own.total, yearTotal = own.yearTotal || 0;
    const mergedFrom = [];
    for (const ck of childrenOf[subj.key] || []) {
      const c = get(ck);
      if ((c.yearTotal || 0) > 0 || c.week > 0) mergedFrom.push(s.subjects.find(x => x.key === ck)?.name || ck);
      week += c.week; total += c.total; yearTotal += c.yearTotal || 0;
    }
    let done = getDone(subj.key);
    for (const ck of childrenOf[subj.key] || []) done += getDone(ck);
    const std = standardHoursFor(s, subj.key, sc.grade);
    if (yearTotal === 0 && week === 0 && done === 0 && std == null) continue;
    any = true;
    // 残り・必要ペース・進捗率・見込みは「年間の着地」指標なので、表示週までの累計(total)でなく年間入力済み(yearTotal)を母数にする
    const remain = std != null ? std - yearTotal : null;
    const pace = remain != null && remain > 0 && weeksLeft > 0 ? remain / weeksLeft : null;
    // 分母は経過「授業」週数(暦週数で割ると夏休み以降の着地を恒常的に過小評価する)
    const projected = yearTotal > 0 ? (yearTotal / weeksElapsed) * (s.hoursBase || 35) : null;
    const pct = std ? Math.min(100, Math.round((yearTotal / std) * 100)) : 0;
    const over = std != null && yearTotal > std;
    const row = `
      <tr class="${over ? 'over' : ''}">
        <td class="subj"><span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span>
          ${esc(subj.name)}${mergedFrom.length ? `<span class="hint">(+${mergedFrom.map(esc).join('・')})</span>` : ''}</td>
        <td>${fmtHours(week)}</td>
        <td>${fmtHours(done)}</td>
        ${detail ? `<td><b>${fmtHours(yearTotal)}</b></td>` : ''}
        <td><input data-std="${esc(subj.key)}@${sc.grade}" value="${std ?? ''}" placeholder="—"
              aria-label="${esc(subj.name)}の標準時数"
              style="width:56px; border:none; background:transparent; text-align:right; font-family:inherit;"></td>
        <td>${remain != null ? fmtHours(remain) : '—'}</td>
        ${detail ? `<td>${pace != null ? fmtHours(pace) + ' /週' : '—'}</td>
        <td>${projected != null ? Math.round(projected) : '—'}</td>` : ''}
        <td style="text-align:left;">${hoursBar(done, yearTotal, std)}</td>
      </tr>`;
    // 専科・複式では「時数0で標準だけある行」を畳む(自分の教科1行を探させない)
    if (s.mode !== 'homeroom' && yearTotal === 0 && week === 0 && done === 0) zeroRows.push(row);
    else activeRows.push(row);
  }
  if (!any) return '';
  if (!activeRows.length && s.mode !== 'homeroom') return ''; // この学級は未入力

  let sumWeek = 0, sumYear = 0, sumDone = 0;
  for (const subj of s.subjects) {
    const v = get(subj.key);
    sumWeek += v.week; sumYear += (v.yearTotal || 0); sumDone += getDone(subj.key);
  }

  // 月別・学期別テーブル
  const subjForMonthly = s.subjects.filter(x => !(x.parent && keys.has(x.parent)));
  const getMonthly = (map, subjKey) => {
    if (!map) return 0;
    let v = map.get(scopeKey(subjKey, scopeVal)) || 0;
    for (const ck of childrenOf[subjKey] || []) v += map.get(scopeKey(ck, scopeVal)) || 0;
    return v;
  };
  const monthlyRows = subjForMonthly.map(subj => {
    const cells = MONTH_ORDER.map(m => {
      const v = getMonthly(monthly.months.get(m), subj.key);
      return `<td>${v ? fmtHours(v) : ''}</td>`;
    });
    const termCells = monthly.terms.map(t => {
      const v = getMonthly(t.hours, subj.key);
      return `<td style="background:#f8fafc;"><b>${v ? fmtHours(v) : ''}</b></td>`;
    });
    const yearTotal = monthly.terms.reduce((a, t) => a + getMonthly(t.hours, subj.key), 0);
    if (!yearTotal) return '';
    return `<tr>
      <td class="subj"><span class="subj-chip" style="background:${esc(subj.color)}">${esc(subj.short || subj.name)}</span></td>
      ${cells.join('')}${termCells.join('')}
      <td style="background:#eef2f7;"><b>${fmtHours(yearTotal)}</b></td>
    </tr>`;
  }).filter(Boolean).join('');

  const monthlyTable = monthlyRows ? `
    <details style="margin-bottom:18px;">
      <summary class="fold-label">月別・学期別</summary>
      <div class="table-scroll" style="margin-top:8px;">
        <table class="stats-table">
          <thead><tr><th style="width:60px;">教科</th>${MONTH_ORDER.map(m => `<th>${m}月</th>`).join('')}
            ${monthly.terms.map(t => `<th style="background:#eef2f7;">${esc(t.name)}</th>`).join('')}<th style="background:#e2e8f0;">年度計</th></tr></thead>
          <tbody>${monthlyRows}</tbody>
        </table>
      </div>
    </details>` : '';

  const zeroBlock = zeroRows.length ? `
    <details style="margin-bottom:10px;">
      <summary class="fold-label">未入力の教科 ${zeroRows.length}件</summary>
      <div class="table-scroll">
        <table class="stats-table" style="margin-top:6px;"><tbody>${zeroRows.join('')}</tbody></table>
      </div>
    </details>` : '';

  return `
    ${sc.label ? `<h3>${esc(sc.label)}</h3>` : ''}
    <div class="table-scroll">
    <table class="stats-table" style="margin-bottom:10px;">
      <thead><tr>
        <th style="width:200px;">教科</th><th style="width:64px;">今週</th>
        <th style="width:74px;">実施済${infoHTML('今日までの日付のコマ(中止を除く)。教育委員会への実施時数報告はこちらを使います')}</th>
        ${detail ? `<th style="width:74px;">予定計${infoHTML('表示中の週までに入力したコマの合計(未来日を含む)')}</th>` : ''}
        <th style="width:74px;">標準${infoHTML('学校教育法施行規則の年間標準授業時数。確保すべき目安で、原則として下回らないようにします(上回ることは差し支えありません)。クリックで上書きできます')}</th>
        <th style="width:64px;">残り${infoHTML('標準時数−入力済みのコマ数(未来日を含む)')}</th>
        ${detail ? `<th style="width:84px;">必要ペース${infoHTML('残り時数÷残り授業週数。長期休業を設定すると休業週を除いて計算します')}</th><th style="width:70px;">見込み${infoHTML('現在のペースが続いた場合の年度末の着地')}</th>` : ''}
        <th>進捗</th>
      </tr></thead>
      <tbody>
        ${activeRows.join('')}
        <tr style="background:#f8fafc;">
          <td class="subj">合計</td><td>${fmtHours(sumWeek)}</td><td>${fmtHours(sumDone)}</td>
          ${detail ? `<td><b>${fmtHours(sumYear)}</b></td><td colspan="5"></td>` : '<td colspan="3"></td>'}
        </tr>
      </tbody>
    </table>
    </div>
    ${zeroBlock}
    ${monthlyTable}`;
}

// ---------------------------------------------------------------- CSV出力(教育委員会報告用・数値)

function downloadCSV(state, weekStart) {
  const s = state.settings;
  const hours = computeHours(state, weekStart);
  const monthly = computeMonthlyHours(state, weekStart);
  // 実施は今日現在で数える(過去週を表示していても報告値が欠けないように基準週を別に取る)
  const doneRef = doneRefWeek(weekStart);
  const monthlyDone = computeMonthlyHours(state, doneRef);
  const scopes = scopesOf(s, hours);
  const keys = new Set(s.subjects.map(x => x.key));
  const childrenOf = {};
  for (const subj of s.subjects) {
    if (subj.parent && keys.has(subj.parent)) (childrenOf[subj.parent] = childrenOf[subj.parent] || []).push(subj.key);
  }
  const num = (x) => Math.round(x * 1000) / 1000;
  // CSVフィールドの引用(カンマ・引用符・改行を含む教科名や学級名でも壊れない)
  const q = (v) => {
    const str = String(v ?? '');
    return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  const row = (cells) => cells.map(q).join(',');

  const head = ['学級・学年', '教科', '区分', ...MONTH_ORDER.map(m => `${m}月`), ...MONTH_ORDER.map(m => `${m}月末累計`), '計', '標準', '標準との差'];
  const lines = [row(head)];
  for (const sc of scopes) {
    const scopeVal = sc.scope === '' ? null : sc.scope;
    const getM = (map, subjKey) => {
      if (!map) return 0;
      let v = map.get(scopeKey(subjKey, scopeVal)) || 0;
      for (const ck of childrenOf[subjKey] || []) v += map.get(scopeKey(ck, scopeVal)) || 0;
      return v;
    };
    for (const subj of s.subjects) {
      if (subj.parent && keys.has(subj.parent)) continue;
      const months = MONTH_ORDER.map(m => getM(monthly.months.get(m), subj.key));
      const total = months.reduce((a, b) => a + b, 0);
      const monthsDone = MONTH_ORDER.map(m => getM(monthlyDone.monthsDone.get(m), subj.key));
      const totalDone = monthsDone.reduce((a, b) => a + b, 0);
      if (!total && !totalDone) continue;
      const cumsOf = (arr) => { let c = 0; return arr.map(v => { c += v; return c; }); };
      const std = standardHoursFor(s, subj.key, sc.grade);
      const label = sc.label || `${s.grade}年${s.className || ''}`;
      lines.push(row([
        label, subj.name, '計画',
        ...months.map(num), ...cumsOf(months).map(num), num(total),
        std ?? '', std != null ? num(total - std) : '',
      ]));
      lines.push(row([
        label, subj.name, '実施',
        ...monthsDone.map(num), ...cumsOf(monthsDone).map(num), num(totalDone),
        std ?? '', std != null ? num(totalDone - std) : '',
      ]));
    }
  }
  if (lines.length === 1) { toast('まだ出力できる時数がありません', 'error'); return; }
  // ファイル名の年度は閲覧中の週から導出する(前年度の集計を新年度ラベルで出さない)
  const fy = fiscalYearOf(addDays(parseDate(weekStart), 3));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `時数集計_${fy}年度_${weekStart}まで.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('CSVを保存しました');
}
