// autom8x-kit v1 — canonical: snoopy-backend/.claude/hooks/lib/shell-words.mjs
// Shell text as words and operators, for guard.mjs: quotes respected, heredoc bodies
// skipped, a command substitution kept as text inside its word. Runs nothing.

/** A heredoc's delimiter at `i` (just after `<<`): the tag, `<<-`, and where it ends. */
function readTag(src, i) {
  const strip = src[i] === '-';
  if (strip) i++;
  while (src[i] === ' ' || src[i] === '\t') i++;
  let tag = '';
  while (i < src.length && !/[\s;&|<>()]/u.test(src[i])) {
    if (src[i] === "'" || src[i] === '"') {
      const j = src.indexOf(src[i], i + 1);
      tag += src.slice(i + 1, j < 0 ? src.length : j);
      i = j < 0 ? src.length : j + 1;
    } else if (src[i] === '\\') (tag += src[i + 1] ?? ''), (i += 2);
    else tag += src[i++];
  }
  return { tag, strip, next: i };
}

/** Past the heredoc bodies that start at `i` (just after a newline). */
function skipBodies(src, i, tags) {
  while (tags.length) {
    const { tag, strip } = tags.shift();
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const line = src.slice(i, nl < 0 ? src.length : nl);
      i = nl < 0 ? src.length : nl + 1;
      if ((strip ? line.replace(/^\t+/u, '') : line) === tag) break;
    }
  }
  return i;
}

/** The `)` closing a `$(` whose body starts at `i`: quotes, nesting and heredocs respected. */
function substEnd(src, i) {
  const tags = [];
  for (let depth = 0; i < src.length; ) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1) + 1;
    else if (c === '"') i = quoteEnd(src, i + 1);
    else if (c === '\n') i = skipBodies(src, i + 1, tags);
    else if (src.startsWith('<<<', i)) i += 3;
    else if (src.startsWith('<<', i)) {
      const t = readTag(src, i + 2);
      tags.push(t);
      i = t.next;
    } else if (src.startsWith('$(', i)) i = substEnd(src, i + 2) + 1;
    else if (c === '(') (depth++, i++);
    else if (c === ')') {
      if (depth === 0) return i;
      depth--;
      i++;
    } else i++;
  }
  return src.length;
}

/** Just past the `"` closing a double-quoted string whose body starts at `i`. */
function quoteEnd(src, i) {
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\\') i += 2;
    else if (src.startsWith('$(', i)) i = substEnd(src, i + 2) + 1;
    else if (src[i] === '`') i = src.indexOf('`', i + 1) < 0 ? src.length : src.indexOf('`', i + 1) + 1;
    else i++;
  }
  return i + 1;
}

/** Shell text as words and operators; quotes respected, heredoc bodies dropped. */
export function tokenize(src) {
  const out = [];
  const heredocs = [];
  let word = null;
  let i = 0;
  const add = (s) => (word = (word ?? '') + s);
  const push = () => void (word !== null && out.push({ w: word }), (word = null));
  const redirect = (op, len) => {
    if (word !== null && /^\d+$/u.test(word)) word = null; // `2>`: the fd is not a word
    push();
    i += len;
    if (op === '>&' && /[\d-]/u.test(src[i] ?? '')) return void i++; // `2>&1`
    out.push({ op: op.includes('<') ? '<' : '>' });
  };
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      add(src.slice(i + 1, j < 0 ? src.length : j));
      i = j < 0 ? src.length : j + 1;
    } else if (c === '"') {
      const end = quoteEnd(src, i + 1);
      add(src.slice(i + 1, end - 1).replace(/\\(["\\$`])/gu, '$1').replace(/\\\n/gu, ''));
      i = end;
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') add(src[i + 1] ?? '');
      i += 2;
    } else if (two === '$(' || c === '`') {
      // A command substitution stays text inside its word.
      let j = c === '`' ? src.indexOf('`', i + 1) : substEnd(src, i + 2);
      j = j < 0 ? src.length : j;
      add(src.slice(i, j + 1));
      i = j + 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      push(), i++;
    } else if (c === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '\n') {
      push();
      out.push({ op: '\n' });
      i = skipBodies(src, i + 1, heredocs);
    } else if (src.startsWith('<<<', i)) {
      push();
      out.push({ op: '<' });
      i += 3;
    } else if (two === '<<') {
      push();
      const t = readTag(src, i + 2);
      heredocs.push(t);
      i = t.next;
    } else if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
      push();
      out.push({ op: two === ';;' ? ';' : two[0] === '|' ? '|' : two });
      i += 2;
    } else if (two === '>>' || two === '&>' || two === '>&' || two === '>|' || two === '<&') {
      redirect(two === '>|' ? '>' : two, 2);
    } else if (c === '>' || c === '<') {
      redirect(c, 1);
    } else if (';|&()'.includes(c)) {
      push();
      out.push({ op: c });
      i++;
    } else {
      add(c);
      i++;
    }
  }
  push();
  return out;
}
