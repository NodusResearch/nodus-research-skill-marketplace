export type ChemistryRule = 'sn2' | 'amide-resonance' | 'e2' | 'aldol' | 'diels-alder' | 'electron-flow';
export type NewmanConformation = 'anti' | 'gauche' | 'eclipsed' | 'staggered';
/**
 * Which atom an arrow touches, named the way a chemist would say it rather than by a
 * coordinate the model cannot know. The element must pick out exactly one atom in its
 * species; `index` breaks a tie among equivalent atoms, counted in the order they
 * appear. This keeps the version-2 rule intact: the model states chemistry, never
 * geometry, and the application resolves it against the structure it fetched.
 */
export interface ElectronFlowSelector { element: string; index?: number }

/**
 * One curved arrow: an electron pair leaving a lone pair or a bond, and arriving at an
 * atom (forming a bond from the donor) or at a bond (raising its order).
 */
export type ElectronFlowBond = [string, string] | { between: [string, string]; order?: number; index?: number };

export interface ElectronFlowEvent {
  from: { species: string; atom?: ElectronFlowSelector; bond?: ElectronFlowBond };
  to: { species: string; atom?: ElectronFlowSelector; bond?: ElectronFlowBond };
  kind?: 'pair' | 'single';
}

/** Model-authored intent is deliberately distinct from application-authored evidence. */
export interface ChemistryIntent {
  version: 2;
  kind: 'structure' | 'comparison' | 'mechanism' | 'reaction' | 'resonance';
  depiction: 'skeletal' | 'wedge-dash' | 'lone-pairs' | 'fischer' | 'haworth' | 'newman';
  rule?: ChemistryRule;
  conformation?: NewmanConformation;
  approach?: 'endo' | 'exo';
  /**
   * Conditions, reagents and a description of where the electrons go, for a reaction the
   * bounded rule library does not cover. Shown beneath the scheme and checked by nothing:
   * it is prose the model wrote, and the document says so wherever it appears.
   */
  notes?: string;
  /**
   * Conditions for a reaction step — temperature, time, workup — written under the arrow.
   * Model-written and checked by nothing, kept separate from `notes` so a step can carry its
   * conditions without also claiming electron pushing. Sanitized and rendered as arrow text.
   */
  conditions?: string;
  /**
   * The author declared the step's outcome racemic. Its open stereocentres are a stated
   * result, not an omission, so the scheme is drawn with them unspecified instead of
   * refused. Nothing verifies the claim; it only stops the drawing being blocked for it.
   */
  racemic?: boolean;
  /**
   * Declared curved arrows. Present for a mechanism or resonance the bounded rule
   * library does not cover, which is most of them: the arrows are checked by applying
   * them and seeing whether the structure they build conserves atoms and charge.
   */
  electronFlow?: ElectronFlowEvent[];
  species: Array<{ id: string; input: { kind: 'name' | 'pubchem-cid' | 'smiles'; value: string }; role?: ReactionRole; coefficient?: number }>;
}

export type ReactionRole = 'reactant' | 'product' | 'agent';
export interface ReactionSpecies { id: string; smiles: string; role: ReactionRole; coefficient: number }
export interface ChemistryReactionArtifact {
  scope: 'balanced-scheme-not-mechanism';
  svg: string;
  /** Model-written conditions and electron pushing. Rendered as prose, checked by nothing. */
  notes?: string;
  /** Model-written step conditions, written beneath the arrow. Unchecked. */
  conditions?: string;
  chemfig: ChemistryChemfigExport;
  species: ReactionSpecies[];
  balance: { atoms: Record<string, number>; charge: number };
  limitations: string[];
}

export interface ChemistryReference {
  provider: 'opsin' | 'pubchem' | 'user';
  query: string;
  smiles: string;
  url?: string;
  retrievedAt: string;
}

export interface ChemistryGraph {
  canonicalSmiles: string;
  molfile: string;
  atoms: Array<{ id: string; atomicNumber: number; charge: number; isotope: number; hydrogens: number; cip?: string }>;
  bonds: Array<{ id: string; atoms: [string, string]; order: number; cip?: string }>;
}

/**
 * Why a drawing could not be fully certified. Scope limits are the application's
 * own boundary, never the user's mistake, so they degrade the trust level instead
 * of refusing the drawing.
 */
export type ChemistryPartialReason =
  | 'element-outside-cip-scope'
  | 'stereochemistry-not-assignable'
  | 'layout-roundtrip-changed-geometry'
  | 'structure-above-validated-size'
  | 'arrow-geometry-heuristic';

export interface ChemistryDocument {
  version: 2;
  /**
   * Created only by the resolver, never accepted in model JSON.
   * `verified` — identity cross-checked and the graph survived the molfile round-trip.
   * `partial`  — the graph is valid and balanced, but something listed in
   *              `partialReasons` fell outside what this build can certify.
   */
  status: 'verified' | 'partial';
  scope: 'reference-graph-and-molfile-roundtrip' | 'graph-valid-validation-incomplete';
  engine: { name: 'RDKit'; version: string };
  species: Array<{ id: string; input: ChemistryIntent['species'][number]['input']; references: ChemistryReference[]; graph: ChemistryGraph; svg: string; depiction?: ChemistryIntent['depiction']; chemfig?: ChemistryChemfigExport; projection?: { convention: string; axis: [string, string]; dihedralDegrees: number; molfile3D: string } }>;
  mechanism?: ChemistryMechanismArtifact;
  reaction?: ChemistryReactionArtifact;
  limitations: string[];
  /** Present when `status` is `partial`; states exactly what was not checked. */
  partialReasons?: ChemistryPartialReason[];
  reason?: string;
  /** Set when a common name was resolved to a curated form the user did not spell out. */
  assumedIdentity?: string;
}

export type ChemistryResolution = ChemistryDocument | {
  version: 2;
  status: 'needs-clarification' | 'unsupported';
  reason: string;
};

export interface ChemistryChemfigExport { status: 'validated' | 'unsupported'; source?: string; reason?: string; checks?: string[] }
export interface ChemistryMechanismArtifact {
  rule: ChemistryRule; scope: 'conditional-elementary-rule-not-product-prediction'; source: string;
  svg: string; chemfig: ChemistryChemfigExport; canonicalProducts: string[]; limitations: string[];
  atomMap: Array<{ from: [number, number]; to: [number, number] }>;
  electronFlow: Array<{ from: { molecule: number; atom?: number; bond?: number }; to: { molecule: number; atom?: number; bond?: number } }>;
  bondEdits: string[];
  /** Atom/bond indices in mappings and flows address these V2000 records. */
  molecules: Array<{ id: string; role: 'reactant' | 'product'; canonicalSmiles: string; molfile: string }>;
  title?: string;
  geometry?: { description: string; molfile3D: string; dihedralDegrees?: number };
  panels?: ChemistryMechanismArtifact[];
}
export interface ChemistryValidationRequest {
  references: string[];
  depiction?: ChemistryIntent['depiction'];
  /** Passed through to a reaction artifact, unverified. See `ChemistryIntent.notes`. */
  notes?: string;
  /** Passed through to a reaction artifact, unverified. See `ChemistryIntent.conditions`. */
  conditions?: string;
  conformation?: NewmanConformation;
  exportChemfig?: boolean;
  mechanism?: {
    rule: ChemistryRule;
    inputs: string[];
    approach?: 'endo' | 'exo';
    /** Declared arrows, with the species ids they address, in the same order as `inputs`. */
    electronFlow?: ElectronFlowEvent[];
    order?: string[];
    resonance?: boolean;
  };
  reaction?: ReactionSpecies[];
  /** Set by the read-only inspector: return the graph even when a stereocentre is
   *  unspecified, so an intermediate is reported with a caveat instead of rejected. */
  inspect?: boolean;
  /** The step is a declared racemate: draw it with its open centres unspecified rather
   *  than refusing the unspecified stereocentre. Used by the route-fix drawing path. */
  racemic?: boolean;
}
/** One entry of a batch inspection: the requested SMILES and what RDKit made of it. */
export interface ChemistryInspectionResult {
  smiles: string;
  ok: boolean;
  graph?: ChemistryGraph;
  error?: string;
}
/** What the read-only inspector and the route checker need from one parsed species,
 *  produced by the same pipeline that draws it, so a reported identity is the verified
 *  one. Atoms are counted with their implicit hydrogens; `composition` is keyed
 *  `${atomicNumber}:${isotope}`. */
export interface ChemistryInspectionSummary {
  canonicalSmiles: string;
  /** Canonical SMILES with chirality and double-bond direction removed: the constitution. */
  skeletonSmiles: string;
  formula: string;
  charge: number;
  heavyAtoms: number;
  /** Specified tetrahedral CIP centres plus specified E/Z bonds. */
  stereocentres: number;
  /** Tetrahedral centres and stereogenic double bonds the author left unspecified. */
  unspecifiedStereocentres: number;
  composition: Record<string, number>;
}
/** One step of a synthesis route, as the read-only route checker reports it. */
export interface RouteSpeciesSummary extends ChemistryInspectionSummary {
  input: string;
  /** The systematic name the author wrote beside this species, when one was supplied. */
  name?: string;
  /** True when the name resolved to this structure, false when it resolved to a different
   *  one. Absent when no name was supplied or none could be resolved. */
  nameOk?: boolean;
  /** The author labelled this product a byproduct. A display flag only. */
  byproduct?: boolean;
}
export interface RouteStepAudit {
  index: number;
  reaction: string;
  ok: boolean;
  error?: string;
  reactants: RouteSpeciesSummary[];
  agents: RouteSpeciesSummary[];
  products: RouteSpeciesSummary[];
  balanced: boolean | null;
  chargeBalanced: boolean | null;
  /** Element-by-element and charge shortfalls, empty when the equation balances. */
  differences: string[];
  unspecifiedStereocentres: number;
  /** One sentence per supplied name that denotes a different structure than the species it
   *  was written beside. Empty when every resolvable name agrees. */
  nameProblems?: string[];
  /** The request declared this step racemic: its open centres are a stated outcome, not a
   *  refusal. Nothing verifies the claim; it only stops the step being blocked for them. */
  racemic?: boolean;
}
export interface RouteLinkAudit {
  from: number;
  to: number;
  ok: boolean;
  reason: 'carried' | 'constitution-only' | 'no-overlap' | 'declared-mismatch' | 'parse-failed';
  /** Species present, by canonical isomeric SMILES, in both the previous step's products
   *  and this step's reactants: the intermediate the route actually carries. */
  carried: Array<{ canonicalSmiles: string; formula: string; heavyAtoms: number }>;
  /** Same constitution but a different stereochemistry or protonation state. */
  skeletonOnly: Array<{ product: string; reactant: string; skeletonSmiles: string }>;
  declaredCarrier?: { input: string; canonicalSmiles: string | null; inProduct: boolean; inReactant: boolean };
}
/** Whether the route forms the molecule it was asked for. */
export interface RouteTargetAudit {
  input: string;
  canonicalSmiles: string | null;
  formula: string | null;
  /** The last step whose products include the target, or null when none does. */
  formedAt: number | null;
  /** `unparsed` never blocks: the target came from the request, not from the route. */
  reason: 'formed' | 'stereo-mismatch' | 'not-formed' | 'unparsed';
}
export interface RouteAudit {
  steps: RouteStepAudit[];
  links: RouteLinkAudit[];
  continuous: boolean;
  /** One sentence per reason the route is not continuous, empty when it is. */
  blocked: string[];
  /** Steps that neither use an earlier intermediate nor feed a later step. */
  isolated?: number[];
  /** Present when the request named a target. */
  target?: RouteTargetAudit;
  /** How many supplied IUPAC names could not be resolved to any structure. Advisory: an
   *  unusual but valid name is not treated as a disagreement. */
  namesUnresolved?: number;
}
export interface ChemistryValidationResult { graph: ChemistryGraph; svg: string; engineVersion: string; chemfig?: ChemistryChemfigExport; mechanism?: ChemistryMechanismArtifact; reaction?: ChemistryReactionArtifact; projection?: ChemistryDocument['species'][number]['projection']; partialReasons?: ChemistryPartialReason[]; inspection?: ChemistryInspectionSummary;
  /** Set when references agreed on the graph but only one supplied stereochemistry. */
  reconciledStereochemistry?: boolean }
