# 1.0.0

Adds General Maps, Historical Maps and Open Image Finder in one signed package. Cartography delegates to native `nodus:maps`; image relevance delegates to native `nodus:vision`. Wikimedia is the default checked source, with optional Met and Art Institute of Chicago sources. Historical maps require supplied dated evidence; no historical retrieval provider is advertised.

New installation permissions: approved source APIs/thumbnail hosts (HTTPS GET), 4 KiB settings storage, media storage, native maps and at most three native vision rounds. No general model permission or credentials. Requires a Nodus build with Capability API 2.2 and native maps/vision; unmodified released 5.3.2 is incompatible.
