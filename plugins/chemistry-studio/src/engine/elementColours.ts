import { MAX_CHEMFIG_SOURCE } from './chemistry';

/** One element palette for every drawing the package shows: RDKit structure pictures, ChemFig
 *  reaction and mechanism schemes, and the application's drawings of database reactions (which
 *  RDKit renders with its default palette). These are RDKit's default heteroatom colours;
 *  carbon, hydrogen and every element not listed, metals included, stay black. */
const ELEMENT_COLOURS: Record<string, { atomicNumber: number; rgb: [number, number, number] }> = {
  N: { atomicNumber: 7, rgb: [0, 0, 255] },
  O: { atomicNumber: 8, rgb: [255, 0, 0] },
  F: { atomicNumber: 9, rgb: [51, 204, 204] },
  P: { atomicNumber: 15, rgb: [255, 127, 0] },
  S: { atomicNumber: 16, rgb: [204, 204, 0] },
  Cl: { atomicNumber: 17, rgb: [0, 204, 0] },
  Br: { atomicNumber: 35, rgb: [127, 76, 25] },
  I: { atomicNumber: 53, rgb: [160, 30, 239] },
};

const byAtomicNumber = new Map(Object.values(ELEMENT_COLOURS).map((entry) => [entry.atomicNumber, entry.rgb]));
const unit = (rgb: [number, number, number]): number[] => rgb.map((value) => Number((value / 255).toFixed(3)));

/** An RDKit `atomColourPalette` for the elements a structure contains (0 is the default). */
export function rdkitAtomPalette(atomicNumbers: Iterable<number>): Record<number, number[]> {
  return Object.fromEntries([0, ...new Set(atomicNumbers)].map((z) => [z, unit(byAtomicNumber.get(z) ?? [0, 0, 0])]));
}

// An exported atom: its node name, then its label (isotope, element, attached H, charge), exactly
// the dialect `exportSceneChemfig` writes and `verifySceneChemfig` reads back.
const ATOM = /@\{([A-Za-z0-9-]+)\}((?:\^\{\d+\})?([A-Z][a-z]?)(?:H(?:_[2-9])?)?(?:\^\{\d*[+-]\})?)/g;

/** Colour each heteroatom label of a verified ChemFig source for display. The whole label is one
 *  braced group (so `OH` is coloured as one, as RDKit draws it); the node name and the bond
 *  geometry are untouched, so the drawing is the same scheme. Applied only to the copy that is
 *  compiled to SVG: the exported source stays plain ChemFig. */
export function colourChemfigAtoms(source: string): string {
  const coloured = source.replace(ATOM, (whole, name: string, label: string, element: string) => {
    const colour = ELEMENT_COLOURS[element]?.rgb;
    return colour ? `@{${name}}{\\color[rgb]{${unit(colour).join(',')}}${label}}` : whole;
  });
  // Colour is a presentation; a scheme it would push over the compiler's size cap is drawn plain
  // rather than not at all.
  return coloured.length > MAX_CHEMFIG_SOURCE ? source : coloured;
}
