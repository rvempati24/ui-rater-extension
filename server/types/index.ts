export type InteractionEventKind =
  | 'pageload' | 'click' | 'rightclick' | 'scroll' | 'mousemove'
  | 'input' | 'change' | 'keydown' | 'formsubmit' | 'copy' | 'paste'
  | 'focus' | 'resize' | 'navigate'
  // Compatibility with the existing side-by-side comparison UI.
  | 'expand' | 'collapse' | 'hover_start' | 'hover_end'
  | 'iframe_click' | 'iframe_scroll';

export interface InteractionEvent {
  kind: InteractionEventKind;
  seq?: number;
  side?: 'left' | 'right';
  ts: number;
  url?: string;
  x?: number;
  y?: number;
  tag?: string;
  text?: string;
  viewport_w?: number;
  viewport_h?: number;
  scroll_y?: number;
  scroll_pct?: number;
  is_fixed?: true;
  href?: string;
  field?: string;
  value?: string;
  key?: string;
  code?: string;
  inputType?: string;
  scrollX?: number;
  scrollY?: number;
  title?: string;
  method?: string;
  action?: string;
}

export interface Trial {
  index: number;
  slug: string;                        // full data depot slug
  group: string;                       // short group name (e.g. "gamestop")
  task_app: string;
  task_prompt: string;
  site_url?: string;
  plain_app: string;
  defect_app: string;
  defect_principle: string;
  defect_descriptions: string[];
  suggested_flows: string[];
  plain_side: 'left' | 'right';
  selected_side: 'left' | 'right' | null;
  is_correct: boolean | null;
  agrees_with_defect: boolean | null;
  completed: boolean;
  timestamp: string | null;
  view_start: string | null;
  duration_ms: number | null;
  interactions: InteractionEvent[];
  session_id?: string;
}

export interface SessionManifest {
  schema_version: 1;
  session_id: string;
  status: 'recording' | 'complete';
  participant_id?: string;
  trial_index?: number;
  app_id?: string;
  task_prompt?: string;
  site_url?: string;
  view_start?: string;
  duration_ms?: number;
  interaction_count?: number;
  snapshot_count?: number;
  completed_at?: string;
  attempt_id?: string;
  website?: WebsiteMetadata;
}

export interface WebsiteMetadata {
  schema_version: 1;
  source: 'local' | 'huggingface';
  repo_id?: string;
  revision?: string;
  commit_sha?: string;
  model: string;
  website: string;
  run_id: string;
  path_in_repo?: string;
  source_url?: string;
  source_dir?: string;
  task_file?: string;
  deployment_dir?: string;
  metadata_file?: string;
  existing_metadata_files?: string[];
  file_count?: number;
}

export interface SnapshotMetadata {
  snapshot_id: string;
  reason: string;
  ts: number;
  url?: string;
  title?: string;
  viewport?: { width: number; height: number };
  scroll?: { x: number; y: number };
  elements: Array<Record<string, unknown>>;
  image_file: string;
}

export interface AppEntry {
  name: string;
  group: string;
  staticPath: string;
  indexPath: string;
  screenshotPath: string | null;
  isDefect?: boolean;
  defectPrinciple?: string;
}

export interface TrialConfigEntry {
  slug: string;
  group: string;
  plain_app: string;
  task_prompt: string;
  site_url?: string;
  defects: { app: string; principle: string; defect_descriptions: string[] }[];
  suggested_flows: string[];
}

export interface ParticipantData {
  trials: Trial[];
}

export type ResultsStore = Record<string, ParticipantData>;
