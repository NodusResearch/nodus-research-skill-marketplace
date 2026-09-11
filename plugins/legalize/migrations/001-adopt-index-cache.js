// Adopts the country index cache the built-in wrote to the profile.
//
// The cache is rebuildable, so nothing here is load-bearing: an index that cannot be read
// or that belongs to a revision the package no longer trusts is simply left behind and
// rebuilt on the next query. What this avoids is a first search re-downloading a few
// hundred megabytes the machine already has.
module.exports = async function migrate({ host, legacy }) {
  const adopted = [];
  for (const entry of legacy?.legalizeIndexes ?? []) {
    if (!entry || typeof entry.country !== 'string' || !/^[a-z]{2}$/.test(entry.country)) continue;
    const index = entry.index;
    if (!index || typeof index.revision !== 'string' || !/^[a-f0-9]{40}$/.test(index.revision)
      || !Array.isArray(index.entries) || !index.entries.length || index.skipped) continue;
    await host.storage.cache.set(`index-${entry.country}`, { revision: index.revision, entries: index.entries, skipped: 0 });
    adopted.push(entry.country);
  }
  return { dataVersion: 1, notes: adopted.length ? `Adopted cached indexes: ${adopted.join(', ')}.` : 'No reusable cached index was found.' };
};
