import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { BACKUPS_DIR } from '@/lib/paths';
import { requireLocalAdmin } from '@/lib/admin-auth';

export async function GET(req: NextRequest) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  try {
    const files = await fs.readdir(BACKUPS_DIR);
    const details = await Promise.all(
      files.map(async (f) => {
        const stat = await fs.stat(path.join(BACKUPS_DIR, f));
        return { file: f, size: stat.size, created: stat.birthtime };
      })
    );
    return NextResponse.json({ count: files.length, backups: details });
  } catch (err: unknown) {
    const isNoDir = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return NextResponse.json({
      count: 0,
      backups: [],
      note: isNoDir ? 'No backups yet — created when a participant completes all trials' : String(err),
    });
  }
}
