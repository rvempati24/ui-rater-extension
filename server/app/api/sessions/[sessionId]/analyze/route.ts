import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import {
  analyzeSession,
  ModelConfigurationError,
  prepareAnalysisInput,
} from '@/lib/ux-analysis';
import { getSessionDir } from '@/lib/sessions';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  try {
    if (req.nextUrl.searchParams.get('prepareOnly') === '1') {
      return NextResponse.json(await prepareAnalysisInput(sessionId));
    }
    return NextResponse.json(await analyzeSession(sessionId));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Analysis failed';
    const status = error instanceof ModelConfigurationError ? 503 : 400;
    return NextResponse.json({ error: message, sessionId }, { status });
  }
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;
    const raw = await fs.readFile(path.join(getSessionDir(sessionId), 'analysis', 'findings.json'), 'utf8');
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: 'Analysis has not completed' }, { status: 404 });
  }
}
