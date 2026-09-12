# Chemistry Studio 2.0.1

A packaging fix. Nothing about what the package draws, refuses to draw, reaches or spends
has changed; the capability, its permissions and its behaviour are identical to 2.0.0.

## What is different

- **The licence notices are complete on Linux.** 2.0.0 shipped `combined-stream`,
  `delayed-stream` and `form-data` there with only "Licence: MIT" and none of the text MIT
  requires be distributed with them. Those three name their licence file `License`, and the
  generator looked for a list of exact spellings: macOS matched it through a
  case-insensitive filesystem and Linux did not. The notices are now read from the
  directory, so the same package carries the same notices everywhere.

- **One archive instead of four.** 2.0.0 declared four targets and published byte-identical
  code in all of them — 21 MB, four times, for one package of JavaScript, WebAssembly and
  data that does not vary by platform. It declares `any` now. Nodus installs the same
  archive on every platform, and an install or an update from 2.0.0 needs no special
  handling: the store resolves the target the catalog offers.

Both were only visible because the archives had three different digests for identical code.
The third cause of that has also been fixed, in the build rather than here: zip timestamps
are stored in DOS format and were encoded in the build machine's timezone, so an archive was
reproducible only on UTC. A published package can now be rebuilt from its commit, on any
machine, and compared against the digest its release manifest is signed over.
