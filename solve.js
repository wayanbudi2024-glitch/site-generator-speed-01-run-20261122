// Faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// A from-scratch reimplementation of makefun-site's build that returns the
// same output tree byte for byte, but faster. Same pipeline, same rules
// (front matter, template dialect, Markdown subset, slug rule, report),
// reworked for speed:
//
//   - Markdown: the lexer and renderer are fused into one pass over the
//     lines, and the inline scanner escapes literal text in bulk instead
//     of one regex replace per character.
//   - Slugs are memoised per case (titles, tag names and heading texts
//     repeat a lot), as are the cards of every post and the header, nav,
//     footer and head partials that render identically across pages.
//   - Templates are compiled once per case into plain JavaScript functions
//     (no interpreter dispatch, no scope-chain walk at render time), with
//     a flat scope object whose loop bindings are saved and restored.
//   - Front matter is found by searching for the closing line instead of
//     splitting and re-joining the whole body.
//
// No network, no clock, no randomness: the output is a function of the
// input alone, and two runs on the same input return the same bytes.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const SPECIAL = /[&<>"']/;
const SPECIAL_G = /[&<>"']/g;

/** `text` with & < > " and ' escaped; the common no-specials case returns it as is. */
function esc(text) {
  return SPECIAL.test(text) ? text.replace(SPECIAL_G, (c) => ESCAPES[c]) : text;
}

/** Escape the slice s[a, b) of `s` into `out`, without building the slice first. */
function pushEsc(s, a, b, out) {
  const t = s.slice(a, b);
  out.push(SPECIAL.test(t) ? t.replace(SPECIAL_G, (c) => ESCAPES[c]) : t);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, memoised in `cache` (per case). */
function slugify(text, cache) {
  let out = cache.get(text);
  if (out !== undefined) return out;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let s = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = s.length > 0;
      continue;
    }
    if (gap) s += '-';
    gap = false;
    s += keep;
  }
  s = s.slice(0, SLUG_MAX).replace(/-+$/, '');
  out = s === '' ? 'untitled' : s;
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The closing line
 * is found by search, so the body is never split and re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeStart = -1;
  let closeEnd = -1;
  const idx = text.indexOf('\n---\n', 3);
  if (idx !== -1) {
    closeStart = idx + 1;
    closeEnd = idx + 5;
  } else if (text.endsWith('\n---')) {
    closeStart = text.length - 3;
    closeEnd = text.length;
  } else return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeStart);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape and inside [from, hi), or -1. A closer is escaped exactly when an
 * odd run of backslashes stands right before it (the run counted inside
 * [from, j), as the reference's left-to-right scan sees it).
 */
function findUnesc(s, what, from, hi) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= hi) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s[k] === '\\') {
      n++;
      k--;
    }
    if ((n & 1) === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape and inside [from, hi), or -1. */
function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s[k] === '\\') {
      n++;
      k--;
    }
    if ((n & 1) === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < hi && s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[lo, hi)` rendered inline into `out`; `env.link(target)` is a link's
 * href. It jumps from one inline mark to the next with native searches
 * instead of walking every character, and literal text between marks is
 * escaped in bulk.
 */
function inlineRange(s, lo, hi, env, out) {
  let lit = lo;
  let i = lo;
  while (i < hi) {
    let nx = hi;
    let j;
    j = s.indexOf('\\', i);
    if (j !== -1 && j < nx) nx = j;
    j = s.indexOf('`', i);
    if (j !== -1 && j < nx) nx = j;
    j = s.indexOf('*', i);
    if (j !== -1 && j < nx) nx = j;
    j = s.indexOf('[', i);
    if (j !== -1 && j < nx) nx = j;
    if (nx === hi) break;
    i = nx;
    const c = s[i];
    if (c === '\\' && i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
      if (lit < i) pushEsc(s, lit, i, out);
      const e = s[i + 1];
      out.push(e === '>' ? '&gt;' : e);
      i += 2;
      lit = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < hi && k > i + 1) {
        if (lit < i) pushEsc(s, lit, i, out);
        out.push('<code>');
        pushEsc(s, i + 1, k, out);
        out.push('</code>');
        i = k + 1;
        lit = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const k = findUnesc(s, '**', i + 2, hi);
        if (k !== -1 && k > i + 2) {
          if (lit < i) pushEsc(s, lit, i, out);
          out.push('<strong>');
          inlineRange(s, i + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
          lit = i;
        } else i += 2;
        continue;
      }
      const k = findSingleStar(s, i + 1, hi);
      if (k !== -1 && k > i + 1) {
        if (lit < i) pushEsc(s, lit, i, out);
        out.push('<em>');
        inlineRange(s, i + 1, k, env, out);
        out.push('</em>');
        i = k + 1;
        lit = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnesc(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m === -1 || m >= hi) m = -1;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (lit < i) pushEsc(s, lit, i, out);
        out.push('<a href="', esc(env.link(target)), '">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        lit = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (lit < hi) pushEsc(s, lit, hi, out);
}

/** `s` rendered inline, as a string. */
function inlineStr(s, env) {
  if (s.indexOf('\\') === -1 && s.indexOf('`') === -1 && s.indexOf('*') === -1 && s.indexOf('[') === -1) return esc(s);
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/** A line of only spaces and tabs (or empty). */
function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let j = n;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e <= j) return null;
  return { depth: n, text: line.slice(j, e) };
}

/** A fence opening: its language, or null. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    j++;
  }
  const langEnd = j;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? line.slice(3, langEnd) : null;
}

/** A fence closing line, or a thematic break, or null. */
function fenceCloseOrHr(line) {
  if (line.startsWith('```')) {
    for (let j = 3; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) return 0;
    }
    return 1;
  }
  if (line.startsWith('---') || line.startsWith('***')) {
    for (let j = 3; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) return 0;
    }
    return 2;
  }
  return 0;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || fenceCloseOrHr(line) === 2;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or
 * ""). The lexer and the renderer run in one pass over the lines.
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && fenceCloseOrHr(lines[i]) !== 1) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      const code = body.length === 0 ? '' : esc(body.join('\n') + '\n');
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (fenceCloseOrHr(line) === 2) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = body.map(trimST).filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const c0 = line.charCodeAt(0);
    const bullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    let ordered = false;
    let start = 1;
    if (!bullet && c0 >= 48 && c0 <= 57) {
      let d = 0;
      while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        start = Number(line.slice(0, d));
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (ordered) {
          let d = 0;
          while (d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) {
            items.push([trimST(l.slice(d + 2))]);
            i++;
            continue;
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push([trimST(l.slice(2))]);
          i++;
          continue;
        }
        if (/^ {2,}\S/.test(l)) {
          items[items.length - 1].push(trimST(l));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inlineStr(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const text = body.join('\n');
    const html = inlineStr(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the flat scope `S`: its first name from `S`, then own properties. */
function lk(S, path) {
  let v = S[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A path rendered by compiled code: one segment reads straight from the
 * flat scope; two segments go through lk2; longer ones through lk.
 */
function lk2(v, b) {
  return v === null || typeof v !== 'object' || !Object.hasOwn(v, b) ? undefined : v[b];
}

/** Code for the value at `path` in scope S. */
function pathCode(path) {
  if (path.length === 1) return `S[${JSON.stringify(path[0])}]`;
  if (path.length === 2) return `C.lk2(S[${JSON.stringify(path[0])}],${JSON.stringify(path[1])})`;
  return `C.lk(S,${JSON.stringify(path)})`;
}

/** JavaScript source for `nodes` appended to `code` (S scope, O output array, C context, D include depth). */
function compileNodes(nodes, code) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        code.push(`O.push(${JSON.stringify(n.text)});`);
        break;
      case 'var':
        code.push(`O.push(C.esc(C.textOf(${pathCode(n.path)})));`);
        break;
      case 'raw':
        code.push(`O.push(C.textOf(${pathCode(n.path)}));`);
        break;
      case 'if': {
        const cond = `C.truthy(${pathCode(n.path)})`;
        code.push(`if(${cond}!==${n.not}){`);
        compileNodes(n.then, code);
        if (n.else !== null) {
          code.push('}else{');
          compileNodes(n.else, code);
        }
        code.push('}');
        break;
      }
      case 'for': {
        const nm = JSON.stringify(n.name);
        code.push(`{const _xs=${pathCode(n.path)};if(Array.isArray(_xs)){const _sv=S[${nm}],_sl=S.loop;for(let _k=0;_k<_xs.length;_k++){const _x=_xs[_k];S[${nm}]=_x;S.loop={index:_k+1,first:_k===0,last:_k===_xs.length-1,length:_xs.length};`);
        compileNodes(n.body, code);
        code.push(`}S[${nm}]=_sv;S.loop=_sl;}}`);
        break;
      }
      case 'include':
        code.push(`C.inc(C,${JSON.stringify(n.name)},S,O,D);`);
        break;
    }
  }
}

/** A parsed template compiled to a function (S scope, O output, C context, D depth). */
function compileTemplate(nodes) {
  const code = [];
  compileNodes(nodes, code);
  return new Function('S', 'O', 'C', 'D', code.join(''));
}

/**
 * An include, with memoisation. `header` and `nav` read only the site and
 * the recent list, so they render once per case; `head` and `footer` read
 * the page's title (and date) too, so they are keyed on those; a `card`
 * reads only its post, so it is keyed on the post's card object.
 */
function inc(C, name, S, O, D) {
  if (D >= INCLUDE_DEPTH) return;
  const fn = C.fns.get(name);
  if (fn === undefined) return;
  // Memoised renders are only reused at the depth they were computed at:
  // every layout includes these partials at depth 0, and their subtrees
  // never approach the depth limit, so a depth-0 render is depth-free.
  if (D === 0 && (name === 'header' || name === 'nav')) {
    let s = C.memo.get(name);
    if (s === undefined) {
      const o = [];
      fn(S, o, C, D + 1);
      s = o.join('');
      C.memo.set(name, s);
    }
    O.push(s);
    return;
  }
  if (D === 0 && name === 'head') {
    const pg = S.page;
    const tg = S.tag;
    const key = `head\0${JSON.stringify([pg ? pg.title : null, tg ? tg.name : null])}`;
    let s = C.memo.get(key);
    if (s === undefined) {
      const o = [];
      fn(S, o, C, D + 1);
      s = o.join('');
      C.memo.set(key, s);
    }
    O.push(s);
    return;
  }
  if (D === 0 && name === 'footer') {
    const pg = S.page;
    const key = `footer\0${JSON.stringify([pg ? pg.title : null, pg ? pg.date : null, pg ? pg.date_long : null])}`;
    let s = C.memo.get(key);
    if (s === undefined) {
      const o = [];
      fn(S, o, C, D + 1);
      s = o.join('');
      C.memo.set(key, s);
    }
    O.push(s);
    return;
  }
  if (D === 0 && name === 'card') {
    const p = S.p;
    if (p !== null && typeof p === 'object') {
      let s = C.cardCache.get(p);
      if (s === undefined) {
        const o = [];
        fn(S, o, C, D + 1);
        s = o.join('');
        C.cardCache.set(p, s);
      }
      O.push(s);
      return;
    }
  }
  fn(S, O, C, D + 1);
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
function build(input) {
  const C = {
    slugCache: new Map(),
    fns: new Map(),
    memo: new Map(),
    cardCache: new Map(),
    esc,
    textOf,
    truthy,
    lk,
    lk2,
    inc,
  };
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      C.fns.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths; a source that is
  //    not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and
  //    dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!C.fns.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its
  //    directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, C.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  //    files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, C.slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and
  //    older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  //    posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name, C.slugCache)) && seen.add(slugify(name, C.slugCache)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, C.slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, C.slugCache)) ?? { name, slug: slugify(name, C.slugCache), url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  //    through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => {
    const c = cardOf(s);
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc;
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    const fn = C.fns.get(name);
    if (fn === undefined) return null;
    const env = Object.create(null);
    env.site = site;
    env.tags = allTags;
    env.recent = recent;
    Object.assign(env, vars);
    const out = [];
    fn(env, out, C, 0);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  //    not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
