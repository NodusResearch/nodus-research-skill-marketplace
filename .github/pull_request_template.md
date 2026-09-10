## Skill, plugin and purpose

Describe the user request this package solves and why the method is useful. Say whether it is
a skill package or a plugin.

## Capabilities and tools

List every native capability, plugin capability and custom tool, with required inputs, outputs
and limitations. For a plugin, list the exact permissions each capability requests (HTTPS
endpoints and methods, secrets, storage) and justify each one.

## Verification

Provide a reproducible request, expected output and invalid-input case. Confirm testing in Assistant and Nodi, including disabled behavior.

- [ ] `node scripts/catalog.mjs --check` passes.
- [ ] The package has its own root directory and a bumped version for an update.
- [ ] For a plugin: `plugin.json`, every `skill.json` and every `capability.json` carry the same version, and `compatibility.minNodusVersion` matches a release I tested.
- [ ] For a plugin: I installed it from a directory (Import, or the profile inbox) and ran every tool and capability from a real conversation.
- [ ] Permissions are the narrowest that work; any expansion versus the previous version is called out above.
- [ ] Metadata and documentation are in English.
- [ ] I have rights to submit the code and content under the declared license, with necessary attribution.
- [ ] I have read POLICY.md; this submission does not promote illegal activity, piracy or unauthorized access.
- [ ] The package contains no secrets, private data, hidden execution or undeclared capabilities.

## Maintainer review

Format validation is not publication approval. Review the instructions, tool source, capability runtime, requested permissions, licensing, purpose and examples before merging. Generated artifacts (`scripts/contract.mjs` and the README catalog block) must never be edited by hand.
