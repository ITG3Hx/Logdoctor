(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogDoctorRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A rule is a plain object. See CONTRIBUTING.md for the full field list.
  //
  //   id        unique slug
  //   severity  'critical' | 'error' | 'warning' | 'info' (or a function of the finding)
  //   title     short headline (string with {1} {plugin} {count} placeholders, or a function)
  //   match     regex tested against every log line (no g flag). Captures are {1}, {2}, ...
  //   key       optional: group hits by this value so each one gets its own finding
  //   filter    optional: (hit, ctx) => boolean, drop hits that do not qualify
  //   plugin    optional: (finding) => plugin name this problem belongs to
  //   vars      optional: (finding) => extra placeholders
  //   explain   what it means, in plain words
  //   fix       list of steps
  //   context   optional: also show this many lines after the first hit
  //   check     alternative to match: (ctx) => null | { title, summary, fix, plugin } for plugin-list rules

  const JAVA_BY_CLASS = { 52: 8, 53: 9, 54: 10, 55: 11, 56: 12, 57: 13, 58: 14, 59: 15, 60: 16, 61: 17, 62: 18, 63: 19, 64: 20, 65: 21, 66: 22, 67: 23, 68: 24, 69: 25 };
  const javaFor = (cls) => JAVA_BY_CLASS[cls] || 'a newer version of Java';

  const jarName = (s) => (s || '').replace(/\.jar$/i, '').replace(/[-_ ]+v?\d[\w.\-+]*$/, '') || s;

  const nums = (line) => (String(line || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);

  const pathPlugin = (text) => {
    const m = /plugins[\/\\]([^\/\\'"]+?)(?:\.jar|[\/\\])/i.exec(text || '');
    return m ? m[1] : null;
  };

  const MISSING_CLASS_HINTS = [
    [/^net[./]milkbowl[./]vault/i, 'Vault', 'Install Vault, plus an economy plugin such as EssentialsX.'],
    [/^me[./]clip[./]placeholderapi/i, 'PlaceholderAPI', 'Install PlaceholderAPI.'],
    [/^com[./]comphenix[./]protocol/i, 'ProtocolLib', 'Install ProtocolLib, using a build that supports your server version.'],
    [/^(?:net[./]luckperms|me[./]lucko[./]luckperms)/i, 'LuckPerms', 'Install LuckPerms.'],
    [/^com[./]sk89q[./]worldedit/i, 'WorldEdit', 'Install WorldEdit (or FastAsyncWorldEdit).'],
    [/^com[./]sk89q[./]worldguard/i, 'WorldGuard', 'Install WorldGuard.'],
    [/^kotlin[./]/i, 'Kotlin', 'The plugin needs the Kotlin runtime. Update it, or install a Kotlin library plugin if its page asks for one.'],
    [/^(?:io[./]papermc|com[./]destroystokyo[./]paper)/i, 'Paper', 'This plugin needs Paper (or a Paper fork). You are probably running Spigot or CraftBukkit.'],
    [/^org[./]bukkit[./]craftbukkit[./]v\d/i, 'version', 'The plugin uses server internals tied to one Minecraft version. Get a build made for your version.'],
    [/^net[./]minecraft[./]server[./]v\d/i, 'version', 'The plugin uses server internals tied to one Minecraft version. Get a build made for your version.']
  ];

  const rules = [
    // Startup and environment
    {
      id: 'java-class-version',
      severity: 'critical',
      title: 'Wrong Java version for this jar',
      match: /class file version (\d+)\.\d+.*?(?:up to|versions up to) (\d+)\.\d+/,
      explain: (f) => 'This jar needs Java ' + javaFor(f.m[1]) + ' but the server is running Java ' + javaFor(f.m[2]) + '.',
      fix: (f) => [
        'Install Java ' + javaFor(f.m[1]) + ' (Temurin from adoptium.net is a good choice) and start the server with it.',
        'If you have several Javas installed, point your start script at the right java.exe or java binary.',
        'On a host panel, pick Java ' + javaFor(f.m[1]) + ' in the startup settings.'
      ]
    },
    {
      id: 'java-unsupported-version',
      severity: 'critical',
      title: 'Java version not supported by this server',
      match: /Unsupported Java detected \(([^)]+)\)/,
      explain: 'The server software refuses to run on Java {1}.',
      fix: ['Install the Java version your server version needs: 8 for 1.8 to 1.16, 17 for 1.17 to 1.20.4, 21 for 1.20.5 and newer.']
    },
    {
      id: 'class-major-unsupported',
      severity: 'error',
      title: 'Plugin or library built for a newer Java than the loader understands',
      match: /Unsupported class file major version (\d+)/,
      plugin: (f) => pathPlugin(f.m.input),
      explain: (f) => 'A jar contains classes compiled for Java ' + javaFor(+f.m[1]) + ', and the tool reading it is too old to understand them.',
      fix: ['Update the plugin that is named near this error.', 'Update your server software, since old builds read newer jars badly.', 'Run the Java version the plugin was built for.']
    },
    {
      id: 'java-major-minor',
      severity: 'critical',
      title: 'Plugin built for a newer Java than the server runs',
      match: /Unsupported major\.minor version (\d+)\.\d+/,
      plugin: (f) => {
        const m = /UnsupportedClassVersionError: ([\w\/.$]+)/.exec(f.hits[0].line.text);
        const jar = f.hits[0].near(/Could not load '(?:plugins[\/\\])?([^']+?)(?:\.jar)?' in folder/, 4, 0);
        return jar ? jarName(jar[1]) : m ? m[1].split(/[\/.]/).slice(0, -1).pop() : null;
      },
      explain: (f) => 'A jar was built for Java ' + javaFor(+f.m[1] + 0) + ' or newer, but the server is running an older Java.',
      fix: (f) => ['Install Java ' + javaFor(+f.m[1]) + ' or newer and start the server with it.', 'Or use an older release of the plugin built for your Java version.']
    },
    {
      id: 'velocity-plugin-load',
      severity: 'error',
      title: 'Velocity plugin failed to load: {1}',
      match: /Can't load plugin (\S+)/,
      key: (m) => m[1],
      plugin: (f) => jarName(f.m[1].split(/[\/\\]/).pop()),
      explain: 'Velocity could not load {1}. The reason is on the next line.',
      fix: ['Read the line below this error for the reason.', 'Make sure the plugin is built for Velocity and for your Velocity version.'],
      context: 2
    },
    {
      id: 'velocity-backend-down',
      replaces: ['connection-refused'],
      severity: 'error',
      title: 'Proxy could not reach backend server {1}',
      match: /Unable to connect to server (\S+?):/,
      key: (m) => m[1],
      explain: 'Players were sent to "{1}" but the proxy could not connect to it, so they were kicked.',
      fix: ['Start the backend server and check it has finished starting.', 'Check the address and port of {1} in velocity.toml (or the BungeeCord config) match the backend server-port.', 'If the backend runs on another machine, open its port in the firewall.']
    },
    {
      id: 'economy-null',
      severity: 'error',
      title: 'Plugin has no economy to use',
      match: /because "(?:this\.)?(?:econ(?:omy)?|eco|vault\w*)" is null/i,
      explain: '{plugin} looked for an economy through Vault and found none, so it crashed. This is the usual cause when Vault is installed but no economy plugin is.',
      fix: ['Install an economy plugin such as EssentialsX (with economy enabled) next to Vault.', 'Check the economy plugin loaded before {plugin} in the log.']
    },
    {
      id: 'eula',
      severity: 'critical',
      title: 'EULA not accepted',
      match: /You need to agree to the EULA/i,
      explain: 'Minecraft will not start until you accept the EULA.',
      fix: ['Open eula.txt in the server folder and change eula=false to eula=true, then start again.']
    },
    {
      id: 'port-in-use',
      mergeWithin: 12,
      severity: 'critical',
      title: 'Port already in use',
      match: /FAILED TO BIND TO PORT|Address already in use|Perhaps a server is already running on that port/i,
      explain: 'Another program, often a second copy of the server, is already using the server port.',
      fix: [
        'Close the other server (check Task Manager or run ps / pkill java on Linux).',
        'Or change server-port in server.properties to a free port.',
        'On a host, make sure the port matches the one your panel assigned.'
      ]
    },
    {
      id: 'oom-heap',
      severity: 'critical',
      title: 'Out of memory (heap)',
      match: /OutOfMemoryError: (Java heap space|GC overhead limit exceeded)/,
      explain: 'The server used all the RAM Java was allowed to use.',
      fix: [
        'Raise the -Xmx value in your start script if the machine has RAM to spare.',
        'Lower view-distance and simulation-distance, and cap entities in your config.',
        'Find the memory hog with a /spark heapsummary. Plugins that cache a lot are the usual cause.'
      ]
    },
    {
      id: 'oom-metaspace',
      severity: 'critical',
      title: 'Out of memory (metaspace)',
      match: /OutOfMemoryError: Metaspace/,
      explain: 'Java ran out of space for class data. This usually means a plugin leaks classes, often after /reload.',
      fix: ['Never use /reload, always restart.', 'Remove or update plugins that were added recently.']
    },
    {
      id: 'oom-native-thread',
      severity: 'critical',
      title: 'Cannot create more threads',
      match: /unable to create (?:new )?native thread/i,
      explain: 'The system refused to create another thread. A plugin is spawning too many, or the host limits processes.',
      fix: ['Ask your host about the process or thread limit.', 'Find which plugin spawns threads with /spark profiler.']
    },
    {
      id: 'heap-reserve',
      severity: 'critical',
      title: 'Java could not start with this memory setting',
      match: /Could not reserve enough space for (?:\d+KB )?object heap|Invalid maximum heap size|Invalid initial heap size|Could not create the Java Virtual Machine/i,
      explain: 'The -Xmx / -Xms value is more than the machine can give, or you are using 32 bit Java.',
      fix: ['Lower -Xmx to less than your free RAM.', 'Install 64 bit Java.', 'Make sure -Xms is not larger than -Xmx.']
    },
    {
      id: 'bad-jar',
      severity: 'critical',
      title: 'Server jar cannot be run',
      match: /Invalid or corrupt jarfile|Unable to access jarfile|Could not find or load main class/,
      explain: 'Java cannot open the jar named in your start command. The file is missing, misspelled, or the download is broken.',
      fix: ['Check the file name in your start script matches the jar exactly.', 'Download the server jar again.', 'Make sure you start the script from inside the server folder.']
    },
    {
      id: 'disk-full',
      severity: 'critical',
      title: 'Disk is full',
      match: /No space left on device|There is not enough space on the disk/i,
      explain: 'The drive the server runs on has no free space, so it cannot save worlds or logs.',
      fix: ['Free up space: old logs, crash reports, backups, and unused worlds are the usual suspects.', 'Check the world is not corrupted after the disk filled.']
    },
    {
      id: 'session-lock',
      severity: 'critical',
      title: 'World is locked by another server',
      match: /Failed to check session lock|session\.lock/i,
      explain: 'Another server process is already using this world folder.',
      fix: ['Stop every other server using this folder, check for leftover java processes, then start again.']
    },
    {
      id: 'file-in-use',
      severity: 'error',
      title: 'File is locked by another program',
      match: /The process cannot access the file because it is being used by another process/,
      explain: 'Windows will not let the server touch a file because another program holds it open.',
      fix: ['Close backup tools, antivirus scans, and any second server instance that touches this folder.']
    },
    {
      id: 'world-level-corrupt',
      severity: 'critical',
      title: 'World data file is damaged',
      match: /(?:Exception reading|Failed to read|Could not read|Unable to read).*level\.dat|level\.dat.*(?:corrupt|invalid|not in gzip)/i,
      explain: 'level.dat, the file that describes the world, cannot be read.',
      fix: ['Restore level.dat from a backup, or from level.dat_old in the same folder (rename it to level.dat).']
    },
    {
      id: 'chunk-corrupt',
      severity: 'error',
      title: 'Chunk data is damaged',
      match: /Chunk file at .* is in the wrong location|Failed to read chunk|Error while loading chunk|Failed to load chunk|Region file .*(?:corrupt|truncated)|Failed to fetch chunk/i,
      explain: 'Part of a region file cannot be read. Usually the server crashed or lost power while saving.',
      fix: ['Restore the affected region file (.mca) from a backup.', 'Use MCA Selector to delete just the broken chunks so the server regenerates them.']
    },
    {
      id: 'chunk-save-failed',
      severity: 'error',
      title: 'Chunk could not be saved',
      match: /Failed to (?:store|save|write) chunk/i,
      explain: 'The server could not write world data to disk.',
      fix: ['Check free disk space and file permissions on the world folder.', 'Check an antivirus or backup tool is not locking the files.']
    },
    {
      id: 'dns-failure',
      severity: 'error',
      title: 'Could not resolve a hostname',
      match: /UnknownHostException:? ?(\S*)/,
      key: (m) => m[1],
      explain: 'The server could not look up "{1}". Either it has no internet, DNS is broken, or the address is a typo.',
      fix: ['Check the address in the config for typos.', 'Make sure the machine has internet and working DNS.']
    },
    {
      id: 'ssl-failure',
      severity: 'error',
      title: 'Secure connection failed',
      match: /PKIX path building failed|SSLHandshakeException|unable to find valid certification path/,
      explain: 'Java does not trust the certificate of a website the server tried to reach. Old Java builds lack newer certificates.',
      fix: ['Update Java to the latest build of your version.', 'Check the system clock is correct.']
    },
    {
      id: 'offline-mode',
      severity: 'warning',
      title: 'Server is in offline mode',
      match: /SERVER IS RUNNING IN OFFLINE\/INSECURE MODE/,
      explain: 'Anyone can join as any username, including your admins. This is only safe behind a proxy that checks logins.',
      fix: ['If you do not use BungeeCord or Velocity, set online-mode=true in server.properties.', 'If you do use a proxy, firewall the backend port so only the proxy can connect, and enable forwarding.']
    },
    {
      id: 'auth-failed',
      severity: 'warning',
      title: 'Player login could not be verified',
      match: /Failed to verify username|Invalid session|authentication servers are down/i,
      explain: 'Mojang session check failed for a player. Causes: Mojang outage, a cracked client on an online-mode server, or a proxy that forwards wrongly.',
      fix: ['If you want cracked players, you need offline mode, with a login plugin and proper protection.', 'If you use a proxy, enable IP forwarding on both sides and make the backend offline mode.']
    },
    {
      id: 'fly-kick',
      severity: 'info',
      title: 'Players kicked for flying',
      match: /was kicked for floating too long|Flying is not enabled on this server/i,
      explain: 'The vanilla fly check kicked a player. It often fires wrongly with lag, elytra tricks, or plugins that move players.',
      fix: ['Set allow-flight=true in server.properties if you run a real anti-cheat or use fly plugins.']
    },
    {
      id: 'bungee-forwarding',
      severity: 'error',
      title: 'Proxy forwarding mismatch',
      match: /If you wish to use IP forwarding, please enable it in your BungeeCord config as well/,
      explain: 'A player reached a backend server that expects BungeeCord forwarding, without the forwarding data. Either the proxy has forwarding off, or the player connected straight to the backend port.',
      fix: ['In the BungeeCord config.yml set ip_forward: true.', 'Firewall the backend port so players can only get in through the proxy.', 'Or set bungeecord: false in spigot.yml if you are not using a proxy.']
    },
    {
      id: 'velocity-forwarding',
      severity: 'error',
      title: 'Velocity forwarding problem',
      match: /Unable to verify player details|This server requires you to connect with Velocity/,
      explain: 'The backend and the Velocity proxy disagree about modern forwarding, usually a wrong or missing secret.',
      fix: ['Copy the secret from forwarding.secret on the proxy into the backend config (paper-global.yml, velocity section).', 'Set player-info-forwarding-mode to modern on the proxy and enable velocity-support on the backend.']
    },
    {
      id: 'connection-reset',
      severity: 'info',
      title: 'Players dropping connections',
      match: /Connection reset( by peer)?|Broken pipe|An existing connection was forcibly closed|Software caused connection abort/,
      explain: 'Normal when players close the game or lose internet. It only matters if it happens constantly.',
      fix: ['No action needed unless many players report disconnects. Then check the network and hosting.']
    },
    {
      id: 'connection-throttled',
      severity: 'warning',
      title: 'Connections being throttled',
      match: /Connection throttled! Please wait before reconnecting/,
      explain: 'Players reconnected faster than connection-throttle in bukkit.yml allows. With a proxy, every player comes from the same address.',
      fix: ['Behind BungeeCord or Velocity set connection-throttle: -1 in bukkit.yml.']
    },
    {
      id: 'bad-packet',
      severity: 'warning',
      title: 'Broken network packets',
      match: /Badly compressed packet|Packet processing error|Internal Exception: io\.netty|DecoderException|EncoderException/,
      explain: 'A packet could not be read or written. Usual causes are a client with an incompatible mod, a packet plugin acting up, or a bad exploit attempt.',
      fix: ['Update ProtocolLib, ViaVersion, and any packet or anti-exploit plugins.', 'If one player causes it, ask them to remove mods.']
    },
    {
      id: 'slow-start',
      severity: 'info',
      title: 'Server took a long time to start',
      match: /Done \(([\d.,]+)s\)!/,
      filter: (hit) => parseFloat(hit.m[1].replace(',', '.')) >= 60,
      explain: 'Start took {1} seconds. Normal is under 30. Large worlds, many plugins, and slow disks all add up.',
      fix: ['Move the server to an SSD.', 'Pregenerate the world so spawn chunks load quickly.', 'Start with a profiler and see which plugin enable takes longest.']
    },
    {
      id: 'reload-used',
      severity: 'warning',
      title: '/reload was used',
      match: /command is not supported and may cause issues|issued server command: \/(?:bukkit:)?reload\b/i,
      explain: '/reload leaks memory and breaks many plugins in strange ways. Many odd errors afterwards come from it.',
      fix: ['Restart the server instead of using /reload.', 'For plugin settings, use the plugin\'s own reload command.']
    },
    {
      id: 'legacy-plugin',
      severity: 'warning',
      title: 'Legacy plugin: {1}',
      match: /Legacy plugin (\S+)/,
      key: (m) => m[1],
      plugin: (f) => f.m[1],
      explain: '{1} does not declare an api-version, so the server turns on a slow compatibility layer for every material.',
      fix: ['Update {1}, or replace it with a maintained plugin.']
    },
    {
      id: 'legacy-material',
      severity: 'warning',
      title: 'Legacy material support enabled',
      match: /Initializing Legacy Material Support/,
      explain: 'At least one old plugin forced legacy mode. Startup is slower and some blocks can behave oddly.',
      fix: ['Find the plugin flagged "Legacy plugin" above and update or remove it.']
    },
    {
      id: 'behind-version',
      severity: 'warning',
      title: 'Server software is outdated',
      match: /You are (\d+) version\(s\) behind/,
      filter: (hit) => +hit.m[1] >= 5,
      explain: 'Your server is {1} builds behind. Old builds miss bug fixes and security fixes.',
      fix: ['Download the latest build of your server software for your Minecraft version.']
    },

    // Plugin loading
    {
      id: 'unsupported-api',
      mergeWithin: 4,
      severity: 'error',
      title: 'Plugin made for a newer Minecraft version',
      match: /Unsupported API version ([\d.]+)/,
      plugin: (f) => {
        const hit = f.hits[0];
        const m = hit.near(/Could not load '(?:plugins[\/\\])?([^']+?)(?:\.jar)?' in folder/, 4, 4);
        return m ? jarName(m[1]) : null;
      },
      explain: '{plugin} was built for Minecraft {1}, but this server is older.',
      fix: ['Use an older release of {plugin} that supports your version, or update your server to {1}.']
    },
    {
      id: 'unknown-dependency',
      severity: 'error',
      title: 'Missing required plugin: {dep}',
      match: /UnknownDependencyException: (.+)$|Unknown\/missing dependency plugins: \[([^\]]+)\]/,
      key: (m) => m[1] || m[2],
      vars: (f) => ({ dep: f.m[1] || f.m[2] }),
      plugin: (f) => {
        const m = /to run '([^']+)'/.exec(f.hits[0].line.text) || f.hits[0].near(/Could not load '(?:plugins[\/\\])?([^']+?)(?:\.jar)?' in folder/, 4, 4) || f.hits[0].near(/Could not load plugin '([^']+?)(?:\.jar)?'/, 4, 4);
        return m ? jarName(m[1]) : null;
      },
      explain: '{plugin} needs {dep} but it is not installed (or failed to load).',
      fix: ['Install {dep} in the plugins folder, then restart.', 'If {dep} is installed, check it loaded without errors earlier in the log.']
    },
    {
      id: 'invalid-description',
      severity: 'error',
      title: 'Jar is not a valid plugin',
      match: /InvalidDescriptionException|plugin\.yml not found|Invalid plugin\.yml|Jar does not contain plugin\.yml|paper-plugin\.yml/i,
      filter: (hit) => !/Unsupported API|Unknown\/missing/.test(hit.line.msg),
      plugin: (f) => pathPlugin(f.hits[0].line.text) || (f.hits[0].near(/Could not load '(?:plugins[\/\\])?([^']+?)(?:\.jar)?' in folder/, 4) || [])[1] || null,
      explain: 'The server tried to load a jar that does not have a usable plugin.yml. It might be a mod, a library, a damaged download, or a plugin for another platform.',
      fix: ['Re-download the jar from the official page.', 'Check it is a Bukkit/Spigot/Paper plugin and not a Fabric/Forge mod or a proxy plugin.', 'Remove it from plugins/ if it should not be there.']
    },
    {
      id: 'main-class-missing',
      severity: 'error',
      title: 'Plugin main class not found',
      match: /Cannot find main class|InvalidPluginException: Cannot find main class/,
      explain: 'The jar names a main class that is not inside it. The download is broken or the jar was edited.',
      fix: ['Download the plugin again.']
    },
    {
      id: 'ambiguous-plugin',
      severity: 'error',
      title: 'Two jars with the same plugin name',
      match: /Ambiguous plugin name [`'"]?([^`'"]+)[`'"]? for files/,
      key: (m) => m[1],
      plugin: (f) => f.m[1],
      explain: 'Two files in plugins/ both claim to be {1}. Only one can load.',
      fix: ['Delete the older copy of {1} from the plugins folder.']
    },
    {
      id: 'could-not-load',
      severity: 'error',
      title: 'Plugin failed to load: {1}',
      match: /Could not load '(?:plugins[\/\\])?([^']+?)(?:\.jar)?' in folder/,
      key: (m) => m[1],
      plugin: (f) => jarName(f.m[1]),
      filter: (hit) => !/Unsupported API|UnknownDependency|Unknown\/missing|InvalidDescription|plugin\.yml|Cannot find main class|UnsupportedClassVersion|Unsupported class file/.test(hit.after(4).join('\n')),
      explain: 'The server could not load {1}. The reason is on the lines right after.',
      fix: ['Read the Caused by lines below this error, they name the real reason.', 'Update the plugin, and check it supports your server version.'],
      context: 3
    },
    {
      id: 'enable-failed',
      severity: 'error',
      title: '{1} failed to enable',
      match: /Error occurred while enabling (\S+(?: \S+)*?) v?(\S+) \(Is it up to date\?\)/,
      key: (m) => m[1],
      plugin: (f) => f.m[1],
      explain: '{1} crashed during startup and was switched off, so none of its features work.',
      fix: ['Read the error just below it for the cause.', 'Update {1} and everything it depends on.', 'Check its config file for mistakes.'],
      context: 4
    },
    {
      id: 'undeclared-dependency',
      severity: 'warning',
      title: '{3} uses classes from {2} without declaring it',
      match: /Loaded class (\S+) from (\S+) v\S+ which is not a depend.*? of (\S+) v\S+/,
      key: (m) => m[3] + '>' + m[2],
      plugin: (f) => f.m[3],
      explain: '{3} reaches into {2} but does not list it as a dependency, so load order is left to luck.',
      fix: ['Usually harmless. If it breaks after an update, tell the author of {3} to add {2} to depend or softdepend.']
    },
    {
      id: 'plugin-conflict-check',
      severity: 'warning',
      title: 'Conflicting plugins installed',
      check: (ctx) => {
        const names = new Set(ctx.plugins.map((p) => p.name.toLowerCase()));
        const has = (...n) => n.some((x) => names.has(x.toLowerCase()));
        const out = [];
        if (has('Essentials', 'EssentialsX') && has('CMI')) out.push('EssentialsX and CMI do the same job and fight over commands.');
        if (has('FastAsyncWorldEdit') && has('WorldEdit')) out.push('FastAsyncWorldEdit already includes WorldEdit. Keep only FastAsyncWorldEdit.');
        const anti = ['Vulcan', 'Grim', 'GrimAC', 'Spartan', 'Matrix', 'NoCheatPlus', 'Intave', 'Themis', 'Karhu', 'Verus'].filter((n) => names.has(n.toLowerCase()));
        if (anti.length > 1) out.push('Several anti-cheats are installed (' + anti.join(', ') + '). They flag each other and cause false bans.');
        const perms = ['LuckPerms', 'PermissionsEx', 'GroupManager', 'UltraPermissions', 'zPermissions', 'bPermissions'].filter((n) => names.has(n.toLowerCase()));
        if (perms.length > 1) out.push('Several permission plugins are installed (' + perms.join(', ') + '). Keep only one.');
        if (!out.length) return null;
        return { summary: out.join(' '), fix: ['Remove the duplicates and keep one plugin per job.'] };
      }
    },
    {
      id: 'abandoned-plugin-check',
      severity: 'info',
      title: 'Abandoned plugins installed',
      check: (ctx) => {
        const dead = ['PermissionsEx', 'GroupManager', 'NoLagg', 'WorldBorder', 'HawkEye'];
        const found = ctx.plugins.filter((p) => dead.some((d) => d.toLowerCase() === p.name.toLowerCase())).map((p) => p.name);
        if (!found.length) return null;
        return { summary: found.join(', ') + ' stopped receiving updates years ago and can break on new Minecraft versions.', fix: ['Replace them with maintained alternatives. LuckPerms replaces PermissionsEx and GroupManager.'] };
      }
    },

    // Runtime plugin errors
    {
      id: 'event-exception',
      severity: 'error',
      title: '{2} throws errors handling {1}',
      match: /Could not pass event (\w+) to (\S+(?: \S+)*?) v?(\S+)/,
      key: (m) => m[2] + '|' + m[1],
      plugin: (f) => f.m[2],
      explain: '{2} crashed while reacting to the {1} event, {count} time(s). The player action that triggered it may have failed.',
      fix: ['Update {2} and its dependencies.', 'Read the Caused by line under the error for the exact reason.', 'If it keeps happening on the latest version, report it to the author with the stack trace.']
    },
    {
      id: 'task-exception',
      severity: 'error',
      title: '{plugin} task crashed',
      match: /Task #\d+ for (\S+) v\S+ generated an exception|Plugin (\S+) v\S+ generated an exception while executing task|Exception in thread "Craft Scheduler Thread - \d+ - (\S+)"/,
      key: (m) => m[1] || m[2] || m[3],
      plugin: (f) => f.m[1] || f.m[2] || f.m[3],
      explain: 'A repeating or delayed task in {plugin} threw an error, {count} time(s). That feature stops working until the next server restart.',
      fix: ['Update {plugin}.', 'Check the error under this line for the real reason, often a missing world, player, or database.']
    },
    {
      id: 'command-exception',
      severity: 'error',
      title: '/{1} command crashed in {2}',
      match: /Unhandled exception executing (?:command )?'([^']+)' in (?:plugin )?(\S+)/,
      key: (m) => m[1] + '|' + m[2],
      plugin: (f) => f.m[2],
      explain: 'Running /{1} threw an error inside {2}.',
      fix: ['Update {2}.', 'Check the config for that command and the Caused by line below.']
    },
    {
      id: 'async-main-thread',
      severity: 'error',
      title: '{plugin} touches the world from the wrong thread',
      match: /Asynchronous ([\w ]+)!|Thread Failed main thread check|Cannot (?:read|modify|load|get|set) .* asynchronously/,
      plugin: (f) => f.hits[0].scanPlugin(40),
      explain: 'A plugin called server code from a background thread. This can corrupt data or crash the server.',
      fix: ['Update the plugin named in the stack trace.', 'If no plugin is named, run the server with spark to find the caller.', 'Report it to the plugin author. They need to run that call on the main thread.']
    },
    {
      id: 'stack-overflow',
      severity: 'error',
      title: 'Infinite loop (StackOverflowError)',
      match: /StackOverflowError/,
      plugin: (f) => f.hits[0].scanPlugin(30),
      explain: 'Code called itself without end. Plugins that react to each other\'s events can cause this.',
      fix: ['Update or remove the plugin named in the trace.', 'Look at the plugins installed most recently.']
    },
    {
      id: 'wrong-version-code',
      severity: 'error',
      title: 'Plugin built for a different version',
      match: /(NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError)(?:: (.+))?$/,
      key: (m) => m[1] + (m[2] || ''),
      plugin: (f) => f.hits[0].scanPlugin(30),
      explain: 'Code called {1}: {2}. That method or field does not exist on this server version.',
      fix: ['Update the plugin named near this error to a build for your Minecraft and server version.', 'If you recently updated the server, update every plugin too.']
    },
    {
      id: 'missing-class',
      title: 'Missing class: {cls}',
      match: /(?:NoClassDefFoundError|ClassNotFoundException): ([\w.$\/\-]+)/,
      severity: (f) => (f.hits.some((h) => (h.line.level === 'ERROR' || h.line.level === 'FATAL' || h.near(/Error occurred while enabling|Could not load|Could not pass event|generated an exception|Unhandled exception/, 4, 0)) && !/Error loading class:/.test(h.line.text)) ? 'error' : 'info'),
      key: (m) => m[1],
      vars: (f) => {
        const cls = f.m[1];
        const hint = MISSING_CLASS_HINTS.find((h) => h[0].test(cls));
        return { cls, hint: hint ? hint[2] : 'The plugin needs a library or another plugin that is not present, or it was built for a different server version.' };
      },
      plugin: (f) => f.hits[0].scanPlugin(30),
      explain: 'A class the code needs ({cls}) is not available. {hint}',
      fix: ['Install or update whatever provides {cls}.', 'Update the plugin to match your server version.']
    },
    {
      id: 'database-problem',
      severity: 'error',
      title: 'Database problem',
      match: /HikariPool-\d+ - (?:Exception during pool initialization|Failed to validate connection)|Communications link failure|Access denied for user|Unknown database|SQLITE_BUSY|database is locked|Too many connections|SQLNonTransientConnectionException/,
      key: (m) => (/Access denied/.test(m[0]) ? 'auth' : /Unknown database/.test(m[0]) ? 'nodb' : /locked|BUSY/.test(m[0]) ? 'locked' : /Too many/.test(m[0]) ? 'many' : 'conn'),
      plugin: (f) => f.hits[0].scanPlugin(40),
      explain: (f) => {
        const k = /Access denied/.test(f.m[0]) ? 'auth' : /Unknown database/.test(f.m[0]) ? 'nodb' : /locked|BUSY/.test(f.m[0]) ? 'locked' : /Too many/.test(f.m[0]) ? 'many' : 'conn';
        return {
          auth: 'The database refused the username or password.',
          nodb: 'The database name does not exist on the database server.',
          locked: 'A SQLite file is busy because several things write to it at once.',
          many: 'The database has hit its connection limit, usually because several plugins each open too many.',
          conn: 'The plugin could not connect to the database server.'
        }[k];
      },
      fix: ['Check host, port, database name, username and password in the plugin config.', 'Make sure the database server is running and accepts connections from this machine.', 'Lower the pool size in the plugin config if you hit the connection limit.']
    },
    {
      id: 'connection-refused',
      severity: 'warning',
      title: 'Connection refused',
      match: /Connection refused:? ?(?:no further information:? ?)?(\S*)/,
      key: (m) => m[1],
      explain: 'Something tried to connect to {1} and nothing was listening. This could be a database, Redis, or another server that is down.',
      fix: ['Start the service on that address, or fix the host and port in the config that uses it.']
    },
    {
      id: 'yaml-tabs',
      replaces: ['yaml-error'],
      severity: 'error',
      title: 'Config contains a tab character',
      match: /found character '\\t' that cannot start any token|found character that cannot start any token/,
      plugin: (f) => pathPlugin(f.hits[0].after(8).join(' ')) || pathPlugin(f.hits[0].line.text),
      explain: 'A YAML config uses a tab for indentation. YAML only allows spaces.',
      fix: ['Open the config in an editor that shows whitespace, replace all tabs with spaces.', 'Paste the file into yamllint.com to find the exact line.']
    },
    {
      id: 'yaml-error',
      mergeWithin: 3,
      severity: 'error',
      title: 'Config file cannot be read',
      match: /Cannot load (?:configuration from stream|(?:\S*[\/\\])?\S+\.ya?ml)|InvalidConfigurationException|mapping values are not allowed here|while parsing a (?:block|flow) (?:mapping|collection)|could not find expected ':'|DuplicateKeyException|bad indentation/,
      plugin: (f) => pathPlugin(f.m.input) || pathPlugin(f.hits[0].after(6).join(' ')),
      explain: 'A YAML config file has a syntax mistake, so {plugin} could not read it. Usual causes: wrong indentation, a missing quote, a duplicate key, or a special character.',
      fix: ['Open the file named in the error. The line number is in the message.', 'Paste it into yamllint.com to find the mistake.', 'If you cannot fix it, delete the file and let the plugin generate a new one.'],
      context: 3
    },
    {
      id: 'vault-missing',
      severity: 'error',
      title: 'Economy or permissions hook missing',
      match: /No (?:economy|Economy) (?:plugin|provider)(?: found)?|Vault (?:was )?(?:not found|is missing)|Could not find (?:a|an|any) (?:Vault )?(?:economy|permission)|no economy provider/i,
      explain: 'A plugin needs money or permissions through Vault, but no provider is registered.',
      fix: ['Install Vault, and an economy plugin such as EssentialsX, and a permissions plugin such as LuckPerms.', 'Check the economy plugin loaded without errors and with economy enabled.']
    },
    {
      id: 'protocollib-untested',
      severity: 'warning',
      title: 'ProtocolLib has not been tested on this version',
      match: /Version \(MC: ([\d.]+)\) has not yet been tested/,
      plugin: () => 'ProtocolLib',
      explain: 'ProtocolLib is older than your Minecraft version {1}. Plugins that depend on it may break.',
      fix: ['Download the newest ProtocolLib, including a dev build from the official site if no release supports {1} yet.']
    },
    {
      id: 'world-missing',
      severity: 'error',
      title: 'World not found: {1}',
      match: /World '([^']+)' (?:is null|not found|could not be loaded)|Cannot find world[:'"` ]*([\w\-]*)|Unable to load world/i,
      key: (m) => m[1] || m[2] || '',
      explain: 'A plugin refers to a world named "{1}" that is not loaded. A world was renamed or deleted, or a world manager has not loaded it yet.',
      fix: ['Check the world name in the plugin config (case matters).', 'If you use Multiverse, make sure the world loads before the plugin that needs it.']
    },
    {
      id: 'datapack-error',
      severity: 'error',
      title: 'Datapack failed to load',
      match: /Failed to load datapacks|Couldn't parse data file|Failed to parse .* from pack|Parsing error loading/,
      explain: 'A datapack has broken or incompatible data.',
      fix: ['Remove recently added datapacks from the world/datapacks folder.', 'Check each datapack supports your Minecraft version (pack_format).']
    },
    {
      id: 'duplicate-uuid',
      severity: 'info',
      title: 'Duplicate entities found',
      match: /Keeping entity (.+?) that already exists with UUID/,
      explain: 'The world has two entities with the same UUID. The server keeps one. This is usually harmless but can leave ghost entities.',
      fix: ['No action needed unless it floods the log. Then clear the entities in that chunk with MCA Selector.']
    },
    {
      id: 'cant-keep-up',
      severity: (f) => (f.count >= 20 || Math.max(...f.all.map((m) => +m[1])) >= 5000 ? 'error' : 'warning'),
      title: 'Server is lagging ("Can\'t keep up")',
      match: /Can't keep up! (?:Is the server overloaded\?|Did the system time change, or is the server overloaded\?) Running (\d+)ms/,
      vars: (f) => {
        const max = Math.max(...f.all.map((m) => +m[1]));
        return { max, secs: (max / 1000).toFixed(1) };
      },
      explain: 'The server fell behind {count} time(s). Worst case it was {max}ms ({secs} seconds) behind.',
      fix: [
        'Run /spark profiler start, play for a few minutes, then /spark profiler stop and open the link. It shows exactly what eats the time.',
        'Lower view-distance and simulation-distance.',
        (f) => (/Paper|Purpur|Pufferfish|Folia|Leaf/i.test(f.info.software || '') ? 'Cap mobs and items in paper-world-defaults.yml, and limit hoppers and redstone.' : 'Lower the mob spawn limits in bukkit.yml and the entity activation ranges in spigot.yml. Moving to Paper gives you many more tuning options.'),
        'Check the host: slow CPU, noisy neighbours, or too little RAM all cause this.'
      ]
    },
    {
      id: 'watchdog',
      mergeWithin: 40,
      severity: 'critical',
      title: 'Server froze and the watchdog killed it',
      match: /A single server tick took ([\d.]+) seconds|The server has not responded for \d+ seconds|The server has stopped responding!|Considering it to be crashed, server will forcibly shutdown/,
      plugin: (f) => f.hits[0].scanPlugin(150, true),
      explain: (f) => 'One tick took far too long, so the server was stopped to protect the world.' + (f.plugin ? ' The main thread was stuck inside ' + f.plugin + '.' : ' The thread dump in the log shows what the main thread was doing.'),
      fix: [
        (f) => (f.plugin ? 'The frames in the dump point at "' + f.plugin + '". If that is not a plugin you know, search your plugins folder for a jar with a matching name or package.' : 'Look for a line marked "Server thread" in the thread dump. The first plugin or server code below it is the culprit.'),
        'Install spark and check /spark tickmonitor to catch slow ticks before they become a crash.',
        'Common causes: huge redstone or hopper builds, a plugin doing disk or web work on the main thread, giant entity pileups.'
      ]
    },
    {
      id: 'moved-too-quickly',
      severity: 'info',
      title: 'Players "moved too quickly"',
      match: /moved (?:too quickly|wrongly)!/,
      explain: 'The server rejected a movement. It comes from lag, teleport plugins, or speed hacks.',
      fix: ['A few are normal. If it floods, check for lag first, then your teleport or anti-cheat plugins.']
    },

    // Pasted spark output (/spark healthreport, /spark tps)
    {
      id: 'spark-tps',
      severity: (f) => (f.vars.low < 15 ? 'error' : 'warning'),
      title: 'spark reports low TPS',
      match: /TPS from last 5s, 10s, 1m, 5m, 15m/,
      filter: (hit) => { const n = nums(hit.after(1)[0]); return n.length >= 5 && Math.min(n[2], n[3]) < 19; },
      vars: (f) => { const n = nums(f.hits[0].after(1)[0]); return { tps: n.slice(0, 5).join(', '), low: Math.min(n[2], n[3]) }; },
      explain: 'spark measured {tps} TPS over the last 5s, 10s, 1m, 5m and 15m. 20 is perfect, and below 18 players notice lag.',
      fix: [
        'Start a profile while it lags: /spark profiler start --timeout 120, then open the link it prints. The widest bars under "Server thread" show what is slow.',
        'If most time is chunk loading or entity ticking, lower view-distance and mob limits. If it is one plugin, update or replace it.'
      ]
    },
    {
      id: 'spark-ticks',
      severity: (f) => (f.vars.max >= 2000 ? 'error' : 'warning'),
      title: 'spark reports slow ticks',
      match: /Tick durations \(min\/med\/95%ile\/max ms\)/,
      filter: (hit) => { const n = nums(hit.after(1)[0]); return n.length >= 4 && (Math.max(n[2], n[6] || 0) > 50 || Math.max(n[3], n[7] || 0) > 1000); },
      vars: (f) => { const n = nums(f.hits[0].after(1)[0]); return { p95: Math.max(n[2], n[6] || 0), max: Math.max(n[3], n[7] || 0) }; },
      explain: 'A tick should take under 50 ms. The slowest 5% took up to {p95} ms and the worst tick took {max} ms, which players feel as freezes.',
      fix: ['Run /spark profiler start --timeout 120 during a lag spike and open the report.', 'Spikes that come every few minutes usually mean garbage collection or a scheduled plugin task such as saving.']
    },
    {
      id: 'spark-memory',
      severity: 'warning',
      title: 'spark reports the heap is almost full',
      match: /Memory usage/,
      filter: (hit) => { const m = /\((\d+)%\)/.exec(hit.after(3).join(' ')); return !!m && +m[1] >= 90; },
      vars: (f) => ({ pct: /\((\d+)%\)/.exec(f.hits[0].after(3).join(' '))[1] }),
      explain: 'The Java heap is {pct}% full. When it stays that full the server spends its time collecting garbage, and it can run out of memory.',
      fix: ['Raise -Xmx if the machine has free RAM.', 'Run /spark heapsummary to see which classes hold the memory. A plugin that keeps growing a cache is the usual cause.']
    },
    {
      id: 'spark-gc',
      severity: (f) => (f.vars.avg >= 2000 ? 'error' : 'warning'),
      title: 'Slow full garbage collections',
      match: /(?:G1 Old|Old Generation|MarkSweepCompact|Concurrent ?Mark ?Sweep)[^\n]*?avg\D*(\d+(?:\.\d+)?)\s*ms/i,
      filter: (hit) => parseFloat(hit.m[1]) >= 500,
      vars: (f) => ({ avg: parseFloat(f.m[1]) }),
      explain: 'Each old-generation collection freezes the server for about {avg} ms. These are the long freezes players call lag spikes.',
      fix: ['Give the server more memory, or find the leak with /spark heapsummary.', 'Use tuned G1 flags (LogDoctor can write them for you in a folder audit).']
    },

    // Mods
    {
      id: 'mixin-failure',
      severity: 'critical',
      title: 'Mod conflict (Mixin failed)',
      match: /Mixin apply failed|InvalidInjectionException|Mixin transformation of .* failed|MixinApplyError|Critical injection failure/,
      explain: 'Two mods try to change the same game code, or a mod was built for a different Minecraft version.',
      fix: ['Read the mod ids named in the message.', 'Update those mods, or remove one of them.', 'Check every mod matches your Minecraft and loader version.'],
      context: 2
    },
    {
      id: 'fabric-incompatible',
      mergeWithin: 6,
      severity: 'critical',
      title: 'Fabric mods are incompatible',
      match: /Incompatible mods found!|Some of your mods are incompatible with the game or each other|Unmet dependency listing/,
      explain: 'Fabric refused to start because of missing or wrong-version dependencies. The list is under this line.',
      fix: ['Install the missing mods it names (very often Fabric API).', 'Match each mod to your Minecraft version.'],
      context: 8
    },
    {
      id: 'forge-missing-deps',
      mergeWithin: 6,
      severity: 'critical',
      title: 'Forge / NeoForge dependency problem',
      match: /Missing or unsupported mandatory dependencies|ModLoadingException|DuplicateModsFoundException/,
      explain: 'A mod needs something that is missing or on the wrong version, or two copies of the same mod are installed.',
      fix: ['Read the lines under this error, they list each missing mod and version.', 'Remove duplicate mod files from the mods folder.'],
      context: 8
    },

    // Crash reports
    {
      id: 'crash-report',
      severity: 'critical',
      title: 'Crash report: {1}',
      match: /^Description: (.+)$/,
      explain: (f) => {
        const d = f.m[1];
        if (/Ticking entity/i.test(d)) {
          const et = f.grep(/Entity Type: (.+)$/);
          const loc = f.grep(/Entity's Exact location: (.+)$/);
          return 'An entity crashed the game while it was updating' + (et ? ' (' + et[1] + ')' : '') + (loc ? ' at ' + loc[1] : '') + '. This points to a corrupt entity or a mod/plugin bug.';
        }
        if (/Ticking block entity/i.test(d)) {
          const bl = f.grep(/Block: (.+)$/);
          const loc = f.grep(/Block location: (.+)$/);
          return 'A block entity (chest, hopper, furnace, sign...) crashed while updating' + (bl ? ': ' + bl[1] : '') + (loc ? ' ' + loc[1] : '') + '.';
        }
        const tail = f.plugin ? ' The stack trace points at ' + f.plugin + '.' : '';
        if (/Exception ticking world/i.test(d)) return 'Something broke while the world was running its tick.' + (tail || ' The stack trace below shows which code.');
        if (/Exception in server tick loop/i.test(d)) return 'The main server loop hit an unhandled error.' + (tail || ' The stack trace below shows which code.');
        if (/Initializing game|Exception while loading/i.test(d)) return 'The game crashed while starting. Usually a bad mod, a bad world, or wrong Java.';
        if (/Watching Server/i.test(d)) return 'The watchdog stopped the server because one tick took too long.';
        return 'The game wrote a crash report.' + (f.plugin ? ' The stack trace points at ' + f.plugin + '.' : ' The stack trace below names the cause.');
      },
      fix: (f) => {
        const d = f.m[1];
        if (/Ticking entity/i.test(d)) return ['Open the world in MCA Selector, find the chunk at that location, and delete entities in it (back up first).', 'Or kill the entity from the console with /kill @e[type=...,x=...,y=...,z=...,distance=..5].', 'Update mods and plugins that add that entity.'];
        if (/Ticking block entity/i.test(d)) return ['Remove the block at that location from the console with /setblock x y z air, or delete the chunk with MCA Selector (back up first).', 'Update mods and plugins that add that block.'];
        return ['Read the "Stack Trace" section of the report, and look at the first lines that name a mod or plugin.', 'Update that mod or plugin.', 'Check "Suspected Mods" if the report lists them.'];
      },
      context: 4
    }
  ];

  // Data rules: JSON files in rules/packs (bundled for the browser as LogDoctorPacks).
  function compilePackRule(d) {
    const rule = { id: d.id, severity: d.severity, title: d.title, match: new RegExp(d.match, d.flags || ''), explain: d.explain, fix: d.fix || [] };
    if (typeof d.key === 'number') rule.key = (m) => m[d.key] || '';
    if (d.plugin !== undefined) rule.plugin = typeof d.plugin === 'number' ? (f) => f.m[d.plugin] || null : () => d.plugin;
    if (d.context) rule.context = d.context;
    if (d.mergeWithin) rule.mergeWithin = d.mergeWithin;
    if (d.replaces) rule.replaces = d.replaces;
    return rule;
  }

  function loadPacks() {
    let packs = [];
    if (typeof module === 'object' && module.exports) {
      try {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '..', 'rules', 'packs');
        packs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch (e) { packs = []; }
    } else if (typeof self !== 'undefined' && self.LogDoctorPacks) packs = self.LogDoctorPacks;
    const out = [];
    for (const pack of packs) for (const d of pack.rules) out.push(compilePackRule(d));
    return out;
  }

  const all = rules.concat(loadPacks());
  all.compilePackRule = compilePackRule;
  return all;
});
