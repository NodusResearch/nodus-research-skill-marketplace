import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compute } from "../src/engine.js";
import factory from "../src/worker.js";
import { validateCapabilityManifestV2, validatePluginManifestV2, validateViewDocument, jsonSchemaMatches } from "../../../scripts/contract-v2.mjs";
const calc = (expression, options = {}) => compute({ mode: "calculate", expression, ...options });
for (const [expression, expected] of [
  ["1/3 + 1/6", "1/2"],
  ["0.1+0.2", "3/10"],
  ["-0.5+0.25", "-1/4"],
  ["-2^2", "-4"],
  ["(-2)^2", "4"],
  ["2^3^2", "512"],
  ["2^-3", "1/8"],
  ["(1+2)*3", "9"],
  ["1-(2-3)", "2"],
  ["sqrt(4/9)", "2/3"],
  ["abs(-3/7)", "3/7"],
  ["100*(1+5/100)", "105"],
  ["3/(-2)", "-3/2"],
  ["0^2", "0"],
  ["1/7+2/7+4/7", "1"]
]) test(`exact ${expression}`, () => {
  const r = calc(expression);
  assert.equal(r.result, expected);
  assert.equal(r.exact, true);
});
for (const [expression, expected, options] of [["sqrt(2)", Math.sqrt(2)], ["sin(pi/2)", 1], ["sin(30)", 0.5, { angles: "degrees" }], ["cos(0)", 1], ["tan(45)", 1, { angles: "degrees" }], ["ln(e)", 1], ["log(100)", 2], ["exp(1)", Math.E], ["2^0.5", Math.sqrt(2)]]) test(`approximate ${expression}`, () => {
  const r = calc(expression, options);
  assert.ok(Math.abs(Number(r.result) - expected) < 1e-10);
  assert.equal(r.exact, false);
});
for (const expression of ["1/0", "0^0", "0^-1", "sqrt(-1)", "ln(0)", "log(-1)", "exp(999)", "2^101", "99^100", "1;process.exit()", "globalThis", "\\input{secret}", "2x", "(1+2", "sin 3", "1 2", "2**3", "1e3", "1".repeat(241), "(".repeat(25) + "1" + ")".repeat(25)]) test(`reject expression ${expression.slice(0, 32)}`, () => assert.throws(() => calc(expression)));
test("tangent pole", () => assert.throws(() => calc("tan(90)", { angles: "degrees" }), /pole/));
const equation = (coefficients) => compute({ mode: "equation", coefficients });
for (const [coefficients, result] of [[[2, -3], "x = 3/2"], [[0, 0], "All real numbers"], [[0, 1], "No solution"], [[1, -3, 2], "2, 1"], [[1, -2, 1], "1, 1"], [[1, 0, 1], "No real roots"], [[0, 2, -3], "x = 3/2"], [["1/2", "-1/4"], "x = 1/2"]]) test(`equation ${coefficients}`, () => assert.equal(equation(coefficients).result, result));
test("irrational roots satisfy equation", () => {
  const r = equation([1, 0, -2]);
  assert.equal(r.exact, false);
  for (const x of r.result.split(",").map(Number)) assert.ok(Math.abs(x * x - 2) < 1e-10);
});
test("stable quadratic avoids cancellation for small root", () => {
  const r = equation([1, 99999999999, 1]);
  const roots = r.result.split(",").map(Number);
  assert.ok(roots.some((x) => Math.abs(x / (-1 / 99999999999) - 1) < 1e-10));
});
const mat = (operation, matrix, other) => compute({ mode: "matrix", operation, matrix, ...other === void 0 ? {} : { other } });
for (const [operation, a, b, result] of [
  ["add", [[1, 2]], [[3, 4]], "4, 6"],
  ["subtract", [[1, 2]], [[3, 4]], "-2, -2"],
  ["multiply", [[1, 2], [3, 4]], [[5, 6], [7, 8]], "19, 22; 43, 50"],
  ["transpose", [[1, 2, 3], [4, 5, 6]], void 0, "1, 4; 2, 5; 3, 6"],
  ["determinant", [[1, 2], [3, 4]], void 0, "-2"],
  ["determinant", [[0, 1], [2, 3]], void 0, "-2"],
  ["determinant", [[1, 2], [2, 4]], void 0, "0"],
  ["inverse", [[1, 2], [3, 4]], void 0, "-2, 1; 3/2, -1/2"],
  ["rref", [[1, 2], [2, 4]], void 0, "1, 2; 0, 0"]
]) test(`matrix ${operation} ${result}`, () => assert.equal(mat(operation, a, b).result, result));
const system = (matrix, rhs) => compute({ mode: "system", matrix, rhs });
test("unique system verifies exact residual", () => {
  const r = system([[2, 1], [1, -1]], [5, 1]);
  assert.equal(r.result, "x1 = 2, x2 = 1");
  assert.ok(r.steps.some((s) => s.tex === "Ax-b=0"));
});
test("overdetermined consistent system", () => assert.equal(system([[1], [2]], [3, 6]).result, "x1 = 3"));
test("inconsistent system", () => assert.equal(system([[1, 1], [2, 2]], [1, 3]).result, "No solution"));
test("underdetermined system", () => assert.match(system([[0, 1, 1]], [2]).result, /Infinitely/));
for (const input of [null, {}, { mode: "calculate", expression: "1", secret: "x" }, { mode: "calculate", expression: "1", angles: "grads" }, { mode: "equation", coefficients: [1] }, { mode: "matrix", operation: "inverse", matrix: [[1, 2], [2, 4]] }, { mode: "matrix", operation: "inverse", matrix: [[1, 2]] }, { mode: "matrix", operation: "add", matrix: [[1]], other: [[1, 2]] }, { mode: "matrix", operation: "multiply", matrix: [[1, 2]], other: [[1]] }, { mode: "matrix", operation: "transpose", matrix: [[{}]] }, { mode: "matrix", operation: "transpose", matrix: [[1], [1, 2]] }, { mode: "matrix", operation: "transpose", matrix: [[1]], other: [[1]] }, { mode: "system", matrix: [[1]], rhs: [] }, { mode: "system", matrix: [[1]], rhs: ["1/0"] }]) test(`reject input ${JSON.stringify(input)}`, () => assert.throws(() => compute(input)));
test("six dimensional inverse invariant", () => {
  const a = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_2, j) => i === j ? i + 1 : j > i ? 1 : 0));
  const inv = mat("inverse", a).result.split("; ").map((row) => row.split(", "));
  const product = mat("multiply", a, inv);
  assert.equal(product.result, Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_2, j) => i === j ? "1" : "0").join(", ")).join("; "));
});
import { fixtures } from "./fixtures.mjs";
test("manifest and all views satisfy the published host contract", async () => {
  const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
  validatePluginManifestV2(read("../plugin.json"));
  const manifest = validateCapabilityManifestV2(read("../capabilities/mathematics/capability.json"));
  const host = { signal: new AbortController().signal };
  const worker = factory(host);
  for (const input of fixtures) {
    assert.ok(jsonSchemaMatches(manifest.tools[0].inputSchema, input));
    const r = await worker.invoke({ toolId: "compute", input });
    assert.equal(r.artifacts.length, 1);
    validateViewDocument(r.artifacts[0].view);
    assert.deepEqual(await worker.renderArtifact(r.artifacts[0]), r.artifacts[0].view);
  }
});
test("cancellation, unknown tool and tampered stored data", async () => {
  const controller = new AbortController();
  const worker = factory({ signal: controller.signal });
  await assert.rejects(worker.invoke({ toolId: "unknown", input: {} }));
  await assert.rejects(worker.renderArtifact({ artifactType: "math-calculation", artifactVersion: 1, data: { engineVersion: "1.0.0", input: { mode: "calculate", expression: "1" }, tex: "forged" } }));
  controller.abort();
  await assert.rejects(worker.invoke({ toolId: "compute", input: fixtures[0] }));
});
