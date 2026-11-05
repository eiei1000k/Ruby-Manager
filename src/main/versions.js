'use strict';
// バージョン文字列の比較・要件判定・EOL 情報（Electron 非依存。テスト可能）

function normalize(v) {
  if (!v) return '';
  return String(v).trim().replace(/^ruby[-@ ]/i, '').replace(/p\d+$/, '');
}

function segments(v) {
  return normalize(v).split(/[.\-]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** Gem::Version 風の比較。プレリリース（文字を含む）は正式版より小さい */
function compare(a, b) {
  const sa = segments(a);
  const sb = segments(b);
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    let x = sa[i];
    let y = sb[i];
    if (x === undefined) x = typeof y === 'string' ? Infinity : 0;
    if (y === undefined) y = typeof x === 'string' ? Infinity : 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : 1;
    if (x === Infinity) return 1;
    if (y === Infinity) return -1;
    return typeof x === 'string' ? -1 : 1;
  }
  return 0;
}

function isRelease(v) {
  return /^\d+(\.\d+)*$/.test(normalize(v));
}

/** "~> 3.2", ">= 3.1, < 4" のような要件を満たすか */
function satisfies(version, requirement) {
  if (!requirement) return true;
  const v = normalize(version);
  const parts = String(requirement).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.every((part) => {
    const m = part.match(/^(~>|>=|<=|!=|>|<|=)?\s*(.+)$/);
    if (!m) return false;
    const op = m[1] || '=';
    const target = normalize(m[2]);
    const c = compare(v, target);
    switch (op) {
      case '=': return c === 0 || (!m[1] && v.startsWith(target + '.'));
      case '!=': return c !== 0;
      case '>': return c > 0;
      case '<': return c < 0;
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '~>': {
        const segs = target.split('.');
        const upperSegs = segs.length > 1 ? segs.slice(0, -1) : segs.slice();
        upperSegs[upperSegs.length - 1] = String(Number(upperSegs[upperSegs.length - 1]) + 1);
        return c >= 0 && compare(v, upperSegs.join('.')) < 0;
      }
      default: return false;
    }
  });
}

/**
 * 指定（"3.3.0" / "3.3" / "ruby-3.3.0"）にマッチするインストール済みバージョンを返す。
 * 完全一致を優先し、無ければプレフィックス一致の最新版。
 */
function resolve(spec, installed) {
  const want = normalize(spec);
  if (!want) return null;
  const exact = installed.find((r) => normalize(r.version) === want);
  if (exact) return { ruby: exact, exact: true };
  const prefix = installed
    .filter((r) => normalize(r.version).startsWith(want + '.'))
    .sort((a, b) => compare(b.version, a.version));
  if (prefix.length) return { ruby: prefix[0], exact: false };
  return null;
}

function series(v) {
  const m = normalize(v).match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : normalize(v);
}

// 公式のブランチ保守状況（https://www.ruby-lang.org/ja/downloads/branches/）。未来の日付は予定。
const EOL = {
  '2.6': '2022-04-12', '2.7': '2023-03-31', '3.0': '2024-04-23', '3.1': '2025-03-26',
  '3.2': '2026-03-31', '3.3': '2027-03-31', '3.4': '2028-03-31', '4.0': '2029-03-31',
};

function lifecycle(v, today = new Date()) {
  const s = series(v);
  const eol = EOL[s];
  if (!eol) {
    const [maj] = s.split('.').map(Number);
    if (maj && maj < 2) return { status: 'eol', label: 'EOL', eol: null };
    if (/^\d+\.\d+$/.test(s) && compare(s, '4.0') > 0) return { status: 'normal', label: '保守中', eol: null };
    return { status: 'unknown', label: '不明', eol: null };
  }
  const end = new Date(eol + 'T00:00:00Z');
  if (end < today) return { status: 'eol', label: 'EOL', eol };
  const months = (end - today) / (1000 * 60 * 60 * 24 * 30);
  if (months <= 12) return { status: 'security', label: 'セキュリティ保守', eol };
  return { status: 'normal', label: '保守中', eol };
}

module.exports = { normalize, compare, satisfies, resolve, series, lifecycle, isRelease };
