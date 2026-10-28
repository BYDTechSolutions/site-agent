import type { SiteAgentErrorCode } from './types.js';

/** Every error this package throws on purpose carries a stable `code`. */
export class SiteAgentError extends Error {
  readonly code: SiteAgentErrorCode;
  constructor(code: SiteAgentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SiteAgentError';
    this.code = code;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof SiteAgentError && error.code === 'aborted') ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError')
  );
}

export function abortError(): SiteAgentError {
  return new SiteAgentError('aborted', 'The run was stopped.');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Resolves with the promise, or rejects as soon as the signal aborts. */
export function raceAbort<T>(promise: Promise<T> | T, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** A signal that aborts when any of the inputs abort (AbortSignal.any where available). */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (native) return native(list);
  const controller = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
