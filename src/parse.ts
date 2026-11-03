// ISO 10303-21 ("STEP part 21") reader: turns the DATA section into a map of
// entity id -> { type, args }. Knows nothing about geometry.
//
// Values: number | string | Ref | Enum | Typed | null ($) | '*' (derived) | Value[]

export class Ref { constructor(public id: number) {} }
export class Enum { constructor(public v: string) {} }
export class Typed { constructor(public type: string, public args: Value[]) {} }
export type Value = number | string | Ref | Enum | Typed | null | '*' | Value[];

export interface Entity {
  id: number;
  type: string;                       // for complex entities: the parts joined with '+'
  args: Value[];                      // simple entity arguments
  parts?: Record<string, Value[]>;    // complex entity: TYPE -> arguments
}

export interface StepFile {
  header: Record<string, Value[]>;
  entities: Map<number, Entity>;
  /** ids by entity type (simple types and every part of complex ones) */
  byType: Map<string, number[]>;
}

export class StepError extends Error {}

/** Decode \X2\...\X0\ (UTF-16 hex), \X\hh (ISO 8859-1) and \S\c escapes in STEP strings. */
export function decodeString(s: string): string {
  if (!s.includes('\\')) return s;
  return s
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex: string) => {
      let out = '';
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex: string) => {
      let out = '';
      for (let i = 0; i + 8 <= hex.length; i += 8) out += String.fromCodePoint(parseInt(hex.slice(i, i + 8), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, ch: string) => String.fromCharCode(ch.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

export function parseStep(text: string): StepFile {
  let i = 0;
  const n = text.length;

  const err = (msg: string): never => {
    const line = text.slice(0, i).split('\n').length;
    throw new StepError(`${msg} (line ${line})`);
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) { i++; continue; }
      if (c === 47 && text.charCodeAt(i + 1) === 42) {        // /* comment */
        const e = text.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      break;
    }
  };
  const keyword = (): string => {
    const s = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 33) i++;
      else break;
    }
    if (i === s) err('expected a keyword');
    return text.slice(s, i).toUpperCase();
  };

  const value = (): Value => {
    ws();
    const c = text[i];
    if (c === '#') {
      i++;
      const s = i;
      while (i < n && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
      return new Ref(Number(text.slice(s, i)));
    }
    if (c === "'") {
      i++;
      let out = '';
      for (;;) {
        const e = text.indexOf("'", i);
        if (e < 0) err('unterminated string');
        out += text.slice(i, e);
        i = e + 1;
        if (text[i] === "'") { out += "'"; i++; continue; }
        break;
      }
      return decodeString(out);
    }
    if (c === '(') {
      i++;
      const list: Value[] = [];
      ws();
      if (text[i] === ')') { i++; return list; }
      for (;;) {
        list.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ')') { i++; break; }
        err('expected , or ) in list');
      }
      return list;
    }
    if (c === '.') {                                  // .ENUM.
      const e = text.indexOf('.', i + 1);
      const v = text.slice(i + 1, e);
      i = e + 1;
      return new Enum(v.toUpperCase());
    }
    if (c === '$') { i++; return null; }
    if (c === '*') { i++; return '*'; }
    if (c === '"') {                                  // binary: keep as string
      const e = text.indexOf('"', i + 1);
      const v = text.slice(i + 1, e);
      i = e + 1;
      return v;
    }
    if (c === '-' || c === '+' || (c >= '0' && c <= '9')) {
      const s = i;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if ((d >= 48 && d <= 57) || d === 46 || d === 69 || d === 101 || d === 43 || d === 45) i++;
        else break;
      }
      const v = Number(text.slice(s, i));
      if (Number.isNaN(v)) err('bad number ' + text.slice(s, i));
      return v;
    }
    // typed parameter, e.g. LENGTH_MEASURE(0.001)
    const k = keyword();
    ws();
    if (text[i] !== '(') err('expected ( after ' + k);
    const args = value() as Value[];
    return new Typed(k, args);
  };

  const argList = (): Value[] => {
    ws();
    if (text[i] !== '(') err('expected (');
    return value() as Value[];
  };

  // ---- header
  const header: Record<string, Value[]> = {};
  const hs = text.indexOf('HEADER;');
  const ds = text.indexOf('DATA;');
  if (ds < 0) throw new StepError('Not a STEP file: no DATA section');
  if (hs >= 0 && hs < ds) {
    i = hs + 7;
    for (;;) {
      ws();
      if (text.startsWith('ENDSEC;', i)) break;
      const k = keyword();
      header[k] = argList();
      ws();
      if (text[i] === ';') i++;
    }
  }

  // ---- data
  const entities = new Map<number, Entity>();
  const byType = new Map<string, number[]>();
  const index = (t: string, id: number) => {
    let a = byType.get(t);
    if (!a) byType.set(t, (a = []));
    a.push(id);
  };
  i = ds + 5;
  for (;;) {
    ws();
    if (i >= n) break;
    if (text.startsWith('ENDSEC;', i)) break;
    if (text[i] !== '#') err('expected #id');
    i++;
    const s = i;
    while (i < n && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
    const id = Number(text.slice(s, i));
    ws();
    if (text[i] !== '=') err('expected =');
    i++;
    ws();
    if (text[i] === '(') {                            // complex entity
      i++;
      const parts: Record<string, Value[]> = {};
      for (;;) {
        ws();
        if (text[i] === ')') { i++; break; }
        const k = keyword();
        parts[k] = argList();
      }
      const type = Object.keys(parts).join('+');
      entities.set(id, { id, type, args: [], parts });
      for (const k of Object.keys(parts)) index(k, id);
    } else {
      const type = keyword();
      const args = argList();
      entities.set(id, { id, type, args });
      index(type, id);
    }
    ws();
    if (text[i] !== ';') err('expected ;');
    i++;
  }
  return { header, entities, byType };
}
