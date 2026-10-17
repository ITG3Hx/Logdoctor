'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { auditServer } = require('../src/audit.js');
const { loadDir } = require('../src/fs-loader.js');
const yaml = require('../src/yaml.js');

const { makeZip } = require('../scripts/zip-writer.js');

const classV = (v) => Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, v]);
const plugin = (yml, main, v) => makeZip([['plugin.yml', yml], [main.replace(/\./g, '/') + '.class', classV(v || 61), true]]);

function buildServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-audit-'));
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
  w('server.properties', 'online-mode=false\nview-distance=16\nserver-ip=1.2.3.4\nenable-rcon=true\nrcon.password=abc\n');
  w('eula.txt', '#x\neula=false\n');
  w('paper-1.21.1.jar', 'x');
  w('start.bat', '@echo off\njava -Xms1G -Xmx2G -XX:+UseConcMarkSweepGC -jar paper.jar nogui\npause\n');
  w('logs/latest.log', '[10:00:00 INFO]: [bootstrap] Running Java 17 (OpenJDK 64-Bit Server VM 17.0.9)\n[10:00:00 INFO]: This server is running Paper version git-Paper-1 (MC: 1.21.1) (Implementing API version 1.21.1-R0.1-SNAPSHOT)\n[10:00:05 INFO]: Done (5.0s)! For help, type "help"\n');
  w('plugins/ShopGUI.jar', plugin('name: ShopGUI\nversion: 1.0\nmain: dev.shop.Main\napi-version: 1.21\ndepend: [Vault]\n', 'dev.shop.Main'));
  w('plugins/NewJava.jar', plugin('name: NewJava\nversion: 2.0\nmain: dev.nj.Main\napi-version: 1.21\n', 'dev.nj.Main', 65));
  w('plugins/FutureThing.jar', plugin('name: FutureThing\nversion: 1.0\nmain: dev.ft.Main\napi-version: 1.22\n', 'dev.ft.Main'));
  w('plugins/Old.jar', plugin('name: OldOne\nversion: 0.1\nmain: dev.old.Main\n', 'dev.old.Main'));
  w('plugins/NoMain.jar', makeZip([['plugin.yml', 'name: NoMain\nversion: 1\nmain: dev.nomain.Main\napi-version: 1.21\n']]));
  w('plugins/FabricThing.jar', makeZip([['fabric.mod.json', '{}']]));
  w('plugins/Broken.jar', 'this is not a zip file at all, just text that is long enough');
  w('plugins/Dup1.jar', plugin('name: Dup\nversion: 1\nmain: a.A\napi-version: 1.21\n', 'a.A'));
  w('plugins/Dup2.jar', plugin('name: Dup\nversion: 2\nmain: a.A\napi-version: 1.21\n', 'a.A'));
  w('plugins/Essentials.jar', plugin('name: Essentials\nversion: 2.20\nmain: e.E\napi-version: 1.21\n', 'e.E'));
  w('plugins/CMI.jar', plugin('name: CMI\nversion: 9\nmain: c.C\napi-version: 1.21\n', 'c.C'));
  w('plugins/Tabs/config.yml', 'settings:\n\tvalue: 1\n');
  w('plugins/Msg/config.yml', "messages:\n  hello: 'don't panic'\n  ok: 'fine'\n");
  w('plugins/Good/config.yml', 'a:\n  b: 1\n  list:\n    - id: 1\n      name: x\n    - id: 2\n      name: y\n');
  return root;
}

test('folder audit finds the problems a log alone would never show', async () => {
  const root = buildServer();
  const r = await auditServer(loadDir(root));
  const ids = new Set(r.findings.map((f) => f.id));
  for (const id of ['audit-eula', 'audit-start-jar-missing', 'audit-old-gc-flags', 'audit-missing-depend', 'audit-api-too-new', 'audit-java-too-old', 'audit-main-missing', 'audit-wrong-platform', 'audit-bad-jar', 'audit-duplicate-plugin', 'plugin-conflict-check', 'audit-yaml', 'audit-offline-mode', 'audit-server-ip', 'audit-view-distance', 'audit-rcon', 'audit-legacy-plugins']) {
    assert.ok(ids.has(id), 'missing ' + id);
  }
  const byId = (id) => r.findings.filter((f) => f.id === id);
  assert.strictEqual(byId('audit-api-too-new')[0].plugin, 'FutureThing');
  assert.strictEqual(byId('audit-java-too-old')[0].plugin, 'NewJava');
  assert.strictEqual(byId('audit-missing-depend')[0].dep, 'Vault');
  assert.strictEqual(byId('audit-yaml').length, 2, 'tabs file and apostrophe file, not the good file');
  assert.ok(byId('audit-yaml').every((f) => f.fixFile && f.fixFile.content), 'both yaml problems are auto fixable');
  assert.ok(!byId('audit-yaml').some((f) => /Good/.test(f.title)));
  assert.strictEqual(r.verdictLevel, 'critical');
  assert.strictEqual(r.info.mcVersion, '1.21.1');
  assert.ok(!ids.has('unknown-dependency'), 'log duplicate of a missing dependency is merged into the audit finding');
  assert.ok(r.plan.length >= 3 && r.plan[0].step === 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a healthy folder audits clean', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-ok-'));
  fs.mkdirSync(path.join(root, 'plugins'));
  fs.writeFileSync(path.join(root, 'server.properties'), 'online-mode=true\nview-distance=10\nserver-ip=\n');
  fs.writeFileSync(path.join(root, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(root, 'plugins', 'A.jar'), plugin('name: A\nversion: 1\nmain: a.A\napi-version: 1.21\n', 'a.A'));
  const r = await auditServer(loadDir(root));
  assert.deepStrictEqual(r.findings.map((f) => f.id), []);
  assert.strictEqual(r.verdictLevel, 'ok');
  fs.rmSync(root, { recursive: true, force: true });
});

test('selecting only the plugins folder still works', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-pl-'));
  fs.writeFileSync(path.join(root, 'A.jar'), plugin('name: A\nversion: 1\nmain: a.A\napi-version: 1.21\ndepend: [Nope]\n', 'a.A'));
  const r = await auditServer(loadDir(root).map((f) => ({ ...f, path: 'myplugins/' + f.path })));
  assert.ok(r.findings.some((f) => f.id === 'audit-missing-depend'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('yaml lint: tabs, duplicates, colon spacing, apostrophes; list items are not duplicates', () => {
  const kinds = (t) => yaml.lint(t).map((i) => i.kind);
  assert.deepStrictEqual(kinds('a:\n\tb: 1\n'), ['tab']);
  assert.deepStrictEqual(kinds('a: 1\na: 2\n'), ['duplicate']);
  assert.deepStrictEqual(kinds('a:\n  enabled:true\n'), ['colon']);
  assert.deepStrictEqual(kinds("m: 'it's'\n"), ['apostrophe']);
  assert.deepStrictEqual(kinds('items:\n  - id: 1\n    n: a\n  - id: 2\n    n: b\n'), []);
  assert.deepStrictEqual(kinds('t: |\n  line: one\n  line: two\nz: 1\n'), []);
  assert.deepStrictEqual(kinds('# comment\nurl: http://x.y:8080/a\n'), []);
  assert.strictEqual(yaml.autofix('a:\n\tb: 1\n'), 'a:\n  b: 1\n');
  assert.strictEqual(yaml.autofix("m: 'it's'\n"), "m: 'it''s'\n");
  assert.strictEqual(yaml.autofix('a: 1\n'), null);
});

test('timeline and plan come out of a log, side effects are folded under their cause', () => {
  const { analyze } = require('../src/engine.js');
  const log = [
    '[10:00:00 INFO]: Starting minecraft server version 1.21.1',
    '[10:00:02 ERROR]: Could not load \'plugins/ShopGUIPlus-1.99.jar\' in folder \'plugins\'',
    '[10:00:02 ERROR]: Unknown/missing dependency plugins: [Vault]. Please download and install these plugins to run \'ShopGUIPlus\'.',
    '[10:00:05 INFO]: Done (4.2s)! For help, type "help"',
    '[10:05:00 ERROR]: Could not pass event PlayerJoinEvent to ShopGUIPlus v1.99',
    '[10:06:00 ERROR]: No economy plugin found'
  ].join('\n');
  const r = analyze(log);
  const side = r.findings.filter((f) => f.sideEffectOf);
  assert.ok(side.some((f) => f.id === 'event-exception'));
  assert.ok(side.some((f) => f.id === 'vault-missing' && f.sideEffectOf === 'Vault'));
  assert.strictEqual(r.plan[0].id, 'unknown-dependency');
  assert.match(r.plan[0].reason, /Also explains 2/);
  assert.ok(r.timeline.length >= 3);
  assert.strictEqual(r.timeline[0].time, '10:00:00');
});