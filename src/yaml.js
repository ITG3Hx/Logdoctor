(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogDoctorYaml = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY_RE = /^(\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s:#'"\[\]{},&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?))\s*:(?=\s|$)/;
  const MAX_LINES = 20000;

  // Index just past the closing quote that matches an opening quote at s[from - 1], or -1 if the line ends first.
  function closeQuote(s, from, q) {
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (q === '"') {
        if (c === '\\') { i++; continue; }
        if (c === '"') return i + 1;
      } else if (c === "'") {
        if (s[i + 1] === "'") { i++; continue; }
        return i + 1;
      }
    }
    return -1;
  }

  // Finds the mistakes that stop Bukkit from reading a config. Returns [{ line, kind, message, fix }].
  // It is deliberately cautious: anything it is not sure about is left alone.
  function lint(text) {
    const issues = [];
    const lines = String(text).split(/\r?\n/).slice(0, MAX_LINES);
    const stack = [];
    let blockIndent = -1;
    let open = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (open) {
        if (closeQuote(raw, 0, open.q) >= 0) open = null;
        continue;
      }
      const trimmed = raw.trim();
      const indent = raw.match(/^ */)[0].length;
      if (blockIndent >= 0) {
        if (!trimmed || indent > blockIndent) continue;
        blockIndent = -1;
      }
      if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') continue;
      if (/^[ ]*\t/.test(raw)) {
        issues.push({ line: i + 1, kind: 'tab', message: 'Line is indented with a tab. YAML only allows spaces.', fix: 'Replace the tab with spaces.' });
        continue;
      }
      const m = KEY_RE.exec(raw);
      const isItem = /^\s*- /.test(raw) || trimmed === '-';
      if (m && !isItem) {
        const key = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3].replace(/''/g, "'") : m[4].trim();
        while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
        if (!stack.length || stack[stack.length - 1].indent < indent) stack.push({ indent, keys: new Set() });
        const top = stack[stack.length - 1];
        if (top.keys.has(key)) issues.push({ line: i + 1, kind: 'duplicate', message: 'Key "' + key + '" appears twice at the same level. The second one makes the whole file fail to load.', fix: 'Delete or rename one of them.' });
        top.keys.add(key);
        const value = raw.slice(m[0].length).trim();
        if (/^[|>][+-]?\d*\s*(#.*)?$/.test(value)) blockIndent = indent;
        else if (value) open = checkValue(value, i + 1, issues);
      } else if (isItem) {
        while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
        const item = raw.replace(/^\s*-\s*/, '').trim();
        if (item) open = checkValue(item, i + 1, issues);
      } else if (!/:\s|:$/.test(trimmed) && /^[A-Za-z_][\w.\-]*:[^\s\/\\:]/.test(trimmed)) {
        issues.push({ line: i + 1, kind: 'colon', message: 'A space is missing after the colon, so "' + trimmed.split(':')[0] + '" is not read as a key.', fix: 'Add a space after the colon.' });
      }
    }
    if (open) issues.push({ line: open.line, kind: 'quote', message: 'A quote opened here is never closed.', fix: 'Close the quote, or remove it.' });
    return issues;
  }

  // Checks a value that starts with a quote. Returns { q, line } if the quote stays open past this line.
  function checkValue(value, line, issues) {
    const q = value[0];
    if (q !== '"' && q !== "'") return null;
    const end = closeQuote(value, 1, q);
    if (end < 0) return { q, line };
    const rest = value.slice(end).trim();
    if (rest && !rest.startsWith('#')) {
      if (q === "'") issues.push({ line, kind: 'apostrophe', message: 'An apostrophe inside a single-quoted text must be doubled (write two apostrophes).', fix: 'Double the apostrophe, or wrap the text in double quotes.' });
      else issues.push({ line, kind: 'quote', message: 'Text continues after the closing double quote.', fix: 'Escape inner quotes with a backslash, or use single quotes outside.' });
    }
    return null;
  }

  // Applies the fixes that are always safe: tabs to spaces and doubled apostrophes.
  function autofix(text) {
    const issues = lint(text);
    if (!issues.length) return null;
    const lines = String(text).split(/\r?\n/);
    let changed = false;
    for (const it of issues) {
      const i = it.line - 1;
      if (it.kind === 'tab') {
        lines[i] = lines[i].replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '  '));
        changed = true;
      } else if (it.kind === 'apostrophe') {
        const m = /^(\s*(?:-\s*)?(?:[^:'"]*:\s*)?)'(.*)'(\s*(?:#.*)?)$/.exec(lines[i]);
        if (m) {
          lines[i] = m[1] + "'" + m[2].replace(/''/g, '\u0000').replace(/'/g, "''").replace(/\u0000/g, "''") + "'" + m[3];
          changed = true;
        }
      }
    }
    return changed ? lines.join('\n') : null;
  }

  function scalar(v) {
    let s = String(v).replace(/\s+#.*$/, '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
    return s;
  }

  // paper-plugin.yml: dependencies -> server -> Name -> required
  function parsePaperDeps(lines, from) {
    const deps = [];
    let section = null;
    let i1 = null;
    let i2 = null;
    let dep = null;
    for (let k = from; k < lines.length; k++) {
      const t = lines[k].trim();
      if (!t || t.startsWith('#')) continue;
      const ind = lines[k].match(/^ */)[0].length;
      if (ind === 0) break;
      const m = /^([^:#]+):\s*(.*)$/.exec(t);
      if (!m) continue;
      const name = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (i1 === null) i1 = ind;
      if (ind === i1) { section = name; i2 = null; dep = null; }
      else if (i2 === null || ind === i2) {
        i2 = ind;
        dep = { name, required: true };
        if (section === 'server') deps.push(dep);
      } else if (dep && name === 'required') dep.required = !/false/i.test(m[2]);
    }
    return deps.filter((d) => d.required).map((d) => d.name);
  }

  // Reads the top-level fields of a plugin.yml / paper-plugin.yml that matter for the audit.
  function parsePluginYml(text) {
    const out = {};
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    let list = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
      if (top) {
        const key = top[1];
        const val = top[2].trim();
        list = null;
        if (key === 'dependencies' && val === '') {
          out.paperDeps = parsePaperDeps(lines, i + 1);
          continue;
        }
        if (val.startsWith('[')) out[key] = val.replace(/^\[|\]$/g, '').split(',').map(scalar).filter(Boolean);
        else if (val === '') { out[key] = []; list = key; }
        else out[key] = scalar(val);
        continue;
      }
      const item = /^\s*-\s+(.+)$/.exec(raw);
      if (item && list) out[list].push(scalar(item[1]));
      else if (/^\S/.test(raw)) list = null;
    }
    if (out.paperDeps) {
      out.depend = [].concat(out.depend || [], out.paperDeps);
    }
    return out;
  }

  return { lint, autofix, parsePluginYml };
});
