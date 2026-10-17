'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyze } = require('../src/engine.js');
const rules = require('../src/rules.js');
const { compatReport, javaFor } = require('../src/compat.js');
const { checkUpdates } = require('../src/updates.js');
const { toHtml } = require('../src/report-html.js');
const { auditServer } = require('../src/audit.js');
const { loadDir } = require('../src/fs-loader.js');
const { makeZip } = require('../scripts/zip-writer.js');

test('every data rule has a fixture that triggers it', () => {
  const dir = path.join(__dirname, '..', 'rules', 'packs');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1);
  const seen = new Set();
  let count = 0;
  for (const file of files) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const d of pack.rules) {
      assert.ok(d.id && d.severity && d.title && d.match && d.explain && Array.isArray(d.fix) && d.fix.length, file + ': ' + d.id + ' is missing a field');
      assert.ok(typeof d.fixture === 'string' && d.fixture.length, d.id + ' needs a fixture');
      assert.ok(!seen.has(d.id), 'duplicate rule id ' + d.id);
      seen.add(d.id);
      assert.strictEqual(rules.filter((r) => r.id === d.id).length, 1, d.id + ' collides with another rule id');
      const r = analyze(d.fixture);
      const f = r.findings.find((x) => x.id === d.id);
      assert.ok(f, d.id + ' did not fire on its own fixture');
      if (d.expect && d.expect.plugin) assert.strictEqual(f.plugin, d.expect.plugin);
      assert.ok(!/\{\d\}/.test(f.title + f.summary), d.id + ' left a placeholder unfilled: ' + f.title + ' / ' + f.summary);
      count++;
    }
  }
  assert.ok(count >= 9);
});

test('spark health report output is understood', () => {
  const text = [
    '[10:00:00 INFO]: [spark] Health report:',
    '[10:00:00 INFO]: >  TPS from last 5s, 10s, 1m, 5m, 15m:',
    '[10:00:00 INFO]: >   *14.2, *15.8, *16.3, *17.9, 19.1',
    '[10:00:00 INFO]: >  Tick durations (min/med/95%ile/max ms) from last 10s, 1m:',
    '[10:00:00 INFO]: >   3.1/ 41.2/ 96.5/ 1800.4;  2.9/ 38.0/ 88.1/ 2400.0',
    '[10:00:00 INFO]: >  Memory usage:',
    '[10:00:00 INFO]: >   7.4 GB / 8.0 GB (93%)',
    '[10:00:00 INFO]: >  G1 Old Generation: 9 collections, avg 3200ms'
  ].join('\n');
  const ids = analyze(text).findings.map((f) => f.id);
  for (const id of ['spark-tps', 'spark-ticks', 'spark-memory', 'spark-gc']) assert.ok(ids.includes(id), 'missing ' + id);
  const healthy = '[10:00:00 INFO]: >  TPS from last 5s, 10s, 1m, 5m, 15m:\n[10:00:00 INFO]: >   20.0, 20.0, 20.0, 20.0, 20.0\n[10:00:00 INFO]: >  Tick durations (min/med/95%ile/max ms) from last 10s, 1m:\n[10:00:00 INFO]: >   1.0/ 3.0/ 8.0/ 20.0;  1.0/ 3.1/ 9.0/ 25.0\n';
  assert.deepStrictEqual(analyze(healthy).findings.map((f) => f.id), []);
});

test('client logs are recognised and class probing noise is only a note', () => {
  const log = [
    '[19:38:26] [Render thread/INFO]: Setting user: Steve',
    '[19:38:27] [main/WARN]: Error loading class: xaero/map/gui/GuiMap (java.lang.ClassNotFoundException: xaero.map.gui.GuiMap)'
  ].join('\n');
  const r = analyze(log);
  const mc = r.findings.find((f) => f.id === 'missing-class');
  assert.strictEqual(mc.severity, 'info');
  assert.strictEqual(mc.title, 'Missing class: xaero.map.gui.GuiMap');
  assert.ok(r.findings.some((f) => f.id === 'client-log'));
  assert.deepStrictEqual(r.culprits, []);
});

test('a class not found while a plugin enables is still an error', () => {
  const log = '[10:00:00 ERROR]: Error occurred while enabling Foo v1.0 (Is it up to date?)\njava.lang.NoClassDefFoundError: net/milkbowl/vault/economy/Economy\n';
  const r = analyze(log);
  assert.strictEqual(r.findings.find((f) => f.id === 'missing-class').severity, 'error');
});

test('upgrade compatibility report', () => {
  assert.strictEqual(javaFor('1.21.4'), 21);
  assert.strictEqual(javaFor('1.20.1'), 17);
  assert.strictEqual(javaFor('26.2'), 25);
  const rep = compatReport([
    { name: 'Fresh', version: '1', api: '1.21', javaNeeded: 17 },
    { name: 'Ancient', version: '1', api: null, javaNeeded: 8 },
    { name: 'Behind', version: '1', api: '1.17', javaNeeded: 16 },
    { name: 'Future', version: '1', api: '1.22', javaNeeded: 21 },
    { name: 'NewJava', version: '1', api: '1.20', javaNeeded: 25 }
  ], '1.21.4');
  const by = (n) => rep.rows.find((r) => r.name === n).status;
  assert.deepStrictEqual([by('Fresh'), by('Ancient'), by('Behind'), by('Future'), by('NewJava')], ['ok', 'risky', 'check', 'broken', 'broken']);
  assert.strictEqual(rep.rows[0].status, 'broken');
  assert.deepStrictEqual(rep.summary, { ok: 1, check: 1, risky: 1, broken: 2 });
});

test('update check reads Modrinth answers and only sends hashes', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const old = { id: 'v1', version_number: '1.0', project_id: 'PROJ', date_published: '2024-01-01' };
    const fresh = { id: 'v2', version_number: '2.0', project_id: 'PROJ', date_published: '2025-01-01' };
    if (url.endsWith('/version_files')) return { ok: true, json: async () => ({ aaa: old, bbb: fresh }) };
    return { ok: true, json: async () => (body.game_versions ? { aaa: fresh } : { aaa: fresh, bbb: fresh }) };
  };
  const r = await checkUpdates([{ name: 'Old', sha1: 'aaa' }, { name: 'New', sha1: 'bbb' }, { name: 'Other', sha1: 'ccc' }], { mc: '1.21.4', fetch: fakeFetch });
  const by = (n) => r.rows.find((x) => x.name === n);
  assert.strictEqual(by('Old').status, 'outdated');
  assert.strictEqual(by('Old').latest, '2.0');
  assert.strictEqual(by('Old').supportsMc, true);
  assert.strictEqual(by('New').status, 'latest');
  assert.strictEqual(by('Other').status, 'unknown');
  assert.strictEqual(r.outdated, 1);
  assert.ok(calls.every((c) => Object.keys(c.body).every((k) => ['hashes', 'algorithm', 'loaders', 'game_versions'].includes(k))), 'only hashes and filters are sent');
});

test('folder audit with update check and upgrade target adds findings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-feat-'));
  fs.mkdirSync(path.join(root, 'plugins'));
  const jar = makeZip([['plugin.yml', 'name: Aged\nversion: 1.0\nmain: a.A\napi-version: 1.17\n'], ['a/A.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 60]), true]]);
  fs.writeFileSync(path.join(root, 'plugins', 'Aged.jar'), jar);
  fs.writeFileSync(path.join(root, 'server.properties'), 'online-mode=true\n');
  const fakeFetch = async (url) => {
    if (url.endsWith('/version_files')) return { ok: true, json: async () => ({ [require('crypto').createHash('sha1').update(jar).digest('hex')]: { id: 'v1', version_number: '1.0', project_id: 'P', date_published: '2023-01-01' } }) };
    return { ok: true, json: async () => ({ [require('crypto').createHash('sha1').update(jar).digest('hex')]: { id: 'v9', version_number: '9.0', project_id: 'P', date_published: '2025-06-01' } }) };
  };
  const r = await auditServer(loadDir(root), { checkUpdates: true, target: '1.21.4', fetch: fakeFetch });
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes('audit-outdated-plugin'));
  assert.ok(ids.includes('audit-upgrade-risk'));
  assert.strictEqual(r.compat.rows[0].status, 'check');
  assert.strictEqual(r.pluginDetails[0].javaNeeded, 16);
  fs.rmSync(root, { recursive: true, force: true });
});

test('HTML report is self-contained and escapes content', () => {
  const r = analyze('[10:00:00 ERROR]: Could not pass event <script>alert(1)</script> to Foo v1.0\n');
  const html = toHtml(r, { contact: 'Message me <b>here</b>' });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/<script/i.test(html), 'no script tags may appear');
  assert.match(html, /Message me &lt;b&gt;here&lt;\/b&gt;/);
  assert.match(html, /LogDoctor/);
});

test('plan titles name the plugin and the totals reconcile', () => {
  const r = analyze(fs.readFileSync(path.join(__dirname, '..', 'samples', 'plugin-problems.log'), 'utf8'));
  assert.ok(r.plan.every((p) => !p.plugin || p.title.toLowerCase().includes(p.plugin.toLowerCase())));
  assert.ok(r.planTotal >= r.plan.length);
});
