export interface Component<I, O> {
  readonly name: string;
  readonly execute: (input: I, scope: Scope) => O | Promise<O>;
}

export type AnyComponent = Component<any, any>;

export interface CallOptions {
  readonly allow: readonly AnyComponent[];
}

export interface RunOptions extends CallOptions {
  readonly maxCalls?: number;
  readonly maxDepth?: number;
  readonly maxEffects?: number;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface Scope {
  readonly signal: AbortSignal;
  readonly invocationId: number;
  readonly parentId: number | null;
  readonly depth: number;
  call<I, O>(target: Component<I, O>, input: I, options?: CallOptions): Promise<O>;
  all<I, O>(calls: readonly { component: Component<I, O>; input: I }[]): Promise<O[]>;
  effect<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export class CompositionError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'CompositionError';
    this.code = code;
  }
}

export function component<I, O>(name: string, execute: Component<I, O>['execute']): Component<I, O> {
  return Object.freeze({ name, execute });
}

function limit(name: string, value: number | undefined, fallback: number, minimum: number): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new CompositionError('invalid_options', `${name} must be a safe integer >= ${minimum}`);
  }
  return resolved;
}

export async function run<I, O>(root: Component<I, O>, input: I, options: RunOptions): Promise<O> {
  if (!Array.isArray(options?.allow)) {
    throw new CompositionError('invalid_options', 'allow must be an array of components');
  }
  const maxCalls = limit('maxCalls', options.maxCalls, 256, 1);
  const maxDepth = limit('maxDepth', options.maxDepth, 16, 0);
  const maxEffects = limit('maxEffects', options.maxEffects, 64, 0);
  const concurrency = limit('concurrency', options.concurrency, 8, 1);
  const timeoutMs = limit('timeoutMs', options.timeoutMs, 300_000, 1);
  const allowed = new Set(options.allow);
  allowed.add(root);

  const controller = new AbortController();
  const started = performance.now();
  const waiting = new Set<PromiseWithResolvers<void>>();
  let calls = 1;
  let effects = 0;
  let activeEffects = 0;
  let nextId = 1;
  let failed = false;
  let failure: unknown;
  let finished = false;
  let timer = setTimeout(scheduleDeadline, Math.min(timeoutMs, 2_147_483_647));

  function fail(error: unknown): void {
    if (failed || finished) return;
    failed = true;
    failure = error;
    for (const waiter of waiting) waiter.reject(error);
    waiting.clear();
    controller.abort(error);
  }

  function check(): void {
    if (!failed && performance.now() - started >= timeoutMs) {
      fail(new CompositionError('deadline', 'Run deadline exceeded'));
    }
    if (failed) throw failure;
  }

  function scheduleDeadline(): void {
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) fail(new CompositionError('deadline', 'Run deadline exceeded'));
    else timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
  }

  function authorize(target: AnyComponent, authority: ReadonlySet<AnyComponent>): void {
    if (!authority.has(target)) {
      throw new CompositionError('forbidden_component', `Component ${target.name} is not allowed`);
    }
  }

  function reserve(count: number, depth: number): void {
    if (count === 0) return;
    if (depth > maxDepth) throw new CompositionError('depth_limit', 'Component depth limit exceeded');
    if (count > maxCalls - calls) throw new CompositionError('call_limit', 'Component call limit exceeded');
    calls += count;
  }

  async function executeEffect<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (activeEffects === concurrency) {
      const waiter = Promise.withResolvers<void>();
      waiting.add(waiter);
      await waiter.promise;
    } else {
      activeEffects++;
    }
    try {
      check();
      const value = await operation(controller.signal);
      check();
      return value;
    } catch (error) {
      fail(error);
      throw failure;
    } finally {
      const waiter = waiting.values().next().value;
      if (waiter) {
        // Transfer the occupied slot before the waiter resumes; new effects cannot steal it.
        waiting.delete(waiter);
        waiter.resolve();
      } else {
        activeEffects--;
      }
    }
  }

  async function invoke<A, B>(
    target: Component<A, B>,
    value: A,
    authority: ReadonlySet<AnyComponent>,
    parentId: number | null,
    depth: number,
  ): Promise<B> {
    const invocationId = nextId++;
    const pending = new Set<Promise<unknown>>();
    let open = true;

    function own<T>(start: () => Promise<T>): Promise<T> {
      let promise: Promise<T>;
      try {
        if (!open) throw new CompositionError('scope_closed', 'Invocation scope is closed');
        check();
        promise = start();
      } catch (error) {
        fail(error);
        promise = Promise.reject(error);
      }
      pending.add(promise);
      // Observe even deliberately unawaited work, and poison the run if its caller catches it.
      void promise.then(
        () => { pending.delete(promise); },
        error => { fail(error); pending.delete(promise); },
      );
      return promise;
    }

    const scope: Scope = Object.freeze({
      signal: controller.signal,
      invocationId,
      parentId,
      depth,
      call<A, B>(child: Component<A, B>, childInput: A, childOptions?: CallOptions): Promise<B> {
        return own(() => {
          authorize(child, authority);
          let childAuthority = authority;
          if (childOptions !== undefined) {
            if (!Array.isArray(childOptions?.allow)) {
              throw new CompositionError('invalid_options', 'allow must be an array of components');
            }
            const narrowed = new Set<AnyComponent>();
            for (const permitted of childOptions.allow) {
              authorize(permitted, authority);
              narrowed.add(permitted);
            }
            childAuthority = narrowed;
          }
          reserve(1, depth + 1);
          return invoke(child, childInput, childAuthority, invocationId, depth + 1);
        });
      },
      all<A, B>(batch: readonly { component: Component<A, B>; input: A }[]): Promise<B[]> {
        return own(() => {
          for (const entry of batch) authorize(entry.component, authority);
          reserve(batch.length, depth + 1);
          // Reserve the entire immediate batch before any member can execute or recurse.
          return Promise.all(batch.map(entry => own(() =>
            invoke(entry.component, entry.input, authority, invocationId, depth + 1))));
        });
      },
      effect<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return own(() => {
          if (effects === maxEffects) throw new CompositionError('effect_limit', 'Effect admission limit exceeded');
          effects++;
          return executeEffect(operation);
        });
      },
    });

    let result!: B;
    try {
      // A microtask boundary also makes deep ordinary recursion independent of the JS stack.
      await Promise.resolve();
      check();
      result = await target.execute(value, scope);
    } catch (error) {
      fail(error);
    } finally {
      // Pending work may itself use this scope; close only after the whole owned subtree settles.
      while (pending.size > 0) await Promise.allSettled(pending);
      open = false;
    }
    check();
    return result;
  }

  const onAbort = () => fail(new CompositionError('cancelled', 'Run was cancelled'));
  try {
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    return await invoke(root, input, allowed, null, 0);
  } finally {
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
