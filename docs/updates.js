(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogDoctorUpdates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://api.modrinth.com/v2';
  const LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia'];

  async function sha1Hex(bytes) {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      return require('crypto').createHash('sha1').update(bytes).digest('hex');
    }
    const buf = await crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function post(path, body, fetchFn) {
    const res = await fetchFn(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'logdoctor (Minecraft server audit tool)' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('Modrinth answered HTTP ' + res.status);
    return res.json();
  }

  // Looks the exact jar files up on Modrinth by hash. Only the hashes are sent, never the files.
  // plugins: [{ name, sha1 }]. Returns { rows, found, outdated } where rows have status latest | outdated | unknown.
  async function checkUpdates(plugins, opts) {
    const options = opts || {};
    const fetchFn = options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) throw new Error('No fetch available');
    const withHash = plugins.filter((p) => p.sha1);
    if (!withHash.length) return { rows: [], found: 0, outdated: 0 };
    const hashes = withHash.map((p) => p.sha1);
    const current = await post('/version_files', { hashes, algorithm: 'sha1' }, fetchFn);
    const known = Object.keys(current);
    let latest = {};
    let forMc = {};
    if (known.length) {
      latest = await post('/version_files/update', { hashes: known, algorithm: 'sha1', loaders: LOADERS }, fetchFn);
      if (options.mc) forMc = await post('/version_files/update', { hashes: known, algorithm: 'sha1', loaders: LOADERS, game_versions: [options.mc] }, fetchFn);
    }
    const rows = withHash.map((p) => {
      const cur = current[p.sha1];
      if (!cur) return { name: p.name, status: 'unknown' };
      const lat = latest[p.sha1];
      const outdated = !!lat && lat.id !== cur.id && new Date(lat.date_published) > new Date(cur.date_published);
      const newest = outdated ? lat : cur;
      return {
        name: p.name,
        status: outdated ? 'outdated' : 'latest',
        current: cur.version_number,
        latest: newest.version_number,
        url: 'https://modrinth.com/project/' + cur.project_id,
        supportsMc: options.mc ? !!forMc[p.sha1] : null
      };
    });
    return { rows, found: rows.filter((r) => r.status !== 'unknown').length, outdated: rows.filter((r) => r.status === 'outdated').length };
  }

  return { checkUpdates, sha1Hex };
});