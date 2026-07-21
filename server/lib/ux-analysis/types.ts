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
  schema_version: 2;
  session_id: string;
  participant_id?: string;
  run_id?: string;
  assignment_id?: string;
  attempt_id?: string;
  attempt_number?: number;
  app_id: string;
  task: string;
  site_url: string;
  duration_ms: number;
  original_event_count: number;
  supplied_event_count: number;
  trace: Array<Record<string, unknown>>;
  snapshots: SnapshotMetadata[];
  source: SourceContext;
  website_provenance?: Record<string, unknown>;
}

export interface UXFinding {
  title: string;
  ux_problem: string;
  observation: string;
  task_impact: string;
  severity: 'low' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  evidence: { event_seq: number[]; snapshot_ids: string[] };
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
