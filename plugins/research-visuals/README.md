# Research Visuals 1.0.0

[Installable signed release](https://github.com/NodusResearch/nodus-research-skill-marketplace/releases/tag/research-visuals-v1.0.0) · [Merged contribution](https://github.com/NodusResearch/nodus-research-skill-marketplace/pull/27)

Three independently enabled Skills share two signed workers and Nodus's native render/review services:

| Skill | Tool | Result |
| --- | --- | --- |
| [General Maps](skills/general-maps/SKILL.md) | `research-visuals:cartography/render-map` | Administrative/thematic polygons, markers, labels, legends and routes; editable SVG and geometry/provenance JSON |
| [Historical Maps](skills/historical-maps/SKILL.md) | `research-visuals:cartography/render-historical-map` | Supplied, dated historical geometry or coordinates; enforced source dates and evidence links |
| [Open Image Finder](skills/research-images/SKILL.md) | `research-visuals:images/search-images` | Licensed image cards, attribution and bounded review receipts; explicit metadata fallback |

Requires Capability API 2.2 in a Nodus build containing native `nodus:maps` and `nodus:vision` 1.x. The package declares both dependencies, so an older build refuses activation. The version baseline is 5.3.2, but **the unmodified released 5.3.2 build is incompatible**. The companion Nodus integration adds shared use in Assistant, Nodi, Research chat, Deep Research and Immersion. These Skills are optional Marketplace installs, not automatic bootstrap migrations.

## Image source selection

Open the **images capability settings** and check the sources to use. Wikimedia Commons is enabled initially; The Metropolitan Museum of Art and Art Institute of Chicago are optional and initially disabled. Settings persist locally. All sources can be disabled, in which case no request occurs. The model cannot override the checked list.

`search-images` accepts `{ "query": "daguerreotype", "maximum": 3 }`. The maximum may be 1–5; it is not a minimum. Five candidate slots are divided across enabled sources. Up to three search batches use deterministic pagination, with at most three native review rounds. A relevant first batch stops the loop. Text-only/unsupported models use conservative keyword matching and explicitly say that no visual inspection occurred. Source/review failures and no relevant candidate remain distinguishable.

Review can incur model charges. The tool is declared `billing: per-call`; the application requires a paid-call maximum for document use and accounts for actual native reviews, including retries across batches. The host enforces cancellation, a 120-second deadline, five images per review, bounded decoded thumbnails, selected-model support and no general model-call permission. Results are stored with `modelVisibility: none`; there is no hidden model turn over the search results.

## Sources and rights (reviewed 2026-09-12)

| Provider | Retrieval and admission rule | Rights / documentation |
| --- | --- | --- |
| Wikimedia Commons | MediaWiki file search, `imageinfo` thumbnails and per-file `extmetadata`; Public domain, CC0, CC BY and CC BY-SA only. BY variants require creator credit and a matching unported licence URL. Unknown, noncommercial and other unsupported licences are excluded. | [API image information](https://www.mediawiki.org/wiki/API:Imageinfo), [content reuse](https://www.mediawiki.org/wiki/Wikimedia_APIs/Content_reuse), [attribution guidance](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia), [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) |
| The Met | Paginated `/public/collection/v1.1/search`, bounded object lookups, `isPublicDomain === true`, approved image host only. The deprecated unbounded v1 search is not used. | [API and migration notes](https://metmuseum.github.io/), [Open Access / CC0](https://www.metmuseum.org/hubs/open-access) |
| Art Institute of Chicago | API search with public-domain filter and per-record `is_public_domain === true`; fixed IIIF thumbnail URL. Other IIIF images are excluded. Description fields under different terms are not requested. | [API documentation and data licensing](https://api.artic.edu/docs/), [image policy](https://www.artic.edu/open-access/open-access-images), [terms](https://www.artic.edu/terms) |

The worker supplies a descriptive User-Agent. It never follows an arbitrary image URL or a redirect. It preserves source links and visible credits, links to the applicable licence and records source/thumbnail hashes. Displayed image bytes must match the bytes prepared for review. The package's AGPL licence covers its code and instructions, **not third-party retrieved images**. Public-domain/licence flags are provider assertions, not independent rights certification; check the source for publication and other applicable rights.

## Maps and historical limits

General Maps reuses the native Natural Earth and geoBoundaries adapters, their reviewed licences, pinned provenance and visible attribution. No OSM tiles or duplicate cartographic engine are bundled. Coordinates are `[longitude, latitude]`; colors are six-digit hex. Supplied overlays need attribution. Provider errors and unmatched selections fail rather than fabricating geography.

Historical Maps currently accepts **supplied dated GeoJSON or documented coordinates/routes**. There is no historical border provider. It rejects modern provider queries and opaque dataset handles, requires a source URL for each layer/overlay and verifies that source periods cover the requested period. Dates use ISO format, including expanded signed years for BCE (`-000500-01-01`). These consistency checks cannot establish historical accuracy: the researcher remains responsible for the evidence. Modern reference maps can be produced separately with General Maps and explicitly labelled modern.

## Security and verification

The signed worker requests seven narrowly scoped HTTPS GET endpoints, 4 KiB of settings state, native maps, media storage and up to three native vision rounds. It requests no secrets, file access, Python, subprocesses or general model permission. The [owner-authorized public-image exception](../../POLICY.md#narrow-exception-controlled-public-image-relevance-review) applies only to controlled relevance review; private and student data remain excluded.

Run deterministic tests with `node --test plugins/research-visuals/test/*.test.mjs`. They cover relevant selection, all rejected, text-only fallback, second-batch success, checked sources, licensing, changed image bytes, forged receipts, cancellation and historical source constraints. Nodus supplies the native geometry/projection, model-provider, sandbox and chat-surface tests. Test image/geometry fixtures are synthetic; no paid calls or personal data are required.

Build and publish using the repository's existing protected `release-plugin.yml` workflow. Local test signatures are not production signatures. Only the protected maintainer workflow signs the distributed archive.
