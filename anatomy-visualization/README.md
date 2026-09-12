# Anatomy Visualization

A Nodus plugin that renders deterministic, attributed anatomy figures for research and
teaching. The model interprets the request; the `self:anatomy` capability resolves the
structures against a pinned, verified catalog for SVG figures, native interactive 3D
models and semantic queries. The model never draws anatomical paths or creates meshes.

- Skill: `Anatomy Visualization` (`skills/anatomy-visualization/`)
- Capability: `anatomy` (`capabilities/anatomy/`), declared as `self:anatomy`
- Author: Drakonis96
- Category: Health and medicine
- Version: 1.1.0
- Permissions: `{}` — no network, no secrets, no storage

This directory is repository documentation and is not installed by Nodus. SVG data remains inside `runtime.js`. Atlas metadata and binary GLB models are declared
read-only assets under `capabilities/anatomy/assets/`; Nodus installs and verifies them.

## What it does

`render-anatomy` accepts up to 12 curated English or Spanish anatomical structures plus optional view, body
sex, label/legend flags and a title, then returns one sanitized SVG with labelled panels,
a distinct colour per structure, numbered callouts in the side margins connected by leader
lines, a legend, provider attribution and explicit notices. Identification never relies on
colour alone. `list-supported-structures` returns the catalog as JSON.

The runtime embeds a gzip-compressed snapshot of the curated geometry, so it works fully
offline and deterministically: the same request always produces the same figure.

## Existing SVG anatomy (coverage matrix)

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

## Curated terminology

Canonical names and reviewed aliases are in `list-supported-structures`. Aliases that are
broader or narrower than the drawn region are marked `generalised: true` and are reported
in the figure. Examples: `deltoid`, `biceps`, `pectoralis major` (generalised to the
pectoral region), `kidneys`, `liver`, `cerebral cortex`, `cerebellum`.

Broad terms that name more than one supported structure are refused with candidates
(`abdominal muscles`, `back muscles`). Per-side SVG terms (`left kidney`) are refused. The 3D tool resolves source-labelled sides explicitly.

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

The runtime declares no network, secrets or writable storage. Its one read-only host
operation, `host.assets.read("atlas")`, can only read declared packaged JSON by ID. Native
model results name packaged assets and stable node IDs, never filesystem paths or URLs. Figures are generated from embedded data with an allowlist of
SVG tags; external references, scripts, event handlers, `foreignObject`, `style` and
`href` are never emitted, and Nodus sanitizes the SVG again before display. Inputs are
validated in the runtime as well as by the manifest schema.

## Medical boundaries

Research and education only. The skill refuses patient-specific diagnosis, treatment,
prognosis or image interpretation, and it accepts no personal health data. Figures are
schematic, not to scale and not validated for clinical use. No clinical validation is
claimed.


## 1.1.0 atlas extension and compatibility gate

**Development integration, not yet a supported release.** The changes require the generic
v1 packaged-asset/model-result extension in the companion Nodus worktree
(`codex/plugin-readonly-model-assets`, based on Nodus 5.3.2). An unmodified 5.3.2 build
cannot install these asset declarations. Publication must wait for the separate upstream
PR, integration, a documented compatible build and maintainer review.
The upstream change is [Nodus PR #765](https://github.com/Drakonis96/nodus/pull/765);
no release is claimed by this document. The minimum version field identifies the tested base;
it is not sufficient without this integration. No native `nodus:anatomy` is introduced.

The plugin keeps Capability API v1 and its Chromium sandbox. Both `self:anatomy` and the
native generic `nodus:3d` are declared. Models go through Nodus's existing validation,
attachment storage and viewer. There is no custom viewer, arbitrary filesystem access,
remote model loading, executable 3D content or geometry generated by a language model.

### Tools and examples

| Tool | Example input | Result |
| --- | --- | --- |
| `render-anatomy` | `{"structures":["hígado","riñones"],"language":"es"}` | Existing deterministic SVG with curated Spanish legend |
| `render-anatomy` | `{"structures":["uterus","prostate"],"sex":"both"}` | Separate female and male panels |
| `render-anatomy` | `{"structures":["liver","kidneys"],"labelMode":"numbers","legend":false}` | Number-only study figure; no hidden answer names |
| `render-anatomy-3d` | `{"structures":["left kidney","right kidney"]}` | Source-labelled mesh selection in the native viewer |
| `render-anatomy-3d` | `{"structures":["sistema digestivo"],"language":"es"}` | Explicitly partial curated digestive-system subset |
| `render-anatomy-3d` | `{"structures":["uterus","ovaries","prostate","testes"],"sex":"both"}` | Separate source-frame models for comparison |
| `query-anatomy` | `{"structure":"kidney","relation":"has-part","depth":2}` | Source graph only, with predicate and source file per edge |
| `list-supported-structures` | `{"dimension":"model","search":"femur"}` | Verified 3D coverage, separate from semantic-only terms |

`labelMode` accepts `names`, `numbers`, or `none`; legacy `labels` still works and default
SVG output is regression-tested against the previous version's exact hashes. Do not combine
`labels` and `labelMode`. A legend requires callouts. Number-only figures identify structures
without colour dependence. `none` is deliberately an unlabelled illustration.

Laterality is source-specific: the SVG renderer remains bilateral. The BodyParts3D graph
contains explicit left/right concepts and element-file mappings. No side is inferred from
screen coordinates. Deltoid requests select a disclosed curated collection of its labelled
clavicular, acromial and spinal portions. Anatomical detail is never silently substituted.

English and Spanish aliases are in `scripts/anatomy/terminology.mjs`; unknown translations
are refused. Structures without curated Spanish labels keep canonical English labels with
a limitation. Canonical FMA/UBERON identifiers remain unchanged. HRA source identities stay
separate and do not manufacture ontology equivalences.

### 3D geometry and semantic coverage

BodyParts3D provides male organs, bones, vessels, individual muscles and muscle portions,
cranial nerves and neuraxis geometry. The exact selected source labels are maintained in
`scripts/anatomy/atlas-selection.mjs`. The reproducible build resolves compounds through
source element tables and atomic concepts through source OBJ headers. A missing mapping or
mesh stops the build. Semantic tables contain substantially more entities than the selected
meshes; `list-supported-structures` advertises only actual geometry.

Systems use source PART-OF membership: digestive (source label **alimentary**), urinary,
respiratory, nervous, cardiovascular, skeletal, endocrine and reproductive (source label
**genital**). These are partial subsets, with omissions reported. Muscles and nerves also
have source IS-A collections. A lymphatic system is not advertised without suitable geometry.
HAS-PART reverses a PART-OF edge; it never creates a new ontology assertion. Query depth and
node bounds prevent unbounded traversal; truncation and absent assertions are explicit.

HuBMAP HRA female kidneys, uterus and ovaries retain independent source frames. Neither a
shared coordinate system nor unprovided sex counterparts are inferred. Source metadata for
the female uterus includes an inconsistent “Visible Human Male” description; the source
title and mesh identify the female uterus. This source inconsistency is preserved in the
provenance and must not be interpreted as clinical validation.

### Asset licences and provenance

[BodyParts3D's official archive licence](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html)
was updated on 2025-02-27 to **CC BY 4.0**, covering redistribution and derivatives. Its
release 4.0 OBJ comments still contain the historical CC BY-SA 2.1 Japan notice. Both the
updated licence/README evidence and the original archive bytes are pinned by SHA-256 in
`atlas-sources.lock.json`; the historical notice is disclosed rather than erased. Required
credit: “BodyParts3D, © The Database Center for Life Science licensed under CC Attribution
4.0 International”. Source geometry is subset, converted to GLB float32 triangles and
expressed in metres from the documented millimetres. One rigid root rotation converts the
source Z-up frame to glTF Y-up; the official coordinate-system diagram is pinned as evidence.
All relative positions are preserved. No anatomical vertices are authored.

HRA assets come from `hubmapconsortium/ccf-releases` at commit
`b036a91aaf7234f462b1249d4a5f4fb0e982f412`, using the v1.3 model files and their individual
reference-organ metadata. Each included object's metadata explicitly specifies CC BY 4.0,
its creators, citation and DOI. The GLB retains coordinates and source node hierarchy;
stable identities and provenance metadata are added, and invalid source normals are omitted
as detailed below. The source credits are preserved
inside each GLB and in the installed `notices.json`, not only in repository documentation.
Native model-result history is reduced to a completion marker before inference; individual
contributor credits remain in application-managed presentation and model metadata.

Native selection preserves source mesh IDs, canonical names, ontology IDs where available,
source hashes and semantic collection IDs in glTF extras. System grouping uses source
membership; multiply classified nodes also retain all collection IDs. This supports future
generic isolate/show/hide/fade controls without adding anatomy-specific viewer code.

### Rebuild and verify

```sh
node scripts/anatomy/build-atlas.mjs           # fetch absent pinned sources, verify, build GLB assets
node scripts/anatomy/build-atlas.mjs --offline # requires the verified source cache
node scripts/anatomy/build.mjs --offline      # existing SVG pipeline plus atlas resolver instructions
node scripts/test-anatomy-visualization.mjs
node scripts/catalog.mjs
npm run validate
```

`ANATOMY_SOURCE_CACHE` optionally selects the build-only atlas cache. It grants no runtime
filesystem access. The default is the OS temporary directory's `anatomy-atlas-sources`.
A corrupted cache entry fails even online. Source locks pin archive versions, exact files,
sizes and hashes; `meshes.lock.json` records every included OBJ's provenance and geometry
counts. Runtime operation is fully offline; a fresh offline rebuild needs cached sources,
just as the existing SVG build does. Package signing/release publication remains a maintainer
action, separate from Git commit signing.

The renal semantic subset additionally uses **Uberon, CC BY 3.0**, at revision
`f060b3eb54179f67926acf0949070a576a23f827`. Its exact ontology and licence bytes are pinned.
Only selected renal terms and explicitly asserted ancestors are included; the source is
multispecies, and non-human kidney descendants are not imported wholesale. Unqualified
renal queries prefer the existing canonical UBERON identity; explicitly sided queries use
the source-labelled FMA terms. Responses preserve their actual namespace and source file.

Full Khronos glTF validation found invalid source normals in one left-kidney primitive and
one uterus primitive. The build omits those invalid NORMAL attributes so standard flat
shading can use the unchanged triangles. This changes lighting metadata only: no anatomical
vertices, faces, positions or transforms are generated or moved. Each asset's provenance
records the affected mesh/primitive/accessor. All packaged GLBs must pass the pinned Khronos
validator with zero errors and warnings in addition to the native Nodus checks.
