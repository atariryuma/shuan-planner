/**
 * GAS Web App ビルダー（依存ゼロ・Node標準のみ）
 * ─────────────────────────────────────────────
 * 目的: 職場などGitHub Pagesにアクセスできない環境向けに、同じアプリを
 *   Google Apps Script の Web アプリ（HtmlService）として配信できる
 *   1枚の `gas/Index.html` を生成する。
 *
 * 方針: 本体ソース（js/ css/ index.html sw.js）は一切変更しない。
 *   ESモジュール18ファイルを「モジュールレジストリ方式」で1つの古典的
 *   <script> に束ね、CSS・アイコンを埋め込んだ単一HTMLを出力する。
 *   - import { a, b } from './x.js'  →  const { a, b } = __M['x.js'];
 *   - export function/const/class    →  宣言からexportを外し、戻り値にまとめる
 *   - await import('./x.js')         →  await Promise.resolve(__M['x.js'])
 *   依存はDAG（循環なし）なのでトポロジカル順に評価すれば前方参照は起きない。
 *
 * 使い方:  node gas/build-webapp.mjs
 *   → gas/Index.html を生成（GASプロジェクトに「Index」HTMLファイルとして貼る）
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = join(ROOT, 'js');

// ---- 1. 全モジュールを収集（js/ 配下の .js を再帰）。id は js/ からの相対（posix） ----
function collect(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full, prefix + name + '/'));
    else if (name.endsWith('.js')) out.push(prefix + name);
  }
  return out;
}
const ids = collect(JS_DIR);
const src = new Map(ids.map(id => [id, readFileSync(join(JS_DIR, id), 'utf8')]));

// 指定子（'./x.js' / '../x.js'）を importer から解決して id（posix）にする
function resolveId(importerId, spec) {
  const baseDir = importerId.includes('/') ? importerId.slice(0, importerId.lastIndexOf('/')) : '';
  const parts = (baseDir ? baseDir.split('/') : []);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    else if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// ---- 2. 静的import解析 → 依存グラフ → トポロジカル順 ----
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/;
const deps = new Map();
for (const id of ids) {
  const set = new Set();
  for (const line of src.get(id).split('\n')) {
    const m = line.match(IMPORT_RE);
    if (m) set.add(resolveId(id, m[2]));
  }
  deps.set(id, set);
}
const order = [];
const seen = new Set();
const temp = new Set();
function visit(id, stack) {
  if (seen.has(id)) return;
  if (temp.has(id)) throw new Error(`循環依存を検出: ${[...stack, id].join(' → ')}`);
  temp.add(id);
  for (const d of deps.get(id) || []) {
    if (!src.has(d)) throw new Error(`未解決の依存: ${id} → ${d}`);
    visit(d, [...stack, id]);
  }
  temp.delete(id);
  seen.add(id);
  order.push(id);
}
for (const id of ids) visit(id, []);
// エントリ（app.js）は副作用で起動するので必ず最後に評価する
// （動的importのみで参照される gws.js 等が先に登録済みになるよう保証）
const ENTRY = 'app.js';
if (order.includes(ENTRY)) order.splice(order.indexOf(ENTRY), 1), order.push(ENTRY);

// ---- 3. 各モジュールを変換（import除去・export収集・dynamic import書換） ----
function transform(id) {
  const exports = new Set();
  const lines = src.get(id).split('\n').map(line => {
    // import { ... } from '...'  →  const { ... } = __M['id'];
    const im = line.match(IMPORT_RE);
    if (im) {
      const names = im[1].trim().replace(/\bas\b/g, ':'); // { a as b } → { a : b }
      return `const {${names}} = __M[${JSON.stringify(resolveId(id, im[2]))}];`;
    }
    // export { a, b };  （再エクスポート/まとめ）→ 行を消し、名前だけ収集
    const ex = line.match(/^export\s*\{([^}]*)\}\s*;?\s*$/);
    if (ex) {
      ex[1].split(',').forEach(n => { const t = n.trim().split(/\bas\b/).pop().trim(); if (t) exports.add(t); });
      return '';
    }
    // export (async) function NAME / export class NAME → export を外して収集
    const fn = line.match(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (fn) { exports.add(fn[1]); return line.replace(/^export\s+/, ''); }
    const cls = line.match(/^export\s+class\s+([A-Za-z0-9_$]+)/);
    if (cls) { exports.add(cls[1]); return line.replace(/^export\s+/, ''); }
    // export const/let/var NAME（= の前の識別子を収集。複数宣言にも対応）
    const vr = line.match(/^export\s+(const|let|var)\s+(.+)$/);
    if (vr) {
      const decl = vr[2];
      const head = decl.split('=')[0]; // 'A' か 'A, B'（分割代入は使われていない前提）
      head.split(',').forEach(n => { const t = n.trim(); if (/^[A-Za-z0-9_$]+$/.test(t)) exports.add(t); });
      return line.replace(/^export\s+/, '');
    }
    return line;
  });
  let body = lines.join('\n');
  // await import('./x.js') → await Promise.resolve(__M['x.js'])（束ね済みなので即解決）
  body = body.replace(/import\(\s*['"]([^'"]+)['"]\s*\)/g,
    (_, spec) => `Promise.resolve(__M[${JSON.stringify(resolveId(id, spec))}])`);
  const ret = exports.size ? `\nreturn { ${[...exports].join(', ')} };` : '';
  return `__M[${JSON.stringify(id)}] = (function(){\n${body}${ret}\n})();`;
}

const bundle = [
  '(function(){',
  '"use strict";',
  'var __M = {};',
  ...order.map(transform),
  '})();',
].join('\n');

// ---- 4. HTMLを組み立て（index.html を土台に、CSS/アイコンを埋め込み、SPAスクリプトを差し替え） ----
const iconSvg = readFileSync(join(ROOT, 'icons', 'icon.svg'), 'utf8');
const iconData = 'data:image/svg+xml;utf8,' + encodeURIComponent(iconSvg);
const appCss = readFileSync(join(ROOT, 'css', 'app.css'), 'utf8');
const printCss = readFileSync(join(ROOT, 'css', 'print.css'), 'utf8');

let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
html = html
  .replace(/<link rel="manifest"[^>]*>\s*/i, '')
  .replace(/<link rel="icon"[^>]*>/i, `<link rel="icon" href="${iconData}">`)
  .replace(/<link rel="stylesheet" href="css\/app\.css">/i, `<style>\n${appCss}\n</style>`)
  .replace(/<link rel="stylesheet" href="css\/print\.css">/i, `<style>\n${printCss}\n</style>`)
  .replace(/src="icons\/icon\.svg"/g, `src="${iconData}"`)
  .replace(/<script type="module" src="js\/app\.js"><\/script>/i, `<script>\n${bundle}\n</script>`);

// GAS配信であることが分かるよう控えめな目印（任意・無害）
html = html.replace('</head>', '<meta name="generator" content="loose-leaf GAS web app">\n</head>');

writeFileSync(join(ROOT, 'gas', 'Index.html'), html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`gas/Index.html を生成しました（${ids.length}モジュールを束ね、${kb} KB）`);
console.log('評価順:', order.join(' → '));
