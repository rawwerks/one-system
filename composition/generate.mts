/**
 * Bring your own generator. One System ships no model providers: an application
 * supplies a Generate function (typically an agent CLI it already has logged in),
 * and One System checks what comes back.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { component, CompositionError, type Component, type Scope } from './runtime.mts';

export interface GenerationRequest {
  readonly prompt: string;
  readonly system?: string;
  /** Earlier rejected drafts and why, oldest first. Empty on the first attempt. */
  readonly feedback: readonly { readonly draft: string; readonly reason: string }[];
  /** JSON Schema the output must satisfy, when the output is structured. */
  readonly responseSchema?: object;
}

/** Implemented by the application. Must stop when the signal aborts. */
export type Generate = (request: GenerationRequest, signal: AbortSignal) => Promise<string>;

/** Throw from decode or verify; the reason is shown to the generator on the next attempt. */
export class Rejected extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'Rejected';
    this.reason = reason;
  }
}

/** Every attempt was rejected. The attempts are private application data. */
export class GenerationRejected extends CompositionError {
  readonly attempts: readonly { readonly draft: string; readonly reason: string }[];
  constructor(attempts: readonly { draft: string; reason: string }[]) {
    super('generation_rejected', `All ${attempts.length} generated drafts were rejected`);
    this.attempts = attempts;
  }
}

export interface Checks<O> {
  /** Deterministic, runs first: parse and validate. Throw Rejected with a fixable reason. */
  readonly decode: (text: string) => O;
  /**
   * Optional semantic check on a decoded value, e.g. System One judgments. Call
   * other components here, then throw Rejected from verify itself: a Rejected
   * thrown inside a called component fails the whole run instead of retrying.
   */
  readonly verify?: (value: O, scope: Scope) => Promise<void>;
}

export interface GenerationOptions {
  /** Total drafts, including the first. Defaults to 2. */
  readonly attempts?: number;
  readonly system?: string;
  readonly responseSchema?: object;
}

/** Generate, check, and repair with feedback until a draft is accepted or attempts run out. */
export function generateChecked<O>(name: string, generate: Generate, checks: Checks<O>, options: GenerationOptions = {}): Component<string, O> {
  const attempts = options.attempts ?? 2;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new CompositionError('invalid_options', 'attempts must be a positive safe integer');
  return component(name, async (prompt, scope) => {
    const feedback: { draft: string; reason: string }[] = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      const request: GenerationRequest = { prompt, system: options.system, feedback: [...feedback], responseSchema: options.responseSchema };
      const draft = await scope.effect(signal => generate(request, signal));
      try {
        const value = checks.decode(draft);
        if (checks.verify) await checks.verify(value, scope);
        return value;
      } catch (error) {
        if (!(error instanceof Rejected)) throw error;
        feedback.push({ draft, reason: error.reason });
      }
    }
    throw new GenerationRejected(feedback);
  });
}

const template = JSON.parse(readFileSync(new URL('./generation.prompt.json', import.meta.url), 'utf8')) as Record<string, string>;
const MAX_ECHOED_DRAFT = 4000;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');

/** The single text an agent CLI receives on stdin. */
export function renderPrompt(request: GenerationRequest): string {
  const sections: string[] = [];
  if (request.system) sections.push(fill(template.system!, { system: request.system }));
  sections.push(fill(template.task!, { prompt: request.prompt }));
  if (request.responseSchema) sections.push(fill(template.schema!, { schema: JSON.stringify(request.responseSchema, null, 2) }));
  if (request.feedback.length) {
    const items = request.feedback.map(({ draft, reason }, i) => fill(template.feedbackItem!, {
      n: String(i + 1), reason,
      draft: draft.length > MAX_ECHOED_DRAFT ? `${draft.slice(0, MAX_ECHOED_DRAFT)}\n[truncated]` : draft,
    }));
    sections.push(fill(template.feedback!, { feedback: items.join('\n\n') }));
  }
  return sections.join('\n\n') + '\n';
}

/** Private diagnostics from a failed agent CLI; never sent back to the generator. */
export class GeneratorFailed extends CompositionError {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super('generator_failed', message);
    this.stderr = stderr;
  }
}

export interface AgentCliOptions {
  /** Defaults to the current environment, so the CLI keeps its existing login. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Stdout bound; exceeding it stops the process. Defaults to 1 MiB. */
  readonly maxOutputBytes?: number;
}

/**
 * An agent CLI in print/exec mode as a Generate: the rendered prompt goes to stdin,
 * the answer comes from stdout. Examples: agentCli('claude', ['-p']),
 * agentCli('pi', ['-p']), agentCli('codex', ['exec']). Model choice, login and
 * subscription stay with the CLI. A zero exit does not make stdout an answer:
 * some CLIs print provider errors to stdout and exit 0, so decode must check it.
 * Cancellation signals the CLI process itself; processes it starts (tools, MCP
 * servers) stop only if the CLI passes the signal on.
 */
export function agentCli(command: string, args: readonly string[] = [], options: AgentCliOptions = {}): Generate {
  const maxOutput = options.maxOutputBytes ?? 1024 * 1024;
  return (request, signal) => new Promise<string>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let killer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killer.unref();
    };
    const finish = (outcome: { value: string } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if ('error' in outcome) { stop(); reject(outcome.error); } else resolve(outcome.value);
    };
    const onAbort = () => finish({ error: signal.reason });
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) return finish({ error: new GeneratorFailed(`${command} output exceeded ${maxOutput} bytes`, stderr) });
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8'); });
    child.once('error', error => finish({ error: new GeneratorFailed(`${command} could not start: ${(error as NodeJS.ErrnoException).code ?? error.message}`, stderr) }));
    child.once('close', (code, killedBy) => {
      if (killer) clearTimeout(killer);
      if (code === 0) finish({ value: Buffer.concat(stdout).toString('utf8') });
      else finish({ error: new GeneratorFailed(`${command} exited with ${code ?? killedBy}`, stderr) });
    });
    child.stdin.on('error', () => { /* a CLI may exit before reading all input; close reports it */ });
    child.stdin.end(renderPrompt(request));
  });
}

/** Parse one JSON value, tolerating a single surrounding code fence that agents often add. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  try { return JSON.parse(fenced ? fenced[1]! : trimmed); }
  catch { throw new Rejected('the answer was not valid JSON; respond with only the JSON value'); }
}
