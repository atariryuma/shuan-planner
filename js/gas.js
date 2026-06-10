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
    if (!url || !token) throw new Error('設定画面でGASのURLと同期トークンを入力してください');
    if (!/\/exec\s*$/.test(url.trim())) {
      console.warn('GAS URLが /exec で終わっていません。デプロイURLを確認してください。');
    }
    const res = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライト回避
      redirect: 'follow',
      body: JSON.stringify({ token, ...payload }),
    });
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

  /** Googleカレンダーから予定を取得(from/to: YYYY-MM-DD) */
  events(from, to, calendarId = '') {
    return this.call({ action: 'events', from, to, calendarId });
  }
}
