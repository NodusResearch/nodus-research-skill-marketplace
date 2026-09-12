/*! Original, bounded arithmetic. User expressions are parsed, never executed as JS. */
const fail = (message) => {
  throw new Error(message);
};
const gcd = (a, b) => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};
function rational(n, d = 1n) {
  if (!d) fail("Division by zero.");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  n /= g;
  d /= g;
  if (n.toString(2).length > 512 || d.toString(2).length > 512) fail("Exact arithmetic exceeds the 512-bit limit.");
  return { n, d };
}
const zero = () => rational(0n), one = () => rational(1n);
const number = (v) => v.approx ?? Number(v.n) / Number(v.d);
const approximate = (x) => Number.isFinite(x) ? { approx: Object.is(x, -0) ? 0 : x } : fail("Result is not finite in the real-number domain.");
const text = (v) => v.approx !== void 0 ? Number(v.approx.toPrecision(12)).toString() : v.d === 1n ? String(v.n) : `${v.n}/${v.d}`;
const tex = (v) => v.approx !== void 0 ? text(v).replace(/e([+-]?\d+)/, "\\times 10^{$1}") : v.d === 1n ? String(v.n) : `${v.n < 0n ? "-" : ""}\\frac{${v.n < 0n ? -v.n : v.n}}{${v.d}}`;
const neg = (a) => a.approx !== void 0 ? approximate(-a.approx) : rational(-a.n, a.d);
function op(a, b, s) {
  if (s === "/" && number(b) === 0) fail("Division by zero.");
  if (a.approx !== void 0 || b.approx !== void 0) return approximate({ "+": () => number(a) + number(b), "-": () => number(a) - number(b), "*": () => number(a) * number(b), "/": () => number(a) / number(b) }[s]());
  return s === "+" ? rational(a.n * b.d + b.n * a.d, a.d * b.d) : s === "-" ? rational(a.n * b.d - b.n * a.d, a.d * b.d) : s === "*" ? rational(a.n * b.n, a.d * b.d) : rational(a.n * b.d, a.d * b.n);
}
function pow(a, b) {
  if (number(a) === 0 && number(b) <= 0) fail("Zero to a non-positive power is undefined.");
  if (b.approx === void 0 && b.d === 1n) {
    if (b.n > 100n || b.n < -100n) fail("Integer exponents must be between -100 and 100.");
    if (a.approx === void 0) return b.n < 0n ? rational(a.d ** -b.n, a.n ** -b.n) : rational(a.n ** b.n, a.d ** b.n);
  }
  return approximate(Math.pow(number(a), number(b)));
}
function decimal(s) {
  if (!/^[+-]?\d{1,12}(?:\.\d{1,12})?$/.test(s)) fail("Use decimal literals with at most 12 digits on each side of the decimal point.");
  const [a, b = ""] = s.split(".");
  return rational(BigInt(a + b), 10n ** BigInt(b.length));
}
function scalar(value) {
  if (typeof value !== "string" && typeof value !== "number") fail("Matrix entries and coefficients must be decimal numbers or fraction strings.");
  if (String(value).length > 64) fail("Numeric input exceeds 64 characters.");
  const parts = String(value).split("/");
  if (parts.length > 2) fail("Invalid fraction.");
  return parts.length === 2 ? op(decimal(parts[0]), decimal(parts[1]), "/") : decimal(parts[0]);
}
function sqrtExact(v) {
  if (number(v) < 0) fail("Square root requires a non-negative real number.");
  if (v.approx !== void 0) return approximate(Math.sqrt(v.approx));
  const root = (n) => {
    if (n < 2n) return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  };
  const a = root(v.n), b = root(v.d);
  return a * a === v.n && b * b === v.d ? rational(a, b) : approximate(Math.sqrt(number(v)));
}
function calculate(expression, add, angles) {
  if (typeof expression !== "string" || expression.length < 1 || expression.length > 240) fail("Expression must contain 1\u2013240 characters.");
  const tokens = expression.match(/\d+(?:\.\d+)?|[a-z]+|[+\-*/^()]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, "") || tokens.length > 100) fail("Unsupported expression or token limit exceeded.");
  let p = 0, depth = 0;
  const record = (v, t) => {
    if (v.approx !== undefined || t !== tex(v)) add(t + (v.approx !== void 0 ? "\\approx" : "=") + tex(v), `${t}: ${text(v)}`);
    return { v, t };
  };
  function atom() {
    if (++depth > 24) fail("Expression nesting exceeds 24 levels.");
    let result2;
    const token = tokens[p++];
    if (token === "(") {
      result2 = sum();
      if (tokens[p++] !== ")") fail("Missing closing parenthesis.");
      result2.t = `\\left(${result2.t}\\right)`;
    } else if (/^\d/.test(token ?? "")) {
      result2 = { v: decimal(token), t: token };
    } else if (token === "pi" || token === "e") {
      result2 = { v: approximate(token === "pi" ? Math.PI : Math.E), t: token === "pi" ? "\\pi" : "e" };
    } else if (["sqrt", "abs", "sin", "cos", "tan", "ln", "log", "exp"].includes(token)) {
      if (tokens[p++] !== "(") fail("Functions require parentheses.");
      const arg = sum();
      if (tokens[p++] !== ")") fail("Missing closing parenthesis.");
      let v;
      const x = number(arg.v), angle = angles === "degrees" ? x * Math.PI / 180 : x;
      if (token === "sqrt") v = sqrtExact(arg.v);
      else if (token === "abs") v = x < 0 ? neg(arg.v) : arg.v;
      else {
        if (["ln", "log"].includes(token) && x <= 0) fail("Logarithms require a positive argument.");
        if (token === "tan" && Math.abs(Math.cos(angle)) < 1e-14) fail("Tangent is undefined or too close to a pole.");
        v = approximate({ sin: () => Math.sin(angle), cos: () => Math.cos(angle), tan: () => Math.tan(angle), ln: () => Math.log(x), log: () => Math.log10(x), exp: () => Math.exp(x) }[token]());
      }
      const argument = angles === "degrees" && ["sin", "cos", "tan"].includes(token) ? `\\left(${arg.t}\\right)^{\\circ}` : arg.t;
      const t = token === "sqrt" ? `\\sqrt{${arg.t}}` : `\\operatorname{${token}}\\left(${argument}\\right)`;
      result2 = record(v, t);
    } else fail("Expected a number, constant, function or parenthesized expression.");
    depth--;
    return result2;
  }
  function power() {
    let a = atom();
    if (tokens[p] === "^") {
      p++;
      const b = unary();
      a = record(pow(a.v, b.v), `{${a.t}}^{${b.t}}`);
    }
    return a;
  }
  function unary() {
    if (tokens[p] === "+" || tokens[p] === "-") {
      const sign = tokens[p++], a = unary();
      return sign === "-" ? { v: neg(a.v), t: `-\\left(${a.t}\\right)` } : a;
    }
    return power();
  }
  function product() {
    let a = unary();
    while (tokens[p] === "*" || tokens[p] === "/") {
      const s = tokens[p++], b = unary();
      a = record(op(a.v, b.v, s), s === "/" ? `\\frac{${a.t}}{${b.t}}` : `${a.t}\\cdot ${b.t}`);
    }
    return a;
  }
  function sum() {
    let a = product();
    while (tokens[p] === "+" || tokens[p] === "-") {
      const s = tokens[p++], b = product();
      a = record(op(a.v, b.v, s), `${a.t}${s}${b.t}`);
    }
    return a;
  }
  const result = sum();
  if (p !== tokens.length) fail("Unexpected tokens; multiplication must use *.");
  return result;
}
const matrixTex = (m) => `\\begin{bmatrix}${m.map((row) => row.map(tex).join("&")).join("\\\\")}\\end{bmatrix}`;
function matrix(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 6 || !Array.isArray(raw[0]) || !raw[0].length || raw[0].length > 6) fail("Matrices must have 1\u20136 rows and columns.");
  const width = raw[0].length;
  if (raw.some((r) => !Array.isArray(r) || r.length !== width)) fail("Matrix rows must have equal lengths.");
  return raw.map((r) => r.map(scalar));
}
function eliminate(raw, pivotColumns, add, check) {
  const a = raw.map((r) => r.slice());
  let row = 0, det = one();
  const pivots = [];
  for (let col = 0; col < pivotColumns && row < a.length; col++) {
    check();
    const pivot = a.findIndex((r, i) => i >= row && r[col].n !== 0n);
    if (pivot < 0) continue;
    if (pivot !== row) {
      [a[pivot], a[row]] = [a[row], a[pivot]];
      det = neg(det);
      add(`R_{${row + 1}}\\leftrightarrow R_{${pivot + 1}}`, "Swap rows.");
    }
    const value = a[row][col];
    det = op(det, value, "*");
    a[row] = a[row].map((x) => op(x, value, "/"));
    add(`R_{${row + 1}}\\gets R_{${row + 1}}/\\left(${tex(value)}\\right)`, "Normalize pivot row.");
    for (let i = 0; i < a.length; i++) if (i !== row && a[i][col].n !== 0n) {
      const f = a[i][col];
      a[i] = a[i].map((x, j) => op(x, op(f, a[row][j], "*"), "-"));
      add(`R_{${i + 1}}\\gets R_{${i + 1}}-\\left(${tex(f)}\\right)R_{${row + 1}}`, "Eliminate pivot column.");
    }
    pivots.push(col);
    row++;
  }
  return { a, pivots, det: row === pivotColumns ? det : zero() };
}
function compute(input, signal) {
  const check = () => signal?.throwIfAborted();
  check();
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Expected an input object.");
  const allowed = { calculate: ["mode", "expression", "angles"], equation: ["mode", "coefficients"], system: ["mode", "matrix", "rhs"], matrix: ["mode", "operation", "matrix", "other"] }[input.mode];
  if (!allowed || Object.keys(input).some((k) => !allowed.includes(k))) fail("Unknown mode or input field.");
  const steps = [];
  const add = (t, alt) => {
    check();
    if (t.length > 4e3 || steps.length >= 80) fail("Calculation exceeds the display budget.");
    steps.push({ tex: t, alt });
  };
  let result, resultTex, exact = true;
  if (input.mode === "calculate") {
    if (input.angles !== void 0 && !["radians", "degrees"].includes(input.angles)) fail("Angles must be radians or degrees.");
    const a = calculate(input.expression, add, input.angles ?? "radians");
    result = text(a.v);
    resultTex = `${a.t}${a.v.approx !== void 0 ? "\\approx" : "="}${tex(a.v)}`;
    exact = a.v.approx === void 0;
  } else if (input.mode === "equation") {
    if (!Array.isArray(input.coefficients) || ![2, 3].includes(input.coefficients.length)) fail("Supply [b,c] for bx+c=0 or [a,b,c] for ax\xB2+bx+c=0.");
    let values = input.coefficients.map(scalar);
    if (values.length === 3 && values[0].n === 0n) values = values.slice(1);
    if (values.length === 2) {
      const [b, c] = values;
      add(`\\left(${tex(b)}\\right)x+\\left(${tex(c)}\\right)=0`, "Linear equation.");
      if (!b.n) {
        result = c.n ? "No solution" : "All real numbers";
        resultTex = c.n ? "\\varnothing" : "x\\in\\mathbb{R}";
      } else {
        const x = op(neg(c), b, "/");
        result = `x = ${text(x)}`;
        resultTex = `x=${tex(x)}`;
        add(`x=\\frac{-(${tex(c)})}{${tex(b)}}`, "Isolate x.");
      }
    } else {
      const [a, b, c] = values, d = op(op(b, b, "*"), op(rational(4n), op(a, c, "*"), "*"), "-");
      add(`(${tex(a)})x^2+(${tex(b)})x+(${tex(c)})=0`, "Quadratic equation.");
      add(`\\Delta=b^2-4ac=${tex(d)}`, "Compute the discriminant.");
      if (d.n < 0n) {
        result = "No real roots";
        resultTex = "\\{x\\in\\mathbb{R}:ax^2+bx+c=0\\}=\\varnothing";
      } else {
        const root = sqrtExact(d);
        if (root.approx === void 0) {
          const den = op(rational(2n), a, "*"), xs = [op(op(neg(b), root, "+"), den, "/"), op(op(neg(b), root, "-"), den, "/")];
          result = xs.map(text).join(", ");
          resultTex = `x\\in\\left\\{${xs.map(tex).join(",")}\\right\\}`;
        } else {
          /*! Stable q formulation avoids subtracting two nearly equal floating values. */
          const q = -0.5 * (number(b) + (number(b) >= 0 ? 1 : -1) * root.approx);
          const xs = [approximate(q / number(a)), approximate(number(c) / q)];
          exact = false;
          result = xs.map(text).join(", ");
          resultTex = `x_1\\approx ${tex(xs[0])},\\quad x_2\\approx ${tex(xs[1])}`;
        }
        add("x=\\frac{-b\\pm\\sqrt{\\Delta}}{2a}", "Quadratic formula; irrational roots use stable q evaluation.");
      }
    }
  } else {
    const a = matrix(input.matrix), rows = a.length, cols = a[0].length;
    add(`A=${matrixTex(a)}`, "Input matrix A: " + a.map((r) => r.map(text).join(", ")).join("; "));
    if (input.mode === "system") {
      if (!Array.isArray(input.rhs) || input.rhs.length !== rows) fail("Right-hand side must have one entry per row.");
      const b = input.rhs.map(scalar);
      add(`b=${matrixTex(b.map((x) => [x]))}`, "Right-hand side: " + b.map(text).join(", "));
      const r = eliminate(a.map((row, i) => [...row, b[i]]), cols, add, check);
      add(matrixTex(r.a), "Reduced augmented matrix.");
      if (r.a.some((row) => row.slice(0, cols).every((x) => !x.n) && row[cols].n)) {
        result = "No solution";
        resultTex = "\\varnothing";
      } else if (r.pivots.length < cols) {
        result = "Infinitely many solutions; reduced augmented matrix specifies the free variables.";
        resultTex = matrixTex(r.a);
      } else {
        const x = Array(cols);
        r.pivots.forEach((col, i) => {
          x[col] = r.a[i][cols];
        });
        for (let i = 0; i < rows; i++) if (op(a[i].reduce((s, v, j) => op(s, op(v, x[j], "*"), "+"), zero()), b[i], "-").n) fail("Internal residual verification failed.");
        result = x.map((v, i) => `x${i + 1} = ${text(v)}`).join(", ");
        resultTex = `x=${matrixTex(x.map((v) => [v]))}`;
        add("Ax-b=0", "Exact residual verified.");
      }
    } else {
      let out;
      if (input.operation === "transpose") out = a[0].map((_, j) => a.map((row) => row[j]));
      else if (["add", "subtract", "multiply"].includes(input.operation)) {
        const b = matrix(input.other);
        add(`B=${matrixTex(b)}`, "Input matrix B: " + b.map((r) => r.map(text).join(", ")).join("; "));
        if (input.operation === "multiply") {
          if (cols !== b.length) fail("Matrix multiplication dimensions do not agree.");
          out = a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => op(s, op(v, b[k][j], "*"), "+"), zero())));
          add("C_{ij}=\\sum_k A_{ik}B_{kj}", "Compute each row-column dot product.");
        } else {
          if (rows !== b.length || cols !== b[0].length) fail("Matrix dimensions must agree.");
          out = a.map((row, i) => row.map((v, j) => op(v, b[i][j], input.operation === "add" ? "+" : "-")));
        }
      } else if (["determinant", "inverse", "rref"].includes(input.operation)) {
        if (input.operation !== "rref" && rows !== cols) fail("This operation requires a square matrix.");
        const augmented = input.operation === "inverse" ? a.map((row, i) => [...row, ...a.map((_, j) => rational(i === j ? 1n : 0n))]) : a;
        const r = eliminate(augmented, cols, add, check);
        if (input.operation === "determinant") {
          result = text(r.det);
          resultTex = `\\det(A)=${tex(r.det)}`;
        } else if (input.operation === "inverse") {
          if (r.pivots.length !== rows) fail("Singular matrix: no inverse.");
          out = r.a.map((row) => row.slice(cols));
        } else out = r.a;
      } else fail("Unsupported matrix operation.");
      if (!["add", "subtract", "multiply"].includes(input.operation) && input.other !== void 0) fail("This operation does not accept a second matrix.");
      if (out) {
        result = out.map((r) => r.map(text).join(", ")).join("; ");
        resultTex = matrixTex(out);
      }
    }
  }
  check();
  if (resultTex.length > 4e3 || result.length > 450) fail("Result exceeds the display budget.");
  return { result, resultTex, exact, steps };
}
export {
  compute,
  rational
};
