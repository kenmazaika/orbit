import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const fmtDate = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
export const fmtDateTime = (iso?: string | null) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

marked.setOptions({ gfm: true, breaks: false });

/**
 * The ONLY place untrusted Markdown becomes HTML.
 * Agent-authored content passes through here, including content stored before
 * this rule existed, so historic rows are protected too.
 */
const SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'srcset', 'formaction'],
  ALLOW_DATA_ATTR: false,
};

let hookInstalled = false;
function sanitize(html: string) {
  if (!hookInstalled && typeof window !== 'undefined') {
    DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
      if (node.tagName === 'A') {
        node.setAttribute('rel', 'noopener noreferrer nofollow');
        node.setAttribute('target', '_blank');
      }
    });
    hookInstalled = true;
  }
  return DOMPurify.sanitize(html, SANITIZE as any) as unknown as string;
}

export const sanitizeHtml = (html: string) => sanitize(String(html || ''));

export function Markdown({ body, className = 'prose' }: { body: string; className?: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(normalizeContent(body).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')) as string;
    return sanitize(raw);
  }, [body]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Some Work sources serialise content before handing it to the API:
 * JSON.stringify'd markdown, or a { text } wrapper. Unwrap at the presentation
 * boundary; the stored value is never modified.
 */
export function normalizeContent(raw: any): string {
  let s = String(raw ?? '');
  if (!s) return '';
  const trimmed = s.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || /\\n/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') s = parsed;
      else if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') s = parsed.text;
    } catch {
      if (/\\n/.test(trimmed) && !/\n/.test(trimmed)) s = trimmed.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
  }
  if (/^\s*\{/.test(s) && /"text"\s*:/.test(s)) {
    try { const parsed = JSON.parse(s); if (parsed && typeof parsed.text === 'string') s = parsed.text; } catch {}
  }
  return s;
}

/** Deterministic markdown to one-paragraph summary. No model, no regeneration. */
export function plainSummary(raw: any, max = 190): string {
  let s = normalizeContent(raw);
  if (!s) return '';
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.split(/\r?\n/).filter((l) => !/^\s{0,3}#{1,6}\s/.test(l)).join('\n');
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ')
       .replace(/^\s*[-+*]\s+/gm, '')
       .replace(/^\s*\d+\.\s+/gm, '')
       .replace(/^\s*>\s?/gm, '')
       .replace(/[*_~]{1,3}/g, '')
       .replace(/\s+/g, ' ')
       .trim();
  if (!s) return '';
  const first = s.match(/^.{40,}?[.!?](?=\s|$)/);
  let out = first ? first[0] : s;
  if (out.length > max) {
    const cut = out.slice(0, max);
    const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
    out = `${cut.slice(0, at > 60 ? at : max).trim()}…`;
  }
  return out;
}

export type ManualView = { title: string; why: string; url: string; steps: string[]; verify: string[] };

/** Interpret a structured manual-step payload generically (no per-tool special cases). */
export function readManual(payload: any, fallbackTitle = 'Manual step'): ManualView {
  const p = payload && typeof payload === 'object' ? payload : {};
  const str = (v: any) => (typeof v === 'string' ? v.trim() : '');
  const arr = (v: any): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : str(x?.text) || str(x?.label) || str(x?.title))).filter(Boolean) : [];
  return {
    title: str(p.title) || str(p.task) || str(p.name) || fallbackTitle,
    why: str(p.why) || str(p.reason) || str(p.explanation) || str(p.description) || str(p.context),
    url: str(p.url) || str(p.href) || str(p.link),
    steps: arr(p.steps || p.instructions || p.actions),
    verify: arr(p.verify || p.verification || p.acceptance || p.checks || p.expected),
  };
}

const SAVED_KEY = 'orbit:saved';
const SAVED_EVENT = 'orbit:saved-change';
const readSaved = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')); } catch { return new Set(); }
};

export function useSaved() {
  const [saved, setSaved] = React.useState<Set<string>>(readSaved);
  React.useEffect(() => {
    const sync = () => setSaved(readSaved());
    window.addEventListener('storage', sync);
    window.addEventListener(SAVED_EVENT, sync);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener(SAVED_EVENT, sync); };
  }, []);
  const toggle = (slug: string) => setSaved((prev) => {
    const next = new Set(prev);
    next.has(slug) ? next.delete(slug) : next.add(slug);
    try { localStorage.setItem(SAVED_KEY, JSON.stringify([...next])); } catch {}
    queueMicrotask(() => window.dispatchEvent(new Event(SAVED_EVENT)));
    return next;
  });
  return { saved, toggle };
}


export type DecisionView = { title: string; lines: { label: string; text: string }[]; steps: string[] };

/**
 * Generic reader for structured decision payloads. Keys are humanised; known
 * fields get editorial labels. Unknown shapes fall back to key/value pairs so
 * nothing needs a per-tool special case.
 */
export function readDecision(payload: any): DecisionView | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const str = (v: any) => (typeof v === 'string' ? v.trim() : '');
  const lines: { label: string; text: string }[] = [];
  const steps: string[] = Array.isArray(payload.steps)
    ? payload.steps.map((x: any) => (typeof x === 'string' ? x : str(x?.text) || str(x?.title))).filter(Boolean)
    : [];
  const seen = new Set<string>(['steps', 'next_action', 'action', 'recommendation']);
  const nextAction = str(payload.next_action) || str(payload.action) || str(payload.recommendation);
  if (nextAction) lines.push({ label: 'Proposed next step', text: nextAction });
  const order = ['question', 'prompt', 'summary', 'rationale', 'why', 'reason', 'context', 'note'];
  for (const k of order) {
    const v = str(payload[k]); if (!v) continue; seen.add(k);
    lines.push({ label: k === 'why' || k === 'reason' ? 'Why' : k === 'question' || k === 'prompt' ? 'Question' : k === 'summary' ? 'Summary' : k === 'context' ? 'Context' : k === 'note' ? 'Note' : 'Rationale', text: v });
  }
  for (const [k, v] of Object.entries(payload)) {
    if (seen.has(k) || typeof v !== 'string' || !v.trim()) continue;
    lines.push({ label: k.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), text: v.trim() });
  }
  if (!lines.length && !steps.length) return null;
  return { title: str(payload.title) || '', lines, steps };
}
