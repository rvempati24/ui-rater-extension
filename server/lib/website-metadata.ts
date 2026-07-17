import fs from 'fs/promises';
import { WebsiteMetadata } from '@/types';

export async function getActiveWebsiteMetadata(): Promise<WebsiteMetadata | undefined> {
  const file = process.env.UI_RATER_WEBSITE_METADATA_FILE;
  if (!file) return undefined;
  try {
    const portable = JSON.parse(await fs.readFile(file, 'utf8')) as WebsiteMetadata;
    delete portable.source_dir;
    delete portable.task_file;
    delete portable.deployment_dir;
    delete portable.metadata_file;
    return portable;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
