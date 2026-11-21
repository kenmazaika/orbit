import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './d1-shim.mjs';
import {
  userPrincipal, ensureWorkspace, createObject, createRevision, submitFeedback,
  publishReview, setFindingNote, getReview,
} from '../../worker/objects/service.ts';
import { anchorFindings, blockSpans } from '../../worker/objects/markdown-blocks.ts';
import { KINDS } from '../../worker/objects/types.ts';

const principal = { kind: 'agent', id: 'openclaw', workspaceId: 'ws_ken', scopes: ['agent', 'artifacts'] };

// Three genuinely independent instances of the same problem, in three sections.
const SYNTHETIC = `---
title: Synthetic
---

# One

The first point is that small habits compound. Small habits compound, which is why they matter. That is the whole lesson of this section about compounding.

# Two

The second point is also about compounding, and it says that small habits compound over time. This section restates it because the first section did not land.

# Three

Finally, the third section repeats that habits compound. It adds no new mechanism, only the sentence again: small habits compound.
`;

const find = (id, exact, line, extra = {}) => ({
  id, category: 'Belaboring / restatement', summary: `restatement ${id}`,
  explanation: 'The beat is made twice in the same passage.',
  anchors: [{ role: 'primary', startLine: line, endLine: line, exact, ...extra }],
});

test('three independent instances of one category stay three findings', () => {
  const findings = anchorFindings(SYNTHETIC, [
    find('finding-1', 'Small habits compound, which is why they matter.', 7),
    find('finding-2', 'This section restates it because the first section did not land.', 11),
    find('finding-3', 'It adds no new mechanism, only the sentence again: small habits compound.', 15),
  ]);
  assert.equal(findings.length, 3);
  assert.deepEqual(findings.map((f) => f.id).sort(), ['finding-1', 'finding-2', 'finding-3']);
  assert.equal(new Set(findings.map((f) => f.category)).size, 1, 'same category');
  assert.equal(new Set(findings.map((f) => f.anchors[0].startLine)).size, 3, 'three distinct lines');
  assert.ok(findings.every((f) => f.anchors[0].resolved));
  // Document order drives order, not the order supplied.
  assert.deepEqual(findings.map((f) => f.order), [7, 11, 15]);
});

test('two findings in one paragraph keep separate ids and the same block', () => {
  const md = '# H\n\nFirst problem lives here. A second, unrelated problem lives here too.\n';
  const findings = anchorFindings(md, [
    { id: 'a', category: 'Generic polish', summary: 's', anchors: [{ exact: 'First problem lives here.' }] },
    { id: 'b', category: 'Unverified specifics', summary: 's', anchors: [{ exact: 'A second, unrelated problem lives here too.' }] },
  ]);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].anchors[0].blockIndex, findings[1].anchors[0].blockIndex);
  assert.notEqual(findings[0].id, findings[1].id);
});

test('repeated identical quotations resolve to their own line, not the first one', () => {
  const md = 'Line one repeats.\n\nMiddle.\n\nLine one repeats.\n';
  const findings = anchorFindings(md, [
    { id: 'first', category: 'Belaboring / restatement', summary: 's', anchors: [{ exact: 'Line one repeats.', startLine: 1, endLine: 1 }] },
    { id: 'second', category: 'Belaboring / restatement', summary: 's', anchors: [{ exact: 'Line one repeats.', startLine: 5, endLine: 5 }] },
  ]);
  assert.equal(findings.length, 2);
  const lines = findings.map((f) => f.anchors[0].matchedLine).sort((a, b) => a - b);
  assert.deepEqual(lines, [1, 5]);
  assert.notEqual(findings[0].anchors[0].blockIndex, findings[1].anchors[0].blockIndex);
});

test('a relational finding keeps both locations and one id', () => {
  const md = '# A\n\nClaim one appears here.\n\n# B\n\nClaim one appears here.\n';
  const [f] = anchorFindings(md, [{
    id: 'rel', category: 'Belaboring / restatement', summary: 'the same claim twice',
    anchors: [
      { role: 'primary', exact: 'Claim one appears here.', startLine: 3, endLine: 3 },
      { role: 'supporting', exact: 'Claim one appears here.', startLine: 7, endLine: 7 },
    ],
  }]);
  assert.equal(f.anchors.length, 2);
  assert.equal(f.anchors[0].role, 'primary');
  assert.equal(f.anchors[1].role, 'supporting');
  assert.deepEqual(f.anchors.map((a) => a.matchedLine), [3, 7]);
});

test('block indices are body-relative, matching what the page renders', () => {
  const md = '---\ntitle: T\ntags: a\n---\n\n# Heading\n\nBody paragraph.\n';
  const [f] = anchorFindings(md, [{ id: 'x', category: 'Generic polish', summary: 's', anchors: [{ exact: 'Body paragraph.' }] }]);
  assert.equal(f.anchors[0].resolved, true);
  // Body blocks: [# Heading, Body paragraph.] -> index 1, not 2 (frontmatter is block 0).
  assert.equal(f.anchors[0].blockIndex, 1);
  assert.equal(blockSpans(md).length, 3);
});

test('an unmatched quote stays unanchored instead of snapping to a nearby paragraph', () => {
  const md = '# H\n\nThis paragraph is real.\n\n```js\nconst x = 1;\n```\n';
  const [f] = anchorFindings(md, [{
    id: 'ghost', category: 'Missing orientation', summary: 's',
    anchors: [{ exact: 'A sentence that was never written.', startLine: 3, endLine: 3 }],
  }]);
  assert.equal(f.anchors[0].resolved, false);
  assert.equal(f.anchors[0].blockIndex, -1);
  assert.equal(f.unanchored, true);
});

test('notes and provenance stay separate for same-category findings', async () => {
  const db = makeDb();
  await ensureWorkspace(db);
  const obj = await createObject(db, principal, {
    kind: KINDS.artifact, externalId: 'synth', title: 'Synth', data: {},
  });
  await createRevision(db, principal, obj.id, { content: SYNTHETIC, source: 'seed', id: 'rev_synth' });
  const published = await publishReview(db, principal, 'synth', {
    revisionId: 'rev_synth', workflow: 'blog-critic', summary: 'three restatements',
    findings: [
      find('finding-1', 'Small habits compound, which is why they matter.', 7),
      find('finding-2', 'This section restates it because the first section did not land.', 11),
    ],
  });
  const reviewId = published.review.id;
  await setFindingNote(db, principal, reviewId, 'finding-1', 'keep the first, it sets up the mechanism');
  await setFindingNote(db, principal, reviewId, 'finding-2', 'this one is redundant — cut it');
  const got = await getReview(db, principal, reviewId);
  const review = got.review || got;
  assert.equal(review.findings.length, 2);
  assert.equal(review.notes['finding-1'], 'keep the first, it sets up the mechanism');
  assert.equal(review.notes['finding-2'], 'this one is redundant — cut it');
  assert.notEqual(review.notes['finding-1'], review.notes['finding-2']);
});
