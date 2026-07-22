import path from 'path';
import { writeJsonAtomic } from './atomic-file.ts';

export async function requestLauncherShutdown(runId: string): Promise<boolean> {
  const file = process.env.UI_RATER_SHUTDOWN_FILE;
  if (!file) return false;
  const target = path.resolve(file);
  await writeJsonAtomic(target, {
    run_id: runId,
    completed_at: new Date().toISOString(),
  });
  return true;
}
