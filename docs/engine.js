(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.LogDoctor = factory(root.LogDoctorRules);
})(typeof self !== 'undefined' ? self : this, function (defaultRules) {
  'use strict';

  const SEVERITY_ORDER = { critical: 0, error: 1, warning: 2, info: 3 };
  const MAX_INPUT_CHARS = 40 * 1024 * 1024;
  const MAX_UNHANDLED = 25;
  const MAX_LINE_CHARS = 4000;
  const MAX_EVIDENCE = 3;

  const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|§[0-9a-fk-orx]/gi;
  const PREFIX_RE = /^\s*\[(?:\d{1,2}[A-Za-z]{3}\d{4} )?(\d{1,2}:\d{2}:\d{2})(?:[.,]\d+)?(?: ([A-Z]+))?\]\s*(?:\[([^\]]*?)(?:\/([A-Z]+))?\])?(?:\s*\[[^\]]*\])?:?\s?(.*)$/;
  const ISO_RE = /^\s*\[?\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2}:\d{2})(?:[.,]\d+)?\]?\s*\[?([A-Z]+)\]?:?\s?(.*)$/;

  const TRACE_RE = /^(?:at |\.\.\. \d+ (?:more|common frames omitted)|Suppressed: )/;
  const CAUSE_RE = /^Caused by: (.+)$/;
  const HEAD_RE = /^(?:Exception in thread "[^"]*" )?((?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)[\w$]*)(?::\s?(.*))?$/;
  const FRAME_RE = /^(?:at )?(?:([^\s\/()]+\.jar)\/{1,2})?(?:[\w.$@-]+\/)?([\w.$]+)\.([\w$<>-]+)\((?:[\w$]+\.(?:java|kt|scala)(?::\d+)?|Native Method|Unknown Source)\)(?:.*~?\[([^\]:]*?):[^\]]*\])?/;

  const GENERIC_SEGMENT = /^(lib|libs|mod|mods|model|models|network|util|utils|core|api|common|internal|impl|shaded|client|server|main|minecraft|forge|fabric|data|java|kotlin|gg|net|org|com)$/i;
  const CLIENT_RE = /Setting user:|LWJGL version|Backend library: LWJGL|OpenAL initialized|Using default sound engine|Narrator library/;
  const SERVER_JAR_RE = /^(paper|spigot|purpur|pufferfish|folia|leaf|canvas|craftbukkit|bukkit|server|minecraft|libraries|patched|velocity|waterfall|bungeecord|fabric|forge|neoforge|app|java|jdk|bootstrap|asm|log4j|\?)/i;
  const SERVER_CLASS_RE = /^(java|javax|jdk|sun|com\.sun|net\.minecraft|org\.bukkit|org\.spigotmc|io\.papermc|com\.mojang|org\.apache|io\.netty|com\.google|it\.unimi|ca\.spottedleaf|co\.aikar|com\.destroystokyo|org\.eclipse|org\.sqlite|com\.zaxxer|org\.yaml|org\.slf4j|kotlin|scala|org\.jetbrains|net\.kyori|com\.velocitypowered|net\.md_5|org\.joml|org\.objectweb|org\.xerial|com\.mysql|org\.mariadb|org\.postgresql|oshi|com\.github\.benmanes|org\.checkerframework|org\.spongepowered|net\.fabricmc|net\.minecraftforge|net\.neoforged|cpw\.mods)\./;

  const GENERIC_EXPLAIN = {
    NullPointerException: 'Code tried to use something that was empty (null). This is a bug in the code that threw it, usually triggered by missing data, a removed world, or an outdated plugin.',
    ClassCastException: 'Code treated an object as the wrong type. Usually caused by a plugin built for a different server version, or two plugins fighting over the same data.',
    IllegalStateException: 'Code reached a state it did not expect. Often caused by calling server API from the wrong thread or at the wrong time.',
    IllegalArgumentException: 'Code was given a value it cannot use, such as a bad material name, a missing world, or a typo in a config file.',
    ConcurrentModificationException: 'A list was changed while another piece of code was looping over it. This is a thread safety bug in a plugin.',
    IndexOutOfBoundsException: 'Code asked for an item past the end of a list. A bug in the plugin, or an empty or wrong config section.',
    ArrayIndexOutOfBoundsException: 'Code asked for an item past the end of an array. A bug in the plugin, or an empty or wrong config section.',
    NumberFormatException: 'A text value was read as a number but was not one. Check the plugin config for a typo in a number field.',
    UnsupportedOperationException: 'Code tried to change something read-only. Usually a plugin bug or an API mismatch.',
    SQLException: 'A database call failed. Check the connection settings and that the database is reachable and has the expected tables.',
    IOException: 'A file or network operation failed. Check disk space, permissions, and whether another program has the file open.',
    FileNotFoundException: 'A file the code needed does not exist or cannot be opened.',
    StackOverflowError: 'Code called itself until the stack ran out. A plugin bug, or two plugins triggering each other forever.',
    ArithmeticException: 'Code divided by zero. A bug in the plugin, or a config value that should not be 0.',
    NoSuchElementException: 'Code asked for an element that is not there. Usually an empty list or a missing config entry.',
    InvocationTargetException: 'A plugin called another method by reflection and that method failed. The real problem is in the Caused by line below.',
    ExceptionInInitializerError: 'A class failed while loading its static data. See the Caused by line for the real error.',
    InvalidConfigurationException: 'A config file could not be read. Check it for indentation, tabs, or a missing quote.'
  };

  function parseLine(rawLine, n) {
    const text = rawLine.slice(0, MAX_LINE_CHARS).replace(ANSI_RE, '').replace(/\r$/, '');
    let level = null;
    let msg = text;
    let time = null;
    let m = PREFIX_RE.exec(text);
    if (m) {
      time = m[1];
      level = m[2] || m[4] || null;
      msg = m[5];
    } else if ((m = ISO_RE.exec(text))) {
      time = m[1];
      level = m[2];
      msg = m[3];
    }
    if (level === 'WARNING') level = 'WARN';
    return { n, text, msg: msg.trim(), level, time };
  }

  function cleanPluginName(jar, plugins) {
    const base = jar.replace(/\.jar$/i, '');
    const name = base.replace(/[-_ ]+v?\d[\w.\-+]*$/, '') || base;
    const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const p of plugins) {
      const pf = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (pf && (pf === flat || flat.startsWith(pf))) return p.name;
    }
    return name;
  }

  function guessPluginFromClass(cls, plugins) {
    if (SERVER_CLASS_RE.test(cls + '.')) return null;
    for (const p of plugins) if (p.pkg && cls.startsWith(p.pkg + '.')) return p.name;
    const flatCls = cls.toLowerCase().replace(/[^a-z0-9]/g, '');
    let best = null;
    for (const p of plugins) {
      const pf = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (pf.length >= (p.isMod ? 3 : 4) && flatCls.includes(pf) && (!best || pf.length > best.flat.length)) best = { name: p.name, flat: pf };
    }
    return best ? best.name : null;
  }

  function parseFrame(msg, plugins) {
    const m = FRAME_RE.exec(msg);
    if (!m) return null;
    const cls = m[2];
    let plugin = null;
    if (m[1] && !SERVER_JAR_RE.test(m[1])) {
      plugin = cleanPluginName(m[1], plugins);
    } else if (!m[1] && m[4] && /\.jar$/i.test(m[4]) && !SERVER_JAR_RE.test(m[4])) {
      const name = cleanPluginName(m[4], plugins);
      if (plugins.some((p) => p.name === name)) plugin = name;
    }
    if (!plugin && !m[1]) plugin = guessPluginFromClass(cls, plugins);
    let guess = null;
    if (!plugin && !m[1] && !SERVER_CLASS_RE.test(cls + '.')) {
      const parts = cls.split('.');
      if (parts.length >= 3) guess = parts[Math.min(2, parts.length - 2)];
      if (guess && GENERIC_SEGMENT.test(guess)) guess = null;
    }
    return { cls, method: m[3], plugin, guess };
  }

  function extractInfo(lines) {
    const info = { software: null, mcVersion: null, java: null, os: null, plugins: [], startSeconds: null, modLoader: null, isCrashReport: false, isClient: false };
    const seen = new Set();
    for (const l of lines) {
      const msg = l.msg;
      if (!msg) continue;
      let m;
      if ((m = /^\s*([\w.\-]+\.jar)\s*\|([^|]*)\|([^|]+)\|([^|]*)\|/.exec(l.text))) {
        const id = m[3].trim();
        if (id && !seen.has(id)) {
          seen.add(id);
          info.plugins.push({ name: id, version: m[4].trim(), isMod: true });
        }
        continue;
      }
      if ((m = /\b(?:Enabling|Loading(?: server plugin)?) ([\w.\-]+) v(\d\S*)|Enabled plugin (\S+) version (\S+)|^Loaded plugin (\S+) (\S+) by /.exec(msg))) {
        const name = m[1] || m[3] || m[5];
        const version = m[2] || m[4] || m[6];
        if (name && !seen.has(name)) {
          seen.add(name);
          info.plugins.push({ name, version });
        }
        continue;
      }
      if (!info.software && (m = /This server is running (\w+) version (.+?) \(MC: ([\d.]+)\)/.exec(msg))) {
        info.software = m[1] === 'CraftBukkit' && /Spigot/i.test(m[2]) ? 'Spigot' : m[1];
        info.mcVersion = m[3];
      } else if (!info.software && (m = /This server is running (\w+) version (\d+\.\d+(?:\.\d+)?)/.exec(msg))) {
        info.software = m[1];
        info.mcVersion = m[2];
      } else if (!info.mcVersion && (m = /Starting minecraft server version ([\d.]+)/i.exec(msg))) {
        info.mcVersion = m[1];
      } else if (!info.modLoader && (m = /Loading Minecraft ([\d.]+) with Fabric Loader ([\d.]+)/.exec(msg))) {
        info.modLoader = 'Fabric Loader ' + m[2];
        info.mcVersion = info.mcVersion || m[1];
      } else if (!info.software && (m = /Booting up Velocity ([\w.\-]+)/.exec(msg))) {
        info.software = 'Velocity ' + m[1];
      } else if (!info.software && (m = /Enabled BungeeCord version (\S+)/.exec(msg))) {
        info.software = 'BungeeCord';
      } else if (!info.modLoader && /NeoForge|net\.neoforged/.test(msg)) {
        info.modLoader = 'NeoForge';
      } else if (!info.modLoader && /Forge Mod Loader|minecraftforge/.test(msg)) {
        info.modLoader = 'Forge';
      }
      if (!info.java && (m = /Running Java (\d+)/.exec(msg))) info.java = m[1];
      if (!info.java && (m = /^Java Version: ([\d._]+)/.exec(msg))) info.java = m[1];
      if (!info.os && (m = /^Operating System: (.+)$/.exec(msg))) info.os = m[1];
      if (!info.mcVersion && (m = /^Minecraft Version: ([\d.]+)/.exec(msg))) info.mcVersion = m[1];
      if (m = /Done \(([\d.,]+)s\)!/.exec(msg)) info.startSeconds = parseFloat(m[1].replace(',', '.'));
      if (/---- Minecraft Crash Report ----/.test(msg)) info.isCrashReport = true;
      if (!info.isClient && CLIENT_RE.test(msg)) info.isClient = true;
    }
    return info;
  }

  function findBlocks(lines, plugins) {
    const blocks = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const msg = lines[i].msg;
      if (cur) {
        if (TRACE_RE.test(msg)) {
          const fr = parseFrame(msg, plugins);
          if (fr) cur.causes[cur.causes.length - 1].frames.push(fr);
          cur.end = i;
          continue;
        }
        const c = CAUSE_RE.exec(msg);
        if (c) {
          const h = HEAD_RE.exec(c[1]);
          cur.causes.push({ cls: h ? h[1] : c[1], msg: h && h[2] ? h[2] : '', frames: [] });
          cur.end = i;
          continue;
        }
        cur = null;
      }
      const cause = CAUSE_RE.exec(msg);
      const head = HEAD_RE.exec(cause ? cause[1] : msg);
      if (head) {
        cur = { start: i, end: i, causes: [{ cls: head[1], msg: head[2] || '', frames: [] }], covered: false, plugin: null };
        blocks.push(cur);
      }
    }
    for (const b of blocks) {
      for (let k = b.causes.length - 1; k >= 0 && !b.plugin; k--) {
        const fr = b.causes[k].frames.find((f) => f.plugin);
        if (fr) b.plugin = fr.plugin;
      }
    }
    return blocks;
  }

  function fill(tpl, f) {
    return tpl.replace(/\{(\w+)\}/g, (all, key) => {
      if (/^\d+$/.test(key)) return f.m && f.m[+key] !== undefined ? f.m[+key] : '';
      if (key === 'plugin') return f.plugin || 'a plugin';
      if (key === 'count') return String(f.count);
      if (f.vars && f.vars[key] !== undefined) return String(f.vars[key]);
      return all;
    });
  }

  function resolve(value, f) {
    if (typeof value === 'function') return resolve(value(f), f);
    if (Array.isArray(value)) return value.map((v) => resolve(v, f)).filter(Boolean);
    if (typeof value === 'string') return fill(value, f);
    return value;
  }

  function asList(value) {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
  }

  function shortLine(text) {
    const t = text.trim();
    return t.length > 280 ? t.slice(0, 277) + '...' : t;
  }

  function analyze(input, options) {
    const opts = options || {};
    const rules = opts.rules || defaultRules;
    const text = String(input || '').slice(0, MAX_INPUT_CHARS);
    const lines = text.split('\n').map((l, i) => parseLine(l, i + 1));
    let lastTime = null;
    for (const l of lines) {
      if (l.time) lastTime = l.time;
      else l.time = lastTime;
    }
    const info = extractInfo(lines);
    for (const kp of opts.knownPlugins || []) {
      const have = info.plugins.find((p) => p.name.toLowerCase() === kp.name.toLowerCase());
      if (have) have.pkg = kp.pkg;
      else info.plugins.push({ name: kp.name, version: kp.version || '', pkg: kp.pkg });
    }
    const blocks = findBlocks(lines, info.plugins);

    const blockOf = new Int32Array(lines.length).fill(-1);
    const blockStart = new Map();
    blocks.forEach((b, idx) => {
      for (let i = b.start; i <= b.end; i++) blockOf[i] = idx;
      blockStart.set(b.start, idx);
    });
    const blockNear = (i) => {
      if (blockOf[i] >= 0) return blocks[blockOf[i]];
      for (let k = 1; k <= 3; k++) if (blockStart.has(i + k)) return blocks[blockStart.get(i + k)];
      return null;
    };

    const grep = (re) => {
      for (const l of lines) {
        const m = re.exec(l.msg);
        if (m) return m;
      }
      return null;
    };

    const scanPlugin = (from, count, allowGuess) => {
      let guess = null;
      for (let k = from + 1; k <= from + count && k < lines.length; k++) {
        const fr = parseFrame(lines[k].msg, info.plugins);
        if (fr && fr.plugin) return fr.plugin;
        if (fr && fr.guess && !guess) guess = fr.guess;
      }
      return allowGuess ? guess : null;
    };

    const hitApi = (m, i) => ({
      m,
      i,
      line: lines[i],
      after(n) {
        const out = [];
        for (let k = i + 1; k < lines.length && out.length < n; k++) if (lines[k].msg) out.push(lines[k].msg);
        return out;
      },
      near(re, before, forward) {
        for (let k = i - 1; k >= 0 && k >= i - before; k--) {
          const mm = re.exec(lines[k].msg);
          if (mm) return mm;
        }
        for (let k = i + 1; k < lines.length && k <= i + (forward || 0); k++) {
          const mm = re.exec(lines[k].msg);
          if (mm) return mm;
        }
        return null;
      },
      scanPlugin(n, allowGuess) {
        return scanPlugin(i, n, allowGuess);
      }
    });

    const findings = [];
    for (const rule of rules) {
      if (rule.match) {
        const groups = new Map();
        for (let i = 0; i < lines.length; i++) {
          const msg = lines[i].msg;
          if (!msg) continue;
          const m = rule.match.exec(msg);
          if (!m) continue;
          const hit = hitApi(m, i);
          if (rule.filter && !rule.filter(hit, { info, grep })) continue;
          const key = rule.key ? rule.key(m) : '';
          if (!groups.has(key)) groups.set(key, []);
          const bucket = groups.get(key);
          const prev = bucket[bucket.length - 1];
          const near = blockNear(i);
          if (near && rule.covers !== false) near.covered = true;
          if (rule.mergeWithin && prev && i - prev.i <= rule.mergeWithin) continue;
          bucket.push(hit);
        }
        for (const hits of groups.values()) {
          const first = hits[0];
          const block = blockNear(first.i);
          if (block && rule.covers !== false) block.covered = true;
          for (const h of hits) {
            const b = blockNear(h.i);
            if (b && rule.covers !== false) b.covered = true;
          }
          const f = {
            m: first.m,
            all: hits.map((h) => h.m),
            hits,
            count: hits.length,
            info,
            plugins: info.plugins,
            grep,
            after: first.after,
            near: first.near,
            scanPlugin: first.scanPlugin,
            plugin: null,
            vars: null
          };
          f.plugin = (rule.plugin && rule.plugin(f)) || (block && block.plugin) || null;
          f.vars = rule.vars ? rule.vars(f) : {};
          const severity = typeof rule.severity === 'function' ? rule.severity(f) : rule.severity;
          const evidence = [];
          for (const h of hits.slice(0, MAX_EVIDENCE)) evidence.push({ line: h.line.n, text: shortLine(h.line.text) });
          if (rule.context) {
            let shown = first.line.n;
            for (let k = first.i + 1; k < lines.length && shown < first.line.n + rule.context + 1; k++) {
              shown++;
              if (lines[k].msg && !evidence.some((e) => e.line === lines[k].n)) evidence.push({ line: lines[k].n, text: shortLine(lines[k].text) });
            }
          }
          findings.push({
            replaces: rule.replaces || [],
            id: rule.id,
            severity,
            title: resolve(rule.title, f),
            summary: resolve(rule.explain, f) || '',
            fix: asList(resolve(rule.fix, f)),
            plugin: f.plugin,
            count: f.count,
            firstLine: first.line.n,
            lastLine: hits[hits.length - 1].line.n,
            time: first.line.time,
            dep: f.vars && f.vars.dep ? f.vars.dep : null,
            evidence
          });
        }
      } else if (rule.check) {
        const res = rule.check({ info, plugins: info.plugins, grep });
        if (!res) continue;
        const f = { m: [], count: 1, plugin: res.plugin || null, vars: res.vars || {} };
        findings.push({
          id: rule.id,
          severity: rule.severity,
          title: resolve(res.title || rule.title, f),
          summary: resolve(res.summary, f) || '',
          fix: asList(resolve(res.fix, f)),
          plugin: f.plugin,
          count: 1,
          firstLine: 0,
          lastLine: 0,
          evidence: []
        });
      }
    }

    const groups = new Map();
    for (const b of blocks) {
      if (b.covered) continue;
      const root = b.causes[b.causes.length - 1];
      const key = root.cls + '|' + (b.plugin || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    let unhandled = 0;
    for (const bs of groups.values()) {
      if (unhandled++ >= MAX_UNHANDLED) break;
      const b = bs[0];
      const root = b.causes[b.causes.length - 1];
      const simple = root.cls.split('.').pop();
      const where = b.plugin ? ' in ' + b.plugin : '';
      const base = GENERIC_EXPLAIN[simple] || 'An exception was thrown and nothing handled it.';
      const detail = root.msg ? ' Message: ' + shortLine(root.msg) : '';
      const fix = b.plugin
        ? [
            'Update ' + b.plugin + ' to the newest version for your server version.',
            'If it still happens on the latest version, report it to the author with this stack trace and your server version.',
            'If the error is not hurting anything and does not repeat, you can ignore it.'
          ]
        : [
            'No plugin is named in this trace, so it may come from the server itself, a mod, or a library.',
            'Update your server software, then search the exception name plus your server version.'
          ];
      const evidence = [{ line: lines[b.start].n, text: shortLine(lines[b.start].text) }];
      findings.push({
        id: 'unhandled-exception',
        severity: 'error',
        title: simple + where + (!b.plugin && root.msg ? ': ' + shortLine(root.msg).slice(0, 80) : ''),
        summary: base + detail,
        fix,
        plugin: b.plugin || null,
        count: bs.length,
        firstLine: lines[b.start].n,
        lastLine: lines[bs[bs.length - 1].start].n,
        time: lines[b.start].time,
        evidence
      });
    }

    const replaced = new Set();
    for (const f of findings) for (const id of f.replaces || []) replaced.add(id);
    for (let k = findings.length - 1; k >= 0; k--) {
      if (replaced.has(findings[k].id)) findings.splice(k, 1);
      else delete findings[k].replaces;
    }

    if (info.isClient) {
      findings.push({ id: 'client-log', severity: 'info', title: 'This looks like a game client log', summary: 'LogDoctor is built for server logs. On a client, the class-not-found and mod-loading warnings below are very common and mostly harmless.', fix: ['For a client crash, open the newest file in the crash-reports folder instead of latest.log.'], plugin: null, count: 1, firstLine: 0, lastLine: 0, evidence: [] });
    }

    findings.sort(sortFindings);

    const tally = new Map();
    for (const b of blocks) if (b.plugin) tally.set(b.plugin, (tally.get(b.plugin) || 0) + 1);
    for (const f of findings) if (f.plugin && !blocks.some((b) => b.plugin === f.plugin)) tally.set(f.plugin, (tally.get(f.plugin) || 0) + f.count);
    const culprits = [...tally.entries()].map(([plugin, count]) => ({ plugin, count })).sort((a, b) => b.count - a.count);

    const levels = { errors: 0, warnings: 0 };
    for (const l of lines) {
      if (l.level === 'ERROR' || l.level === 'FATAL' || l.level === 'SEVERE') levels.errors++;
      else if (l.level === 'WARN') levels.warnings++;
    }

    const plan = decorate(findings);
    const planTotal = findings.filter((f) => !f.sideEffectOf && (f.severity === 'critical' || f.severity === 'error')).length;
    const sum = summarize(findings, info);
    return {
      info,
      findings,
      culprits,
      plan,
      planTotal,
      timeline: buildTimeline(lines, findings),
      counts: sum.counts,
      levels,
      lineCount: lines.length,
      verdict: sum.verdict,
      verdictLevel: sum.verdictLevel
    };
  }

  const LOAD_IDS = new Set(['unsupported-api', 'unknown-dependency', 'enable-failed', 'could-not-load', 'invalid-description', 'main-class-missing', 'ambiguous-plugin', 'audit-missing-depend', 'audit-api-too-new', 'audit-wrong-platform', 'audit-no-plugin-yml', 'audit-main-missing', 'audit-java-too-old', 'audit-duplicate-plugin']);
  const SEVERITY_WEIGHT = { critical: 1000, error: 500, warning: 100, info: 0 };

  function sortFindings(a, b) {
    return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count || (a.firstLine || 0) - (b.firstLine || 0);
  }

  // Marks findings that are probably fallout from a plugin that failed to load,
  // then ranks what is left into an ordered fix plan.
  function decorate(findings) {
    const failed = new Map();
    const missingDeps = new Set();
    for (const f of findings) {
      if (LOAD_IDS.has(f.id) && f.plugin) failed.set(f.plugin.toLowerCase(), f);
      if (f.dep) missingDeps.add(f.dep.toLowerCase());
    }
    for (const f of findings) {
      delete f.sideEffectOf;
      if (LOAD_IDS.has(f.id) || f.severity === 'critical' || /^audit-|^yaml|^economy-null/.test(f.id)) continue;
      const owner = f.plugin && failed.get(f.plugin.toLowerCase());
      if (owner && owner !== f && (!f.firstLine || !owner.firstLine || f.firstLine >= owner.firstLine)) f.sideEffectOf = owner.plugin;
      else if (f.id === 'vault-missing' && missingDeps.has('vault')) f.sideEffectOf = 'Vault';
    }
    const effects = (f) => findings.filter((x) => x.sideEffectOf && f.plugin && x.sideEffectOf.toLowerCase() === f.plugin.toLowerCase()).length +
      (f.dep && f.dep.toLowerCase() === 'vault' ? findings.filter((x) => x.sideEffectOf === 'Vault').length : 0);
    const ranked = findings
      .filter((f) => !f.sideEffectOf && (f.severity === 'critical' || f.severity === 'error'))
      .map((f) => {
        const n = effects(f);
        const score = SEVERITY_WEIGHT[f.severity] + n * 200 + Math.min(f.count, 50) * 2 + (LOAD_IDS.has(f.id) ? 150 : 0) - (f.firstLine || 0) / 1e6;
        return { f, n, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return ranked.map(({ f, n }, i) => ({
      step: i + 1,
      id: f.id,
      title: f.plugin && !f.title.toLowerCase().includes(f.plugin.toLowerCase()) ? f.title + ' (' + f.plugin + ')' : f.title,
      plugin: f.plugin || null,
      reason: n ? 'Also explains ' + n + ' other problem' + (n > 1 ? 's' : '') + ' below.' : f.severity === 'critical' ? 'This is stopping the server.' : f.count > 1 ? 'Happens ' + f.count + ' times.' : ''
    }));
  }

  function buildTimeline(lines, findings) {
    const events = [];
    for (const l of lines) {
      let kind = null;
      let text = null;
      if (!events.some((e) => e.kind === 'start') && /Starting minecraft server version|Loading Minecraft [\d.]+ with Fabric|Booting up Velocity/.test(l.msg)) { kind = 'start'; text = 'Server starting'; }
      else if (/Done \(([\d.,]+)s\)!/.test(l.msg)) { kind = 'ready'; text = 'Server ready in ' + /Done \(([\d.,]+)s\)!/.exec(l.msg)[1] + 's'; }
      else if (/^Stopping (?:the )?server|^Closing Server/.test(l.msg)) { kind = 'stop'; text = 'Server stopping'; }
      if (kind) events.push({ line: l.n, time: l.time, kind, severity: 'ok', text });
    }
    for (const f of findings) {
      if (f.severity === 'info' || !f.firstLine || f.sideEffectOf) continue;
      events.push({ line: f.firstLine, time: f.time, kind: 'finding', severity: f.severity, text: f.title + (f.count > 1 ? ' (x' + f.count + ')' : '') });
    }
    if (events.length < 2) return [];
    let kept = events;
    if (kept.length > 14) {
      const keep = new Set(events.filter((e) => e.kind !== 'finding' || e.severity === 'critical' || e.severity === 'error'));
      kept = events.filter((e) => keep.has(e)).slice(0, 14);
    }
    return kept.sort((a, b) => a.line - b.line);
  }

  function summarize(findings, info) {
    const counts = { critical: 0, error: 0, warning: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;
    let verdict = 'No known problems found.';
    let verdictLevel = 'ok';
    if (counts.critical) {
      verdict = (info && info.isCrashReport) || findings.some((f) => /crash|watchdog|failed to start|did not start/i.test(f.title))
        ? 'The server crashed or could not start.'
        : 'Something serious is stopping the server.';
      verdictLevel = 'critical';
    } else if (counts.error) {
      verdict = counts.error === 1 ? 'Found 1 error.' : 'Found ' + counts.error + ' errors.';
      verdictLevel = 'error';
    } else if (counts.warning) {
      verdict = counts.warning === 1 ? 'Found 1 warning.' : 'Found ' + counts.warning + ' warnings.';
      verdictLevel = 'warning';
    } else if (counts.info) {
      verdict = 'Nothing broken, a few notes.';
      verdictLevel = 'info';
    }
    return { counts, verdict, verdictLevel };
  }

  function where(e) {
    return (e.file ? e.file + (e.line ? ':' + e.line : '') : 'line ' + e.line);
  }

  function toMarkdown(result) {
    const out = [];
    const i = result.info;
    out.push('# LogDoctor report', '');
    const bits = [];
    if (i.software) bits.push(i.software);
    if (i.modLoader) bits.push(i.modLoader);
    if (i.mcVersion) bits.push('Minecraft ' + i.mcVersion);
    if (i.java) bits.push('Java ' + i.java);
    if (i.plugins.length) bits.push(i.plugins.length + ' plugins');
    if (bits.length) out.push(bits.join(' | '), '');
    out.push('**' + result.verdict + '**', '');
    if (result.plan && result.plan.length) {
      out.push('Start here' + (result.planTotal > result.plan.length ? ' (' + result.plan.length + ' of ' + result.planTotal + ' problems)' : '') + ':');
      result.plan.forEach((p) => out.push(p.step + '. ' + p.title + (p.reason ? ' (' + p.reason + ')' : '')));
      out.push('');
    }
    if (result.culprits && result.culprits.length) {
      out.push('Plugins named in the errors: ' + result.culprits.slice(0, 5).map((c) => c.plugin + ' (' + c.count + ')').join(', '), '');
    }
    for (const f of result.findings) {
      out.push('## [' + f.severity.toUpperCase() + '] ' + f.title + (f.count > 1 ? ' (x' + f.count + ')' : '') + (f.sideEffectOf ? ' (likely a side effect of ' + f.sideEffectOf + ')' : ''), '');
      if (f.summary) out.push(f.summary, '');
      if (f.fix.length) {
        out.push('How to fix:');
        f.fix.forEach((s) => out.push('- ' + s));
        out.push('');
      }
      if (f.evidence.length) {
        out.push('```');
        f.evidence.forEach((e) => out.push(where(e) + ': ' + e.text));
        out.push('```', '');
      }
    }
    return out.join('\n');
  }

  // Cheap pass that only reads the server, Minecraft and Java versions.
  function quickInfo(text) {
    return extractInfo(String(text || '').slice(0, MAX_INPUT_CHARS).split('\n').map((l, i) => parseLine(l, i + 1)));
  }

  return { analyze, quickInfo, toMarkdown, parseLine, summarize, decorate, sortFindings, where, SEVERITY_ORDER };
});