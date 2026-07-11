'use strict';

/**
 * Spotify OAuth `state` must be a signed token, not the bare userId — otherwise
 * an attacker who completes consent can tamper `state` to a victim's id and
 * overwrite the victim's stored Spotify tokens (account-linking CSRF). These
 * tests cover the signState/verifyState round-trip + rejection of tampered,
 * foreign-secret, wrong-kind, and the OLD raw-userId state.
 */

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-spotify-oauth-secret-at-least-32-chars!!';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI
  || 'https://api.example.test/oauth/spotify/callback';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const spotify = require('../src/services/spotify-mcp');

test('signState → verifyState round-trips the userId', async () => {
  const token = await spotify.signState('user-123');
  assert.notEqual(token, 'user-123', 'state is signed, not the raw id');
  assert.equal(await spotify.verifyState(token), 'user-123');
});

test('verifyState rejects a raw userId (the old vulnerable state format)', async () => {
  // Pre-fix, the callback trusted `state` AS the userId. That must now fail.
  assert.equal(await spotify.verifyState('victim-user-id'), null);
});

test('verifyState rejects a token signed with a different secret', async () => {
  const forged = jwt.sign({ uid: 'victim', kind: 'spotify_oauth' }, 'attacker-secret');
  assert.equal(await spotify.verifyState(forged), null);
});

test('verifyState rejects a token with the wrong kind', async () => {
  const wrongKind = jwt.sign({ uid: 'victim', kind: 'github_oauth' }, process.env.JWT_SECRET);
  assert.equal(await spotify.verifyState(wrongKind), null);
});

test('verifyState rejects garbage / empty / null', async () => {
  for (const bad of ['', null, undefined, 'not.a.jwt', 123]) {
    assert.equal(await spotify.verifyState(bad), null);
  }
});
