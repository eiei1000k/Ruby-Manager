'use strict';
// リポジトリ（プロジェクト）単位の Ruby 指定・Bundler 状態の解析
const fs = require('fs');
const path = require('path');
const V = require('./versions');
const { parseLockfile } = require('./lockfile');

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function firstExisting(dir, names) {
  for (const n of names) if (fs.existsSync(path.join(dir, n))) return n;
  return null;
}

/** Gemfile の `ruby "..."` 指定を取り出す */
function gemfileRuby(gemfileText, dir) {
  if (!gemfileText) return null;
  const fileM = gemfileText.match(/^\s*ruby\s*\(?\s*file:\s*["']([^"']+)["']/m);
  if (fileM) {
    const txt = read(path.join(dir, fileM[1]));
    const v = txt ? (txt.match(/^ruby\s+(\S+)/m) || [null, txt.trim()])[1] : null;
    return v ? { requirement: v, raw: `file: "${fileM[1]}"` } : null;
  }
  const m = gemfileText.match(/^\s*ruby\s*\(?\s*((?:["'][^"']+["']\s*,?\s*)+)/m);
  if (!m) return null;
  const reqs = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  return { requirement: reqs.join(', '), raw: reqs.map((r) => `"${r}"`).join(', ') };
}

function parseBundleConfig(text) {
  const cfg = {};
  for (const line of (text || '').split(/\r?\n/)) {
    const m = line.match(/^(BUNDLE_[A-Z0-9_]+):\s*"?(.*?)"?\s*$/);
    if (m) cfg[m[1]] = m[2];
  }
  return cfg;
}

function gitBranch(dir) {
  const head = read(path.join(dir, '.git', 'HEAD'));
  if (!head) return null;
  const m = head.match(/ref:\s*refs\/heads\/(.+)/);
  return m ? m[1].trim() : head.trim().slice(0, 8);
}

/**
 * プロジェクトを解析。installed はインストール済み Ruby 一覧（managers.scan の rubies）。
 */
function analyze(dir, installed = [], globalVersion = null) {
  if (!fs.existsSync(dir)) return { path: dir, name: path.basename(dir), exists: false };

  const sources = [];
  const rv = read(path.join(dir, '.ruby-version'));
  if (rv && rv.trim()) sources.push({ file: '.ruby-version', version: rv.trim().split(/\s+/)[0] });
  const tv = read(path.join(dir, '.tool-versions'));
  const tvM = tv && tv.match(/^ruby\s+(\S+)/m);
  if (tvM) sources.push({ file: '.tool-versions', version: tvM[1] });
  const miseName = firstExisting(dir, ['mise.toml', '.mise.toml', 'mise.local.toml']);
  if (miseName) {
    const mm = read(path.join(dir, miseName)).match(/^\s*ruby\s*=\s*(?:\[\s*)?["']([^"']+)["']/m);
    if (mm) sources.push({ file: miseName, version: mm[1] });
  }

  const gemfileName = firstExisting(dir, ['Gemfile', 'gems.rb']);
  const lockName = gemfileName === 'gems.rb' ? 'gems.locked' : 'Gemfile.lock';
  const gemfileText = gemfileName ? read(path.join(dir, gemfileName)) : null;
  const lockText = read(path.join(dir, lockName));
  const lock = lockText ? parseLockfile(lockText) : null;
  const gemReq = gemfileRuby(gemfileText, dir);

  // 実際に使われる版：mise.toml > .tool-versions > .ruby-version（どのマネージャも概ねこの順）
  const order = [miseName, '.tool-versions', '.ruby-version'];
  const pinned = order.map((f) => sources.find((s) => s.file === f)).find(Boolean) || null;
  const wanted = pinned ? pinned.version : (globalVersion || null);
  const resolved = wanted ? V.resolve(wanted, installed) : null;

  const issues = [];
  if (!pinned) issues.push({ level: 'info', text: 'Ruby バージョンファイルがありません（グローバル設定が使われます）' });
  if (pinned && !resolved) issues.push({ level: 'error', text: `Ruby ${pinned.version} がインストールされていません` });
  const distinct = [...new Set(sources.map((s) => V.normalize(s.version)))];
  if (distinct.length > 1) issues.push({ level: 'warn', text: `バージョンファイル同士が不一致: ${sources.map((s) => `${s.file}=${s.version}`).join(' / ')}` });
  const effective = resolved ? resolved.ruby.version : wanted;
  if (gemReq && effective && !V.satisfies(effective, gemReq.requirement)) {
    issues.push({ level: 'error', text: `${gemfileName} の ruby ${gemReq.raw} を ${effective} は満たしていません` });
  }
  if (lock && lock.rubyVersion && effective && V.normalize(lock.rubyVersion) !== V.normalize(effective) && V.series(lock.rubyVersion) !== V.series(effective)) {
    issues.push({ level: 'warn', text: `Gemfile.lock の RUBY VERSION (${lock.rubyVersion}) と使用版 ${effective} のシリーズが異なります` });
  }
  if (gemfileName && !lock) issues.push({ level: 'warn', text: `${lockName} がありません（bundle install 未実行）` });
  if (effective) {
    const lc = V.lifecycle(effective);
    if (lc.status === 'eol') issues.push({ level: 'warn', text: `Ruby ${V.series(effective)} はサポート終了 (EOL) です` });
  }

  const bundleConfig = parseBundleConfig(read(path.join(dir, '.bundle', 'config')));
  const direct = new Set(lock ? lock.dependencies.map((d) => d.name) : []);

  return {
    path: dir,
    name: path.basename(dir),
    exists: true,
    branch: gitBranch(dir),
    sources,
    pinned,
    wanted,
    usingGlobal: !pinned,
    resolved: resolved ? { id: resolved.ruby.id, version: resolved.ruby.version, manager: resolved.ruby.manager, exact: resolved.exact } : null,
    gemfile: gemfileName,
    lockfile: lock ? lockName : null,
    gemRuby: gemReq,
    bundle: lock ? {
      bundledWith: lock.bundledWith,
      rubyVersion: lock.rubyVersion,
      platforms: lock.platforms,
      sources: lock.sources.map((s) => ({ type: s.type, remote: s.remote, revision: s.revision, branch: s.branch })),
      dependencies: lock.dependencies,
      gems: lock.specs.map((s) => ({ ...s, direct: direct.has(s.name) })),
    } : null,
    bundleConfig,
    issues,
    status: issues.some((i) => i.level === 'error') ? 'error' : issues.some((i) => i.level === 'warn') ? 'warn' : 'ok',
  };
}

module.exports = { analyze, gemfileRuby, parseBundleConfig };
