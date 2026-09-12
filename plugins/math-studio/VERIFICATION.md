# Verification record

Package version: 1.0.0. Tested application: Nodus 5.3.2 at commit `9871723b`. Marketplace base: commit `6dd66fb`. Test platform: macOS arm64.

## Package checks

- The Math Studio suite covers 85 cases: exact and approximate arithmetic, parser rejection, angle units, linear and quadratic equations, stable evaluation of irrational quadratic roots, all seven matrix operations, linear-system outcomes, 6 × 6 inversion, cancellation, stored-artifact validation, and Capability API contract validation.
- The repository plugin suite passed with 154 plugin tests, 10 infrastructure tests and 44 anatomy tests.
- Plugin validation, deterministic package building, catalog generation, workflow checks and TypeScript checks passed.
- The final built `any` archive was 29,037 bytes with SHA-256 `e9cccf4f2f2794b8cdb96bf91739ea4665241403031c56eb0e36d2bb9212fd96`. The catalog deliberately keeps the contract maximum until an official published asset supplies its signed size.

## Nodus integration check

`scripts/verify-math-studio-nodus.mjs` built the package, signed its release manifest with a throwaway Ed25519 key, and installed it through the real Nodus v2 package store in a temporary profile. The key existed only inside the verification process; this does not represent an official signature or publication.

The check registered the capability, materialized the disabled-by-default skill, enabled it independently for Assistant and Nodi, started the real utility-process worker, and executed 12 synthetic fixtures. The same fixtures ran through the Assistant, Nodi, Deep Research and Immersion chat pipelines: 48 pipeline executions produced stored artifacts and native views. Reopening each stored artifact recomputed its view. Invalid division and undeclared network access were rejected, and uninstall removed the provider.

The real Nodus `ViewMath` component rendered 51 formulas through strict KaTeX with zero formula errors and zero horizontal overflows at the tested width. A preview and machine-readable evidence are generated under the ignored `build/math-studio-verification/` directory.

## Remaining release checks

Official release signing and publication were not performed. A maintainer must run the protected release workflow and record the published asset size. Windows and Linux execution were not run locally; CI still needs to verify cross-platform archive and path behavior. The chat integration used deterministic request fences rather than a live language-model response, so it proves routing and execution but not model prompt adherence.
