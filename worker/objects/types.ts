// Shared domain constants and validation for the Orbit object model.

export const DEFAULT_WORKSPACE = Object.freeze({ id: 'ws_ken', slug: 'ken', name: 'Ken' });

export const KINDS = Object.freeze({
  artifact: 'orbit.artifact',
  feedback: 'orbit.feedback',
  message: 'orbit.message',
  inbox: 'orbit.inbox',
  decision: 'orbit.decision',
  dispatch: 'orbit.dispatch',
  dispatchFeedback: 'orbit.dispatch_feedback',
  review: 'orbit.review',
  result: 'orbit.result',
  publication: 'orbit.publication',
});

// What a workflow is expected to produce. The declaration fixes the output
// contract (what the bridge must post, what the UI may show); the persisted
// result is what actually decides the presentation.
export const RESULT_KINDS = Object.freeze(['review', 'revision', 'asset', 'publication', 'other']);

export const WORKFLOW_DEFINITIONS = Object.freeze([
  // Blog author first: it is the default selection in the composer.
  { id: 'blog-author', label: 'Blog author', resultKind: 'revision' },
  { id: 'blog-critic', label: 'Blog critic', resultKind: 'review' },
  { id: 'seo-retrofit', label: 'SEO retrofit', resultKind: 'revision' },
  { id: 'signup-retrofit', label: 'Sign-up retrofit', resultKind: 'revision' },
  {
    id: 'generate-masthead', label: 'Generate masthead', resultKind: 'asset',
    options: [
      { key: 'approach', label: 'Approach', type: 'select', values: ['new', 'reference'], default: 'new' },
      { key: 'referenceAssetId', label: 'Reference image', type: 'asset', dependsOn: 'approach=reference' },
      { key: 'provider', label: 'Generator', type: 'select', values: ['grok', 'openai'], default: 'grok' },
    ],
  },
  {
    id: 'publish-post', label: 'Publish blog post', resultKind: 'publication',
    options: [
      { key: 'destination', label: 'Destination', type: 'select', values: ['notes-from-the-loop'], default: 'notes-from-the-loop' },
      { key: 'updateIfPublished', label: 'Update existing post', type: 'boolean', default: true },
    ],
  },
]);

export const DEFAULT_WORKFLOW = 'blog-author';

export function workflowDefinition(id) {
  return WORKFLOW_DEFINITIONS.find((w) => w.id === id) || null;
}

export function workflowResultKind(id: string | null | undefined) {
  return workflowDefinition(id)?.resultKind || null;
}

export const ACTION_STATUS = Object.freeze([
  'pending', 'claimed', 'working', 'needs_input', 'completed', 'failed', 'stale', 'cancelled',
]);

// Legacy poc_requests.status -> object action status.
export const LEGACY_ACTION_STATUS = Object.freeze({
  submitted: 'pending',
  working: 'claimed',
  needs_input: 'needs_input',
  completed: 'completed',
  failed: 'failed',
  stale: 'stale',
});

// Object action status -> legacy status (for export-before-rollback).
export const ACTION_TO_LEGACY = Object.freeze({
  pending: 'submitted',
  claimed: 'working',
  working: 'working',
  needs_input: 'needs_input',
  completed: 'completed',
  failed: 'failed',
  stale: 'stale',
  cancelled: 'failed',
});

export const WORKFLOWS = Object.freeze(WORKFLOW_DEFINITIONS.map((w) => w.id));
export const MAX_TEXT = 20_000;
export const MAX_IMAGE_BYTES = 2_500_000;
export const IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Claim lease. Kept short so a crashed bridge is reclaimed quickly; the worker
// renews it every HEARTBEAT_MS while the agent runs (4x safety margin).
export const LEASE_MS = 120_000;
export const HEARTBEAT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

export function isKind(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_-]*)+$/.test(value);
}

export function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export function clampText(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  return crypto.randomUUID();
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function json(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// shared upstream sync probe 2026-11-21

// public sync probe 2026-11-21T18:35Z
