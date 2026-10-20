/**
 * Parser and serializer for Apple's old-style (OpenStep) property lists.
 *
 * `.pbxproj`, `.xcspec`, `.xcconfig` and many Xcode support files use this
 * format. Encoding is UTF-8; the leading `// !$*UTF8*$!` marker is a comment.
 *
 * Grammar (informal):
 *   value  := dict | array | data | quoted | unquoted
 *   dict   := '{' (key '=' value ';')* '}'
 *   array  := '(' (value (',' value)*)? ','? ')'
 *   data   := '<' hex* '>'
 */

const UNQUOTED_CHAR = /[A-Za-z0-9_$+/:.\-]/;

export class PlistSyntaxError extends Error {
  constructor(message, source, line, column) {
    super(`${source ?? "<plist>"}:${line}:${column}: ${message}`);
    this.name = "PlistSyntaxError";
    this.source = source;
    this.line = line;
    this.column = column;
  }
}

class Parser {
  constructor(text, source) {
    this.text = text;
    this.source = source;
    this.index = 0;
    this.line = 1;
    this.column = 1;
  }

  error(message) {
    throw new PlistSyntaxError(message, this.source, this.line, this.column);
  }

  peek(offset = 0) {
    return this.text[this.index + offset];
  }

  next() {
    const char = this.text[this.index++];
    if (char === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return char;
  }

  skipTrivia() {
    for (;;) {
      const char = this.peek();
      if (char === undefined) return;
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        this.next();
        continue;
      }
      if (char === "/" && this.peek(1) === "/") {
        while (this.peek() !== undefined && this.peek() !== "\n") this.next();
        continue;
      }
      if (char === "/" && this.peek(1) === "*") {
        this.next();
        this.next();
        while (!(this.peek() === "*" && this.peek(1) === "/")) {
          if (this.peek() === undefined) this.error("unterminated block comment");
          this.next();
        }
        this.next();
        this.next();
        continue;
      }
      return;
    }
  }

  parseDocument() {
    this.skipTrivia();
    const value = this.parseValue();
    this.skipTrivia();
    if (this.peek() !== undefined) this.error("trailing data after root value");
    return value;
  }

  parseValue() {
    this.skipTrivia();
    const char = this.peek();
    if (char === undefined) this.error("unexpected end of input");
    if (char === "{") return this.parseDict();
    if (char === "[") return this.parseArray("[", "]");
    if (char === "(") return this.parseArray("(", ")");
    if (char === '"') return this.parseQuoted();
    if (char === "'") return this.parseSingleQuoted();
    if (char === "<") return this.parseData();
    return this.parseUnquoted();
  }

  parseDictKey() {
    const char = this.peek();
    if (char === '"') return this.parseQuoted();
    if (char === "'") return this.parseSingleQuoted();
    return this.parseUnquoted();
  }

  parseDict() {
    this.next(); // {
    const result = {};
    for (;;) {
      this.skipTrivia();
      if (this.peek() === "}") {
        this.next();
        return result;
      }
      if (this.peek() === undefined) this.error("unterminated dictionary");
      const key = this.parseDictKey();
      this.skipTrivia();
      if (this.peek() !== "=") this.error(`expected "=" after key ${JSON.stringify(key)}`);
      this.next();
      const value = this.parseValue();
      this.skipTrivia();
      if (this.peek() !== ";") this.error(`expected ";" after value for key ${JSON.stringify(key)}`);
      this.next();
      result[key] = value;
    }
  }

  parseArray(open = "(", close = ")") {
    this.next(); // open delimiter
    const result = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === close) {
        this.next();
        return result;
      }
      if (this.peek() === undefined) this.error("unterminated array");
      result.push(this.parseValue());
      this.skipTrivia();
      if (this.peek() === ",") {
        this.next();
        continue;
      }
      if (this.peek() === close) {
        this.next();
        return result;
      }
      this.error(`expected "," or "${close}" in array`);
    }
  }

  parseQuoted() {
    this.next();
    let value = "";
    for (;;) {
      const char = this.next();
      if (char === undefined) this.error("unterminated quoted string");
      if (char === '"') return value;
      if (char !== "\\") {
        value += char;
        continue;
      }
      value += this.parseEscape();
    }
  }

  parseSingleQuoted() {
    this.next();
    let value = "";
    for (;;) {
      const char = this.next();
      if (char === undefined) this.error("unterminated quoted string");
      if (char === "'") return value;
      if (char !== "\\") {
        value += char;
        continue;
      }
      value += this.parseEscape();
    }
  }

  parseEscape() {
    const char = this.next();
    if (char === undefined) this.error("unterminated escape sequence");
    switch (char) {
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "v":
        return "\v";
      case "a":
        return "\x07";
      case '"':
        return '"';
      case "'":
        return "'";
      case "\\":
        return "\\";
      case "\n":
        return "";
      case "U":
      case "u": {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.error("invalid \\U escape");
        for (let i = 0; i < 4; i += 1) this.next();
        return String.fromCharCode(parseInt(hex, 16));
      }
      default: {
        if (/[0-7]/.test(char)) {
          let octal = char;
          for (let i = 0; i < 2; i += 1) {
            const digit = this.peek();
            if (digit !== undefined && /[0-7]/.test(digit)) {
              octal += this.next();
            }
          }
          return String.fromCharCode(parseInt(octal, 8));
        }
        return char;
      }
    }
  }

  parseData() {
    this.next(); // <
    let hex = "";
    for (;;) {
      const char = this.next();
      if (char === undefined) this.error("unterminated data literal");
      if (char === ">") break;
      if (/\s/.test(char)) continue;
      if (!/[0-9a-fA-F]/.test(char)) this.error("invalid hex digit in data literal");
      hex += char;
    }
    if (hex.length % 2 !== 0) this.error("data literal has an odd number of hex digits");
    return Buffer.from(hex, "hex");
  }

  parseUnquoted() {
    let value = "";
    while (this.peek() !== undefined && UNQUOTED_CHAR.test(this.peek())) {
      value += this.next();
    }
    if (value.length === 0) {
      this.error(`unexpected character ${JSON.stringify(this.peek())}`);
    }
    return value;
  }
}

/**
 * @param {string} text
 * @param {{source?: string}} [options]
 * @returns {unknown}
 */
export function parseOpenStep(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("parseOpenStep expects a string");
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return new Parser(stripped, options.source).parseDocument();
}

const BARE_KEY = /^[A-Za-z0-9_$+/:.\-]+$/;

function quoteString(value) {
  if (value.length > 0 && BARE_KEY.test(value) && !value.startsWith("//") && !value.startsWith("/*")) {
    return value;
  }
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      default: {
        const code = char.codePointAt(0);
        if (code < 0x20 || code === 0x7f) {
          escaped += `\\U${code.toString(16).padStart(4, "0").toUpperCase()}`;
        } else {
          escaped += char;
        }
      }
    }
  }
  return `"${escaped}"`;
}

function stringifyValue(value, depth) {
  if (Buffer.isBuffer(value)) return `<${value.toString("hex")}>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "()";
    return `(${value.map((item) => stringifyValue(item, depth)).join(", ")})`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const pad = "\t".repeat(depth + 1);
    const close = "\t".repeat(depth);
    const body = entries
      .map(([key, item]) => `${pad}${quoteString(key)} = ${stringifyValue(item, depth + 1)};`)
      .join("\n");
    return `{\n${body}\n${close}}`;
  }
  if (value === true) return "YES";
  if (value === false) return "NO";
  if (value === null || value === undefined) return '""';
  return quoteString(String(value));
}

/**
 * Serialize a JS value as an OpenStep property list.
 * @param {unknown} value
 * @param {{header?: boolean}} [options]
 */
export function stringifyOpenStep(value, options = {}) {
  const header = options.header === false ? "" : "// !$*UTF8*$!\n";
  return `${header}${stringifyValue(value, 0)}\n`;
}
