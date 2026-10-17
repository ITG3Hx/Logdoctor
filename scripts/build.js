'use strict';

// Copies the engine next to the web page, bundles the sample logs and a demo server
// folder so the page can offer them as examples. Run with: npm run build

const fs = require('fs');
const path = require('path');
const { makeZip } = require('./zip-writer.js');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');
const samplesDir = path.join(root, 'samples');

for (const file of ['engine.js', 'rules.js', 'zip.js', 'yaml.js', 'compat.js', 'updates.js', 'report-html.js', 'audit.js']) {
  fs.copyFileSync(path.join(root, 'src', file), path.join(docs, file));
}

const labels = {
  'plugin-problems.log': 'Plugin errors, lag, bad config',
  'watchdog-freeze.log': 'Watchdog freeze and conflicting plugins',
  'crash-report.txt': 'Crash report: ticking entity',
  'wrong-java.log': 'Wrong Java version',
  'fabric-mods.log': 'Fabric mod conflict',
  'clean-start.log': 'Healthy start (no problems)'
};

const out = [];
for (const [file, label] of Object.entries(labels)) {
  const text = fs.readFileSync(path.join(samplesDir, file), 'utf8').replace(/^\uFEFF/, '');
  out.push({ label, text });
}

const classFile = (v) => Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, v]);
const plugin = (yml, main, v) => makeZip([['plugin.yml', yml], [main.replace(/\./g, '/') + '.class', classFile(v || 61), true]]);
const demo = {
  'server.properties': 'online-mode=false\nview-distance=16\nserver-ip=192.168.1.20\nenable-rcon=true\nrcon.password=123\n',
  'eula.txt': 'eula=false\n',
  'paper-1.21.1.jar': 'placeholder',
  'start.bat': '@echo off\njava -Xms1G -Xmx6G -XX:+UseConcMarkSweepGC -jar paper.jar nogui\npause\n',
  'logs/latest.log': '[10:00:00 INFO]: [bootstrap] Running Java 17 (OpenJDK 64-Bit Server VM 17.0.9)\n[10:00:00 INFO]: This server is running Paper version git-Paper-132 (MC: 1.21.1) (Implementing API version 1.21.1-R0.1-SNAPSHOT)\n[10:00:02 ERROR]: Unknown/missing dependency plugins: [Vault]. Please download and install these plugins to run \'ShopGUI\'.\n[10:00:05 INFO]: Done (5.0s)! For help, type "help"\n[10:04:10 ERROR]: Could not pass event PlayerJoinEvent to ShopGUI v1.0\njava.lang.NullPointerException: Cannot invoke "Object.toString()" because "x" is null\n\tat ShopGUI-1.0.jar//dev.shop.Listener.onJoin(Listener.java:21) ~[ShopGUI-1.0.jar:?]\n',
  'plugins/ShopGUI.jar': plugin('name: ShopGUI\nversion: 1.0\nmain: dev.shop.Main\napi-version: 1.21\ndepend: [Vault]\n', 'dev.shop.Main'),
  'plugins/Skyblocks.jar': plugin('name: Skyblocks\nversion: 3.2\nmain: dev.sky.Main\napi-version: 1.22\n', 'dev.sky.Main'),
  'plugins/Parkour-NewJava.jar': plugin('name: Parkour\nversion: 2.0\nmain: dev.park.Main\napi-version: 1.21\n', 'dev.park.Main', 65),
  'plugins/OldHomes.jar': plugin('name: OldHomes\nversion: 0.9\nmain: dev.homes.Main\n', 'dev.homes.Main'),
  'plugins/Essentials.jar': plugin('name: Essentials\nversion: 2.20\nmain: e.E\napi-version: 1.21\n', 'e.E'),
  'plugins/CMI.jar': plugin('name: CMI\nversion: 9.7\nmain: c.C\napi-version: 1.21\n', 'c.C'),
  'plugins/SomeMod.jar': makeZip([['fabric.mod.json', '{}']]),
  'plugins/ClaimMaster/config.yml': 'claims:\n\tmax: 5\n\tsize: 32\n',
  'plugins/Messages/config.yml': "messages:\n  welcome: 'Don't forget to read the rules'\n  bye: 'See you'\n"
};
const demoFiles = Object.entries(demo).map(([p, c]) => ({ path: p, b64: Buffer.from(c).toString('base64') }));

const packDir = path.join(root, 'rules', 'packs');
const packs = fs.readdirSync(packDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(packDir, f), 'utf8')));
fs.writeFileSync(path.join(docs, 'packs.js'), 'window.LogDoctorPacks = ' + JSON.stringify(packs) + ';\n');
if (!fs.existsSync(path.join(docs, 'site-config.js'))) {
  fs.writeFileSync(path.join(docs, 'site-config.js'), '// Edit this file to add your own contact line to every downloaded report.\nwindow.LogDoctorConfig = { contact: "" };\n');
}

fs.writeFileSync(
  path.join(docs, 'samples.js'),
  'window.LogDoctorSamples = ' + JSON.stringify(out) + ';\nwindow.LogDoctorDemoServer = ' + JSON.stringify(demoFiles) + ';\n'
);
console.log('built docs/ (' + out.length + ' samples, demo server with ' + demoFiles.length + ' files)');