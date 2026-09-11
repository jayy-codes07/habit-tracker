/**
 * The transport, and nothing else. One request() plus the error it throws; the
 * endpoints themselves live with their feature, in features/<name>/api.ts.
 *
 * Same origin in both modes: in production Express serves the SPA and /api
 * together, and in development Vite proxies /api to :3000 — which is what lets
 * the session cookie stay SameSite=Lax with no CORS.
 */
export interface Issue {
  path: string;
  message: string;
}

/**
 * Any non-2xx, plus an unreachable server as status 0.
 *
 * The server answers 4xx with { error }, a rejected schema with
 * { error, issues } and a rate-limited login with { error, retryAfterSeconds },
 * so all three travel on one class.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly issues: Issue[];
  readonly retryAfterSeconds?: number;

  constructor(status: number, body: unknown) {
    const shape = (body ?? {}) as {
      error?: string;
      issues?: Issue[];
      retryAfterSeconds?: number;
    };
    super(shape.error ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.issues = shape.issues ?? [];
    this.retryAfterSeconds = shape.retryAfterSeconds;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...init,
      headers: init?.body
        ? { "Content-Type": "application/json", ...init.headers }
        : (init?.headers ?? {}),
    });
  } catch {
    // fetch only rejects for a transport failure. A phone in a lift deserves a
    // sentence, not "TypeError: Failed to fetch".
    throw new ApiError(0, { error: "Can't reach the server." });
  }

  // DELETE endpoints answer 204 with no body at all.
  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

/** A write whose response is thrown away — 204, or a body nothing reads. */
export const send = (method: string, path: string, body?: unknown) =>
  request<never>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

/** A write whose response is read. */
export const sendJson = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
