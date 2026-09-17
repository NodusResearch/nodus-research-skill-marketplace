// The structure validator, run as a killable subworker.
//
// This is where RDKit and OpenChemLib actually load. They are the slowest and least
// bounded part of the package, so they live one process away from it: a validation that
// hangs on a pathological molecule is terminated by the host and costs one drawing.
import { validateChemicalReferences } from './engine/chemistryValidationCore';
import { auditRoute, type RouteAuditInput } from './engine/chemistryRouteAudit';
import type { ChemistryInspectionResult, ChemistryValidationRequest } from './engine/chemistryDocument';

// Electron's utility-process port is not part of @types/node.
declare const process: NodeJS.Process & { parentPort?: { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(value: unknown): void } };

process.parentPort?.on('message', event => {
  const data = event.data as ChemistryValidationRequest & { batch?: string[]; route?: RouteAuditInput };
  // A batch is the read-only inspector: parse many SMILES in one process, and report a
  // species that cannot be parsed as its own error instead of failing the batch.
  if (Array.isArray(data?.batch)) {
    void (async () => {
      const results: ChemistryInspectionResult[] = [];
      for (const smiles of data.batch!) {
        try {
          const checked = await validateChemicalReferences({ references: [smiles], inspect: true });
          results.push({ smiles, ok: true, graph: checked.graph });
        } catch (error) {
          results.push({ smiles, ok: false, error: error instanceof Error ? error.message : 'Chemical validation failed.' });
        }
      }
      return { results };
    })().then(
      result => process.parentPort?.postMessage({ result }),
      error => process.parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Chemical validation failed.' }),
    );
    return;
  }
  // A route is the read-only checker: every step is parsed and every equation and
  // intermediate link is checked here, in the same killable process as a drawing.
  if (data?.route && Array.isArray(data.route.steps)) {
    void auditRoute(data.route).then(
      audit => process.parentPort?.postMessage({ result: audit }),
      error => process.parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Chemical validation failed.' }),
    );
    return;
  }
  void validateChemicalReferences(data).then(
    result => process.parentPort?.postMessage({ result }),
    error => process.parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Chemical validation failed.' }),
  );
});
