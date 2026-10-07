import { APICallError, AISDKError } from "@ai-sdk/provider";

export const VERSION = "0.1.0";

export type TanvoConfig = {
  baseURL: string;
  /** Resolves the identity headers for each call (an API key, or the free tier's anonymous id). */
  headers: () => Record<string, string>;
  fetch: typeof fetch;
  /** Overridable in tests. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => Date;
};

export type TanvoOutput = { url: string; mime: string };
export type TanvoGeneration = {
  id: string;
  kind: "image" | "video" | "music";
  model: string;
  status: "QUEUED" | "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  cost: number;
  error: string | null;
  options: Record<string, unknown>;
  outputs: TanvoOutput[];
};
export type TanvoModel = { id: string; kind: string; defaults: Record<string, unknown>; options: Record<string, unknown> };

export const DONE = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
const KEYS_URL = "https://tanvo.ai/settings/apikeys";
const NEEDS_KEY = new Set(["needs_api_key", "allowance", "anon_ip_daily", "trial_closed"]);

/** A run that reached FAILED (its credits are refunded by the service). */
export class TanvoGenerationError extends AISDKError {
  readonly generationId: string;
  constructor(g: TanvoGeneration) {
    super({ name: "AI_TanvoGenerationError", message: `Tanvo run ${g.id} failed: ${g.error ?? "unknown error"} (credits refunded)` });
    this.generationId = g.id;
  }
}

export async function request<T>(config: TanvoConfig, method: "GET" | "POST", path: string, body?: unknown, o: { headers?: Record<string, string | undefined>; signal?: AbortSignal } = {}): Promise<{ value: T; headers: Record<string, string> }> {
  const url = `${config.baseURL}/api/v1${path}`;
  const extra = Object.fromEntries(Object.entries(o.headers ?? {}).filter((e): e is [string, string] => e[1] !== undefined));
  let res: Response;
  try {
    res = await config.fetch(url, {
      method,
      // Keep the AI SDK's own user agent and append ours, as the official providers do.
      headers: { "content-type": "application/json", accept: "application/json", ...config.headers(), ...extra, "user-agent": [extra["user-agent"], `tanvo-ai-provider/${VERSION}`].filter(Boolean).join(" ") },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: o.signal,
    });
  } catch (cause) {
    if (o.signal?.aborted) throw cause;
    throw new APICallError({ message: `Could not reach ${config.baseURL}: ${cause instanceof Error ? cause.message : String(cause)}`, url, requestBodyValues: body, cause, isRetryable: true });
  }
  const text = await res.text();
  const headers = Object.fromEntries(res.headers.entries());
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON: reported below */
  }
  if (!res.ok) {
    const code = String(data.error ?? `http_${res.status}`);
    const hasKey = "authorization" in config.headers();
    const hint = NEEDS_KEY.has(code) && !hasKey ? ` Get a key at ${KEYS_URL} and pass apiKey to createTanvo() or set TANVO_API_KEY.` : "";
    const issues = Array.isArray(data.issues) ? ` (${(data.issues as string[]).join("; ")})` : "";
    throw new APICallError({
      message: `${code}: ${String(data.message ?? `HTTP ${res.status}`)}${issues}${hint}`,
      url,
      requestBodyValues: body,
      statusCode: res.status,
      responseHeaders: headers,
      responseBody: text,
      data,
      // The service refunds and never double-charges with the same requestKey, so these are safe to retry.
      isRetryable: res.status >= 500 || code === "rate_limited" || code === "busy",
    });
  }
  return { value: data as T, headers };
}

const modelCache = new WeakMap<TanvoConfig, Promise<TanvoModel[]>>();
/** The model catalogue (cached per provider): defaults fill whatever the caller leaves out. */
export function models(config: TanvoConfig): Promise<TanvoModel[]> {
  let p = modelCache.get(config);
  if (!p) {
    p = request<{ models: TanvoModel[] }>(config, "GET", "/models").then((r) => r.value.models);
    p.catch(() => modelCache.delete(config));
    modelCache.set(config, p);
  }
  return p;
}

export async function optionsFor(config: TanvoConfig, modelId: string, given: Record<string, unknown>) {
  const m = (await models(config).catch(() => [])).find((x) => x.id === modelId);
  return { ...(m?.defaults ?? {}), ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined && v !== null)) };
}

export async function submit(config: TanvoConfig, body: Record<string, unknown>, o: { headers?: Record<string, string | undefined>; signal?: AbortSignal }) {
  const clean = Object.fromEntries(Object.entries({ ...body, requestKey: body.requestKey ?? crypto.randomUUID() }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  return request<{ generation: TanvoGeneration }>(config, "POST", "/generations", clean, o);
}

export async function get(config: TanvoConfig, id: string, o: { headers?: Record<string, string | undefined>; signal?: AbortSignal }) {
  return request<{ generation: TanvoGeneration }>(config, "GET", `/generations/${encodeURIComponent(id)}`, undefined, o);
}

/** Polls a run until it finishes or `timeoutMs` passes (then throws, the run keeps going on the service). */
export async function waitFor(config: TanvoConfig, id: string, o: { everyMs: number; timeoutMs: number; headers?: Record<string, string | undefined>; signal?: AbortSignal }) {
  const deadline = Date.now() + o.timeoutMs;
  await config.sleep(Math.min(2000, o.everyMs), o.signal);
  for (;;) {
    try {
      const r = await get(config, id, o);
      if (DONE.has(r.value.generation.status)) return r;
    } catch (e) {
      // A failed read is not a failed run; give up only on errors that will not clear.
      if (!(APICallError.isInstance(e) && e.isRetryable)) throw e;
    }
    if (Date.now() + o.everyMs > deadline) {
      throw new AISDKError({ name: "AI_TanvoTimeoutError", message: `Tanvo run ${id} did not finish within ${Math.round(o.timeoutMs / 1000)} s. It keeps running; read it later with GET /api/v1/generations/${id} or raise providerOptions.tanvo.timeoutMs.` });
    }
    await config.sleep(o.everyMs, o.signal);
  }
}

type FileLike = { type: "file"; mediaType: string; data: string | Uint8Array } | { type: "url"; url: string; mediaType?: string };

/** A public https URL passes through; bytes (or base64) are uploaded and replaced by their stored URL. */
export async function fileUrl(config: TanvoConfig, f: FileLike, o: { headers?: Record<string, string | undefined>; signal?: AbortSignal }): Promise<string> {
  if (f.type === "url") {
    if (f.url.startsWith("data:")) return fileUrl(config, dataUri(f.url), o);
    return f.url;
  }
  const bytes = typeof f.data === "string" ? Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)) : f.data;
  const slot = (await request<{ upload_url: string; url: string }>(config, "POST", "/uploads", { mime: f.mediaType, bytes: bytes.byteLength }, o)).value;
  const put = await config.fetch(slot.upload_url, { method: "PUT", headers: { "content-type": f.mediaType }, body: bytes as unknown as BodyInit, signal: o.signal });
  if (!put.ok) throw new APICallError({ message: `Upload failed with HTTP ${put.status}`, url: slot.upload_url, requestBodyValues: undefined, statusCode: put.status, isRetryable: put.status >= 500 });
  return slot.url;
}

function dataUri(uri: string): FileLike {
  const m = uri.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) throw new AISDKError({ name: "AI_TanvoInvalidFile", message: "Unreadable data: URI." });
  const data = m[2] ? m[3] : btoa(decodeURIComponent(m[3]));
  return { type: "file", mediaType: m[1] ?? "application/octet-stream", data };
}

export async function download(config: TanvoConfig, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await config.fetch(url, { signal });
  if (!res.ok) throw new APICallError({ message: `Download failed with HTTP ${res.status}`, url, requestBodyValues: undefined, statusCode: res.status, isRetryable: res.status >= 500 });
  return new Uint8Array(await res.arrayBuffer());
}

export const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
