'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEEPSEEK_FLASH,
  DEEPSEEK_PRO,
  DEEPSEEK_PROVIDER,
  GREETING_NOT_VIDEO_MESSAGE,
  NON_CHAT_VIDEO_MESSAGE,
  isGreetingChatPrompt,
  isNonChatMediaModel,
  resolveChatTurnModel,
} = require('../src/services/ai/chat-model-guard');

const SEEDANCE = {
  name: 'bytedance/seedance-2.0/text-to-video',
  displayName: 'Seedance 2.0 Text to Video',
  provider: 'fal.ai',
  type: 'VIDEO',
};

test('isGreetingChatPrompt matches hola / hi / gracias / ok / qué tal', () => {
  for (const prompt of ['hola', 'Hola!', 'hi', 'gracias', 'ok', 'qué tal', 'Que tal']) {
    assert.equal(isGreetingChatPrompt(prompt), true, prompt);
  }
  assert.equal(isGreetingChatPrompt('créame un video de un gato'), false);
});

test('Seedance is a non-chat media model', () => {
  assert.equal(isNonChatMediaModel(SEEDANCE), true);
  assert.equal(isNonChatMediaModel(SEEDANCE.name), true);
  assert.equal(isNonChatMediaModel({ name: 'deepseek-v4-flash', type: 'TEXT' }), false);
});

test('hola on Seedance remaps to DeepSeek Flash and never a video job', () => {
  const turn = resolveChatTurnModel({
    selectedModel: SEEDANCE.name,
    provider: SEEDANCE.provider,
    prompt: 'hola',
    model: SEEDANCE,
  });
  assert.equal(turn.action, 'chat');
  assert.equal(turn.name, DEEPSEEK_FLASH);
  assert.equal(turn.provider, DEEPSEEK_PROVIDER);
  assert.equal(turn.disableAgentic, true);
  assert.equal(turn.remapped, true);
});

test('hola on DeepSeek Pro stays on Pro', () => {
  const turn = resolveChatTurnModel({
    selectedModel: 'deepseek-v4-pro',
    provider: 'DeepSeek',
    prompt: 'hola',
  });
  assert.equal(turn.action, 'chat');
  assert.equal(turn.name, DEEPSEEK_PRO);
  assert.equal(turn.provider, DEEPSEEK_PROVIDER);
});

test('hola on Kimi/OpenRouter remaps to DeepSeek Flash', () => {
  const turn = resolveChatTurnModel({
    selectedModel: 'moonshotai/kimi-k2.6',
    provider: 'OpenRouter',
    prompt: 'hola',
  });
  assert.equal(turn.action, 'chat');
  assert.equal(turn.name, DEEPSEEK_FLASH);
  assert.equal(turn.provider, DEEPSEEK_PROVIDER);
});

test('chat-only prompt on Seedance fails fast in Spanish', () => {
  const turn = resolveChatTurnModel({
    selectedModel: SEEDANCE.name,
    provider: 'fal.ai',
    prompt: 'explícame la fotosíntesis',
    model: SEEDANCE,
  });
  assert.equal(turn.action, 'reject_media');
  assert.equal(turn.message, NON_CHAT_VIDEO_MESSAGE);
});

test('real video prompt on Seedance stays on the video model', () => {
  const turn = resolveChatTurnModel({
    selectedModel: SEEDANCE.name,
    provider: 'fal.ai',
    prompt: 'crea un video de un gato en la playa',
    model: SEEDANCE,
  });
  assert.equal(turn.action, 'media');
  assert.equal(turn.name, SEEDANCE.name);
});

test('greeting-vs-video copy is Spanish', () => {
  assert.match(GREETING_NOT_VIDEO_MESSAGE, /saludo no genera video/i);
});
