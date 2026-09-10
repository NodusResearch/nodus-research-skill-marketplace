// Deterministic and self-contained: no permissions are declared, so this runtime has no
// host operations at all. It runs in an ephemeral Chromium sandbox without Node, the
// filesystem, imports, an application bridge or any network access.
//
// Every measurement in the request is converted in one call. Batching is deliberate: a
// reply has a limited number of capability calls, so a table of measurements must not
// need one call per row.
(request) => {
  const LENGTH = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, mi: 1609.344 };
  const MASS = { mg: 0.000001, g: 0.001, kg: 1, t: 1000, oz: 0.028349523125, lb: 0.45359237 };
  const TEMPERATURE = {
    C: { toKelvin: (value) => value + 273.15, fromKelvin: (kelvin) => kelvin - 273.15 },
    F: { toKelvin: (value) => (value + 459.67) * (5 / 9), fromKelvin: (kelvin) => kelvin * (9 / 5) - 459.67 },
    K: { toKelvin: (value) => value, fromKelvin: (kelvin) => kelvin },
  };

  const convert = ({ value, from, to }) => {
    if (!Number.isFinite(value)) throw new Error('Every value must be a finite number.');
    const scale = (table) => (from in table && to in table ? (value * table[from]) / table[to] : null);
    const length = scale(LENGTH);
    if (length !== null) return length;
    const mass = scale(MASS);
    if (mass !== null) return mass;
    if (from in TEMPERATURE && to in TEMPERATURE) {
      const kelvin = TEMPERATURE[from].toKelvin(value);
      if (kelvin < 0) throw new Error(`${value} ${from} is below absolute zero.`);
      return TEMPERATURE[to].fromKelvin(kelvin);
    }
    throw new Error(`Cannot convert ${from} to ${to}: they are not the same kind of quantity, or one is not a supported unit.`);
  };

  const { measurements } = request.input;
  if (!measurements.length) throw new Error('Give at least one measurement to convert.');
  if (measurements.length > 200) throw new Error('At most 200 measurements can be converted in one call.');

  // One bad row fails only that row, so a long table still returns everything it can.
  const rows = measurements.map((measurement) => {
    try {
      return [measurement.value, measurement.from, convert(measurement), measurement.to, ''];
    } catch (error) {
      return [measurement.value, measurement.from, null, measurement.to, error.message];
    }
  });
  return { kind: 'table', columns: ['value', 'from', 'converted', 'to', 'problem'], rows };
}
