# Chemistry Studio 2.2.1

A packaging fix. Nothing the package draws, verifies or refuses has changed.

## Five megabytes of code that never ran

Chemistry Studio vendors `tar-fs`, which carries `bare-fs`, `bare-path` and `bare-url`.
Each of those ships a prebuilt binary for every platform the Bare runtime supports —
Android, iOS, macOS, Linux and Windows — thirty-nine files and a little over five
megabytes. Node loads none of them: those modules are reached only under the `bare`
runtime condition, and a capability worker runs on Node.

They were worse than unused. Apple's notary service opens archives it finds inside a
submitted application and requires every Mach-O binary in them to carry a Developer ID
signature. The fifteen macOS and iOS binaries in 2.2.0 therefore rejected the Nodus 5.4.0
macOS builds outright: an application refused over code that could never execute in it,
and that nothing could sign, because the archive is pinned by digest against a manifest
signed for it.

Prebuilt native binaries no longer travel inside a capability package, and a build that
finds native code it did not expect now fails rather than publishing it.
