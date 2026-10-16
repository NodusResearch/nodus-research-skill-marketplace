// The route-program parser. It checks the SHAPE of a program and nothing else: whether a name
// resolves, whether a template exists and whether a SMARTS matches are the interpreter's
// questions, and answering them here would drag a toolkit into a module whose only job is to let
// the model be told, in microseconds, that line 9 is not a statement.
//
// Two decisions shape the code:
//  - Parsing is total. The caller reports every problem in one round, so a bad line is skipped and
//    the lines that did parse are still returned, rather than the first failure ending the pass.
//  - One diagnostic per statement at most. Once a statement's structure is wrong, later findings on
//    the same line are usually consequences of the first, and a fix prompt that lists them reads as
//    several problems when there is one.

import {
  MOL_REF,
  type ApplyLine,
  type DiagnosticCode,
  type MolRef,
  type Operation,
  type ParseResult,
  type ProgramDiagnostic,
  type ProgramLine,
  type SpeciesRef,
  type StartLine,
} from './routeProgramTypes';

/** A cap on statements, not on characters: the cost the interpreter pays is per line, and a program
 *  this long is a runaway generation rather than a route. */
const MAX_STATEMENTS = 256;

class Refusal {
  constructor(readonly code: DiagnosticCode, readonly message: string) {}
}

type Value =
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'handle'; v: string }
  | { t: 'list'; items: ListItem[] };

interface ListItem {
  key?: string;
  value: Value;
}

interface Arg {
  key?: string;
  value: Value;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

/** Reads the argument list of one call. A hand-written scanner rather than a regex because the
 *  strings may contain commas, brackets, parentheses and escaped quotes (SMARTS is full of all of
 *  them), which is what defeats splitting on punctuation. */
class Scanner {
  pos = 0;
  constructor(private readonly s: string) {}

  private skip(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  peek(): string {
    this.skip();
    return this.s[this.pos] ?? '';
  }

  atEnd(): boolean {
    this.skip();
    return this.pos >= this.s.length;
  }

  expect(ch: string, what: string): void {
    if (this.peek() !== ch) throw new Refusal('syntax', `Expected ${what} here, but found ${this.describeHere()}.`);
    this.pos++;
  }

  private describeHere(): string {
    const c = this.peek();
    return c === '' ? 'the end of the line' : `"${c}"`;
  }

  // Only a backslash before the delimiter is an escape. Every other backslash stays literal
  // because it is a bond direction in a SMILES string, and collapsing it would change the molecule.
  private string(): string {
    const q = this.s[this.pos++];
    let out = '';
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === '\\' && this.s[this.pos + 1] === q) {
        out += q;
        this.pos += 2;
      } else if (c === q) {
        this.pos++;
        return out;
      } else {
        out += c;
        this.pos++;
      }
    }
    throw new Refusal('syntax', 'A quoted string is opened but never closed.');
  }

  private list(): ListItem[] {
    this.pos++;
    const items: ListItem[] = [];
    if (this.peek() === ']') {
      this.pos++;
      return items;
    }
    for (;;) {
      const first = this.value(false);
      if (first.t === 'ident' && this.keywordFollows()) {
        this.pos++;
        items.push({ key: first.v, value: this.value(false) });
      } else {
        items.push({ value: first });
      }
      const c = this.peek();
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === ']') {
        this.pos++;
        return items;
      }
      throw new Refusal('syntax', `Expected "," or "]" in a list, but found ${this.describeHere()}.`);
    }
  }

  private keywordFollows(): boolean {
    return this.peek() === '=';
  }

  value(allowList: boolean): Value {
    const c = this.peek();
    if (c === '"' || c === "'") return { t: 'str', v: this.string() };
    if (c === '[') {
      if (!allowList) throw new Refusal('syntax', 'A list cannot be nested inside another list.');
      return { t: 'list', items: this.list() };
    }
    if (c === '@') {
      // Unquoted by design: a quoted "@last" is a phrase, and letting the two blur would turn a
      // typo in a quote into a silent change of meaning.
      const m = /[A-Za-z0-9_]*/y;
      m.lastIndex = this.pos + 1;
      const word = m.exec(this.s)![0];
      this.pos += 1 + word.length;
      return { t: 'handle', v: word };
    }
    IDENT.lastIndex = this.pos;
    const m = IDENT.exec(this.s);
    if (!m) throw new Refusal('syntax', `Expected a quoted string, a reference or a list, but found ${this.describeHere()}.`);
    this.pos += m[0].length;
    return { t: 'ident', v: m[0] };
  }

  /** Everything between the call's parentheses; the opening one has been consumed. */
  args(): Arg[] {
    const out: Arg[] = [];
    if (this.peek() === ')') {
      this.pos++;
      return this.finish(out);
    }
    for (;;) {
      const first = this.value(true);
      if (first.t === 'ident' && this.keywordFollows()) {
        this.pos++;
        out.push({ key: first.v, value: this.value(true) });
      } else {
        out.push({ value: first });
      }
      const c = this.peek();
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === ')') {
        this.pos++;
        return this.finish(out);
      }
      throw new Refusal('syntax', `Expected "," or ")" between arguments, but found ${this.describeHere()}.`);
    }
  }

  private finish(out: Arg[]): Arg[] {
    if (!this.atEnd()) throw new Refusal('syntax', 'There is extra text after the closing parenthesis.');
    return out;
  }
}

function asString(v: Value, what: string): string {
  if (v.t !== 'str') throw new Refusal('syntax', `${what[0].toUpperCase()}${what.slice(1)} must be a quoted string.`);
  return v.v;
}

function asRef(v: Value, what: string): MolRef {
  if (v.t !== 'ident' || !MOL_REF.test(v.v)) {
    throw new Refusal('syntax', `${what} must be a reference such as M1 (M1 to M999).`);
  }
  return v.v;
}

function speciesFromParts(names: string[], smiles: string[]): SpeciesRef {
  const n = names.map((x) => x.trim());
  const s = smiles.map((x) => x.trim());
  if (n.length + s.length === 0) throw new Refusal('bad-species', 'A species needs either a quoted name or smiles="...", and this one has neither.');
  if (n.length + s.length > 1) throw new Refusal('bad-species', 'A species must give exactly one of a name or smiles, and this one gives more.');
  const text = n.length ? n[0] : s[0];
  if (text === '') throw new Refusal('bad-species', 'A species name or SMILES string is empty.');
  return n.length ? { name: text } : { smiles: text };
}

function speciesFromList(items: ListItem[]): SpeciesRef[] {
  return items.map((item) => {
    if (item.key !== undefined && item.key !== 'smiles') {
      throw new Refusal('syntax', `A reagent may be a quoted name or smiles="...", not ${item.key}=.`);
    }
    const text = asString(item.value, 'A reagent');
    return item.key === 'smiles' ? speciesFromParts([], [text]) : speciesFromParts([text], []);
  });
}

function parseStart(ref: MolRef, line: number, args: Arg[]): StartLine {
  const names: string[] = [];
  const smiles: string[] = [];
  for (const a of args) {
    if (a.key === undefined) names.push(asString(a.value, 'A start species'));
    else if (a.key === 'smiles') smiles.push(asString(a.value, 'smiles'));
    else throw new Refusal('syntax', `The start call does not take ${a.key}=.`);
  }
  return { kind: 'start', line, ref, input: speciesFromParts(names, smiles) };
}

function parseApply(ref: MolRef, line: number, args: Arg[]): ApplyLine {
  if (args.length === 0 || args[0].key !== undefined) {
    throw new Refusal('syntax', 'An apply call must begin with the reference of the molecule it acts on.');
  }
  const from = asRef(args[0].value, 'The first argument of an apply call');
  const ops: Operation[] = [];
  let reagentsValue: Value | undefined;
  let siteValue: Value | undefined;
  let carryValue: Value | undefined;
  const seen = new Set<string>();
  for (const a of args.slice(1)) {
    if (a.key === undefined) throw new Refusal('syntax', 'Every argument after the reference must be written as key=value.');
    if (seen.has(a.key)) throw new Refusal('syntax', `The ${a.key}= argument is given more than once.`);
    seen.add(a.key);
    switch (a.key) {
      case 'template':
      case 'named': {
        const id = asString(a.value, `${a.key}=`).trim();
        if (id === '') throw new Refusal('syntax', `The ${a.key}= argument is empty.`);
        ops.push({ kind: a.key, id });
        break;
      }
      case 'smarts': {
        const smarts = asString(a.value, 'smarts=').trim();
        if (smarts === '') throw new Refusal('syntax', 'The smarts= argument is empty.');
        ops.push({ kind: 'smarts', smarts });
        break;
      }
      case 'reagents':
        reagentsValue = a.value;
        break;
      case 'site':
        siteValue = a.value;
        break;
      case 'carry':
        carryValue = a.value;
        break;
      default:
        throw new Refusal('syntax', `The apply call does not take ${a.key}=.`);
    }
  }
  if (ops.length !== 1) {
    throw new Refusal(
      'unknown-op',
      ops.length === 0
        ? 'An apply line needs exactly one of template=, named= or smarts=, and this one has none.'
        : 'An apply line needs exactly one of template=, named= or smarts=, and this one has more than one.',
    );
  }
  const result: ApplyLine = { kind: 'apply', line, ref, from, op: ops[0], reagents: [] };
  if (siteValue !== undefined) {
    if (siteValue.t === 'handle') {
      const h = siteValue.v;
      if (h !== 'last' && !MOL_REF.test(h)) {
        throw new Refusal('bad-site', `The site handle "@${h}" is not valid; use @last or a reference such as @M3.`);
      }
      result.site = { kind: 'handle', ref: h };
    } else {
      const phrase = asString(siteValue, 'site=').trim();
      if (phrase === '') throw new Refusal('bad-site', 'The site= argument is given but empty.');
      result.site = { kind: 'phrase', phrase };
    }
  }
  if (reagentsValue !== undefined) {
    if (reagentsValue.t !== 'list') throw new Refusal('syntax', 'The reagents= argument must be a list in square brackets.');
    result.reagents = speciesFromList(reagentsValue.items);
  }
  if (carryValue !== undefined) {
    // Two forms: the word, or a one-item list in exactly the shape reagents= takes, so there is no
    // new grammar to learn. A fragment is named as a STRUCTURE and not as a name, because the
    // fragment has to be compared against what the step actually formed and a name would have to
    // be resolved first — and the comparison is the point: a carry the step cannot form is an
    // error that names what it does form, instead of silently carrying the wrong molecule.
    if (carryValue.t === 'list') {
      const items = carryValue.items;
      if (items.length !== 1) throw new Refusal('syntax', 'The carry= list names exactly one fragment.');
      if (items[0].key !== 'smiles') throw new Refusal('syntax', 'A carried fragment is written as a structure: carry=[smiles="..."].');
      const smiles = asString(items[0].value, 'carry=[smiles=').trim();
      if (smiles === '') throw new Refusal('syntax', 'The carry=[smiles="..."] argument is given but empty.');
      result.carry = { kind: 'smiles', smiles };
    } else {
      const word = asString(carryValue, 'carry=').trim().toLowerCase();
      if (word === 'largest' || word === 'smallest') result.carry = { kind: word };
      else if (word === '') throw new Refusal('syntax', 'The carry= argument is given but empty.');
      else {
        throw new Refusal(
          'syntax',
          `carry="${word}" is not one of largest or smallest. To name the fragment instead, write it as a structure: carry=[smiles="..."].`,
        );
      }
    }
  }
  return result;
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const TARGET = /^target\s*=\s*(\S+)$/;
const NOTE = /^note\s+([^\s:]+)\s*:\s*(.*)$/;

type Statement =
  | { kind: 'line'; line: ProgramLine }
  | { kind: 'note'; line: number; ref: MolRef; text: string };

function parseStatement(text: string, lineNo: number): Statement {
  const note = NOTE.exec(text);
  if (note) {
    if (!MOL_REF.test(note[1])) throw new Refusal('syntax', `A note must name a reference such as M1, not "${note[1]}".`);
    if (note[2].trim() === '') throw new Refusal('syntax', `The note for ${note[1]} has no text.`);
    return { kind: 'note', line: lineNo, ref: note[1], text: note[2].trim() };
  }
  const target = TARGET.exec(text);
  if (target) {
    if (!MOL_REF.test(target[1])) throw new Refusal('syntax', `The target must be a reference such as M1, not "${target[1]}".`);
    return { kind: 'line', line: { kind: 'target', line: lineNo, ref: target[1] } };
  }
  const assign = ASSIGN.exec(text);
  if (!assign) throw new Refusal('syntax', 'This line is not a start, apply, note or target statement.');
  const [head, lhs, fn] = assign;
  if (!MOL_REF.test(lhs)) throw new Refusal('syntax', `The name "${lhs}" is not a valid reference; use M1 to M999.`);
  if (fn !== 'start' && fn !== 'apply') throw new Refusal('syntax', `The name "${fn}" is not an operation; use start or apply.`);
  const sc = new Scanner(text);
  sc.pos = head.length;
  const args = sc.args();
  return { kind: 'line', line: fn === 'start' ? parseStart(lhs, lineNo, args) : parseApply(lhs, lineNo, args) };
}

export function parseRouteProgram(text: string): ParseResult {
  const diagnostics: ProgramDiagnostic[] = [];
  const report = (line: number, code: DiagnosticCode, message: string): void => {
    diagnostics.push({ line, code, message });
  };

  const lines: ProgramLine[] = [];
  const notes: Extract<Statement, { kind: 'note' }>[] = [];
  let lastStatementLine = 1;
  let statements = 0;
  let truncated = false;

  const raw = String(text ?? '').split(/\r\n|\r|\n/);
  for (let i = 0; i < raw.length; i++) {
    const trimmed = raw[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const lineNo = i + 1;
    if (++statements > MAX_STATEMENTS) {
      report(lineNo, 'too-many-lines', `The program has more than ${MAX_STATEMENTS} statements; everything from this line on was ignored.`);
      truncated = true;
      break;
    }
    lastStatementLine = lineNo;
    try {
      const st = parseStatement(trimmed, lineNo);
      if (st.kind === 'note') notes.push(st);
      else lines.push(st.line);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      report(lineNo, e.code, e.message);
    }
  }

  // Where each ref is first assigned, so that a reference to a later line can be told apart from a
  // reference to nothing: the fix for one is to reorder, for the other to define.
  const assignedAt = new Map<MolRef, number>();
  const kept: ProgramLine[] = [];
  for (const l of lines) {
    if (l.kind === 'target') {
      kept.push(l);
      continue;
    }
    if (assignedAt.has(l.ref)) {
      report(l.line, 'duplicate-ref', `The reference ${l.ref} is already assigned on line ${assignedAt.get(l.ref)}; each reference may be assigned once.`);
      continue;
    }
    assignedAt.set(l.ref, l.line);
    kept.push(l);
  }

  const checkRef = (ref: MolRef, line: number, who: string): void => {
    const at = assignedAt.get(ref);
    if (at === undefined) report(line, 'unknown-ref', `${who} names ${ref}, which is never assigned.`);
    else if (at > line) report(line, 'forward-ref', `${who} names ${ref}, which is not assigned until line ${at}.`);
  };

  const program: ParseResult['program'] = { lines: kept };
  let sawStart = false;
  let sawTarget = false;
  let applies = 0;
  for (const l of kept) {
    if (l.kind === 'start') sawStart = true;
    else if (l.kind === 'apply') {
      applies++;
      if (l.from === l.ref) report(l.line, 'self-ref', `The reference ${l.ref} is built from itself.`);
      else checkRef(l.from, l.line, 'This apply line');
      const site = l.site;
      if (site?.kind === 'handle') {
        if (site.ref === 'last') {
          if (applies === 1) report(l.line, 'bad-site', 'The site @last has no previous operation to point at, because this is the first apply line.');
        } else if (site.ref === l.ref) {
          report(l.line, 'self-ref', `The site handle @${site.ref} points at the line that assigns it.`);
        } else {
          checkRef(site.ref, l.line, 'The site handle');
        }
      }
    } else {
      if (sawTarget) {
        report(l.line, 'syntax', 'There is more than one target line; only the first is used.');
        continue;
      }
      sawTarget = true;
      program.target = l.ref;
      checkRef(l.ref, l.line, 'The target');
    }
  }
  // The second target stays out of the returned lines so a consumer can trust there is one.
  program.lines = kept.filter((l, i) => l.kind !== 'target' || kept.findIndex((k) => k.kind === 'target') === i);

  const applyByRef = new Map<MolRef, ApplyLine>();
  for (const l of program.lines) if (l.kind === 'apply') applyByRef.set(l.ref, l);
  for (const n of notes) {
    const target = applyByRef.get(n.ref);
    if (!target) {
      report(n.line, 'unknown-ref', assignedAt.has(n.ref) ? `The reference ${n.ref} is a start molecule, and only apply lines take notes.` : `A note names ${n.ref}, which is never assigned by an apply line.`);
    } else if (target.note !== undefined) {
      report(n.line, 'syntax', `The reference ${n.ref} already has a note; the first one is kept.`);
    } else {
      target.note = n.text;
    }
  }

  // A truncated program may simply have put its start or target past the cut, so reporting those as
  // missing would send the model to add what it already wrote.
  if (!truncated) {
    if (!sawStart) report(lastStatementLine, 'no-start', 'The program has no start line.');
    if (!sawTarget) report(lastStatementLine, 'no-target', 'The program has no target line.');
  }

  diagnostics.sort((a, b) => a.line - b.line);
  return { program, diagnostics };
}
