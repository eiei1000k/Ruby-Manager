'use strict';
/* global api */

// ================================================================ state
const S = {
  view: 'overview',           // overview | rubies | project
  env: null,                  // { platform, managers, rubies }
  projects: [],
  selected: null,             // project path
  tab: 'overview',            // project tab: overview | gems
  gemFilter: '',
  sideFilter: '',
  directOnly: false,
  outdated: {},               // path -> { gem: info }
  rubyDetail: {},             // rubyId -> detail | 'loading' | { error }
  jobs: [],                   // { id, title, command, out: [], running, code }
  activeJob: null,
  logOpen: false,
  scanning: false,
  theme: 'system',
};
const jobMeta = new Map();    // jobId -> { project, kind }
const PLATFORMS = ['ruby', 'x86_64-linux', 'aarch64-linux', 'arm64-darwin', 'x86_64-darwin', 'x64-mingw-ucrt'];
const PALETTE = ['blue', 'green', 'orange', 'purple', 'teal', 'pink', 'indigo', 'cyan', 'brown', 'mint'];

// ================================================================ icons (Lucide, ISC License)
const ICONS = {
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  xmark: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  sparkles: '<path d="m14 4 .9 2.1L17 7l-2.1.9L14 10l-.9-2.1L11 7l2.1-.9Z"/><path d="m19 12 .6 1.4 1.4.6-1.4.6L19 16l-.6-1.4-1.4-.6 1.4-.6Z"/><path d="M9.94 14.06 4 20"/><path d="M5 3v4"/><path d="M3 5h4"/>',
  broom: '<path d="m13 11 9-9"/><path d="M14.6 12.6c.8.8.9 2.1.2 3L10 22l-8-8 6.4-4.8c.9-.7 2.2-.6 3 .2Z"/><path d="m6.8 10.4 6.8 6.8"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
};
function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ================================================================ helpers
const $ = (sel) => document.querySelector(sel);
function h(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function norm(v) { return String(v || '').trim().replace(/^ruby[-@ ]/i, '').replace(/p\d+$/, ''); }
function series(v) { const m = norm(v).match(/^(\d+)\.(\d+)/); return m ? `${m[1]}.${m[2]}` : norm(v); }
function cmpVer(a, b) {
  const pa = norm(a).split(/[.\-]/); const pb = norm(b).split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'; const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x - +y; } else if (nx !== ny) return nx ? 1 : -1; else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
/** シリーズ（3.3 等）ごとに iOS システムカラーを割り当てる */
function seriesColor(v) {
  const [maj, min] = series(v).split('.').map(Number);
  if (Number.isNaN(maj)) return 'var(--gray)';
  return `var(--${PALETTE[(maj * 10 + (min || 0)) % PALETTE.length]})`;
}
function hashColor(str) {
  let x = 0;
  for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--${PALETTE[x % PALETTE.length]})`;
}
const sq = (content, color, cls = '') => `<span class="sq ${cls}" style="--c:${color}">${content}</span>`;
const iconSq = (name, color, cls = '') => sq(icon(name), `var(--${color})`, cls);
function letterSq(name, cls = '') {
  const ch = (String(name).match(/[A-Za-z0-9]/) || [String(name)[0] || '?'])[0].toUpperCase();
  return sq(h(ch), hashColor(name), cls);
}
function verSq(v, cls = '') {
  const label = /^\d/.test(norm(v)) ? series(v) : (norm(v).split('-')[0] || '?').slice(0, 3);
  return sq(h(label), seriesColor(v), `ver ${cls}`);
}
const chev = () => icon('chevronRight', 'chev');

/** iOS の inset grouped セクション */
function group(head, body, foot = '', headAction = '') {
  return `<section class="group">${head || headAction ? `<div class="group-head"><span>${head || ''}</span><span class="spacer"></span>${headAction}</div>` : ''}
    <div class="list">${body}</div>${foot ? `<div class="group-foot">${foot}</div>` : ''}</section>`;
}
/** リストのセル */
function cell({ lead = '', title = '', sub = '', value = '', acc = '', attrs = '', cls = '' }) {
  return `<div class="cell ${cls}" ${attrs}>${lead}<div class="cell-main">
    <div class="cell-text"><div class="cell-title">${title}</div>${sub ? `<div class="cell-sub">${sub}</div>` : ''}</div>
    ${value !== '' && value != null ? `<div class="cell-value">${value}</div>` : ''}${acc}</div></div>`;
}
/** タップで実行するアクション行（iOS のテキストボタン行） */
function actionCell(label, ic, attrs, { destructive = false, disabled = false } = {}) {
  return `<div class="cell action ${destructive ? 'destructive' : ''}" role="button" tabindex="${disabled ? -1 : 0}" ${attrs} ${disabled ? 'disabled' : ''}>
    <div class="cell-main"><div class="cell-text"><div class="cell-title">${ic ? icon(ic) : ''}<span>${label}</span></div></div></div></div>`;
}

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' error' : '');
  el.innerHTML = `<span class="circle">${icon(isErr ? 'xmark' : 'check')}</span><span></span>`;
  el.querySelector('span:last-child').textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, isErr ? 7000 : 3200);
}
async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; }
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');
const installers = () => (S.env ? S.env.managers.filter((m) => m.canInstall) : []);
const rubyById = (id) => S.env && S.env.rubies.find((r) => r.id === id);
const LC_ICON = { eol: 'alert', security: 'lock', normal: 'check', unknown: 'info' };
const lcBadge = (lc) => `<span class="badge ${h(lc.status)}" title="${lc.eol ? 'サポート終了: ' + h(lc.eol) : ''}">${icon(LC_ICON[lc.status] || 'info')}${h(lc.label)}</span>`;
const globalBadge = () => `<span class="badge global">${icon('star')}global</span>`;
function projectsUsing(ruby) { return S.projects.filter((p) => p.resolved && p.resolved.id === ruby.id); }
function currentProject() { return S.projects.find((p) => p.path === S.selected); }

// ================================================================ theme
function applyTheme(t) {
  S.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* ignore */ }
  guard(() => api.setTheme(t));
  renderSideFoot();
}

// ================================================================ data
async function rescan() {
  S.scanning = true; renderTop();
  await guard(async () => {
    S.env = await api.scan();
    S.projects = await api.listProjects();
    S.rubyDetail = {};
  });
  S.scanning = false;
  render();
}
async function refreshProject(dir) {
  const p = await guard(() => api.analyzeProject(dir));
  if (!p) return;
  const i = S.projects.findIndex((x) => x.path === dir);
  if (i >= 0) S.projects[i] = p;
  render();
}
async function loadRubyDetail(id) {
  if (!id || S.rubyDetail[id]) return;
  S.rubyDetail[id] = 'loading';
  try { S.rubyDetail[id] = await api.rubyDetail(id); } catch (e) { S.rubyDetail[id] = { error: e.message }; }
  render();
}

// ================================================================ render: shell
let lastViewKey = '';
function render() {
  renderSide();
  renderTop();
  const v = $('#view');
  const key = `${S.view}|${S.selected}|${S.tab}`;
  const scroll = key === lastViewKey ? v.scrollTop : 0;
  let html;
  if (!S.env) html = viewLoading();
  else if (S.view === 'overview') html = viewOverview();
  else if (S.view === 'rubies') html = viewRubies();
  else html = viewProject();
  v.innerHTML = `<div class="view-inner">${html}</div>`;
  v.scrollTop = scroll;
  lastViewKey = key;
  renderLog();
}
function viewLoading() {
  const sk = (w, hgt) => `<div class="skeleton" style="width:${w};height:${hgt}px"></div>`;
  return `<div class="tiles">${[1, 2, 3, 4].map(() => `<div class="tile">${sk('34px', 34)}${sk('50%', 14)}</div>`).join('')}</div>
    ${group('', [1, 2, 3].map(() => cell({ lead: sk('29px', 29), title: sk('40%', 14) })).join(''))}`;
}
function renderSide() {
  if (S.env) {
    const mgrs = S.env.managers.filter((m) => m.available && !m.readonly).map((m) => m.name);
    $('#brand-sub').textContent = mgrs.length ? mgrs.join(' · ') : 'マネージャ未検出';
  }
  if (S.projects.length > 4 && !$('#side-search').firstChild) {
    $('#side-search').innerHTML = `${icon('search')}<input type="search" id="side-filter-input" placeholder="検索">`;
  }
  const navCell = (view, ic, color, label, count) => cell({
    lead: iconSq(ic, color), title: label, value: count === '' ? '' : `<span>${count}</span>`,
    cls: `tap ${S.view === view ? 'selected' : ''}`, attrs: `data-action="go" data-view="${view}"`,
  });
  $('#nav').innerHTML = group('', navCell('overview', 'dashboard', 'blue', '概要', '') + navCell('rubies', 'gem', 'red', 'Ruby バージョン', S.env ? S.env.rubies.length : ''));

  const q = S.sideFilter.toLowerCase();
  const list = S.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
  const rows = list.map((p) => cell({
    lead: letterSq(p.name), title: `<span class="t">${h(p.name)}</span>`,
    value: `<span class="mono small">${h(p.resolved ? p.resolved.version : p.wanted || '')}</span><span class="dot ${p.exists ? p.status : ''}"></span>`,
    cls: `tap ${S.view === 'project' && S.selected === p.path ? 'selected' : ''}`,
    attrs: `data-action="openProject" data-path="${h(p.path)}" title="${h(p.path)}"`,
  })).join('');
  $('#side-projects').innerHTML = group('リポジトリ',
    rows || `<div class="side-empty">${S.projects.length ? '該当なし' : 'まだありません'}</div>`, '',
    `<button class="btn plain" data-action="addProjects" title="リポジトリを追加">${icon('plus')}追加</button>`);
  renderSideFoot();
}
function renderSideFoot() {
  $('#side-foot').innerHTML = `<span>外観</span><div class="seg icons">
    ${[['system', 'monitor', 'システム'], ['light', 'sun', 'ライト'], ['dark', 'moon', 'ダーク']].map(([id, ic, label]) =>
      `<button class="${S.theme === id ? 'active' : ''}" data-action="theme" data-theme="${id}" title="${label}">${icon(ic, 'sm')}</button>`).join('')}</div>`;
}
function renderTop() {
  const p = currentProject();
  let title = '概要';
  let sub = '';
  if (S.view === 'rubies') { title = 'Ruby バージョン'; sub = S.env ? `${S.env.rubies.length} 個インストール済み` : ''; }
  if (S.view === 'project') { title = p ? p.name : 'リポジトリ'; }
  $('#view-title').textContent = title;
  $('#view-sub').textContent = sub;
  $('#view-sub').style.display = sub ? '' : 'none';
  $('#top-actions').innerHTML = `
    ${S.scanning ? '<span class="spinner" title="スキャン中"></span>' : ''}
    <button class="btn plain" data-action="rescan" title="再スキャン (⌘R / Ctrl+R)">${icon('refresh')}再スキャン</button>
    ${installers().length ? `<button class="btn plain bold" data-action="openInstall">${icon('plus')}インストール</button>` : ''}`;
}

// ================================================================ view: overview
function viewOverview() {
  const { rubies, managers } = S.env;
  const ps = S.projects.filter((p) => p.exists);
  const warn = ps.filter((p) => p.status === 'warn').length;
  const err = ps.filter((p) => p.status === 'error').length;
  const unused = rubies.filter((r) => projectsUsing(r).length === 0 && !r.isGlobal);
  const eol = rubies.filter((r) => r.lifecycle.status === 'eol');
  const global = rubies.find((r) => r.isGlobal);

  const missing = {};
  for (const p of S.projects) if (p.exists && !p.resolved && p.wanted) (missing[norm(p.wanted)] ||= []).push(p);

  const tile = (ic, color, num, label, sub, attrs = '', mono = false) => `<div class="tile ${attrs ? 'tap' : ''}" ${attrs}>
      <div class="tile-top"><span class="circle" style="--c:var(--${color})">${icon(ic)}</span><span class="tile-num ${mono ? 'mono' : ''}">${num}</span></div>
      <div class="tile-label">${label}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;

  const chip = (p) => `<button class="chip ${p.usingGlobal ? 'global-use' : ''}" data-action="openProject" data-path="${h(p.path)}" title="${h(p.pinned ? p.pinned.file + ' = ' + p.pinned.version : 'バージョン未指定（グローバルを使用）')}">${letterSq(p.name)}${h(p.name)}<span class="dot ${p.status}"></span></button>`;

  const inst = installers()[0];
  const missRows = Object.entries(missing).map(([v, list]) => cell({
    lead: iconSq('alert', 'red'),
    title: `Ruby <span class="mono">${h(v)}</span> がインストールされていません`,
    sub: `${list.map((p) => h(p.name)).join(', ')} が使用`,
    acc: inst ? `<button class="btn small" data-action="installRuby" data-manager="${h(inst.id)}" data-version="${h(v)}">インストール</button>` : '',
  })).join('');

  const mapRows = rubies.map((r) => {
    const used = projectsUsing(r);
    return cell({
      lead: verSq(r.version),
      title: `<span class="mono" style="font-weight:600">${h(r.version)}</span>${r.isGlobal ? globalBadge() : ''}${lcBadge(r.lifecycle)}`,
      sub: h(r.managerName),
      value: used.length ? `<div class="chips">${used.map(chip).join('')}</div>` : (r.isGlobal ? 'グローバルとして使用' : '未使用'),
    });
  }).join('');

  const mgrRows = managers.filter((m) => m.id !== 'none').map((m) => cell({
    lead: iconSq('package', m.available ? 'green' : 'gray'),
    title: h(m.name),
    sub: m.available && m.global ? `global <span class="mono">${h(m.global)}</span>` : '',
    value: m.available ? (m.canInstall ? 'インストール可' : '検出') : '未検出',
    acc: m.available ? `<span style="color:var(--tint)">${icon('check')}</span>` : '',
    cls: m.available ? '' : 'dim',
  })).join('');

  return `
  <div class="tiles">
    ${tile('gem', 'red', rubies.length, 'インストール済み', `${[...new Set(rubies.map((r) => r.series))].length} シリーズ`, 'data-action="go" data-view="rubies"')}
    ${tile('star', 'orange', h(global ? global.version : '—'), 'グローバル', global ? h(global.managerName) : '未設定', '', true)}
    ${tile('folder', err ? 'red' : warn ? 'orange' : 'blue', S.projects.length, 'リポジトリ', ps.length ? (err || warn ? `エラー ${err} · 警告 ${warn}` : 'すべて問題なし') : '未登録')}
    ${tile('sparkles', 'gray', unused.length, '整理できる Ruby', eol.length ? `うち EOL ${eol.length}` : '未使用の Ruby', 'data-action="go" data-view="rubies"')}
  </div>
  ${S.projects.length ? '' : group('', `<div class="empty">${iconSq('folder', 'blue', 'xl')}<h3>リポジトリを追加</h3>
      <p>フォルダを選ぶと Gemfile や .ruby-version を読み取ります。親フォルダ（例: ~/git）を選ぶと、配下のリポジトリをまとめて追加します。</p>
      <button class="btn filled" data-action="addProjects">${icon('plus')}リポジトリを追加</button></div>`)}
  ${missRows ? group('対応が必要', missRows) : ''}
  ${group('バージョンマップ', mapRows || cell({ title: '<span class="sec">Ruby が見つかりません</span>' }),
    '<div class="legend"><span><span class="dot ok"></span>問題なし</span><span><span class="dot warn"></span>警告</span><span><span class="dot error"></span>エラー</span><span><span class="dash"></span>バージョン未指定（グローバルを使用）</span></div>')}
  ${group('バージョンマネージャ', mgrRows, installers().length ? '' : (S.env.platform === 'win32'
    ? 'インストール可能なマネージャがありません。Windows では mise か winget（RubyInstaller）をおすすめします。'
    : 'インストール可能なマネージャがありません。rbenv + ruby-build か mise をおすすめします。'))}`;
}

// ================================================================ view: rubies
function viewRubies() {
  const { rubies } = S.env;
  if (!rubies.length) return group('', `<div class="empty">${iconSq('gem', 'red', 'xl')}<h3>Ruby が見つかりません</h3></div>`);
  return `<div class="rgrid">${rubies.map((r) => {
    const used = projectsUsing(r);
    const mgr = S.env.managers.find((m) => m.id === r.manager);
    const canGlobal = mgr && !mgr.readonly && r.manager !== 'rubyinstaller' && !r.isGlobal;
    const canRemove = mgr && !mgr.readonly;
    const body = [
      cell({ lead: verSq(r.version, 'lg'), title: `<span class="big-ver">${h(r.version)}</span>`, sub: `<span class="row" style="gap:5px;margin-top:4px">${r.isGlobal ? globalBadge() : ''}${lcBadge(r.lifecycle)}${r.alias ? '<span class="badge plain">alias</span>' : ''}</span>`, cls: 'hero' }),
      cell({ title: 'マネージャ', value: h(r.managerName) }),
      cell({ title: 'サポート終了', value: h(r.lifecycle.eol || '—') }),
      cell({ title: '場所', value: `<span class="mono small trunc" title="${h(r.binDir)}">${h(r.binDir)}</span>` }),
      cell({ title: '使用リポジトリ', sub: used.map((p) => h(p.name)).join(', ') || (r.isGlobal ? 'グローバルとして使用中' : '未使用 — 削除候補'), value: `${used.length}` }),
      actionCell('詳細と gem', 'list', `data-action="rubyDetail" data-id="${h(r.id)}"`),
      canGlobal ? actionCell('グローバルに設定', 'star', `data-action="setGlobal" data-manager="${h(r.manager)}" data-version="${h(r.version)}"`) : '',
      canRemove ? actionCell('削除', 'trash', `data-action="uninstallRuby" data-manager="${h(r.manager)}" data-version="${h(r.version)}" data-used="${used.length}"`, { destructive: true }) : '',
    ].join('');
    return group('', body);
  }).join('')}</div>`;
}

// ================================================================ view: project
const ISSUE = { error: ['alert', 'red'], warn: ['alert', 'orange'], info: ['info', 'blue'] };
function viewProject() {
  const p = currentProject();
  if (!p) return '<div class="empty">リポジトリを選択してください</div>';
  const head = `<div class="phead">
      ${letterSq(p.name, 'xl')}
      <div class="phead-main"><h2>${h(p.name)}${p.branch ? `<span class="badge plain">${icon('branch')}${h(p.branch)}</span>` : ''}</h2><div class="path">${h(p.path)}</div></div>
      <div class="row">
        <button class="btn small gray" data-action="openPath" data-path="${h(p.path)}">${icon('folderOpen', 'sm')}開く</button>
        <button class="btn small gray" data-action="refreshProject" data-path="${h(p.path)}">${icon('refresh', 'sm')}再解析</button>
        <button class="btn small plain danger" data-action="removeProject" data-path="${h(p.path)}">登録解除</button>
      </div></div>`;
  if (!p.exists) return head + group('', cell({ lead: iconSq('alert', 'red'), title: 'フォルダが見つかりません', sub: '移動または削除された可能性があります' }));

  const inst = installers()[0];
  const issueRows = p.issues.length ? p.issues.map((i) => {
    const fix = i.level === 'error' && /インストールされていません/.test(i.text) && inst
      ? `<button class="btn small" data-action="installRuby" data-manager="${h(inst.id)}" data-version="${h(norm(p.wanted))}">インストール</button>` : '';
    const [ic, color] = ISSUE[i.level];
    return cell({ lead: iconSq(ic, color), title: h(i.text), acc: fix });
  }).join('') : cell({ lead: iconSq('check', 'green'), title: '問題は見つかりませんでした' });

  const gemCount = p.bundle ? p.bundle.gems.length : 0;
  const tabs = `<div class="tabs-row"><div class="seg wide">
      <button class="${S.tab === 'overview' ? 'active' : ''}" data-action="tab" data-tab="overview">Ruby と Bundler</button>
      <button class="${S.tab === 'gems' ? 'active' : ''}" data-action="tab" data-tab="gems">Gems <span class="n">${gemCount}</span></button>
    </div></div>`;
  return head + group('診断', issueRows) + tabs + (S.tab === 'gems' ? projectGems(p) : projectOverview(p));
}

function projectOverview(p) {
  const r = p.resolved ? rubyById(p.resolved.id) : null;
  if (r) loadRubyDetail(r.id);
  const detail = r ? S.rubyDetail[r.id] : null;
  const dis = !p.resolved;

  // ---- Ruby
  const hero = cell({
    lead: verSq(p.wanted || '?', 'lg'), cls: 'hero',
    title: `<span class="hero-ver">${h(r ? r.version : p.wanted || '—')}</span>`,
    sub: `<span class="row" style="gap:6px;margin-top:4px">${r ? lcBadge(r.lifecycle) : p.wanted ? `<span class="badge error">${icon('alert')}未インストール</span>` : ''}${p.usingGlobal ? '<span class="badge plain">global</span>' : ''}${r ? `<span>${h(r.managerName)} · ${p.resolved.exact ? '完全一致' : `「${h(p.wanted)}」に前方一致`}</span>` : ''}</span>`,
  });
  const srcRows = p.sources.length
    ? p.sources.map((s) => cell({ title: `<span class="mono">${h(s.file)}</span>`, value: `<span class="mono">${h(s.version)}</span>` })).join('')
    : cell({ title: '指定ファイル', value: 'なし（グローバル）' });
  const rubyGroup = group('Ruby', hero + srcRows
    + cell({ title: `${h(p.gemfile || 'Gemfile')} の ruby`, value: p.gemRuby ? `<span class="mono">${h(p.gemRuby.raw)}</span>` : '指定なし' })
    + cell({ title: 'Gemfile.lock', value: p.bundle && p.bundle.rubyVersion ? `<span class="mono">${h(p.bundle.rubyVersion)}</span>` : '—' }));

  const options = S.env.rubies.map((x) => `<option value="${h(x.version)}" ${r && x.id === r.id ? 'selected' : ''}>${h(x.version)} — ${h(x.managerName)}</option>`).join('');
  const changeGroup = group('バージョンを変更',
    cell({ title: '使用する Ruby', value: `<select class="picker" id="ruby-select" aria-label="使用する Ruby">${options}</select>` })
    + actionCell('このリポジトリに適用', 'check', `data-action="setProjectRuby" data-path="${h(p.path)}"`),
    p.sources.length ? `${p.sources.map((s) => h(s.file)).join('、')} を書き換えます。` : '.ruby-version を作成します。');

  // ---- Bundler
  if (!p.gemfile) {
    return `<div class="cols-2"><div>${rubyGroup}${changeGroup}</div><div>${group('Bundler', cell({ title: '<span class="sec">Gemfile がないリポジトリです</span>' }))}</div></div>`;
  }
  let bundlerStatus = '';
  if (p.bundle && p.bundle.bundledWith) {
    if (detail === 'loading') bundlerStatus = '<span class="spinner"></span>';
    else if (detail && detail.bundlers) {
      bundlerStatus = detail.bundlers.includes(p.bundle.bundledWith)
        ? `<span class="badge ok">${icon('check')}インストール済み</span>`
        : `<button class="btn small" data-action="bundle" data-op="installBundler" data-path="${h(p.path)}">インストール</button>`;
    }
  }
  const cfg = p.bundleConfig || {};
  const vendored = !!cfg.BUNDLE_PATH;
  const plats = p.bundle ? p.bundle.platforms : [];
  const addable = PLATFORMS.filter((x) => !plats.includes(x));
  const bundleGroup = group('Bundler',
    cell({ title: 'BUNDLED WITH', value: `<span class="mono">${h(p.bundle ? p.bundle.bundledWith || '—' : '—')}</span>${bundlerStatus}` })
    + cell({ title: 'Gem', value: p.bundle ? `${p.bundle.gems.length}（直接依存 ${p.bundle.dependencies.length}）` : '—' })
    + cell({
      title: 'vendor/bundle に分離', sub: `<span class="mono">${h(cfg.BUNDLE_PATH || (detail && detail.gemDir) || 'Ruby 共有 (GEM_HOME)')}</span>`,
      acc: `<label class="switch"><input type="checkbox" data-action="bundle" data-op="setPath" data-value="${vendored ? '' : '1'}" data-path="${h(p.path)}" ${vendored ? 'checked' : ''} ${dis ? 'disabled' : ''} aria-label="vendor/bundle に分離"></label>`,
    })
    + cell({
      title: 'プラットフォーム', cls: 'wrap',
      value: `<div class="chips">${plats.map((x) => `<span class="chip mono">${h(x)}<button title="削除" data-action="bundle" data-op="removePlatform" data-platform="${h(x)}" data-path="${h(p.path)}" ${dis ? 'disabled' : ''}>${icon('x', 'sm')}</button></span>`).join('')}
        ${addable.length ? `<span class="chip-add"><select class="picker" id="plat-select" aria-label="追加するプラットフォーム">${addable.map((x) => `<option>${h(x)}</option>`).join('')}</select><button class="icon-btn" data-action="addPlatform" data-path="${h(p.path)}" title="追加" ${dis ? 'disabled' : ''}>${icon('plus')}</button></span>` : ''}</div>`,
    }));

  const op = (label, ic, o, opts = {}) => actionCell(label, ic, `data-action="bundle" data-op="${o}" data-path="${h(p.path)}"`, { disabled: dis, ...opts });
  const gitSrc = p.bundle && p.bundle.sources.filter((s) => s.type !== 'GEM');
  const opsGroup = group('操作',
    op('bundle install', 'play', 'install') + op('bundle check', 'check', 'check') + op('outdated を確認', 'refresh', 'outdated')
    + op('すべて update', 'arrowUp', 'update') + op('bundle lock', 'lock', 'lock') + op('bundle clean', 'broom', 'clean', { destructive: true }),
    dis ? 'このリポジトリ用の Ruby がインストールされていないため実行できません。'
      : (gitSrc && gitSrc.length ? `Git/Path ソース: ${gitSrc.map((s) => `<span class="mono">${h(s.remote)}</span>${s.branch ? ` (${h(s.branch)})` : ''}`).join(', ')}` : ''));

  return `<div class="cols-2"><div>${rubyGroup}${changeGroup}</div><div>${bundleGroup}${opsGroup}</div></div>`;
}

function projectGems(p) {
  if (!p.bundle) return group('', `<div class="empty">${iconSq('package', 'brown', 'xl')}<h3>Gemfile.lock がありません</h3><p>「Ruby と Bundler」タブから bundle install を実行してください。</p></div>`);
  const out = S.outdated[p.path];
  const q = S.gemFilter.toLowerCase();
  const gems = p.bundle.gems
    .filter((g) => (!S.directOnly || g.direct) && (!q || g.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.direct - a.direct) || a.name.localeCompare(b.name));
  const total = p.bundle.gems.length;
  const direct = p.bundle.gems.filter((g) => g.direct).length;
  const outN = out ? Object.keys(out).length : 0;
  const reqOf = Object.fromEntries(p.bundle.dependencies.map((d) => [d.name, d.requirement]));
  const dis = p.resolved ? '' : 'disabled';

  const rows = gems.map((g) => {
    const o = out && out[g.name];
    const sub = [reqOf[g.name] ? `<span class="mono">${h(reqOf[g.name])}</span>` : '', g.platform ? h(g.platform) : '', g.sourceType !== 'GEM' ? h(g.sourceType) : ''].filter(Boolean).join(' · ');
    return cell({
      lead: letterSq(g.name, 'sm'),
      title: `<span class="t">${h(g.name)}</span>${g.direct ? '<span class="badge global">direct</span>' : ''}`,
      sub,
      value: `<span class="mono">${h(g.version)}</span>${o ? `<span class="gem-new">${icon('arrowUp')}${h(o.newest)}</span>` : ''}`,
      acc: g.direct ? `<button class="btn small" data-action="updateGem" data-gem="${h(g.name)}" data-path="${h(p.path)}" ${dis}>update</button>` : '',
    });
  }).join('');

  const depbar = `<div class="depbar">${direct ? `<div style="flex:${direct};background:var(--tint)"></div>` : ''}${total - direct ? `<div style="flex:${total - direct};background:var(--fill)"></div>` : ''}</div>
    <div class="legend"><span><span class="dot" style="background:var(--tint)"></span>直接依存 ${direct}</span><span><span class="dot" style="background:var(--fill)"></span>間接依存 ${total - direct}</span>
    ${out ? `<span><span class="dot ok"></span>更新あり ${outN}</span>` : '<span>「outdated を確認」で更新できる gem を表示します</span>'}</div>`;

  return `<div class="toolbar">
      <div class="search">${icon('search')}<input type="search" id="gem-filter" placeholder="gem を検索" value="${h(S.gemFilter)}"></div>
      <div class="seg"><button class="${S.directOnly ? '' : 'active'}" data-action="directOnly" data-value="">すべて</button><button class="${S.directOnly ? 'active' : ''}" data-action="directOnly" data-value="1">直接依存</button></div>
      <span class="spacer"></span>
      <button class="btn" data-action="bundle" data-op="outdated" data-path="${h(p.path)}" ${dis}>${icon('refresh', 'sm')}outdated を確認</button>
    </div>
    ${group(`Gems · ${gems.length}`, rows || cell({ title: '<span class="sec">該当なし</span>' }), depbar)}`;
}

// ================================================================ sheets (modals)
function modal(title, body, onMount) {
  $('#modal-root').innerHTML = `<div class="modal-back" data-action="closeModalBg"><div class="modal" role="dialog" aria-modal="true" aria-label="${h(title)}">
    <header><span></span><h3>${h(title)}</h3><button class="btn plain bold right" data-action="closeModal">閉じる</button></header>
    <div class="body" id="modal-body">${body}</div></div></div>`;
  if (onMount) onMount($('#modal-body'));
}
function closeModal() { $('#modal-root').innerHTML = ''; }

async function openInstall() {
  const ms = installers();
  if (!ms.length) return toast('インストールに対応したマネージャがありません', true);
  let manager = ms[0].id;
  let all = false;
  let list = null;
  let filter = '';
  const installed = new Set(S.env.rubies.map((r) => norm(r.version)));

  const draw = (body) => {
    const el = body.querySelector('#remote');
    if (!list) {
      el.innerHTML = [1, 2, 3].map(() => group('<span class="skeleton" style="display:inline-block;width:60px;height:12px"></span>', '<div class="ver-list"><div class="skeleton" style="width:80px;height:30px;border-radius:15px"></div><div class="skeleton" style="width:80px;height:30px;border-radius:15px"></div></div>')).join('');
      return;
    }
    const q = filter.trim();
    const items = list.filter((v) => !q || v.includes(q));
    const groups = {};
    for (const v of items) (groups[/^\d/.test(v) ? series(v) : v.split('-')[0]] ||= []).push(v);
    const keys = Object.keys(groups).sort((a, b) => {
      const na = /^\d/.test(a); const nb = /^\d/.test(b);
      return na !== nb ? (na ? -1 : 1) : cmpVer(b, a);
    });
    el.innerHTML = keys.map((k) => {
      const vs = groups[k].sort((a, b) => cmpVer(b, a));
      const latest = vs.find((v) => /^\d+(\.\d+)*$/.test(v));
      const btns = vs.map((v) => {
        const done = installed.has(norm(v));
        const isLatest = v === latest && !done;
        return `<button class="ver-btn ${done ? 'installed' : ''} ${isLatest ? 'latest' : ''}" ${done ? 'disabled' : `data-action="installRuby" data-manager="${h(manager)}" data-version="${h(v)}"`} title="${done ? 'インストール済み' : 'クリックでインストール'}">${done ? icon('check', 'sm') : ''}${h(v)}${isLatest ? '<span class="tag">最新</span>' : ''}</button>`;
      }).join('');
      return group(/^\d/.test(k) ? `Ruby ${h(k)}` : h(k), `<div class="ver-list">${btns}</div>`);
    }).join('') || group('', cell({ title: '<span class="sec">該当なし</span>' }));
  };
  const load = async (body) => {
    list = null;
    draw(body);
    list = (await guard(() => api.listRemote(manager, all))) || [];
    if (!list.length) body.querySelector('#remote').innerHTML = group('', cell({ lead: iconSq('info', 'blue'), title: '一覧を取得できませんでした', sub: 'ruby-build やプラグインの更新が必要かもしれません' }));
    else draw(body);
  };
  modal('Ruby をインストール', `
    <div class="toolbar">
      <div class="search" style="max-width:none">${icon('search')}<input type="search" id="remote-filter" placeholder="バージョンで絞り込み（例: 3.4）"></div>
      ${ms.length > 1 ? `<div class="seg" id="mgr">${ms.map((m, i) => `<button class="${i === 0 ? 'active' : ''}" data-mgr="${h(m.id)}">${h(m.name)}</button>`).join('')}</div>` : ''}
      <label class="switch small sec"><input type="checkbox" id="remote-all">すべて表示</label>
    </div>
    <div id="remote"></div>`, (body) => {
    const mgr = body.querySelector('#mgr');
    if (mgr) {
      mgr.onclick = (e) => {
        const b = e.target.closest('button[data-mgr]');
        if (!b) return;
        manager = b.dataset.mgr;
        mgr.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        load(body);
      };
    }
    body.querySelector('#remote-all').onchange = (e) => { all = e.target.checked; load(body); };
    body.querySelector('#remote-filter').oninput = (e) => { filter = e.target.value; draw(body); };
    body.querySelector('#remote-filter').focus();
    load(body);
  });
}

async function openRubyDetail(id) {
  const r = rubyById(id);
  modal(`Ruby ${r.version}`, group('', [1, 2, 3, 4].map(() => cell({ title: '<div class="skeleton" style="width:50%;height:14px"></div>' })).join('')));
  delete S.rubyDetail[id];
  await loadRubyDetail(id);
  const d = S.rubyDetail[id];
  if (!$('#modal-body')) return;
  if (!d || d.error) { $('#modal-body').innerHTML = group('', cell({ lead: iconSq('alert', 'red'), title: '情報を取得できませんでした', sub: h(d ? d.error : '') })); return; }
  let q = '';
  const draw = () => {
    const gems = d.gems.filter(([n]) => !q || n.includes(q));
    $('#gem-rows').innerHTML = gems.map(([n, v, def]) => cell({ title: h(n), value: `<span class="mono">${h(v)}</span>`, acc: def ? '<span class="badge plain">default</span>' : '' })).join('')
      || cell({ title: '<span class="sec">該当なし</span>' });
    $('#gem-count').textContent = `インストール済み gem · ${gems.length}`;
  };
  $('#modal-body').innerHTML = `
    ${group('情報',
      cell({ lead: verSq(r.version), title: `<span class="mono" style="font-weight:600">${h(r.version)}</span>${lcBadge(r.lifecycle)}`, sub: `<span class="mono">${h(d.description)}</span>` })
      + cell({ title: 'マネージャ', value: h(r.managerName) })
      + cell({ title: 'RubyGems', value: `<span class="mono">${h(d.gem)}</span>` })
      + cell({ title: 'Bundler', value: `<span class="mono">${h(d.bundlers.join(', ') || '—')}</span>` })
      + cell({ title: 'Gem ディレクトリ', sub: `<span class="mono">${h(d.gemDir)}</span>` }))}
    ${group('gem をインストール',
      cell({ title: '<input class="field" type="text" id="gem-name" placeholder="gem 名">' })
      + cell({ title: '<input class="field" type="text" id="gem-ver" placeholder="バージョン（任意）">' })
      + actionCell('gem install', 'download', `data-action="gemInstall" data-id="${h(id)}"`))}
    <div class="toolbar" style="margin-bottom:12px"><div class="search" style="max-width:none">${icon('search')}<input type="search" id="gem-q" placeholder="gem を検索"></div></div>
    <section class="group"><div class="group-head"><span id="gem-count"></span></div><div class="list" id="gem-rows"></div></section>`;
  $('#gem-q').oninput = (e) => { q = e.target.value.trim(); draw(); };
  draw();
}

// ================================================================ jobs / log
api.onJob((type, p) => {
  if (type === 'start') {
    S.jobs.unshift({ id: p.id, title: p.title, command: p.command, out: [], running: true, code: null });
    S.jobs = S.jobs.slice(0, 15);
    S.activeJob = p.id;
    S.logOpen = true;
    renderLog();
  } else if (type === 'data') {
    const j = S.jobs.find((x) => x.id === p.id);
    if (!j) return;
    j.out.push([stripAnsi(p.chunk), p.stream]);
    if (S.activeJob === p.id && S.logOpen) appendLog(stripAnsi(p.chunk), p.stream);
  } else if (type === 'end') {
    const j = S.jobs.find((x) => x.id === p.id);
    if (j) { j.running = false; j.code = p.code; }
    const meta = jobMeta.get(p.id) || {};
    if (p.extra && p.extra.outdated && meta.project) {
      S.outdated[meta.project] = p.extra.outdated;
      const n = Object.keys(p.extra.outdated).length;
      toast(n ? `${n} 個の gem に更新があります` : 'すべての gem が最新です');
      if (S.selected === meta.project) S.tab = 'gems';
    } else if (j) {
      toast(`${p.code === 0 ? '完了' : `失敗 (exit ${p.code})`}: ${j.title}`, p.code !== 0);
    }
    if (p.extra && p.extra.rescanned) rescan();
    else if (meta.project) {
      if (meta.kind && meta.kind !== 'outdated') delete S.outdated[meta.project];
      if (meta.kind === 'installBundler' || meta.kind === 'gem') S.rubyDetail = {};
      refreshProject(meta.project);
    } else renderLog();
  }
});

function jobState(x) {
  if (x.running) return '<span class="spinner"></span>';
  return x.code === 0 ? '<span class="dot ok"></span>' : '<span class="dot error"></span>';
}
function renderLog() {
  const el = $('#log');
  document.body.classList.toggle('log-open', S.jobs.length > 0 && S.logOpen);
  if (!S.jobs.length) { el.className = 'log hidden'; el.innerHTML = ''; return; }
  const running = S.jobs.filter((j) => j.running).length;
  if (!S.logOpen) {
    el.className = '';
    el.innerHTML = `<button class="log-mini" data-action="toggleLog">${running ? '<span class="spinner"></span>' : icon('terminal', 'sm')}${running ? `実行中 ${running}` : `ログ ${S.jobs.length}`}</button>`;
    return;
  }
  el.className = 'log';
  const j = S.jobs.find((x) => x.id === S.activeJob) || S.jobs[0];
  el.innerHTML = `<div class="log-head">
      <span class="title">ジョブ</span>
      ${S.jobs.map((x) => `<button class="log-tab ${x === j ? 'active' : ''}" data-action="selectJob" data-id="${x.id}" title="${h(x.title)}">${jobState(x)}${h(x.title)}</button>`).join('')}
      <span class="spacer"></span>
      ${j && j.running ? `<button class="btn small danger" data-action="cancelJob" data-id="${j.id}">中止</button>` : ''}
      <button class="btn plain bold" data-action="toggleLog">閉じる</button>
    </div><pre id="log-pre"></pre>`;
  const pre = $('#log-pre');
  pre.innerHTML = `<span class="cmd">${h(j.command)}</span>\n` + j.out.map(([s, st]) => `<span class="${st}">${h(s)}</span>`).join('');
  pre.scrollTop = pre.scrollHeight;
}
function appendLog(text, stream) {
  const pre = $('#log-pre');
  if (!pre) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const span = document.createElement('span');
  span.className = stream;
  span.textContent = text;
  pre.appendChild(span);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ================================================================ actions
const actions = {
  go: (d) => { S.view = d.view; render(); },
  rescan: () => rescan(),
  theme: (d) => applyTheme(d.theme),
  toggleLog: () => { S.logOpen = !S.logOpen; renderLog(); },
  selectJob: (d) => { S.activeJob = Number(d.id); renderLog(); },
  cancelJob: (d) => guard(() => api.cancelJob(Number(d.id))),
  closeModal: () => closeModal(),
  closeModalBg: (d, el, e) => { if (e.target === el) closeModal(); },
  openInstall: () => openInstall(),
  rubyDetail: (d) => openRubyDetail(d.id),
  openPath: (d) => guard(() => api.openPath(d.path)),
  directOnly: (d) => { S.directOnly = d.value === '1'; render(); },

  async addProjects() {
    const list = await guard(() => api.addProjects());
    if (list) { S.projects = list; toast(`${list.length} 件のリポジトリを管理中`); render(); }
  },
  openProject: (d) => { S.view = 'project'; S.selected = d.path; S.tab = 'overview'; S.gemFilter = ''; render(); },
  refreshProject: (d) => refreshProject(d.path),
  async removeProject(d) {
    if (!confirm(`登録を解除しますか？（ファイルは削除されません）\n${d.path}`)) return;
    await guard(() => api.removeProject(d.path));
    S.projects = S.projects.filter((p) => p.path !== d.path);
    S.view = 'overview';
    render();
  },
  tab: (d) => { S.tab = d.tab; render(); },

  async installRuby(d) {
    if (!confirm(`Ruby ${d.version} を ${d.manager} でインストールしますか？\n（ビルドに数分かかる場合があります）`)) return;
    closeModal();
    await guard(() => api.installRuby(d.manager, d.version));
  },
  async uninstallRuby(d) {
    const used = Number(d.used || 0);
    if (!confirm(`Ruby ${d.version} (${d.manager}) を削除しますか？${used ? `\n⚠ ${used} 件のリポジトリが使用中です` : ''}\nこの操作は元に戻せません。`)) return;
    const id = await guard(() => api.uninstallRuby(d.manager, d.version));
    if (id === null) { toast(`Ruby ${d.version} を削除しました`); rescan(); }
  },
  async setGlobal(d) {
    const ok = await guard(() => api.setGlobal(d.manager, d.version));
    if (ok) { toast(`グローバルを ${d.version} に設定しました`); rescan(); }
  },
  async setProjectRuby(d) {
    const v = $('#ruby-select').value;
    const res = await guard(() => api.setProjectRuby(d.path, v));
    if (!res) return;
    toast(`${res.touched.join(', ')} を ${v} に更新しました`);
    const i = S.projects.findIndex((x) => x.path === d.path);
    S.projects[i] = res.project;
    render();
  },
  async bundle(d, el) {
    if (d.op === 'clean' && !confirm('bundle clean は Gemfile に含まれない gem を削除します。続行しますか？')) return;
    if (d.op === 'update' && !confirm('すべての gem を更新します（Gemfile.lock が変更されます）。続行しますか？')) return;
    const opts = { value: d.value === '1', platform: d.platform };
    const id = await guard(() => api.bundle(d.path, d.op, opts));
    if (id) jobMeta.set(id, { project: d.path, kind: d.op });
    else if (el.type === 'checkbox') el.checked = !el.checked;
  },
  async addPlatform(d) {
    const platform = $('#plat-select').value;
    const id = await guard(() => api.bundle(d.path, 'addPlatform', { platform }));
    if (id) jobMeta.set(id, { project: d.path, kind: 'addPlatform' });
  },
  async updateGem(d) {
    const id = await guard(() => api.bundle(d.path, 'update', { gems: [d.gem] }));
    if (id) jobMeta.set(id, { project: d.path, kind: 'update' });
  },
  async gemInstall(d) {
    const name = $('#gem-name').value.trim();
    if (!name) return toast('gem 名を入力してください', true);
    const id = await guard(() => api.gemInstall(d.id, name, $('#gem-ver').value.trim() || null));
    if (id) { jobMeta.set(id, { kind: 'gem' }); closeModal(); }
  },
};

function trigger(el, e) {
  if (el.disabled || el.hasAttribute('disabled')) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset, el, e);
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox') return; // change で処理
  if (el.tagName === 'SELECT' || e.target.closest('select')) return;
  trigger(el, e);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'gem-filter') {
    S.gemFilter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const f = $('#gem-filter');
    f.focus(); f.setSelectionRange(pos, pos);
  }
  if (e.target.id === 'side-filter-input') { S.sideFilter = e.target.value; renderSide(); }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('input[type=checkbox][data-action]');
  if (el) trigger(el, e);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') { e.preventDefault(); rescan(); }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-action]')) { e.preventDefault(); trigger(e.target, e); }
});
$('#view').addEventListener('scroll', (e) => $('#topbar').classList.toggle('scrolled', e.target.scrollTop > 4));

// ================================================================ boot
document.documentElement.classList.add(`platform-${api.platform}`);
try { S.theme = localStorage.getItem('theme') || 'system'; } catch { /* ignore */ }
if (S.theme !== 'system') guard(() => api.setTheme(S.theme));
render();
rescan();
