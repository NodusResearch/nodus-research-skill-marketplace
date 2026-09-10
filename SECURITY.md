# Security

Do not include passwords, API keys or private research material in a skill or report. The package runtime is intentionally isolated from the network, host files and Nodus's privileged APIs. Installation does not execute code; tools run only after a user enables a skill and sends a chat request that produces a matching tool call.

Report suspected vulnerabilities through this repository's private vulnerability reporting feature when available. If it is unavailable, open a minimal issue requesting a private reporting channel without exploit details, secrets or personal information. Do not publish an exploit payload in a catalog submission.

Capability runtimes run in an ephemeral Chromium session with no Node, filesystem, imports,
application bridge, preload, navigation, WebRTC or direct network access, and they never
execute native code. A capability reaches the network only through the HTTPS endpoints,
methods and path prefixes its manifest declares, and a configured secret is injected by Nodus
into the request header without ever being exposed to the runtime. Results are validated and
inert: they are not re-parsed as instructions, not re-executed, and never trigger a second
model turn.

Do not attempt to widen this boundary in a submission. A package that asks for permissions it
does not need, hides a network target behind a redirect, or tries to reach a private address
will be rejected. An update that expands its permissions cannot apply itself: Nodus holds it
until the user approves the new set.

Maintainers must inspect every declared tool, capability runtime and its instructions. Automated schema validation does not prove a skill is benign. Rejected or removed official listings do not cause remote uninstallation from users' devices.
