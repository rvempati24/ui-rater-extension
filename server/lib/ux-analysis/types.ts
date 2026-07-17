import { SnapshotMetadata } from '@/types';

export interface SourceFileInput {
  path: string;
  content: string;
  truncated: boolean;
}

export interface SourceContext {
  status: 'not_configured' | 'loaded';
  root_label?: string;
  files: SourceFileInput[];
  total_characters: number;
  truncated: boolean;
}

export interface AnalysisInput {
  schema_version: 1;
  session_id: string;
  app_id: string;
  task: string;
  site_url: string;
  duration_ms: number;
  original_event_count: number;
  supplied_event_count: number;
  trace: Array<Record<string, unknown>>;
  snapshots: SnapshotMetadata[];
  source: SourceContext;
}

export interface SourceCandidate {
  path: string;
  rationale: string;
}

export interface UXFinding {
  title: string;
  observation: string;
  inference: string;
  recommendation: string;
  severity: 1 | 2 | 3 | 4;
  confidence: number;
  evidence: { event_seq: number[]; snapshot_ids: string[] };
  source_candidates: SourceCandidate[];
}

export interface AnalysisResult {
  schema_version: 1;
  session_id: string;
  model: string;
  prompt_version: string;
  findings: UXFinding[];
  rejected: Array<{ title?: string; reason: string }>;
  source: {
    status: SourceContext['status'];
    file_count: number;
    total_characters: number;
    truncated: boolean;
  };
  usage: unknown;
  created_at: string;
}
