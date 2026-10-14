# Math Studio 1.0.1

One fix from an audit. A whole number of right angles in degrees now returns its exact value:
converting to radians first left a sine that should be zero at about 1.2e-16. Tangent at a pole is
reported as undefined rather than returned as a large number.

# Math Studio 1.0.0

Initial Capability API v2 package: restricted arithmetic, exact fractions, real linear/quadratic equations, small linear systems and seven matrix operations. The permissionless trusted worker returns native math nodes and algorithmic steps. No new native Nodus capability or third-party runtime dependency.

Targets: any. Minimum application version: 5.3.2. Official signing and publication remain maintainer actions; development test signatures do not establish release availability. See [VERIFICATION.md](VERIFICATION.md) for the tested build and remaining checks.
