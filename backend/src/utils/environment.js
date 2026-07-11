'use strict';

function rawEnvironmentName(env = process.env) {
  return String(env && env.NODE_ENV ? env.NODE_ENV : '').trim().toLowerCase();
}

function isProductionLike(env = process.env) {
  return rawEnvironmentName(env) === 'production';
}

function isInvalidEnvironmentAlias(env = process.env) {
  return rawEnvironmentName(env) === 'prod';
}

function normalizeEnvironmentName(env = process.env) {
  const name = rawEnvironmentName(env);
  if (name === 'production') return 'production';
  if (name === 'prod') return 'invalid';
  if (name === 'staging' || name === 'stage') return 'staging';
  if (name === 'test') return 'test';
  return 'development';
}

module.exports = {
  isInvalidEnvironmentAlias,
  isProductionLike,
  normalizeEnvironmentName,
  rawEnvironmentName,
};
