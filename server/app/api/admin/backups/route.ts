import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const BACKUPS_DIR = path.join(process.cwd(), 'data', 'backups');

export async function GET() {
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
