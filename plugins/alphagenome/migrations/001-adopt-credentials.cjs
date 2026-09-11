// Adopts what the built-in kept in the profile.
//
// Two things matter here and one does not. The API key has to move from the built-in's
// own encrypted file into the package's secret store, or the user silently loses it. The
// accepted terms only carry over when they are the same terms this package asks for —
// consent to an older document is not consent to this one — which is why the comparison
// is against a date this package names, not against whatever the profile happened to
// hold. The runtime is deliberately not adopted: an environment pip resolved from a
// mutable index is not the pinned one this package promises, so it is rebuilt from the
// lock instead.
//
// Re-runnable by construction: storing the same key twice and writing the same consent
// twice both leave the profile exactly as one run would.

/** The AlphaGenome Output Terms the built-in recorded acceptance of, as it wrote them.
 *  The same document this package versions as 2. */
const BUILTIN_TERMS = '2026-09-08';
const TERMS_VERSION = 2;

module.exports = async function migrate({ host, legacy }) {
  const notes = [];
  const stored = legacy && typeof legacy === 'object' ? legacy.genomics : null;

  const apiKey = typeof stored?.apiKey === 'string' ? stored.apiKey.trim() : '';
  if (apiKey) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(apiKey)) {
      notes.push('The stored key did not look like an AlphaGenome key and was left behind.');
    } else if (await host.secrets.has('api-key')) {
      notes.push('A key is already configured; the old one was not copied over.');
    } else {
      await host.secrets.store('api-key', apiKey);
      notes.push('Adopted the stored API key.');
    }
  }

  if (stored?.termsVersion === BUILTIN_TERMS) {
    await host.storage.state.set('terms', TERMS_VERSION);
    notes.push('Carried over the accepted terms.');
  } else if (stored?.termsVersion) {
    notes.push('The accepted terms are from an older version and have to be accepted again.');
  }

  return { dataVersion: 1, notes: notes.join(' ') || 'Nothing to adopt.' };
};
