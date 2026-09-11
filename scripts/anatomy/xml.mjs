// Minimal, dependency-free XML reader/writer used only by the Anatomy Visualization
// reproducible build. It handles the subset the pinned SVG sources use: declarations,
// comments, DOCTYPE, CDATA, elements, attributes and raw text. Attribute and text
// buffers keep their original entity spelling unless a caller decodes them.
export function parseXml(source) {
  let index = 0;
  const length = source.length;
  const fail = (message) => { throw new Error(`${message} at offset ${index}`); };
  const skipWhitespace = () => { while (index < length && ' \t\r\n'.includes(source[index])) index += 1; };
  const skipUntil = (token) => { const end = source.indexOf(token, index); if (end < 0) fail(`Unterminated ${token}`); index = end + token.length; };
  const skipMisc = () => {
    for (;;) {
      skipWhitespace();
      if (source.startsWith('<?', index)) skipUntil('?>');
      else if (source.startsWith('<!--', index)) skipUntil('-->');
      else if (source.startsWith('<!DOCTYPE', index)) { const end = source.indexOf('>', index); if (end < 0) fail('Unterminated DOCTYPE'); index = end + 1; }
      else return;
    }
  };
  const NAME_STOP = ' \t\r\n/>=\'"';
  const readName = () => {
    const start = index;
    while (index < length && !NAME_STOP.includes(source[index])) index += 1;
    if (start === index) fail('Expected a name');
    return source.slice(start, index);
  };
  const readAttributes = () => {
    const attributes = {};
    for (;;) {
      skipWhitespace();
      if (source.startsWith('/>', index) || source[index] === '>') return attributes;
      const name = readName();
      skipWhitespace();
      if (source[index] !== '=') fail(`Attribute ${name} is missing a value`);
      index += 1;
      skipWhitespace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail(`Attribute ${name} is not quoted`);
      index += 1;
      const end = source.indexOf(quote, index);
      if (end < 0) fail(`Attribute ${name} is unterminated`);
      attributes[name] = source.slice(index, end);
      index = end + 1;
    }
  };
  const readElement = () => {
    if (source[index] !== '<') fail('Expected an element');
    index += 1;
    const name = readName();
    const attributes = readAttributes();
    if (source.startsWith('/>', index)) { index += 2; return { name, attributes, children: [], text: '' }; }
    if (source[index] !== '>') fail(`Element ${name} is malformed`);
    index += 1;
    const children = [];
    let text = '';
    for (;;) {
      if (index >= length) fail(`Element ${name} is unterminated`);
      if (source.startsWith('</', index)) {
        index += 2;
        const close = readName();
        skipWhitespace();
        if (source[index] !== '>') fail(`Element ${name} is not closed`);
        index += 1;
        return { name, attributes, children, text };
      }
      if (source.startsWith('<!--', index)) { skipUntil('-->'); continue; }
      if (source.startsWith('<![CDATA[', index)) {
        const end = source.indexOf(']]>', index);
        if (end < 0) fail('Unterminated CDATA');
        text += source.slice(index + 9, end);
        index = end + 3;
        continue;
      }
      if (source[index] === '<') { children.push(readElement()); continue; }
      const next = source.indexOf('<', index);
      if (next < 0) fail(`Element ${name} has trailing text`);
      text += source.slice(index, next);
      index = next;
    }
  };
  skipMisc();
  const root = readElement();
  skipMisc();
  return root;
}

export function serializeXml(node) {
  const attributes = Object.entries(node.attributes).map(([name, value]) => ` ${name}="${value}"`).join('');
  if (!node.children.length && !node.text) return `<${node.name}${attributes}/>`;
  return `<${node.name}${attributes}>${node.children.map(serializeXml).join('')}${node.text}</${node.name}>`;
}

export function walkElements(node, visit) {
  visit(node);
  for (const child of node.children) walkElements(child, visit);
}

export function findById(root, id) {
  let found = null;
  walkElements(root, (node) => { if (!found && node.attributes.id === id) found = node; });
  return found;
}

export function findElements(root, predicate) {
  const found = [];
  walkElements(root, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

export function decodeEntities(value) {
  return value.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[body] ?? match;
  });
}
