import fs from 'fs/promises';
import path from 'path';
import { InteractionEvent } from '@/types';
import { loadSession } from '@/lib/sessions';
import { collectSourceContext } from './source-context';
import { AnalysisInput } from './types';

function selectTraceEvents(events: InteractionEvent[]): InteractionEvent[] {
  let mouseMoves = 0;
  const selected = events.filter((event) => {
    if (event.kind !== 'mousemove') return true;
    mouseMoves += 1;
    return mouseMoves % 20 === 1;
  });
  if (selected.length <= 500) return selected;
  return [...selected.slice(0, 250), ...selected.slice(-250)];
}

function compactEvent(event: InteractionEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    seq: event.seq,
    ts: event.ts,
    kind: event.kind,
    url: event.url,
    tag: event.tag,
    text: event.text,
    x: event.x,
    y: event.y,
    value: event.value,
    key: event.key,
    scrollX: event.scrollX,
    scrollY: event.scrollY,
  }).filter(([, value]) => value !== undefined && value !== ''));
}

export async function prepareAnalysisInput(sessionId: string) {
  const session = await loadSession(sessionId);
  const selectedEvents = selectTraceEvents(session.interactions);
  const analysisDir = path.join(session.dir, 'analysis');
  await fs.mkdir(analysisDir, { recursive: true });

  const input: AnalysisInput = {
    schema_version: 2,
    session_id: sessionId,
    participant_id: session.manifest.participant_id,
    run_id: session.manifest.run_id,
    assignment_id: session.manifest.assignment_id,
    attempt_id: session.manifest.attempt_id,
    attempt_number: session.manifest.attempt_number,
    app_id: session.manifest.app_id || '',
    task: session.manifest.task_prompt || '',
    site_url: session.manifest.site_url || '',
    duration_ms: session.manifest.duration_ms || 0,
    original_event_count: session.interactions.length,
    supplied_event_count: selectedEvents.length,
    trace: selectedEvents.map(compactEvent),
    snapshots: session.snapshots.slice(0, 12),
    source: await collectSourceContext(undefined, session.manifest.app_id || ''),
    website_provenance: session.manifest.website as unknown as Record<string, unknown> | undefined,
  };
  await fs.writeFile(path.join(analysisDir, 'input.json'), JSON.stringify(input, null, 2), 'utf8');
  return { analysisDir, input, session };
}
