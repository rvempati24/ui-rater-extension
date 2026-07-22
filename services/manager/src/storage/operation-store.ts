import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { PublicationOperationRecord } from '../domain/publication-operation.ts';
import { ensureDir, readJson, writeJson } from './json-store.ts';

export class OperationStore {
  readonly dir: string;
  constructor(private readonly dataDir: string) { this.dir = path.join(dataDir, 'publication-operations'); }
  async init(): Promise<void> { await ensureDir(this.dir); }
  async get(operationId: string): Promise<PublicationOperationRecord | undefined> { return readJson<PublicationOperationRecord>(path.join(this.dir, `${operationId}.json`)); }
  async list(): Promise<PublicationOperationRecord[]> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const records = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readJson<PublicationOperationRecord>(path.join(this.dir, name))));
    return records.filter((value): value is PublicationOperationRecord => Boolean(value));
  }
  operationIdFor(kind: PublicationOperationRecord['kind'], studyId: string): string {
    const digest = crypto.createHash('sha256').update(`${kind}:${studyId}`).digest('hex').slice(0, 32);
    return `pub_${kind}_${digest}`;
  }
  async create(
    input: Omit<PublicationOperationRecord, 'operation_id' | 'created_at' | 'updated_at'>,
    operationId = `pub_${crypto.randomUUID()}`,
  ): Promise<PublicationOperationRecord> {
    const existing = await this.get(operationId);
    if (existing) {
      if (existing.kind !== input.kind || existing.study_id !== input.study_id
        || existing.specification_digest !== input.specification_digest) {
        throw new Error('publication_operation_identity_conflict');
      }
      return existing;
    }
    const now = new Date().toISOString();
    const operation: PublicationOperationRecord = { ...input, operation_id: operationId, created_at: now, updated_at: now };
    await writeJson(path.join(this.dir, `${operation.operation_id}.json`), operation);
    return operation;
  }
  async update(operation: PublicationOperationRecord, patch: Partial<PublicationOperationRecord>): Promise<PublicationOperationRecord> {
    const next = { ...operation, ...patch, updated_at: new Date().toISOString() };
    await writeJson(path.join(this.dir, `${operation.operation_id}.json`), next);
    return next;
  }
}
