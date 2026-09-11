const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shutdownTunnels } = require('./shutdown.cjs');
test('quit leaves inactive and unknown tunnels untouched', async () => {
  const calls = []; const logs = [];
  const result = await shutdownTunnels({ profiles: async () => [
    { id: 'wg1', active: false, statusUnknown: false },
    { id: 'wg2', active: false, statusUnknown: true },
  ], downTunnel: async profile => calls.push(profile.id), log: message => logs.push(message) });
  assert.deepEqual(result, { stopped: 0, total: 0 });
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 0);
});
test('quit disconnects every confirmed-active tunnel', async () => {
  const calls = []; const logs = [];
  const result = await shutdownTunnels({ profiles: async () => [
    { id: 'wg1', active: true },
    { id: 'wg2', active: true },
  ], downTunnel: async profile => calls.push(profile.id), log: message => logs.push(message) });
  assert.deepEqual(result, { stopped: 2, total: 2 });
  assert.deepEqual(calls.sort(), ['wg1', 'wg2']);
  assert.equal(logs.length, 0);
});
test('one failed tunnel does not stop the others and needs no timeout note', async () => {
  const calls = []; const logs = [];
  const result = await shutdownTunnels({ profiles: async () => [
    { id: 'wg1', active: true },
    { id: 'wg2', active: true },
  ], downTunnel: async profile => { if (profile.id === 'wg2') throw Error('boom'); calls.push(profile.id) }, log: message => logs.push(message) });
  assert.deepEqual(result, { stopped: 1, total: 2 });
  assert.deepEqual(calls, ['wg1']);
  assert.equal(logs.length, 0);
});
test('a hanging disconnect cannot hold quit past the timeout', async () => {
  const logs = [];
  const started = Date.now();
  const result = await shutdownTunnels({ profiles: async () => [{ id: 'wg1', active: true }], downTunnel: () => new Promise(() => {}), log: message => logs.push(message), timeout: 60 });
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(result, { stopped: 0, total: 1 });
  assert.deepEqual(logs, ['Не все туннели успели отключиться при завершении']);
});
test('unreadable tunnel list logs and quits without throwing', async () => {
  const logs = [];
  const result = await shutdownTunnels({ profiles: async () => { throw Error('no such file') }, downTunnel: async () => assert.fail('must not run'), log: message => logs.push(message) });
  assert.deepEqual(result, { stopped: 0, total: 0 });
  assert.deepEqual(logs, ['Ошибка чтения состояния']);
});
