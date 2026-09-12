import { validateViewDocument } from "../../../scripts/contract-v2.mjs";
import { compute } from "./engine.js";
const paragraph = (text) => ({ kind: "paragraph", spans: [{ text }] });
function view(input, signal) {
  const value = compute(input, signal);
  return validateViewDocument({ schemaVersion: 1, title: "Math Studio", summary: value.result, nodes: [
    { kind: "math", tex: value.resultTex, display: true, alt: value.result },
    paragraph(value.exact ? "Exact rational calculation in the real-number domain." : "Approximate real-number calculation; displayed to 12 significant digits, without an error bound."),
    ...input.mode === "calculate" ? [paragraph(`Input: ${input.expression}. Trigonometric angles: ${input.angles ?? "radians"}. log = base 10; ln = natural logarithm.`)] : [],
    ...value.steps.map((step) => ({ kind: "math", tex: step.tex, display: true, alt: step.alt })),
    paragraph("Computed by Math Studio 1.0.0 from the supplied mathematical input. Steps are algorithmic. No external sources or services were used.")
  ] });
}
function saved(data) {
  if (!data || data.engineVersion !== "1.0.0" || Object.keys(data).sort().join(",") !== "engineVersion,input") throw new Error("Unsupported stored calculation.");
  return data.input;
}
var stdin_default = (host) => ({
  async health() {
    return { status: "ready", dataVersion: 0 };
  },
  async invoke({ toolId, input }) {
    if (toolId !== "compute") throw new Error("Unknown mathematics tool.");
    const result = view(input, host.signal);
    return { artifacts: [{ artifactType: "math-calculation", artifactVersion: 1, summary: result.summary, data: { engineVersion: "1.0.0", input }, view: result }] };
  },
  async renderArtifact({ artifactType, artifactVersion, data }) {
    if (artifactType !== "math-calculation" || artifactVersion !== 1) throw new Error("Unsupported mathematics artifact.");
    return view(saved(data), host.signal);
  },
  async shutdown() {
  }
});
export {
  stdin_default as default
};
