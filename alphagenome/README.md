# AlphaGenome

Packaged from [Nodus PR #700](https://github.com/Drakonis96/nodus/pull/700), now merged, at revision `02743cbb2c3afe1d5a9368db729948992d3eda4d`. The SKILL.md instructions are copied verbatim from that revision’s shared/genomics.ts export (including the resolved country catalogue for Legalize).

## Compatibility

Requires a Nodus build that registers the `nodus:genomics` capability. That integration is merged and registered in current builds; older builds that do not register it refuse installation. Publishing this package does not install the native runtime. Never substitute fabricated results or generic JavaScript execution for the capability.

The package contains Nodus instructions, not the AlphaGenome SDK, model or API credentials. The native integration manages the personal API key and service terms. The package licence does not replace the separate AlphaGenome service and output terms.

Attribution: Google DeepMind AlphaGenome; Avsec et al. See the pinned [integration and licensing notes](https://github.com/Drakonis96/nodus/blob/02743cbb2c3afe1d5a9368db729948992d3eda4d/legal/ALPHAGENOME.md).
