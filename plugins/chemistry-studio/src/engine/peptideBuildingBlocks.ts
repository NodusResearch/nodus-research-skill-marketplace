/**
 * Standard peptide building blocks (protected amino acids and the free proteinogenic set), name ->
 * isomeric SMILES, sourced from PubChem and RDKit-validated (tools/scratchpad/gen_building_blocks.py).
 * Tried before the network resolvers so a solid-phase route resolves offline and consistently.
 * NON-NATURAL residues are deliberately absent — they have no canonical name and must be given as
 * SMILES by the author (route rules). A resin-bound intermediate is handled separately (resinBound).
 */
export const PEPTIDE_BUILDING_BLOCKS: Record<string, string> = {
  "Fmoc-Ala-OH": "C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Arg(Pbf)-OH": "CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)O)NC(=O)OCC3C4=CC=CC=C4C5=CC=CC=C35)N)C",
  "Fmoc-Asn(Trt)-OH": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)NC(=O)C[C@@H](C(=O)O)NC(=O)OCC4C5=CC=CC=C5C6=CC=CC=C46",
  "Fmoc-Asp(OtBu)-OH": "CC(C)(C)OC(=O)C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Cys(Trt)-OH": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)SC[C@@H](C(=O)O)NC(=O)OCC4C5=CC=CC=C5C6=CC=CC=C46",
  "Fmoc-Gln(Trt)-OH": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)NC(=O)CC[C@@H](C(=O)O)NC(=O)OCC4C5=CC=CC=C5C6=CC=CC=C46",
  "Fmoc-Glu(OtBu)-OH": "CC(C)(C)OC(=O)CC[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Gly-OH": "C1=CC=C2C(=C1)C(C3=CC=CC=C32)COC(=O)NCC(=O)O",
  "Fmoc-His(Trt)-OH": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)N4C=C(N=C4)C[C@@H](C(=O)O)NC(=O)OCC5C6=CC=CC=C6C7=CC=CC=C57",
  "Fmoc-Ile-OH": "CC[C@H](C)[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Leu-OH": "CC(C)C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Lys(Boc)-OH": "CC(C)(C)OC(=O)NCCCC[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Met-OH": "CSCC[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Phe-OH": "C1=CC=C(C=C1)C[C@@H](C(=O)O)NC(=O)OCC2C3=CC=CC=C3C4=CC=CC=C24",
  "Fmoc-Pro-OH": "C1C[C@H](N(C1)C(=O)OCC2C3=CC=CC=C3C4=CC=CC=C24)C(=O)O",
  "Fmoc-Ser(tBu)-OH": "CC(C)(C)OC[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Thr(tBu)-OH": "C[C@H]([C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13)OC(C)(C)C",
  "Fmoc-Trp(Boc)-OH": "CC(C)(C)OC(=O)N1C=C(C2=CC=CC=C21)C[C@@H](C(=O)O)NC(=O)OCC3C4=CC=CC=C4C5=CC=CC=C35",
  "Fmoc-Tyr(tBu)-OH": "CC(C)(C)OC1=CC=C(C=C1)C[C@@H](C(=O)O)NC(=O)OCC2C3=CC=CC=C3C4=CC=CC=C24",
  "Fmoc-Val-OH": "CC(C)[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Boc-Ala-OH": "C[C@@H](C(=O)O)NC(=O)OC(C)(C)C",
  "Boc-Gly-OH": "CC(C)(C)OC(=O)NCC(=O)O",
  "Boc-Phe-OH": "CC(C)(C)OC(=O)N[C@@H](CC1=CC=CC=C1)C(=O)O",
  "Boc-Lys(Fmoc)-OH": "CC(C)(C)OC(=O)N[C@@H](CCCCNC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13)C(=O)O",
  "Boc-Lys(Boc)-OH": "CC(C)(C)OC(=O)NCCCC[C@@H](C(=O)O)NC(=O)OC(C)(C)C",
  "L-alanine": "C[C@@H](C(=O)O)N",
  "L-arginine": "C(C[C@@H](C(=O)O)N)CN=C(N)N",
  "L-asparagine": "C([C@@H](C(=O)O)N)C(=O)N",
  "L-aspartic acid": "C([C@@H](C(=O)O)N)C(=O)O",
  "L-cysteine": "C([C@@H](C(=O)O)N)S",
  "L-glutamine": "C(CC(=O)N)[C@@H](C(=O)O)N",
  "L-glutamic acid": "C(CC(=O)O)[C@@H](C(=O)O)N",
  "glycine": "C(C(=O)O)N",
  "L-histidine": "C1=C(NC=N1)C[C@@H](C(=O)O)N",
  "L-isoleucine": "CC[C@H](C)[C@@H](C(=O)O)N",
  "L-leucine": "CC(C)C[C@@H](C(=O)O)N",
  "L-lysine": "C(CCN)C[C@@H](C(=O)O)N",
  "L-methionine": "CSCC[C@@H](C(=O)O)N",
  "L-phenylalanine": "C1=CC=C(C=C1)C[C@@H](C(=O)O)N",
  "L-proline": "C1C[C@H](NC1)C(=O)O",
  "L-serine": "C([C@@H](C(=O)O)N)O",
  "L-threonine": "C[C@H]([C@@H](C(=O)O)N)O",
  "L-tryptophan": "C1=CC=C2C(=C1)C(=CN2)C[C@@H](C(=O)O)N",
  "L-tyrosine": "C1=CC(=CC=C1C[C@@H](C(=O)O)N)O",
  "L-valine": "CC(C)[C@@H](C(=O)O)N"
};

/** Match a name to a building block regardless of spacing, dash style or case. */
function normalizeBuildingBlockName(name: string): string {
  return name.trim().toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, '');
}

const NORMALIZED = new Map(Object.entries(PEPTIDE_BUILDING_BLOCKS).map(([k, v]) => [normalizeBuildingBlockName(k), v]));

/** The dictionary SMILES for a standard building-block name, or null. */
export function buildingBlockSmiles(name: string): string | null {
  return NORMALIZED.get(normalizeBuildingBlockName(name)) ?? null;
}

/** A resin-bound species (a solid-phase intermediate): it has no resolvable name and must be given
 *  as SMILES with the resin written as a single `*`. Detected so the resolver asks for a structure
 *  instead of retrying a name that can never resolve. */
export function isResinBoundName(name: string): boolean {
  return /\b(resin|peptidyl[- ]?resin|on the resin|[- ]resin\b|solid support|wang|rink|chlorotrityl|2-chlorotrityl)\b/i.test(name);
}