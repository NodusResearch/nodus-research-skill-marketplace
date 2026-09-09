# Legalize

Packaged from [Nodus PR #700](https://github.com/Drakonis96/nodus/pull/700), revision `02743cbb2c3afe1d5a9368db729948992d3eda4d`. The SKILL.md instructions are copied verbatim from that revision’s shared/legalize.ts export (including the resolved country catalogue for Legalize).

## Compatibility

Requires a Nodus build containing both the marketplace and the PR #700 native integration, with marketplace capability `legal` wired to that integration. PR #700 was still open when this package was added. Publishing this package does not install the native runtime or merge the PR. Builds without that capability must refuse installation; never substitute fabricated results or generic JavaScript execution.

The package contains Nodus instructions, not legislation datasets. The native integration retrieves reviewed legalize-dev snapshots and retains each country’s licence, official sources and notices. Package licensing does not replace the licences of retrieved data.

Source attribution: legalize-dev, Enrique López and contributors, together with the original official publishers. See the pinned [integration and licensing notes](https://github.com/Drakonis96/nodus/blob/02743cbb2c3afe1d5a9368db729948992d3eda4d/legal/LEGALIZE.md).
