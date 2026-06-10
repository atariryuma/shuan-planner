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
  return handle_(e, (e.parameter || {}));
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
    if (!token) return json_({ ok: false, error: 'サーバー側にTOKENが未設定です(スクリプト プロパティを確認)' });
    if (!req.token || req.token !== token) return json_({ ok: false, error: '認証エラー: トークンが一致しません' });

    var action = req.action || 'ping';
    if (action === 'ping') return json_({ ok: true, message: 'pong', time: new Date().toISOString() });
    if (action === 'pull') return pull_(req);
    if (action === 'push') return push_(req);
    if (action === 'events') return events_(req);
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
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
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
  if (!lock.tryLock(20000)) return json_({ ok: false, error: '他の同期処理が実行中です。少し待って再試行してください' });
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
  if (!lock.tryLock(20000)) return json_({ ok: false, error: '他の同期処理が実行中です。少し待って再試行してください' });
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

/** Googleカレンダーから期間内の予定を取得(行事欄の自動入力用) */
function events_(req) {
  var from = new Date(req.from + 'T00:00:00+09:00');
  var to = new Date(req.to + 'T23:59:59+09:00');
  if (isNaN(from) || isNaN(to)) return json_({ ok: false, error: 'from/to(YYYY-MM-DD)を指定してください' });
  var cal = req.calendarId ? CalendarApp.getCalendarById(req.calendarId) : CalendarApp.getDefaultCalendar();
  if (!cal) return json_({ ok: false, error: 'カレンダーが見つかりません: ' + req.calendarId });
  var events = cal.getEvents(from, to).map(function (ev) {
    var start = ev.getStartTime();
    return {
      date: Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd'),
      time: ev.isAllDayEvent() ? '' : Utilities.formatDate(start, 'Asia/Tokyo', 'HH:mm'),
      title: ev.getTitle(),
    };
  });
  return json_({ ok: true, events: events });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
