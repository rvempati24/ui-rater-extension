import fs from 'fs/promises';
import path from 'path';
import type { SourceContext, SourceFileInput } from './types';

const MAX_FILES = 50;
const MAX_TOTAL_CHARACTERS = 160_000;
const MAX_FILE_CHARACTERS = 50_000;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.json']);
const ROOT_FILES = new Set([
  'index.html', 'package.json', 'vite.config.js', 'vite.config.ts',
  'next.config.js', 'next.config.mjs', 'next.config.ts',
]);
const SKIP_DIRECTORIES = new Set(['.git', '.next', 'coverage', 'dist', 'node_modules']);

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isSourceFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const basename = path.basename(normalized);
  if (normalized.startsWith('src/')) return SOURCE_EXTENSIONS.has(path.extname(basename));
  return !normalized.includes('/') && ROOT_FILES.has(basename);
}

async function walk(root: string, current: string, output: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await walk(root, absolute, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(root, absolute);
    if (isSourceFile(relative)) output.push(absolute);
  }
}

export async function collectSourceContext(
  configuredRoot = process.env.UI_RATER_WEBSITE_SOURCE_DIR,
  expectedAppId = '',
  configuredRunId = process.env.UI_RATER_WEBSITE_RUN_ID || ''
): Promise<SourceContext> {
  if (!configuredRoot) {
    return { status: 'not_configured', files: [], total_characters: 0, truncated: false };
  }

  const root = await fs.realpath(path.resolve(configuredRoot));
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error('UI_RATER_WEBSITE_SOURCE_DIR is not a directory');
  if (expectedAppId && path.basename(root) !== expectedAppId && configuredRunId !== expectedAppId) {
    throw new Error(
      `Configured website source "${path.basename(root)}" does not match session app "${expectedAppId}"`
    );
  }

  const candidates: string[] = [];
  await walk(root, root, candidates);
  const files: SourceFileInput[] = [];
  let totalCharacters = 0;
  let truncated = false;

  for (const candidate of candidates) {
    if (files.length >= MAX_FILES || totalCharacters >= MAX_TOTAL_CHARACTERS) {
      truncated = true;
      break;
    }
    const resolved = await fs.realpath(candidate);
    if (!isWithinRoot(root, resolved)) continue;
    const raw = await fs.readFile(resolved, 'utf8');
    if (raw.includes('\0')) continue;

    const remaining = MAX_TOTAL_CHARACTERS - totalCharacters;
    const limit = Math.min(MAX_FILE_CHARACTERS, remaining);
    const content = raw.slice(0, limit);
    const fileTruncated = content.length < raw.length;
    files.push({
      path: path.relative(root, resolved).replaceAll('\\', '/'),
      content,
      truncated: fileTruncated,
    });
    totalCharacters += content.length;
    truncated ||= fileTruncated;
  }

  return {
    status: 'loaded',
    root_label: path.basename(root),
    files,
    total_characters: totalCharacters,
    truncated,
  };
}
