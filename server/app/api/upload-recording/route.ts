import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { RECORDINGS_DIR } from '@/lib/paths';
import { saveAttemptRecording } from '@/lib/participant-store';

export async function POST(req: NextRequest) {
  const participantId = req.nextUrl.searchParams.get('participantId');
  const taskIndex = req.nextUrl.searchParams.get('taskIndex');
  const runId = req.nextUrl.searchParams.get('runId');
  const assignmentId = req.nextUrl.searchParams.get('assignmentId');
  const attemptId = req.nextUrl.searchParams.get('attemptId');

  if (!participantId || !taskIndex) {
    return NextResponse.json({ error: 'Missing participantId or taskIndex' }, { status: 400 });
  }

  const recordingsDir = RECORDINGS_DIR;
  await fs.mkdir(recordingsDir, { recursive: true });

  const filename = `${participantId}_task${taskIndex}.webm`;
  const filepath = path.join(recordingsDir, filename);

  const buffer = Buffer.from(await req.arrayBuffer());
  await fs.writeFile(filepath, buffer);

  if (runId && assignmentId && attemptId) {
    await saveAttemptRecording({ participantId, runId, assignmentId, attemptId, data: buffer });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(participantId) || !/^\d+$/.test(taskIndex)) {
    return NextResponse.json({ error: 'Invalid participantId or taskIndex' }, { status: 400 });
  }

  return NextResponse.json({ ok: true, filename, size: buffer.length, attemptId });
}
