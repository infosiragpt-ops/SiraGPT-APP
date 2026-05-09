'use strict';

/**
 * trie — Unicode-safe prefix tree for autocomplete and prefix
 * dictionaries. Pairs with Levenshtein (#49, typo tolerance) and
 * BM25 (#33, ranked search): the trie is the "what starts with"
 * primitive that backs slash-command palettes, tool-name
 * autocomplete, and path matching.
 *
 * Iteration is in insertion order at each level (Map preserves
 * insertion order). prefixSearch returns matches in lexicographic-
 * by-character order with optional `limit` early-exit.
 *
 * Public API:
 *   const t = createTrie()
 *   t.add(word, value?)             — value defaults to true
 *   t.remove(word)                  → boolean
 *   t.has(word)                     → boolean (exact match)
 *   t.get(word)                     → value | undefined
 *   t.prefixSearch(prefix, { limit }) → [{ word, value }, ...]
 *   t.size()
 *   t.snapshot()
 */

function createNode() {
  return { children: new Map(), terminal: false, value: undefined };
}

function createTrie() {
  const root = createNode();
  let count = 0;

  function add(word, value) {
    if (typeof word !== 'string' || !word) throw new TypeError('trie.add: non-empty string required');
    let node = root;
    for (const ch of word) {
      let next = node.children.get(ch);
      if (!next) { next = createNode(); node.children.set(ch, next); }
      node = next;
    }
    if (!node.terminal) count += 1;
    node.terminal = true;
    node.value = value === undefined ? true : value;
  }

  function findNode(prefix) {
    let node = root;
    for (const ch of prefix) {
      const next = node.children.get(ch);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  function has(word) {
    const n = findNode(word);
    return Boolean(n && n.terminal);
  }

  function get(word) {
    const n = findNode(word);
    return n && n.terminal ? n.value : undefined;
  }

  function remove(word) {
    if (typeof word !== 'string' || !word) return false;
    const path = [];
    let node = root;
    for (const ch of word) {
      const next = node.children.get(ch);
      if (!next) return false;
      path.push([node, ch, next]);
      node = next;
    }
    if (!node.terminal) return false;
    node.terminal = false;
    node.value = undefined;
    count -= 1;
    // Trim trailing now-empty nodes.
    for (let i = path.length - 1; i >= 0; i--) {
      const [parent, ch, child] = path[i];
      if (child.terminal || child.children.size > 0) break;
      parent.children.delete(ch);
    }
    return true;
  }

  function* walk(node, prefix, capRef) {
    if (node.terminal) {
      yield { word: prefix, value: node.value };
      capRef.left -= 1;
      if (capRef.left <= 0) return;
    }
    for (const [ch, child] of node.children) {
      yield* walk(child, prefix + ch, capRef);
      if (capRef.left <= 0) return;
    }
  }

  function prefixSearch(prefix, opts = {}) {
    const cap = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
    if (typeof prefix !== 'string') return [];
    const node = findNode(prefix);
    if (!node) return [];
    const out = [];
    const capRef = { left: cap };
    for (const m of walk(node, prefix, capRef)) {
      out.push(m);
      if (out.length >= cap) break;
    }
    return out;
  }

  function size() { return count; }
  function snapshot() {
    return { size: count, rootChildren: root.children.size };
  }

  return { add, remove, has, get, prefixSearch, size, snapshot };
}

module.exports = {
  createTrie,
};
