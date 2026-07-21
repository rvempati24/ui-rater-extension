import { UXFinding } from './types';

export function reportMarkdown(sessionId: string, findings: UXFinding[]): string {
  const lines = [`# UX findings for ${sessionId}`, ''];
  if (findings.length === 0) return `${lines.join('\n')}No evidence-grounded findings were returned.\n`;
  findings.forEach((finding, index) => {
    lines.push(
      `## ${index + 1}. ${finding.title}`,
      '',
      `- UX problem: ${finding.ux_problem}`,
      `- Observation: ${finding.observation}`,
      `- Task impact: ${finding.task_impact}`,
      `- Severity: ${finding.severity}`,
      `- Confidence: ${finding.confidence}`,
      `- Evidence: events ${finding.evidence.event_seq.join(', ') || 'none'}; snapshots ${finding.evidence.snapshot_ids.join(', ') || 'none'}`,
      ''
    );
  });
  return lines.join('\n');
}
