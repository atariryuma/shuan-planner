/**
 * 週案プランナー GASバックエンド
 * ─────────────────────────────────────────────
 * セットアップ手順(詳細は docs/gas-setup.md):
 *  1. https://script.google.com で「新しいプロジェクト」を作成し、このファイルの内容を貼り付ける
 *  2. 左メニュー「プロジェクトの設定」→「スクリプト プロパティ」に
 *       プロパティ: TOKEN / 値: 任意の長いランダム文字列(例: 32文字以上)
 *     を追加する(アプリの設定画面に入れる「同期トークン」と同じ値にする)
 *  3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 全員
 *     でデプロイし、表示された /exec で終わるURLをアプリの設定画面に貼る
 *  4. コードを更新したときは「デプロイを管理」→ 既存デプロイの「編集」→
 *     バージョン「新バージョン」で更新するとURLが変わらない
 *
 * データはこのスクリプトに紐づくスプレッドシート(無ければ自動作成)に保存される。
 * セルの50,000文字制限を避けるため、JSONを45,000文字ずつに分割して保存する。
 */

var CHUNK = 45000;

function doGet(e) {
  var p = (e && e.parameter) || {};
  // action付きのGETは従来通りAPIとして扱う(後方互換)。
  // それ以外(ブラウザでの素のアクセス)はアプリ本体(Index.html)を配信する。
  // ＝この1つのデプロイで「アプリの配信」と「同期API」を兼ねる。
  // ※同期クライアント(gas.js)はすべてPOST(doPost)なので、ページ配信と衝突しない。
  if (p.action) return handle_(e, p);
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ルーズリーフ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
  } catch (err) {
    return json_({ ok: false, error: 'invalid JSON body' });
  }
  return handle_(e, body);
}

function handle_(e, req) {
  try {
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    // 画面にそのまま表示される。実装用語(TOKEN等)を出さず、括弧の誘導も付けない(規約3=結果報告のみ)
    if (!token) return json_({ ok: false, error: 'サーバーに合言葉が未設定です' });
    if (!req.token || req.token !== token) return json_({ ok: false, error: '認証エラー: 合言葉が一致しません' });

    var action = req.action || 'ping';
    if (action === 'ping') return json_({ ok: true, message: 'pong', time: new Date().toISOString() });
    if (action === 'pull') return pull_(req);
    if (action === 'push') return push_(req);
    if (action === 'events') return events_(req);
    if (action === 'calendars') return calendars_(req);
    if (action === 'pushWeek') return pushWeek_(req);
    if (action === 'driveBackup') return driveBackup_(req);
    if (action === 'listBackups') return listBackups_(req);
    if (action === 'fetchBackup') return fetchBackup_(req);
    if (action === 'sheetReport') return sheetReport_(req);
    if (action === 'sheetWeek') return sheetWeek_(req);
    if (action === 'mailWeek') return mailWeek_(req);
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ------------------------------------------------------------ storage

function sheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  var ss = null;
  if (id) {
    // openByIdはゴミ箱内のファイルも開けてしまうため、isTrashedも確認する
    try {
      if (!DriveApp.getFileById(id).isTrashed()) ss = SpreadsheetApp.openById(id);
    } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('週案プランナー保存データ');
    props.setProperty('SHEET_ID', ss.getId());
  }
  var sh = ss.getSheetByName('store');
  if (!sh) sh = ss.insertSheet('store');
  return sh;
}

function readDoc_(docKey) {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 1) return null;
  var rows = sh.getRange(1, 1, last, 3).getValues(); // [docKey, seq, chunk]
  var meta = null, chunks = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) !== docKey) continue;
    if (String(rows[i][1]) === 'meta') meta = rows[i][2];
    else chunks.push([Number(rows[i][1]), String(rows[i][2])]);
  }
  if (!meta && chunks.length === 0) return null;
  chunks.sort(function (a, b) { return a[0] - b[0]; });
  var metaObj = {};
  try { metaObj = JSON.parse(meta || '{}'); } catch (e) {}
  // v2形式: 各チャンクの先頭に番兵文字 'x' を付けて保存している
  // (「=」始まりが数式扱いされる・先頭アポストロフィが消えるSheetsの仕様への防御)
  var jsonStr = chunks.map(function (c) {
    return metaObj.v >= 2 ? c[1].substring(1) : c[1];
  }).join('');
  return { meta: metaObj, json: jsonStr };
}

function writeDoc_(docKey, jsonStr, metaObj) {
  var sh = sheet_();
  metaObj.v = 2;
  var out = [[docKey, 'meta', JSON.stringify(metaObj)]];
  for (var p = 0, seq = 0; p < jsonStr.length; seq++) {
    var len = CHUNK;
    // サロゲートペア(絵文字等)を分断しない: 末尾が上位サロゲートなら1文字手前で切る
    var lastCode = jsonStr.charCodeAt(p + len - 1);
    if (p + len < jsonStr.length && lastCode >= 0xD800 && lastCode <= 0xDBFF) len -= 1;
    out.push([docKey, seq, 'x' + jsonStr.substr(p, len)]);
    p += len;
  }
  // 他docKeyの行を残しつつ全体を組み直して一括書き込み(deleteRowループより高速で、
  // 「削除済み・未書込」の中間状態の時間窓も最小化される)
  var keep = [];
  var last = sh.getLastRow();
  if (last >= 1) {
    var rows = sh.getRange(1, 1, last, 3).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) !== docKey && String(rows[i][0]) !== '') keep.push(rows[i]);
    }
  }
  var all = keep.concat(out);
  sh.clearContents();
  var range = sh.getRange(1, 1, all.length, 3);
  range.setNumberFormat('@'); // プレーンテキスト書式(数式・日付の自動解釈を防ぐ)
  range.setValues(all);
}

// ------------------------------------------------------------ actions

function pull_(req) {
  var docKey = String(req.key || 'default');
  // push中の中間状態(書き換え途中)を読まないようロックを取る
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: '他の同期処理が実行中です' });
  try {
    var doc = readDoc_(docKey);
    if (!doc) return json_({ ok: true, exists: false });
    return json_({ ok: true, exists: true, updatedAt: doc.meta.updatedAt || 0, data: JSON.parse(doc.json) });
  } finally {
    lock.releaseLock();
  }
}

function push_(req) {
  if (!req.data) return json_({ ok: false, error: 'dataがありません' });
  var docKey = String(req.key || 'default');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: '他の同期処理が実行中です' });
  try {
    var incomingAt = Number(req.updatedAt || 0);
    var existing = readDoc_(docKey);
    var serverAt = existing ? Number(existing.meta.updatedAt || 0) : 0;
    if (existing && serverAt > incomingAt && !req.force) {
      return json_({
        ok: false, conflict: true,
        error: 'サーバーに新しいデータがあります。先に「取得」するか、強制送信してください',
        serverUpdatedAt: serverAt,
      });
    }
    // サーバーのupdatedAtは単調増加させる(強制送信で過去に巻き戻すと、
    // 以後の他端末からの送信が競合検出をすり抜けてしまうため)
    var newAt = Math.max(incomingAt || Date.now(), serverAt + 1);
    writeDoc_(docKey, JSON.stringify(req.data), { updatedAt: newAt, savedAt: new Date().toISOString() });
    SpreadsheetApp.flush(); // ロック解放前に書き込みを確定させる
    return json_({ ok: true, updatedAt: newAt });
  } finally {
    lock.releaseLock();
  }
}

/** Googleカレンダーから期間内の予定を取得(行事欄の自動入力用)。複数カレンダー対応 */
function events_(req) {
  var from = new Date(req.from + 'T00:00:00+09:00');
  var to = new Date(req.to + 'T23:59:59+09:00');
  if (isNaN(from) || isNaN(to)) return json_({ ok: false, error: 'from/to(YYYY-MM-DD)を指定してください' });
  var ids = req.calendarIds && req.calendarIds.length ? req.calendarIds
    : (req.calendarId ? [req.calendarId] : ['primary']);
  var events = [];
  var errors = [];
  ids.forEach(function (id) {
    var cal = (id === 'primary') ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
    if (!cal) { errors.push('カレンダーが見つかりません: ' + id); return; }
    cal.getEvents(from, to).forEach(function (ev) {
      // 自分が書き出した週案イベントは行事として取り込まない
      if (ev.getTag && ev.getTag('shuanPlanner')) return;
      var start = ev.getStartTime();
      var title = ev.getTitle();
      if (ev.isAllDayEvent()) {
        // 終日イベントは複数日にまたがることがある(宿泊学習・修学旅行など)。
        // 取得期間と重なる各日に展開する(getEndTimeは最終日の翌日0時=排他的)。
        var dayMs = 24 * 60 * 60 * 1000;
        var s = ev.getAllDayStartDate ? ev.getAllDayStartDate() : start;
        var e = ev.getAllDayEndDate ? ev.getAllDayEndDate() : new Date(start.getTime() + dayMs);
        for (var t = s.getTime(); t < e.getTime(); t += dayMs) {
          var ds = Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy-MM-dd');
          if (ds < req.from || ds > req.to) continue; // 取得期間外の日は除く
          events.push({ date: ds, time: '', title: title });
        }
      } else {
        events.push({
          date: Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd'),
          time: Utilities.formatDate(start, 'Asia/Tokyo', 'HH:mm'),
          title: title,
        });
      }
    });
  });
  events.sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });
  return json_({ ok: true, events: events, errors: errors });
}

/** 利用可能なカレンダーの一覧(所有+購読) */
function calendars_(req) {
  var primaryId = CalendarApp.getDefaultCalendar().getId();
  var list = CalendarApp.getAllCalendars().map(function (c) {
    return { id: c.getId(), name: c.getName(), primary: c.getId() === primaryId };
  });
  return json_({ ok: true, calendars: list });
}

/**
 * 週案をGoogleカレンダーへ書き出す。
 * 専用カレンダー「週案」を自動作成し、期間内の既存の書き出し分(タグ付き)を消してから登録する
 * (二重登録を防ぎ、再書き出しで常に最新の週案に置き換わる)。
 */
function pushWeek_(req) {
  var items = req.events || []; // [{date:'YYYY-MM-DD', start:'HH:mm', end:'HH:mm', title, detail}]
  var from = new Date(req.from + 'T00:00:00+09:00');
  var to = new Date(req.to + 'T23:59:59+09:00');
  if (isNaN(from) || isNaN(to)) return json_({ ok: false, error: 'from/toを指定してください' });

  var props = PropertiesService.getScriptProperties();
  var calId = props.getProperty('SHUAN_CALENDAR_ID');
  var cal = calId ? CalendarApp.getCalendarById(calId) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar('週案', { timeZone: 'Asia/Tokyo', color: '#0B8043' });
    props.setProperty('SHUAN_CALENDAR_ID', cal.getId());
  }

  // 期間内の既存の書き出し分を削除(このアプリが付けたタグだけを対象にする)
  var removed = 0;
  cal.getEvents(from, to).forEach(function (ev, i) {
    if (ev.getTag('shuanPlanner')) {
      ev.deleteEvent();
      removed++;
      if (removed % 10 === 0) Utilities.sleep(1000); // 短時間レート制限対策(公式推奨)
    }
  });

  var created = 0;
  items.forEach(function (it, i) {
    if (!it.date || !it.start || !it.end || !it.title) return;
    var start = new Date(it.date + 'T' + it.start + ':00+09:00');
    var end = new Date(it.date + 'T' + it.end + ':00+09:00');
    if (isNaN(start) || isNaN(end) || end <= start) return;
    var ev = cal.createEvent(it.title, start, end, { description: it.detail || '' });
    ev.setTag('shuanPlanner', '1');
    created++;
    if (created % 10 === 0) Utilities.sleep(1000);
  });
  return json_({ ok: true, created: created, removed: removed, calendarName: cal.getName() });
}

/** 全データJSONをGoogleドライブへバックアップ(世代管理付き) */
function driveBackup_(req) {
  if (!req.data) return json_({ ok: false, error: 'dataがありません' });
  var keep = Math.max(3, Math.min(100, Number(req.keep) || 20));
  var folder = backupFolder_();
  var name = 'shuan-backup-' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss') + '.json';
  folder.createFile(name, JSON.stringify(req.data), 'application/json');
  // 古い世代を削除(名前に日時が入っているので名前順=時系列)
  var files = [];
  var iter = folder.getFiles();
  while (iter.hasNext()) {
    var f = iter.next();
    if (/^shuan-backup-.*\.json$/.test(f.getName())) files.push(f);
  }
  files.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  var deleted = 0;
  while (files.length > keep) {
    files.shift().setTrashed(true);
    deleted++;
  }
  return json_({ ok: true, file: name, kept: Math.min(files.length, keep), deleted: deleted, folderUrl: folder.getUrl() });
}

/** ドライブのバックアップ一覧(新しい順)。本体は返さず、復元の選択用にメタ情報だけ。 */
function listBackups_(req) {
  var folder = backupFolder_();
  var items = [];
  var iter = folder.getFiles();
  while (iter.hasNext()) {
    var f = iter.next();
    if (!/^shuan-backup-.*\.json$/.test(f.getName())) continue;
    items.push({ id: f.getId(), name: f.getName(), date: f.getLastUpdated().toISOString(), size: f.getSize() });
  }
  items.sort(function (a, b) { return a.date < b.date ? 1 : -1; }); // 新しい順
  return json_({ ok: true, backups: items.slice(0, 40), folderUrl: folder.getUrl() });
}

/** 指定IDのバックアップ本体(JSON)を返す。バックアップフォルダ内のものだけ許可する。 */
function fetchBackup_(req) {
  if (!req.id) return json_({ ok: false, error: 'idがありません' });
  var folder = backupFolder_();
  var file;
  try { file = DriveApp.getFileById(req.id); } catch (e) { return json_({ ok: false, error: 'バックアップが見つかりません' }); }
  // 安全のため、バックアップフォルダ配下かつ命名規則に合うものだけ
  if (!/^shuan-backup-.*\.json$/.test(file.getName())) return json_({ ok: false, error: 'バックアップではありません' });
  var ok = false, parents = file.getParents();
  while (parents.hasNext()) { if (parents.next().getId() === folder.getId()) { ok = true; break; } }
  if (!ok) return json_({ ok: false, error: 'バックアップフォルダ外のファイルです' });
  var data;
  try { data = JSON.parse(file.getBlob().getDataAsString()); } catch (e) { return json_({ ok: false, error: '中身を解釈できません' }); }
  return json_({ ok: true, data: data, name: file.getName() });
}

function backupFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BACKUP_FOLDER_ID');
  if (id) {
    // ユーザーがフォルダをゴミ箱に入れた場合、getFolderByIdは例外を投げずに
    // ゴミ箱内のフォルダを返す(=バックアップが30日で消える)ため、isTrashedを確認する
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* 完全削除済みなら作り直す */ }
  }
  var folder = DriveApp.createFolder('週案バックアップ');
  props.setProperty('BACKUP_FOLDER_ID', folder.getId());
  return folder;
}

/** 時数レポートをスプレッドシートに書き出す(教科×月の表+学期計+年度計) */
function sheetReport_(req) {
  var r = req.report;
  if (!r || !r.rows || !r.rows.length) return json_({ ok: false, error: 'レポートデータがありません' });
  var ss = reportSpreadsheet_();
  var sheet = recreateSheet_(ss, String(r.sheetName || 'レポート'));

  var header = ['教科'].concat(r.monthLabels, r.termLabels, ['年度計', '標準', '残り']);
  var values = [header];
  r.rows.forEach(function (row) {
    values.push([row.subject].concat(row.months, row.terms, [row.total, row.standard || '', row.remain != null ? row.remain : '']));
  });

  var numRows = values.length, numCols = header.length;
  var range = sheet.getRange(1, 1, numRows, numCols);
  range.setNumberFormat('@');
  range.setValues(values);
  var bgs = values.map(function (row, i) {
    return row.map(function (_, c) {
      if (i === 0) return '#1f7ac2';
      if (c >= 1 + r.monthLabels.length && c < 1 + r.monthLabels.length + r.termLabels.length) return '#eef2f7';
      if (c >= 1 + r.monthLabels.length + r.termLabels.length) return '#e8edf3';
      return i % 2 ? '#ffffff' : '#f7f9fc';
    });
  });
  range.setBackgrounds(bgs);
  range.setBorder(true, true, true, true, true, true, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(1, 1, 1, numCols).setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidths(2, numCols - 1, 56);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  SpreadsheetApp.flush();
  return json_({ ok: true, url: ss.getUrl() + '#gid=' + sheet.getSheetId() });
}

/** 1週間の週案をスプレッドシートに書き出す(共有・提出用) */
function sheetWeek_(req) {
  var w = req.week;
  if (!w || !w.rows) return json_({ ok: false, error: '週データがありません' });
  var ss = reportSpreadsheet_();
  var sheet = recreateSheet_(ss, String(w.sheetName || '週案'));

  var values = [[w.title || '週案']].concat([w.header], w.rows, w.footer || []);
  // 行ごとの列数を揃える
  var numCols = Math.max.apply(null, values.map(function (r) { return r.length; }));
  values = values.map(function (r) { while (r.length < numCols) r.push(''); return r; });

  var range = sheet.getRange(1, 1, values.length, numCols);
  range.setNumberFormat('@');
  range.setValues(values);
  range.setBorder(true, true, true, true, true, true, '#999999', SpreadsheetApp.BorderStyle.SOLID);
  range.setVerticalAlignment('top').setWrap(true);
  sheet.getRange(1, 1, 1, numCols).mergeAcross().setFontWeight('bold').setFontSize(13);
  sheet.getRange(2, 1, 1, numCols).setBackground('#1f7ac2').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setColumnWidth(1, 52);
  sheet.setColumnWidths(2, numCols - 1, 170);
  SpreadsheetApp.flush();
  return json_({ ok: true, url: ss.getUrl() + '#gid=' + sheet.getSheetId() });
}

function reportSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('REPORT_SS_ID');
  if (id) {
    try {
      if (!DriveApp.getFileById(id).isTrashed()) return SpreadsheetApp.openById(id);
    } catch (e) { /* 完全削除済みなら作り直す */ }
  }
  var ss = SpreadsheetApp.create('週案プランナー出力');
  props.setProperty('REPORT_SS_ID', ss.getId());
  return ss;
}

/** 同名シートを削除して作り直す(最後の1枚は削除できないため一時シートを挟む) */
function recreateSheet_(ss, name) {
  var old = ss.getSheetByName(name);
  if (old) {
    if (ss.getSheets().length === 1) ss.insertSheet('_tmp_');
    ss.deleteSheet(old);
  }
  var sheet = ss.insertSheet(name, 0);
  var tmp = ss.getSheetByName('_tmp_');
  if (tmp) ss.deleteSheet(tmp);
  return sheet;
}

/** 週案をHTMLメールで送信(管理職への提出など)。クォータ: 無料アカウントは100通(受信者)/日 */
function mailWeek_(req) {
  if (!req.to) return json_({ ok: false, error: '送信先メールアドレスを指定してください' });
  if (!req.subject || !req.html) return json_({ ok: false, error: '件名・本文がありません' });
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining < 1) return json_({ ok: false, error: '本日のメール送信枠を使い切りました' });
  MailApp.sendEmail(String(req.to), String(req.subject), String(req.text || '週案を送付します。HTML対応メーラーでご覧ください。'), {
    htmlBody: String(req.html),
    name: req.senderName ? String(req.senderName) : '週案プランナー',
  });
  return json_({ ok: true, remaining: remaining - 1 });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
