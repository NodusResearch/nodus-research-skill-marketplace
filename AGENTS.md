# Agent and contributor guidelines

These instructions govern creating, updating, reviewing, and publishing skills in the [official Nodus Research skill marketplace](https://github.com/NodusResearch/nodus-research-skill-marketplace).

**Main application:** [Drakonis96/nodus](https://github.com/Drakonis96/nodus).

**MUST** and **MUST NOT** express mandatory requirements. **SHOULD** expresses a recommendation whose omission needs justification. These are marketplace admission and development rules, not a declaration of regulatory compliance or an amendment to any software license.

## 1. Read the repository before changing it

Read `README.md`, `SPECIFICATION.md`, `CONTRIBUTING.md`, `POLICY.md`, `SECURITY.md`, applicable agent instructions, package templates, and validation scripts. Inspect the main application when a claim depends on runtime behavior.

Follow the actual package contract. Do not invent manifest fields, capability identifiers, permissions, or installation behavior. Preserve unrelated work and generated-file boundaries. Report conflicts between documentation and implementation; do not silently weaken a safeguard to resolve them.

These rules apply to instructions, manifests, tool code, examples, dependencies, linked resources, documentation, updates, and advertised uses. Review actual functionality: a harmless description or a “research only” disclaimer cannot make prohibited behavior acceptable.

## 2. Understand skills, tools, and capabilities

- **Skill:** an installable workflow containing instructions, metadata, and declarations of required capabilities or optional sandboxed tools.
- **Tool:** a concrete operation the assistant requests through a defined interface and the application executes.
- **Native capability:** specialized or privileged functionality implemented and controlled by Nodus, potentially exposing several tools.

A skill describes a workflow; it does not itself provide every underlying integration. Declaring a capability MUST NOT be treated as granting arbitrary application privileges.

Use the least-privileged implementation. Instruction-only tasks and supported sandboxed calculations do not require new native capabilities. External-service access, credentials, protected data handling, specialized runtimes, and operations outside the sandbox belong in reviewed application-controlled implementations.

Never bypass the sandbox, load hidden executables, embed shared secrets, or substitute fabricated results for unavailable tools. Do not claim package signing, approval gates, or other protections exist unless verified in the application.

## 3. Follow the capability-first development sequence

Every contribution MUST follow this order:

1. **Define scope.** Identify the research purpose, intended users, non-goals, inputs, outputs, sources, rights, privacy risks, and limitations.
2. **Identify execution needs.** Determine whether instructions, sandboxed tools, or native capabilities are required.
3. **Inspect the main application first.** Check [Drakonis96/nodus](https://github.com/Drakonis96/nodus) for existing implementations, capability registration, tool contracts, routing, configuration, permissions, activation, supported surfaces, and tests.
4. **Reuse existing functionality.** Use a compatible existing capability rather than duplicating its integration. A recognized manifest identifier, old PR, or built-in skill is not proof of marketplace support.
5. **Implement missing support upstream.** When necessary, implement or extend the capability in the main application and submit a separate PR there first. Include runtime validation, security and privacy controls, tests, and documentation.
6. **Add the marketplace package afterward.** Submit its PR to this repository, link the application PR, and document required capability and application-version compatibility.
7. **Gate publication.** A dependent marketplace PR may remain a draft while application work proceeds. It MUST NOT enter the supported catalog or be advertised as usable until the capability is integrated, tested, and available in a documented compatible build.
8. **Verify before requesting approval.** Test the package against that build and report remaining limitations honestly.

If access or permissions prevent upstream work, document the blocker. Do not invent a PR, merge, release, implementation, or test result. Do not automatically merge PRs or publish releases without explicit authorization.

## 4. Give every skill a precise, ordered workflow

Every new or materially revised `SKILL.md` MUST organize its instructions in this order:

1. Purpose, intended use, and explicit non-goals.
2. Required inputs and permitted data.
3. Required capabilities, configuration, and prerequisites.
4. Input validation and privacy checks before model or tool access.
5. Numbered execution steps and tool-selection rules.
6. Expected outputs, evidence, attribution, and provenance.
7. Limitations, uncertainty, errors, cancellation, and refusal conditions.

Specify when a tool is mandatory, its permitted inputs, what constitutes success, and what happens when configuration or capability support is missing. Never instruct the model to invent missing evidence, permissions, results, or successful execution.

Respect the specification's schema, file layout, language requirements, and size limits. Mandatory protections MUST be enforced through the relevant runtime, not solely through prompts or optional documentation. Proposed protections must be identified as pending until implemented and tested.

## 5. Preserve academic integrity

Skills MUST support traceable evidence, accurate citations, appropriate attribution, reproducible methods, and human responsibility for research decisions.

Clearly distinguish retrieved source material, deterministic calculations, AI-generated interpretation, and researcher conclusions. Preserve relevant source versions, dataset revisions, and execution parameters. Label synthetic examples and generated material accurately.

Skills MUST NOT facilitate fabricated evidence or references, falsified results, misleading quotations, plagiarism, deceptive authorship claims, manipulated evaluations, or concealment of material methodological limitations.

Do not present transformed content as an unchanged authoritative source. Do not claim scientific validity, clinical reliability, institutional endorsement, or legal compliance merely because a skill uses an official API or passes tests. When evidence is insufficient, disclose that limitation rather than manufacture certainty.

## 6. Keep personal data outside every model

Models MUST NOT receive personal or potentially re-identifiable data through a skill, whether inference is local or remote. This includes language, vision, embedding, and other model-based processing.

Review all model-visible paths: initial messages, prompts, attachments, images, filenames, metadata, retrieved context, tool arguments and results, logs, and traces. Credentials and secrets MUST never be model-visible or included in packages or examples.

Removing names is insufficient. Pseudonymized records and publicly available personal information must not be assumed anonymous.

When an otherwise permitted research workflow necessarily handles personal data:

- Handling MUST remain within explicitly authorized, reviewed application-controlled components outside model context.
- Any anonymization or aggregation MUST occur before model access and address indirect identifiers and re-identification risk. Never use an LLM to anonymize the raw records.
- Only demonstrably non-personal outputs may reach models. Preserve required attribution through application-managed presentation where model exposure would breach this rule.
- Review storage, exports, synchronization, backups, and logging to prevent unintended disclosure.

A tool that redacts data after the initial chat message has reached a model is too late. Warnings and user consent do not override this marketplace rule. If the application cannot enforce the required boundary, block publication.

Use synthetic or demonstrably non-personal fixtures. Never request confidential research records merely to test a contribution.

## 7. Restrict medical and psychiatric skills to research

Medical and psychiatric skills may support literature research, evidence synthesis, classification and terminology reference, and non-patient-specific scientific methodology.

Do not accept skills that diagnose real patients, infer individual diagnoses from symptoms or records, recommend individualized treatment, predict individual clinical outcomes, or direct patient-specific clinical decisions. This applies whether the output is produced by an LLM, deterministic code, or both.

Clearly fictional, labeled cases may support academic explanation or model evaluation, but MUST NOT provide a disguised route for assessing real patients. Validate actual inputs, outputs, tool contracts, and promotion; a disclaimer cannot replace these boundaries.

## 8. Protect students and prohibit student assessment

Teaching skills may support lesson preparation, educator-authored materials, generic exercises, and fictional examples.

They MUST NOT access real student data or expose it to models. This includes identities, submissions, grades, attendance, accommodations, behavioral records, and student-specific communications.

They MUST NOT grade, score, rank, profile, evaluate, or make consequential recommendations about real students, including through deterministic tools. Anonymizing a student's submission does not make automated assessment acceptable under this policy.

Keep preparation of teaching materials separate from assessment of actual students. Use synthetic examples, not real student work, for demonstrations and tests.

## 9. Verify rights and reject infringing workflows

The submitting contributor MUST hold the rights or authorization required for the contribution's actual distribution and operation.

Review code, datasets, text, images, models, instruments, questionnaires, documentation, and API/service terms separately. A code license does not automatically cover accompanying data or third-party content. Public availability is not permission; remote retrieval instead of bundling does not cure missing rights.

Declare licenses accurately, preserve notices and attribution, disclose dependencies and authorization assumptions, and provide supporting references. Do not relicense third-party material under Nodus's license without authority.

Do not accept skills facilitating piracy, unauthorized acquisition or distribution, DRM or paywall circumvention without authorization, stolen credentials, license evasion, malware, unauthorized access, or exfiltration.

Legitimate academic study of unlawful conduct is distinct from facilitating it. Lawful open-access discovery and authorized research remain acceptable.

Unclear rights MUST block publication pending clarification. Agents MUST NOT invent permission or assert a human contributor's ownership or acceptance of terms. Do not modify `LICENSE` to encode marketplace admission restrictions.

## 10. Assign contributor responsibility and enable moderation

The submitting human contributor is responsible for their skill: its content, dependencies, permissions, truthful disclosures, advertised behavior, and correction of reported problems. AI assistance does not remove that responsibility.

Automated checks and maintainer review do not certify ownership, legality, safety, or scientific accuracy. This policy does not purport to transfer every legal liability to contributors or eliminate obligations independently applicable to maintainers or other parties.

Maintainers may reject, suspend, or remove a listing after review or a credible complaint concerning infringement, privacy, security, academic ethics, misleading claims, or other violations. Temporary removal pending investigation is permitted.

Follow `POLICY.md` and `SECURITY.md` for reporting, evidence, corrections, and appeals. Do not invent reporting channels or publish personal data, secrets, or harmful payloads in complaints.

Removal from the official catalog does not remotely uninstall local copies or revoke rights already granted under an applicable license.

## 11. Validate and report before publication

Before recommending acceptance, verify:

- Package validity, ordered instructions, versioning, and compatible runtime support.
- Successful required tool routing and correct behavior for missing configuration, disabled capabilities, invalid input, cancellation, and unavailable services.
- Reproducible examples, source provenance, necessary rights, and accurate limitations.
- Personal-data isolation and compliance with medical, teaching, and academic-integrity boundaries.

Use repository-defined checks; inspect scripts before running them. For catalog updates, use the generator rather than editing generated entries manually:

```sh
node scripts/catalog.mjs
node scripts/catalog.mjs --check
```

Run relevant application tests for upstream capability changes. Prefer safe fixtures; do not use real patient/student data or incur paid API charges without authorization.

Report files changed, linked PRs, compatibility, checks actually run, failures, and unverified behavior. Never mark an unrun test as passed. Automated validation complements, but never replaces, human review.

When updating these guidelines, keep human-facing publication requirements consistent with `POLICY.md` and `CONTRIBUTING.md`. Do not silently certify, rewrite, or remove existing skills: report apparent conflicts for maintainer review.
