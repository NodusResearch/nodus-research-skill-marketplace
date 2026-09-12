# AlphaGenome 2.0.0

AlphaGenome is now an installable capability package rather than part of the Nodus
application. What it does has not changed: one validated regulatory variant
prediction from the official API, using your own personal key, for non-commercial
research.

## What is different

- The Python runtime is built from a lock published with this package: every wheel
  is pinned by URL, size and SHA-256, and installed with `--no-index
  --require-hashes`. The built-in resolved its dependencies from a live index at
  install time, so two machines could end up with different code.
- Your key never reaches the package. Nodus holds it in the system credential
  store and writes it into the interpreter's standard input itself, so it is not
  in an argument list, an environment variable or a log line.
- The result declares itself invisible to the model, and Nodus enforces that. The
  rule used to be written into the application for this one case; it is now part
  of what the package says about its own output.
- Messages are localized by the package instead of being raised in English from a
  layer the translation system could not reach.

## What is carried over

The stored key moves into the secret store on first run. Accepted terms carry over
only when the version matches exactly: consent to older terms is not consent to
these. The runtime is not adopted — an environment resolved from a mutable index
is not the pinned one this package promises, so it is rebuilt from the lock.

Results saved by the built-in keep rendering.
