// The receipt export: wraps the adapter's result in a versioned envelope and
// refuses to return anything the export contract does not allow. Read-only.
// It starts, stops, retries and stores nothing.
import {adaptTaskToReceipt} from './receipt-adapter.mjs';
import {RECEIPT_EXPORT_FORMAT,RECEIPT_EXPORT_VERSION,TIMEBASES,UNAVAILABLE_REASONS,validateReceiptExport} from './receipt-contract.mjs';

// Carried in every export so a reader sees the limits next to the data.
export const RECEIPT_LIMITS=Object.freeze([
  'Every value is a CydeWorks harness record. Nothing here is signed or independently verified, and the file can be edited after export.',
  'Identifiers are derived hashes. They can be correlated across exports, and a short instruction can be confirmed by guessing. This export is not anonymous.',
  'Model display labels are withheld because they may contain private paths or aliases.',
  'A null cost means unknown. Local execution, token counts and missing charges never mean zero cost.',
  'Token counts are reported by the engine or provider. Categories may overlap and must not be added together.',
  'Attempts appear in recorded order. No attempt is recorded as a retry of another.',
  'A succeeded attempt returned a proposal. Accepted is a recorded human decision. Structural checks are neither.',
]);

export function exportReceipt(task,{timebase='run-relative',charges}={}) {
  if(!TIMEBASES.includes(timebase))throw Object.assign(Error('Choose a supported receipt timebase.'),{status:400});
  const head={format:RECEIPT_EXPORT_FORMAT,formatVersion:RECEIPT_EXPORT_VERSION};
  const adapted=adaptTaskToReceipt(task,{timebase,charges});
  const envelope=adapted.available
    ?{...head,available:true,run:adapted.run,evidence:adapted.evidence,limits:[...RECEIPT_LIMITS]}
    :{...head,available:false,reasons:adapted.reasons,limits:[...RECEIPT_LIMITS]};
  if(validateReceiptExport(envelope).ok)return envelope;
  return {...head,available:false,reasons:[{code:'contract-violation',
    message:UNAVAILABLE_REASONS['contract-violation'],attemptIndexes:[]}],limits:[...RECEIPT_LIMITS]};
}
