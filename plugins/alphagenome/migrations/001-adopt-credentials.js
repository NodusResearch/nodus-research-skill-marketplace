// Adopts what the built-in kept in the profile.
//
// Two things matter here and one does not. The API key has to move from the built-in's
// own encrypted file into the package's secret store, or the user silently loses it. The
// accepted terms only carry over when the version matches exactly — consent to older
// terms is not consent to these. The runtime is deliberately not adopted: an environment
// pip resolved from a mutable index is not the pinned one this package promises, so it is
// rebuilt from the lock instead.
module.exports = async function migrate({ host, legacy }) {
  const notes = [];
  if (typeof legacy?.genomics?.apiKey === 'string' && legacy.genomics.apiKey.trim()) {
    await host.secrets.store('api-key', legacy.genomics.apiKey.trim());
    notes.push('Adopted the stored API key.');
  }
  if (legacy?.genomics?.termsVersion === legacy?.currentTermsVersion) {
    await host.storage.state.set('terms', 2);
    notes.push('Carried over the accepted terms.');
  } else if (legacy?.genomics?.termsVersion) {
    notes.push('The accepted terms are from an older version and have to be accepted again.');
  }
  return { dataVersion: 1, notes: notes.join(' ') || 'Nothing to adopt.' };
};
