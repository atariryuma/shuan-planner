/**
 * GAS同期クライアント。
 * GASのWebアプリはCORSプリフライト(OPTIONS)に応答できないため、
 * POSTは Content-Type: text/plain の「単純リクエスト」で送る(プリフライト回避)。
 * GASは302リダイレクトで応答するので redirect: 'follow' が必須。
 */

export class GasClient {
  constructor(getConfig) {
    this.getConfig = getConfig; // () => ({url, token})
  }

  get configured() {
    const { url, token } = this.getConfig();
    return !!(url && token);
  }

  async call(payload) {
    const { url, token } = this.getConfig();
    if (!url || !token) throw new Error('設定 → Google連携 で接続先URLと合言葉を入力してください');
    if (!/\/exec\s*$/.test(url.trim())) {
      console.warn('GAS URLが /exec で終わっていません。デプロイURLを確認してください。');
    }
    if (!navigator.onLine) throw new Error('オフラインです。接続後にもう一度お試しください');
    let res;
    try {
      res = await fetch(url.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライト回避
        redirect: 'follow',
        body: JSON.stringify({ token, ...payload }),
      });
    } catch {
      // fetchのTypeErrorは英語のままユーザーに見えるため日本語に変換する
      throw new Error('サーバーに接続できません(ネットワークか接続先URLを確認してください)');
    }
    if (!res.ok) throw new Error(`通信エラー (HTTP ${res.status})`);
    // GASはエラー時もHTTP 200で返す。認可エラー等ではJSONでなくHTMLのログインページが
    // 返ることがあるため、先頭文字で防御的に判定する。
    const text = await res.text();
    if (text.trim().startsWith('<')) {
      throw new Error('GASがHTMLを返しました。デプロイ設定(アクセスできるユーザー: 全員)と承認を確認してください');
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('GASからの応答を解釈できません。/exec のURLか確認してください');
    }
    if (!data.ok && !data.conflict) throw new Error(data.error || '不明なエラー');
    return data;
  }

  ping() { return this.call({ action: 'ping' }); }

  /** ローカル全データを送信(同期トークンは保存データに含めない) */
  push(state, { force = false } = {}) {
    const data = JSON.parse(JSON.stringify(state));
    if (data.settings?.gas) data.settings.gas.token = '';
    return this.call({ action: 'push', key: 'default', data, updatedAt: state.updatedAt, force });
  }

  /** サーバーの全データを取得 */
  pull() {
    return this.call({ action: 'pull', key: 'default' });
  }

  /** Googleカレンダーから予定を取得(from/to: YYYY-MM-DD)。calendarIds省略時はメインカレンダー */
  events(from, to, calendarIds = []) {
    return this.call({ action: 'events', from, to, calendarIds });
  }

  /** 利用可能なカレンダー一覧 */
  calendars() {
    return this.call({ action: 'calendars' });
  }

  /** 週案を専用カレンダー「週案」へ書き出す(再実行で置き換え) */
  pushWeek(events, from, to) {
    return this.call({ action: 'pushWeek', events, from, to });
  }

  /** 全データをGoogleドライブへバックアップ(世代管理付き) */
  driveBackup(state, keep = 20) {
    const data = JSON.parse(JSON.stringify(state));
    if (data.settings?.gas) data.settings.gas.token = '';
    return this.call({ action: 'driveBackup', data, keep });
  }

  /** 時数レポートをスプレッドシートへ書き出す(reportはbuildHoursReportの戻り値をそのまま渡す) */
  sheetReport(report) {
    return this.call({ action: 'sheetReport', report });
  }

  /** 週案をスプレッドシートへ書き出す(weekはbuildWeekSheetの戻り値をそのまま渡す) */
  sheetWeek(week) {
    return this.call({ action: 'sheetWeek', week });
  }

  /** 週案をHTMLメールで送信 */
  mailWeek(payload) {
    return this.call({ action: 'mailWeek', ...payload });
  }
}
