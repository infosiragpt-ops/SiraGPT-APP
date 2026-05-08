/**
 * Health module barrel — exposes the registry, probe primitives and
 * built-in dependency probes.
 */

'use strict';

const probe = require('./probe');
// Re-exports `percentile` and `summarizeHistory` along with the core primitives.
const { createDbProbe }       = require('./probes/db');
const { createRedisProbe }    = require('./probes/redis');
const { createDiskProbe }     = require('./probes/disk');
const { createMemoryProbe }   = require('./probes/memory');
const { createOpenAIProbe }   = require('./probes/provider-openai');
const {
  createSyntheticPingProbe,
  SyntheticPingSampler,
} = require('./probes/synthetic-ping');

module.exports = {
  ...probe,
  createDbProbe,
  createRedisProbe,
  createDiskProbe,
  createMemoryProbe,
  createOpenAIProbe,
  createSyntheticPingProbe,
  SyntheticPingSampler,
};
