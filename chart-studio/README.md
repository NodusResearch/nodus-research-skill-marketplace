# Chart Studio

A Capability API v1 plugin containing one skill and one permissionless JavaScript
capability. It renders 14 static SVG chart types using Nodus's existing viewer. No new
native capability, network service, key, npm runtime dependency, or upstream change is needed.

Supported: line, area, vertical bar, grouped bar, horizontal bar, stacked bar, pie, donut,
histogram, scatter, bubble, box-and-whisker, heatmap, and radar. See
[SKILL.md](skills/chart-studio/SKILL.md) for exact input contracts and method definitions.
Unlisted types, arbitrary HTML, log scales, interactive dashboards and statistical
inference are outside this version.

## Install and use

Import this directory as a plugin in a compatible Nodus build, then enable **Chart Studio**
for Assistant and/or Nodi. The installed skill requests only `self:charts`; the resolved
capability is `chart-studio:charts`, with the single tool `render-chart`. All three
manifests use version `1.0.0`. Permissions are `{}`: the engine has no host operations.

Example request: “Using synthetic data only, draw grouped bars for two experimental
materials. Material A has values 4, 7, 5 and Material B has 3, 5, 8 across conditions
Cold, Ambient and Warm. Values are in arbitrary units.”

The tool input for that example is:

```json
{
  "chartType": "grouped-bar",
  "title": "Experimental materials across conditions",
  "dataKind": "synthetic",
  "source": "Fictional materials fixture; no empirical findings",
  "xLabel": "Condition",
  "yLabel": "Response (arbitrary units)",
  "labels": ["Cold", "Ambient", "Warm"],
  "series": [
    { "name": "Material A", "values": [4, 7, 5] },
    { "name": "Material B", "values": [3, 5, 8] }
  ]
}
```

Nodus provides the installed skill ID in the tool prompt; do not substitute the package
slug for that ID. The output is an executed SVG result, with an explicit synthetic label,
source, method notes and exact inputs in its XML description. It can be downloaded through
the existing SVG viewer. No model-generated image or second completion is needed.

## Scope, privacy and rights

Intended for researchers and educators preparing generic materials from synthetic or
demonstrably non-personal data. This is not a personal-record import, aggregation,
anonymization, student assessment or patient-specific workflow. It has no private-data
channel. Caller declarations and numeric validation cannot prove anonymity or prevent
personal information already submitted in an initial model message. Do not use it where
personal data must be handled: that requires a reviewed host boundary outside the model.

All runtime source is original code for this contribution; no external plotting library,
font, dataset, image or service is bundled. Package code uses the repository's
AGPL-3.0-only license. Synthetic tests contain fictional materials and numeric sequences.
Input data keeps its own rights; source notes are supplied by the caller, not retrieved or
verified. Human contributor review of rights and advertised use remains required.

## Compatibility and verification

The target is Capability API 1 and Nodus 5.3.2. Verification must identify the exact build;
the current local source is `9871723b` (5.3.2 development source, 2026-09-12), not proof of
testing the separately distributed 5.3.2 binary. No later native capability is required.
See the verification record below before recommending publication.

The marketplace specification describes four shared calls per reply, while that source's
`skill-capabilities/contracts.ts` and `external/main.ts` allow 16 permissionless calls and
four metered calls. This plugin needs one call per chart and its instructions retain the
conservative four-call budget. The discrepancy is reported here; neither generated
contracts nor the application are changed to resolve it.

Run deterministic package tests from the marketplace root:

```sh
npm run test:charts
node scripts/catalog.mjs --check
```

Tests live outside the package because v1 installs only declared files. Test fixtures and
rendered previews are not executable package content. The engine has bounds on inputs,
numbers and output size and validates every chart-specific shape. It escapes all XML text;
Nodus applies its existing sanitizer when displaying SVG. This is not an automatic
guarantee of scientific validity or suitable visual design for every input.

Verification record (2026-09-12, macOS, Nodus source `9871723b`):

- `npm run test:charts`: 61 passing tests covering all 14 types, schemas, deterministic
  output, exact input preservation, mathematical reference cases, text safety, limits,
  signed/zero/constant data, and alignment of category labels with line endpoints.
- `npm run test:plugins`: all 184 tests passed, including the 61 Chart Studio tests.
- `npm run validate`: package/catalog, templates, workflow checks, v2 package validation
  and existing TypeScript checks passed. The README catalog was regenerated with
  `node scripts/catalog.mjs`; generated contract files are unchanged.
- `node scripts/verify-chart-studio-nodus.mjs /path/to/nodus`: unmodified directory import
  into an isolated profile, exact version/digest resolution, all 14 types through both
  Assistant and Nodi (28 executions), and real Chromium sandbox execution passed. Only
  model completions were scripted; no model API or paid service was used.
- The same verifier passed four charts in a reply, the current host's 16-call sandbox
  limit, absent/disabled capability paths, invalid input, cancellation before and during
  execution, and stale-session rejection. Network, secrets and storage are not requested.
- All 14 SVGs passed Nodus's actual DOM sanitizer, retained their exact input provenance,
  and had no clipped or overlapping text in browser measurements. Long CJK labels, long
  titles and a complete 8-by-24 matrix also passed. Representative rendered PNGs were
  visually inspected. The verifier writes local evidence to `build/chart-studio-verification`;
  `npm run preview:charts` generates a separate gallery in `build/chart-studio-preview`.

The local Nodus checkout lacked its declared cartography dependencies. For this check only,
`d3-geo@3.1.1`, `topojson-client@3.1.0`, `topojson-server@3.0.1` and
`topojson-simplify@3.0.3` were installed in an ignored temporary dependency directory and
supplied through `NODUS_VERIFICATION_NODE_MODULES`. They are unrelated host dependencies;
they are not bundled with Chart Studio, and no application source or lockfile changed.
An up-to-date checkout with its own dependencies installed does not need that override.

Not verified: a separately distributed release binary, Windows/Linux execution on this
machine, manual UI interaction, or an unscripted model's chart/tool selection. CI is
configured to run the package tests on Linux, Windows and macOS; its results must be
checked on the pull request. No release or merge has been performed. Human contributor
and maintainer review remains necessary before acceptance.
