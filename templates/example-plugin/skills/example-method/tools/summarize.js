(input) => ({ count: input.values.length, total: input.values.reduce((total, value) => total + value, 0) })
