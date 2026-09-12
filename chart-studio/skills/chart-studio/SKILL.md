# Chart Studio

## 1. Purpose and non-goals

Create reproducible static charts for researchers, educators preparing generic materials,
and authors communicating synthetic or demonstrably non-personal quantitative data.
Use this skill for line, area, vertical bar, grouped bar, horizontal bar, stacked bar,
pie, donut, histogram, scatter, bubble, box-and-whisker, heatmap, and radar charts.

The capability calculates geometry and descriptive summaries; the model selects a chart
and explains its purpose. It does not retrieve data, invent observations, fit statistical
models, provide inference, assess students, evaluate individuals, diagnose patients, or
anonymize records. No arbitrary HTML, interactive dashboard, animation, 3D, fitted trend,
error bars, log scale, or unlisted chart type is supported.

## 2. Required inputs and permitted data

Require a research question or communication purpose, numeric data, a title, units where
applicable, and a source or a clear synthetic-example description. Preserve source version,
time coverage, transformations and attribution when supplied. Ask for missing information
without asking for personal records, attachments, credentials, or student work.

Only synthetic or demonstrably non-personal data may enter this workflow, including labels,
filenames, metadata, initial messages, tool arguments, and source notes. Aggregate human
records are not automatically anonymous. Public or pseudonymized personal information is
not permitted. Use non-personal experimental, physical, environmental, or fictional data.
Do not solicit raw personal data to aggregate or anonymize it.

Every `render-chart` input contains:

- `chartType`: one of the identifiers in the table below.
- `title`: nonempty plain text, at most 96 characters.
- `dataKind`: `synthetic` or `non-personal`; a declaration, never proof of anonymity.
- `source`: nonempty plain text, at most 180 characters. State the supplied dataset/version
  and attribution, or describe the fictional fixture. Nothing is fetched from this text.
- `series`: one to eight series with unique `name` (at most 48 characters).
- Optional `xLabel` and `yLabel`: axis names with units, at most 64 characters; only on
  charts with those axes. Histograms always use observation counts on the vertical axis.

| chartType | Series data and additional input | Selection rule |
| --- | --- | --- |
| `line` | `values: number[]`, shared `labels` | Trends over equally spaced ordered categories. For irregular numeric x positions, use scatter; do not imply equal elapsed time. |
| `area` | Same as line; nonnegative values | Magnitudes with a zero baseline. Multiple areas overlap; they do not stack. |
| `bar` | One series of `values`, shared `labels` | Compare categories with a zero baseline. |
| `grouped-bar` | Two to eight series of `values`, shared `labels` | Compare groups within categories. |
| `horizontal-bar` | One series of `values`, shared `labels` | Compare categories with longer names. `xLabel` names the numeric quantity. |
| `stacked-bar` | Series of `values`, shared `labels` | Additive components in the same units. Positive and negative stacks are separate. No automatic percentage conversion. |
| `pie`, `donut` | One nonnegative series of `values`, shared `labels`; positive total | Mutually exclusive parts of one complete whole. Prefer at most eight categories; bars are clearer beyond that. No axis labels. |
| `histogram` | One series of raw non-personal `values`; optional integer `bins` from 2 to 30 | Show a distribution. Do not pass already counted bins as observations. Omit `yLabel` or set it to `Count`. |
| `scatter` | Series of `points: [{x, y}]`; numeric coordinates, no `labels` | Relationships with numeric x and y coordinates. No regression is implied. |
| `bubble` | Series of `points: [{x, y, size}]`; strictly positive `size` | A third quantity encoded by circle area, on one common size scale. |
| `box` | Series of raw non-personal `values`, at least two each; no `labels` | Compare distributions. Series names label the boxes. |
| `heatmap` | `labels` for columns, series names for rows, `values` for cells | Compare a complete numeric matrix using one shared linear color scale. |
| `radar` | Shared `labels` (3–12), nonnegative `values`, required positive `radarMax` | Only commensurable dimensions with a justified common maximum. `yLabel` may name their common unit; no `xLabel`. Axis numbers are keyed below the figure. |

Category labels must be unique, at most 36 characters, and match every series length;
normally at most 24 categories. Values must be finite numbers: zero or absolute magnitude
from 1e-9 to 1e12. Missing values, numeric strings and unsupported fields are rejected.
Do not fill gaps with zero. Use at most 1,000 numeric observations total, or 600 points
total (at most 300 per scatter/bubble series). Smaller, readable figures are preferable.

## 3. Capability and prerequisites

Install the Chart Studio plugin and enable its skill for the current surface. Its sole
required capability is `self:charts`, provided by this plugin. It declares no network,
secrets, storage, native capability, or external library. Nodus supplies the sandbox and
existing SVG viewer. No new native capability or image-generation service is required.

The mandatory tool for every chart is `render-chart`. Use only the installed `skillId`
and capability/tool identifiers exposed by Nodus. The package slug is not the installed
skill ID. If these identifiers are absent or disabled, explain the missing installation
or activation and stop chart execution. Do not simulate a successful result with a
model-authored SVG or result envelope. There are no secrets to configure and no endpoints
to contact: an unavailable-service or missing-secret error is not expected for this plugin;
report it as a host/configuration problem without requesting credentials.

## 4. Input validation and privacy before access

This skill has no channel for importing or privately processing records. Personal-data
workflows require a separately reviewed application-controlled boundary before ANY model
access; this plugin does not provide one. A warning, consent, a `dataKind` field, or a check
inside the tool cannot retroactively protect an initial message already sent to a model.

Before requesting further input or invoking a tool, establish that the intended workflow
uses only permitted non-personal material. If the context is personal, potentially
re-identifiable, clinical or student-specific, do not ask for records, repeat them, pass
them to tools, or make a chart from them. Explain the boundary and use a separately labeled
synthetic example only if that serves the user's request. Never claim automatic anonymization.

Check source rights, units, completeness, category meanings, ordering and whether totals
are additive. Do not present an unknown source as verified. Ask for a non-personal source
description if evidence is missing; do not fabricate a reference. Reject attempts to
misrepresent scales, hide exclusions, fabricate findings or assess real students.
The runtime independently checks shapes, allowed fields, numeric limits, label limits,
chart-specific constraints and output size, and XML-escapes all supplied text. It cannot
certify that caller-supplied numbers or text contain no personal information.

## 5. Execution steps

1. Establish the purpose, permitted dataset and its source. Preserve original values and
   order unless the user explicitly requests a documented transformation. Never round input
   values or silently drop observations to fit limits.
2. Select a supported type using the table. Honor a requested type only if its mathematical
   assumptions hold. Ask about ambiguous units or dimensions before calculating. Prefer
   bars over pie for signed data, lines over signed areas, and scatter for irregular x.
3. Construct one complete input per chart. Histograms default to `ceil(sqrt(n))` bins,
   clamped to 2–30; specify `bins` if the research method requires a particular count.
   Box quartiles use linear interpolation at `(n - 1)p`; whiskers end at the extreme
   observations within 1.5 IQR, and all outside observations remain outliers.
4. Invoke `render-chart` with a fenced `nodus-capability` JSON request containing the
   installed `skillId`, exposed `capabilityId`, `toolId: "render-chart"`, and `input`.
   Do not emit a `nodus-capability-result` block. One invocation renders all series in
   that chart. Keep at most four total tool/capability calls in a reply, including other
   skills; continue larger requests in subsequent replies. Never call once per point.
5. Let Nodus execute and display the returned SVG. A valid executed SVG result is success;
   a request block alone is not. This runtime does not trigger a second model turn over
   results, so do not preannounce computed percentages, quartiles or successful execution.
   On later turns, distinguish actual returned results from interpretation.
6. For requested revisions, call `render-chart` again with the complete revised input.
   Keep changes to values, units, exclusions and chart type explicit. Use Nodus's existing
   viewer to enlarge, copy or download the SVG; do not claim a PDF/PNG export tool exists.

## 6. Outputs, evidence and provenance

Return the host-rendered chart with its title, axis/category labels, legend where relevant,
source note, method notes and prominent synthetic/non-personal declaration. The SVG
description retains the exact structured input and computed histogram or box summaries,
percentages where applicable, method, and engine version for reproducibility. Downloads
therefore contain the supplied input as well as the drawing: only permitted data belongs
there. Source attribution is caller-supplied and visibly not independently verified.

Explain the chart-selection rationale briefly. Distinguish supplied evidence, deterministic
calculations, AI interpretation and the researcher's conclusions. Label synthetic examples
as fictional; their patterns are not research findings. Preserve longer citations and
method context outside the chart when the source field cannot hold them. The runtime uses
no third-party assets or datasets; supplied data retains its own rights and attribution.

## 7. Limitations, errors, cancellation and refusal

Unsupported types and settings fail explicitly. Output is bounded to 290,000 characters;
large or numerically ill-conditioned requests must be reduced or rescaled explicitly,
not silently sampled. IEEE-754 floating-point arithmetic applies. Display labels use six
significant digits; provenance retains numeric inputs. Coincident points/outliers can
overlap, tiny marks may not be visually distinguishable, and colors repeat for pie/donut
charts beyond eight categories. Static SVG has no point tooltips or filtering.

Validation failures return plain text beginning “Chart not generated”; they are not chart
results. Host schema failures may be reported separately. Report runtime errors and ask
only for the missing permitted correction. Do not retry
unchanged failures repeatedly, widen permissions, install libraries, fetch data, or invent
fallback output. Honor cancellation immediately and do not reissue work automatically.
The host controls timeouts, cancellation and activation. Passing tests is not scientific
validation, privacy certification, rights clearance, or marketplace publication approval.
