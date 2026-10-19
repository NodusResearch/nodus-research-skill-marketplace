/**
 * Standard peptide building blocks (protected amino acids and the free proteinogenic set), name ->
 * isomeric SMILES, sourced from PubChem and RDKit-validated (tools/scratchpad/gen_building_blocks.py).
 * Tried before the network resolvers so a solid-phase route resolves offline and consistently.
 * NON-NATURAL residues are deliberately absent — they have no canonical name and must be given as
 * SMILES by the author (route rules). A resin-bound intermediate is handled separately (resinBound).
 */
export const PEPTIDE_BUILDING_BLOCKS: Record<string, string> = {
  "Fmoc-Ala-OH": "C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  // Fmoc-Ala-OH acylating L-serine, then acetone closing the serine's side-chain OH and backbone
  // N-H into the cyclic N,O-acetal (derived here as the reverse of pseudoproline-opening, and
  // proved by reopening it onto the independently built dipeptide). The oxazolidine removes the
  // backbone N-H and kinks the chain, which is what breaks up the beta-sheet aggregation that
  // stalls a coupling mid-sequence; `pseudoproline-opening` restores the native serine, so the
  // kink is temporary and the peptide asked for is the one that comes back. C24H26N2O6.
  "Fmoc-Ala-Ser(psiMe,Mepro)-OH": "C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)N1[C@H](C(=O)O)COC1(C)C",
  "Fmoc-Arg(Pbf)-OH": "CC1=C(C(=C(C2=C1OC(C2)(C)C)C)S(=O)(=O)NC(=NCCC[C@@H](C(=O)O)NC(=O)OCC3C4=CC=CC=C4C5=CC=CC=C35)N)C",
  "Fmoc-Asn(Trt)-OH": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)NC(=O)C[C@@H](C(=O)O)NC(=O)OCC4C5=CC=CC=C5C6=CC=CC=C46",
  "Fmoc-Asp(OMpe)-OH": "CCC(C)(CC)OC(=O)C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Asp(OtBu)-OH": "CC(C)(C)OC(=O)C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  // DIPEPTIDE BLOCKS. One coupling, two residues. Derived from the blocks above with the plugin's
  // own transforms rather than transcribed, so the stereocentres are the shipped ones: the Asp
  // centre below is Fmoc-Asp(OtBu)-OH's and the Pro centre is Fmoc-Pro-OH's, both S, checked.
  // Each carries a temporary auxiliary that the route must remove before the peptide is finished.
  // Fmoc-Asp(OtBu)-OH + (Dmb)Gly-OH, water lost. Dmb caps the Gly backbone nitrogen so it cannot
  // close the succinimide that makes Asp-Gly the classic aspartimide sequence. C34H38N2O9.
  "Fmoc-Asp(OtBu)-(Dmb)Gly-OH": "COc1ccc(CN(CC(=O)O)C(=O)[C@H](CC(=O)OC(C)(C)C)NC(=O)OCC2c3ccccc3-c3ccccc32)c(OC)c1",
  "Fmoc-Cys(Trt)-OH": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)SC[C@@H](C(=O)O)NC(=O)OCC4C5=CC=CC=C5C6=CC=CC=C46",
  // Orthogonal Cys blocks for the future disulfide route. Acm is acid-stable and removed by
  // Hg(II)/I2/Tl(III); StBu is removed by thiolysis. Both are L (S) and are asserted by the D-aa
  // sweep; neither is selected by the linear generator, which still defaults to Cys(Trt).
  "Fmoc-Cys(Acm)-OH": "CC(=O)NCSC[C@@H](C(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21",
  "Fmoc-Cys(StBu)-OH": "CC(C)(C)SSC[C@@H](C(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21",
  "Fmoc-Gln(Trt)-OH": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)NC(=O)CC[C@@H](C(=O)O)NC(=O)OCC4C5=CC=CC=C5C6=CC=CC=C46",
  "Fmoc-Glu(OtBu)-OH": "CC(C)(C)OC(=O)CC[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Gly-OH": "C1=CC=C2C(=C1)C(C3=CC=CC=C32)COC(=O)NCC(=O)O",
  // Fmoc-Gly-OH acylating L-proline's ring nitrogen, water lost. The Fmoc sits on the glycine, so
  // removing it needs a carbamate N-H that Fmoc-Pro-OH does not have. C22H22N2O5.
  "Fmoc-Gly-Pro-OH": "O=C(NCC(=O)N1CCC[C@H]1C(=O)O)OCC1c2ccccc2-c2ccccc21",
  "Fmoc-His(Trt)-OH": "C1=CC=C(C=C1)C(C2=CC=CC=C2)(C3=CC=CC=C3)N4C=C(N=C4)C[C@@H](C(=O)O)NC(=O)OCC5C6=CC=CC=C6C7=CC=CC=C57",
  // The OTHER ring nitrogen, and that is the entire point of carrying both. Histidine racemises
  // because the imidazole's PI nitrogen — the one adjacent to the carbon bearing the side chain —
  // abstracts the alpha-proton of the activated residue. Substitution THERE prevents it;
  // substitution on the tau nitrogen only lowers the pi nitrogen's basicity and so reduces it.
  // Fmoc-His(Trt)-OH above is tau-substituted, which is why the his-epimerisation hazard could
  // previously only say that no pi-protected histidine ships.
  //
  // Bum is tert-butoxymethyl: TFA-labile, so it comes off with everything else at the end, which
  // is what makes it the Fmoc-compatible choice. Do not confuse it with Bom (benzyloxymethyl,
  // CAS 84891-19-0, C29H27N3O5), which is HF-labile and belongs to Boc chemistry.
  // CAS 90653-46-6, C26H29N3O5, MW 463.53 — checked against the catalogue entry, and the
  // substituted nitrogen is asserted to be the one adjacent to C-gamma in test_his_bum_block.py.
  //
  // CAUTION carried in the hazard message too: deprotection releases FORMALDEHYDE, which needs a
  // scavenger of its own or it goes on to modify the peptide.
  // NOTE the [C@H], not [C@@H]: this entry is written with the NITROGEN before the carboxyl,
  // the opposite order from Fmoc-His(Trt)-OH above, and swapping two neighbours inverts what
  // the same tag means. Written as [C@@H] it is the D residue — right formula, right mass,
  // wrong molecule. Both blocks are now asserted to carry the same CIP code (S) rather than
  // a hand-checked letter.
  "Fmoc-His(Bum)-OH": "CC(C)(C)OCn1c(C[C@H](NC(=O)OCC2c3ccccc3-c3ccccc32)C(=O)O)cnc1",
  "Fmoc-Ile-OH": "CC[C@H](C)[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Leu-OH": "CC(C)C[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  "Fmoc-Lys(Boc)-OH": "CC(C)(C)OC(=O)NCCCC[C@@H](C(=O)O)NC(=O)OCC1C2=CC=CC=C2C3=CC=CC=C13",
  // Orthogonal Lys side-chain protections, for the on-resin work the Boc group cannot do.
  // Dde and Ddiv are enamines removed by hydrazine; Ddiv is the more migration-resistant of the
  // two. Alloc is a Pd(0)-labile carbamate. None of these is selected by the linear generator,
  // which still defaults to Lys(Boc).
  "Fmoc-Lys(Dde)-OH": "CC(=C1C(=O)CC(C)(C)CC1=O)NCCCC[C@@H](C(=O)O)NC(=O)OCC2c3ccccc3-c3ccccc32",
  "Fmoc-Lys(Ddiv)-OH": "CC(C)CC(=C1C(=O)CC(C)(C)CC1=O)NCCCC[C@@H](C(=O)O)NC(=O)OCC2c3ccccc3-c3ccccc32",
  "Fmoc-Lys(Alloc)-OH": "C=CCOC(=O)NCCCC[C@@H](C(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21",
  // The same Pd(0)-labile allyl protection on the side-chain carboxyls. These are the carboxyl
  // partners for an on-resin cyclisation: one group is freed while the tBu/Boc groups survive.
  "Fmoc-Glu(OAll)-OH": "C=CCOC(=O)CC[C@@H](C(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21",
  "Fmoc-Asp(OAll)-OH": "C=CCOC(=O)C[C@@H](C(=O)O)NC(=O)OCC1c2ccccc2-c2ccccc21",
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