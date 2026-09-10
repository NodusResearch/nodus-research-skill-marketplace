<p align="center"><img src="assets/nodus-marketplace.svg" width="144" height="144" alt="Nodus Marketplace" /></p>
<h1 align="center">Nodus Research - Skill marketplace</h1>
<p align="center">Research methods. Creative tools. Shared possibilities.</p>

Discover and share skills for the Nodus assistant and Nodi. Each skill is a self-contained directory with the same versioned manifest, instructions and optional tools.

In Nodus, open **Skills → Marketplace**. This repository is included by default. Select **Update catalog**, review a skill, install it, then enable it independently for Assistant or Nodi in **My skills**. You can add any number of public GitHub repository sources using the same format. Requires a Nodus build containing the marketplace integration; earlier releases support instruction-only imports.

Catalog updates do not change installed skills. Installing a replacement is explicit, replaces local edits and disables the skill until you enable it again. Repository snapshots are pinned to a commit. Removing a source keeps its installed skills.

[Create a skill](CONTRIBUTING.md) · [Package specification](SPECIFICATION.md) · [Marketplace rules](POLICY.md) · [Security](SECURITY.md)

AlphaGenome and Legalize are packaged from [Nodus PR #700](https://github.com/Drakonis96/nodus/pull/700). They require a build with their native integrations and marketplace capability routing; the PR is currently open. Builds without those capabilities cannot install them. See each package’s compatibility notes.

## Skills, tools and native capabilities

A skill is an installable package: metadata, instructions, expected behavior and a declaration of what the assistant may use. A tool is one concrete operation the assistant can invoke. A native capability is functionality implemented and controlled by Nodus itself, which exposes one or more privileged or specialized tools to compatible skills.

Most skills need nothing beyond their instructions. A skill may also ship ordinary sandboxed JavaScript tools for calculations, parsing, transformations and generators; those run inside the package, with no network, filesystem or credentials.

Advanced skills declare a native capability instead. The package never bundles or reproduces the external service. It states which capability it needs, and Nodus exposes the corresponding tools at runtime when the running build supports that capability and the user has permitted it. Native capabilities cover work that arbitrary marketplace code should not perform: external-service access, credential handling, authoritative-data retrieval, specialized validated computation and other deeper application integrations.

- [AlphaGenome](alphagenome/) is the skill; Nodus's native genomics capability performs the AlphaGenome integration.
- [Legalize](legalize/) is the skill; the native legal capability performs the reviewed legislation retrieval.
- [Chemistry Studio](chemistry-studio/) is the skill; native chemistry tooling performs the specialized validated chemistry operations.

Declaring a capability does not grant it. A package requests, Nodus decides: builds without the capability refuse installation, and the privileged tools never leave the trusted runtime. The layering is deliberate. Marketplace packages describe workflows; sensitive or specialized execution stays inside Nodus.

## Catalog

<!-- catalog:start -->

### Data analysis

| App / skill | Creator | Description |
| --- | --- | --- |
| [Descriptive Statistics](descriptive-statistics/) | [@Drakonis96](https://github.com/Drakonis96) | Calculate count, mean, median, range and population standard deviation from a supplied numeric sample. |

### Law and legislation

| App / skill | Creator | Description |
| --- | --- | --- |
| [Legalize](legalize/) | [@Drakonis96](https://github.com/Drakonis96) | Find legislation in legalize-dev country repositories, preserving official sources, snapshot versions, licences and attribution. Requires the native integration from Nodus PR #700. |

### Learning

| App / skill | Creator | Description |
| --- | --- | --- |
| [Socratic Tutor](socratic-tutor/) | [@Drakonis96](https://github.com/Drakonis96) | Guided learning through focused questions, progressive hints and personalized feedback. |

### Science

| App / skill | Creator | Description |
| --- | --- | --- |
| [AlphaGenome](alphagenome/) | [@Drakonis96](https://github.com/Drakonis96) | AlphaGenome regulatory variant predictions for non-commercial research, with local plots and attributed exports. Requires a personal API key and the native integration from Nodus PR #700. |
| [Chemistry Studio](chemistry-studio/) | [@Drakonis96](https://github.com/Drakonis96) | Reference-backed molecular structures, Fischer/Haworth/Newman projections and bounded reaction mechanisms with validated ChemFig export. |

### Thinking and writing

| App / skill | Creator | Description |
| --- | --- | --- |
| [Action Planner](action-planner/) | [@Drakonis96](https://github.com/Drakonis96) | Turn a goal into priorities, concrete steps and an achievable first action. |
| [Brainstorm Studio](brainstorm-studio/) | [@Drakonis96](https://github.com/Drakonis96) | Generate distinct ideas, then select and develop the most promising ones. |
| [Compare & Choose](compare-choose/) | [@Drakonis96](https://github.com/Drakonis96) | Compare alternatives against explicit criteria and recommend a choice suited to your needs. |
| [Constructive Critic](constructive-critic/) | [@Drakonis96](https://github.com/Drakonis96) | Review a text, design or proposal and prioritize specific, practical improvements. |
| [Make It Simple](make-it-simple/) | [@Drakonis96](https://github.com/Drakonis96) | Explain complex material clearly with concrete examples and useful analogies. |
| [Perspective Switcher](perspective-switcher/) | [@Drakonis96](https://github.com/Drakonis96) | Explore different viewpoints and see which assumptions change the conclusions. |
| [Thought Partner](thought-partner/) | [@Drakonis96](https://github.com/Drakonis96) | Develop an unfinished idea, surface assumptions and find a useful way forward. |
| [Writing Partner](writing-partner/) | [@Drakonis96](https://github.com/Drakonis96) | Draft and refine clear, purposeful writing while preserving your voice and intent. |

### Visual creation

| App / skill | Creator | Description |
| --- | --- | --- |
| [Image Atelier](image-atelier/) | [@Drakonis96](https://github.com/Drakonis96) | Original illustrations, concept art and visual scenes using your image model. |
| [SVG Studio](svg-studio/) | [@Drakonis96](https://github.com/Drakonis96) | Precise diagrams, explanatory drawings, maps, timelines and visual systems. |

<!-- catalog:end -->

## Share your own workflow

Create a skill in Nodus, add its metadata and optional capabilities/tools, save it and select **Export**. Choose a parent directory; Nodus creates a new skill directory ready to copy to a repository root. You can also start from [the template](templates/example-skill/). Never put credentials or private research data in a package.

The official catalog is curated. Skills promoting illegal activity, piracy, license circumvention, malware or unauthorized access are prohibited. Automated format checks complement human review; passing validation is not approval. Independent sources are controlled by their maintainers and are not endorsed by Nodus.

## Maintainers

Run `node scripts/catalog.mjs` after changing a skill; CI checks package validity and catalog freshness with `node scripts/catalog.mjs --check`. The validator is generated from Nodus's shared package contract using `scripts/sync-skill-marketplace.mjs` in the application repository.

The repository uses [AGPL-3.0-only](LICENSE). Each manifest declares its package license. The Nodus name and logo identify the project; inclusion does not grant permission to imply endorsement of a third-party marketplace.
