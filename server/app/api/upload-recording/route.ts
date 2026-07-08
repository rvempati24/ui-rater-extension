import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';

export async function POST(req: NextRequest) {
  const participantId = req.nextUrl.searchParams.get('participantId');
  const taskIndex = req.nextUrl.searchParams.get('taskIndex');

  if (!participantId || !taskIndex) {
    return NextResponse.json({ error: 'Missing participantId or taskIndex' }, { status: 400 });
  }

  const recordingsDir = path.join(process.cwd(), '..', 'data', 'recordings');
  await fs.mkdir(recordingsDir, { recursive: true });

  const filename = `${participantId}_task${taskIndex}.webm`;
  const filepath = path.join(recordingsDir, filename);

  const buffer = Buffer.from(await req.arrayBuffer());
  await fs.writeFile(filepath, buffer);

  return NextResponse.json({ ok: true, filename, size: buffer.length });
}
