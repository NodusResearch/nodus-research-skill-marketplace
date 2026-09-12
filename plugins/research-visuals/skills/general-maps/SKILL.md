# General Maps

## 1. Purpose and non-goals
Create research maps across disciplines: administrative polygons, thematic regions, exact points, labels, legends and straight, curved or arrowed routes. Do not invent geography, geocode names from memory, infer private locations, or claim disputed boundaries are settled facts. Historical borders belong to Historical Maps.

## 2. Inputs and permitted data
Use a geographic scope, desired projection, optional categories/values and public or researcher-supplied WGS84 coordinates in **[longitude, latitude]** order. Accept source-backed GeoJSON FeatureCollections. Every supplied layer and coordinate overlay needs a source label, licence, attribution and, where available, evidence URL. Do not include private home addresses, student records or confidential field sites.

## 3. Capabilities and prerequisites
Requires the signed Research Visuals package and `research-visuals:cartography`, which depends on native `nodus:maps` 1.x. Use its mandatory `render-map` tool. `render-historical-map` is reserved for the Historical Maps workflow. A build containing native maps and vision is required; unmodified released Nodus 5.3.2 lacks these additions. Missing or disabled support means no map can be claimed.

Use the application-declared `research-map-request` fenced JSON protocol to invoke `render-map`. The fence body is the tool input, with no invented result envelope.

## 4. Validation before access
Check coordinate order, source rights and requested scope. Ask for missing exact coordinates instead of guessing. Use modern provider geometry only for modern geography. Values and territory selectors must correspond to actual feature properties: an unmatched selector fails. Never present a schematic illustration as measured geometry.

## 5. Execution
1. Choose supplied GeoJSON or an approved provider query: `natural-earth` for world countries, `geoboundaries` with an ISO alpha-3 country and level 0, 1 or 2 for modern administrative data. Provider availability and boundary level coverage vary by country.
2. Invoke `render-map` with title and meaningful alt text. Put the query in each layer so retrieval and rendering occur in one controlled call; alternatively provide `data: {geojson, source}`. Avoid opaque dataset references across calls.
3. Use `select: {property, values}` for exact subset selection, `colors: {property, values: [{value, color}]}` for thematic colors, and `labelProperty` for labels. Do not fabricate property names; when unknown, request an unfiltered map or use supplied documented data.
4. Add coordinate markers, route coordinate arrays (`straight`, `curved` or `great-circle`, optional `arrow`), labels and a matching legend. `overlaySource` is mandatory for markers/routes. Select equal-earth, mercator or equirectangular for the research purpose.
5. Use only the returned SVG and provenance. Include a visual only when useful; enabled tools and limits never imply a minimum number of maps.

## 6. Outputs and evidence
Return the application-rendered map, editable SVG and geometry/provenance JSON. Preserve visible source attribution, licences, data revisions, hashes, projection and any modifications. Describe user-assigned values separately from provider boundaries. The same result renderer works in Assistant, Nodi, Research chat and document figures.

## 7. Limitations and errors
No tiles, arbitrary URL fetches, built-in geocoder or historical boundary retrieval. Modern sources may differ in granularity, naming and political interpretation. Stop on cancelled work, invalid geometry, unavailable providers or exhausted ceilings; never substitute invented geometry. Up to four tool calls per reply is a ceiling shared with other tools, not a target.
