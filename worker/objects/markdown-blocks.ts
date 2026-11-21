// Line-level anchoring for review findings.
//
// A finding points at a *source span* in the immutable markdown revision: a start
// line, an end line, and the verbatim quote. Every span is validated against the
// revision — model-supplied line numbers are a hint, never trusted blindly, and a
// quote that is not present is left unresolved instead of being attached to the
// nearest paragraph.
//
// The same block splitter runs in the browser (src/pages/artifacts/[slug].astro).

/** Collapse whitespace and unify curly quotes so a quote matches its source. */
export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split markdown into blocks on blank lines, keeping fenced code blocks whole. */
export function splitBlocks(markdown: unknown): string[] {
  return blockSpans(markdown).map((b) => b.text);
}

export type BlockSpan = { index: number; text: string; startLine: number; endLine: number };

/** Blocks with their 1-based source line ranges. */
export function blockSpans(markdown: unknown): BlockSpan[] {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: BlockSpan[] = [];
  let buf: string[] = [];
  let start = 1;
  let inFence = false;
  const flush = (endLine: number) => {
    const text = buf.join('\n').trim();
    if (text) out.push({ index: out.length, text, startLine: start, endLine });
    buf = [];
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence && !buf.length) start = n;
      inFence = !inFence;
      buf.push(line);
      return;
    }
    if (!inFence && /^\s*$/.test(line)) {
      flush(n - 1);
      start = n + 1;
      return;
    }
    if (!buf.length) start = n;
    buf.push(line);
  });
  flush(lines.length);
  return out;
}

/** First body line (1-based) after YAML frontmatter; 1 when there is none. */
export function bodyStartLine(markdown: unknown): number {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return 1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') return i + 2;
  return 1;
}

type DocIndex = { norm: string; lineOf: number[]; lines: string[] };

/** Normalized document plus a char → source-line map, so a quote can span lines. */
function buildIndex(markdown: unknown): DocIndex {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let norm = '';
  const lineOf: number[] = [];
  lines.forEach((raw, i) => {
    const n = normalizeText(raw);
    for (const ch of n) { norm += ch; lineOf.push(i + 1); }
    norm += ' ';
    lineOf.push(i + 1);
  });
  return { norm, lineOf, lines: lines.map(normalizeText) };
}

function occurrences(doc: DocIndex, needle: string) {
  const hits: { startLine: number; endLine: number }[] = [];
  if (!needle) return hits;
  let at = doc.norm.indexOf(needle);
  while (at >= 0) {
    const startLine = doc.lineOf[at];
    const endLine = doc.lineOf[Math.min(at + needle.length - 1, doc.lineOf.length - 1)];
    hits.push({ startLine, endLine });
    at = doc.norm.indexOf(needle, at + Math.max(1, needle.length));
  }
  return hits;
}

function nearestHeading(doc: DocIndex, line: number): string | null {
  for (let i = Math.min(line - 1, doc.lines.length - 1); i >= 0; i--) {
    const m = doc.lines[i].match(/^#{1,6}\s+(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

export type FindingAnchor = {
  role?: 'primary' | 'supporting';
  exact: string;
  heading?: string | null;
  startLine?: number;
  endLine?: number;
  blockIndex?: number;
  resolved?: boolean;
  ambiguous?: boolean;
  matchedLine?: number;
};

export type Finding = {
  id: string;
  category: string;
  summary: string;
  explanation?: string;
  anchors?: FindingAnchor[];
  unanchored?: boolean;
  order?: number;
};

const MAX_FINDINGS = 50;
const MAX_ANCHORS = 10;

/**
 * Validate every finding against one immutable revision.
 *
 * Resolution order for an anchor:
 *   1. the model's startLine/endLine, if the quote is actually there;
 *   2. a unique exact occurrence elsewhere in the document;
 *   3. among several exact occurrences, the one matching the supplied heading,
 *      then the one nearest the supplied line, then the stated occurrence.
 * A quote with no exact occurrence stays `resolved: false` — it is shown in the
 * "not anchored" section, never attached to a nearby paragraph.
 */
export function anchorFindings(markdown: unknown, rawFindings: unknown): Finding[] {
  const doc = buildIndex(markdown);
  // The page renders only the body (frontmatter is parsed separately), so block
  // indices must be body-relative or every callout lands on the wrong block.
  const bodyStart = bodyStartLine(markdown);
  const spans = blockSpans(markdown)
    .filter((b) => b.endLine >= bodyStart)
    .map((b, i) => ({ ...b, index: i }));
  const list = Array.isArray(rawFindings) ? rawFindings.slice(0, MAX_FINDINGS) : [];
  const seen = new Set<string>();
  const out: Finding[] = [];

  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const f: any = raw;
    const category = String(f.category ?? '').trim().slice(0, 120);
    const summary = String(f.summary ?? '').trim().slice(0, 600);
    if (!category || !summary) return;
    let id = String(f.id ?? '').trim().slice(0, 64) || `finding-${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);

    const anchorsRaw: any[] = Array.isArray(f.anchors) ? f.anchors.slice(0, MAX_ANCHORS) : [];
    const anchors: FindingAnchor[] = [];
    anchorsRaw.forEach((a, ai) => {
      if (!a || typeof a !== 'object') return;
      const exact = String(a.exact ?? '').trim().slice(0, 2000);
      if (!exact) return;
      const needle = normalizeText(exact);
      const hits = occurrences(doc, needle);
      const hintedStart = Number.isFinite(Number(a.startLine)) ? Number(a.startLine) : null;
      const hintedEnd = Number.isFinite(Number(a.endLine)) ? Number(a.endLine) : null;
      const heading = a.heading ? String(a.heading).slice(0, 200) : null;

      let pick = null as null | { startLine: number; endLine: number };
      let ambiguous = false;

      if (hits.length) {
        const atHint = hintedStart
          ? hits.find((h) => h.startLine <= hintedStart + 1 && h.endLine >= hintedStart - 1)
          : null;
        if (atHint) pick = atHint;
        else if (hits.length === 1) pick = hits[0];
        else {
          ambiguous = true;
          const byHeading = heading
            ? hits.find((h) => normalizeText(nearestHeading(doc, h.startLine) || '') === normalizeText(heading))
            : null;
          if (byHeading) { pick = byHeading; ambiguous = false; }
          else if (hintedStart) {
            pick = hits.reduce((best, h) =>
              Math.abs(h.startLine - hintedStart) < Math.abs(best.startLine - hintedStart) ? h : best, hits[0]);
          } else if (Number.isFinite(Number(a.occurrence)) && hits[Number(a.occurrence)]) {
            pick = hits[Number(a.occurrence)];
            ambiguous = false;
          } else {
            pick = hits[0];
          }
        }
      }

      const blockIndex = pick
        ? spans.findIndex((b) => b.startLine <= pick!.startLine && b.endLine >= pick!.startLine)
        : -1;

      anchors.push({
        role: a.role === 'supporting' ? 'supporting' : (ai === 0 ? 'primary' : 'supporting'),
        exact,
        heading: heading ?? (pick ? nearestHeading(doc, pick.startLine) : null),
        startLine: pick ? pick.startLine : (hintedStart ?? undefined),
        endLine: pick ? pick.endLine : (hintedEnd ?? undefined),
        blockIndex,
        resolved: Boolean(pick) && blockIndex >= 0,
        ambiguous,
        matchedLine: pick ? pick.startLine : undefined,
      });
    });

    // Document order, not the critic's importance ranking, drives inline numbering.
    const primary = anchors.find((a) => a.resolved && a.role === 'primary')
      || anchors.find((a) => a.resolved);
    out.push({
      id, category, summary,
      explanation: f.explanation ? String(f.explanation).slice(0, 4000) : '',
      anchors,
      unanchored: !primary,
      order: primary ? (primary.startLine || 0) : Number.MAX_SAFE_INTEGER,
    });
  });

  return out.sort((a, b) => (a.order! - b.order!) || a.id.localeCompare(b.id));
}
