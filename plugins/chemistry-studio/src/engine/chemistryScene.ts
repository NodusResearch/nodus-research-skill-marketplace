import { Molecule } from 'openchemlib';
import type { RDKitModule } from '@rdkit/rdkit';

export interface SceneAtom { id: string; element: string; charge: number; isotope: number; label: string; x: number; y: number; depth?: number; lonePairs?: number; radical?: number; unpaired?: number }
export interface SceneBond { id: string; a: number; b: number; order: number; stereo: number; plain?: boolean }
export interface ChemicalScene { atoms: SceneAtom[]; bonds: SceneBond[]; convention?: 'fischer' | 'haworth'; description?: string; spatial?: Array<{ x: number; y: number; z: number }> }

export function sceneFromMolfile(molfile: string): ChemicalScene {
  const m = Molecule.fromMolfile(molfile);
  m.ensureHelperArrays(Molecule.cHelperCIP);
  return {
    atoms: Array.from({ length: m.getAllAtoms() }, (_, a) => {
      const element = m.getAtomLabel(a), h = m.getImplicitHydrogens(a), charge = m.getAtomCharge(a), isotope = m.getAtomMass(a);
      const label = `${isotope ? `^{${isotope}}` : ''}${element}${h ? `H${h > 1 ? `_${h}` : ''}` : ''}${charge ? `^{${Math.abs(charge) > 1 ? Math.abs(charge) : ''}${charge > 0 ? '+' : '-'}}` : ''}`;
      // The molfile RAD value (1 singlet, 2 doublet, 3 triplet), which OpenChemLib keeps in the
      // high nibble. Without it RDKit re-reads a radical centre with one hydrogen more.
      const radical = m.getAtomRadical(a) >> 4;
      return { id: `a${a}`, element, charge, isotope, label, x: m.getAtomX(a), y: -m.getAtomY(a), ...(radical ? { radical } : {}) };
    }),
    bonds: Array.from({ length: m.getAllBonds() }, (_, b) => ({ id: `b${b}`, a: m.getBondAtom(0, b), b: m.getBondAtom(1, b), order: m.getBondOrder(b),
      stereo: m.getBondType(b) === Molecule.cBondTypeUp ? 1 : m.getBondType(b) === Molecule.cBondTypeDown ? 6 : 0 })),
  };
}

/** The skeletal convention: a neutral carbon with at least one bond is a bare vertex, its
 *  hydrogens implied by valence. Everything a reader could not infer keeps its label: a heteroatom
 *  and its hydrogens (OH, NH₂), a charged or isotopically labelled carbon, and a carbon with no
 *  bond at all (methane would otherwise draw as nothing). Only the label changes; the element,
 *  charge and coordinates the round-trip checks are untouched. */
export function skeletalLabels(scene: ChemicalScene): ChemicalScene {
  const bonded = new Set(scene.bonds.flatMap(bond => [bond.a, bond.b]));
  return { ...scene, atoms: scene.atoms.map((atom, index) => (atom.element === 'C' && !atom.charge && !atom.isotope && bonded.has(index) ? { ...atom, label: '' } : atom)) };
}

/** Independent molfile writer: no OCL parity cache may override edited geometry. */
export function sceneMolfile(scene: ChemicalScene): string {
  const field = (n: number) => String(n).padStart(3);
  const xyz = (n: number) => n.toFixed(4).padStart(10);
  const is3D = scene.convention === 'haworth' || !!scene.spatial;
  const atoms = scene.atoms.map((a, i) => {
    // Haworth uses y(screen projection) = .45*y(ring plane) + .8*z.
    const z = scene.spatial?.[i].z ?? (is3D ? a.depth ?? 0 : 0);
    const y = scene.spatial?.[i].y ?? (is3D ? (a.y - .8 * z) / .45 : a.y);
    return `${xyz(scene.spatial?.[i].x ?? a.x)}${xyz(y)}${xyz(z)} ${a.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
  });
  const bonds = scene.bonds.map(b => `${field(b.a + 1)}${field(b.b + 1)}${field(b.order)}${field(is3D ? 0 : b.stereo)}  0  0  0`);
  // V2000 property entries are " aaa vvv": a blank before each three-wide field. RDKit happens to
  // read a CHG line without them, but drops an ISO line written that way without an error.
  const props = scene.atoms.flatMap((a, i) => [
    ...(a.charge ? [`M  CHG  1 ${field(i + 1)} ${field(a.charge)}`] : []),
    ...(a.isotope ? [`M  ISO  1 ${field(i + 1)} ${field(a.isotope)}`] : []),
    ...(a.radical ? [`M  RAD  1 ${field(i + 1)} ${field(a.radical)}`] : []),
  ]);
  return `\n     Nodus          ${is3D ? '3D' : '2D'}\n\n${field(atoms.length)}${field(bonds.length)}  0  0  0  0  0  0  0  0999 V2000\n${[...atoms, ...bonds, ...props, 'M  END', ''].join('\n')}`;
}

/** Force a didactic tetrahedral perspective on a molecule with exactly one
 * four-coordinate single-bonded centre. Non-stereocentres such as chloroform carry
 * no wedge in the graph, so the scene must choose one solid wedge and one hashed
 * bond itself. The pair is chosen perpendicular in the projection so the four
 * directions stay distinct. Molecules with several such centres are left to the
 * ordinary explicit-hydrogen drawing, which is less cluttered. */
export function forceTetrahedralPerspective(scene: ChemicalScene): boolean {
  const incident: number[][] = scene.atoms.map(() => []);
  scene.bonds.forEach((bond, index) => { incident[bond.a].push(index); incident[bond.b].push(index); });
  const centres = scene.atoms.flatMap((atom, index) => ['C', 'N', 'Si'].includes(atom.element)
    && incident[index].length === 4 && incident[index].every(bond => scene.bonds[bond].order === 1) ? [index] : []);
  if (centres.length !== 1) return false;
  const centre = centres[0], bonds = incident[centre];
  const angle = (bond: number): number => {
    const other = scene.bonds[bond].a === centre ? scene.bonds[bond].b : scene.bonds[bond].a;
    return Math.atan2(scene.atoms[other].y - scene.atoms[centre].y, scene.atoms[other].x - scene.atoms[centre].x);
  };
  const first = bonds[0];
  let hashed = bonds[1], closest = Infinity;
  for (const bond of bonds.slice(1)) {
    const separation = Math.abs(angle(bond) - angle(first)) % Math.PI;
    const delta = Math.abs(separation - Math.PI / 2);
    if (delta < closest) { closest = delta; hashed = bond; }
  }
  // The renderer draws the narrow end at the bond's first atom, so the centre
  // must be that endpoint or the wedge/hash would point away from it.
  for (const bond of [first, hashed]) if (scene.bonds[bond].b === centre) {
    const other = scene.bonds[bond].a;
    scene.bonds[bond].a = centre;
    scene.bonds[bond].b = other;
  }
  scene.bonds[first].stereo = 1;
  scene.bonds[hashed].stereo = 6;
  return true;
}

export function canonicalScene(scene: ChemicalScene, kit: RDKitModule): string {
  const m = kit.get_mol(sceneMolfile(scene), JSON.stringify({ removeHs: true }));
  if (!m) throw new Error('The scene encodes an invalid chemical graph.');
  try { return m.get_smiles(); } finally { m.delete(); }
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const glyph = (s: string) => s.replace(/_([2-9])/g, (_, n) => '₀₁₂₃₄₅₆₇₈₉'[Number(n)]).replace(/\^\{([^}]+)\}/g, (_, text: string) => [...text].map(c => '0123456789+-'.includes(c) ? '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'['0123456789+-'.indexOf(c)] : c).join(''));

// Every main-group element: one missing from this table drew with no pairs at all, so
// hydrogen selenide came out with a bare selenium and still read as verified.
const VALENCE_ELECTRONS: Record<string, number> = {
  H: 1, Li: 1, Be: 2, B: 3, C: 4, N: 5, O: 6, F: 7, Na: 1, Mg: 2, Al: 3, Si: 4, P: 5, S: 6, Cl: 7,
  K: 1, Ca: 2, Ga: 3, Ge: 4, As: 5, Se: 6, Br: 7, Rb: 1, Sr: 2, In: 3, Sn: 4, Sb: 5, Te: 6, I: 7, Xe: 8,
};

/** Nonbonding pairs are derived from valence electrons, formal charge and the sum
 * of bond orders. The language model never supplies them. */
export function assignLonePairs(scene: ChemicalScene): void {
  const bondOrder = scene.atoms.map(() => 0);
  scene.bonds.forEach(bond => { bondOrder[bond.a] += bond.order; bondOrder[bond.b] += bond.order; });
  scene.atoms.forEach((atom, index) => {
    const electrons = (VALENCE_ELECTRONS[atom.element] ?? 0) - atom.charge - bondOrder[index];
    atom.lonePairs = Math.max(0, Math.min(4, Math.floor(electrons / 2)));
    // An odd count is a radical: its unpaired electron is drawn, not rounded away.
    atom.unpaired = electrons > 0 && electrons < 8 ? electrons % 2 : 0;
  });
}

export function renderScene(scene: ChemicalScene): string {
  const xs = scene.atoms.map(a => a.x), ys = scene.atoms.map(a => a.y);
  const minX = Math.min(...xs), maxY = Math.max(...ys), scale = 64;
  const w = Math.max(200, (Math.max(...xs) - minX) * scale + 100), h = (maxY - Math.min(...ys)) * scale + 100;
  const point = (i: number) => ({ x: 50 + (scene.atoms[i].x - minX) * scale, y: 50 + (maxY - scene.atoms[i].y) * scale });
  const paths = scene.bonds.map(b => {
    const a = point(b.a), c = point(b.b), dx = c.x - a.x, dy = c.y - a.y, length = Math.hypot(dx, dy);
    const px = -dy / length, py = dx / length;
    if (b.stereo && !b.plain) {
      if (b.stereo === 1) return `<path data-bond="${b.id}" d="M${a.x},${a.y} L${c.x + px * 5},${c.y + py * 5} L${c.x - px * 5},${c.y - py * 5}Z" fill="black"/>`;
      return Array.from({ length: 12 }, (_, i) => { const t = (i + 1) / 13, x = a.x + t * dx, y = a.y + t * dy; return `<path d="M${x - px * t * 5},${y - py * t * 5} L${x + px * t * 5},${y + py * t * 5}"/>`; }).join('');
    }
    return Array.from({ length: b.order }, (_, i) => { const offset = (i - (b.order - 1) / 2) * 4; return `<path data-bond="${b.id}" d="M${a.x + px * offset},${a.y + py * offset} L${c.x + px * offset},${c.y + py * offset}"/>`; }).join('');
  }).join('');
  const labels = scene.atoms.map((a, i) => { const p = point(i), label = glyph(a.label); return `<g data-atom="${a.id}"><rect x="${p.x - Math.max(9, label.length * 6)}" y="${p.y - 13}" width="${Math.max(18, label.length * 12)}" height="26" fill="white" stroke="none"/><text x="${p.x}" y="${p.y + 7}" text-anchor="middle" fill="black" stroke="none" font-family="Arial" font-size="21">${escape(label)}</text></g>`; }).join('');
  // Lone pairs occupy the directions left over after bonding: they cluster in the
  // widest angular gap between bonds rather than spreading between two bonds.
  const lonePairs = scene.atoms.map((atom, i) => {
    if (!atom.lonePairs && !atom.unpaired) return '';
    const count = (atom.lonePairs ?? 0) + (atom.unpaired ?? 0);
    const p = point(i), occupied: number[] = [];
    scene.bonds.forEach(bond => {
      const other = bond.a === i ? bond.b : bond.b === i ? bond.a : -1;
      if (other >= 0) { const q = point(other); occupied.push(Math.atan2(q.y - p.y, q.x - p.x)); }
    });
    let angles: number[];
    if (!occupied.length) angles = Array.from({ length: count }, (_, k) => k * 2 * Math.PI / count);
    else {
      const sorted = [...occupied].sort((a, b) => a - b);
      let start = sorted[0], widest = 0;
      for (let k = 0; k < sorted.length; k++) {
        const end = sorted[(k + 1) % sorted.length] + (k + 1 === sorted.length ? 2 * Math.PI : 0);
        if (end - sorted[k] > widest) { widest = end - sorted[k]; start = sorted[k]; }
      }
      const bisector = start + widest / 2, spread = Math.min(Math.PI / 3, widest / (count + 1));
      angles = Array.from({ length: count }, (_, k) => bisector + (k - (count - 1) / 2) * spread);
    }
    return angles.map((angle, k) => {
      const cx = p.x + Math.cos(angle) * 26, cy = p.y + Math.sin(angle) * 26;
      if (k >= (atom.lonePairs ?? 0)) return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.6" fill="black" stroke="none"/>`;
      const tx = -Math.sin(angle) * 4.5, ty = Math.cos(angle) * 4.5;
      return `<circle cx="${(cx + tx).toFixed(1)}" cy="${(cy + ty).toFixed(1)}" r="2.6" fill="black" stroke="none"/><circle cx="${(cx - tx).toFixed(1)}" cy="${(cy - ty).toFixed(1)}" r="2.6" fill="black" stroke="none"/>`;
    }).join('');
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><title>${escape(scene.description ?? 'Chemical scene')}</title><rect width="100%" height="100%" fill="white"/><g stroke="black" stroke-width="1.8" fill="none">${paths}${labels}${lonePairs}</g></svg>`;
}

/** A deliberately narrow, reversible ChemFig dialect, not arbitrary TeX. */
export function exportSceneChemfig(scene: ChemicalScene, anchoredBonds: ReadonlySet<number> = new Set()): string {
  const emitted = new Set<number>(), tree = new Set<number>();
  // Wedges must be explicit tree edges, never implicit ring closures. Build a
  // spanning tree with those edges first without changing atom order or parity.
  // A bond an electron arrow starts or ends on comes next: only a tree edge carries
  // the @{b…} name the arrow is drawn to, and a ring closure has none.
  const parents = scene.atoms.map((_, i) => i);
  const root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]));
  const rank = (b: SceneBond, i: number) => (b.stereo && !b.plain ? 2 : 0) + (anchoredBonds.has(i) ? 1 : 0);
  const edges = scene.bonds.map((b, i) => ({ b, i })).sort((x, y) => rank(y.b, y.i) - rank(x.b, x.i));
  for (const { b, i } of edges) if (root(b.a) !== root(b.b)) { parents[root(b.a)] = root(b.b); tree.add(i); }
  if (tree.size !== scene.atoms.length - 1) throw new Error('Disconnected ChemFig scenes are unsupported.');
  // node-tikzjax's TeX never returns once branches nest 32 deep (a 33-atom chain), and a
  // timed-out engine refuses every later compilation: refuse the export here instead.
  const render = (a: number, depth = 0): string => {
    if (depth > 30) throw new Error('ChemFig export exceeds the supported branch depth.');
    emitted.add(a);
    let text = `@{${scene.atoms[a].id}}${scene.atoms[a].label}`;
    scene.bonds.forEach((b, i) => { if (!tree.has(i) && (b.a === a || b.b === a)) {
      if (b.stereo && !b.plain) throw new Error('Stereochemical ring closures cannot be exported in this dialect.');
      text += `?[r${i},${b.order}]`;
    } });
    scene.bonds.forEach((b, i) => {
      const c = b.a === a ? b.b : b.b === a ? b.a : -1;
      if (c < 0 || !tree.has(i) || emitted.has(c)) return;
      const dx = scene.atoms[c].x - scene.atoms[a].x, dy = scene.atoms[c].y - scene.atoms[a].y;
      let symbol = b.order === 2 ? '=' : b.order === 3 ? '~' : '-';
      if (b.stereo && !b.plain) symbol = `${b.a === a ? '<' : '>'}${b.stereo === 6 ? ':' : ''}`;
      text += `(${symbol}[@{${b.id}}:${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(6)},${Math.hypot(dx, dy).toFixed(6)}]${render(c, depth + 1)})`;
    });
    return text;
  };
  const source = `\\chemfig[atom sep=30pt]{${render(0)}}`;
  if (source.length > 7500) throw new Error('ChemFig export exceeds the validated size limit.');
  return source;
}

/** Parse the actual emitted source, reconstruct coordinates/topology, then
 * check against the scene and the independent reference graph. */
export function verifySceneChemfig(source: string, expected: ChemicalScene, canonical: string, kit: RDKitModule): void {
  const prefix = '\\chemfig[atom sep=30pt]{';
  if (!source.startsWith(prefix) || !source.endsWith('}')) throw new Error('Unsupported ChemFig export dialect.');
  const body = source.slice(prefix.length, -1), atoms: SceneAtom[] = [], bonds: SceneBond[] = [], rings = new Map<string, [number, number]>();
  let p = 0;
  const read = (pattern: RegExp): RegExpExecArray => { const match = pattern.exec(body.slice(p)); if (!match) throw new Error(`Invalid ChemFig export at ${p}.`); p += match[0].length; return match; };
  const parse = (x: number, y: number): number => {
    const atom = read(/^@\{(a\d+)\}((?:(?:\^\{\d+\})?[A-Z][a-z]?(?:H(?:_[2-9])?)?(?:\^\{\d*[+-]\})?)?)/);
    // An unlabelled atom is a bare skeletal vertex, which is carbon by the convention the exporter
    // follows: `skeletalLabels` blanks only a neutral, unlabelled, bonded carbon. Its hydrogens are
    // implied, and the RDKit round-trip below recomputes them from valence.
    const definition: Array<string | undefined> = atom[2]
      ? /^(?:\^\{(\d+)\})?([A-Z][a-z]?)(?:H(?:_[2-9])?)?(?:\^\{(\d*)([+-])\})?$/.exec(atom[2])!
      : ['', undefined, 'C', undefined, undefined];
    const index = atoms.length;
    if (atoms.some(a => a.id === atom[1])) throw new Error('Duplicate exported atom ID.');
    atoms.push({ id: atom[1], label: atom[2], element: definition[2]!, isotope: Number(definition[1] ?? 0), charge: definition[4] ? Number(definition[3] || 1) * (definition[4] === '+' ? 1 : -1) : 0, x, y });
    while (p < body.length && body[p] !== ')') {
      if (body.startsWith('?[', p)) { const ring = read(/^\?\[(r\d+),([123])\]/), previous = rings.get(ring[1]);
        if (previous) { if (previous[1] !== Number(ring[2])) throw new Error('Inconsistent ring order.'); bonds.push({ id: '', a: previous[0], b: index, order: previous[1], stereo: 0 }); rings.delete(ring[1]); }
        else rings.set(ring[1], [index, Number(ring[2])]);
      } else {
        const bond = read(/^\((<:|>:|<|>|-|=|~)\[@\{(b\d+)\}:(-?[\d.]+),([\d.]+)\]/), angle = Number(bond[3]) * Math.PI / 180, length = Number(bond[4]);
        if (!Number.isFinite(angle) || !Number.isFinite(length) || length <= 0 || length > 100) throw new Error('Invalid export geometry.');
        const next = parse(x + length * Math.cos(angle), y + length * Math.sin(angle)); read(/^\)/);
        const reversed = bond[1].startsWith('>');
        bonds.push({ id: bond[2], a: reversed ? next : index, b: reversed ? index : next, order: bond[1] === '=' ? 2 : bond[1] === '~' ? 3 : 1, stereo: /[<>]/.test(bond[1]) ? bond[1].includes(':') ? 6 : 1 : 0 });
      }
    }
    return index;
  };
  parse(0, 0);
  if (p !== body.length || rings.size || atoms.length !== expected.atoms.length || bonds.length !== expected.bonds.length) throw new Error('Incomplete exported graph.');
  const origin = expected.atoms[0];
  for (const a of atoms) {
    const original = expected.atoms.find(e => e.id === a.id);
    if (!original || original.label !== a.label || Math.hypot(a.x - (original.x - origin.x), a.y - (original.y - origin.y)) > .0001) throw new Error('ChemFig changed an atom or its coordinates.');
    a.depth = original.depth;
  }
  for (const b of bonds) {
    const a = atoms[b.a].id, c = atoms[b.b].id;
    const original = expected.bonds.find(e => (expected.atoms[e.a].id === a && expected.atoms[e.b].id === c) || (!b.stereo && expected.atoms[e.a].id === c && expected.atoms[e.b].id === a));
    if (!original || (b.id && b.id !== original.id) || original.order !== b.order || (original.plain ? 0 : original.stereo) !== b.stereo) throw new Error('ChemFig changed a bond or wedge orientation.');
    // Reapply only the explicitly checked projection convention, never an
    // unconstrained stereochemical label supplied by the model.
    if (original.plain) { b.stereo = original.stereo; b.plain = true; if (expected.atoms[original.a].id !== a) [b.a, b.b] = [b.b, b.a]; }
  }
  // Restore absolute coordinates for Haworth's fixed ring-plane projection.
  atoms.forEach(a => { a.x += origin.x; a.y += origin.y; });
  const roundtrip = canonicalScene({ atoms, bonds, convention: expected.convention }, kit);
  if (roundtrip !== canonical) {
    // A 2-D layout must place an open double bond's substituents somewhere, and RDKit reads
    // that geometry back as E/Z. When the reference itself left the bond unspecified, that is
    // not a change to the compound: compare the constitutions (stereochemistry removed). When
    // the reference specifies stereochemistry, the round-trip must reproduce it exactly.
    const skeleton = (smiles: string): string => {
      const stripped = kit.get_mol(smiles.replace(/@/g, '').replace(/[\\/]/g, ''));
      if (!stripped) return smiles;
      try { return stripped.get_smiles(); } finally { stripped.delete(); }
    };
    if (/[@\\/]/.test(canonical) || skeleton(roundtrip) !== skeleton(canonical)) {
      throw new Error('ChemFig round-trip changed the reference graph or stereochemistry.');
    }
  }
}
