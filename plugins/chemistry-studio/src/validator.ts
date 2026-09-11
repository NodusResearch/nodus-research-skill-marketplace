// The structure validator, run as a killable subworker.
//
// This is where RDKit and OpenChemLib actually load. They are the slowest and least
// bounded part of the package, so they live one process away from it: a validation that
// hangs on a pathological molecule is terminated by the host and costs one drawing.
import { validateChemicalReferences } from './engine/chemistryValidationCore';
import type { ChemistryValidationRequest } from './engine/chemistryDocument';

// Electron's utility-process port is not part of @types/node.
declare const process: NodeJS.Process & { parentPort?: { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(value: unknown): void } };

process.parentPort?.on('message', event => {
  void validateChemicalReferences(event.data as ChemistryValidationRequest).then(
    result => process.parentPort?.postMessage({ result }),
    error => process.parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Chemical validation failed.' }),
  );
});
