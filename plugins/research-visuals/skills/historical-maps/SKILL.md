# Historical Maps

## 1. Purpose and non-goals
Visualize historical regions, borders, places and routes for research, teaching or route planning. A historical map is dated by definition: state the period it describes, and say which parts of it rest on a source. Reconstructed geometry is allowed and the runtime labels it as such; what is not allowed is presenting a reconstruction as documented evidence, substituting current administrative geometry for a dated boundary, or inferring sensitive personal movement.

## 2. Inputs and permitted data
Require the requested `period: {from, to}` in ISO dates, with expanded signed years for BCE dates (for example `-000500-01-01`). Accept any of:

- Dated GeoJSON FeatureCollections, as `layers[].data: {geojson, source}`, when the researcher or the corpus supplies them.
- Coordinates you supply for the places and itineraries the request names: `markers`, `routes`, labels and a legend. A place or route map needs no polygon layer.
- Documented coordinates or routes taken from a supplied source.

Every source carries `label`, `attribution` and `license`. Name the origin honestly — "reconstruction from general knowledge", "coordinates of current city centres", or the actual dataset and its licence — and never cite a work that was not supplied or consulted. Only public or researcher-authorized non-personal data: no real student data, confidential sites or individual tracking.

## 3. Capabilities and prerequisites
Requires signed Research Visuals and `research-visuals:cartography`, backed by native `nodus:maps` 1.x. Dated retrieval needs a build that offers the `openhistoricalmap` provider; where the query is refused for that reason, say so and fall back as section 4 describes rather than substituting anything. The mandatory tool is `render-historical-map`; `render-map` belongs to General Maps and must not carry a dated request. Requires a build with native maps and vision; unmodified released Nodus 5.3.2 is incompatible. No historical geometry provider is integrated in this version: geometry comes from the researcher, the corpus, or your own documented coordinates.

Use the application-declared `historical-map-request` fenced JSON protocol to invoke `render-historical-map`. The fence body is the tool input, with no invented result envelope, and unknown properties are refused — build it from the schema the application lists for the tool.

## 4. Choosing what the map rests on
1. **Dated divisions of the period come from OpenHistoricalMap.** Query `openhistoricalmap` with the `level` the request needs — 2 for states and polities, 4 for regions and provinces where the project has mapped them — and the requested `period`, and give the request its `bounds`: the frame is also the retrieval window, because that index has no country key. The runtime keeps only the boundaries whose own start and end dates cover the period and whose centre falls inside the frame, reports the period in the result, and lists in its provenance what it left out. A neighbour clipped by the frame is not the subject: widen the bounds to include it deliberately. What this dataset has not mapped is absent rather than approximated, so check those notes before claiming completeness.
2. A source you or the researcher supply, whose period covers the request and which carries an evidence URL, also renders as a dated map.
3. With no dated source at all, build the map from what the request establishes — the named places, the administrative structure of the period, the itinerary between two points — and label the geometry as approximate. The runtime returns the map with a warning notice and marks it as an approximate reconstruction; keep that notice and describe the map the same way in your answer.
4. Current-geometry providers (`natural-earth`, `geoboundaries`) are drawn as a *reference frame*: attributed, described in the map as today's boundaries, and never counted as dated. Use them when the user is asking about the current division, or beside dated geometry for context, and say which is which.
5. Never declare a source period that does not cover the requested interval, and never use an opaque dataset handle: the first would make the label untrue and the second cannot be attributed. Both are refused. Do not generate a polygon and describe it as documented evidence.

## 5. Execution
1. Establish the intended date or interval. Split periods into separate maps when borders changed; a single static map cannot show contradictory boundary states.
2. Prepare the layers: `layers[].query` for dated boundaries (OpenHistoricalMap) or for a reference frame, `layers[].data: {geojson, source}` for geometry supplied with the request, and `markers` and `routes` for the places and itineraries that matter. A map with markers or routes carries their own source as an object, for example `overlaySource: {label: "Current city centres", attribution: "Model reconstruction, not evidence", license: "CC0"}` — never a bare string. A route is two or more positions with `kind` (`straight`, `curved` or `great-circle`), optional `arrow`, `color`, `width` and `label`; each consecutive pair is joined as a cartographic line, never as road directions.
3. Call `render-historical-map` with the top-level period, title, meaningful alt text, projection, colors, labels and legend as appropriate. `labelProperty` must name an existing feature property (OpenHistoricalMap features carry `name`), and labels are placed where the data puts them and one that cannot be placed without covering another is omitted: at a country or continental frame, label only the largest divisions and give the rest their geometry unlabelled or a marker each. A dense layer can also outgrow the SVG ceiling — select fewer features or use a coarser frame. `markers` and `routes` require an `overlaySource`: an object with `label`, `attribution` and `license`, and optionally `url` and `period`.
4. Coordinates are WGS84 `[longitude, latitude]`. Check the order before the call; a swapped pair is a place in the ocean.
5. Present only the returned map. Explain what is uncertain, approximate or contested, and distinguish documented locations from schematic connecting lines. If you answer a map request with an SVG block of your own, the runtime retires it and says why: a map that no tool drew has no sources to check.

## 6. Outputs and evidence
Show the dated map with visible source attribution, editable SVG and geometry/provenance JSON. Retain URLs, licences, requested and source periods, coordinate origins and modifications. Keep the runtime's approximate-reconstruction notice visible when it returns one, and mark synthetic demonstrations as synthetic.

## 7. Limitations and errors
OpenHistoricalMap's coverage is uneven and community-mapped: Spanish provinces mostly do not exist in it, some regions exist only as labels, and other countries and centuries are better covered than others. A boundary the project has not mapped is absent, so read the provenance notes and say what the map does not show. It is also a single public endpoint that rate-limits bursts: a busy answer is an error, not a reason to substitute another source. A source period that does not cover the requested interval and an opaque dataset handle are refused. Cancellation and call ceilings stop execution. Enabling this Skill never requires generating a map.
