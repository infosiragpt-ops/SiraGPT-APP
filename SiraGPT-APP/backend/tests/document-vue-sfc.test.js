'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-vue-sfc');
const { extractVueSfc, buildVueSfcForFiles, renderVueSfcBlock } = engine;

const SFC_FIXTURE = `<template>
  <div class="card">
    <h1 v-if="title">{{ title }}</h1>
    <ul>
      <li v-for="item in items" :key="item.id">{{ item.name }}</li>
    </ul>
    <button v-on:click="handleClick">Click</button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

const props = defineProps<{ title: string }>();
const emit = defineEmits<{ (e: 'select', id: number): void }>();

const items = ref([]);
const count = computed(() => items.value.length);

onMounted(() => {
  items.value = fetchItems();
});

function handleClick() {
  emit('select', 1);
}
</script>

<style scoped>
.card { padding: 1rem; }
</style>

<i18n lang="json">
{ "en": { "hello": "Hello" } }
</i18n>
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractVueSfc('').total, 0);
  assert.equal(extractVueSfc(null).total, 0);
});

test('non-Vue text returns empty', () => {
  const r = extractVueSfc('Just plain text with no Vue markers');
  assert.equal(r.total, 0);
});

test('detects template / script / style / i18n blocks', () => {
  const r = extractVueSfc(SFC_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'template'));
  assert.ok(r.entries.some((e) => e.kind === 'script'));
  assert.ok(r.entries.some((e) => e.kind === 'style'));
  assert.ok(r.entries.some((e) => e.kind === 'i18n'));
});

test('detects <script setup>', () => {
  const r = extractVueSfc(SFC_FIXTURE);
  assert.ok(r.totals.setup >= 1);
  assert.ok(r.entries.some((e) => e.kind === 'setup'));
});

test('detects <style scoped>', () => {
  const r = extractVueSfc(SFC_FIXTURE);
  assert.ok(r.totals.scoped >= 1);
});

test('detects <style module>', () => {
  const r = extractVueSfc('<template><div></div></template><style module>.a {}</style>');
  assert.ok(r.totals.cssModule >= 1);
});

test('detects lang attribute on blocks', () => {
  const r = extractVueSfc(SFC_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'langAttr' && /lang=ts/.test(e.name)));
});

test('detects composition API hooks', () => {
  const r = extractVueSfc(SFC_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'compositionApi' && e.name === 'ref'));
  assert.ok(r.entries.some((e) => e.kind === 'compositionApi' && e.name === 'computed'));
  assert.ok(r.entries.some((e) => e.kind === 'compositionApi' && e.name === 'onMounted'));
});

test('detects defineProps / defineEmits macros', () => {
  const r = extractVueSfc(SFC_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'macro' && e.name === 'defineProps'));
  assert.ok(r.entries.some((e) => e.kind === 'macro' && e.name === 'defineEmits'));
});

test('detects v-if / v-for / v-on directives', () => {
  const r = extractVueSfc(SFC_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'directive' && /v-if/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'directive' && /v-for/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'directive' && /v-on/.test(e.name)));
});

test('detects v-bind shorthand (full form)', () => {
  const r = extractVueSfc('<template><div v-bind:title="x" v-model="val"></div></template>');
  assert.ok(r.entries.some((e) => /v-bind/.test(e.name)));
  assert.ok(r.entries.some((e) => /v-model/.test(e.name)));
});

test('dedupes identical entries', () => {
  const r = extractVueSfc('<template><div></div></template><template><div></div></template>');
  assert.equal(r.entries.filter((e) => e.kind === 'template' && e.name === 'template' && !e.detail).length, 1);
});

test('caps entries per file', () => {
  let text = '<template>';
  for (let i = 0; i < 30; i++) text += `<div v-if="x${i}"></div> `;
  text += '</template>';
  const r = extractVueSfc(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractVueSfc(SFC_FIXTURE);
  assert.ok(r.totals.template >= 1);
  assert.ok(r.totals.script >= 1);
  assert.ok(r.totals.style >= 1);
});

test('buildVueSfcForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.vue', extractedText: '<template><div v-if="x"></div></template>' },
    { name: 'b.vue', extractedText: '<template><span v-for="i in y" :key="i"></span></template>' },
  ];
  const r = buildVueSfcForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderVueSfcBlock returns markdown when entries exist', () => {
  const files = [{ name: 'App.vue', extractedText: SFC_FIXTURE }];
  const r = buildVueSfcForFiles(files);
  const md = renderVueSfcBlock(r);
  assert.match(md, /^## VUE SFC/);
});

test('renderVueSfcBlock empty when nothing surfaces', () => {
  assert.equal(renderVueSfcBlock({ perFile: [] }), '');
  assert.equal(renderVueSfcBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildVueSfcForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: SFC_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
