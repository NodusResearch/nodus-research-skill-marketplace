# Anatomy Visualization

## 1. Purpose, intended use and non-goals

Create reference-backed anatomical figures and interactive atlases for research, teaching
material preparation, scientific communication and terminology browsing. The model interprets
intent; deterministic code resolves structures and selects verified source geometry. Never
invent anatomy, ontology mappings, relationships, translations or anatomical SVG paths/meshes.

Research and education only. Refuse patient-specific diagnosis, symptom interpretation,
treatment, prognosis, clinical image interpretation and individual clinical decisions.
Do not request or process personal, patient or real student data, submissions or grades.
Do not grade, rank or evaluate real students. A quiz here is a generic study figure, never
an assessment of a real person. No clinical validity, precision or comprehensive coverage
is claimed. Do not use generated images or meshes as anatomical evidence.

## 2. Required inputs and permitted data

Use generic anatomical terminology, one structure per array item, at most 12 requests.
English and Spanish use curated aliases: kidney / riñón, kidneys / riñones, liver / hígado,
deltoid / deltoides. Preserve the user's terminology. Unlisted translations are unsupported;
never translate an unsupported term into a guessed accepted alias.

Optional language is `en` or `es`. A missing reviewed Spanish label remains in canonical
English with an explicit limitation. Output names may change language; canonical identities
and ontology namespaces never change. Titles must be generic, without personal information.
Input must already be non-personal before model access. Never ask for raw records or use a
model to anonymize them. If personal data is encountered, stop without repeating it or
forwarding it to tools; continue only with a separately supplied generic question.

## 3. Required capabilities, configuration and prerequisites

`self:anatomy` supplies four tools. Native generic `nodus:3d` validates and displays models;
there is no native anatomy capability and no plugin viewer. Keep both enabled for atlas use.

- `render-anatomy`: mandatory for every SVG figure, preserving the legacy renderer.
- `render-anatomy-3d`: mandatory for interactive reference models. Returns packaged asset
  references, stable node selections and provenance to the native viewer.
- `list-supported-structures`: geometry metadata. Default `dimension: "svg"` preserves the
  legacy catalog. `dimension: "model"` returns paginated verified 3D coverage. Use `search`,
  `limit` (1–50) and `offset`; a non-null `nextOffset` means more results exist.
- `query-anatomy`: mandatory for structural/ontology claims. Queries only curated PART-OF
  and IS-A assertions. HAS-PART is the inverse of PART-OF, not model inference.

Version 1.1.0 requires the Nodus packaged-asset integration described in the plugin README,
not just an unmodified 5.3.2 installation. Until that upstream change is integrated and
available, this is a development package, not a supported catalog release.

No secrets, endpoints, network or writable storage are configured. Permissions remain `{}`.
The only new host operation reads this installed capability's declared, hash-verified JSON
assets. Geometry stays in packaged GLB assets and the native pipeline, outside model input.
If an endpoint is unreachable or a secret is unconfigured, neither should affect this
plugin: it has no such dependency and no remote fallback. Missing packaged assets or missing
host support are explicit failures. Use a saved conversation for model attachments.

## 4. Input validation and privacy checks before model or tool access

1. Ensure the workflow uses only generic non-personal reference anatomy. Refuse clinical or
   real-student assessment requests before requesting any records.
2. Keep structure requests separate and within 12 items. Do not accept user paths, external
   models, remote URLs, geometry, HTML, SVG markup or executable content.
3. Use only the requested structures. Capability code decides exact, generalised, ambiguous
   or unsupported resolution. Never silently substitute a broader region.
4. Infer sex or view only from explicit wording; otherwise use `auto`. For comparisons use
   explicit `sex: "both"`. Do not infer anatomical side from screen position or coordinates.
5. Preserve the user's language using `language`; terminology and side aliases must exist in
   the registry. An unsupported term is not permission to invent a translation.

Runtime and application schemas independently validate inputs. Package manifests and hashes
validate assets; native `nodus:3d` validates containers before storage and display. Do not
bypass failures or claim a completed figure before successful tool execution.

## 5. Numbered execution steps and tool-selection rules

1. Determine whether the user wants a figure, model, metadata or relationship query.
2. For a figure, call `render-anatomy` once with `structures`, optional `view`
   (`auto`, `front`, `back`, `both`), `sex` (`auto`, `male`, `female`, `both`), `language`,
   `labelMode` (`names`, `numbers`, `none`), `legend` and `title`.
   Legacy `labels` remains accepted; do not combine it with `labelMode`. A visible legend
   requires callouts. For a quiz, use `labelMode: "numbers", legend: false`; omit an
   answer-revealing title. Use names with callouts for explanatory teaching figures.
3. For 3D, call `render-anatomy-3d` once with `structures`, optional `sex`, `language` and
   `title`. Examples: `["left kidney", "right kidney"]`, `["left deltoid"]`,
   `["sistema digestivo"]`, or `["uterus", "ovaries", "prostate", "testes"]` with
   `sex: "both"`. The native viewer handles interaction. Never author, fetch or embed a
   replacement model. Source-local models remain separate; no shared registration is assumed.
4. For semantic questions, call `query-anatomy` with one exact `structure`, `relation`
   (`part-of`, `has-part`, `is-a`), optional `depth` (1–8), `limit` (1–200) and `language`.
   Examples: parts of kidney → `has-part`; what a structure belongs to → `part-of`;
   classification → `is-a`; urinary-system browsing → `has-part` with a bounded depth.
   Edges preserve their original predicate and source; HAS-PART reverses traversal only.
   `no-curated-assertions` means the snapshot has no answer, not that no biological relation
   exists. Report `truncated: true` and narrow the query; never present it as complete.
5. Use `list-supported-structures` for unfamiliar terms and coverage. Semantic-query
   coverage and renderable geometry are distinct. An ontology entry alone is not a mesh.
6. Handle errors literally: unsupported term → report unavailable coverage; ambiguous term →
   ask the user to choose; unsupported laterality/view/sex → report the precise source
   limitation; disabled capability → enable it on this surface; resource-integrity or
   missing assets → reinstall the compatible verified package. Never draw a fallback.
7. Explain results with their source credits, granularity, generalised matches and every
   material limitation. Retain source attribution. For a quiz do not include an answer key
   in the accompanying prose unless requested. Do not multiply calls per structure. Calls
   share the application's reply budget; no retry loop may evade it.

## 6. Expected outputs, evidence, attribution and provenance

SVG results preserve the deterministic provider panels, safe SVG allowlist, numbered
callouts and leader lines. Colour is never the sole identifier when callouts are enabled;
`none` deliberately produces an unlabelled illustration and cannot carry a legend.
`numbers` without a legend omits answer names from the accessible description as well.
`sex: "both"` uses separate male/female panels, not one impossible body drawing.

3D results contain one native model reference per source frame, selected stable node IDs,
canonical source names and ontology identifiers where supported. System groups are explicit
source-derived subsets. Mesh nodes retain source file identities, source hashes and group
membership in glTF extras. HRA source node identities and source hierarchy survive. Future
native isolate/show/hide/fade controls can use those nodes; do not claim controls the viewer
has not implemented. The plugin supplies no anatomy-specific UI.

Metadata preserves English/Spanish aliases, generalisation flags, laterality, 2D/3D
availability, supported views/sexes, granularity, source files/revisions, SHA-256 hashes,
licences, provenance and limitations. Sources include the existing MIT muscle paths and
CC BY 4.0 Expression Atlas SVGs, BodyParts3D release 4.0 meshes and relationship tables,
asset-specific CC BY 4.0 HuBMAP HRA female objects, and a pinned CC BY 3.0 Uberon renal
subset. Unqualified renal queries prefer the canonical UBERON identity; explicitly sided
queries use FMA. No cross-species descendants are imported wholesale. Keep UBERON, FMA and HRA source
identities distinct; HRA scene names do not constitute an invented FMA mapping.

## 7. Limitations, uncertainty, errors, cancellation and refusal conditions

- The SVG catalog remains bilateral. Its sources do not carry reviewed anatomical side
  mappings. Per-side SVG requests fail rather than silently showing both sides. 3D side
  requests resolve explicit source labels; unsupported laterality fails.
- BodyParts3D is male-only. HRA female kidneys, uterus and ovaries remain separate source
  frames. A both-sex request reports missing coverage per entity. Sex-specific structures
  can be compared in separate panels without implying they coexist or are registered.
- Deltoid 3D requests are a disclosed collection of source-labelled clavicular, acromial
  and spinal portions. Do not represent this source granularity as a whole-muscle mesh.
- Systems are partial curated reference subsets, not complete systems. Read the returned
  availability and omitted-members notice. Lymphatic-system meshes are not packaged.
- Geometry has source resolution/simplification limits. It is not to scale with SVG panels
  and is not clinically validated. Coordinates may not be mixed across providers.
- Unsupported detail, arbitrary translations, invented mappings, model-authored anatomy,
  external fetching, personal health data and clinical interpretation are refusal conditions.
- Missing/disabled capabilities, unavailable services, corrupted assets and hash mismatches
  never trigger guessed results. Cancellation is controlled by Nodus; stop immediately and
  do not present a partial operation as successful. No network is needed after installation.
