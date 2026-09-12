# Math Studio

## 1. Purpose and non-goals

Calculate arithmetic and fractions, solve real linear/quadratic equations and linear systems, and work with small matrices. Use for generic research methodology and educator-authored synthetic exercises. Display results and algorithmic steps using Nodus native mathematics.

This is not a general computer algebra system: no arbitrary symbolic simplification, derivatives, integrals, complex roots, units, proofs, clinical decisions or assessment of real students. A successful calculation does not validate a scientific model or its assumptions.

## 2. Required inputs and permitted data

Accept only mathematical expressions and demonstrably non-personal numeric coefficients, such as synthetic exercises or physical constants the user is entitled to use. Do not request names, documents, records, dataset rows, student submissions or identifying context. Expressions are arithmetic syntax, never code or user-supplied TeX. Decimals use a dot; multiplication requires `*`.

Matrix entries, right-hand sides and coefficients may be decimal numbers or strings such as `"-3/7"`. Decimal literals allow at most 12 digits before and after the dot. Prefer strings to preserve intended decimals. Matrices have 1–6 rows and columns; equations supply two or three coefficients. No scientific-notation input.

## 3. Capability and prerequisites

Requires this package's `self:mathematics` capability (`math-studio:mathematics` after installation), Capability API v2 and Nodus 5.3.2. The `compute` tool is mandatory for every claimed computed result. It runs an original JavaScript engine and returns a native `math` view with stored provenance. No API key, endpoint, network, files, runtime download or host permissions are needed. Installation requires the official signed v2 distribution; an unsigned development archive is not an installable release. Enable the installed skill for the desired conversation surface.

## 4. Validation and privacy before access

The intake boundary must exclude personal or potentially re-identifiable data before any model access. This skill cannot anonymize raw data or enforce a boundary after a user has already pasted it into chat. Do not solicit such data, forward it to tools, or claim that removing names makes it permitted. A workflow requiring that data is unsupported until an application-controlled, reviewed boundary exists.

For permitted mathematical input, resolve ambiguous decimal separators, parentheses, angle units and coefficient ordering before invoking the tool. Do not silently change numbers. The engine rejects unsupported syntax, extra fields, dimension mismatches, undefined real operations and resource-limit violations. Neither consent nor a disclaimer expands permitted uses.

## 5. Execution and tool selection

1. Select a mode, preserving the user's values. State any modeling assumptions separately from the calculation.
2. Invoke `compute` through a `math-studio-request` fence containing one JSON object. Use at most four calls per reply, accounting for other tools. Choose the matching shape:
   - Arithmetic: `{"mode":"calculate","expression":"1/3 + 1/6"}`. Operators: `+ - * / ^`, parentheses, `pi`, `e`, and one-argument `sqrt`, `abs`, `sin`, `cos`, `tan`, `ln`, `log`, `exp`. Powers associate right; unary minus follows powers. `ln` is natural and `log` base 10. Angles default to radians; set `"angles":"degrees"` when required. Expressions are limited to 240 characters, 100 tokens and 24 nested atoms; integer powers range from -100 to 100.
   - Equation: `{"mode":"equation","coefficients":[1,-3,2]}` represents `ax²+bx+c=0`. Two entries represent `bx+c=0`. A zero quadratic coefficient reduces to a linear equation. Roots are restricted to real numbers.
   - System: `{"mode":"system","matrix":[[2,1],[1,-1]],"rhs":[5,1]}` solves `Ax=b`. A unique solution includes an exact residual check; inconsistent and underdetermined systems are reported explicitly. The latter returns the reduced augmented matrix and identifies the presence of free variables, without a parameterized solution.
   - Matrix: `{"mode":"matrix","operation":"inverse","matrix":[[1,2],[3,4]]}`. Operations are `add`, `subtract`, `multiply`, `transpose`, `determinant`, `inverse`, `rref`. The first three require `other`; the rest reject it. Determinants and inverses require square matrices.
3. Let the host execute and render the artifact. Never write a model-authored result fence or pretend a request itself proves successful execution. Explain the selected method when useful, but do not replace computed steps with invented steps or infer a hidden artifact's result.
4. Report success only after the host produces the result. On a mathematical or schema error, explain the specific limitation and correct only an unambiguous transcription error; otherwise ask for the missing mathematical input. Do not retry an unchanged failure.

## 6. Outputs, evidence and provenance

Expect a native formula containing the result, an exact/approximate label, the mathematical inputs, algorithm-generated steps and engine version. Rational arithmetic, rational roots and row reduction are exact within the 512-bit reduced numerator/denominator limit. Irrational roots, constants and transcendental operations use JavaScript floating point, displayed to 12 significant digits without certified error bounds. Intermediate display is bounded; exceeding the budget fails rather than truncating evidence.

Artifacts store the input and engine version; Nodus supplies package provenance. Reopening recomputes with that engine version. Stored artifact data has `modelVisibility: none`; the host displays it to the user without sending stored results back into model context. Keep external factual interpretation and researcher conclusions distinct from this deterministic calculation. Cite a source only when one was actually supplied/retrieved; synthetic exercises need no invented citation.

## 7. Limitations, errors and cancellation

Reject unsupported modes, singular inverse requests, division by zero, non-finite results, invalid dimensions and non-real domains. Quadratics with negative discriminant report no real roots, not no complex roots. Near tangent poles are rejected; floating-point underflow and roundoff remain possible. Exact row operations may exceed the bounded integer or display budget even when a final answer is small. The host timeout and cancellation apply; computation checks cancellation between bounded stages. No output after cancellation should be claimed as complete.

If the package is absent, disabled or incompatible, explain the prerequisite and stop claiming executable mathematics. There are no secrets to configure or remote services to retry. Refuse workflows involving real-student assessment, individual clinical decisions, fabricated evidence or inputs requiring prohibited personal-data exposure. No current-source retrieval, scientific certification, full symbolic algebra or production release is implied by this skill.
