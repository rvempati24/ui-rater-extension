import { UXFinding } from './types';

export function validateFindings(
  value: unknown,
  validEventSeq: Set<number>,
  validSnapshotIds: Set<string>
): { findings: UXFinding[]; rejected: Array<{ title?: string; reason: string }> } {
  const candidates = (value as { findings?: unknown[] })?.findings;
  if (!Array.isArray(candidates)) throw new Error('Model output does not contain findings[]');
  const findings: UXFinding[] = [];
  const rejected: Array<{ title?: string; reason: string }> = [];

  for (const candidate of candidates as UXFinding[]) {
    const eventIds = candidate.evidence?.event_seq || [];
    const snapshotIds = candidate.evidence?.snapshot_ids || [];
    if (eventIds.length + snapshotIds.length === 0) {
      rejected.push({ title: candidate.title, reason: 'No evidence references' });
    } else if (eventIds.some((id) => !validEventSeq.has(id))) {
      rejected.push({ title: candidate.title, reason: 'Unknown event sequence' });
    } else if (snapshotIds.some((id) => !validSnapshotIds.has(id))) {
      rejected.push({ title: candidate.title, reason: 'Unknown snapshot ID' });
    } else {
      findings.push(candidate);
    }
  }
  return { findings, rejected };
}
