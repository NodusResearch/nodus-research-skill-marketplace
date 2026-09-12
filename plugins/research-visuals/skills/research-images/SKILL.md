# Open Image Finder

## 1. Purpose and non-goals
Retrieve openly reusable images relevant to a research request: photographs, museum objects, ephemera, diagrams or other visual sources. Wikimedia Commons is the default. Do not generate an image, identify unknown people, infer sensitive personal attributes, inspect private files, or authenticate an object merely from a thumbnail.

## 2. Inputs and permitted data
Use a concise public search phrase and optional `maximum` of 1–5 images (default 3). This is an upper bound, never a quota. Only public tool-retrieved thumbnails and safe source metadata enter native vision. No private files, confidential queries, credentials, real student records or unrelated application data.

## 3. Capabilities, settings and prerequisites
Requires signed Research Visuals, `research-visuals:images` and native `nodus:vision` 1.x. Call the mandatory `search-images` tool. Requires a build with native maps and vision; unmodified released Nodus 5.3.2 is incompatible.
In capability settings the user checks sources independently: Wikimedia Commons (on by default), The Metropolitan Museum of Art and Art Institute of Chicago (off by default). Tool arguments cannot override those settings. If all are off, ask the user to enable a source in settings. No source API key is required. A configured vision-capable chat model enables paid relevance review; the application's maximum paid-call budget applies. Text-only/unsupported models fall back to explicitly labelled metadata ranking.

Use the application-declared `research-image-request` fenced JSON protocol to invoke `search-images`. The fence body is the tool input, with no invented result envelope.

## 4. Validation and privacy before access
Ensure the search is public and does not solicit prohibited identification or student assessment. The worker accepts only allowlisted APIs and image hosts. Wikimedia files require Public domain, CC0, CC BY or CC BY-SA with verified licence URL and attribution where required; uncertain/unsupported rights are excluded. Both museums require an explicit public-domain flag. Public availability alone is not sufficient. The owner-authorized public-image exception permits this controlled relevance review, not general model access to private data.

## 5. Execution
1. Call `search-images` once with `{ "query": "daguerreotype", "maximum": 3 }` or another phrase grounded in the user's request. The host supplies the original request; never manufacture review handles or receipts.
2. The worker searches enabled sources, prepares at most five thumbnails and asks only the selected model to assess relevance. If all are rejected, it may retrieve the next batch, with at most three search batches/review rounds and a 120-second tool deadline. There are no arbitrary recursive model calls or model switches.
3. On text-only/unsupported models, the worker labels keyword/metadata matches as uninspected and stops after that batch. It may select zero. Review or source errors do not become successful visual inspection.
4. Present only the selected, host-stored images and their visible attribution. Do not re-request the tool to defeat the per-reply/paid-call ceilings. Never claim to have inspected a returned image when the receipt says otherwise.

## 6. Outputs and evidence
Return image cards, creator/credit line, source page, licence and licence link, plus downloadable machine-readable provenance and actual review receipts. The displayed bytes are hash-checked against the source bytes prepared for review. Results remain on the device (`modelVisibility: none`); no hidden model turn reads them. Images are thumbnails, without editorial alterations; relevance review is not authentication or independent licence certification.

## 7. Limitations, errors and cancellation
Coverage and search ordering vary. Unsupported or unverified licences, missing metadata, unavailable sources, changed images and malformed receipts are excluded with honest status. Cancellation stops host operations. No arbitrary URL input, public tile backend, user credentials or private file access. Source rights can change: retain the receipt and check the source before publication. No relevant candidate is a successful bounded outcome, not a requirement to invent a replacement.
