// Krillion Party: zero-dependency Node server (Node 18+). State is in memory; SSE for realtime.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000, KEY = process.env.ANTHROPIC_API_KEY, GROQ = process.env.GROQ_API_KEY;
const HAS = GROQ || KEY; // Groq wins if both are set; neither = mock grader
const ANSWER_MS = +process.env.ANSWER_MS || 25000; // time limit to answer
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
// Too Clever (15) is not gradable by nicheness: it applies only when an answer matches the question writer's optional trap answer.
const CATS = { Plankton: 10, Schooler: 30, Rare: 60, 'Deep Cut': 85, 'One in a Krillion': 100 };
const rooms = new Map();
const rid = () => Math.random().toString(36).slice(2, 10);
const fail = (s, m) => { throw Object.assign(new Error(m), { status: s }); };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const newCode = () => { let c; do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); while (rooms.has(c)); return c; };

// ---------- AI (server-side only) ----------
async function ai(system, user) {
  let t;
  if (GROQ) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GROQ },
      body: JSON.stringify({ model: GROQ_MODEL, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
    const d = await r.json(); if (!r.ok) throw new Error('AI error: ' + JSON.stringify(d).slice(0, 200));
    t = d.choices[0].message.content;
  } else {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, temperature: 0, system, messages: [{ role: 'user', content: user }] }) });
    const d = await r.json(); if (!r.ok) throw new Error('AI error: ' + JSON.stringify(d).slice(0, 200));
    t = d.content.map(c => c.text || '').join('');
  }
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}
const MOD_SYS = `You moderate trivia-style questions for a party game where players name things ("Name a type of pasta"). Approve only questions that are: objective (answers can be checked), fair (no personal/private knowledge), answerable (many valid answers), clear without context, allow answers from very common to very obscure, and appropriate (no offensive, discriminatory or sexually explicit content). Reject subjective ("coolest", "best"), personal, or too-narrow questions. Reply ONLY with JSON: {"approved":bool,"reason":string,"suggested_revision":string|null,"difficulty":1-5}`;
const GRADE_SYS = `You grade answers for a "nicheness" game. Follow these evaluation steps strictly:

Step 1: Validity and alias resolution
- Determine if the answer is valid for the question.
- Accept standard synonyms, official or unofficial aliases, common misspellings, localized names, and reasonable contextual interpretations.
- If the answer is not something you recognize but plausibly fits the question, treat it as valid and grade it Deep Cut or higher. If it looks made up, is gibberish, or clearly does not fit the question, it is invalid.
- If invalid, set valid to false, category to "Invalid", and explain in "reason".

Step 2: Context-relative nicheness
CORE RULE: Judge nicheness strictly relative to the domain defined by the Question, NEVER against general world knowledge.
- Assume the audience is knowledgeable about the topic of the question. Imagine 100 people who know this topic well and ask how many of them would think of this answer.
- Example: for a question about Quantum Physics, terms like "Photon" or "Electron" are "Plankton", even though the average person on the street might not know them.
- Example: for a niche topic like 1990s Anime Soundtracks, the most famous soundtrack is "Plankton", while an unreleased demo track is "One in a Krillion".

Assign EXACTLY ONE category:
- "Plankton": the top 1-3 immediate answers; roughly 80 or more of those 100 would think of it. Flagship examples, main characters, standard defaults.
- "Schooler": recognizable to most people familiar with the topic; roughly 40-79 of 100. Well-known secondary entries, popular side content.
- "Rare": requires solid familiarity with the topic; roughly 15-39 of 100. Lesser-known details that need active memory retrieval.
- "Deep Cut": requires dedicated knowledge; roughly 3-14 of 100. Background details, obscure spin-offs, minor entries, deep lore.
- "One in a Krillion": exceptionally rare even among topic experts; fewer than 3 of 100. Footnotes, single-frame cameos, unreleased media, hyper-specific edge cases within the exact scope of the question.
The percentages are rough guides, not exact cutoffs. If torn between two categories, pick the more common (lower) one.

Examples for the question "Name a Looney Tunes character": Bugs Bunny = Plankton. Foghorn Leghorn = Schooler. Gossamer = Rare. Michigan J. Frog = Deep Cut. Hubie and Bertie = One in a Krillion.

Evaluation rules:
1. Relative calibration: never call an answer "Deep Cut" just because the general public would not know it; judge it only against other answers to THAT question.
2. Obscurity vs complexity: word length or technical jargon does not determine nicheness. A simple answer can be "One in a Krillion" if it is virtually forgotten within the domain.
3. Consistency: identical answers to the same question must always get the same category.
4. Strict trap matching: set matches_trap to true ONLY if the Answer is the exact same underlying entity or concept as the Trap answer (accounting for aliases and synonyms). Always grade the category normally regardless of a trap match.

Reply ONLY with valid JSON, writing "reason" (one short sentence) BEFORE "category":
{"valid": bool, "normalized_answer": "string", "reason": "string", "category": "string", "matches_trap": bool}`;
const mockMod = q => { const bad = /\b(best|cool|coolest|favou?rite|yesterday|i|my|me)\b/i.test(q) || q.trim().length < 10;
  return { approved: !bad, reason: bad ? '[MOCK] Too short or subjective/personal.' : '[MOCK] Looks fine.', suggested_revision: null, difficulty: 3 }; };
const mockGrade = (q, a, tc) => { let h = 0; for (const c of a.toLowerCase().trim()) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return { valid: a.trim().length > 0, normalized_answer: a.trim(), category: Object.keys(CATS)[h % 5], matches_trap: !!tc && a.trim().toLowerCase() === tc.trim().toLowerCase(), reason: '[MOCK] Deterministic hash grade; set ANTHROPIC_API_KEY for real grading.' }; };
const moderate = q => HAS ? ai(MOD_SYS, `Question: ${q}`) : mockMod(q);
async function grade(q, a, tc) {
  const g = HAS ? await ai(GRADE_SYS, `Question: ${q}\nAnswer: ${a}` + (tc ? `\nTrap answer: ${tc}` : '')) : mockGrade(q, a, tc); // player identity never sent
  if (g.valid && !(g.category in CATS)) g.category = 'Plankton'; // e.g. a stray "Too Clever" is coerced
  g.trap = !!(g.valid && tc && g.matches_trap);
  return g;
}

// ---------- game logic ----------
const timeoutAns = () => ({ normalized: '(no answer)', category: 'No answer', points: 0, reason: 'Ran out of time.' });
function fillMissing(r) { for (const id of r.players.keys()) if (!r.answers[id] && !r.busy.has(id)) r.answers[id] = timeoutAns(); }
function tryFinish(r) { if (r.phase === 'answering' && Object.keys(r.answers).length === r.players.size) finish(r); push(r); }
function reset(r) { r.questions = {}; r.assign = {}; r.answers = {}; r.last = null; r.busy = new Set(); }
function assign(r) { // random cyclic derangement: nobody gets own question, every question answered once
  const s = shuffle([...r.players.keys()]); r.assign = {};
  s.forEach((au, i) => { r.assign[s[(i + 1) % s.length]] = au; }); r.phase = 'answering';
  r.deadline = Date.now() + ANSWER_MS; const rd = r.round;
  setTimeout(() => { if (r.phase === 'answering' && r.round === rd) { fillMissing(r); tryFinish(r); } }, ANSWER_MS + 500);
}
function finish(r) {
  const nm = id => r.players.get(id).name;
  const rows = Object.entries(r.assign).map(([ans, au]) => { const a = r.answers[ans], q = r.questions[au];
    return { authorId: au, author: nm(au), question: q.text, tooClever: q.tooClever, answererId: ans, answerer: nm(ans), answer: a.normalized,
      category: a.category, points: a.points, reason: a.reason, caught: q.tooClever ? a.category === 'Too Clever' : null }; });
  const scores = {};
  for (const p of r.players.values()) { // Round score = nicheness I gave - nicheness my question received (can be negative)
    const gave = rows.find(x => x.answererId === p.id), got = rows.find(x => x.authorId === p.id);
    const s = gave.points - got.points; p.score += s; scores[p.id] = { name: p.name, gave: gave.points, got: got.points, round: s };
  }
  r.last = { rows, scores }; r.history.push({ round: r.round, scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.round])) }); r.phase = 'results';
}
function view(r, pid) { // personalized: never leaks other players' questions/answers before reveal
  const online = id => [...r.clients].some(c => c.pid === id);
  const v = { code: r.code, phase: r.phase, round: r.round, hostId: r.hostId, me: pid, history: r.history,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready, score: p.score, online: online(p.id), hasQ: !!r.questions[p.id], hasA: !!r.answers[p.id] })) };
  if (r.phase === 'questions') v.myQuestion = r.questions[pid]?.text || null;
  if (r.phase === 'answering') v.task = r.answers[pid] ? null : { question: r.questions[r.assign[pid]].text };
  if (r.phase === 'answering') v.msLeft = Math.max(0, r.deadline - Date.now());
  if (r.phase === 'results') v.results = r.last;
  return v;
}
const push = r => r.clients.forEach(c => c.res.write(`data:${JSON.stringify(view(r, c.pid))}\n\n`));
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function ctx(b) { const r = rooms.get(clean(b.code, 4).toUpperCase()); if (!r) fail(404, 'Room not found');
  const pid = r.tok.get(b.token); if (!pid) fail(403, 'Not in this room'); return [r, r.players.get(pid)]; }
function addPlayer(r, token, name) { const p = { id: rid(), name, ready: false, score: 0 }; r.players.set(p.id, p); r.tok.set(token, p.id); return p; }

const act = {
  create(b) { const name = clean(b.name, 20); if (!name || !b.token) fail(400, 'Name required');
    const r = { code: newCode(), hostId: null, phase: 'lobby', round: 0, players: new Map(), tok: new Map(), clients: new Set(), history: [] };
    reset(r); rooms.set(r.code, r); r.hostId = addPlayer(r, b.token, name).id; return { code: r.code }; },
  join(b) { const r = rooms.get(clean(b.code, 4).toUpperCase()); if (!r) fail(404, 'Room not found');
    if (r.tok.has(b.token)) return { code: r.code }; // refresh/rejoin
    const name = clean(b.name, 20); if (!name) fail(400, 'Name required');
    if (r.phase !== 'lobby') fail(409, 'Game already started');
    if (r.players.size >= 12) fail(409, 'Room full');
    if ([...r.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) fail(409, 'Name taken');
    addPlayer(r, b.token, name); push(r); return { code: r.code }; },
  ready(b) { const [r, p] = ctx(b); if (r.phase !== 'lobby') fail(409, 'Not in lobby'); p.ready = !p.ready; push(r); return {}; },
  start(b) { const [r, p] = ctx(b); if (p.id !== r.hostId) fail(403, 'Host only'); if (r.phase !== 'lobby') fail(409, 'Already started');
    if (r.players.size < 3) fail(400, 'Need at least 3 players'); if ([...r.players.values()].some(x => !x.ready)) fail(400, 'Everyone must be ready');
    r.round = 1; r.phase = 'questions'; push(r); return {}; },
  async question(b) { const [r, p] = ctx(b); if (r.phase !== 'questions') fail(409, 'Not accepting questions');
    if (r.questions[p.id] || r.busy.has(p.id)) fail(409, 'Already submitted');
    const text = clean(b.text, 200); if (text.length < 3) return { approved: false, reason: 'Question is empty.' };
    r.busy.add(p.id);
    try { const m = await moderate(text); if (!m.approved) return m;
      if (r.phase !== 'questions') fail(409, 'Round changed');
      r.questions[p.id] = { text, tooClever: clean(b.tooClever, 120) || null };
      if (Object.keys(r.questions).length === r.players.size) assign(r);
      push(r); return { approved: true, difficulty: m.difficulty };
    } catch (e) { if (e.status) throw e; fail(502, 'Moderation failed, try again'); } finally { r.busy.delete(p.id); } },
  async answer(b) { const [r, p] = ctx(b); if (r.phase !== 'answering') fail(409, 'Not answering');
    if (r.answers[p.id] || r.busy.has(p.id)) fail(409, 'Already answered');
    if (Date.now() > r.deadline) fail(409, 'Time is up!');
    const text = clean(b.text, 120); if (!text) return { ok: false, reason: 'Type an answer.' };
    r.busy.add(p.id);
    try { const q = r.questions[r.assign[p.id]], g = await grade(q.text, text, q.tooClever);
      if (!g.valid) { if (Date.now() > r.deadline && r.phase === 'answering') { r.answers[p.id] = timeoutAns(); tryFinish(r); return { ok: false, reason: 'Time is up!' }; }
        return { ok: false, reason: g.reason || 'That does not answer the question. Try again.' }; }
      if (r.phase !== 'answering') fail(409, 'Round changed');
      r.answers[p.id] = { normalized: clean(g.normalized_answer || text, 120), category: g.trap ? 'Too Clever' : g.category, points: g.trap ? 15 : CATS[g.category],
        reason: clean(g.reason, 300) + (g.trap ? ` Matched the question writer's Too Clever answer (would have been ${g.category}).` : '') };
      tryFinish(r); return { ok: true };
    } catch (e) { if (e.status) throw e; if (Date.now() > r.deadline && r.phase === 'answering' && !r.answers[p.id]) { r.answers[p.id] = timeoutAns(); tryFinish(r); } fail(502, 'Grading failed, try again'); } finally { r.busy.delete(p.id); } },
  next(b) { const [r, p] = ctx(b); if (p.id !== r.hostId) fail(403, 'Host only'); if (r.phase !== 'results') fail(409, 'Round not finished');
    r.round++; reset(r); r.phase = 'questions'; push(r); return {}; },
};

const send = (res, s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (u.pathname === '/events' || u.pathname === '/api/state')) {
      const r = rooms.get((u.searchParams.get('code') || '').toUpperCase()), pid = r?.tok.get(u.searchParams.get('token'));
      if (!pid) return send(res, 404, { error: 'No such session' });
      if (u.pathname === '/api/state') return send(res, 200, view(r, pid));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const c = { pid, res }; r.clients.add(c); req.on('close', () => { r.clients.delete(c); push(r); }); return push(r);
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      const fn = act[u.pathname.slice(5)]; if (!fn) return send(res, 404, { error: 'Unknown action' });
      let body = ''; for await (const ch of req) { body += ch; if (body.length > 1e5) fail(413, 'Too big'); }
      return send(res, 200, await fn.call(act, JSON.parse(body || '{}')));
    }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'public/index.html'))); }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
}).listen(PORT, () => console.log(`Krillion Party on :${PORT} (${GROQ ? 'Groq ' + GROQ_MODEL : KEY ? 'Claude ' + MODEL : 'MOCK AI: set GROQ_API_KEY or ANTHROPIC_API_KEY'})`));
