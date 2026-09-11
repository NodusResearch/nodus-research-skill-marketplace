# Security

Do not include passwords, API keys or private research material in a skill or report. The package runtime is intentionally isolated from the network, host files and Nodus's privileged APIs. Installation does not execute code; tools run only after a user enables a skill and sends a chat request that produces a matching tool call.

Report suspected vulnerabilities through this repository's private vulnerability reporting feature when available. If it is unavailable, open a minimal issue requesting a private reporting channel without exploit details, secrets or personal information. Do not publish an exploit payload in a catalog submission.

Capability API v1 runtimes run in an ephemeral Chromium session with no Node, filesystem,
imports, application bridge, preload, navigation, WebRTC or direct network access. They reach
the network only through the HTTPS endpoints, methods and path prefixes their manifests
declare, and a configured secret is injected by Nodus without being exposed to the runtime.

Capability API v2 packages may contain trusted Node or Python runtime code, vendored
dependencies, and migrations that run against a user's existing data. Nodus installs an official v2 package only after verifying an Ed25519 signature
over a release manifest that pins every archive by name, size and SHA-256 digest. The signing
key is available only to the protected release environment, never to pull-request jobs or
contributors. A valid signature proves provenance and integrity, not safety: maintainers must
review all runtime code, dependency locks, permissions and migrations before approving a
release.

A package's Python runtime is built from the locks it ships: every wheel pinned by URL,
size and SHA-256, fetched only through the host the capability's own manifest permits, and
installed with `--no-index --require-hashes`. Nothing is resolved from an index on the
user's machine, and a lock naming any other host is refused before it is published.

A package's migrations are the numbered scripts its manifest declares, run one at a time in
the package's own worker with the host it has at runtime. The application records only the
version they actually reached, so a migration that fails leaves the data at the last step
that finished and is retried from there — and a capability is not announced at all until
its data version matches what the package declares. Review migrations as carefully as
runtime code: they are the one part of a package that touches what a user already had.

Do not attempt to bypass either runtime boundary in a submission. A package that asks for
permissions it does not need, hides a network target behind a redirect, or tries to reach a
private address will be rejected. An update that expands its permissions cannot apply itself:
Nodus holds it until the user approves the new set.

Maintainers must inspect every declared tool, capability runtime and its instructions. Automated schema validation does not prove a skill is benign. Rejected or removed official listings do not cause remote uninstallation from users' devices.
