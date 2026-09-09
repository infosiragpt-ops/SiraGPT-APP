'use strict';

const todos = [];

function add(title) {
  const item = { id: todos.length + 1, title: String(title || ''), done: false };
  todos.push(item);
  return item;
}

function list() {
  return todos.slice();
}

function complete(id) {
  const item = todos.find((t) => t.id === Number(id));
  if (!item) return null;
  item.done = true;
  return item;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'add') return add(rest.join(' '));
  if (cmd === 'complete') return complete(rest[0]);
  return list();
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
}

module.exports = { add, list, complete, main };
