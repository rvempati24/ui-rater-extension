import fs from 'fs/promises';
import path from 'path';
import { AnalysisInput } from './types';
import { buildTextInput, FINDINGS_SCHEMA, SYSTEM_PROMPT } from './prompt';

export class ModelConfigurationError extends Error {}

function responseText(response: Record<string, unknown>): string {
  if (typeof response.output_text === 'string') return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'output_text' && typeof block.text === 'string') return block.text;
    }
  }
  throw new Error('Model response did not contain output text');
}

export async function requestFindings(input: AnalysisInput, sessionDir: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
  if (!apiKey) {
    throw new ModelConfigurationError(
      'analysis/input.json was created; set OPENAI_API_KEY to run the model'
    );
  }

  const userContent: Array<Record<string, unknown>> = [
    { type: 'input_text', text: buildTextInput(input) },
  ];
  for (const snapshot of input.snapshots) {
    const imagePath = path.resolve(sessionDir, snapshot.image_file);
    if (!imagePath.startsWith(`${path.resolve(sessionDir)}${path.sep}`)) {
      throw new Error('Snapshot path escaped the session directory');
    }
    const image = await fs.readFile(imagePath);
    userContent.push({
      type: 'input_text',
      text: `Snapshot ${snapshot.snapshot_id} at ${snapshot.ts} ms (${snapshot.reason}). Visible elements: ${JSON.stringify(snapshot.elements.slice(0, 20))}`,
    });
    userContent.push({
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${image.toString('base64')}`,
    });
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model,
      store: false,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: SYSTEM_PROMPT }] },
        { role: 'user', content: userContent },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'ux_findings',
          strict: true,
          schema: FINDINGS_SCHEMA,
        },
      },
      reasoning: { effort: 'low' },
      max_output_tokens: 4000,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
  }
  const responseJson = await response.json() as Record<string, unknown>;
  return {
    model,
    output: JSON.parse(responseText(responseJson)),
    usage: responseJson.usage || null,
  };
}
