# Anatomy Visualization

A Nodus plugin that renders deterministic, attributed anatomy figures for research and
teaching. The model interprets the request; the `self:anatomy` capability resolves the
structures against a pinned, verified catalog and renders one SVG figure. The model never
draws anatomical paths.

- Skill: `Anatomy Visualization` (`skills/anatomy-visualization/`)
- Capability: `anatomy` (`capabilities/anatomy/`), declared as `self:anatomy`
- Author: Drakonis96
- Category: Health and medicine
- Version: 1.0.0
- Permissions: `{}` — no network, no secrets, no storage

This directory is repository documentation and is not installed by Nodus. Everything the
runtime needs is inside `runtime.js`.

## What it does

`render-anatomy` accepts up to 12 English anatomical structures plus optional view, body
sex, label/legend flags and a title, then returns one sanitized SVG with labelled panels,
a distinct colour per structure, numbered callouts in the side margins connected by leader
lines, a legend, provider attribution and explicit notices. Identification never relies on
colour alone. `list-supported-structures` returns the catalog as JSON.

The runtime embeds a gzip-compressed snapshot of the curated geometry, so it works fully
offline and deterministically: the same request always produces the same figure.

## Supported anatomy (coverage matrix)

The catalog is built from the graphical resources below, not from an ontology. An FMA
identifier is a semantic cross-reference only and does not imply a separate drawing.

| Category | Provider | Structures | Views | Granularity | Laterality | Ontology | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Muscles | Anatome / react-native-body-highlighter; diaphragm from the organ panel | biceps brachii, triceps brachii, deltoid, trapezius, rectus abdominis, tibialis anterior, diaphragm | front, back | individual muscle | bilateral only | FMA cross-references where an exact label matched | No per-side selection; no other individual muscles |
| Muscle groups | Anatome / react-native-body-highlighter | pectoral region, abdominal obliques, quadriceps femoris, hamstring muscles, gluteal muscles, calf muscles, adductor muscles, forearm muscles, upper back muscles, lower back muscles | front, back | muscle group | bilateral only | FMA cross-reference for quadriceps femoris | Region names cover several muscles; generalised aliases are marked |
| Organs | EMBL-EBI Expression Atlas anatomogram | brain, heart, lungs, liver, kidneys, stomach, pancreas, spleen, gallbladder, small intestine, colon, rectum, appendix, urinary bladder, esophagus, thyroid gland, adrenal glands, spinal cord, tongue, pituitary gland, eyes, breasts, prostate gland, testes, epididymis, uterus, ovaries, vagina, fallopian tubes, uterine cervix, placenta | front | organ | unpaired or bilateral; no per-side selection | UBERON element ids from the source; FMA cross-references where exact | Schematic front view; overlapping organs share the source drawing order |
| Tissues | EMBL-EBI Expression Atlas anatomogram | endometrium | front | mucosa | unpaired | UBERON element id | Only this tissue is drawn; no generic tissue overlays |
| Brain | EMBL-EBI Expression Atlas brain anatomogram | 20 regions (cerebral cortex, cerebellum, thalamus, diencephalon, occipital/temporal/parietal lobes, frontal and prefrontal cortex, medulla oblongata, hippocampus, hypothalamus, pineal gland, nucleus accumbens, locus ceruleus, amygdala, middle frontal gyrus, middle temporal gyrus, cingulate cortex, telencephalic ventricle) | dedicated schematic sagittal and lateral brain views | brain region | bilateral only | UBERON element ids; FMA cross-references where exact | Region shapes only; the two axial source views are not redistributed |
| Body regions | Anatome / react-native-body-highlighter; oral cavity and nose from the organ panel | head, neck region, hair, hands, knees, ankles, feet, oral cavity, nose | front, back | schematic region | bilateral only | UBERON element ids for oral cavity and nose | Regions, not individual muscles or bones |
| Vessels | EMBL-EBI Expression Atlas anatomogram | aorta | front | artery | unpaired | UBERON element id (UBERON:0000947); FMA cross-reference | Only the aorta; no other vessels |
| Bones | — | none | — | — | — | — | Not covered |
| Nerves | — | none | — | — | — | — | Not covered |

Whole brain is drawn on the organ panel; brain regions are drawn on the dedicated brain
panel. They are not mixed into one silhouette.

## Supported English terminology

Canonical names and reviewed aliases are in `list-supported-structures`. Aliases that are
broader or narrower than the drawn region are marked `generalised: true` and are reported
in the figure. Examples: `deltoid`, `biceps`, `pectoralis major` (generalised to the
pectoral region), `kidneys`, `liver`, `cerebral cortex`, `cerebellum`.

Broad terms that name more than one supported structure are refused with candidates
(`abdominal muscles`, `back muscles`). Per-side terms (`left kidney`) are refused.

## Sources, revisions and licences

All revisions are pinned and SHA-256 verified by `scripts/anatomy/sources.lock.json`.
`runtime.js` embeds the compressed derivative and reproduces the required notices.

| Source | Revision | Used for | Licence |
| --- | --- | --- | --- |
| [Anatome](https://github.com/Rippy1911/anatome) `api/data/bodyPaths.json` | `ea36eedbc0a65d4576d1ef10abd42af3c407f11e` | muscle and body-region SVG paths | Path data MIT (react-native-body-highlighter); repository Apache-2.0 |
| [react-native-body-highlighter](https://github.com/HichamELBSI/react-native-body-highlighter) | `15df9e2dbc621450001960bed5a30e6a75357faa` | original path provenance, MIT notice, framing viewBoxes | MIT, Copyright (c) 2022 ELABBASSI Hicham |
| [EMBL-EBI Expression Atlas anatomogram](https://github.com/ebi-gene-expression-group/anatomogram) `homo_sapiens.male.svg`, `homo_sapiens.female.svg`, `homo_sapiens.brain.svg` | `9fcc37022cce1e2862692a5f5fbfb78572b87e67` | organ, body outline and brain-region geometry | Graphical material CC BY 4.0 ([Expression Atlas licence](https://www.ebi.ac.uk/gxa/licence.html)); source code Apache-2.0 |
| [Foundational Model of Anatomy](https://github.com/uw-sig/FMA) version 5.1.0 | `c6f70808ba2859b88cb0b8362c34fa9017c6f96a` | semantic cross-references, retrieved through [EMBL-EBI OLS4](https://www.ebi.ac.uk/ols4) | CC BY 4.0 |

Modifications of third-party material: geometry is subset to the structures above, numeric
coordinates are rounded to two decimals with arc flags parsed individually, presentation
styles and source ids are removed, and the Expression Atlas licence icon is removed from
the body outlines (attribution is rendered as text in every figure instead). No exercise
photographs, GIFs, exercise metadata, user data or health-tracking material is used.

Original plugin code and documentation are licensed AGPL-3.0-only. Third-party material
keeps its own licence. The full MIT notice is reproduced inside `runtime.js`.

## Reproducible build

```sh
node scripts/anatomy/build.mjs             # fetch pinned inputs, verify SHA-256, regenerate runtime.js
node scripts/anatomy/build.mjs --offline   # rebuild from the local source cache only
node scripts/anatomy/build.mjs --fetch-fma # refresh FMA cross-references from OLS4
```

The build refuses bytes that do not match the recorded SHA-256, refuses unexpected SVG
elements and external references, and verifies that the generated `runtime.js` is a
function expression under the 256,000-character capability limit without backticks,
template interpolation or backslashes (Nodus embeds runtime sources in a template literal).

## Tests

```sh
node scripts/test-anatomy-visualization.mjs
node scripts/catalog.mjs --check
node scripts/validate-templates.mjs
```

## Security

The runtime declares no permissions, so the sandbox exposes no host operations at all: no
network, secrets or storage. Figures are generated from embedded data with an allowlist of
SVG tags; external references, scripts, event handlers, `foreignObject`, `style` and
`href` are never emitted, and Nodus sanitizes the SVG again before display. Inputs are
validated in the runtime as well as by the manifest schema.

## Medical boundaries

Research and education only. The skill refuses patient-specific diagnosis, treatment,
prognosis or image interpretation, and it accepts no personal health data. Figures are
schematic, not to scale and not validated for clinical use. No clinical validation is
claimed.
