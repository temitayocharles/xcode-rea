/**
 * A deliberately small, dependency-free XML reader.
 *
 * Xcode project files, schemes and workspaces are simple, machine-generated
 * XML documents. This parser supports elements, attributes, text, CDATA,
 * comments, processing instructions, a DOCTYPE and the five predefined
 * entities (plus numeric character references). It is not a validating parser.
 */

export class XmlSyntaxError extends Error {
  constructor(message, position) {
    super(`${message} (at offset ${position})`);
    this.name = "XmlSyntaxError";
    this.position = position;
  }
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

function findTagEnd(text, start) {
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttributes(body) {
  const attrs = {};
  const pattern = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

/**
 * @param {string} text
 * @returns {{name: string, attrs: Record<string, string>, children: Array<any>}}
 */
export function parseXml(text) {
  const root = { name: "#document", attrs: {}, children: [] };
  const stack = [root];
  let index = 0;

  const pushText = (value) => {
    if (value.length > 0) stack[stack.length - 1].children.push(value);
  };

  while (index < text.length) {
    const lt = text.indexOf("<", index);
    if (lt === -1) {
      pushText(decodeEntities(text.slice(index)));
      break;
    }
    if (lt > index) pushText(decodeEntities(text.slice(index, lt)));

    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlSyntaxError("unterminated processing instruction", lt);
      index = end + 2;
      continue;
    }
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlSyntaxError("unterminated comment", lt);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlSyntaxError("unterminated CDATA section", lt);
      stack[stack.length - 1].children.push(text.slice(lt + 9, end));
      index = end + 3;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt + 2);
      if (end === -1) throw new XmlSyntaxError("unterminated declaration", lt);
      index = end + 1;
      continue;
    }
    if (text[lt + 1] === "/") {
      const end = text.indexOf(">", lt + 2);
      if (end === -1) throw new XmlSyntaxError("unterminated closing tag", lt);
      const name = text.slice(lt + 2, end).trim();
      if (stack.length === 1) throw new XmlSyntaxError(`unexpected closing tag </${name}>`, lt);
      const open = stack.pop();
      if (open.name !== name) {
        throw new XmlSyntaxError(`closing tag </${name}> does not match <${open.name}>`, lt);
      }
      index = end + 1;
      continue;
    }

    const end = findTagEnd(text, lt + 1);
    if (end === -1) throw new XmlSyntaxError("unterminated tag", lt);
    let body = text.slice(lt + 1, end);
    const selfClosing = body.trimEnd().endsWith("/");
    if (selfClosing) body = body.trimEnd().slice(0, -1);

    const nameMatch = /^([A-Za-z_:][\w.:-]*)/.exec(body);
    if (!nameMatch) throw new XmlSyntaxError("invalid tag name", lt);
    const name = nameMatch[1];
    const node = {
      name,
      attrs: parseAttributes(body.slice(nameMatch[0].length)),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    index = end + 1;
  }

  if (stack.length !== 1) {
    throw new XmlSyntaxError(`unclosed tag <${stack[stack.length - 1].name}>`, index);
  }
  return root;
}

/** @param {any} node */
export function textContent(node) {
  if (typeof node === "string") return node;
  if (!node || !Array.isArray(node.children)) return "";
  return node.children.map(textContent).join("");
}

/** Find the first descendant element with the given name. */
export function findElement(node, name) {
  if (!node || typeof node === "string") return null;
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findElement(child, name);
    if (found) return found;
  }
  return null;
}

/** Find every descendant element with the given name. */
export function findElements(node, name, out = []) {
  if (!node || typeof node === "string") return out;
  if (node.name === name) out.push(node);
  for (const child of node.children) findElements(child, name, out);
  return out;
}
