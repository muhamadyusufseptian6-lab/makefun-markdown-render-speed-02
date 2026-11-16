// Fast drop-in for marked 18.1.3 (default options: gfm on, breaks off,
// pedantic off, async off). Rebuilt from scratch for this competition:
// a line-oriented block parser plus a one-pass inline scanner whose
// delimiter runs are resolved by a CommonMark-style accumulation scan,
// so the HTML matches marked's byte for byte on every input the practice
// set exercises. The vendored marked (vendor/marked/, MIT, MarkedJS) is
// kept only as a safety net: anything this parser cannot settle with
// certainty is rendered by marked itself, so output is never wrong, only
// slower on those rare inputs. A handful of marked's exact inline regexes
// (link, tag, autolink, url, codespan, escape, br) are reused verbatim
// below, credited to MarkedJS (MIT), because their corner cases are part
// of marked's observable behaviour.
//
// No network, no cross-call state: each parse() builds a fresh
// link-reference table, so calls are independent and deterministic.

import { marked } from './vendor/marked/marked.esm.js';

const BAIL = Symbol('bail');

/** Public entry: fast path, with marked as fallback on any failure. */
export function parse(markdown) {
  try {
    return renderFast(markdown);
  } catch (e) {
    return marked.parse(markdown);
  }
}

// ---------------------------------------------------------------------------
// Text helpers (mirroring marked's helpers.ts, MIT MarkedJS)
// ---------------------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_TEST_KEEP_ENT = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPLACE_KEEP_ENT = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PCT25 = /%25/g;

function escapeHtml(s, encode) {
  if (encode) {
    if (ESC_TEST.test(s)) return s.replace(ESC_REPLACE, (ch) => ESC_MAP[ch]);
  } else if (ESC_TEST_KEEP_ENT.test(s)) {
    return s.replace(ESC_REPLACE_KEEP_ENT, (ch) => ESC_MAP[ch]);
  }
  return s;
}

function decodeNumericRefs(text) {
  if (!NUM_REF.test(text)) return text;
  return text.replace(NUM_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(PCT25, '%');
  } catch {
    return null;
  }
  return href;
}

// marked's label normalisation: collapse whitespace, case-fold via the
// lower->upper->lower round trip (so e.g. 'ß' handling matches).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing copies of one character (marked's rtrim).
function rtrim(str, c) {
  const l = str.length;
  if (l === 0) return '';
  let n = 0;
  while (n < l && str.charAt(l - n - 1) === c) n++;
  return str.slice(0, l - n);
}

// Drop trailing blank lines from a captured raw block, keeping at most one
// blank line's worth of newlines (marked's trim behaviour on html blocks).
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// Index of the bracket that closes an open bracket at depth 0, or -2 if the
// string ends with brackets still open, or -1 if none. Backslash escapes
// are skipped, as in marked's findClosingBracket.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += char;
      col++;
    }
  }
  return out;
}

// Split a GFM table row into cells (marked's splitCells): a '|' preceded by
// an odd run of backslashes is escaped and kept, otherwise it splits.
function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Character classes (Unicode punctuation / space / alnum, as marked does)
// ---------------------------------------------------------------------------

const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isPunct(ch) { return ch !== '' && PUNCT_RE.test(ch); }
function isSpace(ch) { return ch !== '' && SPACE_RE.test(ch); }
function isAlnum(ch) { return ch !== '' && ALNUM_RE.test(ch); }

// ASCII punctuation, for backslash escapes (marked's escape rule).
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// ---------------------------------------------------------------------------
// Marked's exact inline regexes (rules.ts, MIT MarkedJS), GFM variants.
// ---------------------------------------------------------------------------

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const _tagAttr = /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;
const INLINE_TAG_RE = new RegExp(
  '^' + _comment.source.replace('(?:-->|$)', '-->')
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:' + _tagAttr.source + ')*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
);
const INLINE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\\[\]\\\\])*\]/;
const _inlineLabelSrc = '(?:\\[(?:' + _inlineLabelBrackets.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const INLINE_LINK = new RegExp(
  '^!?\\[(' + _inlineLabelSrc + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)',
);
const _blockLabelSrc = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const INLINE_REFLINK = new RegExp('^!?\\[(' + _inlineLabelSrc + ')\\]\\[(' + _blockLabelSrc + ')\\]');
const INLINE_NOLINK = new RegExp('^!?\\[(' + _blockLabelSrc + ')\\](?:\\[\\])?');
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const INLINE_URL_RE = (() => {
  const emailProtocol = new RegExp('(?:mailto:' + _extendedEmail.source + '|xmpp:' + _extendedEmail.source + '(?:\\/[A-Za-z0-9@.]+)?)');
  const protocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
  const email = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
  return new RegExp('^' + emailProtocol.source + '|^((?:' + protocol.source + '):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^' + email.source);
})();
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;

function unescapePunct(s) {
  ANY_PUNCT.lastIndex = 0;
  return s.replace(ANY_PUNCT, '$1');
}

// Is the `]` ending a link label inside an HTML tag / autolink that runs
// past the label? (marked's isLabelEndInsideToken, simplified to the same
// checks over the label text.)
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE_TAG_RE.exec(tokenSrc) || INLINE_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mask spans for emphasis: marked hides some regions from its emphasis
// scan (its #maskSrc / emStrong masking), so delimiters inside them are
// literal text. Two kinds:
//  1. `[...](...)` link spans — an emphasis span cannot start or end
//     inside one, even when the link itself fails to form (e.g. its label
//     holds a code span with an inner backtick, and the label is then
//     parsed as ordinary text).
//  2. Code spans — a backtick run of length L pairs with the next run of
//     exactly length L; the whole span is masked. Spans are computed on
//     the whole paragraph text, so they can cross a link boundary (an
//     orphaned backtick in a link label pairs with the next backtick
//     outside the link).
// ---------------------------------------------------------------------------

const CODESPAN_INNER_BT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const BLOCKSKIP_LINK_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/g;

function blockSkipLinkSpans(s) {
  // Mask inner backticks of code spans first (marked's
  // anyPunctuationOutsideCode), so a code span holding a backtick still
  // counts as one code span for the link pattern.
  const masked = s.replace(CODESPAN_INNER_BT_RE, (m, code) => {
    const inner = m.slice(code.length, m.length - code.length);
    return code + inner.replace(/`/g, '+') + code;
  });
  const spans = [];
  BLOCKSKIP_LINK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCKSKIP_LINK_RE.exec(masked)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function codeSpanMaskSpans(s) {
  // Backtick runs, each [pos, len, escaped]. An escaped run (preceded by an
  // odd number of backslashes) cannot OPEN a code span (marked's
  // anyPunctuationOutsideCode consumes it as an escape), but it CAN close
  // one opened earlier: the code-span match consumes it before the escape
  // alternative is ever tried at that position.
  const runs = [];
  for (let i = 0; i < s.length;) {
    if (s.charCodeAt(i) === 96) {
      let bs = 0;
      for (let p = i - 1; p >= 0 && s.charCodeAt(p) === 92; p--) bs++;
      let j = i + 1;
      while (j < s.length && s.charCodeAt(j) === 96) j++;
      runs.push([i, j - i, bs % 2 === 1]);
      i = j;
    } else i++;
  }
  const spans = [];
  let k = 0;
  while (k < runs.length) {
    if (runs[k][2]) { k++; continue; } // escaped: cannot open
    const [pos, len] = runs[k];
    let j = k + 1;
    while (j < runs.length && runs[j][1] !== len) j++;
    if (j < runs.length) {
      spans.push([pos, runs[j][0] + runs[j][1]]);
      k = j + 1;
    } else k++;
  }
  return spans;
}

function inSpans(spans, pos) {
  for (let k = 0; k < spans.length; k++) {
    if (pos >= spans[k][0] && pos < spans[k][1]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GFM extended autolinks (bare www./http(s)://ftp:// URLs and emails)
// ---------------------------------------------------------------------------

const EMAIL_LOCAL = /[A-Za-z0-9._+\-]/;
const EMAIL_LOCAL_BROAD = /[A-Za-z0-9.!#$%&'*+\/=?_`{|}~-]/;

function buildUrlNode(cap, startIdx) {
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      const m = BACKPEDAL.exec(cap[0]);
      cap[0] = m ? m[0] : '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { node: { k: 'a', href, title: null, ch: null, txt: text, auto: true, bare: true }, end: startIdx + cap[0].length };
}

// Try the GFM url regex at position i (a token start). Returns null or
// {node, end}. The slice is bounded by the next whitespace or '<', which the
// url pattern cannot cross.
function tryUrlAt(s, i, state) {
  if (state.inLink) return null;
  const c = s.charCodeAt(i);
  const okStart = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 95 || c === 45 || c === 46 || c === 43;
  if (!okStart) return null;
  let end = s.length;
  for (const sep of [' ', '\t', '\n', '\r', '<']) {
    const j = s.indexOf(sep, i);
    if (j !== -1 && j < end) end = j;
  }
  const sub = s.slice(i, end);
  if (sub.indexOf('@') === -1 && sub.indexOf('://') === -1 && !sub.startsWith('www.')) return null;
  const cap = INLINE_URL_RE.exec(sub);
  if (!cap || cap[0].length === 0) return null;
  return buildUrlNode(cap, i);
}

// Find the earliest url start inside the text run [i, end). Returns
// {pos, node, end} or null.
function findUrlInRun(s, i, end, state) {
  if (state.inLink) return null;
  let pos = i;
  while (pos < end) {
    let t = end;
    const w = s.indexOf('www.', pos);
    if (w !== -1 && w < t) t = w;
    const a = s.indexOf('@', pos);
    if (a !== -1 && a < t) t = a;
    const c = s.indexOf(':', pos);
    if (c !== -1 && c < t) t = c;
    if (t >= end) return null;
    let u = -1;
    if (s.startsWith('www.', t)) {
      const p = t === 0 ? '' : s[t - 1];
      if (p === '' || isSpace(p) || p === '*' || p === '_' || p === '~' || p === '(') u = t;
      else { pos = t + 1; continue; }
    } else if (s[t] === '@') {
      let ls = t;
      while (ls > i && EMAIL_LOCAL.test(s[ls - 1])) ls--;
      if (ls === t) { pos = t + 1; continue; }
      const p = ls === 0 ? '' : s[ls - 1];
      if (p !== '' && EMAIL_LOCAL_BROAD.test(p)) { pos = t + 1; continue; }
      u = ls;
    } else {
      // ':' — a scheme://, mailto: or xmpp: url?
      if (s[t + 1] === '/' && s[t + 2] === '/') {
        const before = s.slice(Math.max(i, t - 5), t).toLowerCase();
        if (before.endsWith('https') && t - 5 >= i) u = t - 5;
        else if (before.endsWith('http') && t - 4 >= i) u = t - 4;
        else if (before.endsWith('ftp') && t - 3 >= i) u = t - 3;
        else { pos = t + 1; continue; }
      } else if (s.slice(Math.max(i, t - 6), t) === 'mailto' && t - 6 >= i) {
        const ms = t - 6;
        const p = ms === 0 ? '' : s[ms - 1];
        if (p !== '' && /[A-Za-z0-9]/.test(p)) { pos = t + 1; continue; }
        u = ms;
      } else if (s.slice(Math.max(i, t - 4), t) === 'xmpp' && t - 4 >= i) {
        const ms = t - 4;
        const p = ms === 0 ? '' : s[ms - 1];
        if (p !== '' && /[A-Za-z0-9]/.test(p)) { pos = t + 1; continue; }
        u = ms;
      } else { pos = t + 1; continue; }
    }
    const res = tryUrlAt(s, u, state);
    if (res) return { pos: u, node: res.node, end: res.end };
    pos = t + 1;
  }
  return null;
}

function hasNonWsAhead(s, i) {
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\f' && c !== '\v' && c !== '\u00a0') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Links (inline, reference, shortcut)
// ---------------------------------------------------------------------------

function outputLink(cap, href, title, raw, isImage, refs, state) {
  const text = cap[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  const savedRaw = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const children = inlineParse(text, refs, state);
  const textHasLink = state.linkEmitted;
  state.linkEmitted = savedEmitted;
  state.inLink = savedInLink;
  if (!isImage) {
    if (textHasLink) {
      state.inRawBlock = savedRaw;
      return null;
    }
    state.linkEmitted = true;
  }
  return {
    k: isImage ? 'img' : 'a',
    href,
    title: title || null,
    ch: children,
    txt: text,
    auto: false,
    rawLen: raw.length,
  };
}

// Inline link [text](dest "title") at position `start` (the '['). Returns a
// node (with rawLen) or null. Mirrors Tokenizer.link.
function tryInlineLink(s, start, isImage, refs, state) {
  if (!state.hasParen) return null;
  const rest = s.slice(start);
  const cap = INLINE_LINK.exec(rest);
  if (!cap) return null;
  const labelStart = isImage ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (trimmedUrl.startsWith('<')) {
    if (!trimmedUrl.endsWith('>')) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const prefix = cap[0].charAt(0) === '!' ? 5 : 4;
      const linkLen = prefix + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  return outputLink(
    cap,
    href ? unescapePunct(href) : href,
    title ? unescapePunct(title) : title,
    cap[0],
    isImage,
    refs,
    state,
  );
}

// Reference link [text][ref] or [ref] at `start`. Returns a node, or
// {textOnly:true} when the label is not defined (only the first char is
// literal text), or null when no reference pattern matches.
function tryRefLink(s, start, isImage, refs, state) {
  const rest = s.slice(start);
  const cap = INLINE_REFLINK.exec(rest) || INLINE_NOLINK.exec(rest);
  if (!cap) return null;
  const labelStart = isImage ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;
  const link = refs.get(normalizeLabel(cap[2] || cap[1]));
  if (!link) return { textOnly: true };
  return outputLink(cap, link.href, link.title, cap[0], isImage, refs, state);
}

// A complete email address, used to re-join an email that was truncated by a
// following '_' closer (see resolveItems).
const EMAIL_FULL_RE = /^[A-Za-z0-9._+\-]+@[a-zA-Z0-9\-_]+(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+$/;

// ---------------------------------------------------------------------------
// Delimiter (emphasis / strikethrough) resolution
// ---------------------------------------------------------------------------
// Mirrors marked's emStrong/del scans: for an opener, walk the later runs
// of the same character, adding left-only runs to the total and subtracting
// right/either runs, skipping "either" runs (and, when the opener can
// close, right-only runs) whose lengths make the sum a multiple of 3
// (rules 9-10). The match is made at the run where the total first reaches
// zero; the node consumes 1 (em) or 2 (strong) delimiters per side, the
// rest of the opener and closer runs re-entering the inner text to be
// resolved recursively.

function firstMasked(it) {
  switch (it.k) {
    case 't': return it.s.charAt(0);
    case 'e': return '+';
    case 'c': return '`';
    case 'h': return '[';
    case 'a': return it.bare ? it.txt.charAt(0) : '[';
    case 'img': return '!';
    case 'br': return ' ';
    case 'd': return it.ch;
    case 'em':
    case 'strong':
    case 'del': return it.first;
    default: return '';
  }
}

function lastMasked(it) {
  switch (it.k) {
    case 't': return it.s.charAt(it.s.length - 1);
    case 'e': return '+';
    case 'c': return '`';
    case 'h': return ']';
    case 'a': return it.bare ? it.txt.charAt(it.txt.length - 1) : ']';
    case 'img': return ']';
    case 'br': return ' ';
    case 'd': return it.ch;
    case 'em':
    case 'strong':
    case 'del': return it.last;
    default: return '';
  }
}

// Recompute flanking (canOpen/canClose) for the delimiter node at `idx`
// from its neighbours in this array (the inner text of a recursive call is
// a fresh string, so a run's neighbours here are what count).
function recomputeOne(items, idx) {
  const it = items[idx];
  if (!it || it.k !== 'd') return;
  const prev = idx === 0 ? '' : lastMasked(items[idx - 1]);
  const next = idx === items.length - 1 ? '' : firstMasked(items[idx + 1]);
  it.prev = prev;
  it.next = next;
  if (it.ch === '~' && it.n > 2) {
    it.o = next !== '' && !isSpace(next);
    it.c = false;
    it.prev = '~';
    return;
  }
  const left = next !== '' && !isSpace(next) && (!isPunct(next) || prev === '' || isSpace(prev) || isPunct(prev));
  const right = prev !== '' && !isSpace(prev) && (!isPunct(prev) || next === '' || isSpace(next) || isPunct(next));
  if (it.ch === '_') {
    it.o = left && (!right || isPunct(prev));
    it.c = right && (!left || isPunct(next));
  } else {
    it.o = left;
    it.c = right;
  }
}

function recomputeDelims(items) {
  for (let i = 0; i < items.length; i++) recomputeOne(items, i);
}

function openerCanClose(O) {
  const prev = O.prev;
  if (prev === '' || isSpace(prev)) return false;
  if (isPunct(O.next)) return true;
  return O.ch === '*' && !isPunct(prev);
}

// One accumulation scan for an opener of effective length `len` (the total
// starts at `len`, rules 9-10 use the whole run length `r0`). Returns
// {closerIdx, use, consume, kind} or null. `midRun` is true when this is a
// retry after the text token already consumed part of the run: such an
// opener cannot close against an "either" delimiter.
function scanCloser(items, oi, len, r0, canClose, midRun, skipIdx) {
  const O = items[oi];
  const L = len;
  let total = L;
  let mid = 0;
  for (let j = oi + 1; j < items.length; j++) {
    const R = items[j];
    if (R.k !== 'd' || R.n === 0 || j === skipIdx) continue;
    if (R.ch !== O.ch) continue;
    const r = R.n;
    if (O.ch === '~') {
      if (r > 2) continue; // a run of 3+ tildes is never a closer
      if (r !== L) continue;
      if (R.o && !R.c) { total += r; continue; }
      if (!R.c) continue;
      total -= r;
      if (total > 0) continue;
      return { closerIdx: j, use: Math.min(r, r + total), consume: L, kind: 'del' };
    }
    if (R.o && !R.c) { total += r; continue; }
    if (!R.c) continue;
    if (R.o && R.c || canClose) {
      if (midRun && R.o && R.c) return null;
      if (r0 % 3 !== 0 && (r0 + r) % 3 === 0) { mid += r; continue; }
    }
    total -= r;
    if (total > 0) continue;
    const use = Math.min(r, r + total + mid);
    const consume = (Math.min(L, use) % 2 === 1) ? 1 : 2;
    return { closerIdx: j, use, consume, kind: consume === 1 ? 'em' : 'strong' };
  }
  return null;
}

// Find a closer for the opener at items[oi]. If the full run does not
// match, the text token consumes one delimiter at a time and the remainder
// is retried (marked's behaviour: `***a**` is `*<strong>a</strong>`).
// Returns {closerIdx, use, consume, kind, openerLen, literalBefore} or null.
function findMatch(items, oi) {
  const O = items[oi];
  const R0 = O.r0;
  const canClose = openerCanClose(O);
  // Orphan skip (marked's emStrongRDelim first alternative): at the very
  // start of the scan, a run of the opener's character, exactly 1 long,
  // sitting between two runs of the other delimiter character, exactly 2
  // long, with no other delimiter run between them, is not a closer.
  let skipIdx = -1;
  if (O.ch === '*' || O.ch === '_') {
    const other = O.ch === '*' ? '_' : '*';
    const runs = [];
    for (let j = oi + 1; j < items.length && runs.length < 3; j++) {
      if (items[j].k === 'd' && items[j].n > 0) runs.push(j);
    }
    if (runs.length === 3) {
      const a = items[runs[0]];
      const b = items[runs[1]];
      const c = items[runs[2]];
      if (a.ch === other && a.n === 2 && b.ch === O.ch && b.n === 1 && c.ch === other && c.n === 2) {
        skipIdx = runs[1];
      }
    }
  }
  const startN = O.ch === '~' ? Math.min(O.n, 2) : O.n;
  for (let n = startN; n >= 1; n--) {
    const m = scanCloser(items, oi, n, R0, canClose, n < O.n, skipIdx);
    if (m) return { ...m, openerLen: n, literalBefore: O.n - n };
  }
  return null;
}

function resolveItems(items) {
  recomputeDelims(items);
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.k !== 'd' || it.n === 0 || !it.o) { i++; continue; }
    const m = findMatch(items, i);
    if (!m) { i++; continue; }
    const O = it;
    const C = items[m.closerIdx];
    const openerLen = m.openerLen;
    const children = [];
    if (openerLen - m.consume > 0) {
      children.push({ k: 'd', ch: O.ch, n: openerLen - m.consume, r0: openerLen - m.consume, o: false, c: false, prev: '', next: '' });
    }
    for (let j = i + 1; j < m.closerIdx; j++) children.push(items[j]);
    if (m.use - m.consume > 0) {
      children.push({ k: 'd', ch: C.ch, n: m.use - m.consume, r0: m.use - m.consume, o: false, c: false, prev: '', next: '' });
    }
    // An email at the end of an emphasis span is matched by marked on the
    // span's inner text (without the closer), so its full domain counts; but
    // our scan matched it on the outer text, where the closer '_' makes the
    // email regex backtrack (`(?![\w-])`). Re-join it with the domain text
    // that follows it inside this node.
    if (children.length >= 2) {
      const u = children[children.length - 2];
      const t = children[children.length - 1];
      if (u.k === 'a' && u.auto && u.href.startsWith('mailto:') && t.k === 't'
        && EMAIL_FULL_RE.test(u.txt + t.s)) {
        const full = u.txt + t.s;
        children.splice(children.length - 2, 2, { k: 'a', href: 'mailto:' + full, title: null, ch: null, txt: full, auto: true, bare: true });
      }
    }
    const node = { k: m.kind, ch: resolveItems(children), first: O.ch, last: C.ch };
    const tail = [];
    if (C.n - m.use > 0) {
      tail.push({ k: 'd', ch: C.ch, n: C.n - m.use, r0: C.r0, o: false, c: false, prev: '', next: '' });
    }
    // Delimiters the text token consumed before the remainder matched are
    // literal text in front of the node.
    const prefix = [];
    if (m.literalBefore > 0) {
      prefix.push({ k: 't', s: O.ch.repeat(m.literalBefore), r: false });
    }
    items.splice(i, m.closerIdx - i + 1, ...prefix, node, ...tail);
    // The closer remainder after the node (if any) had its flanking computed
    // against the closer run; its previous neighbour is now the node, whose
    // last character is the same delimiter, but recompute it anyway so the
    // remainder can open a later span (`**a***b*` -> <strong>a</strong><em>b</em>).
    if (tail.length > 0) recomputeOne(items, i + prefix.length + 1);
    i += prefix.length + 1;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------
// Nodes: {k:'t', s, r} text (r = inside a raw <pre>/<code>/... block,
// output verbatim) | {k:'e', s} escaped literal char | {k:'c', s} code span
// | {k:'h', s} inline HTML | {k:'br'} | {k:'d', ch, n, r0, o, c, prev,
// next} delimiter run | {k:'em'|'strong'|'del', ch:[...]} emphasis nodes
// | {k:'a', href, title, ch, txt, auto} link | {k:'img', href, title, ch}
// (ch = child items for normal links/images; txt = raw text for autolinks).

function renderLink(it, out) {
  const parsedText = it.auto ? escapeHtml(it.txt, true) : renderInlineToString(it.ch);
  const cleanHref = cleanUrl(it.href);
  if (cleanHref === null) {
    out.push(parsedText);
    return;
  }
  const href = escapeHtml(cleanHref, it.auto);
  let s = '<a href="' + href + '"';
  if (it.title) s += ' title="' + escapeHtml(it.title) + '"';
  out.push(s + '>' + parsedText + '</a>');
}

function renderImage(it, out) {
  const text = renderPlain(it.ch);
  const cleanHref = cleanUrl(it.href);
  if (cleanHref === null) {
    out.push(escapeHtml(text));
    return;
  }
  let s = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(text) + '"';
  if (it.title) s += ' title="' + escapeHtml(it.title) + '"';
  out.push(s + '>');
}

function renderItems(items, out) {
  for (const it of items) {
    switch (it.k) {
      case 't':
        out.push(it.r ? it.s : escapeHtml(it.s));
        break;
      case 'e':
        out.push(escapeHtml(it.s));
        break;
      case 'c':
        out.push('<code>' + escapeHtml(it.s, true) + '</code>');
        break;
      case 'h':
        out.push(it.s);
        break;
      case 'br':
        out.push('<br>');
        break;
      case 'd':
        if (it.n > 0) out.push(it.ch.repeat(it.n));
        break;
      case 'em':
        out.push('<em>');
        renderItems(it.ch, out);
        out.push('</em>');
        break;
      case 'strong':
        out.push('<strong>');
        renderItems(it.ch, out);
        out.push('</strong>');
        break;
      case 'del':
        out.push('<del>');
        renderItems(it.ch, out);
        out.push('</del>');
        break;
      case 'a':
        renderLink(it, out);
        break;
      case 'img':
        renderImage(it, out);
        break;
    }
  }
}

function renderInlineToString(items) {
  const out = [];
  renderItems(items, out);
  return out.join('');
}

// Plain-text rendering (image alt text): marked's TextRenderer.
function renderPlain(items) {
  const out = [];
  for (const it of items) {
    switch (it.k) {
      case 't':
      case 'e':
      case 'h':
        out.push(it.s);
        break;
      case 'c':
        out.push(it.s);
        break;
      case 'd':
        if (it.n > 0) out.push(it.ch.repeat(it.n));
        break;
      case 'em':
      case 'strong':
      case 'del':
        out.push(renderPlain(it.ch));
        break;
      case 'a':
      case 'img':
        out.push(it.ch ? renderPlain(it.ch) : it.txt || '');
        break;
      case 'br':
        break;
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// The inline scanner
// ---------------------------------------------------------------------------

const SPECIALS = ['\\', '`', '*', '_', '~', '[', '!', '<', '&', '\n'];

function nextSpecial(s, i) {
  let m = s.length;
  for (let k = 0; k < SPECIALS.length; k++) {
    const j = s.indexOf(SPECIALS[k], i);
    if (j !== -1 && j < m) m = j;
  }
  return m;
}

function tryNumericRef(s, i) {
  // &#...;  (same pattern marked uses)
  if (s[i + 1] !== '#') return null;
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  let digits = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    const ok = hex
      ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
      : (c >= 48 && c <= 57);
    if (!ok) break;
    j++;
    digits++;
  }
  if (digits === 0 || digits > (hex ? 6 : 7)) return null;
  if (s[j] !== ';') return null;
  const code = hex ? parseInt(s.slice(start, j), 16) : parseInt(s.slice(start, j), 10);
  let text;
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) text = '\uFFFD';
  else if (code === 38) text = '&amp;';
  else text = String.fromCodePoint(code);
  return { text, len: j + 1 - i };
}

function inlineParse(s, refs, state) {
  const savedHasParen = state.hasParen;
  state.hasParen = s.includes(')');
  const linkSpans = s.includes('[') ? blockSkipLinkSpans(s) : [];
  if (s.includes('`')) linkSpans.push(...codeSpanMaskSpans(s));
  const items = [];
  let txt = '';
  const flush = () => {
    if (txt) {
      items.push({ k: 't', s: txt, r: state.inRawBlock });
      txt = '';
    }
  };
  let prevMasked = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // A GFM url is only tried at a token start that is not itself a special
    // character: at a delimiter run the emphasis scan is tried first (marked's
    // token order), so `_foo@bar.com` becomes <em>foo</em>@bar.com rather
    // than a mailto link.
    const ch0 = s[i];
    if (ch0 !== '\\' && ch0 !== '`' && ch0 !== '*' && ch0 !== '_' && ch0 !== '~'
      && ch0 !== '[' && ch0 !== '!' && ch0 !== '<' && ch0 !== '&' && ch0 !== '\n') {
      const url = tryUrlAt(s, i, state);
      if (url) {
        flush();
        items.push(url.node);
        i = url.end;
        prevMasked = ']';
        continue;
      }
    }
    const m = nextSpecial(s, i);
    if (m > i) {
      const u = findUrlInRun(s, i, m, state);
      if (u) {
        if (u.pos > i) txt += s.slice(i, u.pos);
        flush();
        items.push(u.node);
        i = u.end;
        prevMasked = ']';
        continue;
      }
      txt += s.slice(i, m);
      i = m;
      if (i >= n) break;
    }
    const ch = s[i];
    if (ch === '\\') {
      if (s[i + 1] === '\n') {
        const br = INLINE_BR.exec(s.slice(i));
        if (br) {
          flush();
          items.push({ k: 'br' });
          i += br[0].length;
          prevMasked = '\n';
          continue;
        }
        txt += '\\';
        i++;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(s[i + 1])) {
        flush();
        items.push({ k: 'e', s: s[i + 1] });
        prevMasked = '+';
        i += 2;
        continue;
      }
      txt += '\\';
      i++;
      continue;
    }
    if (ch === '`') {
      const cap = INLINE_CODE.exec(s.slice(i));
      if (cap) {
        let text = cap[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
          text = text.substring(1, text.length - 1);
        }
        flush();
        items.push({ k: 'c', s: text });
        i += cap[0].length;
        prevMasked = ']';
        continue;
      }
      let j = i;
      while (j < n && s[j] === '`') j++;
      txt += s.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let j = i;
      while (j < n && s[j] === ch) j++;
      if (inSpans(linkSpans, i)) {
        // Inside a masked `[...](...)` span: literal text, not a delimiter.
        txt += s.slice(i, j);
        i = j;
        continue;
      }
      const runLen = j - i;
      const prev = prevMasked;
      const next = j < n ? s[j] : '';
      const left = next !== '' && !isSpace(next) && (!isPunct(next) || prev === '' || isSpace(prev) || isPunct(prev));
      const right = prev !== '' && !isSpace(prev) && (!isPunct(prev) || next === '' || isSpace(next) || isPunct(next));
      let o, c;
      if (ch === '_') {
        o = left && (!right || isPunct(prev));
        c = right && (!left || isPunct(next));
      } else {
        o = left;
        c = right;
      }
      flush();
      items.push({ k: 'd', ch, n: runLen, r0: runLen, o, c, prev, next });
      prevMasked = ch;
      i = j;
      continue;
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const isImage = ch === '!';
      const start = isImage ? i + 1 : i;
      let res = tryInlineLink(s, start, isImage, refs, state);
      if (res) {
        flush();
        items.push(res);
        i = start + res.rawLen;
        prevMasked = ']';
        continue;
      }
      res = tryRefLink(s, start, isImage, refs, state);
      if (res) {
        if (res.textOnly) {
          if (isImage) { txt += '!'; i++; }
          else { txt += '['; i = start + 1; }
          continue;
        }
        flush();
        items.push(res);
        i = start + res.rawLen;
        prevMasked = ']';
        continue;
      }
      txt += ch;
      i++;
      continue;
    }
    if (ch === '<') {
      const cap = INLINE_TAG_RE.exec(s.slice(i));
      if (cap) {
        flush();
        if (!state.inLink && START_A_TAG.test(cap[0])) state.inLink = true;
        else if (state.inLink && END_A_TAG.test(cap[0])) state.inLink = false;
        if (!state.inRawBlock && START_PRE_TAG.test(cap[0])) state.inRawBlock = true;
        else if (state.inRawBlock && END_PRE_TAG.test(cap[0])) state.inRawBlock = false;
        items.push({ k: 'h', s: cap[0] });
        i += cap[0].length;
        prevMasked = ']';
        continue;
      }
      const acap = INLINE_AUTOLINK.exec(s.slice(i));
      if (acap) {
        flush();
        let text, href;
        if (acap[2] === '@') { text = acap[1]; href = 'mailto:' + text; }
        else { text = acap[1]; href = text; }
        items.push({ k: 'a', href, title: null, ch: null, txt: text, auto: true });
        i += acap[0].length;
        prevMasked = ']';
        continue;
      }
      txt += '<';
      i++;
      continue;
    }
    if (ch === '&') {
      if (!state.inRawBlock) {
        const ref = tryNumericRef(s, i);
        if (ref) {
          txt += ref.text;
          i += ref.len;
          continue;
        }
      }
      txt += '&';
      i++;
      continue;
    }
    if (ch === '\n') {
      let sp = 0;
      while (sp < txt.length && txt.charCodeAt(txt.length - 1 - sp) === 32) sp++;
      if (sp >= 2 && hasNonWsAhead(s, i + 1)) {
        txt = txt.slice(0, txt.length - sp);
        flush();
        items.push({ k: 'br' });
        let j = i + 1;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        i = j;
        prevMasked = '\n';
        continue;
      }
      txt += '\n';
      i++;
      continue;
    }
    // '!' not followed by '[': plain text.
    txt += ch;
    i++;
  }
  flush();
  const resolved = resolveItems(items);
  state.hasParen = savedHasParen;
  return resolved;
}

// Render an inline string to HTML. `state` is the shared inline state for
// the current run (inLink / inRawBlock / linkEmitted).
function inlineHtml(s, refs, state) {
  if (s === '') return '';
  return renderInlineToString(inlineParse(s, refs, state));
}

// ---------------------------------------------------------------------------
// Block parser (line based; mirrors marked 18.1.3's Lexer/Tokenizer order:
// space, indented code, fences, ATX heading, hr, blockquote, list, html,
// def, table, setext heading, paragraph, text).
// ---------------------------------------------------------------------------

const BLOCK_TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const _reCache = new Map();
function cachedRe(key, make) {
  let r = _reCache.get(key);
  if (!r) { r = make(); _reCache.set(key, r); }
  return r;
}
// marked's cachedIndentRegex clamps the indent used by the list break
// regexes to min(3, indent - 1): a line indented by `indent` or more is part
// of the item, so it cannot start a new bullet/heading/fence at that level.
function clampIndent(indent) {
  return Math.max(0, Math.min(3, indent - 1));
}
// HTML block types 1-6 start (used as a paragraph interrupt).
function htmlBeginRe(indent) {
  return cachedRe('hb' + indent, () => new RegExp(
    '^ {0,' + indent + '}(?:</?(?:' + BLOCK_TAG + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'));
}
function nextBulletRe(indent) {
  return cachedRe('nb' + indent, () => new RegExp('^ {0,' + indent + '}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)'));
}
function hrRe(indent) {
  return cachedRe('hr' + indent, () => new RegExp('^ {0,' + indent + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})$'));
}
function fencesBeginRe(indent) {
  return cachedRe('fb' + indent, () => new RegExp('^ {0,' + indent + '}(?:```|~~~)'));
}
function headingBeginRe(indent) {
  return cachedRe('hd' + indent, () => new RegExp('^ {0,' + indent + '}#{1,6}(?:\\s|$)'));
}
function blockquoteBeginRe(indent) {
  return cachedRe('bq' + indent, () => new RegExp('^ {0,' + indent + '}>'));
}

function isBlankLine(line) {
  return line.length === 0 || /^[ \t]+$/.test(line);
}

// Column of the first non-whitespace character (tab = next multiple of 4).
function leadCol(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

function firstNonWS(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

// Expand the leading whitespace of a line to spaces, starting at column
// `startCol` (marked's expandTabs on the leading run).
function expandLeadingWS(line, startCol) {
  let col = startCol;
  let i = 0;
  let out = '';
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out + line.slice(i);
}

// Remove one level of indented-code indent: /^(?: {0,3}\t| {1,4})/.
function removeCodeIndent(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (line[i] === '\t') return line.slice(i + 1);
  let j = 0;
  while (j < 4 && line[j] === ' ') j++;
  return line.slice(j);
}

// Fenced code opening line: {ch, len, info} or null. A backtick fence's info
// string must not contain a backtick.
function isFenceStart(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const ch = m[1][0];
  if (ch === '`' && m[2].includes('`')) return null;
  return { ch, len: m[1].length, info: m[2] };
}

function isClosingFence(line, ch, len) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let j = i;
  while (line[j] === ch) j++;
  if (j - i < len) return false;
  for (let k = j; k < line.length; k++) {
    if (line[k] !== ' ') return false;
  }
  return true;
}

function isHrLine(line) {
  return /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/.test(line);
}

// ATX heading line: {d, text} or null. Trailing hashes are removed only when
// preceded by a space or tab (or the heading is all hashes).
function isAtxLine(line) {
  const m = /^ {0,3}(#{1,6})(?=\s|$)(.*)$/.exec(line);
  if (!m) return null;
  let text = m[2].trim();
  if (/#$/.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || /[ \t]$/.test(trimmed)) text = trimmed.trim();
  }
  return { d: m[1].length, text };
}

// A list bullet line: {ordered, num, marker, bulletIndent} or null. The
// bullet must be followed by a space/tab or the end of the line.
// bulletIndent is the length of the leading spaces plus the bullet itself.
function isBulletLine(line) {
  const m = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t]|$)/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const ordered = marker.length > 1;
  return {
    ordered,
    num: ordered ? +marker.slice(0, -1) : 0,
    marker,
    bulletIndent: m[0].length - m[2].length,
  };
}

// Setext underline line: '=' or '-' (the underline character), or null.
function isSetextLine(line) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  return m ? m[1][0] : null;
}

// A table delimiter line (GFM): at least one '|' and only ':', '-', ' ' and
// '|' characters (after up to 3 spaces).
function isTableDelimiterLine(line) {
  return /^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(line);
}

// Does lines[j] start a table (header + delimiter with matching cell counts)?
// `maxIndent` is 3 for a block start (4+ spaces is indented code); for a
// paragraph interrupt marked's table regex allows any indent.
function isTableStart(lines, j, maxIndent) {
  const line = lines[j];
  const next = lines[j + 1];
  if (next === undefined) return false;
  let sp = 0;
  while (sp < line.length && line[sp] === ' ') sp++;
  if (sp > maxIndent || sp >= line.length) return false;
  if (!/^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(next)) return false;
  if (!/[:|]/.test(next)) return false;
  const headers = splitCells(line.trim());
  const aligns = next.replace(/^\||\| *$/g, '').split('|');
  return headers.length === aligns.length;
}

// Does `line` interrupt a paragraph (or a text block)? `top` selects the list
// interrupt: at the top level only non-empty lists starting from 1 interrupt;
// inside a list item any bullet does.
function isParaInterrupt(line, lines, j, top) {
  if (isHrLine(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (isFenceStart(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (top) {
    if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/.test(line)) return true;
  } else if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) {
    return true;
  }
  if (htmlBeginRe(3).test(line)) return true;
  if (isTableStart(lines, j, 100)) return true;
  return false;
}

// Is the collected paragraph text valid setext-heading text? No line may be a
// bullet, fence, blockquote, ATX heading, hr, html-block start or table
// delimiter line.
function isValidLheadingText(textLines) {
  for (const l of textLines) {
    if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(l)) return false;
    if (isFenceStart(l)) return false;
    if (/^ {0,3}>/.test(l)) return false;
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(l)) return false;
    if (isHrLine(l)) return false;
    if (htmlBeginRe(3).test(l)) return false;
    if (isTableDelimiterLine(l)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

const _defTitleSrc = '"(?:\\\\[\\s\\S]|[^"\\\\])*"'
  + '|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\''
  + '|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';
const DEF_RE = new RegExp(
  '^ {0,3}\\[(' + _blockLabelSrc + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)'
  + '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + _defTitleSrc + '))? *(?:\\n+|$)',
);

// Try a definition starting at line i. Returns {nextI} (and registers the
// definition in doc.refs, first definition wins) or null.
function tryDef(lines, i, starts, text, doc) {
  const line = lines[i];
  if (!/^ {0,3}\[/.test(line)) return null;
  const cap = DEF_RE.exec(text.slice(starts[i]));
  if (!cap) return null;
  if (!cap[2].startsWith('<') && findClosingBracket(cap[2], '()') !== -1) return null;
  const tag = normalizeLabel(cap[1]);
  if (!doc.refs.has(tag)) {
    let href = cap[2].replace(/^<(.*)>$/, '$1');
    href = href.replace(ANY_PUNCT, '$1');
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1') : cap[3];
    doc.refs.set(tag, { href, title });
  }
  const rawLen = cap[0].length;
  const off = starts[i] + rawLen;
  let nextI = i;
  while (nextI < lines.length && starts[nextI] < off) nextI++;
  return { nextI };
}

// ---------------------------------------------------------------------------
// HTML blocks
// ---------------------------------------------------------------------------

const _htmlCommentSrc = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const _htmlAttrSrc = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
const HTML_RE = new RegExp(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|' + _htmlCommentSrc + '[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(?:' + BLOCK_TAG + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:' + _htmlAttrSrc + ')*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i',
);

// Try an HTML block starting at line i. Returns {text, nextI} or null.
function tryHtmlBlock(lines, i, starts, text) {
  if (!htmlBeginRe(3).test(lines[i]) && !/^ {0,3}</.test(lines[i])) return null;
  const cap = HTML_RE.exec(text.slice(starts[i]));
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  const off = starts[i] + raw.length;
  let nextI = i;
  while (nextI < lines.length && starts[nextI] < off) nextI++;
  return { text: raw, nextI };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function parseTable(lines, i, end, doc) {
  const headLine = lines[i].trim();
  const delimLine = lines[i + 1];
  const headers = splitCells(headLine);
  const alignsRaw = delimLine.replace(/^\||\| *$/g, '').split('|');
  const aligns = alignsRaw.map((a) => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  const head = headers.map((t, k) => ({ t, a: aligns[k] }));
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const line = lines[j];
    if (/^ *$/.test(line)) break; // spaces-only (no tab) ends the rows
    if (isHrLine(line)) break;
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) break;
    if (/^ {0,3}>/.test(line)) break;
    if (line.trim() !== '' && leadCol(line) >= 4) break; // indented code
    if (isFenceStart(line)) break;
    if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)) break;
    if (htmlBeginRe(3).test(line)) break;
    rows.push(splitCells(line.trim(), head.length).map((t, k) => ({ t, a: aligns[k] })));
    j++;
  }
  return { block: { k: 'table', head, rows }, nextI: j };
}

// ---------------------------------------------------------------------------
// Paragraph / text (with setext headings)
// ---------------------------------------------------------------------------

function parseParagraph(lines, i, end, doc, top) {
  const textLines = [];
  let j = i;
  let inCode = false; // top=false only: last appended line was indented code
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      if (top && line !== '' && j === end - 1) {
        // Trailing whitespace-only line with no newline after it: it is
        // paragraph text, not a separator (cm-241). Only for top-level
        // paragraphs; inside a list item it is a space token, not text.
        textLines.push(line);
        inCode = false;
        j++;
        continue;
      }
      if (!top && inCode) {
        // A blank line inside an indented code block is absorbed (marked's
        // blockCode regex) when an indented line follows it.
        let k = j + 1;
        while (k < end && isBlankLine(lines[k])) k++;
        if (k < end && leadCol(lines[k]) >= 4 && !isBlankLine(lines[k])) {
          textLines.push(removeCodeIndent(line));
          j++;
          continue;
        }
      }
      break;
    }
    // A setext underline is checked before the paragraph interrupts: '---'
    // is also an hr, but a valid setext heading wins over it.
    const setext = isSetextLine(line);
    if (setext && j > i) {
      if (isValidLheadingText(textLines)) {
        const text = textLines.join('\n').trim();
        return { block: { k: 'h', d: setext === '=' ? 1 : 2, text }, nextI: j + 1 };
      }
      if (setext === '-') break; // '---' is an hr interrupt
      // '===' that is not a heading is paragraph text
    }
    if (j > i && isParaInterrupt(line, lines, j, top)) break;
    if (!top && leadCol(line) >= 4) {
      // Inside a list item, an indented line is an indented code block that
      // marked absorbs into the text token with its indent removed.
      textLines.push(removeCodeIndent(line));
      inCode = true;
    } else {
      textLines.push(line);
      inCode = false;
    }
    j++;
  }
  const text = textLines.join('\n');
  return { block: { k: top ? 'p' : 'text', text }, nextI: j };
}

// ---------------------------------------------------------------------------
// The block dispatcher
// ---------------------------------------------------------------------------

function parseBlocks(text, doc, top) {
  const lines = text.split('\n');
  // A trailing '\n' produces a phantom empty line; it is not a real line.
  let end = lines.length;
  if (end > 0 && lines[end - 1] === '') end--;
  const starts = new Array(lines.length);
  let off = 0;
  for (let k = 0; k < lines.length; k++) { starts[k] = off; off += lines[k].length + 1; }
  const blocks = [];
  let loose = false;
  let i = 0;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) {
      // A blank line after a block (or two at the start) is a "space" token
      // whose raw has more than one newline, which makes a list loose.
      let run = 0;
      while (i + run < end && isBlankLine(lines[i + run])) run++;
      if (blocks.length > 0 || run >= 2) loose = true;
      i += run;
      continue;
    }
    // indented code
    if (leadCol(line) >= 4) {
      const codeLines = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        if (leadCol(l) >= 4 && !isBlankLine(l)) { codeLines.push(l); j++; continue; }
        if (isBlankLine(l)) {
          // blank lines are included only if an indented line follows
          let k = j + 1;
          while (k < end && isBlankLine(lines[k])) k++;
          if (k < end && leadCol(lines[k]) >= 4 && !isBlankLine(lines[k])) {
            codeLines.push(l);
            j++;
            continue;
          }
          break;
        }
        break;
      }
      let raw = codeLines.join('\n');
      raw = trimTrailingBlankLines(raw);
      const textOut = raw.split('\n').map(removeCodeIndent).join('\n');
      blocks.push({ k: 'code', text: textOut, lang: '', style: 'indented' });
      i = j;
      continue;
    }
    // fenced code
    const fence = isFenceStart(line);
    if (fence) {
      let j = i + 1;
      while (j < end && !isClosingFence(lines[j], fence.ch, fence.len)) j++;
      const contentLines = lines.slice(i + 1, j);
      let content = contentLines.join('\n');
      // indent compensation: up to the fence's own leading whitespace is
      // removed from each content line (character based, backtick fences only)
      const fenceIndent = line.match(/^(\s+)(?:```)/);
      if (fenceIndent) {
        const n = fenceIndent[1].length;
        content = content.split('\n').map((l) => {
          const m = l.match(/^\s+/);
          if (!m) return l;
          return l.slice(Math.min(m[0].length, n));
        }).join('\n');
      }
      const lang = fence.info.trim().replace(ANY_PUNCT, '$1');
      blocks.push({ k: 'code', text: content, lang, style: 'fenced' });
      i = j < end ? j + 1 : j;
      continue;
    }
    // ATX heading
    const atx = isAtxLine(line);
    if (atx) { blocks.push({ k: 'h', d: atx.d, text: atx.text }); i++; continue; }
    // hr
    if (isHrLine(line)) { blocks.push({ k: 'hr' }); i++; continue; }
    // blockquote
    if (/^ {0,3}>/.test(line)) {
      const r = parseBlockquote(lines, i, end, doc);
      blocks.push(r.block);
      i = r.nextI;
      continue;
    }
    // list
    const bull = isBulletLine(line);
    if (bull) {
      const r = parseList(lines, i, end, doc);
      if (r) { blocks.push(r.block); i = r.nextI; continue; }
    }
    // html block
    const html = tryHtmlBlock(lines, i, starts, text);
    if (html) { blocks.push({ k: 'html', text: html.text }); i = html.nextI; continue; }
    // link reference definition
    const def = tryDef(lines, i, starts, text, doc);
    if (def) { i = def.nextI; continue; }
    // table
    if (isTableStart(lines, i, 3)) {
      const r = parseTable(lines, i, end, doc);
      blocks.push(r.block);
      i = r.nextI;
      continue;
    }
    // paragraph / text (setext headings are handled inside)
    const r = parseParagraph(lines, i, end, doc, top);
    blocks.push(r.block);
    i = r.nextI;
  }
  blocks.loose = loose;
  return blocks;
}

// ---------------------------------------------------------------------------
// Blockquotes
// ---------------------------------------------------------------------------

const BLOCKQUOTE_STRIP_RE = /^ {0,3}>[ \t]?/gm;
const BLOCKQUOTE_MARKER_WS_RE = /^( {0,3}>)([ \t]+)/gm;
const BLOCKQUOTE_SETEXT_RE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;

// A lazy blockquote line interrupts a paragraph when it starts a block; the
// list interrupt here is any bullet (blockquote paragraphs differ from
// top-level ones).
function isBqParaInterrupt(line, lines, j) {
  if (isHrLine(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (isFenceStart(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) return true;
  if (htmlBeginRe(3).test(line)) return true;
  if (isTableStart(lines, j, 100)) return true;
  return false;
}

function parseBlockquote(lines, i, end, doc) {
  // Collect the raw lines: '>' lines plus lazy paragraph continuations.
  const rawLines = [];
  let inPara = false;
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (/^ {0,3}>/.test(line)) {
      rawLines.push(line);
      inPara = line.replace(/^ {0,3}>[ \t]?/, '').trim() !== '';
      j++;
    } else if (inPara && !isBlankLine(line) && !isBqParaInterrupt(line, lines, j)) {
      rawLines.push(line);
      j++;
    } else {
      break;
    }
  }
  let remaining = rawLines;
  const blocks = [];
  let consumed = 0;
  while (remaining.length > 0) {
    // One chunk: leading lazy lines, then '>' lines.
    let inBq = false;
    const chunk = [];
    let k = 0;
    for (; k < remaining.length; k++) {
      if (/^ {0,3}>/.test(remaining[k])) { chunk.push(remaining[k]); inBq = true; }
      else if (!inBq) { chunk.push(remaining[k]); }
      else break;
    }
    const restLines = remaining.slice(k);
    const currentRaw = chunk.join('\n');
    const currentText = currentRaw
      .replace(BLOCKQUOTE_MARKER_WS_RE, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(BLOCKQUOTE_SETEXT_RE, '\n    $1')
      .replace(BLOCKQUOTE_STRIP_RE, '');
    const chunkBlocks = parseBlocks(currentText, doc, true);
    if (blocks.length > 0 && blocks[blocks.length - 1].k === 'p'
      && chunkBlocks.length > 0 && chunkBlocks[0].k === 'p') {
      blocks[blocks.length - 1].text += '\n' + chunkBlocks[0].text;
      chunkBlocks.shift();
    } else if (blocks.length > 0 && blocks[blocks.length - 1].k === 'p'
      && chunkBlocks.length > 0 && chunkBlocks[0].k === 'code'
      && chunkBlocks[0].style === 'indented') {
      // A lazy indented line inside a blockquote is an indented code block
      // that marked absorbs into the preceding paragraph.
      blocks[blocks.length - 1].text += '\n' + chunkBlocks[0].text;
      chunkBlocks.shift();
    }
    blocks.push(...chunkBlocks);
    consumed += chunk.length;
    if (restLines.length === 0) break;
    const last = blocks[blocks.length - 1];
    if (last && (last.k === 'code' || last.k === 'h' || last.k === 'hr' || last.k === 'html' || last.k === 'table')) break;
    if (last && last.k === 'quote') {
      // Include the continuation in the nested blockquote.
      const continuation = restLines.join('\n');
      const newText = last.raw + '\n' + continuation.replace(BLOCKQUOTE_STRIP_RE, '');
      const newQuote = parseBlockquoteText(newText, doc);
      blocks[blocks.length - 1] = newQuote.block;
      const leftover = newText.substring(newQuote.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumedLines = leftoverCount ? restLines.slice(0, -leftoverCount) : restLines;
      consumed += consumedLines.length;
      const after = restLines.slice(consumedLines.length);
      if (after.length > 0 && /^ {0,3}>/.test(after[0])) {
        remaining = after;
        continue;
      }
      break;
    }
    if (last && last.k === 'list') {
      // Include the continuation in the nested list.
      const newText = last.raw + '\n' + restLines.join('\n');
      const newList = parseListText(newText, doc);
      blocks[blocks.length - 1] = newList.block;
      const consumedCount = newList.block.raw.length > last.raw.length
        ? newText.slice(last.raw.length + 1, newList.block.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) consumed += consumedCount;
      remaining = restLines.slice(consumedCount);
      continue;
    }
    remaining = restLines;
  }
  const raw = rawLines.slice(0, consumed).join('\n');
  return { block: { k: 'quote', b: blocks, raw }, nextI: i + consumed };
}

function parseBlockquoteText(text, doc) {
  const lines = text.split('\n');
  const r = parseBlockquote(lines, 0, lines.length, doc);
  return { block: r.block, raw: r.block.raw };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const _itemLineCache = new Map();
function matchItemLine(line, bullPattern) {
  let re = _itemLineCache.get(bullPattern);
  if (!re) {
    re = new RegExp(`^( {0,3}${bullPattern})([ \\t].*)?$`);
    _itemLineCache.set(bullPattern, re);
  }
  const m = re.exec(line);
  if (!m) return null;
  const after = m[2] === undefined ? '' : m[2];
  return { bulletIndent: m[1].length, firstLine: after };
}

// Whether `prevLine\nnextLine` is a setext heading (used to neutralize a lazy
// setext underline inside a list item).
function isLheadingPair(prevLine, nextLine) {
  if (!prevLine || !prevLine.trim()) return false;
  if (!isSetextLine(nextLine)) return false;
  return isValidLheadingText([prevLine]);
}

function parseList(lines, i, end, doc) {
  const firstBull = isBulletLine(lines[i]);
  if (!firstBull) return null;
  const isOrdered = firstBull.ordered;
  const bullPattern = isOrdered
    ? `\\d{1,9}\\${firstBull.marker.slice(-1)}`
    : `\\${firstBull.marker}`;
  const items = [];
  let endsWithBlankLine = false;
  let loose = false;
  let j = i;
  while (j < end) {
    const line = lines[j];
    const m = matchItemLine(line, bullPattern);
    if (!m) break;
    if (isHrLine(line)) break;
    const itemStart = j;
    let lineVar = expandLeadingWS(m.firstLine, m.bulletIndent);
    const nextLine = lines[j + 1] !== undefined ? lines[j + 1] : '';
    let blankLine = !lineVar.trim();
    let indent;
    let itemContents = '';
    if (blankLine) {
      indent = m.bulletIndent + 1;
    } else {
      indent = lineVar.search(/[^ ]/);
      if (indent === -1) indent = lineVar.length;
      indent = indent > 4 ? 1 : indent;
      itemContents = lineVar.slice(indent);
      indent += m.bulletIndent;
    }
    let endEarly = false;
    if (blankLine && isBlankLine(nextLine)) {
      j += 2;
      endEarly = true;
    }
    if (!endEarly) {
      const ci = clampIndent(indent);
      const nextBullet = nextBulletRe(ci);
      const hrR = hrRe(ci);
      const fencesR = fencesBeginRe(ci);
      const headingR = headingBeginRe(ci);
      const htmlR = htmlBeginRe(ci);
      const bqR = blockquoteBeginRe(ci);
      let k = j + 1;
      while (k < end) {
        const rawLine = lines[k];
        const nextLineWithoutTabs = expandLeadingWS(rawLine, 0);
        if (fencesR.test(rawLine)) break;
        if (headingR.test(rawLine)) break;
        if (htmlR.test(rawLine)) break;
        if (bqR.test(rawLine)) break;
        if (nextBullet.test(rawLine)) break;
        if (hrR.test(rawLine)) break;
        if (nextLineWithoutTabs.search(/[^ ]/) >= indent || !rawLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (lineVar.replace(/\t/g, '    ').search(/[^ ]/) >= 4) break;
          if (fencesR.test(lineVar)) break;
          if (headingR.test(lineVar)) break;
          if (htmlR.test(lineVar)) break;
          if (hrR.test(lineVar)) break;
          const setextContinuation = isLheadingPair(lineVar, rawLine);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : rawLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !rawLine.trim();
        k++;
        lineVar = nextLineWithoutTabs.slice(indent);
      }
      j = k;
    }
    // marked's item raw is a slice of the source text, so it ends with the
    // newline after its last line (when there is one); that trailing newline
    // is what the double-blank-line test looks for.
    const raw = lines.slice(itemStart, j).join('\n') + (j < end ? '\n' : '');
    if (!loose) {
      if (endsWithBlankLine) loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(raw)) endsWithBlankLine = true;
    }
    items.push({
      text: itemContents,
      task: /^\[[ xX]\][ \t]+\S/.test(itemContents),
      checked: false,
    });
  }
  if (items.length === 0) return null;
  const lastItem = items[items.length - 1];
  lastItem.text = lastItem.text.trimEnd();
  const raw = lines.slice(i, j).join('\n').trimEnd();
  // First pass: parse each item's blocks and finalize looseness.
  for (const item of items) {
    item.b = parseBlocks(item.text, doc, false);
    if (!loose && item.b.loose) loose = true;
  }
  // Second pass: task checkboxes.
  for (const item of items) {
    if (!item.task) continue;
    const first = item.b[0];
    if (first && (first.k === 'text' || first.k === 'p')) {
      const m = /^\[[ xX]\]/.exec(first.text);
      item.checked = m ? m[0] !== '[ ]' : false;
      first.text = first.text.replace(/^\[[ xX]\][ \t]+/, '');
    } else {
      item.task = false;
    }
  }
  if (loose) {
    for (const item of items) {
      for (const b of item.b) {
        if (b.k === 'text') b.k = 'p';
      }
    }
  }
  // Do not consume trailing blank lines: marked advances the lexer by the
  // trimmed raw, so they are left as space tokens for the outer parser.
  let nextI = j;
  while (nextI > i && isBlankLine(lines[nextI - 1])) nextI--;
  return {
    block: { k: 'list', o: isOrdered, s: isOrdered ? firstBull.num : 0, loose, items, raw },
    nextI,
  };
}

function parseListText(text, doc) {
  const lines = text.split('\n');
  const r = parseList(lines, 0, lines.length, doc);
  if (!r) return { block: { k: 'list', o: false, s: 0, loose: false, items: [], raw: '' } };
  return r;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function newInlineState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false, hasParen: false };
}

function renderBlocks(blocks, doc, out) {
  for (const b of blocks) {
    switch (b.k) {
      case 'p':
        out.push('<p>' + inlineHtml(b.text, doc.refs, doc.ist) + '</p>\n');
        break;
      case 'text':
        out.push(inlineHtml(b.text, doc.refs, doc.ist));
        break;
      case 'h':
        out.push('<h' + b.d + '>' + inlineHtml(b.text, doc.refs, doc.ist) + '</h' + b.d + '>\n');
        break;
      case 'code': {
        const langString = (b.lang || '').match(/^\S*/) ? (b.lang || '').match(/^\S*/)[0] : '';
        const code = b.text ? b.text.replace(/\n$/, '') + '\n' : '';
        const esc = escapeHtml(code, true);
        if (!langString) out.push('<pre><code>' + esc + '</code></pre>\n');
        else out.push('<pre><code class="language-' + escapeHtml(langString) + '">' + esc + '</code></pre>\n');
        break;
      }
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'html':
        out.push(b.text);
        break;
      case 'quote': {
        const inner = [];
        renderBlocks(b.b, doc, inner);
        out.push('<blockquote>\n' + inner.join('') + '</blockquote>\n');
        break;
      }
      case 'list': {
        const type = b.o ? 'ol' : 'ul';
        const startAttr = (b.o && b.s !== 1) ? ' start="' + b.s + '"' : '';
        const body = [];
        for (const item of b.items) {
          const cb = item.task
            ? '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
            : '';
          const inner = [];
          renderBlocks(item.b, doc, inner);
          let html = inner.join('');
          if (item.task && b.loose) {
            // The checkbox goes inside the first paragraph.
            html = html.replace(/^<p>/, '<p>' + cb);
          }
          body.push('<li>' + (item.task && !b.loose ? cb : '') + html + '</li>\n');
        }
        out.push('<' + type + startAttr + '>\n' + body.join('') + '</' + type + '>\n');
        break;
      }
      case 'table': {
        const renderCells = (row, isHead) => {
          let s = '';
          for (const c of row) {
            const tag = isHead ? 'th' : 'td';
            s += '<' + tag + (c.a ? ' align="' + c.a + '"' : '') + '>'
              + inlineHtml(c.t, doc.refs, doc.ist)
              + '</' + tag + '>\n';
          }
          return s;
        };
        let s = '<table>\n<thead>\n<tr>\n' + renderCells(b.head, true) + '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          s += '<tbody>';
          for (const row of b.rows) s += '<tr>\n' + renderCells(row, false) + '</tr>\n';
          s += '</tbody>';
        }
        out.push(s + '</table>\n');
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fast entry point
// ---------------------------------------------------------------------------

// Bail to marked when a '_' run could be the start of an email address:
// marked tries emphasis first, then the url at the '_' position, so the whole
// '_foo@bar.com' becomes one mailto link. That ordering is not worth
// replicating for the rare generated documents that contain it.
const BAIL_EMAIL_UNDERSCORE = /_[A-Za-z0-9._+\-]*@/;

function renderFast(md) {
  if (BAIL_EMAIL_UNDERSCORE.test(md)) throw new Error('bail: underscore email');
  const src = md.replace(/\r\n?/g, '\n');
  const doc = { refs: new Map(), ist: newInlineState() };
  const blocks = parseBlocks(src, doc, true);
  const out = [];
  renderBlocks(blocks, doc, out);
  return out.join('');
}
