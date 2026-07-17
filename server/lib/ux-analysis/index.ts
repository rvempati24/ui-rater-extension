import fs from 'fs/promises';
import path from 'path';
import { prepareAnalysisInput as prepareInput } from './input';
import { requestFindings } from './openai';
import { reportMarkdown } from './report';
import { AnalysisResult } from './types';
import { validateFindings } from './validate';

export { ModelConfigurationError } from './openai';

export async function prepareAnalysisInput(sessionId: string) {
  const prepared = await prepareInput(sessionId);
  return {
    session_id: sessionId,
    input_file: path.join(prepared.analysisDir, 'input.json'),
    event_count: prepared.input.supplied_event_count,
    snapshot_count: prepared.input.snapshots.length,
    source_status: prepared.input.source.status,
    source_file_count: prepared.input.source.files.length,
    source_characters: prepared.input.source.total_characters,
    source_truncated: prepared.input.source.truncated,
  };
}

export async function analyzeSession(sessionId: string): Promise<AnalysisResult> {
  const { analysisDir, input, session } = await prepareInput(sessionId);
  const modelResponse = await requestFindings(input, session.dir);
  const validated = validateFindings(
    modelResponse.output,
    new Set(session.interactions.flatMap((event) => typeof event.seq === 'number' ? [event.seq] : [])),
    new Set(session.snapshots.map((snapshot) => snapshot.snapshot_id)),
    new Set(input.source.files.map((file) => file.path))
  );
  const result: AnalysisResult = {
    schema_version: 1,
    session_id: sessionId,
    model: modelResponse.model,
    prompt_version: 'source-aware-baseline-v1',
    findings: validated.findings,
    rejected: validated.rejected,
    source: {
      status: input.source.status,
      file_count: input.source.files.length,
      total_characters: input.source.total_characters,
      truncated: input.source.truncated,
    },
    usage: modelResponse.usage,
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(analysisDir, 'findings.json'), JSON.stringify(result, null, 2), 'utf8');
  await fs.writeFile(path.join(analysisDir, 'report.md'), reportMarkdown(sessionId, result.findings), 'utf8');
  return result;
}
