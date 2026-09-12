# Math Studio

[Installable signed release](https://github.com/NodusResearch/nodus-research-skill-marketplace/releases/tag/math-studio-v1.0.0) · [Merged contribution](https://github.com/NodusResearch/nodus-research-skill-marketplace/pull/31)

Math Studio is a permissionless Capability API v2 package for bounded mathematical computation. It calculates results in a trusted worker and asks Nodus to display them with native `math` view nodes.

Version 1.0.0 supports restricted arithmetic expressions, exact fractions, real linear and quadratic equations, linear systems, and matrix addition, subtraction, multiplication, transpose, determinant, inverse, and reduced row echelon form. Matrices are limited to 6 × 6. Rational paths remain exact within the documented integer bound; transcendental functions and irrational roots are clearly labelled as approximations.

The package does not use a network service, secret, filesystem, native capability, external runtime, or third-party dependency. It requires Nodus 5.3.2 because it uses Capability API v2 and native mathematical views.

The official 1.0.0 archive is signed with the NodusResearch `nr02` release key. Locally built archives and ephemeral verification signatures are development artifacts rather than official releases.
