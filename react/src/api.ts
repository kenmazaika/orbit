export const API = '/api/v1';

export async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (!res.ok) {
    let body: any = null;
    try { body = await res.json(); } catch {}
    throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status, body });
  }
  return res.json();
}

export type Asset = {
  id: string; filename: string; mime: string; size: number; role: string;
  state: string; provider?: string | null; include_flag?: number; instruction?: string | null;
  created_at?: string;
};
export type Action = {
  id: string; article_id: string; kind?: string; workflow?: string | null; result_kind?: string;
  text?: string; status: string; reply?: string; error?: string | null; worker?: string;
  created_at?: string; claimed_at?: string | null; completed_at?: string | null;
  attempts?: number; max_attempts?: number; revision_id?: string | null; asset_id?: string | null;
};
export type Revision = { id: string; number: number; sha256?: string; source?: string; created_at: string };
export type ReviewFinding = { id: string; category?: string; summary?: string; explanation?: string; anchors?: any[] };
export type Review = {
  id: string; workflow?: string; targetRevisionId?: string; targetRevisionNumber?: number;
  findingCount?: number; summary?: string; findings?: ReviewFinding[]; notes?: Record<string, string>;
  overallNote?: string; createdAt?: string;
};
export type ArtifactState = {
  article: { id: string; title: string; canonical_path?: string; created_at?: string; closed_at?: string | null };
  currentRevisionId: string; currentNumber: number; revisions: Revision[];
  events: { id: string; role: string; text: string; created_at: string }[];
  activeRequest?: Action | null; lastRequest?: Action | null;
  reviews: Review[]; workflowResultKinds: Record<string, string>;
  masthead?: Asset | null; mastheadCandidates?: Asset[]; publication?: any;
  images: Asset[];
};
export type ArtifactRow = {
  id: string; title: string; current_number?: number; updated_at?: string; closed_at?: string | null;
};
export type InboxItem = {
  id: string; orbit_id: string; type: 'message' | 'decision'; title: string; body: string;
  summary?: string; choices: any[]; actions: any[]; instruction?: string | null;
  selections?: any[]; selected_instruction?: string; status: string; folder?: string; outbox?: boolean;
  created_at?: string; submitted_at?: string | null; processed_at?: string | null;
};
export type ContentNote = {
  slug: string; title: string; description?: string; category: string; pubDate: string;
  body: string; minutes: number;
};
export type ContentReport = ContentNote & { summary?: string };
