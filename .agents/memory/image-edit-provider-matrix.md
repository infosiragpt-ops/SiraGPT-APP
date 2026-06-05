---
name: Image generation vs editing provider capability
description: Which providers SiraGPT can use for prompt-only image generation vs image-to-image editing, and why OpenRouter edit requests must be rerouted.
---

# Image generation vs editing provider matrix

Two distinct code paths in `/api/ai/generate-image` (backend/src/routes/ai.js,
`generateSingleImage`):

- **Prompt-only generation** (no input image): supported on **OpenAI**,
  **Gemini**, and **OpenRouter** (`generateOpenRouterImage`).
- **Image-to-image editing** (an `imagePath` is set — i.e. the user edits a
  prior chat image or uploads one): only **OpenAI** (`gpt-image-1` edit) and
  **Gemini** (`gemini-2.5-flash-image`) implement it in
  `aiService.generateImageFromImage` (ai-service.js). **OpenRouter does NOT
  edit.**

**Rule:** an edit request selected with an OpenRouter model must NOT hard-fail.
Reroute editing to a configured edit provider (Gemini if `GEMINI_API_KEY`, else
OpenAI if `OPENAI_API_KEY`, else a clear error). The request `model` is
irrelevant for editing — `generateImageFromImage` hardcodes its own model per
provider.

**Why:** users pick a chat model (often OpenRouter) and then ask to edit the
last image; without the reroute they hit "OpenRouter image editing is not
enabled yet" and the request dies (ECONNRESET). The capability gap is not
discoverable from the model picker, so the backend must paper over it.

## `response_format` is poison for modern image models

`imagen-*` and `gpt-image-*` (OpenAI Images API AND Google's OpenAI-compatible
endpoint) REJECT `response_format` → `400 Unknown parameter: 'response_format'`.
They return `b64_json` by default, so never send the param. The ONLY models that
still accept `response_format: 'b64_json'` are legacy OpenAI dall-e-2/3 (which
otherwise return a URL). Guard it behind a model check (`isOpenAiResponsesImageModel`
omits it for gpt-image-*); Gemini/Imagen calls must omit it unconditionally.

