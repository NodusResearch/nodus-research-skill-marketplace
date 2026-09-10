# Official marketplace rules

These are publication and moderation rules for the official Nodus Marketplace. They apply to manifests, instructions, tool code, capability runtimes, requested permissions, documentation, linked resources and promoted use cases. They are conditions of listing, separate from the software license.

## Prohibited submissions

We do not publish skills whose purpose, instructions, code or promotion encourages, facilitates or solicits:

- Illegal activity or evasion of applicable legal requirements.
- Piracy: unauthorized acquisition, reproduction or distribution of copyrighted works, software, books, papers, datasets or media.
- Cracks, key generators, stolen credentials or subscription tokens; bypassing licensing, DRM, paywalls or access controls without authorization.
- Malware, credential theft, fraud, unauthorized access, exfiltration, destructive behavior or concealment of these actions.
- Distribution of private or confidential data without permission, impersonation, or deceptive claims of Nodus endorsement.
- Undisclosed execution, obfuscated payloads, hidden downloads, or instructions that try to escape Nodus's permission boundaries.

Lawful open-access discovery, use of properly licensed materials, authorized security research and neutral academic analysis are welcome. Merely discussing piracy, cybercrime or another unlawful subject for legitimate research is not prohibited. Review considers the actual purpose and behavior, not keywords alone. Authors must identify any authorization or licensing assumptions on which their workflow depends.

## Plugin permissions

A plugin capability may request only what it demonstrably needs. Listing requires that:

- Every HTTPS endpoint, method and path prefix is declared, justified in the pull request, and actually used. Undeclared, unused or speculative endpoints are removed before publication.
- Secrets are declared so Nodus can inject them, never requested from the user in a prompt and never returned, logged or echoed by the runtime.
- Storage is namespaced to the plugin and bounded by a stated size, and is not used to accumulate personal data.
- A capability that needs no host access declares no permissions.

Attempting to widen the sandbox — reaching a private or loopback address, hiding a destination behind a redirect, obtaining a secret's value, executing native code, or simulating a capability the runtime does not have — is prohibited and is grounds for removal.

A version that expands the permissions of a previous version must say so explicitly in its pull request. Nodus holds such an update until each user approves the new set; a submission that tries to disguise the expansion is treated as undisclosed execution.

## Submission requirements

Use the documented directory structure and English metadata/documentation. Identify the real submitting creator username, declare a license you have authority to grant, credit dependencies and sources, and disclose every capability and tool. Do not include secrets, telemetry, tracking or private examples. Describe limitations accurately. Include reproducible examples and expected results for tools.

For a plugin, every component carries the same SemVer version, and any change increments all of them. Republishing different content under an existing version is refused by the application, not merely by review. Generated artifacts (`scripts/contract.mjs`, the README category index and the README catalog block) must be committed exactly as generated and never edited by hand.

## Review and enforcement

1. Submit a pull request containing one directory per skill or plugin and the regenerated catalog.
2. Automated checks validate the package contract and README. They do not determine legality, ownership, or safety of behavior.
3. A maintainer reviews instructions, code, capability runtimes, requested permissions, licensing, advertised use and reproducible examples before approval. New versions receive the same review.
4. A submission may be rejected or a listing removed for violating these rules. Maintainers explain the relevant rule when practicable and may request corrections.
5. Report concerns using a repository issue without private data or harmful payloads; sensitive vulnerabilities follow SECURITY.md. Appeal a listing decision with evidence and a concrete correction in the original pull request or a new issue.

Removal from the official catalog does not remotely delete installations. Users control their local skills. Authors may host independent repositories with the same package format. Nodus does not review or endorse those sources; their availability does not exempt anyone from applicable laws or grant rights to protected content.
