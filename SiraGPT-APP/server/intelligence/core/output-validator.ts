/**
 * server/intelligence/core/output-validator.ts
 *
 * Default OutputValidator — validates LLM text against a Zod schema for
 * structured outputs, with best-effort JSON extraction (fenced blocks, leading
 * prose, balanced-brace walking) and a self-correction repair prompt builder.
 *
 * Never throws: returns a typed Result.
 */

import type { z } from 'zod';
import type { Result } from '../ports/common';
import { err, ok } from '../ports/common';
import type { OutputValidationError, OutputValidator } from '../ports';

/** Extract the most plausible JSON value from arbitrary model text. */
export function extractJsonCandidate(raw: string): string | null {
  if (!raw) return null;
  let text = raw.trim();

  // Strip a leading ```json / ``` fence and trailing fence.
  const fence = text.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    text = fence[1].trim();
  }

  // Fast path: already a bare JSON object/array.
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    return text;
  }

  // Otherwise, walk for the first balanced { ... } or [ ... ] region.
  const start = firstStructuralIndex(text);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function firstStructuralIndex(text: string): number {
  const obj = text.indexOf('{');
  const arr = text.indexOf('[');
  if (obj < 0) return arr;
  if (arr < 0) return obj;
  return Math.min(obj, arr);
}

export function createDefaultOutputValidator(): OutputValidator {
  function validate<T>(
    raw: string,
    schema: z.ZodType<T>
  ): Result<T, OutputValidationError> {
    const candidate = extractJsonCandidate(raw);
    if (candidate == null) {
      return err<OutputValidationError>({
        kind: 'no_json',
        message: 'no JSON value could be located in the model output',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (e) {
      return err<OutputValidationError>({
        kind: 'parse_error',
        message: e instanceof Error ? e.message : 'invalid JSON',
      });
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map(
        (iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`
      );
      return err<OutputValidationError>({
        kind: 'schema_error',
        message: 'output did not satisfy the schema',
        issues,
      });
    }

    return ok(result.data);
  }

  function repairPrompt(originalPrompt: string, error: OutputValidationError): string {
    const lines: string[] = [];
    lines.push('Your previous response could not be parsed as the required structured output.');
    if (error.kind === 'no_json') {
      lines.push('No JSON object was found. Respond with ONLY a single valid JSON value, no prose, no code fences.');
    } else if (error.kind === 'parse_error') {
      lines.push(`The JSON was malformed: ${error.message}. Return STRICTLY valid JSON.`);
    } else {
      lines.push('The JSON did not match the schema. Fix exactly these issues:');
      for (const issue of error.issues ?? []) lines.push(`  - ${issue}`);
    }
    lines.push('');
    lines.push('Original request:');
    lines.push(originalPrompt);
    return lines.join('\n');
  }

  return { validate, repairPrompt };
}
