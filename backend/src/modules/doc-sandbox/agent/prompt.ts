import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../engine/artifacts';

export const EDITOR_PROMPT_VERSION = 'preserve-v1.1.0';

export function loadEditorPrompt(): { text: string; version: string; sha256: string } {
  const text = readFileSync(join(__dirname, 'prompts', 'editor.system.md'), 'utf8');
  if (text.length < 1000) throw new Error('DOC_ENGINE_PROMPT_INVALID');
  return { text, version: EDITOR_PROMPT_VERSION, sha256: sha256(Buffer.from(text, 'utf8')) };
}
