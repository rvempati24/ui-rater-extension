import type { StudySpecification, StudyStatus } from '@ui-rater/contracts';

export interface StudyRecord {
  schema_version: 1;
  study_id: string;
  status: StudyStatus;
  specification: StudySpecification;
  specification_digest: string;
  publication_operation_id?: string;
  retirement_operation_id?: string;
  study_revision_id?: string;
  created_at: string;
  updated_at: string;
}

export function canTransitionStudy(from: StudyStatus, to: StudyStatus): boolean {
  if (from === to) return true;
  return (from === 'draft' && to === 'publishing')
    || (from === 'publishing' && (to === 'ready' || to === 'draft'))
    || (from === 'ready' && to === 'retiring')
    || (from === 'retiring' && (to === 'ready' || to === 'retired'));
}
