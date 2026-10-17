'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { analyze, toMarkdown } = require('../src/engine.js');
const rules = require('../src/rules.js');

const sample = (name) => fs.readFileSync(path.join(__dirname, '..', 'samples', name), 'utf8');
const ids = (r) => r.findings.map((f) => f.id);

test('every rule has the required fields and a unique id', () => {
  const seen = new Set();
  for (const r of rules) {
    assert.ok(r.id && !seen.has(r.id), 'duplicate or missing id: ' + r.id);
    seen.add(r.id);
    assert.ok(['critical', 'error', 'warning', 'info'].includes(typeof r.severity === 'function' ? 'error' : r.severity), r.id + ' severity');
    assert.ok(r.match || r.check, r.id + ' needs match or check');
    if (r.match) assert.ok(!r.match.global, r.id + ' match must not use the g flag');
    assert.ok(r.title, r.id + ' title');
  }
  assert.ok(rules.length >= 50, 'expected at least 50 rules');
});

test('no rule text contains an em dash or emoji', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules.js'), 'utf8');
  assert.ok(!src.includes('\u2014'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(src));
});

test('clean start log has no findings', () => {
  const r = analyze(sample('clean-start.log'));
  assert.deepStrictEqual(ids(r), []);
  assert.strictEqual(r.verdictLevel, 'ok');
  assert.strictEqual(r.info.software, 'Paper');
  assert.strictEqual(r.info.mcVersion, '1.21.1');
  assert.strictEqual(r.info.plugins.length, 3);
});

test('wrong Java version is explained with both versions', () => {
  const r = analyze(sample('wrong-java.log'));
  assert.deepStrictEqual(ids(r), ['java-class-version']);
  assert.match(r.findings[0].summary, /needs Java 21.*Java 17/);
  assert.strictEqual(r.verdictLevel, 'critical');
});

test('plugin problems log finds the expected issues and blames the right plugins', () => {
  const r = analyze(sample('plugin-problems.log'));
  const got = new Set(ids(r));
  for (const id of ['unsupported-api', 'unknown-dependency', 'yaml-tabs', 'enable-failed', 'event-exception', 'task-exception', 'command-exception', 'async-main-thread', 'cant-keep-up', 'legacy-plugin', 'offline-mode', 'slow-start', 'world-missing']) {
    assert.ok(got.has(id), 'missing finding ' + id);
  }
  assert.ok(!got.has('yaml-error'), 'yaml-error should be replaced by yaml-tabs');
  assert.ok(!got.has('unhandled-exception'), 'every trace in this sample has a specific rule');
  const byId = (id) => r.findings.find((f) => f.id === id);
  assert.strictEqual(byId('unsupported-api').plugin, 'FancyNpcs');
  assert.strictEqual(byId('unsupported-api').count, 1);
  assert.strictEqual(byId('unknown-dependency').plugin, 'ShopGUIPlus');
  assert.strictEqual(byId('event-exception').plugin, 'OldHomes');
  assert.strictEqual(byId('async-main-thread').plugin, 'CoreProtect');
  assert.strictEqual(byId('cant-keep-up').severity, 'error');
  assert.strictEqual(r.culprits[0].plugin, 'OldHomes');
});

test('watchdog freeze names the plugin from the thread dump', () => {
  const r = analyze(sample('watchdog-freeze.log'));
  const w = r.findings.find((f) => f.id === 'watchdog');
  assert.ok(w);
  assert.strictEqual(w.plugin, 'HopperOptimizer');
  assert.strictEqual(w.count, 1);
  assert.ok(ids(r).includes('plugin-conflict-check'));
  assert.ok(ids(r).includes('abandoned-plugin-check'));
});

test('crash report extracts the entity and location', () => {
  const r = analyze(sample('crash-report.txt'));
  const f = r.findings.find((x) => x.id === 'crash-report');
  assert.ok(f);
  assert.match(f.summary, /villager/);
  assert.match(f.summary, /120\.50, 64\.00, -340\.50/);
  assert.strictEqual(r.info.java, '21.0.4');
});

test('fabric incompatibility is reported once with its detail lines', () => {
  const r = analyze(sample('fabric-mods.log'));
  const f = r.findings.find((x) => x.id === 'fabric-incompatible');
  assert.ok(f);
  assert.strictEqual(f.count, 1);
  assert.ok(f.evidence.some((e) => /fabric-api/.test(e.text)));
});

test('unknown exceptions fall back to a generic finding with the plugin from the jar name', () => {
  const log = [
    '[10:00:00 INFO]: [Shopper] Enabling Shopper v1.0',
    '[10:00:05 ERROR]: Something odd happened',
    'java.lang.ArithmeticException: / by zero',
    '\tat Shopper-1.0.jar//dev.shop.Price.calc(Price.java:9) ~[Shopper-1.0.jar:?]',
    '\tat org.bukkit.scheduler.BukkitRunnable.run(BukkitRunnable.java:1) ~[paper-api.jar:?]'
  ].join('\n');
  const r = analyze(log);
  assert.deepStrictEqual(ids(r), ['unhandled-exception']);
  assert.strictEqual(r.findings[0].plugin, 'Shopper');
  assert.match(r.findings[0].summary, /divided by zero/);
});

test('handles CRLF, ANSI colors and ISO timestamps', () => {
  const log = '\u001b[33m[10:00:00 WARN]\u001b[0m: Can\'t keep up! Is the server overloaded? Running 3000ms or 60 ticks behind\r\n2026-01-01 10:00:01 [INFO] You need to agree to the EULA in order to run the server\r\n';
  const r = analyze(log);
  assert.deepStrictEqual(new Set(ids(r)), new Set(['cant-keep-up', 'eula']));
});

test('markdown report contains the verdict and each finding', () => {
  const md = toMarkdown(analyze(sample('wrong-java.log')));
  assert.match(md, /# LogDoctor report/);
  assert.match(md, /\[CRITICAL\] Wrong Java version/);
});

test('empty and huge-line input does not throw', () => {
  assert.doesNotThrow(() => analyze(''));
  assert.doesNotThrow(() => analyze('x'.repeat(2000000)));
  assert.doesNotThrow(() => analyze(null));
});
const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('review fixture: modern Paper log is detected and plugins are listed', () => {
  const r = analyze(fx('1-paper-npe.log'));
  assert.strictEqual(r.info.software, 'Paper');
  assert.strictEqual(r.info.mcVersion, '1.21.4');
  assert.deepStrictEqual(r.info.plugins.map((p) => p.name).sort(), ['ShopPlus', 'Vault']);
  assert.ok(ids(r).includes('economy-null'));
  assert.strictEqual(r.plan[0].plugin, 'ShopPlus');
  assert.strictEqual(r.findings.find((f) => f.id === 'enable-failed').plugin, 'ShopPlus');
});

test('review fixture: old Spigot, class version, old lag wording, one port finding', () => {
  const r = analyze(fx('2-spigot-legacy.log'));
  assert.strictEqual(r.info.software, 'Spigot');
  const j = r.findings.find((f) => f.id === 'java-major-minor');
  assert.ok(j);
  assert.strictEqual(j.plugin, 'Dynmap');
  assert.ok(ids(r).includes('cant-keep-up'));
  assert.strictEqual(r.findings.find((f) => f.id === 'port-in-use').count, 1);
  const lag = r.findings.find((f) => f.id === 'cant-keep-up');
  assert.ok(!lag.fix.some((s) => /paper-world-defaults/.test(s)), 'no Paper-only advice on Spigot');
});

test('review fixture: watchdog dump without jar tags still names a suspect', () => {
  const r = analyze(fx('3-paper-watchdog.log'));
  const w = r.findings.find((f) => f.id === 'watchdog');
  assert.ok(w);
  assert.strictEqual(w.plugin, 'chestsort');
});

test('review fixture: velocity plugin load, backend down, no duplicate connection refused', () => {
  const r = analyze(fx('4-velocity.log'));
  const got = ids(r);
  assert.ok(got.includes('velocity-plugin-load'));
  assert.ok(got.includes('velocity-backend-down'));
  assert.ok(!got.includes('connection-refused'));
  assert.strictEqual(r.findings.find((f) => f.id === 'velocity-plugin-load').plugin, 'oldchat');
});

test('review fixture: forge crash report names the mod from the mod list', () => {
  const r = analyze(fx('6-forge-crash.txt'));
  const f = r.findings.find((x) => x.id === 'crash-report');
  assert.strictEqual(f.plugin, 'biomemod');
  assert.match(f.summary, /biomemod/);
});

test('yaml: valid files from the review produce no issues', () => {
  const yaml = require('../src/yaml.js');
  const valid = [
    'd: "x #y"\ne: abc#def\nc: \'a#b\'\n',
    'm: "first line\n  second line"\nn: 1\n',
    'm: "he said \\"hi\\" and \\\\"\nn: "C:\\\\path\\\\"\n',
    'm: \'first line\n  it\'\'s second\'\nn: 1\n',
    'foo:bar: 1\n',
    'prefix: \'&7[&aServer&7] \'\nmsg: \'&cDon\'\'t do that\'\n',
    'base: &b\n  a: 1\nother:\n  <<: *b\n  a: 3\n',
    'm: {a: 1, b: 2}\nl: [a, \'it\'\'s\', "x"]\n'
  ];
  for (const v of valid) assert.deepStrictEqual(yaml.lint(v), [], JSON.stringify(v));
});

test('plugin.yml: list items at column 0 and paper-plugin.yml dependencies are read', () => {
  const yaml = require('../src/yaml.js');
  assert.deepStrictEqual(yaml.parsePluginYml('name: X\ndepend:\n- Vault\n- Foo\nsoftdepend: [A]\n').depend, ['Vault', 'Foo']);
  const p = yaml.parsePluginYml('name: X\nmain: a.B\ndependencies:\n  server:\n    Vault:\n      load: BEFORE\n      required: true\n    Soft:\n      required: false\n  bootstrap:\n    Other:\n      required: true\n');
  assert.deepStrictEqual(p.depend, ['Vault']);
});