import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { PARTICIPANTS_PATH } from '@/lib/paths';

const INIT_PATH = path.join('/app', 'data-init', 'participants.json');
const TMP_PATH  = PARTICIPANTS_PATH + '.tmp';

export async function POST() {
  try {
    const content = await fs.readFile(INIT_PATH, 'utf-8');
    await fs.writeFile(TMP_PATH, content, 'utf-8');
    await fs.rename(TMP_PATH, PARTICIPANTS_PATH);
    const participants = JSON.parse(content);
    return NextResponse.json({ ok: true, count: participants.length, participants });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
