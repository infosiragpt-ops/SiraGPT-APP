'use strict';

const { Scheduler } = require('./scheduler');
const { Job, STATE } = require('./job');
const { InMemoryStore, PrismaStore } = require('./store');
const { parseSchedule, parseCron, parseInterval, nextAfter, CronParseError } = require('./cron');

let _singleton = null;

function getScheduler(opts) {
  if (!_singleton) _singleton = new Scheduler(opts);
  return _singleton;
}

module.exports = {
  Scheduler,
  Job,
  STATE,
  InMemoryStore,
  PrismaStore,
  parseSchedule,
  parseCron,
  parseInterval,
  nextAfter,
  CronParseError,
  getScheduler,
};
