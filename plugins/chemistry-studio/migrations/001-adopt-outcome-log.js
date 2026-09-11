// Adopts the chemistry outcome log the built-in kept in the profile.
//
// The log is diagnostic only: it records which requests the verified lane could not draw,
// so the rules can be improved. Losing it costs nothing a user can see, which is why a
// failure here is not allowed to block the migration.
module.exports = async function migrate({ host, legacy }) {
  const entries = Array.isArray(legacy?.chemistryOutcomes) ? legacy.chemistryOutcomes.slice(-500) : [];
  if (!entries.length) return { dataVersion: 1, notes: 'No outcome log to adopt.' };
  try {
    await host.storage.state.set('outcomes', entries);
    return { dataVersion: 1, notes: `Adopted ${entries.length} outcome record(s).` };
  } catch {
    return { dataVersion: 1, notes: 'The outcome log could not be adopted; it is diagnostic only and will be rebuilt.' };
  }
};
