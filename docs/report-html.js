(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogDoctorReport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const where = (e) => (e.file ? e.file + (e.line ? ':' + e.line : '') : 'line ' + e.line);

  const CSS = ':root{--bg:#f6f7f5;--panel:#fff;--text:#16201a;--muted:#5b6b61;--line:#d8dfd9;--accent:#16a34a;--critical:#a21caf;--error:#dc2626;--warning:#b45309;--info:#0369a1;--ok:#16a34a}' +
    '@media(prefers-color-scheme:dark){:root{--bg:#0e1411;--panel:#151d18;--text:#e6efe9;--muted:#93a79a;--line:#26352c;--accent:#22c55e;--critical:#e879f9;--error:#f87171;--warning:#fbbf24;--info:#38bdf8;--ok:#4ade80}}' +
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}.w{max-width:820px;margin:0 auto;padding:24px 16px 56px}' +
    'h1{margin:0;font-size:1.6rem}h1 span{color:var(--accent)}.sub{color:var(--muted);margin:4px 0 18px}.v{background:var(--panel);border:1px solid var(--line);border-left:6px solid var(--ok);border-radius:12px;padding:14px 18px}' +
    '.v.critical{border-left-color:var(--critical)}.v.error{border-left-color:var(--error)}.v.warning{border-left-color:var(--warning)}.v.info{border-left-color:var(--info)}.v h2{margin:0;font-size:1.2rem}' +
    '.card{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--info);border-radius:12px;padding:12px 16px;margin-top:12px}.card.critical{border-left-color:var(--critical)}.card.error{border-left-color:var(--error)}.card.warning{border-left-color:var(--warning)}' +
    '.card h3{margin:0;font-size:1.02rem}.sev{font-size:.7rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-right:8px;color:var(--muted)}.card p{margin:6px 0 0}.fx{margin:10px 0 2px;font-size:.78rem;font-weight:700;text-transform:uppercase;color:var(--accent);letter-spacing:.06em}' +
    'ul,ol{margin:2px 0 0;padding-left:20px}pre{margin:8px 0 0;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;overflow-x:auto;font:12px/1.5 ui-monospace,Consolas,monospace}.m{color:var(--muted);font-size:.9rem}h4{margin:22px 0 4px;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--accent)}' +
    'table{border-collapse:collapse;width:100%;margin-top:6px;font-size:.92rem}td,th{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left}.foot{margin-top:30px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}';

  function finding(f) {
    let h = '<div class="card ' + esc(f.severity) + '"><h3><span class="sev">' + esc(f.severity) + '</span>' + esc(f.title) + (f.count > 1 ? ' <span class="m">x' + f.count + '</span>' : '') + '</h3>';
    if (f.sideEffectOf) h += '<p class="m">Probably caused by ' + esc(f.sideEffectOf) + '.</p>';
    if (f.summary) h += '<p>' + esc(f.summary) + '</p>';
    if (f.fix && f.fix.length) h += '<div class="fx">How to fix</div><ul>' + f.fix.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul>';
    if (f.evidence && f.evidence.length) h += '<pre>' + f.evidence.map((e) => esc(where(e) + '  ' + e.text)).join('\n') + '</pre>';
    return h + '</div>';
  }

  // One self-contained page with no scripts and no external files. Safe to attach in Discord or email.
  function toHtml(result, opts) {
    const o = opts || {};
    const i = result.info || {};
    const bits = [i.software, i.modLoader, i.mcVersion && 'Minecraft ' + i.mcVersion, i.java && 'Java ' + i.java, i.plugins && i.plugins.length && i.plugins.length + ' plugins'].filter(Boolean);
    let body = '<h1>Log<span>Doctor</span> report</h1><div class="sub">' + esc(bits.join('  |  ')) + (o.date ? '  |  ' + esc(o.date) : '') + '</div>';
    body += '<div class="v ' + esc(result.verdictLevel) + '"><h2>' + esc(result.verdict) + '</h2></div>';
    if (result.plan && result.plan.length) {
      body += '<h4>Start here</h4><ol>' + result.plan.map((p) => '<li>' + esc(p.title) + (p.reason ? ' <span class="m">' + esc(p.reason) + '</span>' : '') + '</li>').join('') + '</ol>';
    }
    if (result.compat) {
      const c = result.compat;
      body += '<h4>Upgrade check for Minecraft ' + esc(c.target) + ' (Java ' + c.java + ')</h4><table><tr><th>Plugin</th><th>Status</th><th>Why</th></tr>' +
        c.rows.map((r) => '<tr><td>' + esc(r.name) + ' ' + esc(r.version) + '</td><td>' + esc(r.status) + '</td><td>' + esc(r.reason) + '</td></tr>').join('') + '</table>';
    }
    const main = result.findings.filter((f) => !f.sideEffectOf && f.severity !== 'info');
    const side = result.findings.filter((f) => f.sideEffectOf);
    const notes = result.findings.filter((f) => !f.sideEffectOf && f.severity === 'info');
    body += '<h4>Findings</h4>' + (main.map(finding).join('') || '<p class="m">Nothing needs fixing.</p>');
    if (side.length) body += '<h4>Likely side effects</h4>' + side.map(finding).join('');
    if (notes.length) body += '<h4>Notes</h4>' + notes.map(finding).join('');
    if (o.contact) body += '<div class="foot">' + esc(o.contact) + '</div>';
    body += '<div class="foot">Made with LogDoctor. Everything in this file was produced on the reader\'s own machine.</div>';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LogDoctor report</title><style>' + CSS + '</style></head><body><div class="w">' + body + '</div></body></html>';
  }

  return { toHtml };
});