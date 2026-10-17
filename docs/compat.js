(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogDoctorCompat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ABANDONED = ['PermissionsEx', 'GroupManager', 'NoLagg', 'WorldBorder', 'HawkEye', 'Essentials'];
  const STATUS_ORDER = { broken: 0, risky: 1, check: 2, ok: 3 };

  const parts = (v) => String(v || '').split('.').map((n) => parseInt(n, 10) || 0);

  function cmp(a, b) {
    const x = parts(a);
    const y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  // Java a Minecraft version needs. 26.x uses the new year-based numbering.
  function javaFor(target) {
    if (cmp(target, '26') >= 0) return 25;
    if (cmp(target, '1.20.5') >= 0) return 21;
    if (cmp(target, '1.18') >= 0) return 17;
    if (cmp(target, '1.17') >= 0) return 16;
    return 8;
  }

  // How many feature releases behind an api-version is. 1.21 vs 1.18 is 3, 26.1 vs 1.21 counts as 5.
  function gap(api, target) {
    const a = parts(api);
    const t = parts(target);
    const rank = (p) => (p[0] >= 26 ? 22 + (p[0] - 26) * 2 + (p[1] || 0) : p[1] || 0);
    return rank(t) - rank(a);
  }

  // audit.pluginDetails: [{ name, version, api, javaNeeded, file }]
  function compatReport(pluginDetails, target) {
    const java = javaFor(target);
    const rows = pluginDetails.map((p) => {
      let status = 'ok';
      let reason = 'Declares support for ' + (p.api || 'an older version') + ' and nothing else stands out.';
      if (p.api && cmp(p.api, target) > 0) {
        status = 'broken';
        reason = 'Built for Minecraft ' + p.api + ', newer than ' + target + '. The server will refuse to load it.';
      } else if (p.javaNeeded && p.javaNeeded > java) {
        status = 'broken';
        reason = 'Needs Java ' + p.javaNeeded + ', but ' + target + ' runs on Java ' + java + '.';
      } else if (!p.api) {
        status = 'risky';
        reason = 'No api-version, so it was made for 1.12 or older. Expect broken blocks and items on ' + target + '.';
      } else if (ABANDONED.some((a) => a.toLowerCase() === p.name.toLowerCase()) && p.name.toLowerCase() !== 'essentials') {
        status = 'risky';
        reason = 'Unmaintained plugin. Replace it before upgrading.';
      } else if (gap(p.api, target) >= 3) {
        status = 'check';
        reason = 'Built for ' + p.api + ', ' + gap(p.api, target) + ' releases behind ' + target + '. Look for a newer version before you upgrade.';
      }
      return { name: p.name, version: p.version, status, reason };
    });
    rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
    const summary = { ok: 0, check: 0, risky: 0, broken: 0 };
    rows.forEach((r) => summary[r.status]++);
    return { target, java, rows, summary };
  }

  return { compatReport, javaFor, cmp };
});