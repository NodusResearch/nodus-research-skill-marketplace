# Legalize

Packaged from [Nodus PR #700](https://github.com/Drakonis96/nodus/pull/700), now merged, at revision `02743cbb2c3afe1d5a9368db729948992d3eda4d`. The SKILL.md instructions are copied verbatim from that revision’s shared/legalize.ts export (including the resolved country catalogue for Legalize).

## Compatibility

Requires a Nodus build that registers the `nodus:legal` capability. That integration is merged and registered in current builds; older builds that do not register it refuse installation. Publishing this package does not install the native runtime. Never substitute fabricated results or generic JavaScript execution for the capability.

The package contains Nodus instructions, not legislation datasets. The native integration retrieves reviewed legalize-dev snapshots and retains each country’s licence, official sources and notices. Package licensing does not replace the licences of retrieved data.

Source attribution: legalize-dev, Enrique López and contributors, together with the original official publishers. See the pinned [integration and licensing notes](https://github.com/Drakonis96/nodus/blob/02743cbb2c3afe1d5a9368db729948992d3eda4d/legal/LEGALIZE.md).
