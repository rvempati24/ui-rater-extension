import fs from 'fs/promises';
import path from 'path';

export async function requestLauncherShutdown(runId: string): Promise<boolean> {
  const file = process.env.UI_RATER_SHUTDOWN_FILE;
  if (!file) return false;
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({
    run_id: runId,
    completed_at: new Date().toISOString(),
  }));
  await fs.rename(temporary, target);
  return true;
}
