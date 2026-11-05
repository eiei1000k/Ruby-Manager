'use strict';
// 各 Ruby バージョンマネージャのアダプタ。
// どのアダプタも { id, name, detect, list, getGlobal, setGlobal, listRemote, installCmd, uninstallCmd, execCmd } を持つ。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, isWin } = require('./exec');
const V = require('./versions');

const home = os.homedir();
const VERSION_RE = /^[A-Za-z0-9._+\-]+$/;

function assertVersion(v) {
  if (!VERSION_RE.test(String(v))) throw new Error(`不正なバージョン指定: ${v}`);
}

function readdirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function rubyExe(binDir) {
  return path.join(binDir, isWin ? 'ruby.exe' : 'ruby');
}

function lines(text) {
  return (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** 汎用: bin を PATH 先頭に置いて実行 */
function defaultExec(ruby, cmd, args) {
  return { cmd, args, binDir: ruby.binDir, version: ruby.version };
}

// ---------------------------------------------------------------- rbenv
const rbenv = {
  id: 'rbenv', name: 'rbenv', url: 'https://github.com/rbenv/rbenv',
  async detect(env) {
    if (isWin) return false;
    const r = await run('rbenv', ['root'], { env });
    if (r.code !== 0) return false;
    this.root = r.stdout.trim();
    const b = await run('rbenv', ['install', '--version'], { env });
    this.canInstall = b.code === 0;
    return true;
  },
  async list() {
    return readdirSafe(path.join(this.root, 'versions'))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => ({
        version: d.name,
        binDir: path.join(this.root, 'versions', d.name, 'bin'),
        alias: d.isSymbolicLink(),
      }))
      .filter((r) => fs.existsSync(rubyExe(r.binDir)));
  },
  async getGlobal(env) {
    const r = await run('rbenv', ['global'], { env, cwd: home });
    return r.code === 0 ? r.stdout.trim() : null;
  },
  async setGlobal(env, v) { assertVersion(v); return run('rbenv', ['global', v], { env }); },
  async listRemote(env, all) {
    const r = await run('rbenv', ['install', all ? '--list-all' : '--list'], { env, timeout: 60000 });
    return lines(r.stdout).filter((l) => VERSION_RE.test(l));
  },
  installCmd(v) { assertVersion(v); return { cmd: 'rbenv', args: ['install', '--skip-existing', v] }; },
  uninstallCmd(v) { assertVersion(v); return { cmd: 'rbenv', args: ['uninstall', '--force', v] }; },
  execCmd: defaultExec,
};

// ---------------------------------------------------------------- mise
const mise = {
  id: 'mise', name: 'mise', url: 'https://mise.jdx.dev/', canInstall: true,
  async detect(env) {
    const r = await run('mise', ['--version'], { env });
    return r.code === 0;
  },
  async list(env) {
    const r = await run('mise', ['ls', '--installed', '--json', 'ruby'], { env, cwd: home });
    try {
      return JSON.parse(r.stdout).map((t) => ({ version: t.version, binDir: path.join(t.install_path, 'bin') }));
    } catch { return []; }
  },
  async getGlobal(env) {
    const r = await run('mise', ['ls', '--global', '--json', 'ruby'], { env, cwd: home });
    try {
      const arr = JSON.parse(r.stdout);
      const hit = arr.find((t) => t.active) || arr[0];
      return hit ? hit.version : null;
    } catch { return null; }
  },
  async setGlobal(env, v) { assertVersion(v); return run('mise', ['use', '--global', `ruby@${v}`], { env }); },
  async listRemote(env) {
    const r = await run('mise', ['ls-remote', 'ruby'], { env, timeout: 60000 });
    return lines(r.stdout).filter((l) => VERSION_RE.test(l));
  },
  installCmd(v) { assertVersion(v); return { cmd: 'mise', args: ['install', `ruby@${v}`] }; },
  uninstallCmd(v) { assertVersion(v); return { cmd: 'mise', args: ['uninstall', `ruby@${v}`] }; },
  execCmd: defaultExec,
};

// ---------------------------------------------------------------- asdf
const asdf = {
  id: 'asdf', name: 'asdf', url: 'https://asdf-vm.com/', canInstall: true,
  async detect(env) {
    if (isWin) return false;
    const r = await run('asdf', ['--version'], { env });
    if (r.code !== 0) return false;
    const p = await run('asdf', ['plugin', 'list'], { env });
    this.dataDir = env.ASDF_DATA_DIR || path.join(home, '.asdf');
    return lines(p.stdout).includes('ruby');
  },
  async list() {
    const base = path.join(this.dataDir, 'installs', 'ruby');
    return readdirSafe(base)
      .filter((d) => d.isDirectory())
      .map((d) => ({ version: d.name, binDir: path.join(base, d.name, 'bin') }))
      .filter((r) => fs.existsSync(rubyExe(r.binDir)));
  },
  async getGlobal(env) {
    const file = env.ASDF_DEFAULT_TOOL_VERSIONS_FILENAME || '.tool-versions';
    try {
      const txt = fs.readFileSync(path.join(home, file), 'utf8');
      const m = txt.match(/^ruby\s+(\S+)/m);
      return m ? m[1] : null;
    } catch { return null; }
  },
  async setGlobal(env, v) {
    assertVersion(v);
    const r = await run('asdf', ['set', '--home', 'ruby', v], { env, cwd: home }); // asdf >= 0.16
    if (r.code === 0) return r;
    return run('asdf', ['global', 'ruby', v], { env, cwd: home });
  },
  async listRemote(env) {
    const r = await run('asdf', ['list', 'all', 'ruby'], { env, timeout: 60000 });
    return lines(r.stdout).filter((l) => VERSION_RE.test(l));
  },
  installCmd(v) { assertVersion(v); return { cmd: 'asdf', args: ['install', 'ruby', v] }; },
  uninstallCmd(v) { assertVersion(v); return { cmd: 'asdf', args: ['uninstall', 'ruby', v] }; },
  execCmd: defaultExec,
};

// ---------------------------------------------------------------- rvm
const rvm = {
  id: 'rvm', name: 'RVM', url: 'https://rvm.io/', canInstall: true,
  async detect(env) {
    if (isWin) return false;
    this.root = env.rvm_path || path.join(home, '.rvm');
    this.bin = path.join(this.root, 'bin', 'rvm');
    return fs.existsSync(this.bin);
  },
  async list() {
    const base = path.join(this.root, 'rubies');
    return readdirSafe(base)
      .filter((d) => d.isDirectory() && d.name !== 'default')
      .map((d) => ({ version: d.name.replace(/^ruby-/, ''), rvmName: d.name, binDir: path.join(base, d.name, 'bin') }))
      .filter((r) => fs.existsSync(rubyExe(r.binDir)));
  },
  async getGlobal(env) {
    const r = await run(this.bin, ['alias', 'show', 'default'], { env });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim().replace(/^ruby-/, '').replace(/@.*$/, '') : null;
  },
  async setGlobal(env, v) { assertVersion(v); return run(this.bin, ['alias', 'create', 'default', `ruby-${v}`], { env }); },
  async listRemote(env) {
    const r = await run(this.bin, ['list', 'known'], { env, timeout: 60000 });
    const out = [];
    for (const l of lines(r.stdout)) {
      const m = l.match(/^\[ruby-\]([\d.]+)(?:\[([^\]]+)\])?$/);
      if (m) out.push(m[1] + (m[2] || ''));
    }
    return out;
  },
  installCmd(v) { assertVersion(v); return { cmd: this.bin, args: ['install', `ruby-${v}`] }; },
  uninstallCmd(v) { assertVersion(v); return { cmd: this.bin, args: ['remove', `ruby-${v}`] }; },
  execCmd(ruby, cmd, args) {
    return { cmd: this.bin, args: [ruby.rvmName || `ruby-${ruby.version}`, 'do', cmd, ...args], binDir: null };
  },
};

// ---------------------------------------------------------------- chruby (+ ruby-install)
const chruby = {
  id: 'chruby', name: 'chruby / ruby-install', url: 'https://github.com/postmodern/chruby',
  dirs: [path.join(home, '.rubies'), '/opt/rubies'],
  async detect(env) {
    if (isWin) return false;
    const ri = await run('ruby-install', ['--version'], { env });
    this.canInstall = ri.code === 0;
    return this.canInstall || this.dirs.some((d) => readdirSafe(d).length > 0);
  },
  async list() {
    const out = [];
    for (const base of this.dirs) {
      for (const d of readdirSafe(base)) {
        if (!d.isDirectory()) continue;
        const binDir = path.join(base, d.name, 'bin');
        if (fs.existsSync(rubyExe(binDir))) out.push({ version: d.name.replace(/^ruby-/, ''), dir: path.join(base, d.name), binDir });
      }
    }
    return out;
  },
  async getGlobal() {
    try { return fs.readFileSync(path.join(home, '.ruby-version'), 'utf8').trim() || null; } catch { return null; }
  },
  async setGlobal(env, v) {
    assertVersion(v);
    fs.writeFileSync(path.join(home, '.ruby-version'), `${v}\n`);
    return { code: 0, stdout: '~/.ruby-version を更新しました (chruby auto.sh 用)', stderr: '' };
  },
  async listRemote(env) {
    const r = await run('ruby-install', ['--list', 'ruby'], { env, timeout: 60000 });
    return lines(r.stdout).filter((l) => /^\d/.test(l) && VERSION_RE.test(l));
  },
  installCmd(v) { assertVersion(v); return { cmd: 'ruby-install', args: ['--no-reinstall', 'ruby', v] }; },
  uninstallCmd(v) {
    assertVersion(v);
    return { remove: path.join(home, '.rubies', `ruby-${v}`) };
  },
  execCmd: defaultExec,
};

// ---------------------------------------------------------------- RubyInstaller (Windows)
const rubyinstaller = {
  id: 'rubyinstaller', name: 'RubyInstaller (winget)', url: 'https://rubyinstaller.org/',
  async detect(env) {
    if (!isWin) return false;
    const w = await run('winget', ['--version'], { env });
    this.canInstall = w.code === 0;
    return true;
  },
  async list() {
    const roots = ['C:\\', 'C:\\tools', path.join(process.env.LOCALAPPDATA || '', 'Programs')];
    const out = [];
    for (const root of roots) {
      for (const d of readdirSafe(root)) {
        if (!d.isDirectory() || !/^ruby\d/i.test(d.name)) continue;
        const binDir = path.join(root, d.name, 'bin');
        if (fs.existsSync(rubyExe(binDir))) out.push({ version: null, binDir, label: d.name });
      }
    }
    return out;
  },
  async getGlobal() { return null; },
  async setGlobal() { return { code: 1, stdout: '', stderr: 'RubyInstaller ではシステム環境変数 PATH の順序でグローバルが決まります。' }; },
  async listRemote() {
    return ['4.0', '3.4', '3.3', '3.2', '3.1'];
  },
  installCmd(v) {
    assertVersion(v);
    return { cmd: 'winget', args: ['install', '--id', `RubyInstallerTeam.RubyWithDevKit.${V.series(v)}`, '-e', '--accept-package-agreements', '--accept-source-agreements'] };
  },
  uninstallCmd(v) {
    assertVersion(v);
    return { cmd: 'winget', args: ['uninstall', '--id', `RubyInstallerTeam.RubyWithDevKit.${V.series(v)}`, '-e'] };
  },
  execCmd: defaultExec,
};

// ---------------------------------------------------------------- system
const system = {
  id: 'system', name: 'システム / Homebrew', readonly: true,
  async detect() { return !isWin; },
  async list() {
    const cands = ['/usr/bin', '/opt/homebrew/opt/ruby/bin', '/usr/local/opt/ruby/bin', '/home/linuxbrew/.linuxbrew/opt/ruby/bin'];
    return cands.filter((b) => fs.existsSync(rubyExe(b))).map((binDir) => ({ version: null, binDir }));
  },
  async getGlobal() { return null; },
  async setGlobal() { return { code: 1, stdout: '', stderr: 'システム Ruby はグローバルに設定できません。' }; },
  async listRemote() { return []; },
  installCmd() { return null; },
  uninstallCmd() { return null; },
  execCmd: defaultExec,
};

const ALL = [rbenv, mise, asdf, rvm, chruby, rubyinstaller, system];

async function rubyVersionOf(binDir, env) {
  const r = await run(rubyExe(binDir), ['-e', 'print RUBY_VERSION'], { env, timeout: 10000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** 全マネージャを検出し、インストール済み Ruby を一覧化 */
async function scan(env) {
  const managers = [];
  const rubies = [];
  const seenBin = new Set();
  for (const m of ALL) {
    let available = false;
    try { available = await m.detect(env); } catch { available = false; }
    const info = { id: m.id, name: m.name, url: m.url || null, available, canInstall: !!(available && m.canInstall), readonly: !!m.readonly, global: null };
    managers.push(info);
    if (!available) continue;
    try { info.global = await m.getGlobal(env); } catch { /* ignore */ }
    let list = [];
    try { list = await m.list(env); } catch { list = []; }
    for (const r of list) {
      const real = (() => { try { return fs.realpathSync(r.binDir); } catch { return r.binDir; } })();
      if (seenBin.has(real)) continue;
      seenBin.add(real);
      if (!r.version) r.version = await rubyVersionOf(r.binDir, env);
      if (!r.version) continue;
      rubies.push({
        ...r,
        id: `${m.id}:${r.version}:${rubies.length}`,
        manager: m.id,
        managerName: m.name,
        isGlobal: !!info.global && V.normalize(info.global) === V.normalize(r.version),
        lifecycle: V.lifecycle(r.version),
        series: V.series(r.version),
      });
    }
  }
  if (managers.filter((m) => m.available && m.id !== 'system').length === 0) {
    managers.push({ id: 'none', name: 'バージョンマネージャ未検出', available: false });
  }
  rubies.sort((a, b) => V.compare(b.version, a.version));
  return { managers, rubies };
}

function getManager(id) {
  const m = ALL.find((x) => x.id === id);
  if (!m) throw new Error(`unknown manager: ${id}`);
  return m;
}

module.exports = { scan, getManager, assertVersion, rubyExe, ALL };
