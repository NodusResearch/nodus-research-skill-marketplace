// Deterministic and self-contained: no permissions are declared, so this runtime has no
// host operations at all. It runs in an ephemeral Chromium sandbox without Node, the
// filesystem, imports, an application bridge or any network access.
(request) => {
  const LENGTH = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, mi: 1609.344 };
  const MASS = { mg: 0.000001, g: 0.001, kg: 1, t: 1000, oz: 0.028349523125, lb: 0.45359237 };
  const TEMPERATURE = {
    C: { toKelvin: (value) => value + 273.15, fromKelvin: (kelvin) => kelvin - 273.15 },
    F: { toKelvin: (value) => (value + 459.67) * (5 / 9), fromKelvin: (kelvin) => kelvin * (9 / 5) - 459.67 },
    K: { toKelvin: (value) => value, fromKelvin: (kelvin) => kelvin },
  };

  const { value, from, to } = request.input;
  if (!Number.isFinite(value)) throw new Error('The value must be a finite number.');

  const scale = (table) => (from in table && to in table ? { kind: 'json', value: { value: (value * table[from]) / table[to], unit: to } } : null);
  const length = scale(LENGTH);
  if (length) return length;
  const mass = scale(MASS);
  if (mass) return mass;
  if (from in TEMPERATURE && to in TEMPERATURE) {
    const kelvin = TEMPERATURE[from].toKelvin(value);
    if (kelvin < 0) throw new Error('That temperature is below absolute zero.');
    return { kind: 'json', value: { value: TEMPERATURE[to].fromKelvin(kelvin), unit: to } };
  }

  throw new Error(`Cannot convert ${from} to ${to}: they are not the same kind of quantity, or one is not a supported unit.`);
}
