// Reviews: structured critique results that never create a document revision.
// Fixture: the real `01-draft-v1.md` from the daily-note post and the five findings
// the blog critic produced on it (see 01.55 - daily-note-post/receipts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb } from './d1-shim.mjs';
import {
  userPrincipal, ensureWorkspace, createObject, createRevision, getObjectByExternal,
  submitFeedback, claimAction, completeActionWithResult, listRevisions,
  publishReview, getReview, listReviews, setFindingNote, setReviewNote, critiqueContext,
  artifactState,
} from '../../worker/objects/service.ts';
import { anchorFindings, splitBlocks, blockSpans, normalizeText } from '../../worker/objects/markdown-blocks.ts';

const principal = userPrincipal();
const MARKDOWN = readFileSync(new URL('../fixtures/daily-note-v1.md', import.meta.url), 'utf8');
const ARTICLE = 'daily-note';
const REVISION = 'rev_v1';

const FINDINGS = [
  {
    id: 'finding-1',
    category: 'Imprecise specifics',
    summary: 'Two sources mentioned, but three listed.',
    explanation: 'The article describes six sources, calls two easy, then refers to "the other two" while naming three. The count does not reconcile.',
    anchors: [{ exact: "The other two are the reason this works. KDP, GA4, and Search Console don't give an agent a simple API for this.", heading: 'How it gets filled' }],
  },
  {
    id: 'finding-2',
    category: 'Belaboring',
    summary: 'Repeated again in Setting one up.',
    explanation: 'The later passage is stronger because it gives the reader a practical instruction.',
    anchors: [
      { exact: 'Once that path exists, any site I can log into is a source.', heading: 'How it gets filled' },
      { exact: "If the agent can drive a browser, the source list is basically anything you can see when you're logged in.", heading: 'Setting one up' },
    ],
  },
  {
    id: 'finding-3',
    category: 'Unverified specifics',
    summary: 'The only measured proof point has no number or magnitude.',
    explanation: 'The report screenshot just below could provide evidence.',
    anchors: [{ exact: "The numbers were lower than they should have been, and they didn't match what I knew about the previous day.", heading: 'The morning it caught something' }],
  },
  {
    id: 'finding-4',
    category: 'Manufactured drama / belaboring',
    summary: 'Three sentences restate one fact: it runs early.',
    explanation: 'The closing aphorism restates the two sentences above it.',
    anchors: [{ exact: "I set the job early enough that the note is done before I start the day. That's the whole scheduling decision. It doesn't need to be real-time. It needs to be waiting for me.", heading: 'How it gets filled' }],
  },
  {
    id: 'finding-5',
    category: 'Performative importance',
    summary: 'The conclusion repeats a point the evidence already made.',
    explanation: 'It announces significance and then restates the thesis.',
    anchors: [{ exact: "That's why I keep it.", heading: 'The morning it caught something' }],
  },
];

async function seeded() {
  const db = makeDb();
  await ensureWorkspace(db);
  const artifact = await createObject(db, principal, {
    kind: 'orbit.artifact', title: 'The daily note', externalId: ARTICLE,
    data: { canonical_path: 'drafts/01-draft-v1.md' },
  });
  await createRevision(db, principal, artifact.id, {
    content: MARKDOWN, source: 'seed', id: REVISION, expectedRevisionId: undefined,
  });
  return { db, artifact: artifact.id };
}

// ------------------------------------------------------------------ blocks ---

test('anchors resolve to a validated source line and block', async () => {
  const spans = blockSpans(MARKDOWN);
  assert.ok(spans.length > 10);
  const quote = "The other two are the reason this works. KDP, GA4, and Search Console don't give an agent a simple API for this.";
  const [f] = anchorFindings(MARKDOWN, [{
    id: 'f', category: 'Unverified specifics', summary: 'count does not reconcile',
    anchors: [{ role: 'primary', startLine: 1, endLine: 1, exact: quote }],
  }]);
  const a = f.anchors[0];
  assert.equal(a.resolved, true);
  const span = spans[a.blockIndex];
  assert.ok(a.startLine >= span.startLine && a.endLine <= span.endLine, 'line inside its block');
  assert.match(MARKDOWN.split('\n')[a.startLine - 1], /The other two are the reason this works/);
});

test('curly quotes and collapsed whitespace still match', async () => {
  const [f] = anchorFindings(MARKDOWN, [{
    id: 'f', category: 'Belaboring', summary: 'x',
    anchors: [{ exact: "The other two are the reason this works. KDP, GA4, and Search Console don\u2019t give an agent a simple API for this." }],
  }]);
  assert.equal(f.anchors[0].resolved, true);
  assert.equal(normalizeText('  a\n b  '), 'a b');
});

test('two same-category observations stay separate findings with separate ids', async () => {
  const findings = anchorFindings(MARKDOWN, [
    { id: 'finding-1', category: 'Belaboring', summary: 'first paragraph restates itself', anchors: [{ exact: 'The other two are the reason this works.' }] },
    { id: 'finding-2', category: 'Belaboring', summary: 'second paragraph restates the same beat', anchors: [{ exact: 'Once that path exists, any site I can log into is a source.' }] },
  ]);
  assert.equal(findings.length, 2);
  assert.notEqual(findings[0].id, findings[1].id);
  assert.equal(findings[0].category, findings[1].category);
  // Document order drives `order`, regardless of the order the critic returned them.
  assert.ok(findings[0].order <= findings[1].order);
});

test('a code block is not used to anchor a neighbouring prose problem', async () => {
  const md = 'Intro line.\n\n```js\nconst a = 1;\n```\n\nAfter the fence.';
  const [f] = anchorFindings(md, [{ id: 'f', category: 'Missing orientation', summary: 'x', anchors: [{ exact: 'Intro line.' }] }]);
  assert.equal(f.anchors[0].resolved, true);
  assert.notEqual(f.anchors[0].blockIndex, blockSpans(md).findIndex((b) => /const a = 1/.test(b.text)));
});

test('fenced code blocks survive as one block', async () => {
  const blocks = splitBlocks('Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro');
  assert.equal(blocks.length, 3);
  assert.match(blocks[1], /const b = 2/);
});

test('multi-location finding keeps one id and two resolved block indices', async () => {
  const findings = anchorFindings(MARKDOWN, [FINDINGS[1]]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'finding-2');
  assert.equal(findings[0].anchors.length, 2);
  assert.ok(findings[0].anchors.every((a) => a.resolved));
  assert.notEqual(findings[0].anchors[0].blockIndex, findings[0].anchors[1].blockIndex);
  assert.ok(findings[0].anchors[0].blockIndex < findings[0].anchors[1].blockIndex);
});

test('an unresolvable anchor is retained but marked unresolved, never guessed', async () => {
  const findings = anchorFindings(MARKDOWN, [{
    id: 'ghost', category: 'Unverified specifics', summary: 'Not in this revision.',
    anchors: [{ exact: 'This sentence does not exist anywhere in the draft.' }],
  }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].anchors[0].blockIndex, -1);
  assert.equal(findings[0].anchors[0].resolved, false);
  assert.equal(findings[0].unanchored, true);
});

test('malformed findings are dropped, not trusted', async () => {
  const findings = anchorFindings(MARKDOWN, [
    null, {}, { category: 'Belaboring' }, { summary: 'no category' },
    { id: 'ok', category: 'Belaboring', summary: 'Valid one.' },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'ok');
});

// ----------------------------------------------------------------- reviews ---

test('publishReview stores findings without creating a document revision', async () => {
  const { db, artifact } = await seeded();
  const before = await listRevisions(db, principal, artifact);
  const res = await publishReview(db, principal, ARTICLE, {
    revisionId: REVISION, workflow: 'blog-critic', summary: 'Five findings.',
    findings: FINDINGS,
  });
  assert.equal(res.duplicate, false);
  assert.equal(res.review.findingCount, 5);
  assert.equal(res.review.targetRevisionId, REVISION);
  assert.equal(res.review.workflow, 'blog-critic');

  const after = await listRevisions(db, principal, artifact);
  assert.equal(after.length, before.length, 'artifact must not gain a revision');
  const state = await artifactState(db, principal, ARTICLE);
  assert.equal(state.currentNumber, 1);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].findingCount, 5);
});

test('the review is bound to the exact revision it critiqued', async () => {
  const { db, artifact } = await seeded();
  const res = await publishReview(db, principal, ARTICLE, {
    revisionId: REVISION, workflow: 'blog-critic', findings: FINDINGS,
  });
  const review = await getReview(db, principal, res.review.id);
  assert.equal(review.targetRevisionId, REVISION);
  assert.equal(review.targetObjectId, artifact);

  // A new revision does not inherit the old critique.
  await createRevision(db, principal, artifact, { content: MARKDOWN + '\n\nNew line.', source: 'feedback' });
  const onlyV1 = await listReviews(db, principal, ARTICLE, { revisionId: REVISION });
  assert.equal(onlyV1.reviews.length, 1);
  const state = await artifactState(db, principal, ARTICLE);
  const v2 = state.revisions.find((r) => r.number === 2);
  const forV2 = await listReviews(db, principal, ARTICLE, { revisionId: v2.id });
  assert.equal(forV2.reviews.length, 0);
});

test('unknown revision is rejected instead of silently retargeting', async () => {
  const { db } = await seeded();
  const res = await publishReview(db, principal, ARTICLE, {
    revisionId: 'rev_nope', workflow: 'blog-critic', findings: FINDINGS,
  });
  assert.equal(res.error, 'unknown_revision');
});

test('duplicate delivery of the same action cannot create a second review', async () => {
  const { db } = await seeded();
  const one = await publishReview(db, principal, ARTICLE, {
    revisionId: REVISION, workflow: 'blog-critic', findings: FINDINGS, actionId: 'act_1',
  });
  const two = await publishReview(db, principal, ARTICLE, {
    revisionId: REVISION, workflow: 'blog-critic', findings: FINDINGS, actionId: 'act_1',
  });
  assert.equal(two.duplicate, true);
  assert.equal(two.review.id, one.review.id);
  const list = await listReviews(db, principal, ARTICLE);
  assert.equal(list.reviews.length, 1);
});

test('human notes persist per finding and never mutate the findings', async () => {
  const { db } = await seeded();
  const { review } = await publishReview(db, principal, ARTICLE, {
    revisionId: REVISION, workflow: 'blog-critic', findings: FINDINGS,
  });
  const before = await getReview(db, principal, review.id);

  const saved = await setFindingNote(db, principal, review.id, 'finding-1', 'Agree. Fix the count.');
  assert.equal(saved.review.notes['finding-1'], 'Agree. Fix the count.');
  assert.deepEqual(saved.review.findings, before.findings, 'notes must not rewrite findings');

  const edited = await setFindingNote(db, principal, review.id, 'finding-1', 'Agree. Use the real number.');
  assert.equal(edited.review.notes['finding-1'], 'Agree. Use the real number.');

  const removed = await setFindingNote(db, principal, review.id, 'finding-1', null);
  assert.equal(removed.review.notes['finding-1'], undefined);

  const overall = await setReviewNote(db, principal, review.id, 'Keep the drumbeat.');
  assert.equal(overall.review.overallNote, 'Keep the drumbeat.');
});

test('a note on an unknown finding is refused', async () => {
  const { db } = await seeded();
  const { review } = await publishReview(db, principal, ARTICLE, {
    revisionId: REVISION, workflow: 'blog-critic', findings: FINDINGS,
  });
  const res = await setFindingNote(db, principal, review.id, 'finding-99', 'nope');
  assert.equal(res.error, 'unknown_finding');
});

test('workspace isolation: another workspace cannot read the review', async () => {
  const { db } = await seeded();
  const { review } = await publishReview(db, principal, ARTICLE, {
    revisionId: REVISION, workflow: 'blog-critic', findings: FINDINGS,
  });
  await ensureWorkspace(db, { id: 'ws_other', slug: 'other', name: 'Other' });
  const other = userPrincipal('ws_other');
  assert.equal(await getReview(db, other, review.id), null);
  assert.equal(await listReviews(db, other, ARTICLE), null);
});

test('critique context gives an authoring workflow everything it needs', async () => {
  const { db } = await seeded();
  await submitFeedback(db, principal, ARTICLE, {
    text: 'Tighten the opening', idempotencyKey: 'fb_1', baseRevisionId: REVISION,
  });
  const { review } = await publishReview(db, principal, ARTICLE, {
    revisionId: REVISION, workflow: 'blog-critic', findings: FINDINGS,
  });
  await setFindingNote(db, principal, review.id, 'finding-2', 'That repetition is deliberate. Keep it.');

  const ctx = await critiqueContext(db, principal, ARTICLE, { revisionId: REVISION });
  assert.equal(ctx.revision.id, REVISION);
  assert.equal(ctx.revision.markdown, MARKDOWN);
  assert.equal(ctx.review.id, review.id);
  assert.equal(ctx.review.findings.length, 5);
  assert.equal(ctx.notes['finding-2'], 'That repetition is deliberate. Keep it.');
  assert.ok(ctx.conversation.some((m) => m.text === 'Tighten the opening'));
});

// ------------------------------------------------------- action completion ---

test('a critic action completes as a review and leaves the revision untouched', async () => {
  const { db, artifact } = await seeded();
  const req = await submitFeedback(db, principal, ARTICLE, {
    kind: 'workflow', workflow: 'blog-critic', idempotencyKey: 'wf_1', baseRevisionId: REVISION,
  });
  const claim1 = await claimAction(db, principal, req.requestId, 'felix-local');

  const done = await completeActionWithResult(db, principal, req.requestId, {
    reply: 'Five findings.', review: { summary: 'Five findings.', findings: FINDINGS }, token: claim1.token,
  });
  assert.equal(done.ok, true);
  assert.equal(done.review.findingCount, 5);
  assert.equal(done.revision, null);
  assert.equal((await listRevisions(db, principal, artifact)).length, 1);
});

test('the same action replaying its result does not duplicate the review', async () => {
  const { db } = await seeded();
  const req = await submitFeedback(db, principal, ARTICLE, {
    kind: 'workflow', workflow: 'blog-critic', idempotencyKey: 'wf_2', baseRevisionId: REVISION,
  });
  const claim2 = await claimAction(db, principal, req.requestId, 'felix-local');
  await completeActionWithResult(db, principal, req.requestId, {
    review: { summary: 'x', findings: FINDINGS }, token: claim2.token,
  });
  const again = await completeActionWithResult(db, principal, req.requestId, {
    review: { summary: 'x', findings: FINDINGS }, token: claim2.token,
  });
  assert.equal(again.duplicate, true);
  assert.equal((await listReviews(db, principal, ARTICLE)).reviews.length, 1);
});

test('a revision workflow still publishes a revision and a critic cycle can repeat', async () => {
  const { db, artifact } = await seeded();

  // Cycle 1 — critic.
  const c1 = await submitFeedback(db, principal, ARTICLE, {
    kind: 'workflow', workflow: 'blog-critic', idempotencyKey: 'wf_c1', baseRevisionId: REVISION,
  });
  const c1claim = await claimAction(db, principal, c1.requestId, 'felix-local');
  await completeActionWithResult(db, principal, c1.requestId, {
    review: { summary: 's1', findings: FINDINGS }, token: c1claim.token,
  });

  // Author.
  const a1 = await submitFeedback(db, principal, ARTICLE, {
    kind: 'workflow', workflow: 'blog-author', idempotencyKey: 'wf_a1',
    baseRevisionId: REVISION, reviewId: (await listReviews(db, principal, ARTICLE)).reviews[0].id,
  });
  const a1claim = await claimAction(db, principal, a1.requestId, 'felix-local');
  const authored = await completeActionWithResult(db, principal, a1.requestId, {
    reply: 'Fixed the count.', markdown: MARKDOWN.replace('The other two', 'The third'), token: a1claim.token,
  });
  assert.equal(authored.revision.number, 2);
  const state = await artifactState(db, principal, ARTICLE);
  assert.equal(state.currentNumber, 2);

  // Cycle 2 — critic on V2.
  const c2 = await submitFeedback(db, principal, ARTICLE, {
    kind: 'workflow', workflow: 'blog-critic', idempotencyKey: 'wf_c2', baseRevisionId: authored.revision.id,
  });
  const c2claim = await claimAction(db, principal, c2.requestId, 'felix-local');
  await completeActionWithResult(db, principal, c2.requestId, {
    review: { summary: 's2', findings: [FINDINGS[0]] }, token: c2claim.token,
  });

  const all = await listReviews(db, principal, ARTICLE);
  assert.equal(all.reviews.length, 2);
  assert.equal(all.reviews[0].targetRevisionId, authored.revision.id);
  // The V1 critique is still there and still bound to V1.
  assert.equal(all.reviews[1].targetRevisionId, REVISION);
  assert.equal((await listRevisions(db, principal, artifact)).length, 2);
});

test('a revision workflow that returns no markdown completes without a revision', async () => {
  const { db } = await seeded();
  const req = await submitFeedback(db, principal, ARTICLE, {
    kind: 'workflow', workflow: 'seo-retrofit', idempotencyKey: 'wf_seo', baseRevisionId: REVISION,
  });
  const seoClaim = await claimAction(db, principal, req.requestId, 'felix-local');
  const res = await completeActionWithResult(db, principal, req.requestId, { reply: 'Nothing to change.', markdown: '', token: seoClaim.token });
  assert.equal(res.ok, true);
  assert.equal(res.revision, null);
  assert.equal((await listRevisions(db, principal, ARTICLE)).length, 1);
});

test('workflow result kinds are declared, not inferred from names', async () => {
  const { db, artifact } = await seeded();
  const state = await artifactState(db, principal, ARTICLE);
  assert.deepEqual(state.workflowResultKinds, {
    'blog-author': 'revision',
    'blog-critic': 'review',
    'seo-retrofit': 'revision',
    'signup-retrofit': 'revision',
    'generate-masthead': 'asset',
    'publish-post': 'publication',
  });
  assert.ok(await getObjectByExternal(db, principal, 'orbit.artifact', ARTICLE));
  assert.ok(artifact);
});
