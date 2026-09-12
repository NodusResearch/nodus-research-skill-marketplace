# Historical Maps

## 1. Purpose and non-goals
Visualize documented historical regions, borders, places and routes for research or teaching. A historical map is a dated interpretation of evidence. Never reconstruct former borders from model memory, claim modern administrative geometry is historical, or infer sensitive personal movement.

## 2. Inputs and permitted data
Require the requested `period: {from, to}`, source-backed GeoJSON or documented coordinates/routes, source label, licence, attribution and evidence URL. Each source must declare a period covering the requested interval. Use ISO dates, with expanded signed years for BCE dates (for example `-000500-01-01`). Only public or researcher-authorized non-personal data; no real student data, confidential sites or individual tracking.

## 3. Capabilities and prerequisites
Requires signed Research Visuals and `research-visuals:cartography`, backed by native `nodus:maps` 1.x. The mandatory tool is `render-historical-map`; `render-map` belongs to General Maps and must not bypass historical checks. Requires a build with native maps and vision; unmodified released Nodus 5.3.2 is incompatible. No historical geometry provider is integrated in this version.

Use the application-declared `historical-map-request` fenced JSON protocol to invoke `render-historical-map`. The fence body is the tool input, with no invented result envelope.

## 4. Validation before access
Check the actual source, rights, temporal validity and coordinate order [longitude, latitude]. If geometry is missing, ask for an openly licensed dated dataset or supplied GeoJSON. Do not generate a polygon and label it as historical evidence. The runtime rejects provider queries, opaque dataset handles, undated sources, sources without URLs, and intervals outside the supplied source coverage.

## 5. Execution
1. Establish the intended date or interval. Split periods into separate maps when borders changed; a single static map cannot show contradictory boundary states.
2. Prepare `layers[].data: {geojson, source}` with the source's own `period`. For a historical route/point map, provide documented markers/routes and a dated `overlaySource`; polygon layers are optional.
3. Call `render-historical-map` with the top-level period, title, alt text, projection, colors, labels and legend as appropriate. All source periods must cover the requested interval. Runtime date checks verify consistency, not historical truth.
4. Present only the returned map. Explain uncertain, approximate or contested reconstructions and distinguish documented locations from schematic connecting lines.

## 6. Outputs and evidence
Show the dated map with visible source attribution, editable SVG and geometry/provenance JSON. Retain URLs, licence, requested/source periods, coordinate sources and modifications. Make source uncertainty visible in the title, legend or explanation. Synthetic demonstrations must be clearly marked synthetic.

## 7. Limitations and errors
There is no automatic historical border lookup in this version. A missing dataset is a real limitation, not permission to use current borders. Refuse absent/out-of-period evidence and report source failures. Cancellation and call ceilings stop execution. Enabling this Skill never requires generating a map.
