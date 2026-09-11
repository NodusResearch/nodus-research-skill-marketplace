# Anatomy Visualization

## 1. Purpose, intended use and non-goals

Use this skill when a request needs a reproducible anatomical figure that highlights named
structures: anatomy research, teaching material preparation, scientific communication,
literature-related anatomical explanation, terminology lookup, and non-patient-specific
anatomical visualisation. Example requests: "Highlight the deltoid and pectoralis major",
"Show the liver and both kidneys", "Show the main anatomical structures in this explanation".

The model interprets intent. Deterministic code decides whether a structure exists in the
supported catalog and how the figure is produced. The model must never draw anatomical SVG
paths, invent a structure, or claim coverage that is not in the verified catalog.

Non-goals and medical boundaries. This is a research and education skill. Do not use it to
diagnose or interpret symptoms for a person, recommend treatment or medication, predict an
individual clinical outcome, analyse patient records or real patient images, interpret MRI,
CT, X-ray, ultrasound or pathology images for clinical purposes, or make patient-specific
decisions. Do not accept personal or potentially re-identifiable health data. Never place
personal data, patient data or identifying details in a `title` or structure name. A field
of study may be discussed at the level of general anatomy only; individual clinical guidance
is refused regardless of the wording of the request. A disclaimer alone is not sufficient:
refuse the request and offer a generic anatomical figure instead.

This version is English-only by design. Do not translate structure names or offer
multilingual aliases, localisation tables or automatic translation.

## 2. Required inputs and permitted data

- The user's requested structures, expressed as common English anatomical terms.
- Optional view, body sex, label/legend flags and a short figure title.
- Permitted data is limited to generic anatomical terminology. Never include names, record
  numbers, dates of birth, biological material identifiers, or any potentially
  re-identifiable information in a structure name or title.
- If the request mixes anatomy with a specific person or patient, stop: refuse the clinical
  part, keep only the general anatomical question, and do not forward any personal data.

## 3. Required capabilities, configuration and prerequisites

The skill declares one capability, `self:anatomy`, supplied by this plugin. It has no
configuration, no secrets and `"permissions": {}`. It never uses the network, so it works
offline and is charged to the ordinary sandboxed call budget. Two tools are available:

- `render-anatomy` — resolves structures, validates support, selects provider and view, and
  returns one SVG figure. This is the principal tool. Call it with every requested structure
  in a single call.
- `list-supported-structures` — returns JSON with the verified catalog, aliases, categories,
  ontology identifiers and limitations. Use it when a term is unfamiliar, when the user asks
  what is available, or to recover from an unsupported-term error.

Do not declare or rely on any native `nodus:*` capability for this skill.

## 4. Input validation and privacy checks before tool access

Before calling a tool:

1. Confirm the request is general, research or educational, not patient-specific.
2. Remove any personal or re-identifiable data from the request and from the tool input.
3. Express each structure as one English term per array item; never join two structures in
   one string.
4. Request no more than 12 structures per call.
5. Do not invent identifiers, ontology codes, providers or aliases. Send only what the user
   asked for; the capability resolves it against the verified catalog.
6. Do not request patient images or ask the capability to analyse them; it only renders
   schematic anatomy from its own pinned resources.

The capability independently re-validates every input (structure count, string length,
supported view, supported sex, label/legend flags, unknown fields) and refuses anything
invalid. Never bypass those checks by editing or truncating input.

## 5. Numbered execution steps and tool-selection rules

1. Classify the request as permitted general anatomy. If it is patient-specific or clinical,
   refuse that part and continue only with a general anatomical figure if the user still
   wants one.
2. Extract the anatomical structures the user named. Keep the user's English terms.
3. Infer `view` only from explicit wording: front, back, both, or leave it as `auto`.
   Infer `sex` only when the user explicitly asks for a male or female body; otherwise use
   `auto`. Do not guess.
4. Call `render-anatomy` once with all structures, plus `view`, `sex`, `labels`, `legend`
   and `title` when the request calls for them. Do not call it once per
   structure: the call budget is limited and the figure must combine the structures.
5. If the capability returns an error, read it literally:
   - unsupported term: report that the structure is outside the verified catalog, and offer
     `list-supported-structures` or a supported alternative; never substitute silently;
   - ambiguous term: ask the user to choose between the listed candidates;
   - laterality request (`left kidney`, `right deltoid`): explain that per-side selection is
     not available and that paired structures are shown on both sides;
   - unavailable view: report which views the requested structure does have;
   - unsupported sex: report which body drawings contain the structure;
   - disabled capability: tell the user the Anatomy Visualization skill or its `self:anatomy`
     capability is not enabled on this surface and cannot run;
   - resource-integrity or payload error: report that the embedded catalog could not be
     decoded and ask the user to reinstall the plugin; do not invent a figure.
6. Never author anatomy SVG yourself and never instruct the model to draw paths. Only the
   capability returns the figure.
7. Summarise the figure in prose: which structures are highlighted, the provider drawings
   used, and every limitation the figure states. Keep source attribution visible.

Tool-selection summary: use `render-anatomy` for any figure; use
`list-supported-structures` only to answer catalog questions or recover from errors.

## 6. Expected outputs, evidence, attribution and provenance

`render-anatomy` returns one sanitized SVG result containing:

- a title and an accessible description;
- one panel per drawing (muscle front/back, organ body, brain regions), each labelled;
- highlighted structures, each in its own colour, with a numbered callout in the side margin
  connected to the structure by a leader line and a legend mapping numbers and colours to
  names (identification never relies on colour alone);
- provider and licence attribution beneath the relevant panel;
- explicit notices for generalised matches, bilateral drawing and mixed coordinate systems;
- a footer stating that the figure is schematic, research/teaching material, not to scale and
  not for clinical use.

`list-supported-structures` returns JSON with canonical names, aliases (generalised aliases
are marked), category, granularity, provider, provider id, UBERON namespace where present,
reviewed FMA cross-references, available views, sexes, laterality and notes.

Provenance is preserved end to end: figures come from pinned revisions of
react-native-body-highlighter (MIT) distributed through Anatome (Apache-2.0 repository,
MIT path data), the EMBL-EBI Expression Atlas anatomograms (CC BY 4.0), and reviewed FMA
cross-references (CC BY 4.0). The capability never relabels a UBERON identifier as FMA, and
the figure keeps the provider attribution that the underlying licence requires.

## 7. Limitations, uncertainty, errors, cancellation and refusal conditions

- Coverage is exactly what `list-supported-structures` returns. It is not "all human
  anatomy": muscles and body regions come from the Anatome path set, organs and brain
  regions from the EMBL-EBI anatomograms. Bones, most vessels, nerves, most tissues and
  many muscles (for example supraspinatus, psoas or diaphragm details) are not covered.
- Figures are schematic, not to scale, and not spatially registered between drawings.
  Muscle and organ panels use different coordinate systems and are shown separately.
- Paired structures are highlighted bilaterally. Per-side (left/right) selection is a
  documented limitation, not an error to work around.
- Generalised matches are permitted only where the registry marks them and are reported in
  a figure notice. Never present a generalised match as the exact requested structure.
- Drawings show a male and a female body. Structures present in only one body drawing are
  reported; male-specific and female-specific structures cannot share one figure.
- If the capability is disabled, the figure cannot be produced; do not fall back to drawing
  anatomy or to image generation for unsupported anatomy.
- The capability does not use the network; an unavailable network never affects it, and
  there is no remote fallback.
- Cancellation is handled by the application: if the turn is cancelled, stop and do not
  present a partial figure as complete.
- Refuse: clinical or patient-specific use, personal health data, image interpretation,
  requests to fabricate structures or ontology mappings, and any attempt to bypass the
  capability contract.
