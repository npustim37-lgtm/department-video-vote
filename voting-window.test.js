import test from 'node:test';
import assert from 'node:assert/strict';
import { votingPhase } from './src/voting-window.js';

test('投票模式與時段邊界', () => {
  const opens_at = '2026-10-11T02:00:00Z';
  const closes_at = '2026-10-11T04:00:00Z';
  const before = Date.parse('2026-10-11T01:59:59Z');
  const start = Date.parse(opens_at);
  const end = Date.parse(closes_at);
  assert.equal(votingPhase({ mode: 'scheduled', opens_at, closes_at }, before), 'upcoming');
  assert.equal(votingPhase({ mode: 'scheduled', opens_at, closes_at }, start), 'open');
  assert.equal(votingPhase({ mode: 'scheduled', opens_at, closes_at }, end), 'ended');
  assert.equal(votingPhase({ mode: 'closed', opens_at, closes_at }, start), 'closed');
  assert.equal(votingPhase({ mode: 'open' }, end), 'open');
  assert.equal(votingPhase({ mode: 'open', closes_at }, end), 'ended');
});
