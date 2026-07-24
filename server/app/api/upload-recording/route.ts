import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { RECORDINGS_DIR } from '@/lib/paths';

export async function POST(req: NextRequest) {
  const participantId = req.nextUrl.searchParams.get('participantId');
  const taskIndex = req.nextUrl.searchParams.get('taskIndex');

  if (!participantId || !taskIndex) {
    return NextResponse.json({ error: 'Missing participantId or taskIndex' }, { status: 400 });
  }

  const recordingsDir = RECORDINGS_DIR;
  await fs.mkdir(recordingsDir, { recursive: true });

  const filename = `${participantId}_task${taskIndex}.webm`;
  const filepath = path.join(recordingsDir, filename);

  const buffer = Buffer.from(await req.arrayBuffer());
  await fs.writeFile(filepath, buffer);

  return NextResponse.json({ ok: true, filename, size: buffer.length });
}

// Serve a previously uploaded recording back to the annotation editor.
export async function GET(req: NextRequest) {
  const participantId = req.nextUrl.searchParams.get('participantId');
  const taskIndex = req.nextUrl.searchParams.get('taskIndex');

  if (!participantId || !taskIndex) {
    return NextResponse.json({ error: 'Missing participantId or taskIndex' }, { status: 400 });
  }
  // Guard against path traversal in the filename components.
  if (!/^[A-Za-z0-9_-]+$/.test(participantId) || !/^\d+$/.test(taskIndex)) {
    return NextResponse.json({ error: 'Invalid participantId or taskIndex' }, { status: 400 });
  }

  const filepath = path.join(RECORDINGS_DIR, `${participantId}_task${taskIndex}.webm`);

  try {
    const buffer = await fs.readFile(filepath);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'video/webm',
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'none',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  }
}
