import { MAX_SPECIES_CHARS } from './chemistryLimits';
import { Molecule } from 'openchemlib';
import type { RDKitLoader, RDKitModule, JSMol } from '@rdkit/rdkit';
import { requireVendored } from './vendor';
import type { ChemistryGraph, ChemistryInspectionSummary, ChemistryPartialReason, ChemistryValidationRequest, ChemistryValidationResult } from './chemistryDocument';
import { formulaOf } from './chemistryElements';
import { rdkitAtomPalette } from './elementColours';
import { sceneFromMolfile, sceneMolfile, renderScene, exportSceneChemfig, verifySceneChemfig, forceTetrahedralPerspective, assignLonePairs } from './chemistryScene';
import { deriveProjection } from './chemistryProjections';
import { deriveMechanism } from './chemistryMechanisms';
import { deriveNewman, exportNewman, verifyNewman, renderNewman, newmanEvidence } from './chemistryNewman';
import { renderCheckedMechanism, renderExtendedMechanism } from './chemistryRuleRender';

/**
 * Elements where RDKit's CIP labeller and implicit-valence model are dependable.
 * Anything outside still draws; it just downgrades the document to `partial`.
 */
const ORGANIC_CIP_ELEMENTS = new Set([1, 5, 6, 7, 8, 9, 14, 15, 16, 17, 35, 53]);

let engine: Promise<RDKitModule> | undefined;
function rdkit(): Promise<RDKitModule> {
  // Loaded from the package's own vendor tree, and only when a structure actually needs
  // validating: this is several megabytes of WebAssembly.
  return engine ??= (requireVendored<RDKitLoader | { default: RDKitLoader }>('@rdkit/rdkit') as { default?: RDKitLoader } & RDKitLoader).default?.() ?? (requireVendored<RDKitLoader>('@rdkit/rdkit'))();
}

/** A structure's heavy-atom graph: element, formal charge and radical count per atom, and each
 *  bond's order in the Kekulé form (an aromatic ring reads as alternating 1 and 2). The ions of
 *  a salt are atoms of the same graph with no bond between them. */
export interface MoleculeGraph { elements: number[]; charges: number[]; radicals: number[]; bonds: Array<[number, number, number]> }

export async function moleculeGraph(smiles: string): Promise<MoleculeGraph> {
  const kit = await rdkit();
  const molecule = kit.get_mol(smiles);
  if (!molecule) throw new Error('RDKit rejected the molecular graph.');
  try {
    if (!molecule.is_valid()) throw new Error('Invalid molecular graph.');
    const json = JSON.parse(molecule.get_json()) as {
      defaults: { atom: { z: number; chg: number; nRad: number }; bond: { bo: number } };
      molecules: Array<{ atoms: Array<{ z?: number; chg?: number; nRad?: number }>; bonds?: Array<{ atoms: [number, number]; bo?: number }> }>;
    };
    const graph: MoleculeGraph = { elements: [], charges: [], radicals: [], bonds: [] };
    for (const raw of json.molecules) {
      const offset = graph.elements.length;
      for (const atom of raw.atoms) {
        graph.elements.push(atom.z ?? json.defaults.atom.z);
        graph.charges.push(atom.chg ?? json.defaults.atom.chg);
        graph.radicals.push(atom.nRad ?? json.defaults.atom.nRad);
      }
      for (const bond of raw.bonds ?? []) graph.bonds.push([bond.atoms[0] + offset, bond.atoms[1] + offset, bond.bo ?? json.defaults.bond.bo]);
    }
    return graph;
  } finally {
    molecule.delete();
  }
}

/**
 * Whether an unspecified double bond is genuinely ambiguous.
 *
 * OpenChemLib exempts rings of seven atoms or fewer (`isSmallRingBond`) and treats
 * every larger ring double bond exactly like an acyclic one. That threshold is right
 * in general — trans-cyclooctene is isolable, so an eight-ring really does have two
 * geometries — but it misfires on a double bond fused into a smaller ring, where the
 * ring system already fixes the geometry. Porphyrin and chlorophyll cores are the
 * cases that matter: their meso bridges were reported as unspecified E/Z.
 */
function stereogenicRingBond(molecule: Molecule, bond: number, rings: ReturnType<Molecule['getRingSet']>): boolean {
  if (!molecule.isRingBond(bond)) return true;
  if (molecule.isAromaticBond(bond)) return false;
  if (molecule.getBondRingSize(bond) < 8) return false;
  const first = molecule.getBondAtom(0, bond), second = molecule.getBondAtom(1, bond);
  for (let ring = 0; ring < rings.getSize(); ring++) {
    const atoms = rings.getRingAtoms(ring);
    if (atoms.includes(first) || atoms.includes(second)) return false;
  }
  return true;
}

function layoutPenalty(molfile: string): number {
  const molecule = Molecule.fromMolfile(molfile);
  let length = 0;
  for (let b = 0; b < molecule.getAllBonds(); b++) {
    const a = molecule.getBondAtom(0, b), c = molecule.getBondAtom(1, b);
    length += Math.hypot(molecule.getAtomX(a) - molecule.getAtomX(c), molecule.getAtomY(a) - molecule.getAtomY(c));
  }
  const unit = length / Math.max(1, molecule.getAllBonds()) || 1;
  let penalty = 0;
  for (let a = 0; a < molecule.getAllAtoms(); a++) {
    for (let b = a + 1; b < molecule.getAllAtoms(); b++) {
      const distance = Math.hypot(molecule.getAtomX(a) - molecule.getAtomX(b), molecule.getAtomY(a) - molecule.getAtomY(b)) / unit;
      penalty += Math.max(0, 0.9 - distance) ** 2;
    }
  }
  return penalty;
}

/** The element-and-isotope composition and net charge of a verified graph. Hydrogens are
 *  counted from each heavy atom's implicit count, so a formula includes them. */
function compositionOf(atoms: ChemistryGraph['atoms']): { composition: Record<string, number>; charge: number; heavyAtoms: number } {
  const composition: Record<string, number> = {};
  let charge = 0;
  for (const atom of atoms) {
    const key = `${atom.atomicNumber}:${atom.isotope || 0}`;
    composition[key] = (composition[key] ?? 0) + 1;
    if (atom.hydrogens) composition['1:0'] = (composition['1:0'] ?? 0) + atom.hydrogens;
    charge += atom.charge ?? 0;
  }
  return { composition, charge, heavyAtoms: atoms.length };
}

/** A `*` is accepted only as one solid support (chemistryElements SUPPORT): a single bare `*` or
 *  `[*]`. Several, or a labelled or isotopic one (`[*:1]`, `[1*]`), is a generic structure. */
function supportAllowed(smiles: string): boolean {
  const stars = (smiles.match(/\*/g) ?? []).length;
  if (stars === 0) return true;
  // The bracketed form must be exactly `[*]`. Testing "not preceded by `[`" accepted `[1*]`,
  // because the digit satisfied it — an isotopically labelled attachment point, which is a
  // generic structure and would otherwise have been conserved through the balance as a support.
  if (stars !== 1) return false;
  const bare = smiles.replace(/\[\*\]/g, '');
  if (!bare.includes('*')) return true;
  // The one remaining `*` is unbracketed only if no `[` is open where it sits.
  const index = bare.indexOf('*');
  const before = bare.slice(0, index);
  const opened = (before.match(/\[/g) ?? []).length;
  const closed = (before.match(/\]/g) ?? []).length;
  return opened === closed;
}

/** Call only inside a killable process: WASM cannot be interrupted by Promise.race. */
export async function validateChemicalReferences(request: ChemistryValidationRequest): Promise<ChemistryValidationResult> {
  if (!Array.isArray(request.references) || request.references.length < 1 || request.references.length > 3
    || request.references.some(s => typeof s !== 'string' || !s || s.length > MAX_SPECIES_CHARS || /\s|\|/.test(s) || !supportAllowed(s))) {
    throw new Error('Unsupported molecular input.');
  }
  if (request.references.some(s => /@(?:AL|SP|TB|OH|TH)/.test(s))) throw new Error('Extended or non-tetrahedral stereochemistry is outside the validated scope.');
  const kit = await rdkit();
  const owned: JSMol[] = [];
  const parse = (source: string): JSMol => {
    const molecule = kit.get_mol(source);
    if (!molecule) throw new Error('RDKit rejected the molecular graph.');
    owned.push(molecule);
    if (!molecule.is_valid()) throw new Error('Invalid molecular graph.');
    return molecule;
  };
  try {
    const refs = request.references.map(parse);
    for (const [index, molecule] of refs.entries()) {
      const specified = (request.references[index].match(/\[[^\]]*@{1,2}[^\]]*\]/g) ?? []).length;
      const tags = JSON.parse(molecule.get_stereo_tags()) as { CIP_atoms: Array<[number, string]>; CIP_bonds: unknown[] };
      if (specified !== tags.CIP_atoms.filter(([, tag]) => tag !== '(?)').length) throw new Error('A supplied stereochemical annotation was discarded or cannot be validated.');
      if (/[\\/]/.test(request.references[index]) && !tags.CIP_bonds.length) throw new Error('A supplied double-bond stereochemical annotation was discarded.');
    }
    // Same engine, same canonicalization, stereo/isotope/charge retained. Never
    // compare canonical strings produced by different toolkits or sorted CIP lists.
    let reference = refs[0];
    let reconciledStereochemistry = false;
    if (refs.some(m => m.get_smiles() !== reference.get_smiles())) {
      // OPSIN reads a systematic name literally, so it returns the flat skeleton where
      // PubChem returns the curated isomer. That is not a disagreement about which
      // molecule this is, and refusing it left the user holding a message they could do
      // nothing with. When the references agree on connectivity, charge and isotopes,
      // adopt the most specified form and declare it, rather than abstaining over the
      // other's silence. A real disagreement about the graph still refuses.
      // Re-canonicalize each reference with its stereo descriptors removed. Chirality
      // and double-bond direction are the only things `@`, `/` and `\` encode, so the
      // result is the bare skeleton, compared through the same engine as everything else.
      const skeletonOf = (molecule: JSMol): string => parse(molecule.get_smiles().replace(/@/g, '').replace(/[\\/]/g, '')).get_smiles();
      const skeleton = skeletonOf(reference);
      if (refs.some(m => skeletonOf(m) !== skeleton)) throw new Error('Chemical references disagree on connectivity, charge, isotope or stereochemistry.');
      const specified = (molecule: JSMol): number => {
        const tags = JSON.parse(molecule.get_stereo_tags()) as { CIP_atoms: Array<[number, string]>; CIP_bonds: unknown[] };
        return tags.CIP_atoms.filter(([, tag]) => tag !== '(?)').length + tags.CIP_bonds.length;
      };
      // Silence may be filled in; contradiction may not. Every other reference has to
      // be stereochemically mute, so this stays a case of one source saying nothing.
      // Two references that both specify and disagree — R against S — are a real
      // conflict about which compound this is, and still refuse.
      reference = refs.reduce((chosen, molecule) => specified(molecule) > specified(chosen) ? molecule : chosen, reference);
      if (refs.some(m => m !== reference && specified(m) > 0)) throw new Error('Chemical references disagree on connectivity, charge, isotope or stereochemistry.');
      reconciledStereochemistry = true;
    }
    const canonicalSmiles = reference.get_smiles();
    const partialReasons = new Set<ChemistryPartialReason>();
    const ocl = Molecule.fromSmiles(canonicalSmiles);
    // Size is a resource guard, not a chemical judgement: a large structure still
    // draws, it simply stops carrying a full-verification claim.
    if (ocl.getAllAtoms() > 600) throw new Error('Structures above 600 atoms cannot be drawn in the available time budget.');
    if (ocl.getAllAtoms() > 160) partialReasons.add('structure-above-validated-size');
    ocl.ensureHelperArrays(Molecule.cHelperCIP);
    const degree = Array.from({ length: ocl.getAllAtoms() }, () => 0);
    for (let b = 0; b < ocl.getAllBonds(); b++) { degree[ocl.getBondAtom(0, b)]++; degree[ocl.getBondAtom(1, b)]++; }
    for (let atom = 0; atom < ocl.getAllAtoms(); atom++) {
      if (ocl.getAtomLabel(atom) !== 'C') continue;
      const doubleNeighbours: number[] = [];
      for (let b = 0; b < ocl.getAllBonds(); b++) {
        if (ocl.getBondOrder(b) !== 2) continue;
        if (ocl.getBondAtom(0, b) === atom) doubleNeighbours.push(ocl.getBondAtom(1, b));
        else if (ocl.getBondAtom(1, b) === atom) doubleNeighbours.push(ocl.getBondAtom(0, b));
      }
      // A cumulated system has a stereogenic axis only when BOTH ends of the WHOLE chain carry
      // two substituents and the chain has an even number of double bonds. The end groups then
      // lie in perpendicular planes and the axis has a configuration — the allene case, which
      // SMILES writes as @/@@ on the central atom and which this validator does not certify.
      //
      // The parity matters: an even count (allene, [4]cumulene) is perpendicular and so axial,
      // an odd count (butatriene) is coplanar and is ordinary E/Z, which the bond-parity check
      // below already handles. An end carrying one substituent and a lone pair (a carbodiimide
      // nitrogen, R–N=C=N–R') or none (a ketene oxygen, carbon dioxide) has no configuration to
      // express, so there is nothing to get wrong and nothing to refuse.
      //
      // Both ends means the ends of the chain, not the atoms next to this one: counting the
      // double bonds alone refused carbon dioxide; asking only that ONE end carries the chain
      // onwards then refused every carbodiimide — the standard amide coupling reagent — and so
      // failed every route that forms an amide with one; and inspecting only the immediate
      // neighbours accepted a substituted [4]cumulene, whose inner atoms each see a neighbour
      // carrying nothing but the chain.
      if (doubleNeighbours.length === 2) {
        const substituents = (end: number) => degree[end] - 1 + ocl.getImplicitHydrogens(end);
        const ends: number[] = [];
        let doubleBonds = 0;
        let cyclic = false;
        for (const direction of doubleNeighbours) {
          const seen = new Set<number>([atom]);
          let previous = atom;
          let current = direction;
          doubleBonds += 1;
          // Walk to the end of the cumulated chain: an atom with two double bonds carries it
          // onwards, one with a single double bond is an end. `seen` stops a cyclic cumulene.
          for (;;) {
            if (seen.has(current)) { cyclic = true; break; }
            seen.add(current);
            const onwards: number[] = [];
            for (let b = 0; b < ocl.getAllBonds(); b++) {
              if (ocl.getBondOrder(b) !== 2) continue;
              const a0 = ocl.getBondAtom(0, b), a1 = ocl.getBondAtom(1, b);
              if (a0 === current && a1 !== previous) onwards.push(a1);
              else if (a1 === current && a0 !== previous) onwards.push(a0);
            }
            if (onwards.length !== 1) { ends.push(current); break; }
            doubleBonds += 1;
            previous = current;
            current = onwards[0];
          }
        }
        if (!cyclic && ends.length === 2 && doubleBonds % 2 === 0
          && ends.every(end => substituents(end) >= 2)) {
          throw new Error('Cumulated double bonds are outside the validated stereochemical scope.');
        }
      }
    }
    const rings = ocl.getRingSet();
    let unspecifiedBonds = 0;
    for (let b = 0; b < ocl.getAllBonds(); b++) {
      if (ocl.getBondParity(b) === Molecule.cBondParityUnknown && stereogenicRingBond(ocl, b, rings)) {
        // The inspector reports an unspecified double bond as a caveat instead of
        // refusing; drawing still requires the author to say which geometry is meant.
        if (!request.inspect && !request.racemic && !request.openStereo && request.depiction !== 'lone-pairs') throw new Error('Bond stereochemistry is unspecified; provide the required E/Z isomer.');
        unspecifiedBonds++;
      }
      if (ocl.isBINAPChiralityBond(b)) throw new Error('Axial stereochemistry is outside the validated scope.');
    }
    // Two independent layout engines. A drawing is only usable if its coordinates
    // round-trip back to the same graph, so when OpenChemLib's coordinate inventor
    // rewrites geometry — it flips long conjugated polyenes inside macrolactones —
    // RDKit's own layout is tried before giving up. A wrong picture is never drawn.
    const oclMolfile = ocl.toMolfile();
    const rdkitMolfile = reference.get_new_coords(true);
    const faithful = (source: string): JSMol | undefined => {
      try { const candidate = parse(source); return candidate.get_smiles() === canonicalSmiles ? candidate : undefined; }
      catch { return undefined; }
    };
    const oclScene = faithful(oclMolfile), rdkitScene = faithful(rdkitMolfile);
    let molfile: string, scene: JSMol;
    if (oclScene && rdkitScene) {
      const preferRdkit = layoutPenalty(rdkitMolfile) < layoutPenalty(oclMolfile);
      molfile = preferRdkit ? rdkitMolfile : oclMolfile;
      scene = preferRdkit ? rdkitScene : oclScene;
    } else if (oclScene) { molfile = oclMolfile; scene = oclScene; }
    else if (rdkitScene) {
      molfile = rdkitMolfile; scene = rdkitScene;
      partialReasons.add('layout-roundtrip-changed-geometry');
    } else throw new Error('No available layout reproduced the reference graph and stereochemistry.');
    let drawing = sceneFromMolfile(molfile);
    const newman = request.depiction === 'newman' ? deriveNewman(canonicalSmiles, kit, request.conformation) : undefined;
    if (request.depiction === 'fischer' || request.depiction === 'haworth') {
      drawing = deriveProjection(canonicalSmiles, request.depiction, kit);
      molfile = sceneMolfile(drawing);
      scene = parse(molfile);
    }
    const stereo = JSON.parse(scene.get_stereo_tags()) as { CIP_atoms: Array<[number, string]>; CIP_bonds: Array<[number, number, string]> };
    const json = JSON.parse(scene.get_json());
    if (json.molecules.length !== 1) throw new Error('Only one molecular graph per species is supported.');
    const raw = json.molecules[0];
    const elementOf = (index: number): number => ({ ...json.defaults.atom, ...raw.atoms[index] }).z;
    // An unassigned centre on carbon is a real question for the user. On a metal it is
    // not: RDKit's CIP labeller reports a four-coordinate iron or cobalt as an
    // unspecified stereocentre, which is what made haem b and cyanocobalamin look
    // ambiguous when nothing about them was. Trust the labeller only where it is sound.
    let unspecifiedAtoms = 0;
    for (const [index, tag] of stereo.CIP_atoms) {
      if (tag !== '(?)') continue;
      if (!request.inspect && !request.racemic && !request.openStereo && ORGANIC_CIP_ELEMENTS.has(elementOf(index))) throw new Error('A stereocentre is unspecified; provide the required stereoisomer.');
      // openStereo draws the centre as unspecified with no caveat: the caller checked the step.
      if (!request.openStereo) partialReasons.add('stereochemistry-not-assignable');
      if (ORGANIC_CIP_ELEMENTS.has(elementOf(index))) unspecifiedAtoms++;
    }
    const atoms = raw.atoms.map((a: Record<string, number>, i: number) => {
      const value = { ...json.defaults.atom, ...a };
      // Every element draws. Outside the organic set the CIP labeller and the implicit
      // valence model are not dependable, so the drawing keeps its graph and its balance
      // check but stops claiming stereochemical verification. Refusing an element the
      // toolkits parse perfectly well was this validator's own limit, not chemistry's.
      // A bare counterion ([Na+], [K+]) is the exception: it has no stereochemistry and no
      // implicit valence to certify, so only an out-of-set element actually bonded into the
      // structure downgrades the document.
      const bonded = raw.bonds.some((b: { atoms: [number, number] }) => b.atoms[0] === i || b.atoms[1] === i);
      if (!ORGANIC_CIP_ELEMENTS.has(value.z) && bonded) partialReasons.add('element-outside-cip-scope');
      return { id: `a${i}`, atomicNumber: value.z, charge: value.chg, isotope: value.isotope, hydrogens: value.impHs,
        ...(stereo.CIP_atoms.find(([index]) => index === i) ? { cip: stereo.CIP_atoms.find(([index]) => index === i)![1].replace(/[()]/g, '') } : {}) };
    });
    const bonds = raw.bonds.map((b: { atoms: [number, number]; bo?: number }, i: number) => {
      const tag = stereo.CIP_bonds.find(([a, c]) => a === b.atoms[0] && c === b.atoms[1] || a === b.atoms[1] && c === b.atoms[0]);
      return { id: `b${i}`, atoms: b.atoms.map(a => `a${a}`) as [string, string], order: b.bo ?? json.defaults.bond.bo,
        ...(tag ? { cip: tag[2].replace(/[()]/g, '') } : {}) };
    });
    const graph: ChemistryGraph = { canonicalSmiles, molfile, atoms, bonds };
    // What the read-only path needs to check a route without drawing any of it: the
    // verified identity, its constitution, its composition and whether stereochemistry
    // was left open.
    const inspection: ChemistryInspectionSummary | undefined = request.inspect ? (() => {
      const { composition, charge, heavyAtoms } = compositionOf(atoms);
      let skeletonSmiles = canonicalSmiles;
      try { skeletonSmiles = parse(canonicalSmiles.replace(/@/g, '').replace(/[\\/]/g, '')).get_smiles(); } catch { /* keep the canonical form */ }
      const specifiedAtoms = stereo.CIP_atoms.filter(([, tag]) => tag !== '(?)').length;
      return {
        canonicalSmiles, skeletonSmiles, formula: formulaOf(composition), charge, heavyAtoms,
        stereocentres: specifiedAtoms + stereo.CIP_bonds.length,
        unspecifiedStereocentres: unspecifiedAtoms + unspecifiedBonds,
        composition,
      };
    })() : undefined;
    // Render the exact round-tripped scene, not the original text or another layout.
    const size = atoms.length > 40 ? { width: 1000, height: 650 } : { width: 640, height: 420 };
    // The package's one element palette (heteroatoms coloured, carbon and metals black), set
    // for exactly the elements present so RDKit's fuller CPK defaults never leak in.
    const atomColourPalette = rdkitAtomPalette(atoms.map((a: { atomicNumber: number }) => a.atomicNumber));
    // CIP remains in the graph metadata; drawing it on every crowded centre can
    // obscure the bonds which actually carry stereochemistry. The two explicit-hydrogen
    // depictions below are opt-ins: they expand the drawing only, and the graph recorded
    // above stays the heavy-atom reference everything else is checked against.
    const explicitHydrogenScene = (): string => {
      // Expanded from the conformer-free canonical graph: add_hs() leaves the new atoms at
      // the origin when the molecule it is given already carries a conformer.
      const withH = parse(canonicalSmiles).add_hs();
      if (request.depiction === 'lone-pairs') {
        // Every hydrogen drawn, and the nonbonding pairs counted from valence electrons,
        // formal charge and bond order. The model never supplies them.
        const lone = sceneFromMolfile(withH);
        assignLonePairs(lone);
        return renderScene(lone);
      }
      // A stereocentre wedges itself under RDKit's own stereo annotation. A molecule with
      // one tetrahedral centre and no stereocentre — chloroform, dichloromethane — does
      // not, so the scene picks one solid wedge and one hashed bond to show its shape.
      if (stereo.CIP_atoms.length === 0) {
        const perspective = sceneFromMolfile(withH);
        if (forceTetrahedralPerspective(perspective)) return renderScene(perspective);
      }
      return parse(withH).get_svg_with_highlights(JSON.stringify({ ...size, atomColourPalette, prepareMolsBeforeDrawing: false, addStereoAnnotation: true }));
    };
    const svg = newman ? renderNewman(newman)
      : drawing.convention ? renderScene(drawing)
        : request.depiction === 'wedge-dash' || request.depiction === 'lone-pairs' ? explicitHydrogenScene()
          : scene.get_svg_with_highlights(JSON.stringify({ ...size, atomColourPalette, prepareMolsBeforeDrawing: false, addStereoAnnotation: false }));
    if (!svg.includes('<svg') || /NaN|Infinity/.test(svg)) throw new Error('Invalid SVG geometry.');
    const result: ChemistryValidationResult = { graph, svg, engineVersion: kit.version(), ...(inspection ? { inspection } : {}), ...(partialReasons.size ? { partialReasons: [...partialReasons] } : {}), ...(reconciledStereochemistry ? { reconciledStereochemistry } : {}) };
    if (request.reaction) {
      if (request.mechanism) throw new Error('A balanced scheme cannot also claim mechanism verification.');
      const { renderBalancedReaction } = await import('./chemistryReaction');
      result.reaction = await renderBalancedReaction(request.reaction, validateChemicalReferences, request.notes, request.conditions, request.racemic, request.openStereo);
    }
    if (newman) result.projection = newmanEvidence(newman);
    if (request.exportChemfig) {
      try {
        const source = newman ? exportNewman(newman) : exportSceneChemfig(drawing);
        if (newman) verifyNewman(source, newman, canonicalSmiles, kit);
        else verifySceneChemfig(source, drawing, canonicalSmiles, kit);
        const { compileChemfig } = await import('./chemistry');
        await compileChemfig(source);
        result.chemfig = { status: 'validated', source, checks: ['Parsed emitted topology, labels, bond orders and coordinates', 'RDKit stereochemical round-trip under the stated projection convention', 'Actual ChemFig compilation in a killable worker'] };
      } catch (error) { result.chemfig = { status: 'unsupported', reason: error instanceof Error ? error.message : 'ChemFig export failed validation.' }; }
    }
    if (request.mechanism) {
      const { rule, inputs, approach, electronFlow, order, resonance } = request.mechanism;
      if (rule === 'electron-flow') {
        const { deriveElectronFlowMechanism } = await import('./chemistryArrowLedger');
        result.mechanism = await renderCheckedMechanism(deriveElectronFlowMechanism(inputs, order ?? [], electronFlow ?? [], !!resonance, kit), kit);
        // The electron movement is proved by applying it; where each arrow is drawn is
        // still a heuristic, and the document says so rather than implying otherwise.
        partialReasons.add('arrow-geometry-heuristic');
        result.partialReasons = [...partialReasons];
      } else {
        result.mechanism = rule === 'sn2' || rule === 'amide-resonance'
          ? await renderCheckedMechanism(deriveMechanism(rule, inputs, kit), kit)
          : await renderExtendedMechanism(rule, inputs, kit, approach);
      }
    }
    return result;
  } finally {
    for (const molecule of owned) molecule.delete();
  }
}
