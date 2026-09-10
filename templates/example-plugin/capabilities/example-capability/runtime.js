// Runs in an ephemeral Chromium sandbox: no Node, filesystem, imports, bridge or direct
// network. Declare permissions in capability.json to reach a host operation.
(request) => {
  const metres = { m: 1, km: 1000 };
  const { value, from, to } = request.input;
  if (!(from in metres) || !(to in metres)) throw new Error('Supported units are m and km.');
  return { kind: 'json', value: { value: (value * metres[from]) / metres[to], unit: to } };
}
