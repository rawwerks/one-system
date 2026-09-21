// Numbers never enter a JS number on the opaque wire path. Nodes keep spans in
// one source string rather than copying every nested subtree (quadratic space).
interface Span { source: string; start: number; end: number }
export type JsonNode =
  | (Span & { kind: 'object'; fields: Map<string, JsonNode> })
  | (Span & { kind: 'array'; items: JsonNode[] })
  | (Span & { kind: 'string'; value: string })
  | (Span & { kind: 'number' })
  | (Span & { kind: 'boolean'; value: boolean })
  | (Span & { kind: 'null' });
export type JsonObject = Extract<JsonNode, { kind: 'object' }>;
export const INT64_MAX = 9223372036854775807n;
const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const integerToken = /^-?(?:0|[1-9][0-9]*)$/;

export function raw(node: JsonNode): string {
  return node.source.slice(node.start, node.end);
}

// Iterative parsing matches encoding/json's 10,000-container nesting bound,
// including when arbitrary state/extensions are much deeper than JS's stack.
export function parseJSON(source: string): JsonNode {
  let at = 0;
  const fail = (): never => { throw new Error('Invalid JSON'); };
  const whitespace = () => {
    while (source[at] === ' ' || source[at] === '\t' || source[at] === '\r' || source[at] === '\n') at++;
  };
  const string = (): string => {
    const start = at++;
    for (;;) {
      const c = source.charCodeAt(at++);
      if (!Number.isFinite(c) || c < 32) fail();
      if (c === 34) break;
      if (c === 92) {
        const escaped = source[at++];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(at, at + 4))) fail();
          at += 4;
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) fail();
      }
    }
    // JSON.parse sees a STRING TOKEN ONLY, never an opaque numeric value.
    // Go replaces unpaired UTF-16 surrogates when decoding JSON strings.
    return (JSON.parse(source.slice(start, at)) as string).toWellFormed();
  };
  const value = (): JsonNode => {
    whitespace();
    const start = at;
    const c = source[at];
    if (c === '{') { at++; return { kind: 'object', source, start, end: at, fields: new Map() }; }
    if (c === '[') { at++; return { kind: 'array', source, start, end: at, items: [] }; }
    if (c === '"') {
      const decoded = string();
      return { kind: 'string', source, start, end: at, value: decoded };
    }
    for (const [literal, decoded] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(literal, at)) {
        at += literal.length;
        return decoded === null ? { kind: 'null', source, start, end: at }
          : { kind: 'boolean', source, start, end: at, value: decoded };
      }
    }
    numberToken.lastIndex = at;
    const match = numberToken.exec(source);
    if (!match) return fail();
    at = numberToken.lastIndex;
    return { kind: 'number', source, start, end: at };
  };
  const root = value();
  type Frame = { node: Extract<JsonNode, { kind: 'object' | 'array' }>; first: boolean };
  const stack: Frame[] = [];
  const enter = (node: JsonNode) => {
    if (node.kind === 'object' || node.kind === 'array') {
      if (stack.length >= 10_000) fail();
      stack.push({ node, first: true });
    }
  };
  enter(root);
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const node = frame.node;
    whitespace();
    const close = node.kind === 'object' ? '}' : ']';
    if (source[at] === close) {
      at++;
      node.end = at;
      stack.pop();
      continue;
    }
    if (!frame.first) {
      if (source[at++] !== ',') fail();
      whitespace();
      if (source[at] === close) fail();
    }
    frame.first = false;
    let key: string | undefined;
    if (node.kind === 'object') {
      if (source[at] !== '"') fail();
      key = string();
      whitespace();
      if (source[at++] !== ':') fail();
    }
    const child = value();
    if (node.kind === 'object') node.fields.set(key!, child);
    else node.items.push(child);
    enter(child);
  }
  whitespace();
  if (at !== source.length) fail();
  return root;
}

export function object(node: JsonNode | undefined): JsonObject {
  if (node?.kind !== 'object') throw new Error('Expected JSON object');
  return node;
}

export function text(node: JsonNode | undefined): string {
  if (node?.kind !== 'string') throw new Error('Expected JSON string');
  return node.value;
}

// Exact mathematical integer classification, even for 1e999999 and 1e-999999.
// Exponents only compare to bounded token lengths, so saturation is harmless.
function integral(token: string): boolean {
  const [coefficient = '', exponent] = token.split(/[eE]/);
  const digits = coefficient.replace(/[-.]/g, '');
  const trimmed = digits.replace(/0+$/, '');
  if (trimmed === '') return true;
  const dot = coefficient.indexOf('.');
  const fraction = dot < 0 ? 0 : coefficient.length - dot - 1;
  return (exponent === undefined ? 0 : Number(exponent)) >= fraction - (digits.length - trimmed.length);
}

// The build-time schema guard proves number values are observed by TYPE ONLY.
// A number is projected to an exact representative of its numeric type: 0 for
// mathematical integers and 0.5 otherwise. This view is NEVER serialized.
export function validationView(root: JsonNode): unknown {
  const values = new Map<JsonNode, unknown>();
  const pending: Array<[JsonNode, boolean]> = [[root, false]];
  while (pending.length) {
    const [node, complete] = pending.pop()!;
    if (!complete && (node.kind === 'object' || node.kind === 'array')) {
      pending.push([node, true]);
      const children = node.kind === 'object' ? node.fields.values() : node.items;
      for (const child of children) pending.push([child, false]);
      continue;
    }
    switch (node.kind) {
      case 'number': values.set(node, integral(raw(node)) ? 0 : 0.5); break;
      case 'null': values.set(node, null); break;
      case 'string': case 'boolean': values.set(node, node.value); break;
      case 'array': values.set(node, node.items.map(child => values.get(child))); break;
      case 'object': {
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, child] of node.fields) result[key] = values.get(child);
        values.set(node, result);
        break;
      }
    }
  }
  return values.get(root);
}

export function signedInteger(node: JsonNode | undefined): bigint {
  if (node?.kind !== 'number' || !integerToken.test(raw(node))) throw new Error('Expected int64 token');
  const token = raw(node);
  // Avoid allocating arbitrary-size BigInts from attacker-controlled usage.
  if (token.length > 20) throw new Error('Integer exceeds int64');
  const n = BigInt(token);
  if (n < -INT64_MAX - 1n || n > INT64_MAX) throw new Error('Integer exceeds int64');
  return n;
}

export function finiteFloat(node: JsonNode | undefined, nullValue = 0): number {
  if (node === undefined || node.kind === 'null') return nullValue;
  if (node.kind !== 'number') throw new Error('Expected float64 token');
  const value = Number(raw(node));
  // Go float64 decoding rejects overflow, but accepts underflow and signed zero.
  if (!Number.isFinite(value)) throw new Error('Float64 overflow');
  return value;
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

// Only the named object layer is rebuilt; untouched subtrees retain every
// number lexeme, duplicate member, escape sequence and extension value.
export function encodeObject(fields: Iterable<readonly [string, string]>): string {
  return '{' + Array.from(fields, ([key, value]) => quote(key) + ':' + value).join(',') + '}';
}

export function replaceFields(node: JsonObject, replacements: ReadonlyMap<string, string>): string {
  const fields = new Map<string, string>();
  for (const [key, value] of node.fields) fields.set(key, replacements.get(key) ?? raw(value));
  for (const [key, value] of replacements) fields.set(key, value);
  return encodeObject(fields);
}

export function compact(source: string): string {
  // Compaction is lexical, not a decode/re-encode. Escaped Unicode contributes
  // its literal ASCII spelling just as encoding/json.Compact does in Go.
  const pieces: string[] = [];
  let start = 0;
  let quoted = false;
  for (let at = 0; at < source.length; at++) {
    const c = source[at];
    if (quoted) {
      if (c === '\\') at++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      if (start !== at) pieces.push(source.slice(start, at));
      start = at + 1;
    }
  }
  if (start === 0) return source;
  pieces.push(source.slice(start));
  return pieces.join('');
}

// Go string sorting is UTF-8/codepoint order, not JS's UTF-16 code-unit order.
export function compareIDs(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const diff = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
}
