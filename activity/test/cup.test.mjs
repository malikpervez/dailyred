// Tests for the Cup's player-vs-player battles (cup.mjs, cup-engine.mjs):
//   cd activity && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Dex } from '@pkmn/sim';
import { createApp } from '../app.mjs';
import { createCup } from '../cup.mjs';
import { openStore } from '../store.mjs';
import { generateTeam } from '../../web/battle/team.js';

const dex = Dex.forGen(3);
const USERS = {
  'token-ash': { id: '101', username: 'ash', global_name: 'Ash' },
  'token-misty': { id: '202', username: 'misty', global_name: 'Misty' },
  'token-gary': { id: '303', username: 'gary', global_name: 'Gary' },
};
const fakeDiscord = async (url, init = {}) => {
  const user = USERS[init.headers?.Authorization?.replace('Bearer ', '')];
  return new Response(JSON.stringify(user ?? { message: '401' }), { status: user ? 200 : 401, headers: { 'Content-Type': 'application/json' } });
};

// A server around `store` with its own Cup (a fresh one = a restarted server).
async function serve(store, clock) {
  const finished = [];
  const cup = createCup({ store, loadEngine: () => import('../cup-engine.mjs'), now: () => clock.time, onFinished: (id, r) => finished.push([id, r]), log: { warn() {} } });
  const server = createServer(createApp({ webRoot: '.', store, clientId: '1', clientSecret: 's', fetch: fakeDiscord, cup }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, token, body) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, ...(await res.json()) };
  };
  // Reads the event stream until `until(events)` (or 5 seconds), then hangs up.
  const listen = async (path, token, until, headers = {}) => {
    const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}`, ...headers } });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    const events = [];
    let buffer = '';
    const deadline = Date.now() + 5000;
    while (!until(events) && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise((ok) => setTimeout(() => ok({}), 200))]);
      if (done) break;
      if (value) buffer += new TextDecoder().decode(value);
      for (let i; (i = buffer.indexOf('\n\n')) >= 0;) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        // (The "live" marker, after catching up, isn't one of the battle's events.)
        if (data && JSON.parse(data).kind !== 'live') events.push({ n: Number(/^id: (\d+)$/m.exec(block)?.[1]), ...JSON.parse(data) });
      }
    }
    await reader.cancel();
    return events;
  };
  return { cup, call, listen, finished, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }) };
}

const lastRequest = (events) => events.filter((e) => e.kind === 'request').at(-1)?.request;
const logText = (events) => events.filter((e) => e.kind === 'log').map((e) => e.text).join('\n');

test("two players battle through the server, each seeing only what they're allowed to", async () => {
  const store = openStore(':memory:');
  const clock = { time: Date.parse('2026-11-24T20:00:00Z') };
  let site = await serve(store, clock);
  try {
    const id = await site.cup.create({
      p1: { id: '101', name: 'Ash', team: generateTeam(dex, 11, 2) },
      p2: { id: '202', name: 'Misty', team: generateTeam(dex, 22, 2) },
    });

    const ash = await site.call(`/api/cup/battles/${id}`, 'token-ash');
    assert.deepEqual([ash.me, ash.players.p2.name, ash.team.length, ash.ended], ['p1', 'Misty', 6, false]);
    assert.equal((await site.call(`/api/cup/battles/${id}`, 'token-misty')).me, 'p2');
    const gary = await site.call(`/api/cup/battles/${id}`, 'token-gary');
    assert.deepEqual([gary.me, gary.team], ['spectator', null], 'others can watch, without the teams');
    assert.equal((await site.call(`/api/cup/battles/${id}`, 'nobody')).status, 401);

    // Each player's stream: the battle so far and their own request.
    const ashEvents = await site.listen(`/api/cup/battles/${id}/events`, 'token-ash', (e) => lastRequest(e));
    const mistyEvents = await site.listen(`/api/cup/battles/${id}/events`, 'token-misty', (e) => lastRequest(e));
    assert.match(logText(ashEvents), /\|player\|p2\|Misty\|/);
    assert.equal(lastRequest(ashEvents).side.id, 'p1');
    assert.equal(lastRequest(mistyEvents).side.id, 'p2');
    assert.ok(!mistyEvents.some((e) => e.kind === 'request' && e.request.side.id === 'p1'), "Misty never gets Ash's requests");
    assert.doesNotMatch(logText(mistyEvents), /\|switch\|p1a: [^|]+\|[^|]+\|\d+\/(?!100\b)\d+/, "nor Ash's exact HP");
    assert.match(logText(ashEvents), /\|switch\|p1a: [^|]+\|[^|]+\|\d+\/(?!100\b)\d+/, 'Ash sees his own');
    assert.deepEqual((await site.call(`/api/cup/battles/${id}`, 'token-ash')).waitingOn, ['p1', 'p2']);

    // Choices: only your own battle, only the current turn, only real moves.
    const rqid = lastRequest(ashEvents).rqid;
    assert.equal((await site.call(`/api/cup/battles/${id}/choose`, 'token-gary', { choice: 'move 1' })).status, 403);
    assert.equal((await site.call(`/api/cup/battles/${id}/choose`, 'token-ash', { choice: 'move 1', rqid: rqid - 1 })).status, 409);
    assert.match((await site.call(`/api/cup/battles/${id}/choose`, 'token-ash', { choice: 'move 9', rqid })).error, /doesn't have a move 9/);
    assert.equal((await site.call(`/api/cup/battles/${id}/choose`, 'token-ash', { choice: 'move 1', rqid })).ok, true);
    assert.deepEqual((await site.call(`/api/cup/battles/${id}`, 'token-ash')).waitingOn, ['p2'], 'it waits for Misty');
    await site.call(`/api/cup/battles/${id}/choose`, 'token-misty', { choice: 'move 1', rqid: lastRequest(mistyEvents).rqid });

    // Picking up where the stream left off (Last-Event-ID): only what's new.
    const lastSeen = ashEvents.at(-1).n;
    const newer = await site.listen(`/api/cup/battles/${id}/events`, 'token-ash', (e) => /\|turn\|2/.test(logText(e)), { 'Last-Event-ID': String(lastSeen) });
    assert.ok(newer[0].n === lastSeen + 1, 'continues from the next event');
    assert.match(logText(newer), /\|turn\|2/);

    // The server restarts: the battle is rebuilt from what was saved, to the event.
    const before = (await site.listen(`/api/cup/battles/${id}/events`, 'token-misty', (e) => /\|turn\|2/.test(logText(e)))).map((e) => e.kind);
    await site.close();
    site = await serve(store, clock);
    const after = await site.listen(`/api/cup/battles/${id}/events`, 'token-misty', (e) => e.length >= before.length);
    assert.deepEqual(after.map((e) => e.kind), before);
    assert.deepEqual((await site.call(`/api/cup/battles/${id}`, 'token-ash')).waitingOn, ['p1', 'p2']);

    // Ash moves; Misty walks away. At the match's deadline she's the one
    // holding it up, so she loses.
    const sofar = await site.listen(`/api/cup/battles/${id}/events`, 'token-ash', (e) => /\|turn\|2/.test(logText(e)) && lastRequest(e));
    await site.call(`/api/cup/battles/${id}/choose`, 'token-ash', { choice: 'move 1', rqid: lastRequest(sofar).rqid });
    assert.deepEqual((await site.call(`/api/cup/battles/${id}`, 'token-ash')).waitingOn, ['p2']);
    assert.equal(await site.cup.timeOut(id), 'p2');
    assert.deepEqual(site.finished.map(([b, r]) => [b, r.winner, r.how, r.players.p1, r.left.p1]), [[id, 'p1', 'timeout', '101', 6]]);
    assert.equal((await site.call(`/api/cup/battles/${id}/choose`, 'token-misty', { choice: 'move 1' })).status, 400, 'over is over');
    assert.equal(await site.cup.timeOut(id), null);

    // Another: Ash gives up. The bracket hears which match it was.
    const teams = { p1: { id: '101', name: 'Ash', team: generateTeam(dex, 11, 2) }, p2: { id: '202', name: 'Misty', team: generateTeam(dex, 22, 2) } };
    const second = await site.cup.create({ ...teams, context: { cupId: 'g:2026-12', match: 'W1-1' } });
    assert.deepEqual((await site.call(`/api/cup/battles/${second}`, 'token-misty')).context, { cupId: 'g:2026-12', match: 'W1-1' });
    const done = await site.call(`/api/cup/battles/${second}/choose`, 'token-ash', { choice: 'forfeit' });
    assert.deepEqual([done.ended, done.winner], [true, 'p2']);
    assert.deepEqual([site.finished.at(-1)[1].how, site.finished.at(-1)[1].context.match], ['gave up', 'W1-1']);

    // One nobody ever moved in: a coin toss at the deadline.
    const third = await site.cup.create(teams);
    assert.equal(await site.cup.timeOut(third, () => 0.9), 'p2');
    assert.equal(site.finished.at(-1)[1].winner, 'p1');
    assert.equal((await site.call('/api/cup/battles/nope1234', 'token-ash')).status, 404);
  } finally {
    await site.close();
  }
});
