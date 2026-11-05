'use strict';
// Gemfile.lock パーサ（Bundler を呼ばずに解析するので高速・Ruby 未インストールでも動く）

function parseNameVersion(line) {
  const m = line.trim().match(/^([^\s(!]+)(?:\s+\(([^)]*)\))?(!)?$/);
  if (!m) return null;
  return { name: m[1], inner: m[2] || '', pinned: !!m[3] };
}

function parseLockfile(text) {
  const result = {
    sources: [], specs: [], dependencies: [], platforms: [],
    rubyVersion: null, bundledWith: null,
  };
  if (!text) return result;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let section = null;
  let source = null;
  let currentSpec = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      section = line.trim();
      currentSpec = null;
      if (['GEM', 'GIT', 'PATH', 'PLUGIN SOURCE'].includes(section)) {
        source = { type: section, remote: null, revision: null, branch: null, ref: null, tag: null };
        result.sources.push(source);
      } else {
        source = null;
      }
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (source) {
      const kv = line.trim().match(/^(remote|revision|branch|ref|tag|glob|submodules):\s*(.*)$/);
      if (indent === 2 && kv) { source[kv[1]] = kv[2]; continue; }
      if (indent === 2) continue; // "specs:"
      if (indent === 4) {
        const nv = parseNameVersion(line);
        if (!nv) continue;
        const dash = nv.inner.indexOf('-');
        currentSpec = {
          name: nv.name,
          version: dash >= 0 ? nv.inner.slice(0, dash) : nv.inner,
          platform: dash >= 0 ? nv.inner.slice(dash + 1) : null,
          sourceType: source.type,
          remote: source.remote,
          deps: [],
        };
        result.specs.push(currentSpec);
      } else if (indent === 6 && currentSpec) {
        const nv = parseNameVersion(line);
        if (nv) currentSpec.deps.push({ name: nv.name, requirement: nv.inner || null });
      }
      continue;
    }
    switch (section) {
      case 'PLATFORMS': result.platforms.push(line.trim()); break;
      case 'DEPENDENCIES': {
        const nv = parseNameVersion(line);
        if (nv) result.dependencies.push({ name: nv.name, requirement: nv.inner || null, pinned: nv.pinned });
        break;
      }
      case 'RUBY VERSION': result.rubyVersion = line.trim().replace(/^ruby\s+/, ''); break;
      case 'BUNDLED WITH': result.bundledWith = line.trim(); break;
      default: break;
    }
  }
  return result;
}

/** `bundle outdated --parseable` の出力を解析 */
function parseOutdated(text) {
  const out = {};
  for (const line of (text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([^\s(!]+)\s+\((.+)\)$/);
    if (!m) continue;
    const info = { name: m[1] };
    for (const part of m[2].split(',')) {
      const kv = part.trim().match(/^(newest|installed|requested)\s+(.+)$/);
      if (kv) info[kv[1]] = kv[2].trim();
    }
    if (info.newest) out[info.name] = info;
  }
  return out;
}

module.exports = { parseLockfile, parseOutdated };
