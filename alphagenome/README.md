# AlphaGenome

Packaged from [Nodus PR #700](https://github.com/Drakonis96/nodus/pull/700), revision `02743cbb2c3afe1d5a9368db729948992d3eda4d`. The SKILL.md instructions are copied verbatim from that revision’s shared/genomics.ts export (including the resolved country catalogue for Legalize).

## Compatibility

Requires a Nodus build containing both the marketplace and the PR #700 native integration, with marketplace capability `genomics` wired to that integration. PR #700 was still open when this package was added. Publishing this package does not install the native runtime or merge the PR. Builds without that capability must refuse installation; never substitute fabricated results or generic JavaScript execution.

The package contains Nodus instructions, not the AlphaGenome SDK, model or API credentials. The native integration manages the personal API key and service terms. The package licence does not replace the separate AlphaGenome service and output terms.

Attribution: Google DeepMind AlphaGenome; Avsec et al. See the pinned [integration and licensing notes](https://github.com/Drakonis96/nodus/blob/02743cbb2c3afe1d5a9368db729948992d3eda4d/legal/ALPHAGENOME.md).
