// Krillion Party: zero-dependency Node server (Node 18+). State is in memory; SSE for realtime.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000, KEY = process.env.ANTHROPIC_API_KEY, GROQ = process.env.GROQ_API_KEY;
const HAS = GROQ || KEY; // Groq wins if both are set; neither = mock grader
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
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GROQ },
      body: JSON.stringify({ model: GROQ_MODEL, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
    const d = await r.json(); if (!r.ok) throw new Error('AI error: ' + JSON.stringify(d).slice(0, 200));
    t = d.choices[0].message.content;
  } else {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, temperature: 0, system, messages: [{ role: 'user', content: user }] }) });
    const d = await r.json(); if (!r.ok) throw new Error('AI error: ' + JSON.stringify(d).slice(0, 200));
    t = d.content.map(c => c.text || '').join('');
  }
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}
const MOD_SYS = `You moderate trivia-style questions for a party game where players name things ("Name a type of pasta"). Approve only questions that are: objective (answers can be checked), fair (no personal/private knowledge), answerable (many valid answers), clear without context, allow answers from very common to very obscure, and appropriate (no offensive, discriminatory or sexually explicit content). Reject subjective ("coolest", "best"), personal, or too-narrow questions. Reply ONLY with JSON: {"approved":bool,"reason":string,"suggested_revision":string|null,"difficulty":1-5}`;
const GRADE_SYS = `You grade answers for a "nicheness" game. Step 1: is the answer valid for the question (accept synonyms, aliases, spelling variants, reasonable interpretations)? Step 2: if valid, assign exactly one category, judged RELATIVE TO THE QUESTION: "Plankton" (obvious, first thing most people say), "Schooler" (somewhat niche but recognizable), "Rare" (uncommon knowledge), "Deep Cut" (very obscure, needs specific knowledge), "One in a Krillion" (exceptionally obscure and hard to think of). Do not reward length or complexity by itself; an unusual answer isn't automatically a deep cut. Be consistent: identical answers always get identical categories. If a "Trap answer" is given, set matches_trap true only if the Answer is the same thing as the Trap answer (synonym, alias or spelling variant); still grade the category normally. Reply ONLY with JSON: {"valid":bool,"normalized_answer":string,"category":string,"matches_trap":bool,"reason":string}`;
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
function reset(r) { r.questions = {}; r.assign = {}; r.answers = {}; r.last = null; r.busy = new Set(); }
function assign(r) { // random cyclic derangement: nobody gets own question, every question answered once
  const s = shuffle([...r.players.keys()]); r.assign = {};
  s.forEach((au, i) => { r.assign[s[(i + 1) % s.length]] = au; }); r.phase = 'answering';
}
function finish(r) {
  const nm = id => r.players.get(id).name;
  const rows = Object.entries(r.assign).map(([ans, au]) => { const a = r.answers[ans], q = r.questions[au];
    return { authorId: au, author: nm(au), question: q.text, tooClever: q.tooClever, answererId: ans, answerer: nm(ans), answer: a.normalized,
      category: a.category, points: a.points, reason: a.reason, caught: q.tooClever ? a.category === 'Too Clever' : null }; });
  const scores = {};
  for (const p of r.players.values()) { // Round score = |nicheness I gave - nicheness my question received|
    const gave = rows.find(x => x.answererId === p.id), got = rows.find(x => x.authorId === p.id);
    const s = Math.abs(gave.points - got.points); p.score += s; scores[p.id] = { name: p.name, gave: gave.points, got: got.points, round: s };
  }
  r.last = { rows, scores }; r.history.push({ round: r.round, scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.round])) }); r.phase = 'results';
}
function view(r, pid) { // personalized: never leaks other players' questions/answers before reveal
  const online = id => [...r.clients].some(c => c.pid === id);
  const v = { code: r.code, phase: r.phase, round: r.round, hostId: r.hostId, me: pid, history: r.history,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready, score: p.score, online: online(p.id), hasQ: !!r.questions[p.id], hasA: !!r.answers[p.id] })) };
  if (r.phase === 'questions') v.myQuestion = r.questions[pid]?.text || null;
  if (r.phase === 'answering') v.task = r.answers[pid] ? null : { question: r.questions[r.assign[pid]].text };
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
    const text = clean(b.text, 120); if (!text) return { ok: false, reason: 'Type an answer.' };
    r.busy.add(p.id);
    try { const q = r.questions[r.assign[p.id]], g = await grade(q.text, text, q.tooClever);
      if (!g.valid) return { ok: false, reason: g.reason || 'That does not answer the question. Try again.' };
      if (r.phase !== 'answering') fail(409, 'Round changed');
      r.answers[p.id] = { normalized: clean(g.normalized_answer || text, 120), category: g.trap ? 'Too Clever' : g.category, points: g.trap ? 15 : CATS[g.category],
        reason: clean(g.reason, 300) + (g.trap ? ` Matched the question writer's Too Clever answer (would have been ${g.category}).` : '') };
      if (Object.keys(r.answers).length === r.players.size) finish(r);
      push(r); return { ok: true };
    } catch (e) { if (e.status) throw e; fail(502, 'Grading failed, try again'); } finally { r.busy.delete(p.id); } },
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
