(input) => {
  if (!input || !Array.isArray(input.values) || !input.values.length || input.values.length > 10000 || input.values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Provide between 1 and 10000 finite numbers in values.');
  }
  const values = [...input.values].sort((a, b) => a - b);
  let mean = 0, m2 = 0;
  for (let index = 0; index < values.length; index++) {
    const delta = values[index] - mean;
    mean += delta / (index + 1);
    m2 += delta * (values[index] - mean);
  }
  const middle = Math.floor(values.length / 2);
  const result = { count: values.length, mean, median: values.length % 2 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2, minimum: values[0], maximum: values[values.length - 1], range: values[values.length - 1] - values[0], populationStandardDeviation: Math.sqrt(m2 / values.length) };
  if (Object.values(result).some(value => !Number.isFinite(value))) throw new Error('Numbers exceed the supported numeric range.');
  return result;
}
