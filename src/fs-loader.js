'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'region', 'entities', 'poi', 'playerdata', 'stats', 'advancements', 'DIM-1', 'DIM1', 'cache', 'libraries', 'versions', 'backups', 'backup']);
const MAX_DEPTH = 6;
const MAX_FILES = 20000;

// Lists a server folder as { path, size, read } items for auditServer. Reads nothing until asked.
function loadDir(root) {
  const out = [];
  (function walk(dir, rel, depth) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(full, relPath, depth + 1);
      } else if (ent.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (e) { continue; }
        out.push({ path: relPath, size, read: async () => new Uint8Array(fs.readFileSync(full)) });
      }
    }
  })(root, '', 0);
  return out;
}

module.exports = { loadDir };