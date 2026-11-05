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
  directOnly: false,
  outdated: {},               // path -> { gem: info }
  rubyDetail: {},             // rubyId -> detail | 'loading' | { error }
  jobs: [],                   // { id, title, command, out: [], running, code, meta }
  activeJob: null,
  logOpen: false,
  scanning: false,
};
const jobMeta = new Map();    // jobId -> { project, kind }
const PLATFORMS = ['ruby', 'x86_64-linux', 'aarch64-linux', 'arm64-darwin', 'x86_64-darwin', 'x64-mingw-ucrt'];

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
/** シリーズ（3.3 等）ごとに安定した色相 */
function seriesColor(v) {
  const s = series(v);
  const [maj, min] = s.split('.').map(Number);
  if (Number.isNaN(maj)) return 'hsl(270 10% 55%)';
  const hue = ((maj * 10 + (min || 0)) * 67) % 360;
  return `hsl(${hue} 62% 52%)`;
}
function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' error' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 3500);
}
async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; }
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');
const installers = () => (S.env ? S.env.managers.filter((m) => m.canInstall) : []);
const rubyById = (id) => S.env && S.env.rubies.find((r) => r.id === id);
const lcBadge = (lc) => `<span class="badge ${h(lc.status)}" title="${lc.eol ? 'EOL: ' + h(lc.eol) : ''}">${h(lc.label)}</span>`;
function projectsUsing(ruby) { return S.projects.filter((p) => p.resolved && p.resolved.id === ruby.id); }
function currentProject() { return S.projects.find((p) => p.path === S.selected); }

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
function render() {
  renderNav();
  renderSide();
  renderTop();
  const v = $('#view');
  const scroll = v.scrollTop;
  if (!S.env) v.innerHTML = '<div class="empty"><div class="spinner"></div><h3>環境をスキャン中…</h3><p>Ruby バージョンマネージャを検出しています</p></div>';
  else if (S.view === 'overview') v.innerHTML = viewOverview();
  else if (S.view === 'rubies') v.innerHTML = viewRubies();
  else if (S.view === 'project') v.innerHTML = viewProject();
  v.scrollTop = scroll;
  renderLog();
}
function renderNav() {
  const n = S.env ? S.env.rubies.length : 0;
  $('#nav').innerHTML = [
    ['overview', '◉ 概要', ''],
    ['rubies', '◆ Ruby バージョン', n],
  ].map(([id, label, count]) => `<button class="${S.view === id ? 'active' : ''}" data-action="go" data-view="${id}"><span>${label}</span><span class="muted small">${count}</span></button>`).join('');
}
function renderSide() {
  $('#side-projects').innerHTML = S.projects.length
    ? S.projects.map((p) => `<button class="${S.view === 'project' && S.selected === p.path ? 'active' : ''}" data-action="openProject" data-path="${h(p.path)}" title="${h(p.path)}">
        <span class="dot ${p.exists ? p.status : 'none'}"></span><span class="name">${h(p.name)}</span>
        <span class="muted small mono">${h(p.resolved ? p.resolved.version : p.wanted || '')}</span></button>`).join('')
    : '<div class="muted small" style="padding:4px 10px">まだありません</div>';
}
function renderTop() {
  const titles = { overview: '概要', rubies: 'Ruby バージョン' };
  const p = currentProject();
  $('#view-title').textContent = S.view === 'project' ? (p ? p.name : 'リポジトリ') : titles[S.view];
  $('#scan-status').innerHTML = S.scanning ? '<span class="spinner"></span> スキャン中' : '';
}

// ================================================================ view: overview
function viewOverview() {
  const { rubies, managers } = S.env;
  const err = S.projects.filter((p) => p.status === 'error').length;
  const warn = S.projects.filter((p) => p.status === 'warn').length;
  const unused = rubies.filter((r) => projectsUsing(r).length === 0 && !r.isGlobal);
  const eol = rubies.filter((r) => r.lifecycle.status === 'eol');
  const global = rubies.find((r) => r.isGlobal);

  // プロジェクトが要求しているが未インストールのバージョン
  const missing = {};
  for (const p of S.projects) if (p.exists && !p.resolved && p.wanted) (missing[norm(p.wanted)] ||= []).push(p);

  const pill = (p) => `<span class="pill ${p.usingGlobal ? 'global-use' : ''}" data-action="openProject" data-path="${h(p.path)}" title="${h(p.pinned ? p.pinned.file + ' = ' + p.pinned.version : 'グローバル設定を使用')}"><span class="dot ${p.status}"></span>${h(p.name)}</span>`;

  const rows = rubies.map((r) => {
    const used = projectsUsing(r);
    return `<div class="vrow">
      <div class="vlabel"><span class="vswatch" style="background:${seriesColor(r.version)}"></span>
        <div><div class="row" style="gap:6px"><span class="vver">${h(r.version)}</span>${r.isGlobal ? '<span class="badge global">★ global</span>' : ''}${lcBadge(r.lifecycle)}</div>
        <div class="vmeta">${h(r.managerName)}</div></div></div>
      <div class="vtrack">${used.map(pill).join('') || '<span class="muted small">使用中のリポジトリなし</span>'}</div>
    </div>`;
  }).join('');
  const missRows = Object.entries(missing).map(([v, ps]) => `<div class="vrow missing">
      <div class="vlabel"><span class="vswatch" style="background:${seriesColor(v)}"></span>
        <div><div class="row" style="gap:6px"><span class="vver">${h(v)}</span><span class="badge error">未インストール</span></div>
        ${installers().length ? `<button class="btn small" style="margin-top:4px" data-action="installRuby" data-manager="${h(installers()[0].id)}" data-version="${h(v)}">インストール</button>` : ''}</div></div>
      <div class="vtrack">${ps.map(pill).join('')}</div></div>`).join('');

  return `
  <div class="stats">
    <div class="stat"><div class="label">インストール済み Ruby</div><div class="value">${rubies.length}</div></div>
    <div class="stat"><div class="label">グローバル</div><div class="value mono" style="font-size:20px">${h(global ? global.version : '—')}</div></div>
    <div class="stat"><div class="label">リポジトリ</div><div class="value">${S.projects.length}<small>${err ? `エラー ${err}` : ''}${warn ? ` 警告 ${warn}` : ''}</small></div></div>
    <div class="stat"><div class="label">未使用の Ruby</div><div class="value">${unused.length}<small>${eol.length ? `EOL ${eol.length}` : ''}</small></div></div>
  </div>
  <div class="stack">
    <div class="card">
      <h2>バージョンマップ <span class="muted small" style="font-weight:400">どのリポジトリがどの Ruby を使っているか</span><span class="spacer"></span>
        ${installers().length ? '<button class="btn small primary" data-action="openInstall">＋ Ruby をインストール</button>' : ''}</h2>
      ${rubies.length || missRows ? `<div class="vmap">${missRows}${rows}</div>` : '<div class="empty">Ruby が見つかりません</div>'}
      <div class="legend">
        <span><span class="dot ok"></span>問題なし</span><span><span class="dot warn"></span>警告</span><span><span class="dot error"></span>エラー</span>
        <span><span class="pill global-use" style="cursor:default;padding:0 8px">点線</span>バージョン未指定（グローバルを使用）</span>
      </div>
    </div>
    <div class="card">
      <h2>検出したバージョンマネージャ</h2>
      <div class="chips">${managers.map((m) => `<span class="chip ${m.available ? '' : 'off'}">${m.available ? '●' : '○'} ${h(m.name)}${m.global ? ` <span class="muted mono">global ${h(m.global)}</span>` : ''}${m.canInstall ? ' <span class="badge ok">install</span>' : ''}</span>`).join('')}</div>
      ${installers().length ? '' : `<p class="muted small" style="margin-bottom:0">インストール可能なマネージャがありません。${S.env.platform === 'win32' ? 'Windows では <b>mise</b> か <b>winget</b>（RubyInstaller）を推奨します。' : '<b>rbenv + ruby-build</b> か <b>mise</b> の導入を推奨します。'}</p>`}
    </div>
    ${S.projects.length ? '' : `<div class="card empty"><h3>リポジトリを登録しましょう</h3><p>フォルダを選ぶと Gemfile や .ruby-version を自動で読み取ります。<br>親フォルダ（例: ~/git）を選ぶと配下のリポジトリをまとめて追加します。</p><button class="btn primary" data-action="addProjects">＋ リポジトリを追加</button></div>`}
  </div>`;
}

// ================================================================ view: rubies
function viewRubies() {
  const { rubies } = S.env;
  const max = Math.max(1, ...rubies.map((r) => projectsUsing(r).length));
  const cards = rubies.map((r) => {
    const used = projectsUsing(r);
    const mgr = S.env.managers.find((m) => m.id === r.manager);
    const canGlobal = mgr && !mgr.readonly && r.manager !== 'rubyinstaller';
    const canRemove = mgr && !mgr.readonly;
    return `<div class="card rcard">
      <span class="stripe" style="background:${seriesColor(r.version)}"></span>
      <div class="ver">${h(r.version)} ${r.isGlobal ? '<span class="badge global">★ global</span>' : ''}</div>
      <div class="row">${lcBadge(r.lifecycle)}<span class="badge plain">${h(r.managerName)}</span>${r.alias ? '<span class="badge plain">alias</span>' : ''}</div>
      <div class="meta">${r.lifecycle.eol ? `サポート終了: ${h(r.lifecycle.eol)}` : ''}</div>
      <div>
        <div class="row small"><span>使用リポジトリ</span><span class="spacer"></span><b class="num">${used.length}</b></div>
        <div class="usage-bar"><div style="width:${(used.length / max) * 100}%"></div></div>
        <div class="muted small" style="margin-top:4px">${used.map((p) => h(p.name)).join(', ') || (r.isGlobal ? '（グローバルとして使用）' : '未使用 — 削除候補')}</div>
      </div>
      <div class="meta mono" title="${h(r.binDir)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(r.binDir)}</div>
      <div class="actions">
        <button class="btn small" data-action="rubyDetail" data-id="${h(r.id)}">詳細・gem</button>
        ${canGlobal && !r.isGlobal ? `<button class="btn small" data-action="setGlobal" data-manager="${h(r.manager)}" data-version="${h(r.version)}">グローバルに設定</button>` : ''}
        ${canRemove ? `<button class="btn small danger" data-action="uninstallRuby" data-manager="${h(r.manager)}" data-version="${h(r.version)}" data-used="${used.length}">削除</button>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="row" style="margin-bottom:14px">
      <span class="muted">${rubies.length} 個の Ruby がインストールされています</span><span class="spacer"></span>
      ${installers().length ? '<button class="btn primary" data-action="openInstall">＋ Ruby をインストール</button>' : ''}
    </div>
    <div class="rcards">${cards || '<div class="empty">Ruby が見つかりません</div>'}</div>`;
}

// ================================================================ view: project
function viewProject() {
  const p = currentProject();
  if (!p) return '<div class="empty">リポジトリを選択してください</div>';
  const head = `<div class="phead">
      <div style="flex:1;min-width:0"><h2>${h(p.name)} ${p.branch ? `<span class="badge plain">⎇ ${h(p.branch)}</span>` : ''}</h2><div class="path">${h(p.path)}</div></div>
      <div class="row">
        <button class="btn small" data-action="openPath" data-path="${h(p.path)}">フォルダを開く</button>
        <button class="btn small" data-action="refreshProject" data-path="${h(p.path)}">⟳ 再解析</button>
        <button class="btn small danger" data-action="removeProject" data-path="${h(p.path)}">登録解除</button>
      </div></div>`;
  if (!p.exists) return head + '<div class="issue error">フォルダが見つかりません（移動または削除された可能性があります）</div>';
  const gemCount = p.bundle ? p.bundle.gems.length : 0;
  const tabs = `<div class="tabs">
      <button class="${S.tab === 'overview' ? 'active' : ''}" data-action="tab" data-tab="overview">Ruby と Bundler</button>
      <button class="${S.tab === 'gems' ? 'active' : ''}" data-action="tab" data-tab="gems">Gems <span class="muted small">${gemCount}</span></button>
    </div>`;
  const issues = p.issues.length ? `<div class="issues">${p.issues.map((i) => {
    const fix = i.level === 'error' && /インストールされていません/.test(i.text) && installers().length
      ? `<span class="spacer"></span><button class="btn small" data-action="installRuby" data-manager="${h(installers()[0].id)}" data-version="${h(norm(p.wanted))}">${h(norm(p.wanted))} をインストール</button>` : '';
    return `<div class="issue ${i.level}">${i.level === 'error' ? '✕' : i.level === 'warn' ? '!' : 'i'} ${h(i.text)}${fix}</div>`;
  }).join('')}</div>` : '<div class="issues"><div class="issue info" style="background:var(--ok-soft);color:var(--ok)">✓ 問題は見つかりませんでした</div></div>';
  return head + issues + tabs + (S.tab === 'gems' ? projectGems(p) : projectOverview(p));
}

function projectOverview(p) {
  const r = p.resolved ? rubyById(p.resolved.id) : null;
  if (r) loadRubyDetail(r.id);
  const detail = r ? S.rubyDetail[r.id] : null;
  const options = S.env.rubies.map((x) => `<option value="${h(x.version)}" ${r && x.id === r.id ? 'selected' : ''}>${h(x.version)} (${h(x.managerName)})</option>`).join('');
  const sources = p.sources.length
    ? p.sources.map((s) => `<dt><code>${h(s.file)}</code></dt><dd class="mono">${h(s.version)}</dd>`).join('')
    : '<dt>指定ファイル</dt><dd class="muted">なし（グローバル設定を使用）</dd>';

  const rubyCard = `<div class="card">
    <h2>Ruby</h2>
    <div class="bigver"><span class="vswatch" style="background:${seriesColor(p.wanted)};width:8px;height:30px;border-radius:4px"></span>
      ${h(r ? r.version : p.wanted || '—')}
      ${r ? lcBadge(r.lifecycle) : p.wanted ? '<span class="badge error">未インストール</span>' : ''}
      ${p.usingGlobal ? '<span class="badge plain">global</span>' : ''}
    </div>
    <p class="muted small">${r ? `${h(r.managerName)} · ${p.resolved.exact ? '完全一致' : `「${h(p.wanted)}」に前方一致`}` : ''}</p>
    <dl class="kv">
      ${sources}
      <dt>${h(p.gemfile || 'Gemfile')} の ruby</dt><dd class="mono">${p.gemRuby ? h(p.gemRuby.raw) : '<span class="muted">指定なし</span>'}</dd>
      <dt>Gemfile.lock</dt><dd class="mono">${p.bundle && p.bundle.rubyVersion ? h(p.bundle.rubyVersion) : '<span class="muted">—</span>'}</dd>
    </dl>
    <div class="row" style="margin-top:14px">
      <select id="ruby-select">${options}</select>
      <button class="btn primary" data-action="setProjectRuby" data-path="${h(p.path)}">このリポジトリに適用</button>
    </div>
    <p class="muted small" style="margin-bottom:0">${p.sources.length ? `${p.sources.map((s) => h(s.file)).join(', ')} を書き換えます` : '.ruby-version を作成します'}</p>
  </div>`;

  let bundlerStatus = '';
  if (p.bundle && p.bundle.bundledWith) {
    if (detail === 'loading') bundlerStatus = '<span class="spinner"></span>';
    else if (detail && detail.bundlers) {
      const ok = detail.bundlers.includes(p.bundle.bundledWith);
      bundlerStatus = ok ? '<span class="badge ok">インストール済み</span>'
        : `<span class="badge warn">未インストール</span> <button class="btn small" data-action="bundle" data-op="installBundler" data-path="${h(p.path)}">インストール</button>`;
    }
  }
  const cfg = p.bundleConfig || {};
  const vendored = !!cfg.BUNDLE_PATH;
  const plats = p.bundle ? p.bundle.platforms : [];
  const addable = PLATFORMS.filter((x) => !plats.includes(x));
  const disabled = p.resolved ? '' : 'disabled title="Ruby が未インストールです"';

  const bundleCard = p.gemfile ? `<div class="card">
    <h2>Bundler</h2>
    <dl class="kv">
      <dt>BUNDLED WITH</dt><dd class="row"><span class="mono">${h(p.bundle ? p.bundle.bundledWith || '—' : '—')}</span>${bundlerStatus}</dd>
      <dt>Gem 数</dt><dd>${p.bundle ? `${p.bundle.gems.length}（直接依存 ${p.bundle.dependencies.length}）` : '—'}</dd>
      <dt>インストール先</dt><dd class="row"><span class="mono">${h(cfg.BUNDLE_PATH || (detail && detail.gemDir) || 'Ruby 共有 (GEM_HOME)')}</span>
        <button class="btn small" data-action="bundle" data-op="setPath" data-value="${vendored ? '' : '1'}" data-path="${h(p.path)}" ${disabled}>${vendored ? '共有に戻す' : 'vendor/bundle に分離'}</button></dd>
      <dt>プラットフォーム</dt><dd><div class="chips">${plats.map((x) => `<span class="chip mono">${h(x)}<button title="削除" data-action="bundle" data-op="removePlatform" data-platform="${h(x)}" data-path="${h(p.path)}" ${disabled}>✕</button></span>`).join('')}
        ${addable.length ? `<select id="plat-select" style="padding:2px 6px">${addable.map((x) => `<option>${h(x)}</option>`).join('')}</select><button class="btn small" data-action="addPlatform" data-path="${h(p.path)}" ${disabled}>追加</button>` : ''}</div></dd>
    </dl>
    <div class="actions-grid" style="margin-top:14px">
      <button class="btn primary" data-action="bundle" data-op="install" data-path="${h(p.path)}" ${disabled}>bundle install</button>
      <button class="btn" data-action="bundle" data-op="check" data-path="${h(p.path)}" ${disabled}>check</button>
      <button class="btn" data-action="bundle" data-op="outdated" data-path="${h(p.path)}" ${disabled}>outdated を確認</button>
      <button class="btn" data-action="bundle" data-op="update" data-path="${h(p.path)}" ${disabled}>すべて update</button>
      <button class="btn" data-action="bundle" data-op="lock" data-path="${h(p.path)}" ${disabled}>lock</button>
      <button class="btn danger" data-action="bundle" data-op="clean" data-path="${h(p.path)}" ${disabled}>clean</button>
    </div>
    ${p.bundle && p.bundle.sources.some((s) => s.type !== 'GEM') ? `<p class="muted small" style="margin-bottom:0">Git/Path ソース: ${p.bundle.sources.filter((s) => s.type !== 'GEM').map((s) => `<code>${h(s.remote)}</code>${s.branch ? ` (${h(s.branch)})` : ''}`).join(', ')}</p>` : ''}
  </div>` : `<div class="card"><h2>Bundler</h2><p class="muted">Gemfile がないリポジトリです。</p></div>`;

  return `<div class="grid cols-2">${rubyCard}${bundleCard}</div>`;
}

function projectGems(p) {
  if (!p.bundle) return '<div class="empty">Gemfile.lock がありません。「Ruby と Bundler」タブから bundle install を実行してください。</div>';
  const out = S.outdated[p.path];
  const q = S.gemFilter.toLowerCase();
  const gems = p.bundle.gems
    .filter((g) => (!S.directOnly || g.direct) && (!q || g.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.direct - a.direct) || a.name.localeCompare(b.name));
  const total = p.bundle.gems.length;
  const direct = p.bundle.gems.filter((g) => g.direct).length;
  const outN = out ? Object.keys(out).length : 0;
  const reqOf = Object.fromEntries(p.bundle.dependencies.map((d) => [d.name, d.requirement]));
  const disabled = p.resolved ? '' : 'disabled';

  const seg = `<div class="segbar" title="直接依存 / 間接依存">
      <div style="width:${(direct / total) * 100}%;background:var(--ruby)"></div>
      <div style="width:${((total - direct) / total) * 100}%;background:var(--info);opacity:.5"></div></div>
    <div class="legend" style="margin-top:2px"><span><span class="dot" style="background:var(--ruby)"></span>直接依存 ${direct}</span><span><span class="dot" style="background:var(--info);opacity:.5"></span>間接依存 ${total - direct}</span>
    ${out ? `<span><span class="dot ok"></span>更新あり ${outN}</span>` : '<span>「outdated を確認」で更新可能な gem を表示</span>'}</div>`;

  const rows = gems.map((g) => {
    const o = out && out[g.name];
    return `<tr>
      <td><b>${h(g.name)}</b> ${g.direct ? '<span class="badge global">direct</span>' : ''}</td>
      <td class="mono">${h(g.version)}${g.platform ? ` <span class="muted">${h(g.platform)}</span>` : ''}</td>
      <td class="mono muted">${h(reqOf[g.name] || '')}</td>
      <td class="mono">${o ? `<span class="gem-new">→ ${h(o.newest)}</span>` : out ? '<span class="muted">最新</span>' : ''}</td>
      <td class="small muted">${g.sourceType === 'GEM' ? '' : h(g.sourceType)}</td>
      <td>${g.direct ? `<button class="btn small" data-action="updateGem" data-gem="${h(g.name)}" data-path="${h(p.path)}" ${disabled}>update</button>` : ''}</td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div class="row">
      <input type="search" id="gem-filter" placeholder="gem を検索…" value="${h(S.gemFilter)}" style="width:240px">
      <label class="row small"><input type="checkbox" id="direct-only" ${S.directOnly ? 'checked' : ''}> 直接依存のみ</label>
      <span class="spacer"></span>
      <button class="btn" data-action="bundle" data-op="outdated" data-path="${h(p.path)}" ${disabled}>outdated を確認</button>
    </div>
    ${seg}
    <div class="table-wrap" style="margin-top:12px"><table>
      <thead><tr><th>Gem</th><th>バージョン</th><th>Gemfile 要件</th><th>最新</th><th>ソース</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">該当なし</td></tr>'}</tbody></table></div>
  </div>`;
}

// ================================================================ modals
function modal(title, body, onMount) {
  $('#modal-root').innerHTML = `<div class="modal-back" data-action="closeModalBg"><div class="modal" role="dialog" aria-modal="true">
    <header><h3>${h(title)}</h3><button class="btn ghost" data-action="closeModal" aria-label="閉じる">✕</button></header>
    <div class="body" id="modal-body">${body}</div></div></div>`;
  if (onMount) onMount($('#modal-body'));
}
function closeModal() { $('#modal-root').innerHTML = ''; }

async function openInstall() {
  const ms = installers();
  if (!ms.length) return toast('インストールに対応したマネージャがありません', true);
  let manager = ms[0].id;
  let all = false;
  let list = [];
  let filter = '';
  const installed = new Set(S.env.rubies.map((r) => norm(r.version)));

  const draw = (body) => {
    const q = filter.trim();
    const items = list.filter((v) => !q || v.includes(q));
    const groups = {};
    for (const v of items) (groups[/^\d/.test(v) ? series(v) : v.split('-')[0]] ||= []).push(v);
    const keys = Object.keys(groups).sort((a, b) => {
      const na = /^\d/.test(a); const nb = /^\d/.test(b);
      return na !== nb ? (na ? -1 : 1) : cmpVer(b, a);
    });
    body.querySelector('#remote').innerHTML = !list.length ? '<div class="empty"><span class="spinner"></span> 取得中…</div>'
      : keys.map((k) => {
        const vs = groups[k].sort((a, b) => cmpVer(b, a));
        const latest = vs.find((v) => /^\d+(\.\d+)*$/.test(v));
        return `<div class="remote-group"><h4><span class="dot" style="background:${seriesColor(k)}"></span>${h(k)}</h4>
          <div class="remote-list">${vs.map((v) => `<button class="btn small ${installed.has(norm(v)) ? 'installed' : ''} ${v === latest ? 'latest' : ''}" data-action="installRuby" data-manager="${h(manager)}" data-version="${h(v)}" title="${installed.has(norm(v)) ? 'インストール済み' : 'クリックでインストール'}">${h(v)}${installed.has(norm(v)) ? ' ✓' : ''}</button>`).join('')}</div></div>`;
      }).join('') || '<div class="muted">該当なし</div>';
  };
  const load = async (body) => {
    list = [];
    draw(body);
    const res = await guard(() => api.listRemote(manager, all));
    list = res || [];
    if (!list.length) body.querySelector('#remote').innerHTML = '<div class="muted">一覧を取得できませんでした（ruby-build / プラグインの更新が必要かもしれません）</div>';
    else draw(body);
  };
  modal('Ruby をインストール', `
    <div class="row" style="margin-bottom:12px">
      <select id="mgr">${ms.map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join('')}</select>
      <input type="search" id="remote-filter" placeholder="バージョンで絞り込み (例: 3.4)" style="flex:1">
      <label class="row small"><input type="checkbox" id="remote-all"> すべて（jruby 等も）</label>
    </div>
    <p class="muted small" style="margin-top:0">赤枠 = 各シリーズの最新安定版 / 緑 = インストール済み。クリックでインストールを開始します（数分かかります）。</p>
    <div id="remote" class="remote-groups"></div>`, (body) => {
    body.querySelector('#mgr').onchange = (e) => { manager = e.target.value; load(body); };
    body.querySelector('#remote-all').onchange = (e) => { all = e.target.checked; load(body); };
    body.querySelector('#remote-filter').oninput = (e) => { filter = e.target.value; draw(body); };
    load(body);
  });
}

async function openRubyDetail(id) {
  const r = rubyById(id);
  modal(`Ruby ${r.version} (${r.managerName})`, '<div class="empty"><span class="spinner"></span> 読み込み中…</div>');
  delete S.rubyDetail[id];
  await loadRubyDetail(id);
  const d = S.rubyDetail[id];
  if (!$('#modal-body')) return;
  if (!d || d.error) { $('#modal-body').innerHTML = `<div class="issue error">${h(d ? d.error : '失敗しました')}</div>`; return; }
  let q = '';
  const draw = () => {
    const gems = d.gems.filter(([n]) => !q || n.includes(q));
    $('#gem-rows').innerHTML = gems.map(([n, v, def]) => `<tr><td>${h(n)}</td><td class="mono">${h(v)}</td><td>${def ? '<span class="badge plain">default</span>' : ''}</td></tr>`).join('');
  };
  $('#modal-body').innerHTML = `
    <dl class="kv">
      <dt>RUBY_DESCRIPTION</dt><dd class="mono">${h(d.description)}</dd>
      <dt>RubyGems</dt><dd class="mono">${h(d.gem)}</dd>
      <dt>Gem ディレクトリ</dt><dd class="mono">${h(d.gemDir)}</dd>
      <dt>Bundler</dt><dd class="mono">${h(d.bundlers.join(', ') || '—')}</dd>
      <dt>サポート</dt><dd>${lcBadge(r.lifecycle)} ${r.lifecycle.eol ? `<span class="muted small">EOL ${h(r.lifecycle.eol)}</span>` : ''}</dd>
    </dl>
    <div class="row" style="margin:16px 0 10px">
      <input type="search" id="gem-q" placeholder="gem を検索…" style="flex:1">
      <input type="text" id="gem-name" placeholder="gem 名" style="width:140px"><input type="text" id="gem-ver" placeholder="バージョン(任意)" style="width:120px">
      <button class="btn primary" data-action="gemInstall" data-id="${h(id)}">gem install</button>
    </div>
    <div class="muted small" style="margin-bottom:6px">${d.gems.length} gems</div>
    <div class="table-wrap" style="max-height:40vh"><table><thead><tr><th>Gem</th><th>Version</th><th></th></tr></thead><tbody id="gem-rows"></tbody></table></div>`;
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
    if (S.activeJob === p.id) appendLog(stripAnsi(p.chunk), p.stream);
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

function renderLog() {
  const el = $('#log');
  if (!S.jobs.length) { el.className = 'log hidden'; return; }
  const running = S.jobs.filter((j) => j.running).length;
  if (!S.logOpen) {
    el.className = 'log-mini';
    el.innerHTML = `<button class="btn" data-action="toggleLog">${running ? '<span class="spinner"></span> ' : ''}ログ (${S.jobs.length})</button>`;
    return;
  }
  el.className = 'log';
  const j = S.jobs.find((x) => x.id === S.activeJob) || S.jobs[0];
  el.innerHTML = `<div class="log-head">
      <b class="small">ジョブ</b>
      ${S.jobs.map((x) => `<button class="log-tab ${x === j ? 'active' : ''}" data-action="selectJob" data-id="${x.id}" title="${h(x.title)}">${x.running ? '<span class="spinner"></span>' : x.code === 0 ? '<span class="dot ok"></span>' : '<span class="dot error"></span>'}${h(x.title)}</button>`).join('')}
      <span class="spacer"></span>
      ${j && j.running ? `<button class="btn small danger" data-action="cancelJob" data-id="${j.id}">中止</button>` : ''}
      <button class="btn small ghost" data-action="toggleLog">最小化 ▾</button>
    </div><pre id="log-pre"></pre>`;
  const pre = $('#log-pre');
  pre.innerHTML = `<span class="cmd">$ ${h(j.command)}</span>\n` + j.out.map(([s, st]) => `<span class="${st}">${h(s)}</span>`).join('');
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
  toggleLog: () => { S.logOpen = !S.logOpen; renderLog(); },
  selectJob: (d) => { S.activeJob = Number(d.id); renderLog(); },
  cancelJob: (d) => guard(() => api.cancelJob(Number(d.id))),
  closeModal: () => closeModal(),
  closeModalBg: (d, el, e) => { if (e.target === el) closeModal(); },
  openInstall: () => openInstall(),
  rubyDetail: (d) => openRubyDetail(d.id),
  openPath: (d) => guard(() => api.openPath(d.path)),

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
  async bundle(d) {
    if (d.op === 'clean' && !confirm('bundle clean は Gemfile に含まれない gem を削除します。続行しますか？')) return;
    if (d.op === 'update' && !confirm('すべての gem を更新します（Gemfile.lock が変更されます）。続行しますか？')) return;
    const opts = { value: d.value === '1', platform: d.platform };
    const id = await guard(() => api.bundle(d.path, d.op, opts));
    if (id) jobMeta.set(id, { project: d.path, kind: d.op });
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

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset, el, e);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'gem-filter') {
    S.gemFilter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const f = $('#gem-filter');
    f.focus(); f.setSelectionRange(pos, pos);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'direct-only') { S.directOnly = e.target.checked; render(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') { e.preventDefault(); rescan(); }
});

render();
rescan();
