'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { run, kill, loadShellEnv, envWithRuby } = require('./exec');
const managers = require('./managers');
const project = require('./project');
const { parseOutdated } = require('./lockfile');

let win = null;
let env = null;
let cache = { managers: [], rubies: [] };
const jobs = new Map();
let jobSeq = 0;

// ------------------------------------------------------------ 永続化（登録したプロジェクト）
const storeFile = () => path.join(app.getPath('userData'), 'projects.json');
function loadProjects() {
  try { return JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { return []; }
}
function saveProjects(list) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify([...new Set(list)], null, 2));
}

// ------------------------------------------------------------ ジョブ（長時間コマンドのストリーミング）
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startJob({ title, cmd, args, cwd, jobEnv, onEnd }) {
  const id = ++jobSeq;
  const job = { id, title, child: null, output: '' };
  jobs.set(id, job);
  send('job:start', { id, title, command: [cmd, ...args].join(' '), cwd: cwd || null });
  run(cmd, args, {
    cwd,
    env: jobEnv || env,
    onSpawn: (c) => { job.child = c; },
    onData: (chunk, stream) => { job.output += chunk; send('job:data', { id, chunk, stream }); },
  }).then(async (res) => {
    jobs.delete(id);
    let extra = null;
    if (onEnd) { try { extra = await onEnd(res); } catch (e) { extra = { error: String(e.message || e) }; } }
    send('job:end', { id, code: res.code, extra });
  });
  return id;
}

/** 指定 Ruby で実行するためのコマンドと環境 */
function rubyCommand(rubyId, cmd, args) {
  const ruby = cache.rubies.find((r) => r.id === rubyId);
  if (!ruby) throw new Error('対象の Ruby が見つかりません。再スキャンしてください。');
  const m = managers.getManager(ruby.manager);
  const wrapped = m.execCmd(ruby, cmd, args);
  const jobEnv = wrapped.binDir ? envWithRuby(env, wrapped.binDir, ruby.version) : env;
  return { cmd: wrapped.cmd, args: wrapped.args, jobEnv, ruby };
}

async function rescan() {
  env = await loadShellEnv();
  cache = await managers.scan(env);
  return cache;
}

function globalVersion() {
  const g = cache.rubies.find((r) => r.isGlobal);
  if (g) return g.version;
  const m = cache.managers.find((x) => x.available && x.global);
  return m ? m.global : null;
}

function analyzeProject(dir) {
  return project.analyze(dir, cache.rubies, globalVersion());
}

// ------------------------------------------------------------ IPC
const GEM_RE = /^[A-Za-z0-9._\-]+$/;
const PLATFORM_RE = /^[A-Za-z0-9._\-]+$/;

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
}

function registerIpc() {
  handle('env:scan', async () => {
    await rescan();
    return { platform: process.platform, ...cache };
  });

  handle('ruby:detail', async (rubyId) => {
    const script = path.join(app.getPath('temp'), 'ruby-manager-detail.rb');
    fs.writeFileSync(script, [
      'require "json"; require "rbconfig"',
      'specs = Gem::Specification.to_a',
      'puts JSON.generate({',
      '  description: RUBY_DESCRIPTION, gem: Gem::VERSION, gemDir: Gem.dir, prefix: RbConfig::CONFIG["prefix"],',
      '  bundlers: specs.select { |s| s.name == "bundler" }.map { |s| s.version.to_s }.sort,',
      '  gems: specs.map { |s| [s.name, s.version.to_s, (s.respond_to?(:default_gem?) && s.default_gem?) ? true : false] }.sort_by { |n, v| [n, Gem::Version.new(v)] }',
      '})',
    ].join('\n'));
    const { cmd, args, jobEnv } = rubyCommand(rubyId, 'ruby', [script]);
    const r = await run(cmd, args, { env: jobEnv, timeout: 30000 });
    if (r.code !== 0) throw new Error(r.stderr || 'ruby の実行に失敗しました');
    const line = r.stdout.trim().split(/\r?\n/).pop();
    return JSON.parse(line);
  });

  handle('ruby:remote', async (managerId, all) => managers.getManager(managerId).listRemote(env, !!all));

  handle('ruby:setGlobal', async (managerId, version) => {
    const r = await managers.getManager(managerId).setGlobal(env, version);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || '失敗しました');
    return true;
  });

  handle('ruby:install', async (managerId, version) => {
    const c = managers.getManager(managerId).installCmd(version);
    if (!c) throw new Error('このマネージャはインストールに対応していません');
    return startJob({ title: `Ruby ${version} をインストール (${managerId})`, cmd: c.cmd, args: c.args, onEnd: () => rescan().then(() => ({ rescanned: true })) });
  });

  handle('ruby:uninstall', async (managerId, version) => {
    const c = managers.getManager(managerId).uninstallCmd(version);
    if (!c) throw new Error('このマネージャはアンインストールに対応していません');
    if (c.remove) {
      await fs.promises.rm(c.remove, { recursive: true, force: true });
      await rescan();
      return null;
    }
    return startJob({ title: `Ruby ${version} をアンインストール (${managerId})`, cmd: c.cmd, args: c.args, onEnd: () => rescan().then(() => ({ rescanned: true })) });
  });

  handle('ruby:gemInstall', async (rubyId, gem, version) => {
    if (!GEM_RE.test(gem) || (version && !GEM_RE.test(version))) throw new Error('不正な gem 指定');
    const { cmd, args, jobEnv, ruby } = rubyCommand(rubyId, 'gem', ['install', gem, ...(version ? ['-v', version] : [])]);
    return startJob({ title: `gem install ${gem}${version ? ' -v ' + version : ''} (Ruby ${ruby.version})`, cmd, args, jobEnv });
  });

  handle('projects:list', async () => loadProjects().map(analyzeProject));

  handle('projects:add', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'リポジトリを追加（Gemfile のないフォルダを選ぶと配下のリポジトリを一括追加）',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (res.canceled) return loadProjects().map(analyzeProject);
    const list = loadProjects();
    const isRubyProject = (d) => ['Gemfile', 'gems.rb', '.ruby-version', '.tool-versions'].some((f) => fs.existsSync(path.join(d, f)));
    for (const dir of res.filePaths) {
      if (isRubyProject(dir)) { list.push(dir); continue; }
      let found = 0;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const sub = path.join(dir, ent.name);
        if (ent.isDirectory() && !ent.name.startsWith('.') && isRubyProject(sub)) { list.push(sub); found++; }
      }
      if (!found) list.push(dir);
    }
    saveProjects(list);
    return loadProjects().map(analyzeProject);
  });

  handle('projects:remove', async (dir) => {
    saveProjects(loadProjects().filter((p) => p !== dir));
    return true;
  });

  handle('project:analyze', async (dir) => analyzeProject(dir));

  handle('project:setRuby', async (dir, version) => {
    managers.assertVersion(version);
    const a = analyzeProject(dir);
    const touched = [];
    for (const s of a.sources) {
      const file = path.join(dir, s.file);
      let txt = fs.readFileSync(file, 'utf8');
      if (s.file === '.ruby-version') txt = `${version}\n`;
      else if (s.file === '.tool-versions') txt = txt.replace(/^ruby\s+\S+/m, `ruby ${version}`);
      else txt = txt.replace(/^(\s*ruby\s*=\s*(?:\[\s*)?["'])[^"']+(["'])/m, `$1${version}$2`);
      fs.writeFileSync(file, txt);
      touched.push(s.file);
    }
    if (!touched.length) {
      fs.writeFileSync(path.join(dir, '.ruby-version'), `${version}\n`);
      touched.push('.ruby-version');
    }
    return { touched, project: analyzeProject(dir) };
  });

  handle('project:bundle', async (dir, action, opts = {}) => {
    const a = analyzeProject(dir);
    if (!a.resolved) throw new Error('このプロジェクト用の Ruby がインストールされていません');
    let args;
    let onEnd = null;
    switch (action) {
      case 'install': args = ['install']; break;
      case 'check': args = ['check']; break;
      case 'clean': args = ['clean']; break;
      case 'lock': args = ['lock']; break;
      case 'update': {
        const gems = (opts.gems || []).filter((g) => GEM_RE.test(g));
        args = gems.length ? ['update', ...gems] : ['update', '--all'];
        break;
      }
      case 'outdated':
        args = ['outdated', '--parseable'];
        onEnd = (res) => ({ outdated: parseOutdated(res.stdout) });
        break;
      case 'addPlatform':
        if (!PLATFORM_RE.test(opts.platform || '')) throw new Error('不正なプラットフォーム');
        args = ['lock', '--add-platform', opts.platform];
        break;
      case 'removePlatform':
        if (!PLATFORM_RE.test(opts.platform || '')) throw new Error('不正なプラットフォーム');
        args = ['lock', '--remove-platform', opts.platform];
        break;
      case 'setPath':
        args = opts.value ? ['config', 'set', '--local', 'path', 'vendor/bundle'] : ['config', 'unset', '--local', 'path'];
        break;
      case 'installBundler': {
        const v = a.bundle && a.bundle.bundledWith;
        if (!v || !GEM_RE.test(v)) throw new Error('Gemfile.lock に BUNDLED WITH がありません');
        const c = rubyCommand(a.resolved.id, 'gem', ['install', 'bundler', '-v', v]);
        return startJob({ title: `bundler ${v} をインストール (${a.name})`, cmd: c.cmd, args: c.args, cwd: dir, jobEnv: c.jobEnv });
      }
      default: throw new Error(`unknown action: ${action}`);
    }
    const c = rubyCommand(a.resolved.id, 'bundle', args);
    return startJob({ title: `bundle ${args.join(' ')} (${a.name} / Ruby ${c.ruby.version})`, cmd: c.cmd, args: c.args, cwd: dir, jobEnv: c.jobEnv, onEnd });
  });

  handle('job:cancel', async (id) => {
    const j = jobs.get(id);
    if (j && j.child) kill(j.child);
    return true;
  });

  handle('shell:openPath', async (p) => shell.openPath(p));
  handle('shell:openExternal', async (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('https のみ');
    return shell.openExternal(url);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Ruby Manager',
    backgroundColor: '#14121a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const j of jobs.values()) if (j.child) kill(j.child);
  if (process.platform !== 'darwin') app.quit();
});
