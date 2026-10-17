# Changelog

## 2.1.0

- Upgrade check: `--target 1.21.4` marks every plugin ok, check, risky or broken for the version you want, and shows the Java version it needs
- Update check: `--check-updates` looks your jars up on Modrinth by file hash and lists newer versions. Opt in only, hashes only
- Understands pasted `/spark` health report output (TPS, tick durations, heap, garbage collection)
- Rules can now be JSON files with a built-in fixture (`rules/packs`), checked automatically by the tests
- Self-contained HTML report (`--html`), and a contact line you can set in `docs/site-config.js`
- The plan names the plugin in each step and shows how many problems it covers
- Low-priority notes are hidden in the terminal and collapsed in the browser
- Game client logs are recognised, and harmless class probing from mods is no longer reported as an error
- Package-name guesses for plugins are only used for watchdog thread dumps, and are labelled as guesses
- Fixes from real logs: stray `)` in class names, plugin lists for newer Paper formats, Velocity and Forge crash reports

## 2.0.0

- Folder audit: reads plugin jars, configs, `server.properties`, `eula.txt` and the start script, and merges them with `latest.log`
- Ranked fix plan, timeline, side effects folded under their cause
- Corrected config files and a tuned start script (`--write-fixes`)
- mclo.gs links, GitHub Action, CLI and browser versions

## 1.0.0

- Log and crash report diagnosis with 60 rules
