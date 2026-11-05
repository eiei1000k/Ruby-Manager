'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const V = require('../src/main/versions');
const { parseLockfile, parseOutdated } = require('../src/main/lockfile');
const project = require('../src/main/project');

test('version compare / satisfies', () => {
  assert.ok(V.compare('3.3.10', '3.3.9') > 0);
  assert.ok(V.compare('3.4.0-preview1', '3.4.0') < 0);
  assert.strictEqual(V.compare('ruby-3.3.0', '3.3.0'), 0);
  assert.ok(V.satisfies('3.3.6', '~> 3.3'));
  assert.ok(!V.satisfies('4.0.0', '~> 3.3'));
  assert.ok(V.satisfies('3.3.6', '~> 3.3.1'));
  assert.ok(!V.satisfies('3.4.0', '~> 3.3.1'));
  assert.ok(V.satisfies('3.2.1', '>= 3.1, < 3.3'));
  assert.ok(!V.satisfies('3.3.0', '>= 3.1, < 3.3'));
});

test('resolve picks exact then highest prefix', () => {
  const inst = [{ version: '3.3.1' }, { version: '3.3.6' }, { version: '3.4.1' }];
  assert.strictEqual(V.resolve('3.3.1', inst).ruby.version, '3.3.1');
  assert.strictEqual(V.resolve('3.3', inst).ruby.version, '3.3.6');
  assert.strictEqual(V.resolve('ruby-3.4.1', inst).ruby.version, '3.4.1');
  assert.strictEqual(V.resolve('3.2', inst), null);
});

test('lifecycle', () => {
  const d = new Date('2026-11-05');
  assert.strictEqual(V.lifecycle('3.1.4', d).status, 'eol');
  assert.strictEqual(V.lifecycle('3.3.6', d).status, 'security');
  assert.strictEqual(V.lifecycle('3.4.1', d).status, 'normal');
});

test('parse lockfile', () => {
  const fs = require('fs');
  const lock = parseLockfile(fs.readFileSync(path.join(__dirname, 'fixtures/sample/Gemfile.lock'), 'utf8'));
  assert.strictEqual(lock.bundledWith, '2.5.22');
  assert.strictEqual(lock.rubyVersion, '3.3.6p108');
  assert.deepStrictEqual(lock.platforms, ['arm64-darwin', 'x86_64-linux']);
  assert.strictEqual(lock.specs.length, 4);
  const noko = lock.specs.find((s) => s.name === 'nokogiri');
  assert.strictEqual(noko.version, '1.16.0');
  assert.strictEqual(noko.platform, 'arm64-darwin');
  assert.deepStrictEqual(noko.deps, [{ name: 'racc', requirement: '~> 1.4' }]);
  assert.strictEqual(lock.specs.find((s) => s.name === 'mygem').sourceType, 'GIT');
  assert.deepStrictEqual(lock.dependencies.map((d) => [d.name, d.pinned]), [['mygem', true], ['rails', false]]);
  assert.strictEqual(lock.sources[0].branch, 'main');
});

test('parse outdated', () => {
  const o = parseOutdated('Fetching gem metadata\nrack (newest 3.0.8, installed 2.2.8, requested ~> 2.2)\nrake (newest 13.2.1, installed 13.0.6)\n');
  assert.deepStrictEqual(Object.keys(o), ['rack', 'rake']);
  assert.strictEqual(o.rack.requested, '~> 2.2');
});

test('analyze project', () => {
  const dir = path.join(__dirname, 'fixtures/sample');
  const inst = [{ id: 'r1', version: '3.3.6', manager: 'rbenv' }];
  const a = project.analyze(dir, inst);
  assert.strictEqual(a.resolved.id, 'r1');
  assert.strictEqual(a.gemRuby.requirement, '~> 3.3');
  assert.strictEqual(a.bundle.gems.find((g) => g.name === 'rails').direct, true);
  assert.strictEqual(a.status, 'ok');
});

test('analyze project with missing ruby', () => {
  const a = project.analyze(path.join(__dirname, 'fixtures/sample'), [{ id: 'x', version: '3.4.1', manager: 'mise' }]);
  assert.strictEqual(a.resolved, null);
  assert.strictEqual(a.status, 'error');
});
