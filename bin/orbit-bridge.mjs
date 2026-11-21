#!/usr/bin/env node
// Generic Orbit action bridge. One poller, plugin handlers, server-side claims.
// Env: ORBIT_BASE, ORBIT_ARTIFACT_BRIDGE_TOKEN (or ORBIT_TOKEN), ORBIT_BRIDGE_LEDGER.

import {
  readFileSync, writeFileSync, renameSync, mkdirSync, mkdtempSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const DEFAULT_BASE = 'https://orbit.kenmazaika.com';
const DEFAULT_LEDGER = join(homedir(), '.openclaw', 'workspace', 'state', 'orbit-bridge-results.json');
const SKILLS = join(homedir(), '.openclaw', 'workspace', 'skills');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ResultLedger {
  constructor(path = DEFAULT_LEDGER) {
    this.path = path;
    this.data = {};
    try { this.data = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  }
  get(id) { return this.data[id] || null; }
  set(id, value) { this.data[id] = value; this.save(); }
  delete(id) { delete this.data[id]; this.save(); }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

export function makeApi(base, token) {
  return async (path, opts = {}) => {
    const { raw, ...fetchOpts } = opts;
    const res = await fetch(base.replace(/\/$/, '') + '/api/v1' + path, {
      ...fetchOpts,
      headers: {
        accept: 'application/json', authorization: `Bearer ${token}`,
        ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}),
      },
    });
    if (raw) {
      if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return data;
  };
}

/**
 * Resolve an installed skill to its SKILL.md path.
 * OpenClaw injects a compact <available_skills> catalog into every agent run and the
 * model loads the file on demand — so the bridge references the skill instead of
 * pasting it into the prompt. Missing skills fail visibly, never silently.
 */
export function skillPath(name) {
  const candidates = [
    join(SKILLS, name, 'SKILL.md'),
    join(homedir(), '.openclaw', 'workspace', 'Vault', '07 - SKILLS', name, 'SKILL.md'),
  ];
  for (const path of candidates) { try { readFileSync(path, 'utf8'); return path; } catch {} }
  return null;
}

function skillDirective(name, role) {
  if (!name) return '';
  const path = skillPath(name);
  if (!path) {
    return `MISSING SKILL: the ${role} skill "${name}" is not installed on this machine.
Stop before writing anything and reply with exactly {"reply":"skill_unavailable: ${name}"}.`;
  }
  return `${role} SKILL — invoke the installed skill "${name}" by reference:
- Read ${path} with the read tool before you start. It is the authoritative procedure and editorial guidance for this run.
- Follow that SKILL.md; do not guess or reconstruct its contents.
- Do not load any other skill.`;
}

function buildCritiqueBlock(req) {
  const critique = req.critique;
  if (!critique) return '';
  const findings = Array.isArray(critique.findings) ? critique.findings : [];
  if (!findings.length && !critique.overallNote) return '';
  const lines = findings.map((f, i) => {
    const anchors = (f.anchors || []).filter((a) => a.exact).map((a) => {
      const where = a.startLine ? `L${a.startLine}${a.endLine && a.endLine !== a.startLine ? '-' + a.endLine : ''}` : 'unlocated';
      const role = a.role === 'supporting' ? ' (supporting)' : '';
      return `      ${where}${role}: "${a.exact}"`;
    }).join('\n');
    const note = critique.notes && critique.notes[f.id] ? `\n      Ken's note: ${critique.notes[f.id]}` : '';
    return `${i + 1}. [${f.category}] ${f.summary} (id: ${f.id})${f.explanation ? `\n      why: ${f.explanation}` : ''}${anchors ? `\n${anchors}` : ''}${note}`;
  });
  return `CRITIQUE ON THIS REVISION (${critique.workflow || 'blog-critic'}, ${findings.length} findings — each one is a separate observation):\n${lines.join('\n')}\n${critique.overallNote ? `Overall note from Ken: ${critique.overallNote}\n` : ''}`;
}

export function buildArtifactPrompt(req) {
  const base = req.base?.markdown || '';
  const images = req.images || [];
  const imgs = images.map((i) =>
    `- ${i.id} (${i.filename}, ${i.mime})${i.instruction ? ' — ' + i.instruction : ''}`).join('\n');
  const workflow = req.kind === 'workflow' ? req.workflow : '';
  const resultKind = req.result_kind || 'revision';
  const critiqueBlock = resultKind === 'revision' ? buildCritiqueBlock(req) : '';

  // Feedback rounds: user turns only, oldest → newest, minus the current request
  // (it is printed separately below) and consecutive repeats.
  const current = String(req.text || '').trim();
  const rounds = [];
  for (const h of req.history || []) {
    if (h.role && h.role !== 'user') continue;
    const text = String(h.text || '').trim();
    if (!text || text === current) continue;
    if (rounds.length && rounds[rounds.length - 1] === text) continue;
    rounds.push(text);
  }

  if (resultKind === 'review') {
    const numbered = base.split('\n').map((line, i) => `${String(i + 1).padStart(4, ' ')}| ${line}`).join('\n');
    return `You are critiquing one revision of Ken's article. Return ONLY valid JSON, no prose outside it.

Shape:
{"reply": "<one or two sentences to Ken, no praise section>", "review": {"summary": "<optional one-line overall note>", "findings": [
  {"id": "finding-1", "category": "<problem name>", "summary": "<one short line>", "explanation": "<one or two sentences: what it does instead of communicating>",
   "anchors": [{"role": "primary", "startLine": 12, "endLine": 12, "exact": "<verbatim quote from those lines>", "heading": "<nearest section heading>"}]}
]}}

Rules:
- You are a critic, never an editor. No rewrites, no replacement sentences, no praise section, no severity scores.
- ONE OBSERVATION IS ONE FINDING. Each distinct problem gets its own id and its own anchor, even when an earlier finding used the same category. Two paragraphs that each belabor their own point are two findings. Two places that both lack orientation are two findings.
- The only exception is relational: the same claim made in two places, or an awkward transition between two sections, is ONE finding with a "primary" anchor and a "supporting" anchor. Quote both passages.
- Never merge unrelated problems because they share a category. Never split a relational problem into unrelated findings.
- The catalog names a KIND of problem, not a bucket with one slot.
- Be selective the way a good editor is: flag what you would actually mark, skip borderline nits, allow deliberate repetition, do not enforce lengths or formulas, and zero findings is a valid answer.
- "exact" MUST be copied character for character from the numbered lines (without the line-number prefix) — same words, same punctuation, no ellipses, no paraphrase. A paraphrase cannot be anchored and shows as unanchored.
- "startLine"/"endLine" are the 1-based numbers shown before the "|" and must actually contain the quote. The server validates them; a guessed line is corrected or rejected.
- A quote may be a sentence or a short phrase; it does not need to cover the paragraph.
- Do NOT anchor a transition or "missing orientation" finding to a code block just because the block is nearby. Point at the prose line or the boundary.
- "summary" is the compact collapsed line; "explanation" is the expanded level. Never repeat one in the other.
- Do NOT return markdown. This workflow produces findings only; the article is not revised.
${imgs ? `- Images attached to this revision are in the working directory. Open one when a claim in the article depends on what it shows; never infer content from a filename and never invent what an image shows.\n${imgs}` : ''}
${skillDirective(workflow || 'blog-critic', 'CRITIQUE')}

ARTICLE (revision V${req.base?.number}, numbered by source line):
<<<ARTICLE
${numbered}
ARTICLE>>>`;
  }

  return `You are revising a blog article for Ken. Return ONLY valid JSON, no prose outside it.

Shape: {"reply": "<short conversational reply to Ken>", "markdown": "<full revised article markdown, or empty string if no revision>", "dispositions": [{"findingId": "finding-1", "status": "addressed|retained|unresolved", "note": "<one short line when retained or unresolved>"}]}

Rules:
- The article below is the complete current revision. Preserve frontmatter, headings, links, and images unless the feedback asks otherwise.
- Apply the feedback to the whole article. Keep what works.
- "reply" is conversational and specific: what you changed, what you kept, any concern. No generic acknowledgement.
- Apply every still-relevant item from EVERY feedback round below, not just the newest. Later rounds supersede earlier ones where they conflict; name the conflict in "reply".
- The current request is Ken's explicit direction and outranks anything a critic suggested.
- Return one disposition for EVERY critique finding you were given, keyed by its id. "addressed" means you changed the text to fix it; "retained" means you deliberately kept it (say why in note); "unresolved" means you could not fix it without inventing evidence (say why). Never invent a change just to mark a finding addressed.
${critiqueBlock ? `- Address substantive critique findings. Where Ken wrote a note on a finding, his note wins over the critic. Do not implement every finding — a deliberate choice he has defended stays. Say briefly what changed and what you intentionally left unchanged. Never invent a number, quote, or source to satisfy a finding; if evidence is missing, qualify the claim or say the gap remains in "reply".` : ''}
${imgs ? `- Attached images are saved in the working directory. OPEN AND LOOK AT EACH ONE before placing anything:\n${imgs}\n- Place an image in the body only where it genuinely supports the surrounding passage, using a durable reference: ![descriptive alt](/api/v1/images/<asset-id>)\n- Never use file paths, blob: URLs or expiring URLs in markdown.\n- If the article contains a placeholder like [screenshot: description], replace it in place when an attached image actually matches what it describes; otherwise leave the placeholder and say it is unresolved. Match on image content, never on filename.\n- Do not group images at the start or end, do not repeat an image, and do not invent what an image shows - alt text must describe only what you can see.\n- Report in "reply" which images you placed where, and which you left unused.` : ''}
${skillDirective('blog-author', 'AUTHORING')}
${workflow && workflow !== 'blog-author' ? skillDirective(workflow, 'WORKFLOW') : ''}

CONTEXT
Artifact: ${req.article_id || req.object_id}
Action: ${req.id}
Source revision: V${req.base?.number ?? '?'} (${req.base?.id || 'none'})
Result kind: ${resultKind}

${critiqueBlock ? critiqueBlock + '\n' : ''}FEEDBACK ROUNDS (oldest → newest; still in force unless the current request overrides them):
${rounds.length ? rounds.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)'}

CURRENT REQUEST:
${current || `(workflow request: ${workflow || 'none'})`}

ARTICLE (current revision V${req.base?.number}):
<<<ARTICLE
${base}
ARTICLE>>>

OUTPUT CONTRACT — this wins over any other output description above or in the skill:
Return ONLY one JSON object, nothing before or after it.
{"reply": "<short reply to Ken>", "markdown": "<the COMPLETE revised article, frontmatter included; empty string if no revision is warranted>", "dispositions": [{"findingId": "<id from the critique>", "status": "addressed|retained|unresolved", "note": "<one line when retained or unresolved>"}]}
- "markdown" is the whole document, never a summary of edits.
- "dispositions" has exactly one entry per critique finding id. No findings in context means an empty array.
- A prose reply instead of this object is a failed run.`;
}

export function buildInboxPrompt(req) {
  return `You are handling an approved Orbit Inbox decision for Ken.

Execute the decision using the tools and workspace available to you. The Orbit action is the authority for this turn. Do not edit Orbit's database or action state; the bridge owns that. Respect all normal safety and external-action approval rules.

ACTION CONTEXT
- Object: ${req.object_id}
- Title: ${req.title}
- Message: ${req.body || '(none)'}
- Selected choices: ${(req.choices || []).length ? req.choices.map((x) => `\n  - ${x}`).join('') : ' none'}
- Instruction: ${req.instruction || '(none)'}

Return a concise completion note stating what happened, any artifact path, and any blocker. Do not return JSON.`;
}

export function runOpenClaw(prompt, { sessionKey, cwd, timeoutMs = 900000, onSpawn } = {}) {
  const dir = cwd || mkdtempSync(join(tmpdir(), 'orbit-bridge-'));
  const file = join(dir, 'prompt.md');
  writeFileSync(file, prompt);
  return new Promise((resolve, reject) => {
    const child = spawn('openclaw', ['agent', '--message-file', file, '--json', '--session-key', sessionKey], {
      env: process.env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    // The run is announced as soon as the process is actually up, not when it finishes.
    child.on('spawn', () => { if (onSpawn) Promise.resolve(onSpawn()).catch(() => {}); });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('agent timeout'));
    }, timeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`agent exit ${code}: ${err.slice(0, 500)}`));
    });
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

export function runHermes(prompt, { sessionKey, cwd, timeoutMs = 900000, onSpawn } = {}) {
  const dir = cwd || mkdtempSync(join(tmpdir(), 'orbit-hermes-'));
  const file = join(dir, 'prompt.md');
  writeFileSync(file, prompt);
  const profile = process.env.ORBIT_HERMES_PROFILE || 'felix';
  return new Promise((resolve, reject) => {
    const child = spawn('hermes', ['-p', profile, '-z', prompt], {
      env: process.env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    child.on('spawn', () => { if (onSpawn) Promise.resolve(onSpawn()).catch(() => {}); });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('hermes timeout'));
    }, timeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`hermes exit ${code}: ${err.slice(0, 500)}`));
    });
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

function inner(text) {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function extractAgentText(raw) {
  const text = String(raw || '').trim();
  let envelope = null;
  try { envelope = JSON.parse(text); } catch {}
  return String(envelope?.result?.payloads?.[0]?.text
    || envelope?.finalAssistantRawText || envelope?.finalAssistantVisibleText || envelope?.text || text).trim();
}

export function parseArtifactResult(raw, resultKind = 'revision') {
  const candidate = extractAgentText(raw);
  const object = inner(candidate);
  if (object && (typeof object.reply === 'string' || typeof object.markdown === 'string' || object.review)) {
    const findings = Array.isArray(object.review?.findings) ? object.review.findings : [];
    return {
      reply: String(object.reply || ''),
      markdown: resultKind === 'review' ? '' : String(object.markdown || ''),
      review: resultKind === 'review' ? { summary: String(object.review?.summary || ''), findings } : null,
      dispositions: Array.isArray(object.dispositions) ? object.dispositions : [],
    };
  }
  return { reply: candidate.slice(0, 4000), markdown: '', review: null, dispositions: [] };
}

function buildMastheadPrompt(req) {
  const options = req.options || {};
  const approach = options.approach === 'reference' ? 'reference' : 'new';
  const provider = String(options.provider || 'grok');
  const reference = req.images?.find((i) => i.id === options.referenceAssetId) || null;
  return `Create the masthead (featured image) for this blog post. Return ONLY valid JSON.

Shape: {"reply": "<one or two sentences about the image>", "asset": {"path": "<absolute path to the generated PNG>", "filename": "masthead.png", "mime": "image/png"}}

Task:
- Artifact: ${req.article_id}
- Source revision: V${req.base?.number ?? '?'}
- Approach: ${approach === 'reference' ? 'reference-based (adapt the supplied reference image)' : 'new concept (no reference image)'}
- Generator: xai/grok-imagine-image-quality (pinned by the skill; no fallback provider)
${reference ? `- Reference image: ${reference.filename} (${reference.mime}) is in the working directory${options.referenceInstruction ? ` — ${options.referenceInstruction}` : ''}` : ''}
${options.instructions || req.text ? `- Extra direction from Ken: ${options.instructions || req.text}` : ''}

Rules:
- Follow the installed masthead-dark-logo-scene skill for composition, palette, crops and verification. It is authoritative.
- 16:9, mobile-safe centre crop, no baked headline text.
- Generate at 16:9. Then COPY the generated file into the working directory as ./masthead.png (use cp) and return that absolute path in asset.path. The generator's own output folder is not readable by Orbit.
- Do not modify the article. Do not publish anything.
${skillDirective('masthead-dark-logo-scene', 'MASTHEAD')}

ARTICLE (current revision V${req.base?.number}):
<<<ARTICLE
${req.base?.markdown || ''}
ARTICLE>>>`;
}

function buildPublishPrompt(req) {
  const pub = req.publication?.data || null;
  return `Publish this artifact to Notes from the Loop and return ONLY valid JSON.

Shape: {"reply": "<short confirmation>", "publication": {"url": "<public https url>", "status": "published|updated|failed"}}

Context:
- Artifact: ${req.article_id}
- Revision: V${req.base?.number ?? '?'}
- Destination: ${(req.options?.destination) || 'notes-from-the-loop'}
- Blog repo: /home/matthew/kenmazaika-blog (content: src/content/blog/<slug>.md, deploy: npm run deploy)
${req.masthead ? `- Active masthead asset: ${req.masthead.filename} (${req.masthead.id}) — use it as the featured image.` : '- No active masthead; the pipeline allows posts without one.'}
- Inline images: ${(req.images || []).length}
${pub ? `- Previously published: ${pub.url || 'unknown url'} (${pub.status}) — update that post, do not create a duplicate.` : ''}
${req.options?.instructions || req.text ? `- Ken's instruction: ${req.options?.instructions || req.text}` : ''}

Rules:
- Use the existing publishing pipeline in the blog repo; do not invent a new one.
- Preserve frontmatter and the selected revision's content; never fabricate metadata.
- Refuse to publish if an image reference cannot be resolved — report the blocker instead.
- Do not create duplicate posts; reuse the existing URL when one exists.
- Nothing else may be written to the blog repo besides this post and its images.`;
}

export function parseMastheadResult(raw) {
  const text = extractAgentText(raw);
  const object = inner(text);
  if (object && (typeof object.reply === 'string' || object.asset)) {
    return { reply: String(object.reply || ''), asset: object.asset || null };
  }
  return { reply: text.slice(0, 2000), asset: null };
}

export function parsePublicationResult(raw) {
  const text = extractAgentText(raw);
  const object = inner(text);
  if (object && (object.publication || typeof object.reply === 'string')) {
    return { reply: String(object.reply || ''), publication: object.publication || null };
  }
  return { reply: text.slice(0, 2000), publication: null };
}

async function handleMasthead(req, { api, runner, checkpoint, token, timing }) {
  // No ledger cache here: the generated file lives in a temp dir, and a retry needs
  // the bytes to still exist. A duplicate asset on a rare crash-retry is visible as a
  // historical candidate, never as a lost masthead.
  const dir = mkdtempSync(join(tmpdir(), 'orbit-masthead-'));
  const options = req.options || {};
  const reference = (req.images || []).find((i) => i.id === options.referenceAssetId);
  if (reference) {
    try {
      const bytes = await api(`/images/${encodeURIComponent(reference.id)}`, { raw: true });
      writeFileSync(join(dir, reference.filename), bytes);
    } catch (error) {
      throw new Error(`reference_image_unavailable: ${error.message}`);
    }
  }
  const tAgent = Date.now();
  const raw = await runner(buildMastheadPrompt(req), {
    sessionKey: `agent:main:orbit-masthead-${req.id}`, cwd: dir,
    onSpawn: () => api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
      method: 'POST', body: JSON.stringify({ status: 'working', token }),
    }),
  });
  if (timing) timing.agentMs = Date.now() - tAgent;
  const result = parseMastheadResult(raw);
  const filename = (result.asset && result.asset.filename) || 'masthead.png';
  const candidates = [
    result.asset && result.asset.path,
    join(dir, filename),
    join(dir, 'masthead.png'),
  ].filter(Boolean);
  let path = candidates.find((p) => { try { return existsSync(p) && readFileSync(p).length > 0; } catch { return false; } });
  if (!path) {
    // Last resort: the newest image the run left in its working directory.
    try {
      const found = readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
      if (found) path = join(dir, found.f);
    } catch {}
  }
  if (!path) throw new Error('masthead_missing: no generated image found in the run directory');
  const bytes = readFileSync(path);
  if (!bytes.length) throw new Error('masthead_empty: generated file had no bytes');
  const uploaded = await api(`/artifacts/${encodeURIComponent(req.article_id)}/images`, {
    method: 'POST',
    body: JSON.stringify({
      filename, mime: (result.asset && result.asset.mime) || 'image/png',
      dataBase64: bytes.toString('base64'),
      role: 'masthead', assetState: 'active',
      provider: options.provider || 'grok',
      referenceAssetId: options.referenceAssetId || undefined,
      revisionId: req.base && req.base.id ? req.base.id : undefined,
      instruction: options.instructions || req.text || undefined,
    }),
  });
  checkpoint({ reply: result.reply, assetId: uploaded.id });
  await api(`/agent/actions/${encodeURIComponent(req.id)}/complete`, {
    method: 'POST', body: JSON.stringify({ reply: result.reply, assetId: uploaded.id, token }),
  });
  return { reply: result.reply, assetId: uploaded.id, filename, revisionId: null };
}

async function handlePublish(req, { api, runner, token, timing }) {
  // Implemented, deliberately inert on this host. Both gates must be open, and the
  // only caller that opens them is a human-initiated request.
  if (process.env.ORBIT_PUBLISH_ENABLED !== '1') {
    throw new Error('publish_not_enabled: the publish workflow is implemented but disabled on this host');
  }
  if (!req.options || req.options.confirm !== true) {
    throw new Error('publish_not_confirmed: resubmit with options.confirm = true');
  }
  const tAgent = Date.now();
  const raw = await runner(buildPublishPrompt(req), {
    sessionKey: `agent:main:orbit-publish-${req.id}`,
    onSpawn: () => api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
      method: 'POST', body: JSON.stringify({ status: 'working', token }),
    }),
  });
  if (timing) timing.agentMs = Date.now() - tAgent;
  const result = parsePublicationResult(raw);
  if (!result.publication || !result.publication.url) {
    await api(`/artifacts/${encodeURIComponent(req.article_id)}/publication`, {
      method: 'POST',
      body: JSON.stringify({ status: 'failed', revisionId: req.base && req.base.id, detail: { reply: result.reply } }),
    });
    throw new Error('publication_failed: the pipeline did not return a url');
  }
  await api(`/artifacts/${encodeURIComponent(req.article_id)}/publication`, {
    method: 'POST',
    body: JSON.stringify({
      status: result.publication.status || 'published',
      url: result.publication.url,
      revisionId: req.base && req.base.id,
      destination: (req.options && req.options.destination) || 'notes-from-the-loop',
    }),
  });
  return result;
}

// ---------------------------------------------------------------- Work ---

function formatBrief(brief) {
  const c = brief && brief.content ? brief.content : null;
  if (!c) return '';
  const thesis = c.working_thesis || c.emerging_thesis;
  const tension = c.tension;
  const angle = c.angle || c.current_direction;
  const decisions = Array.isArray(c.decisions) ? c.decisions : [];
  const established = [], tentative = [], rejected = [];
  for (const d of decisions) {
    const text = typeof d === 'string' ? d : d.text;
    if (!text) continue;
    const raw = typeof d === 'string' ? 'established' : (d.status === 'hypothesis' ? 'tentative' : d.status);
    if (raw === 'rejected') rejected.push(text);
    else if (raw === 'tentative') tentative.push(text);
    else established.push(text);
  }
  const lines = [];
  if (thesis) lines.push(`Working thesis: ${thesis}`);
  if (tension) lines.push(`Tension: ${tension}`);
  if (angle) lines.push(`Angle: ${angle}`);
  if (established.length) lines.push(`Established decisions:\n${established.map((x) => `- ${x}`).join('\n')}`);
  if (tentative.length) lines.push(`Tentative (not accepted yet):\n${tentative.map((x) => `- ${x}`).join('\n')}`);
  if (rejected.length) lines.push(`Rejected / not pursuing:\n${rejected.map((x) => `- ${x}`).join('\n')}`);
  const evidence = Array.isArray(c.evidence) ? c.evidence : (Array.isArray(c.context) ? c.context : []);
  if (evidence.length) lines.push(`Evidence / examples:\n${evidence.map((x) => `- ${x}`).join('\n')}`);
  const unresolved = Array.isArray(c.unresolved) ? c.unresolved : (Array.isArray(c.open_questions) ? c.open_questions : []);
  if (unresolved.length) lines.push(`Unresolved:\n${unresolved.map((x) => `- ${x}`).join('\n')}`);
  const notPursuing = Array.isArray(c.not_pursuing) ? c.not_pursuing : [];
  if (notPursuing.length) lines.push(`Not pursuing:\n${notPursuing.map((x) => `- ${x}`).join('\n')}`);
  if (c.reader_takeaway) lines.push(`Reader takeaway: ${c.reader_takeaway}`);
  const boundaries = Array.isArray(c.boundaries) ? c.boundaries : (Array.isArray(c.constraints) ? c.constraints : []);
  if (boundaries.length) lines.push(`Boundaries:\n${boundaries.map((x) => `- ${x}`).join('\n')}`);
  return lines.join('\n');
}

export function buildWorkPrompt(state, mode) {
  const w = state.work || {};
  const genesis = w.genesis || {};
  const messages = (state.messages || []).slice(-30).map((m) =>
    `[${m.role}${m.kind && m.kind !== 'message' ? `/${m.kind}` : ''}] ${String(m.text || '').slice(0, 4000)}`).join('\n\n');
  const plan = state.currentPlan;
  const planText = plan ? `CURRENT PLAN (rev ${plan.revision}, ${plan.status})\nGoal: ${plan.goal}\n${(plan.steps || []).map((st, i) => `${i + 1}. [${st.status || 'pending'}] ${st.title}${st.detail ? ` — ${st.detail}` : ''}`).join('\n')}\nRationale: ${plan.rationale || '(none)'}` : '(no plan yet)';
  const feedback = (state.messages || []).filter((m) => m.role === 'user').slice(-6).map((m) => `- ${m.text}`).join('\n') || '(none)';
  const brief = formatBrief(state.brief);
  const briefBlock = brief ? `WORKING BRIEF (from Explore — treat settled decisions as established; do not re-litigate):\n${brief}\n` : '';

  const boundaries = `BOUNDARIES (staging prototype)
- You may read files, research the web, inspect the repo, run reversible local tests, and write only under a temp working directory or staging resources.
- Do NOT send email, post publicly, publish the blog, deploy production, change production D1, purchase anything, or contact a third party.
- If a step requires one of those, stop and emit an authorization interaction with the exact payload; do not claim it happened.
- Do not expose hidden reasoning. Report only observable work: what you checked, what you found, what you produced.`;

  if (mode === 'plan') {
    return `You are Orbit Work, Ken's collaborator. A Work session starts from an observation and you take responsibility for turning it into a concrete outcome.

GENESIS (${genesis.type || 'source'}: ${genesis.title || w.title})
Ref: ${genesis.ref || '(none)'}
URL: ${genesis.url || '(none)'}

<<<SOURCE
${String(genesis.snapshot || '').slice(0, 60000)}
SOURCE>>>

SESSION
Title: ${w.title}
Goal: ${w.goal || '(not set)'}
State: ${w.state}

${briefBlock}
CONVERSATION SO FAR
${messages || '(no messages yet)'}

YOUR TASK — PREPARATION
Investigate this opportunity before you plan. Use your real tools (web_search, web_fetch, repo inspection) to check whether it is still actionable and what is missing. Do not just paraphrase the source into a checklist.
Then produce:
1. A concise, concrete assessment for Ken: what you looked into, what you found, whether it is worth pursuing, and what the useful outcome would be.
2. A plan of 2-5 steps with short descriptions. The plan is a working hypothesis and should focus on delivering the main outcome. Do not add monitoring, recurring check-ins, or multi-week follow-up steps; put verification in the final step. If something genuinely must happen later, mention it in the reply instead of making it a plan step.
3. The first human judgment point if one is genuinely useful (otherwise omit it).
Do not start external actions.

${boundaries}

OUTPUT CONTRACT — return ONLY one JSON object, no prose before or after it:
{"reply":"<markdown assessment for Ken>","plan":{"goal":"<one line>","rationale":"<why this approach>","steps":[{"title":"<short>","detail":"<one sentence>"}]},"interaction":null,"result":null,"state":"awaiting_direction"}
A prose reply instead of this object is a failed run.`;
  }

  return `You are Orbit Work, Ken's collaborator. Continue a session that Ken has already accepted.

GENESIS
${genesis.title || w.title} — ${genesis.url || genesis.ref || ''}
<<<SOURCE
${String(genesis.snapshot || '').slice(0, 60000)}
SOURCE>>>

SESSION
Title: ${w.title}
Goal: ${w.goal || '(not set)'}
State: ${w.state}

${briefBlock}
${planText}

RECENT USER FEEDBACK
${feedback}

CONVERSATION SO FAR
${messages || '(none)'}

YOUR TASK — EXECUTION
Carry the accepted plan forward and do real work with your tools. Do the main action rather than scheduling future monitoring or long-tail follow-up. Adapt the plan when evidence changes; do not restart the session or discard completed work.
Work autonomously through reversible steps. Bring Ken in only when:
- a genuine choice benefits from his judgment (collaboration: 2-3 concrete options), or
- a consequential external action needs explicit authorization (authorization: show recipient, destination, exact text/payload), or
- a manual step only he can do (manual: tell him exactly what to do).
When you finish, report what actually changed, what you verified, what remains, and links/paths to outputs. Never claim an external action was performed. If everything is done, state "completed" and return a result object.

${boundaries}

OUTPUT CONTRACT — return ONLY one JSON object, no prose before or after it:
{"reply":"<markdown update for Ken: what you did, found, decided>","plan":{"goal":"...","rationale":"...","steps":[{"title":"...","detail":"...","status":"pending|active|done|blocked"}]},"interaction":{"type":"collaboration|authorization|manual","prompt":"<the decision or handoff>","context":"<short context>","options":[{"id":"a","label":"Use the first"}],"payload":{}},"result":{"summary":"<what was accomplished>","links":[{"label":"...","url":"..."}],"verified":["..."],"remaining":"..."},"state":"working|awaiting_feedback|awaiting_authorization|awaiting_manual|blocked|completed"}
Include "plan" only when the plan materially changes (it becomes a new revision). Use null for plan/interaction/result when not applicable.`;
}

export function buildExplorePrompt(state) {
  const w = state.work || {};
  const genesis = w.genesis || {};
  const messages = (state.messages || []).slice(-24).map((m) =>
    `[${m.role}${m.kind && m.kind !== 'message' ? `/${m.kind}` : ''}] ${String(m.text || '').slice(0, 4000)}`).join('\n\n');
  const brief = formatBrief(state.brief);

  return `You are Orbit Explore, Ken's collaborative thinking partner. Guided is where work gets planned and executed; Explore is where an idea becomes worth executing. Your job is not to produce a complete treatment of the topic. Your job is to help Ken discover and refine the strongest version of his own idea, especially the spine of a blog post.

GENESIS (${genesis.type || 'source'}: ${genesis.title || w.title})
${genesis.url ? `URL: ${genesis.url}` : ''}
${genesis.ref ? `Ref: ${genesis.ref}` : ''}
<<<SOURCE
${String(genesis.snapshot || '').slice(0, 30000)}
SOURCE>>>

CURRENT WORKING BRIEF
${brief || '(none yet)'}

CONVERSATION SO FAR
${messages || '(no messages yet)'}

HOW TO RESPOND
- Default to roughly 100–250 words. This is not a hard cap: go longer when Ken explicitly asks for deeper analysis, when the problem genuinely requires it, when comparing several important alternatives, or when he asks for a synthesis or working brief. A short reply with one good distinction and one useful question is usually better than a comprehensive essay. Leave room for Ken to disagree, correct, or choose.
- Every reply should make at least one real intellectual move: contribute an observation, distinction, challenge, or reframe; make the idea tangible with a provisional thesis, two competing framings, a short example, a possible opening, a title, or a miniature argument; name the one or two gaps that materially affect the direction; or ask at most one question that changes the direction.
- Do not mechanically include all four moves. Do not follow a response template. Do not end every reply with a question.
- Never respond with generic encouragement, “tell me more”, “what do you think?”, “would you like me to expand?”, or a long restatement of what Ken said. Offer something worth reacting to.
- Say which idea seems stronger and why. Disagree when the evidence or logic points that way; do not automatically agree.
- Ken's input often comes from dictation: long, repetitive, incomplete, self-correcting, with tangents. Interpret meaning; do not correct prose or polish it into a document.

BLOG SPINE
When the idea is a blog post, the eventual spine is: central argument, tension, distinctive contribution, supporting evidence, gaps, reader takeaway, boundaries. Treat it as a thinking framework, not a form. Do not print an empty seven-section template at the start. Build only the parts that are earned, and keep track of what is established versus still tentative.

CONCRETE SKETCHES
You may show a provisional one-sentence thesis, two competing ways to frame the argument, a possible opening paragraph, a short illustrative example, a possible title, or the central tension in a few sentences. Label these as sketches. Never write the full post, a comprehensive outline, an SEO workflow, or start the drafting pipeline. If Ken asks for substantive drafting or execution, say that belongs in Guided and suggest switching. Do not switch modes automatically.

GAPS
Name at most two material gaps at a time. Distinguish gaps that must be resolved before the idea works from details that can be researched during Guided execution. Do not produce an exhaustive critique, and do not make exploration endless by requiring every uncertainty to be resolved before moving on.

QUESTIONS
Ask one question at a time, only when the answer changes the argument. Good questions force a meaningful choice: which of two arguments is the one Ken wants to defend; what he observed in his own system; whether the interesting part is the problem or the approach; what would convince a skeptical reader. Prefer a concrete proposal over a question when a proposal is more useful.

CONVERGENCE
Adapt a sense of progression without forcing it. Early: identify possibilities, connections, and the interesting tension. Middle: compare interpretations, test tentative theses, challenge assumptions, and find supporting examples. Later: clarify the core argument, important gaps, boundaries, and summarize the emerging spine. When the idea is reasonably clear, say so and suggest switching to Guided; never switch automatically.

RESEARCH AND BOUNDARIES
- You may use read-only tools (web_search, web_fetch, file reads) for bounded verification when it genuinely improves the discussion. Do not hallucinate past decisions or research; distinguish established facts from assumptions.
- Do NOT produce an execution plan, checklist, outline, or draft unless Ken explicitly asks for a small illustrative sketch. Do NOT start publishing, messaging, editing files, deploying, or any consequential action. Keep the editorial Markdown style; no chat bubbles, no hidden reasoning.

WORKING BRIEF
Maintain a compact current understanding, not an essay and not a transcript summary. Update it only when the conversation materially changes it: a new direction, an explicit decision, a rejection, a constraint, a resolved question, or a thesis Ken accepts. Preserve Ken's explicit decisions and rejected directions. Keep agent proposals tentative until Ken accepts them. Do not let the brief grow indefinitely; the conversation is the full history.
Fields:
- working_thesis: one or two sentences; mark it tentative in the text if Ken has not accepted it
- tension: the problem, contradiction, or overlooked distinction that makes this worth exploring
- angle: the concrete angle, example, or system that makes it distinctive
- evidence: concrete examples, observations, or references (max 5)
- decisions: [{"text":"...","status":"established" | "tentative" | "rejected"}]
- unresolved: the one to three questions that matter most
- not_pursuing: explicit exclusions and rejected directions
- reader_takeaway: what should someone understand differently, if known
- boundaries: scope, tone, audience, or constraints
Return brief only when material; otherwise set "brief": null.

OUTPUT CONTRACT — return ONLY one JSON object, no prose before or after it:
{"reply":"<collaborative editorial markdown for Ken>","brief":{"working_thesis":"...","tension":"...","angle":"...","evidence":["..."],"decisions":[{"text":"...","status":"established"}],"unresolved":["..."],"not_pursuing":["..."],"reader_takeaway":"...","boundaries":["..."]} | null}
A prose reply instead of this object is a failed run. If nothing material changed, set "brief": null.`;
}

export function parseExploreResult(raw) {
  const text = extractAgentText(raw);
  const obj = inner(text);
  if (!obj || typeof obj !== 'object') return null;
  const reply = typeof obj.reply === 'string' ? obj.reply : (typeof obj.markdown === 'string' ? obj.markdown : '');
  if (!reply.trim()) return null;
  return { reply, brief: obj.brief && typeof obj.brief === 'object' ? obj.brief : null };
}

export function parseWorkResult(raw) {
  const text = extractAgentText(raw);
  const obj = inner(text);
  if (!obj || typeof obj !== 'object') return null;
  const reply = typeof obj.reply === 'string' ? obj.reply : (typeof obj.markdown === 'string' ? obj.markdown : '');
  if (!reply && !obj.plan && !obj.interaction && !obj.result) return null;
  return {
    reply,
    plan: obj.plan && typeof obj.plan === 'object' ? obj.plan : null,
    interaction: obj.interaction && typeof obj.interaction === 'object' ? obj.interaction : null,
    result: obj.result && typeof obj.result === 'object' ? obj.result : null,
    state: typeof obj.state === 'string' ? obj.state : null,
  };
}

async function handleWork(req, { api, runner, cached, checkpoint, token, timing }) {
  if (req.mode === 'explore') return handleExplore(req, { api, runner, cached, checkpoint, token, timing });
  const state = await api(`/work/${encodeURIComponent(req.work_id)}`);
  const prompt = buildWorkPrompt(state, req.mode);
  if (timing) timing.promptChars = prompt.length;
  const dir = mkdtempSync(join(tmpdir(), 'orbit-work-'));
  const sessionKey = `agent:main:orbit-work-${req.work_id}`;
  const raw = await runner(prompt, {
    sessionKey, cwd: dir,
    onSpawn: () => api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
      method: 'POST', body: JSON.stringify({ status: 'working', token }),
    }),
  });
  let result = parseWorkResult(raw);
  if (!result) {
    // One bounded repair: same session already holds the source and task.
    const repaired = await runner(
      'Return ONLY the required JSON object for the Work task above — no prose, no code fence. Include reply, and plan/interaction/result where applicable.',
      { sessionKey, cwd: dir },
    );
    result = parseWorkResult(repaired);
  }
  if (!result) throw new Error('work_contract_failed');
  checkpoint(result);
  const applied = await api(`/work/${encodeURIComponent(req.work_id)}/agent-result`, {
    method: 'POST',
    body: JSON.stringify({ actionId: req.id, token, ...result }),
  });
  if (applied.warning) console.warn(`[${req.id}] complete warning: ${applied.warning}`);
  return result;
}

async function handleExplore(req, { api, runner, cached, checkpoint, token, timing }) {
  const state = await api(`/work/${encodeURIComponent(req.work_id)}`);
  const prompt = buildExplorePrompt(state);
  if (timing) timing.promptChars = prompt.length;
  const dir = mkdtempSync(join(tmpdir(), 'orbit-explore-'));
  const sessionKey = `agent:main:orbit-explore-${req.work_id}`;
  const raw = await runner(prompt, {
    sessionKey, cwd: dir,
    onSpawn: () => api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
      method: 'POST', body: JSON.stringify({ status: 'working', token }),
    }),
  });
  let result = parseExploreResult(raw);
  if (!result) {
    const repaired = await runner(
      'Return ONLY the required Explore JSON object — reply markdown and an optional brief. No prose, no code fence.',
      { sessionKey, cwd: dir },
    );
    result = parseExploreResult(repaired);
  }
  if (!result) throw new Error('explore_contract_failed');
  checkpoint(result);
  const applied = await api(`/work/${encodeURIComponent(req.work_id)}/agent-result`, {
    method: 'POST',
    body: JSON.stringify({ actionId: req.id, token, reply: result.reply, brief: result.brief }),
  });
  if (applied.warning) console.warn(`[${req.id}] explore complete warning: ${applied.warning}`);
  return result;
}

export const handlers = {
  'work.plan': async (req, context) => handleWork(req, context),
  'work.explore': async (req, context) => handleExplore(req, context),
  'work.execute': async (req, context) => handleWork(req, context),
  'artifact.feedback': async (req, context) => handleArtifact(req, context),
  'artifact.workflow': async (req, context) => handleArtifact(req, context),
  'artifact.masthead': async (req, context) => handleMasthead(req, context),
  'artifact.publish': async (req, context) => handlePublish(req, context),
  'inbox.decision': async (req, context) => handleInbox(req, context),
};

function buildRepairPrompt(req, previous) {
  const ids = (req.critique?.findings || []).map((f) => f.id).filter(Boolean);
  return `Your previous response did not follow the required output contract, so this run produced no revision and no dispositions.

Return ONLY one JSON object now — no prose before or after it:
{"reply": "<short reply to Ken>", "markdown": "<the COMPLETE revised article, frontmatter included>", "dispositions": [${ids.map((id) => `{"findingId":"${id}","status":"addressed|retained|unresolved","note":"<one line when retained or unresolved>"}`).join(',') || '{"findingId":"<id>","status":"addressed|retained|unresolved","note":"..."}'}]}

Rules:
- "markdown" must be the whole document, not a description of edits. If nothing should change, send "".
- One disposition per critique finding id${ids.length ? `: ${ids.join(', ')}` : ''}.
- Do not invent changes to satisfy a finding.

If you cannot comply, return {"reply":"could not comply","markdown":"","dispositions":[]}.`;
}

async function downloadImages(req, api, dir, concurrency = 4) {
  const images = req.images || [];
  const ok = [];
  let cursor = 0;
  const lane = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= images.length) return;
      const image = images[index];
      try {
        const bytes = await api(`/images/${encodeURIComponent(image.id)}`, { raw: true });
        writeFileSync(join(dir, image.filename), bytes);
        ok[index] = image;
      } catch (error) {
        console.error(`[${req.id}] image ${image.id}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, images.length || 1) }, lane));
  return ok.filter(Boolean);
}

async function handleArtifact(req, { api, runner, cached, checkpoint, token, timing }) {
  const resultKind = req.result_kind || 'revision';
  const workflow = req.kind === 'workflow' ? (req.workflow || '') : '';
  const required = resultKind === 'review' ? (workflow || 'blog-critic') : 'blog-author';
  if (!skillPath(required)) throw new Error(`skill_unavailable: ${required}`);
  if (workflow && workflow !== 'blog-author' && !skillPath(workflow)) {
    throw new Error(`skill_unavailable: ${workflow}`);
  }
  let result = cached;
  if (!result) {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-artifact-'));
    const tImage = Date.now();
    // Bounded parallel downloads: a handful of images should not cost one RTT each.
    const manifest = await downloadImages(req, api, dir);
    if (timing) timing.imagesMs = Date.now() - tImage;
    const prompt = buildArtifactPrompt({ ...req, images: manifest });
    if (timing) timing.promptChars = prompt.length;
    const tAgent = Date.now();
    const raw = await runner(prompt, {
      sessionKey: `agent:main:orbit-artifact-${req.id}`, cwd: dir,
      onSpawn: () => {
        if (timing) timing.startMs = Date.now() - tAgent;
        return api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
          method: 'POST', body: JSON.stringify({ status: 'working', token }),
        });
      },
    });
    if (timing) timing.agentMs = Date.now() - tAgent;
    result = parseArtifactResult(raw, resultKind);
    // The contract can be missed (prose instead of JSON). One bounded repair call,
    // same session so the article and findings are already in context.
    const expected = (req.critique?.findings || []).length;
    if (resultKind === 'revision' && expected && (!result.markdown || !(result.dispositions || []).length)) {
      try {
        const repaired = await runner(buildRepairPrompt(req, raw), {
          sessionKey: `agent:main:orbit-artifact-${req.id}`, cwd: dir,
          onSpawn: () => api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
            method: 'POST', body: JSON.stringify({ status: 'working', token }),
          }),
        });
        const again = parseArtifactResult(repaired, resultKind);
        if (again.markdown || (again.dispositions || []).length) {
          result = { ...again, reply: again.reply || result.reply };
          if (timing) timing.repaired = true;
        }
      } catch (error) { console.error(`[${req.id}] contract repair: ${error.message}`); }
    }
    checkpoint(result);
  }
  if (result.reply) await api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
    method: 'POST', body: JSON.stringify({ status: 'working', reply: result.reply, token }),
  });

  // A review is a result in its own right: no document revision is created.
  if (result.review && Array.isArray(result.review.findings)) {
    const published = await api(`/artifacts/${encodeURIComponent(req.article_id)}/reviews`, {
      method: 'POST', body: JSON.stringify({
        revisionId: req.base?.id || null,
        workflow: req.workflow || 'blog-critic',
        actionId: req.id,
        summary: result.review.summary,
        findings: result.review.findings,
      }),
    });
    await api(`/agent/actions/${encodeURIComponent(req.id)}/complete`, {
      method: 'POST', body: JSON.stringify({ reply: result.reply, revisionId: null, token, dispositions: result.dispositions || [] }),
    });
    return { ...result, reviewId: published.review?.id || null, revisionId: null };
  }

  let revisionId = null;
  if (result.markdown) {
    const revision = await api(`/artifacts/${encodeURIComponent(req.article_id)}/revisions`, {
      method: 'POST', body: JSON.stringify({
        id: `revision_action_${req.id}`, markdown: result.markdown,
        source: req.kind || 'feedback', expectedRevisionId: req.base?.id || null,
      }),
    });
    revisionId = revision.revision?.id || null;
  }
  await api(`/agent/actions/${encodeURIComponent(req.id)}/complete`, {
    method: 'POST', body: JSON.stringify({ reply: result.reply, revisionId, token, dispositions: result.dispositions || [] }),
  });
  return { ...result, revisionId };
}

async function handleInbox(req, { api, runner, cached, checkpoint, token, timing }) {
  const result = cached || {
    reply: extractAgentText(await runner(buildInboxPrompt(req), {
      sessionKey: `agent:main:orbit-inbox-${req.id}`,
      onSpawn: () => api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
        method: 'POST', body: JSON.stringify({ status: 'working', token }),
      }),
    })).slice(0, 8000),
  };
  if (!cached) checkpoint(result);
  if (result.reply) await api(`/agent/actions/${encodeURIComponent(req.id)}/progress`, {
    method: 'POST', body: JSON.stringify({ status: 'working', reply: result.reply, token }),
  });
  await api(`/agent/actions/${encodeURIComponent(req.id)}/complete`, {
    method: 'POST', body: JSON.stringify({ reply: result.reply, token }),
  });
  return result;
}

export async function processRequest(req, { api, runner = runOpenClaw, ledger, worker = 'orbit-bridge' }) {
  const handler = handlers[req.action];
  if (!handler) throw new Error(`no handler for ${req.action}`);
  const claimed = await api(`/agent/actions/${encodeURIComponent(req.id)}/claim`, {
    method: 'POST', body: JSON.stringify({ worker }),
  });
  if (!claimed.ok) return { skipped: true, reason: claimed.reason || 'not_claimable' };
  const token = claimed.token;
  const claimedAt = Date.now();
  console.log(`[${req.id}] claimed ${req.action} attempt ${claimed.attempt}/${claimed.maxAttempts}`);
  // Keep the lease alive for the whole run, and stop it the moment the run ends.
  let lost = false;
  const heartbeatMs = Number(process.env.ORBIT_BRIDGE_HEARTBEAT_MS || 45000);
  const beat = async () => {
    try {
      await api(`/agent/actions/${encodeURIComponent(req.id)}/heartbeat`, {
        method: 'POST', body: JSON.stringify({ token }),
      });
    } catch (error) {
      if (/claim_lost|409/.test(error.message)) { lost = true; console.error(`[${req.id}] claim lost`); }
    }
  };
  const timer = setInterval(beat, heartbeatMs);
  try {
    const cached = ledger?.get(req.id);
    const timing = { queuedAt: req.created_at || null };
    const result = await handler(req, {
      api, runner, cached, token, timing, checkpoint: (value) => ledger?.set(req.id, value),
    });
    // Handler completed remotely before this deletion. A crash leaves a harmless cache entry.
    ledger?.delete(req.id);
    console.log(JSON.stringify({
      action: req.id, type: req.action, completed: true, revision: result.revisionId || null,
      queueMs: timing.queuedAt ? Math.max(0, claimedAt - Date.parse(timing.queuedAt)) : null,
      startMs: timing.startMs ?? null, imagesMs: timing.imagesMs ?? null,
      agentMs: timing.agentMs ?? null, totalMs: Date.now() - claimedAt,
      promptChars: timing.promptChars ?? null, attempt: claimed.attempt,
    }));
    return { ok: true, result };
  } catch (error) {
    if (lost) {
      console.error(`[${req.id}] abandoned: claim lost (another worker owns this action)`);
      return { skipped: true, reason: 'claim_lost' };
    }
    const retryable = Number(req.attempts || 0) + 1 < Number(req.max_attempts || 3);
    try {
      await api(`/agent/actions/${encodeURIComponent(req.id)}/fail`, {
        method: 'POST', body: JSON.stringify({ error: error.message, retryable, token }),
      });
    } catch (failError) { console.error(`[${req.id}] fail update: ${failError.message}`); }
    throw error;
  } finally {
    clearInterval(timer);
  }
}

async function main() {
  const base = process.env.ORBIT_BASE || DEFAULT_BASE;
  const token = process.env.ORBIT_TOKEN || process.env.ORBIT_ARTIFACT_BRIDGE_TOKEN || (() => {
    try { return readFileSync(join(homedir(), '.openclaw', 'workspace', 'secrets', 'orbit-artifact-bridge.token'), 'utf8').trim(); }
    catch { return ''; }
  })();
  if (!token) throw new Error('missing ORBIT_TOKEN or ORBIT_ARTIFACT_BRIDGE_TOKEN');
  const api = makeApi(base, token);
  const ledger = new ResultLedger(process.env.ORBIT_BRIDGE_LEDGER || DEFAULT_LEDGER);
  const worker = process.env.ORBIT_BRIDGE_WORKER || process.env.ORBIT_ARTIFACT_WORKER || 'felix-local';
  // Which agent runtime executes the action. Defaults to OpenClaw so existing
  // deployments are unaffected; set ORBIT_BRIDGE_RUNNER=hermes for a Hermes bridge.
  const runner = String(process.env.ORBIT_BRIDGE_RUNNER || 'openclaw').toLowerCase() === 'hermes'
    ? runHermes
    : runOpenClaw;
  console.log(`orbit bridge: base=${base} worker=${worker} runner=${runner === runHermes ? 'hermes' : 'openclaw'}`);
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  // Limited concurrency: independent actions must not queue behind one slow artifact,
  // while two actions on the same artifact stay strictly serial (no competing revisions).
  const maxConcurrent = Math.max(1, Number(process.env.ORBIT_BRIDGE_CONCURRENCY || 2));
  const inFlight = new Map(); // object key -> action id
  while (!stopping) {
    try {
      if (inFlight.size >= maxConcurrent) { await sleep(750); continue; }
      const { requests = [] } = await api('/agent/actions?limit=5');
      let started = 0;
      for (const req of requests) {
        if (stopping) break;
        if (inFlight.size >= maxConcurrent) break;
        const key = req.article_id || req.object_id || req.id;
        if (inFlight.has(key)) continue;
        inFlight.set(key, req.id);
        started += 1;
        processRequest(req, { api, ledger, worker, runner })
          .catch((error) => console.error(`[${req.id}] ${error.message}`))
          .finally(() => { inFlight.delete(key); });
      }
      await sleep(started ? 500 : (requests.length ? 1000 : 2000));
    } catch (error) {
      console.error(`poll error: ${error.message}`);
      await sleep(3000);
    }
  }
  // Drain in-flight runs so SIGTERM during a publish does not orphan the claim.
  const deadline = Date.now() + 30000;
  while (inFlight.size && Date.now() < deadline) await sleep(500);
  console.log(`bridge stopped (${inFlight.size} still in flight)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
