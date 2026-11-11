const { spawn } = require('child_process');
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: 3111, ANSWER_MS: 1500, ANTHROPIC_API_KEY: '', GROQ_API_KEY: '' } });
const B = 'http://localhost:3111';
const post = async (a, b) => { const r = await fetch(B + '/api/' + a, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { s: r.status, ...(await r.json()) }; };
const state = async (c, t) => (await fetch(`${B}/api/state?code=${c}&token=${t}`)).json();
const ok = (c, m) => { if (!c) { console.error('FAIL', m); srv.kill(); process.exit(1); } console.log('ok  ', m); };
const names = ['Oscar', 'Alex', 'Sam'], T = names.map(n => 'tok-' + n);
(async () => {
  await new Promise(r => setTimeout(r, 600));
  const code = (await post('create', { token: T[0], name: 'Oscar' })).code;
  for (let i = 1; i < 3; i++) ok((await post('join', { token: T[i], code, name: names[i] })).s === 200, 'join ' + names[i]);
  ok((await post('start', { token: T[0], code })).s === 400, 'cannot start before ready');
  for (const t of T) await post('ready', { token: t, code });
  ok((await post('start', { token: T[0], code })).s === 200, 'host starts');
  const total = {};
  for (let round = 1; round <= 2; round++) {
    ok((await post('question', { token: T[0], code, text: 'best thing?' })).approved === false, 'subjective question rejected');
    for (let i = 0; i < 3; i++) ok((await post('question', { token: T[i], code, text: `Name a type of pasta (${round}-${names[i]})`, tooClever: `answer0-r${round}` })).approved, 'question approved ' + names[i]);
    const tasks = [];
    for (let i = 0; i < 3; i++) { const s = await state(code, T[i]); ok(s.phase === 'answering', names[i] + ' sees answering');
      tasks.push(s.task.question); ok(!s.task.question.includes(names[i]), names[i] + ' did not get own question'); ok(!/"answer"|"tooClever"/.test(JSON.stringify(s)), 'no leaks'); }
    ok(new Set(tasks).size === 3, 'each question assigned exactly once');
    ok((await post('answer', { token: T[0], code, text: '  ' })).ok === false, 'empty answer rejected, retry allowed');
    for (let i = 0; i < 3; i++) { ok((await post('answer', { token: T[i], code, text: `answer${i}-r${round}` })).ok, 'answered ' + names[i]);
      ok((await post('answer', { token: T[i], code, text: 'again' })).s === 409, 'duplicate blocked'); }
    const s = await state(code, T[1]); ok(s.phase === 'results', 'results revealed');
    const P = { 'Too Clever': 15, Plankton: 10, Schooler: 30, Rare: 60, 'Deep Cut': 85, 'One in a Krillion': 100 };
    for (const row of s.results.rows) ok(P[row.category] === row.points, `points match category (${row.category}=${row.points})`);
    for (const p of s.players) { const gave = s.results.rows.find(x => x.answererId === p.id).points, got = s.results.rows.find(x => x.authorId === p.id).points;
      total[p.id] = (total[p.id] || 0) + (gave - got); ok(s.results.scores[p.id].round === gave - got, `${p.name}: ${gave}-${got} signed round score`); ok(p.score === total[p.id], `${p.name} cumulative = ${total[p.id]}`); }
    const hit = s.results.rows.filter(x => x.caught); ok(hit.length === 1 && hit[0].answer === `answer0-r${round}` && hit[0].points === 15 && hit[0].category === 'Too Clever', 'Too Clever trap caught and scored 15'); ok(s.results.rows.filter(x => x.category === 'Too Clever').length === 1, 'only matching answer is Too Clever');
    ok((await post('next', { token: T[0], code })).s === 200, 'next round');
  }
  for (let i = 0; i < 3; i++) await post('question', { token: T[i], code, text: `Name a type of pasta (3-${names[i]})` });
  for (let i = 0; i < 2; i++) await post('answer', { token: T[i], code, text: `answer${i}-r3` });
  await new Promise(r => setTimeout(r, 2500));
  const s3 = await state(code, T[0]); ok(s3.phase === 'results', 'timer ends the round');
  const late = s3.results.rows.find(x => x.answerer === 'Sam'); ok(late.category === 'No answer' && late.points === 0, 'timed-out player gets 0');
  ok((await post('answer', { token: T[2], code, text: 'late' })).s === 409, 'late answer rejected');
  console.log('\nALL PASSED'); srv.kill();
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
