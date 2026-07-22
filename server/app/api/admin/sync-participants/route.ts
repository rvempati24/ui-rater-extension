import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { PARTICIPANTS_PATH } from '@/lib/paths';
import { requireLocalAdmin } from '@/lib/admin-auth';
import { writeFileAtomic } from '@/lib/atomic-file';
import { withFileLock } from '@/lib/file-lock';

const INIT_PATH = path.join('/app', 'data-init', 'participants.json');

export async function POST(req: NextRequest) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  try {
    const content = await fs.readFile(INIT_PATH, 'utf-8');
    const participants = JSON.parse(content);
    await withFileLock('legacy-participant-allowlist', () =>
      writeFileAtomic(PARTICIPANTS_PATH, content, 'utf8')
    );
    return NextResponse.json({ ok: true, count: participants.length, participants });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
