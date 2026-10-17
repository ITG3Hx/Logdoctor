#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyze, toMarkdown, where } = require('../src/engine.js');
const { auditServer } = require('../src/audit.js');
const { loadDir } = require('../src/fs-loader.js');
const { toHtml } = require('../src/report-html.js');

const USAGE = `LogDoctor reads a Minecraft server log or crash report, or a whole server folder,
and explains what is wrong and how to fix it.

Usage:
  logdoctor <server folder>        audit the whole server: plugins, configs, start script, logs
  logdoctor <log file>             diagnose a log or crash report
  logdoctor https://mclo.gs/xxxx   diagnose a log someone shared on mclo.gs
  cat latest.log | logdoctor       read from stdin (or use "-" as the file)

Folder audit options:
  --target <version>    also check which plugins survive an upgrade, for example --target 1.21.4
  --check-updates       look the plugin jars up on Modrinth and list newer versions.
                        Only file hashes are sent, nothing else.
  --write-fixes [dir]   save corrected configs and a tuned start script into dir
                        (default logdoctor-fixes). Your originals are never changed.

Output options:
  --html <file>         write a self-contained HTML report you can attach anywhere
  --md                  print a Markdown report (good for Discord or an issue)
  --json                print the full result as JSON
  --contact <text>      add a line to the HTML and Markdown reports, for example how to reach you
  --verbose             also print low-priority notes
  --no-color            turn off colors
  --fail-on <level>     exit with code 1 if a finding is at least this severe
                        (critical, error, warning, info). Default: error
  -h, --help            show this help
`;

const SEVERITY_ORDER = { critical: 0, error: 1, warning: 2, info: 3 };

function parseArgs(argv) {
  const args = { file: null, json: false, md: false, color: process.stdout.isTTY === true, failOn: 'error', help: false, writeFixes: null, target: null, checkUpdates: false, html: null, verbose: false, contact: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--md') args.md = true;
    else if (a === '--no-color') args.color = false;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--check-updates') args.checkUpdates = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--fail-on') args.failOn = argv[++i];
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--html') args.html = argv[++i];
    else if (a === '--contact') args.contact = argv[++i] || '';
    else if (a === '--write-fixes') args.writeFixes = argv[i + 1] && !argv[i + 1].startsWith('-') && !fs.existsSync(argv[i + 1]) ? argv[++i] : 'logdoctor-fixes';
    else if (a === 'audit') continue;
    else if (a === '-' || !a.startsWith('-')) args.file = a;
    else return { error: 'Unknown option: ' + a };
  }
  if (!(args.failOn in SEVERITY_ORDER)) return { error: 'Invalid --fail-on value: ' + args.failOn };
  if (args.target && !/^\d+(\.\d+){0,2}$/.test(args.target)) return { error: 'Invalid --target value: ' + args.target + ' (use something like 1.21.4)' };
  if (args.html === undefined || args.html === null && argv.includes('--html')) return { error: '--html needs a file name' };
  return args;
}

function painter(enabled) {
  const wrap = (code) => (s) => (enabled ? '\u001b[' + code + 'm' + s + '\u001b[0m' : s);
  return { bold: wrap('1'), dim: wrap('2'), red: wrap('31'), yellow: wrap('33'), green: wrap('32'), cyan: wrap('36'), magenta: wrap('35') };
}

function render(result, c, verbose) {
  const out = [];
  const sevColor = { critical: c.magenta, error: c.red, warning: c.yellow, info: c.cyan };
  const i = result.info;
  const bits = [];
  if (i.software) bits.push(i.software);
  if (i.modLoader) bits.push(i.modLoader);
  if (i.mcVersion) bits.push('Minecraft ' + i.mcVersion);
  if (i.java) bits.push('Java ' + i.java);
  if (i.plugins && i.plugins.length) bits.push(i.plugins.length + ' plugins');
  out.push(c.bold('LogDoctor') + (result.audit ? c.dim('  server audit') : ''));
  if (bits.length) out.push(c.dim(bits.join('  |  ')));
  if (result.scanned) {
    const s = result.scanned;
    out.push(c.dim('Checked ' + s.plugins + ' plugin jars, ' + s.configs + ' config files' + (s.log ? ', latest.log' : '') + (s.crash ? ', ' + s.crash : '')));
  }
  out.push('');
  const verdictColor = { ok: c.green, info: c.cyan, warning: c.yellow, error: c.red, critical: c.magenta }[result.verdictLevel];
  out.push(verdictColor(c.bold(result.verdict)));
  out.push('');
  if (result.plan && result.plan.length) {
    out.push(c.bold('Start here') + (result.planTotal > result.plan.length ? c.dim('  (' + result.plan.length + ' of ' + result.planTotal + ' problems)') : ''));
    result.plan.forEach((p) => out.push('  ' + p.step + '. ' + p.title + (p.reason ? c.dim('  ' + p.reason) : '')));
    out.push('');
  }
  if (result.compat) {
    const cp = result.compat;
    out.push(c.bold('Upgrade check for Minecraft ' + cp.target) + c.dim('  (needs Java ' + cp.java + ')'));
    const color = { broken: c.red, risky: c.yellow, check: c.yellow, ok: c.green };
    cp.rows.forEach((r) => out.push('  ' + color[r.status](r.status.padEnd(7)) + ' ' + r.name + ' ' + c.dim(r.version) + (r.status === 'ok' ? '' : c.dim('  ' + r.reason))));
    out.push('');
  }
  if (result.timeline && result.timeline.length > 1) {
    out.push(c.bold('What happened'));
    result.timeline.forEach((t) => out.push('  ' + c.dim((t.time || '--:--:--').padEnd(9)) + (t.severity === 'ok' ? t.text : sevColor[t.severity](t.text))));
    out.push('');
  }
  if (result.culprits && result.culprits.length) {
    out.push(c.dim('Plugins named in the errors: ' + result.culprits.slice(0, 5).map((x) => x.plugin + ' (' + x.count + ')').join(', ')));
    out.push('');
  }
  const shown = result.findings.filter((f) => verbose || f.severity !== 'info');
  for (const f of shown) {
    const color = sevColor[f.severity];
    out.push(color(c.bold('[' + f.severity.toUpperCase() + ']')) + ' ' + c.bold(f.title) + (f.count > 1 ? c.dim('  x' + f.count) : '') + (f.sideEffectOf ? c.dim('  (probably caused by ' + f.sideEffectOf + ')') : ''));
    if (f.summary) out.push('  ' + f.summary);
    if (f.fix.length) {
      out.push('  ' + c.green('Fix:'));
      f.fix.forEach((s) => out.push('   - ' + s));
    }
    if (f.fixFile) out.push('  ' + c.green('Fixed file available: ') + f.fixFile.path + c.dim('  (run with --write-fixes)'));
    f.evidence.forEach((e) => out.push(c.dim('  ' + where(e) + ': ' + e.text)));
    out.push('');
  }
  const hidden = result.findings.length - shown.length;
  if (hidden) out.push(c.dim(hidden + ' low-priority note' + (hidden > 1 ? 's' : '') + ' hidden. Use --verbose to see them.'));
  if (!result.findings.length) out.push('Nothing to report.');
  return out.join('\n');
}

function writeFixes(result, dir) {
  const written = [];
  for (const f of result.findings) {
    if (!f.fixFile) continue;
    fs.mkdirSync(dir, { recursive: true });
    const name = f.fixFile.path.replace(/[\\/]/g, '__');
    const target = path.join(dir, name);
    fs.writeFileSync(target, f.fixFile.content);
    written.push(target);
  }
  return written;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(args.error + '\n\n' + USAGE);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let result;
  const mclogs = args.file && /^https?:\/\/(?:www\.)?mclo\.gs\/(\w+)\/?$/.exec(args.file);
  if (mclogs) {
    const res = await fetch('https://api.mclo.gs/1/raw/' + mclogs[1]);
    if (!res.ok) {
      process.stderr.write('Could not download that mclo.gs log (HTTP ' + res.status + ').\n');
      return 2;
    }
    result = analyze(await res.text());
  } else if (args.file && args.file !== '-' && fs.existsSync(args.file) && fs.statSync(args.file).isDirectory()) {
    result = await auditServer(loadDir(path.resolve(args.file)), { ramGb: Math.round(os.totalmem() / 1073741824), target: args.target, checkUpdates: args.checkUpdates });
  } else {
    let text;
    if (args.file && args.file !== '-') {
      if (!fs.existsSync(args.file)) {
        process.stderr.write('File not found: ' + args.file + '\n');
        return 2;
      }
      text = fs.readFileSync(path.resolve(args.file), 'utf8');
    } else if (process.stdin.isTTY) {
      process.stdout.write(USAGE);
      return 2;
    } else {
      text = fs.readFileSync(0, 'utf8');
    }
    result = analyze(text);
  }
  const reportOpts = { contact: args.contact, date: new Date().toISOString().slice(0, 10) };
  if (args.json) process.stdout.write(JSON.stringify(result, (k, v) => (k === 'aikarFlags' ? undefined : v), 2) + '\n');
  else if (args.md) process.stdout.write(toMarkdown(result) + (args.contact ? '\n\n' + args.contact : '') + '\n');
  else process.stdout.write(render(result, painter(args.color), args.verbose) + '\n');
  if (args.html) {
    fs.writeFileSync(args.html, toHtml(result, reportOpts));
    process.stdout.write('\nWrote report to ' + path.resolve(args.html) + '\n');
  }
  if (args.writeFixes) {
    const files = writeFixes(result, args.writeFixes);
    process.stdout.write(files.length ? '\nWrote ' + files.length + ' fixed file(s) to ' + path.resolve(args.writeFixes) + '\n' : '\nNo fixable files found.\n');
  }
  const limit = SEVERITY_ORDER[args.failOn];
  return result.findings.some((f) => SEVERITY_ORDER[f.severity] <= limit) ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 2; });
