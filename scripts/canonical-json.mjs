#!/usr/bin/env node
import { createHash } from 'node:crypto';

let input = '';
for await (const chunk of process.stdin) input += chunk;

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  throw new Error('Unsupported canonical JSON value');
}

const serialized = JSON.stringify(canonical(JSON.parse(input)));
const digest = `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
process.stdout.write(JSON.stringify({ canonical: serialized, digest }));
