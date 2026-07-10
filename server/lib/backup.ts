import path from 'path';
import fs from 'fs/promises';
import { uploadToDrive } from './gdrive';
import { RESULTS_PATH, BACKUPS_DIR } from './paths';

/**
 * Called once a participant submits their final comparison vote.
 * Saves a timestamped copy of data/results.json to data/backups/ and
 * uploads it to Google Drive (if credentials are configured).
 * This is a fire-and-forget call; errors are logged but never thrown.
 */
export async function backupOnCompletion(participantId: string): Promise<void> {
  try {
    await fs.mkdir(BACKUPS_DIR, { recursive: true });
    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `results_${participantId}_${ts}.json`;
    const dest     = path.join(BACKUPS_DIR, filename);
    await fs.copyFile(RESULTS_PATH, dest);
    console.log(`[backup] ${participantId} complete → ${dest}`);

    // Upload to Google Drive (fire-and-forget, won't affect the vote response)
    uploadToDrive(dest, filename).catch(err =>
      console.error('[backup] Google Drive upload failed:', err)
    );
  } catch (err) {
    console.error('[backup] Failed:', err);
  }
}
