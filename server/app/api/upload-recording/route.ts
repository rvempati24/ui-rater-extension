import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { RECORDINGS_DIR } from '@/lib/paths';
import { saveAttemptRecording } from '@/lib/participant-store';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function writeCompatibilityRecording(file: string, data: Buffer): Promise<void> {
  try {
    const existing = await fs.readFile(file);
    if (existing.equals(data)) return;
    throw new Error('Compatibility recording already exists with different content');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.writeFile(file, data, { flag: 'wx' });
}

export async function POST(req: NextRequest) {
  const participantId = req.nextUrl.searchParams.get('participantId');
  const taskIndex = req.nextUrl.searchParams.get('taskIndex');
  const runId = req.nextUrl.searchParams.get('runId');
  const assignmentId = req.nextUrl.searchParams.get('assignmentId');
  const attemptId = req.nextUrl.searchParams.get('attemptId');

  if (!participantId || !SAFE_ID.test(participantId) || !taskIndex || !/^\d+$/.test(taskIndex)) {
    return NextResponse.json({ error: 'Invalid participantId or taskIndex' }, { status: 400 });
  }
  const managedIds = [runId, assignmentId, attemptId];
  const hasManagedIds = managedIds.some(Boolean);
  if (hasManagedIds && !managedIds.every((value) => value && SAFE_ID.test(value))) {
    return NextResponse.json({ error: 'Invalid or incomplete run/assignment/attempt IDs' }, { status: 400 });
  }

  const buffer = Buffer.from(await req.arrayBuffer());
  if (buffer.length === 0) {
    return NextResponse.json({ error: 'Recording is empty' }, { status: 400 });
  }

  if (hasManagedIds) {
    await saveAttemptRecording({
      participantId, runId: runId!, assignmentId: assignmentId!, attemptId: attemptId!, data: buffer,
    });
  }

  await fs.mkdir(RECORDINGS_DIR, { recursive: true });
  const baseName = `${participantId}_task${taskIndex}.webm`;
  const basePath = path.join(RECORDINGS_DIR, baseName);
  let filename = baseName;
  try {
    await writeCompatibilityRecording(basePath, buffer);
  } catch (error: unknown) {
    if (!attemptId || !SAFE_ID.test(attemptId)) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : 'Recording already exists',
      }, { status: 409 });
    }
    filename = `${participantId}_task${taskIndex}_${attemptId}.webm`;
    await writeCompatibilityRecording(path.join(RECORDINGS_DIR, filename), buffer);
  }

  return NextResponse.json({ ok: true, filename, size: buffer.length, attemptId });
}
