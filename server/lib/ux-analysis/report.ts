import { UXFinding } from './types';

export function reportMarkdown(sessionId: string, findings: UXFinding[]): string {
  const lines = [`# UX findings for ${sessionId}`, ''];
  if (findings.length === 0) return `${lines.join('\n')}No evidence-grounded findings were returned.\n`;
  findings.forEach((finding, index) => {
    const sources = finding.source_candidates.length
      ? finding.source_candidates.map((source) => `${source.path} (${source.rationale})`).join('; ')
      : 'none';
    lines.push(
      `## ${index + 1}. ${finding.title}`,
      '',
      `- Observation: ${finding.observation}`,
      `- Inference: ${finding.inference}`,
      `- Severity: ${finding.severity}/4`,
      `- Confidence: ${finding.confidence}`,
      `- Evidence: events ${finding.evidence.event_seq.join(', ') || 'none'}; snapshots ${finding.evidence.snapshot_ids.join(', ') || 'none'}`,
      `- Source candidates: ${sources}`,
      `- Recommendation: ${finding.recommendation}`,
      ''
    );
  });
  return lines.join('\n');
}
