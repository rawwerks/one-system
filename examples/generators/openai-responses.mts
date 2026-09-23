/**
 * Example: a Generate over the OpenAI Responses API with plain fetch.
 *
 * Copy and adapt this in your application. One System does not ship, pin or
 * maintain an LLM client, and hosts no generation. You choose the provider,
 * model, key and limits. The same shape fits any HTTP completion API.
 */
import type { Generate, GenerationRequest } from '../../composition/generate.mts';

export interface ResponsesOptions {
  readonly apiKey: string;
  /** Your choice; this example deliberately has no default model. */
  readonly model: string;
  /** Defaults to https://api.openai.com/v1/; a proxy or compatible base path is kept. */
  readonly baseUrl?: string;
  readonly maxOutputTokens?: number;
}

function input(request: GenerationRequest): string {
  const parts = [request.prompt];
  if (request.feedback.length) {
    parts.push('Earlier answers were rejected. Fix every problem and answer again:',
      ...request.feedback.map((f, i) => `Rejected answer ${i + 1}:\n${f.draft}\nProblem: ${f.reason}`));
  }
  return parts.join('\n\n');
}

export function openAIResponses(options: ResponsesOptions): Generate {
  return async (request, signal) => {
    const body: Record<string, unknown> = {
      model: options.model,
      instructions: request.system,
      input: input(request),
      max_output_tokens: options.maxOutputTokens ?? 2048,
      store: false,
    };
    if (request.responseSchema) {
      // Strict mode cannot express maps with caller-chosen keys, such as System One
      // questions. Send the schema as guidance; decode validates the result anyway.
      body.text = { format: { type: 'json_schema', name: 'answer', schema: request.responseSchema, strict: false } };
    }
    const base = options.baseUrl ?? 'https://api.openai.com/v1/';
    const response = await fetch(new URL('responses', base.endsWith('/') ? base : `${base}/`), {
      method: 'POST', signal, redirect: 'error',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data: {
      status?: string; error?: { message?: string } | null;
      output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
    } = {};
    try { data = JSON.parse(text); } catch { if (response.ok) throw new Error('OpenAI Responses API returned a non-JSON body'); }
    if (!response.ok) throw new Error(`OpenAI Responses API failed: HTTP ${response.status} ${data.error?.message ?? ''}`.trim());
    if (data.status && data.status !== 'completed') throw new Error(`OpenAI response is ${data.status}`);
    const content = (data.output ?? []).filter(item => item.type === 'message').flatMap(item => item.content ?? []);
    const refusal = content.find(part => part.type === 'refusal');
    if (refusal) throw new Error(`The model refused: ${refusal.refusal ?? ''}`);
    return content.filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
  };
}

// Usage, e.g. to author System One questions:
//   const generate = openAIResponses({ apiKey: process.env.OPENAI_API_KEY!, model: process.env.OPENAI_MODEL! });
//   const author = questionAuthor('questions', generate, { route: await routeCapabilities(gateway, 'local-demo') });
