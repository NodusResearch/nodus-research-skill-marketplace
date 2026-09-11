// Adopts the country index cache the built-in wrote to the profile.
//
// The cache is rebuildable, so nothing here is load-bearing: an index that cannot be read
// or that belongs to a revision the package no longer trusts is simply left behind and
// rebuilt on the next query. What this avoids is a first search re-downloading a few
// hundred megabytes the machine already has.
//
// One country failing must not cost the others theirs, so each is adopted on its own and
// an index already in the cache is left alone — which is also what makes a retry after an
// interrupted run cheap rather than destructive.
module.exports = async function migrate({ host, legacy }) {
  const adopted = [];
  const skipped = [];
  for (const entry of legacy?.legalizeIndexes ?? []) {
    if (!entry || typeof entry.country !== 'string' || !/^[a-z]{2}$/.test(entry.country)) continue;
    const index = entry.index;
    if (!index || typeof index.revision !== 'string' || !/^[a-f0-9]{40}$/.test(index.revision)
      || !Array.isArray(index.entries) || !index.entries.length || index.skipped) continue;
    const key = `index-${entry.country}`;
    try {
      // Anything already in the cache was put there by this package, which means it is at
      // least as current as what the built-in left. Adoption fills a gap; it never
      // overwrites a snapshot the package fetched for itself.
      const existing = await host.storage.cache.get(key);
      if (existing && typeof existing === 'object') continue;
      await host.storage.cache.set(key, { revision: index.revision, entries: index.entries, skipped: 0 });
      adopted.push(entry.country);
    } catch {
      skipped.push(entry.country);
    }
  }
  const notes = [
    adopted.length ? `Adopted cached indexes: ${adopted.join(', ')}.` : 'No reusable cached index was found.',
    skipped.length ? `Left behind and will be rebuilt: ${skipped.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  return { dataVersion: 1, notes };
};
