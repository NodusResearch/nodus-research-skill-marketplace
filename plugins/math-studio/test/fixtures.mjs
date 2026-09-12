const fixtures = [{ mode: "calculate", expression: "1/3+1/6" }, { mode: "calculate", expression: "sin(30)", angles: "degrees" }, { mode: "equation", coefficients: [1, -3, 2] }, { mode: "equation", coefficients: [1, 0, -2] }, { mode: "system", matrix: [[2, 1], [1, -1]], rhs: [5, 1] }, ...["add", "subtract", "multiply", "transpose", "determinant", "inverse", "rref"].map((operation) => ({ mode: "matrix", operation, matrix: [[1, 2], [3, 4]], ...["add", "subtract", "multiply"].includes(operation) ? { other: [[5, 6], [7, 8]] } : {} }))];
export {
  fixtures
};
