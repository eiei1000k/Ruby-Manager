'use strict';
// コマンド実行と、GUI 起動時でもログインシェルと同じ環境変数を使うためのユーティリティ
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
let cachedEnv = null;

function quoteWin(arg) {
  if (arg === '') return '""';
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * コマンドを実行し、終了を待つ。
 * Windows では .cmd/.bat (rbenv, bundle.bat 等) を解決するため shell 経由で起動する。
 */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    const spawnOpts = { cwd: opts.cwd, env: opts.env || cachedEnv || process.env, windowsHide: true };
    try {
      if (isWin) {
        child = spawn([quoteWin(cmd), ...args.map(quoteWin)].join(' '), [], { ...spawnOpts, shell: true });
      } else {
        child = spawn(cmd, args, spawnOpts);
      }
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message || e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (opts.timeout) timer = setTimeout(() => child.kill(), opts.timeout);
    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; opts.onData && opts.onData(s, 'stdout'); });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; opts.onData && opts.onData(s, 'stderr'); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e.message || e) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr }); });
    if (opts.onSpawn) opts.onSpawn(child);
  });
}

/** よく使われるバージョンマネージャのパス（ログインシェルが読めなかった場合の保険） */
function fallbackPaths() {
  const h = os.homedir();
  if (isWin) {
    const local = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
    return [path.join(local, 'mise', 'shims'), path.join(local, 'Microsoft', 'WinGet', 'Links')];
  }
  return [
    path.join(h, '.rbenv', 'bin'), path.join(h, '.rbenv', 'shims'),
    path.join(h, '.local', 'bin'), path.join(h, '.local', 'share', 'mise', 'shims'),
    path.join(h, '.asdf', 'shims'), path.join(h, '.asdf', 'bin'), path.join(h, '.rvm', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin',
  ];
}

/** macOS/Linux ではログインシェルから環境変数を取得する（Finder 起動だと PATH が最小限のため） */
async function loadShellEnv() {
  if (cachedEnv) return cachedEnv;
  const env = { ...process.env };
  if (!isWin) {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const marker = '__RUBY_MANAGER_ENV__';
    const script = `echo ${marker}; ELECTRON_RUN_AS_NODE=1 "${process.execPath}" -p 'JSON.stringify(process.env)'; echo ${marker}`;
    const res = await run(shell, ['-ilc', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 });
    const parts = res.stdout.split(marker);
    if (parts.length >= 3) {
      try {
        const parsed = JSON.parse(parts[1].trim());
        delete parsed.ELECTRON_RUN_AS_NODE;
        Object.assign(env, parsed);
      } catch { /* ignore */ }
    }
  }
  const key = isWin ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path' : 'PATH';
  const current = (env[key] || '').split(path.delimiter).filter(Boolean);
  for (const p of fallbackPaths()) if (!current.includes(p) && fs.existsSync(p)) current.push(p);
  env[key] = current.join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  cachedEnv = env;
  return env;
}

/** 特定 Ruby の bin を PATH 先頭に置いた環境を作る（他マネージャの干渉を避ける） */
function envWithRuby(baseEnv, binDir, version) {
  const env = { ...baseEnv };
  for (const k of ['GEM_HOME', 'GEM_PATH', 'RUBYOPT', 'RUBYLIB', 'BUNDLE_GEMFILE', 'BUNDLE_BIN_PATH', 'RUBY_ROOT', 'RUBY_ENGINE', 'RUBY_VERSION']) delete env[k];
  const key = isWin ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path' : 'PATH';
  env[key] = [binDir, env[key] || ''].join(path.delimiter);
  if (version) {
    env.RBENV_VERSION = version;
    env.ASDF_RUBY_VERSION = version;
    env.MISE_RUBY_VERSION = version;
  }
  return env;
}

module.exports = { run, loadShellEnv, envWithRuby, isWin };
