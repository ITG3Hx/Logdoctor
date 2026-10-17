(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./rules.js'), require('./zip.js'), require('./yaml.js'), require('./compat.js'), require('./updates.js'));
  else root.LogDoctorAudit = factory(root.LogDoctor, root.LogDoctorRules, root.LogDoctorZip, root.LogDoctorYaml, root.LogDoctorCompat, root.LogDoctorUpdates);
})(typeof self !== 'undefined' ? self : this, function (Engine, rules, Zip, Yaml, Compat, Updates) {
  'use strict';

  const TEXT_LIMIT = 8 * 1024 * 1024;
  const LOG_LIMIT = 40 * 1024 * 1024;
  const MAX_CONFIGS = 400;
  const dec = new TextDecoder('utf-8');

  const verParts = (v) => String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
  function cmpVer(a, b) {
    const x = verParts(a);
    const y = verParts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }
  const javaMajor = (v) => {
    if (!v) return null;
    const m = /^1\.(\d+)/.exec(v) || /^(\d+)/.exec(v);
    return m ? +m[1] : null;
  };

  function aikarFlags(mb) {
    const gb = Math.max(1, Math.round(mb / 1024));
    const big = mb >= 12288;
    return [
      '-Xms' + gb + 'G', '-Xmx' + gb + 'G', '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch',
      big ? '-XX:G1NewSizePercent=40' : '-XX:G1NewSizePercent=30',
      big ? '-XX:G1MaxNewSizePercent=50' : '-XX:G1MaxNewSizePercent=40',
      big ? '-XX:G1HeapRegionSize=16M' : '-XX:G1HeapRegionSize=8M',
      big ? '-XX:G1ReservePercent=15' : '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
      big ? '-XX:InitiatingHeapOccupancyPercent=20' : '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
      '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true'
    ];
  }

  function normalize(list) {
    const items = list.map((f) => ({ f, p: f.path.replace(/\\/g, '/').replace(/^\.?\//, '') }));
    let prefix = '';
    let addPlugins = false;
    const sp = items.find((x) => /(^|\/)server\.properties$/i.test(x.p));
    if (sp) prefix = sp.p.replace(/server\.properties$/i, '');
    else {
      const pj = items.find((x) => /(^|\/)plugins\/[^\/]+\.jar$/i.test(x.p));
      if (pj) prefix = pj.p.replace(/plugins\/[^\/]+\.jar$/i, '');
      else {
        const j = items.find((x) => /\.jar$/i.test(x.p));
        if (j) {
          prefix = j.p.replace(/[^\/]*$/, '');
          addPlugins = true;
        }
      }
    }
    const out = [];
    for (const x of items) {
      if (!x.p.startsWith(prefix)) continue;
      const rel = x.p.slice(prefix.length);
      out.push({ path: (addPlugins ? 'plugins/' : '') + rel, size: x.f.size, read: x.f.read });
    }
    return out;
  }

  function pluginOfPath(p) {
    const m = /^plugins\/([^\/]+)\//i.exec(p);
    return m ? m[1] : null;
  }

  async function auditServer(input, opts) {
    const options = opts || {};
    const files = normalize(input);
    const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
    const has = (p) => byPath.has(p.toLowerCase());
    const readBytes = async (p, limit) => {
      const f = byPath.get(p.toLowerCase());
      if (!f || f.size > (limit || TEXT_LIMIT)) return null;
      try { return await f.read(); } catch (e) { return null; }
    };
    const readText = async (p, limit) => {
      const b = await readBytes(p, limit);
      return b ? dec.decode(b).replace(/^\uFEFF/, '') : null;
    };

    const findings = [];
    const add = (o) => findings.push(Object.assign({ count: 1, firstLine: 0, lastLine: 0, evidence: [], fix: [], plugin: null, summary: '', source: 'audit' }, o));

    // Logs
    // Only the versions are read now. The full log analysis runs after the jars are read,
    // so that stack frames can be matched to plugins by their package.
    let logResult = null;
    let crashResult = null;
    const logText = await readText('logs/latest.log', LOG_LIMIT);
    const logQuick = logText ? Engine.quickInfo(logText) : null;
    const crashes = files.map((f) => f.path).filter((p) => /^crash-reports\/crash-.*\.txt$/i.test(p)).sort();
    let crashText = null;
    let crashQuick = null;
    if (crashes.length) {
      crashText = await readText(crashes[crashes.length - 1]);
      if (crashText) crashQuick = Engine.quickInfo(crashText);
    }
    let mc = (logQuick && logQuick.mcVersion) || (crashQuick && crashQuick.mcVersion) || null;
    let software = (logQuick && logQuick.software) || null;
    const vh = await readText('version_history.json');
    if (vh) {
      const m = /MC: ([\d.]+)/.exec(vh);
      if (m && !mc) mc = m[1];
      if (!software && /Paper/i.test(vh)) software = 'Paper';
    }
    const javaVer = (logQuick && logQuick.java) || (crashQuick && crashQuick.java) || null;
    const jMajor = javaMajor(javaVer);

    // Plugins
    const jars = files.filter((f) => /^plugins\/[^\/]+\.jar$/i.test(f.path));
    const plugins = [];
    let done = 0;
    for (const jar of jars) {
      if (options.onProgress) options.onProgress(++done, jars.length);
      let bytes = null;
      try { bytes = await jar.read(); } catch (e) { bytes = null; }
      const entries = bytes ? Zip.listEntries(bytes) : null;
      if (!entries) {
        add({ id: 'audit-bad-jar', severity: 'error', title: jar.path.slice(8) + ' is not a valid jar', summary: 'The file cannot be opened as a jar. The download was probably cut off or it is not a jar at all.', fix: ['Download ' + jar.path.slice(8) + ' again and replace it.'], evidence: [{ file: jar.path, text: (bytes ? bytes.length : 0) + ' bytes' }] });
        continue;
      }
      const names = new Set(entries.map((e) => e.name));
      const ymlEntry = entries.find((e) => e.name === 'paper-plugin.yml') && !names.has('plugin.yml') ? entries.find((e) => e.name === 'paper-plugin.yml') : entries.find((e) => e.name === 'plugin.yml');
      if (!ymlEntry) {
        let platform = null;
        if (names.has('fabric.mod.json')) platform = ['a Fabric mod', 'Move it to the mods folder of a Fabric server, or find the Bukkit/Paper plugin version of it.'];
        else if (names.has('META-INF/mods.toml') || names.has('META-INF/neoforge.mods.toml')) platform = ['a Forge or NeoForge mod', 'Move it to the mods folder of a Forge/NeoForge server, or find the Paper plugin version.'];
        else if (names.has('velocity-plugin.json')) platform = ['a Velocity proxy plugin', 'Put it in the plugins folder of your Velocity proxy, not the backend server.'];
        else if (names.has('bungee.yml')) platform = ['a BungeeCord proxy plugin', 'Put it in the plugins folder of your BungeeCord proxy, not the backend server.'];
        else if (names.has('META-INF/sponge_plugins.json')) platform = ['a Sponge plugin', 'Sponge plugins do not run on Paper. Find the Paper version.'];
        if (platform) add({ id: 'audit-wrong-platform', severity: 'error', title: jar.path.slice(8) + ' is ' + platform[0], summary: 'It does not belong in a Paper/Spigot plugins folder and will be skipped or fail to load.', fix: [platform[1]], plugin: jar.path.slice(8).replace(/\.jar$/i, ''), evidence: [{ file: jar.path, text: platform[0] }] });
        else add({ id: 'audit-no-plugin-yml', severity: 'warning', title: jar.path.slice(8) + ' has no plugin.yml', summary: 'Nothing in this jar tells the server how to load it. If it is a library, it does not belong in plugins.', fix: ['Remove it from plugins/ unless a plugin asked you to install it there.'], evidence: [{ file: jar.path, text: entries.length + ' files inside' }] });
        continue;
      }
      let meta = {};
      try { meta = Yaml.parsePluginYml(dec.decode(await Zip.readEntry(bytes, ymlEntry, 1024 * 1024))); } catch (e) { meta = {}; }
      if (!meta.name) {
        add({ id: 'audit-no-plugin-yml', severity: 'error', title: jar.path.slice(8) + ' has an unreadable ' + ymlEntry.name, summary: 'The plugin descriptor has no name, so the server cannot load it.', fix: ['Download the plugin again.'], evidence: [{ file: jar.path, text: ymlEntry.name }] });
        continue;
      }
      const mainClass = meta.main && typeof meta.main === 'string' ? meta.main : null;
      const p = {
        pkg: mainClass && mainClass.includes('.') ? mainClass.slice(0, mainClass.lastIndexOf('.')).split('.').slice(0, 3).join('.') : null,
        name: String(meta.name),
        version: meta.version ? String(meta.version) : '',
        file: jar.path,
        api: meta['api-version'] ? String(meta['api-version']) : null,
        depend: [].concat(meta.depend || []),
        soft: [].concat(meta.softdepend || []),
        provides: [].concat(meta.provides || []),
        sha1: options.checkUpdates && Updates ? await Updates.sha1Hex(bytes) : null,
        javaNeeded: null
      };
      plugins.push(p);
      const main = meta.main && typeof meta.main === 'string' ? meta.main : null;
      if (main) {
        const cls = main.replace(/\./g, '/') + '.class';
        const ce = entries.find((e) => e.name === cls);
        if (!ce) {
          add({ id: 'audit-main-missing', severity: 'error', title: p.name + ' is missing its main class', summary: 'plugin.yml says the main class is ' + main + ' but it is not inside the jar. The download is broken or the jar was edited.', fix: ['Download ' + p.name + ' again.'], plugin: p.name, evidence: [{ file: jar.path, text: 'main: ' + main }] });
        } else {
          try {
            const cb = await Zip.readEntry(bytes, ce);
            const need = ((cb[6] << 8) | cb[7]) - 44;
            p.javaNeeded = need;
            if (jMajor && need > jMajor) add({ id: 'audit-java-too-old', severity: 'error', title: p.name + ' needs Java ' + need, summary: p.name + ' ' + p.version + ' was built for Java ' + need + ', but your log shows Java ' + javaVer + '. It will fail to load.', fix: ['Run the server on Java ' + need + ' or newer.', 'Or use an older release of ' + p.name + ' built for Java ' + jMajor + '.'], plugin: p.name, evidence: [{ file: jar.path, text: main + ' is class version ' + (need + 44) }] });
          } catch (e) { /* unreadable class, skip */ }
        }
      }
    }

    const nameSet = new Set();
    for (const p of plugins) { nameSet.add(p.name.toLowerCase()); p.provides.forEach((x) => nameSet.add(String(x).toLowerCase())); }

    const byName = new Map();
    for (const p of plugins) {
      const k = p.name.toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(p);
    }
    for (const list of byName.values()) {
      if (list.length > 1) add({ id: 'audit-duplicate-plugin', severity: 'error', title: list[0].name + ' is installed twice', summary: 'Two jars both declare the plugin ' + list[0].name + '. Only one can load, and the other causes load errors.', fix: ['Delete the older copy and keep only one.'], plugin: list[0].name, evidence: list.map((p) => ({ file: p.file, text: p.name + ' ' + p.version })) });
    }

    for (const p of plugins) {
      for (const d of p.depend) {
        if (!nameSet.has(String(d).toLowerCase())) {
          add({ id: 'audit-missing-depend', severity: 'error', title: p.name + ' needs ' + d, dep: d, summary: p.name + ' requires the plugin ' + d + ' but it is not in the plugins folder, so ' + p.name + ' will not load.', fix: ['Install ' + d + ' (a version for your server), then restart.'], plugin: p.name, evidence: [{ file: p.file, text: 'depend: ' + d }] });
        }
      }
    }

    if (mc) {
      const mm = verParts(mc).slice(0, 2).join('.');
      const tooNew = plugins.filter((p) => p.api && cmpVer(p.api, mm) > 0);
      for (const p of tooNew) add({ id: 'audit-api-too-new', severity: 'error', title: p.name + ' is made for Minecraft ' + p.api, summary: p.name + ' ' + p.version + ' declares api-version ' + p.api + ', but your server is on ' + mc + '. The server refuses to load it.', fix: ['Use an older release of ' + p.name + ' that supports ' + mc + ', or update the server to ' + p.api + '.'], plugin: p.name, evidence: [{ file: p.file, text: 'api-version: ' + p.api }] });
      if (cmpVer(mm, '1.13') >= 0) {
        const legacy = plugins.filter((p) => !p.api);
        if (legacy.length) add({ id: 'audit-legacy-plugins', severity: 'warning', count: legacy.length, title: legacy.length + ' plugin' + (legacy.length > 1 ? 's' : '') + ' without api-version', summary: legacy.map((p) => p.name).join(', ') + ' do not declare an api-version. The server turns on a slow compatibility mode for all of them, and blocks can behave oddly.', fix: ['Update them, or replace them with maintained plugins.'], evidence: legacy.map((p) => ({ file: p.file, text: p.name + ' ' + p.version })) });
      }
    }

    for (const rule of rules) {
      if (!rule.check) continue;
      const res = rule.check({ info: { plugins }, plugins, grep: () => null });
      if (res) add({ id: rule.id, severity: rule.severity, title: res.title || rule.title, summary: res.summary || '', fix: res.fix || [], plugin: res.plugin || null });
    }

    let updates = null;
    if (options.checkUpdates && Updates) {
      try {
        updates = await Updates.checkUpdates(plugins.map((p) => ({ name: p.name, sha1: p.sha1 })), { mc, fetch: options.fetch });
        const old = updates.rows.filter((r) => r.status === 'outdated');
        if (old.length) add({ id: 'audit-outdated-plugin', severity: 'warning', count: old.length, title: old.length + (old.length > 1 ? ' plugins have updates' : ' plugin has an update'), summary: old.map((r) => r.name + ' ' + r.current + ' to ' + r.latest).join(', ') + '.', fix: ['Update them one at a time and restart in between, so you can tell which update broke something.'].concat(old.slice(0, 8).map((r) => r.name + ': ' + r.url)) });
        add({ id: 'audit-updates-coverage', severity: 'info', title: 'Update check covered ' + updates.found + ' of ' + plugins.length + ' plugins', summary: 'Only plugins published on Modrinth can be matched. The other ' + (plugins.length - updates.found) + ' (Spigot-only, paid, or custom) were not checked.', fix: [] });
      } catch (e) {
        add({ id: 'audit-updates-failed', severity: 'info', title: 'Could not check for plugin updates', summary: 'Modrinth could not be reached (' + (e && e.message ? e.message : e) + '). Nothing was sent or changed.', fix: ['Check your internet connection and run it again.'] });
      }
    }

    // Config files
    const cfgPaths = files.map((f) => f.path).filter((p) => /\.ya?ml$/i.test(p) && (/^plugins\/.+/i.test(p) ? p.split('/').length <= 5 : /^(bukkit|spigot|commands|help|permissions)\.yml$/i.test(p) || /^config\/[^\/]+\.yml$/i.test(p))).slice(0, MAX_CONFIGS);
    const cfg = {};
    for (const path of cfgPaths) {
      const text = await readText(path, 2 * 1024 * 1024);
      if (text === null) continue;
      if (/^(spigot|bukkit)\.yml$/i.test(path) || /^config\/paper-global\.yml$/i.test(path)) cfg[path.toLowerCase()] = text;
      const issues = Yaml.lint(text);
      if (!issues.length) continue;
      const lines = text.split(/\r?\n/);
      const hard = issues.some((i) => i.kind === 'tab' || i.kind === 'duplicate' || i.kind === 'apostrophe');
      const fixed = Yaml.autofix(text);
      const plugin = pluginOfPath(path);
      add({
        id: 'audit-yaml',
        severity: hard ? 'error' : 'warning',
        count: issues.length,
        title: 'Config problem in ' + path,
        summary: issues.slice(0, 4).map((i) => 'Line ' + i.line + ': ' + i.message).join(' ') + (issues.length > 4 ? ' (' + (issues.length - 4) + ' more)' : ''),
        fix: ['Fix the listed lines. ' + issues[0].fix].concat(fixed ? ['A corrected copy is available to download below.'] : ['Paste the file into yamllint.com to double check it.']),
        plugin,
        evidence: issues.slice(0, 4).map((i) => ({ file: path, line: i.line, text: (lines[i.line - 1] || '').replace(/\t/g, '<TAB>').trim().slice(0, 200) })),
        fixFile: fixed ? { name: path.split('/').pop(), path, content: fixed } : null
      });
    }

    // server.properties and proxy settings
    const props = {};
    const propsText = await readText('server.properties');
    if (propsText) {
      propsText.split(/\r?\n/).forEach((l, idx) => {
        const m = /^\s*([\w.\-]+)\s*=\s*(.*)$/.exec(l);
        if (m) props[m[1]] = { v: m[2].trim(), line: idx + 1 };
      });
    }
    const spigot = cfg['spigot.yml'] || '';
    const paperGlobal = cfg['config/paper-global.yml'] || '';
    const bungee = /^\s*bungeecord:\s*true/m.test(spigot);
    const velocity = /velocity:[\s\S]{0,120}?enabled:\s*true/.test(paperGlobal);
    const proxied = bungee || velocity;
    if (propsText) {
      const ev = (k) => [{ file: 'server.properties', line: props[k].line, text: k + '=' + props[k].v }];
      if (props['online-mode'] && props['online-mode'].v === 'false' && !proxied) add({ id: 'audit-offline-mode', severity: 'warning', title: 'online-mode is off and no proxy is set up', summary: 'Anyone can join with any username, including an admin\'s. This is only safe behind a BungeeCord or Velocity proxy that checks logins.', fix: ['Set online-mode=true in server.properties.', 'If you really need cracked players, add a login plugin such as AuthMe and protect your ops.'], evidence: ev('online-mode') });
      if (proxied && props['online-mode'] && props['online-mode'].v === 'true' && bungee) add({ id: 'audit-bungee-online', severity: 'warning', title: 'BungeeCord mode with online-mode=true', summary: 'With BungeeCord forwarding on, the backend must have online-mode=false, otherwise players cannot log in.', fix: ['Set online-mode=false on the backend and firewall its port so only the proxy can connect.'], evidence: ev('online-mode') });
      if (velocity && /secret:\s*(''|"")?\s*$/m.test(paperGlobal)) add({ id: 'audit-velocity-secret', severity: 'error', title: 'Velocity forwarding has no secret', summary: 'Velocity support is on but the secret is empty, so the backend rejects every player.', fix: ['Copy the secret from forwarding.secret on the proxy into paper-global.yml under proxies.velocity.secret.'], evidence: [{ file: 'config/paper-global.yml', text: 'velocity: enabled: true, secret empty' }] });
      if (props['server-ip'] && props['server-ip'].v && props['server-ip'].v !== '0.0.0.0') add({ id: 'audit-server-ip', severity: 'warning', title: 'server-ip is set', summary: 'server-ip is "' + props['server-ip'].v + '". If it is not an address that belongs to this machine the server cannot bind its port, and on hosts it usually breaks the connection.', fix: ['Leave server-ip empty unless you know you need it.'], evidence: ev('server-ip') });
      if (props['view-distance'] && +props['view-distance'].v > 12) add({ id: 'audit-view-distance', severity: 'warning', title: 'view-distance is ' + props['view-distance'].v, summary: 'High view distance multiplies the chunks the server must keep and send, and is a common cause of lag on busy servers.', fix: ['Try view-distance=10 and simulation-distance=8 first. Raise it only if the server has CPU to spare.'], evidence: ev('view-distance') });
      if (props['enable-rcon'] && props['enable-rcon'].v === 'true' && props['rcon.password'] && props['rcon.password'].v.length < 8) add({ id: 'audit-rcon', severity: 'warning', title: 'RCON is on with a weak password', summary: 'RCON gives full console access. A short password can be guessed.', fix: ['Use a long random rcon.password, or set enable-rcon=false.'], evidence: ev('enable-rcon') });
    }
    const eula = await readText('eula.txt', 4096);
    if (eula && /^\s*eula\s*=\s*false/mi.test(eula)) add({ id: 'audit-eula', severity: 'critical', title: 'EULA is not accepted', summary: 'eula.txt says eula=false, so the server will stop right after starting.', fix: ['Open eula.txt and change eula=false to eula=true.'], evidence: [{ file: 'eula.txt', text: 'eula=false' }] });

    // Start script
    const scripts = files.filter((f) => /^[^\/]+\.(bat|cmd|sh)$/i.test(f.path) && f.size < 65536);
    for (const s of scripts) {
      const text = await readText(s.path, 65536);
      if (!text) continue;
      const line = text.replace(/[\\^]\r?\n\s*/g, ' ').split(/\r?\n/).find((l) => /\bjava(?:w)?(?:\.exe)?["']?\s/i.test(l) && /-jar\b/.test(l));
      if (!line) continue;
      const jarM = /-jar\s+("[^"]+"|'[^']+'|\S+)/.exec(line);
      const jar = jarM ? jarM[1].replace(/^["']|["']$/g, '') : null;
      const ev = [{ file: s.path, text: line.trim().slice(0, 240) }];
      const rootJars = files.filter((f) => /^[^\/]+\.jar$/i.test(f.path)).map((f) => f.path);
      if (jar && !/[%$]/.test(jar) && !has(jar)) {
        add({ id: 'audit-start-jar-missing', severity: 'critical', title: s.path + ' starts a jar that does not exist', summary: 'The script runs "' + jar + '" but that file is not in the server folder, so the server cannot start.', fix: rootJars.length ? ['Change the jar name in ' + s.path + ' to one of: ' + rootJars.join(', ') + '.'] : ['Download your server jar into this folder and use its exact name in ' + s.path + '.'], evidence: ev });
      }
      const xmx = /-Xmx(\d+)([MmGg])/.exec(line);
      const xms = /-Xms(\d+)([MmGg])/.exec(line);
      const mb = (m) => (m ? +m[1] * (/g/i.test(m[2]) ? 1024 : 1) : null);
      const heap = mb(xmx);
      if (heap && heap < 2048) add({ id: 'audit-low-ram', severity: 'warning', title: 'Only ' + heap + ' MB of RAM for the server', summary: 'A modern server with plugins needs at least 2 to 4 GB. Low memory causes constant garbage collection lag and out of memory crashes.', fix: ['Raise -Xmx to 4G or more if the machine has the RAM.'], evidence: ev });
      if (xms && xmx && mb(xms) !== mb(xmx)) add({ id: 'audit-xms-xmx', severity: 'info', title: '-Xms and -Xmx differ', summary: 'Letting the heap resize causes extra pauses. Servers run smoother with both set to the same value.', fix: ['Set -Xms equal to -Xmx.'], evidence: ev });
      const oldGc = /-XX:\+?(UseConcMarkSweepGC|UseParNewGC|CMSIncrementalMode|CMSIncrementalPacing|CMSClassUnloadingEnabled)|-XX:(?:Max)?PermSize/.exec(line);
      if (oldGc) add({ id: 'audit-old-gc-flags', severity: jMajor && jMajor >= 14 ? 'error' : 'warning', title: 'Start script uses removed Java flags', summary: oldGc[0] + ' was removed in newer Java versions (14 and up). Java refuses to start with it.', fix: ['Remove those flags and use the recommended command below.'], evidence: ev });
      if (!/UseG1GC|UseZGC|UseShenandoahGC|UseParallelGC/.test(line) && !/velocity|waterfall|bungee/i.test(jar || '')) {
        const use = heap || 4096;
        const flags = aikarFlags(use).join(' ');
        const isSh = /\.sh$/i.test(s.path);
        const cmd = 'java ' + flags + ' -jar ' + (jar || 'server.jar') + ' nogui';
        const content = isSh ? '#!/bin/sh\n' + cmd + '\n' : '@echo off\r\n' + cmd + '\r\npause\r\n';
        add({ id: 'audit-no-gc-flags', severity: 'info', title: 'Start script has no tuned Java flags', summary: 'The widely used Aikar flags reduce lag spikes from garbage collection. ' + (heap ? 'They are set here for your ' + Math.round(use / 1024) + ' GB.' : 'No -Xmx was found, so 4 GB is assumed.'), fix: ['Replace the java line in ' + s.path + ' with the recommended command, or download the finished script below.'], evidence: ev, fixFile: { name: 'start-recommended' + (isSh ? '.sh' : '.bat'), path: s.path, content } });
      }
      break;
    }

    // Analyze logs now that the plugins are known
    const knownPlugins = plugins.filter((p) => p.pkg).map((p) => ({ name: p.name, version: p.version, pkg: p.pkg }));
    if (logText) logResult = Engine.analyze(logText, { knownPlugins });
    if (crashText) crashResult = { name: crashes[crashes.length - 1], result: Engine.analyze(crashText, { knownPlugins }) };

    // Merge log findings
    const sameDep = (f) => findings.some((x) => x.id === 'audit-missing-depend' && f.dep && x.dep && x.dep.toLowerCase() === f.dep.toLowerCase());
    const samePlugin = (id, f) => findings.some((x) => x.id === id && f.plugin && x.plugin && x.plugin.toLowerCase() === f.plugin.toLowerCase());
    const duplicatesAudit = (f) =>
      (f.id === 'unknown-dependency' && sameDep(f)) ||
      (f.id === 'unsupported-api' && samePlugin('audit-api-too-new', f)) ||
      (/^yaml-/.test(f.id) && findings.some((x) => x.id === 'audit-yaml')) ||
      ((f.id === 'legacy-plugin' || f.id === 'legacy-material') && findings.some((x) => x.id === 'audit-legacy-plugins')) ||
      ((f.id === 'plugin-conflict-check' || f.id === 'abandoned-plugin-check') && findings.some((x) => x.id === f.id)) ||
      (f.id === 'offline-mode' && findings.some((x) => x.id === 'audit-offline-mode'));
    const takeFindings = (res, source, file) => {
      for (const f of res.findings) {
        if (duplicatesAudit(f)) continue;
        const copy = Object.assign({}, f, { source });
        copy.evidence = f.evidence.map((e) => Object.assign({ file }, e));
        findings.push(copy);
      }
    };
    if (logResult) takeFindings(logResult, 'log', 'logs/latest.log');
    if (crashResult) takeFindings(crashResult.result, 'crash', crashResult.name);

    const pluginDetails = plugins.map((p) => ({ name: p.name, version: p.version, api: p.api, javaNeeded: p.javaNeeded, file: p.file }));
    let compat = null;
    if (options.target && Compat) {
      compat = Compat.compatReport(pluginDetails, options.target);
      const bad = compat.rows.filter((r) => r.status === 'broken');
      const risky = compat.rows.filter((r) => r.status === 'risky' || r.status === 'check');
      if (bad.length || risky.length) {
        add({
          id: 'audit-upgrade-risk',
          severity: bad.length ? 'error' : 'warning',
          count: bad.length + risky.length,
          title: 'Upgrading to ' + options.target + ': ' + (bad.length ? bad.length + ' plugin' + (bad.length > 1 ? 's' : '') + ' will not load' : risky.length + ' plugin' + (risky.length > 1 ? 's' : '') + ' need a look'),
          summary: bad.concat(risky).slice(0, 6).map((r) => r.name + ' (' + r.reason + ')').join(' '),
          fix: ['Update or replace those plugins first, then upgrade on a copy of the server and read the log.', 'Java ' + compat.java + ' is required for ' + options.target + '.']
        });
      }
    }

    findings.sort(Engine.sortFindings);    const plan = Engine.decorate(findings);
    const sum = Engine.summarize(findings, { isCrashReport: !!crashResult });
    const baseInfo = (logResult && logResult.info) || (crashResult && crashResult.result.info) || { plugins: [] };
    const info = Object.assign({}, baseInfo, { mcVersion: mc, software: software || baseInfo.software, plugins: plugins.map((p) => ({ name: p.name, version: p.version })) });
    const culprits = (logResult && logResult.culprits) || [];
    return {
      audit: true,
      info,
      findings,
      culprits,
      plan,
      planTotal: findings.filter((f) => !f.sideEffectOf && (f.severity === 'critical' || f.severity === 'error')).length,
      timeline: logResult ? logResult.timeline : [],
      counts: sum.counts,
      verdict: sum.verdict,
      verdictLevel: sum.verdictLevel,
      lineCount: logResult ? logResult.lineCount : 0,
      scanned: { files: files.length, plugins: plugins.length, configs: cfgPaths.length, log: !!logResult, crash: crashResult ? crashResult.name : null },
      pluginDetails,
      compat,
      updates,
      aikarFlags
    };
  }

  return { auditServer, aikarFlags, normalize };
});