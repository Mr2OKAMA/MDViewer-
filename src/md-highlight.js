/**
 * エディタ用の Markdown シンタックスハイライター。
 * textarea の背面に重ねる <pre> 用の HTML を生成する。
 * 文字幅がずれるとキャレット位置が狂うため、太字・斜体などの字形変化は使わず色のみで表現する。
 * フェンスコードブロックの中身は highlight.js で言語別に色分けする (関数名・引数・キーワード等)。
 */
import hljs from 'highlight.js/lib/common';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const span = (cls, html) => (html ? `<span class="mdh-${cls}">${html}</span>` : '');

const codeCache = new Map();

function highlightCode(code, lang) {
  const key = `${lang}\u0000${code}`;
  const hit = codeCache.get(key);
  if (hit !== undefined) return hit;
  let html;
  try {
    html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        : esc(code);
  } catch {
    html = esc(code);
  }
  html = span('codeblock', html);
  if (codeCache.size > 300) codeCache.clear();
  codeCache.set(key, html);
  return html;
}

// [種類, 正規表現 (sticky)] を先頭から順に試す
const INLINE_RULES = [
  ['esc', /\\[!-/:-@[-`{-~]/y],
  ['code', /(`+)(?!`).*?[^`]\1(?!`)|(`+)[^`]\2(?!`)/y],
  ['image', /!\[([^\]\n]*)\]\(([^)\s]*)((?:\s+"[^"]*")?)\)/y],
  ['link', /\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]\(([^)\s]*)((?:\s+"[^"]*")?)\)/y],
  ['reflink', /\[([^\]\n]+)\]\[([^\]\n]*)\]/y],
  ['footnote', /\[\^[^\]\s]+\]/y],
  ['autolink', /<(?:https?:\/\/|mailto:)[^>\s]+>/y],
  ['url', /https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/y],
  ['comment', /<!--.*?-->/y],
  ['html', /<\/?[A-Za-z][\w-]*(?:\s+[^<>]*?)?\/?>/y],
  ['strong', /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/y],
  ['strike', /(~~)(?=\S)(.+?)(?<=\S)\1/y],
  ['em', /(\*|_)(?=[^\s*_])(.+?)(?<=[^\s*_])\1(?!\1)/y]
];

function renderToken(type, m, tableRow) {
  const mark = (s) => span('mark', esc(s));
  switch (type) {
    case 'image':
      return (
        mark('![') + span('link-text', esc(m[1])) + mark('](') + span('url', esc(m[2])) +
        span('title', esc(m[3])) + mark(')')
      );
    case 'link':
      return (
        mark('[') + span('link-text', inline(m[1], tableRow)) + mark('](') + span('url', esc(m[2])) +
        span('title', esc(m[3])) + mark(')')
      );
    case 'reflink':
      return mark('[') + span('link-text', inline(m[1], tableRow)) + mark('][') + span('url', esc(m[2])) + mark(']');
    case 'autolink':
    case 'url':
      return span('url', esc(m[0]));
    case 'strong':
    case 'strike':
    case 'em':
      return span(type, mark(m[1]) + inline(m[2], tableRow) + mark(m[1]));
    case 'footnote':
      return span('link-text', esc(m[0]));
    default:
      return span(type, esc(m[0]));
  }
}

function inline(text, tableRow = false) {
  let out = '';
  let plain = '';
  let i = 0;
  const flush = () => {
    out += esc(plain);
    plain = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (tableRow && ch === '|') {
      flush();
      out += span('table', '|');
      i++;
      continue;
    }
    // URL は単語の途中からは開始しない
    const prev = text[i - 1] || ' ';
    let matched = null;
    for (const [type, re] of INLINE_RULES) {
      if (type === 'url' && /[\w/]/.test(prev)) continue;
      if (type === 'em' && ch === '_' && /\w/.test(prev)) continue;
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m[0]) {
        matched = [type, m];
        break;
      }
    }
    if (matched) {
      flush();
      out += renderToken(matched[0], matched[1], tableRow);
      i += matched[1][0].length;
    } else {
      plain += ch;
      i++;
    }
  }
  flush();
  return out;
}

const RE_HEADING = /^(\s{0,3})(#{1,6})(?=\s|$)(.*)$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^(\s{0,3}(?:>\s?)+)(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(?:(\[[ xX]\])(?=\s|$))?(.*)$/;
const RE_REFDEF = /^(\s{0,3})(\[[^\]]+\]:)(\s+)(\S+)(.*)$/;
const RE_TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const RE_SETEXT_EQ = /^\s{0,3}=+\s*$/;
const RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

function highlightLine(line, next) {
  if (!line.trim()) return esc(line);
  let m;
  if ((m = line.match(RE_HEADING))) {
    const level = m[2].length;
    return esc(m[1]) + span(`heading mdh-h${level}`, span('mark', m[2]) + inline(m[3]));
  }
  if (next !== undefined && RE_SETEXT_EQ.test(next)) return span('heading mdh-h1', inline(line));
  if (RE_HR.test(line)) return span('hr', esc(line));
  if ((m = line.match(RE_QUOTE))) {
    return span('quote-mark', esc(m[1])) + span('quote', highlightLine(m[2]));
  }
  if ((m = line.match(RE_LIST))) {
    const [, indent, marker, space, task, rest] = m;
    const box = task ? span(/x/i.test(task) ? 'task-done' : 'task', esc(task)) : '';
    return esc(indent) + span('list', esc(marker)) + esc(space) + box + inline(rest);
  }
  if ((m = line.match(RE_REFDEF))) {
    return esc(m[1]) + span('link-text', esc(m[2])) + esc(m[3]) + span('url', esc(m[4])) + span('title', esc(m[5]));
  }
  if (RE_TABLE_DELIM.test(line)) return span('table', esc(line));
  return inline(line, /^\s*\|/.test(line));
}

/**
 * Markdown テキスト全体をハイライト済み HTML に変換する。
 * 出力の改行位置は入力と完全に一致する (行数・文字数を変えない)。
 */
export function highlightMarkdown(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  // YAML フロントマター
  if (lines[0] === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && (l === '---' || l === '...'));
    if (end > 0) {
      out.push(span('meta', esc(lines.slice(0, end + 1).join('\n'))));
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(RE_FENCE);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const info = fence[3];
      const lang = info.trim().split(/[\s{]/)[0].toLowerCase();
      const close = new RegExp(`^\\s{0,3}\\${fence[2][0]}{${fence[2].length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      out.push(span('fence', esc(fence[1] + fence[2])) + span('lang', esc(info)));
      if (j > i + 1) out.push(highlightCode(lines.slice(i + 1, j).join('\n'), lang));
      if (j < lines.length) out.push(span('fence', esc(lines[j])));
      i = j + 1;
      continue;
    }
    if (RE_SETEXT_EQ.test(line) && i > 0 && lines[i - 1].trim()) {
      out.push(span('mark', esc(line)));
    } else {
      out.push(highlightLine(line, lines[i + 1]));
    }
    i++;
  }
  return out.join('\n');
}
