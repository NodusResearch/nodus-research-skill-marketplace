// Adopts the chemistry outcome log the built-in kept in the profile.
//
// The log is diagnostic only: it records which requests the verified lane could not draw,
// so the rules can be improved. Losing it costs nothing a user can see, which is why a
// failure here is not allowed to block the migration — but it is still adopted rather
// than dropped, because a record of what did not work is what makes the next release
// better.
//
// Re-runnable: a log this package has already adopted is left exactly as it is, so a
// retry after a later step failed cannot overwrite outcomes recorded since.
module.exports = async function migrate({ host, legacy }) {
  const entries = Array.isArray(legacy?.chemistryOutcomes)
    ? legacy.chemistryOutcomes.filter(entry => entry && typeof entry === 'object').slice(-500)
    : [];
  if (!entries.length) return { dataVersion: 1, notes: 'No outcome log to adopt.' };
  try {
    const existing = await host.storage.state.get('outcomes');
    if (Array.isArray(existing) && existing.length) {
      return { dataVersion: 1, notes: 'An outcome log is already present; the older one was left behind.' };
    }
    await host.storage.state.set('outcomes', entries);
    return { dataVersion: 1, notes: `Adopted ${entries.length} outcome record(s).` };
  } catch {
    return { dataVersion: 1, notes: 'The outcome log could not be adopted; it is diagnostic only and will be rebuilt.' };
  }
};
