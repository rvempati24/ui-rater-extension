import path from 'node:path';
import crypto from 'node:crypto';
import { requestDigest, type StudySpecification } from '@ui-rater/contracts';
import type { StudyRecord } from '../domain/study.ts';
import { canTransitionStudy } from '../domain/study.ts';
import { ensureDir, readJson, writeJson } from './json-store.ts';
import { withLocks } from './lock.ts';

export class StudyStore {
  readonly dir: string;
  readonly receiptsDir: string;
  constructor(private readonly dataDir: string) {
    this.dir = path.join(dataDir, 'studies');
    this.receiptsDir = path.join(dataDir, 'study-receipts');
  }
  async init(): Promise<void> { await Promise.all([ensureDir(this.dir), ensureDir(this.receiptsDir)]); }
  async get(studyId: string): Promise<StudyRecord | undefined> { return readJson<StudyRecord>(path.join(this.dir, `${studyId}.json`)); }
  async getByKey(key: string): Promise<StudyRecord | undefined> {
    const receipt = await readJson<{ study_id: string; specification_digest: string }>(path.join(this.receiptsDir, `${encodeURIComponent(key)}.json`));
    return receipt ? this.get(receipt.study_id) : undefined;
  }
  async create(specification: StudySpecification, idempotencyKey: string): Promise<{ study: StudyRecord; created: boolean }> {
    return withLocks([`study-create-key:${idempotencyKey}`, `study:${specification.studyId}`], async () => {
      const digest = requestDigest(specification);
      const prior = await this.getByKey(idempotencyKey);
      if (prior) {
        if (prior.specification_digest !== digest) throw new Error('idempotency_key_reused');
        return { study: prior, created: false };
      }
      const now = new Date().toISOString();
      const study: StudyRecord = {
        schema_version: 1,
        study_id: specification.studyId,
        status: 'draft',
        specification,
        specification_digest: digest,
        created_at: now,
        updated_at: now,
      };
      const existing = await this.get(specification.studyId);
      if (existing) {
        if (existing.specification_digest !== digest) throw new Error('study_id_conflict');
        await writeJson(path.join(this.receiptsDir, `${encodeURIComponent(idempotencyKey)}.json`), { study_id: existing.study_id, specification_digest: digest });
        return { study: existing, created: false };
      }
      await writeJson(path.join(this.dir, `${specification.studyId}.json`), study);
      await writeJson(path.join(this.receiptsDir, `${encodeURIComponent(idempotencyKey)}.json`), { study_id: study.study_id, specification_digest: digest, created_at: now });
      return { study, created: true };
    });
  }
  async update(study: StudyRecord, patch: Partial<StudyRecord>): Promise<StudyRecord> {
    const current = await this.get(study.study_id);
    if (!current) throw new Error('study_not_found');
    if (patch.study_id && patch.study_id !== current.study_id) throw new Error('study_id_immutable');
    if (patch.specification_digest && patch.specification_digest !== current.specification_digest) throw new Error('study_specification_immutable');
    if (patch.status && !canTransitionStudy(current.status, patch.status)) {
      throw new Error(`invalid_study_transition:${current.status}:${patch.status}`);
    }
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    await writeJson(path.join(this.dir, `${study.study_id}.json`), next);
    return next;
  }
}
