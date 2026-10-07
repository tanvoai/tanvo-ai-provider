import type {
  Experimental_VideoModelV4 as VideoModelV4,
  Experimental_VideoModelV4CallOptions as VideoModelV4CallOptions,
  Experimental_VideoModelV4OperationStartResult as VideoModelV4OperationStartResult,
  Experimental_VideoModelV4OperationStatusResult as VideoModelV4OperationStatusResult,
  Experimental_VideoModelV4OperationWebhook as VideoModelV4OperationWebhook,
  Experimental_VideoModelV4Result as VideoModelV4Result,
  JSONValue,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { TanvoGenerationError, fileUrl, get, optionsFor, submit, waitFor, type TanvoConfig, type TanvoGeneration } from "./api.js";

/** Tanvo video model ids (see GET https://tanvo.ai/api/v1/models). Any other string is passed through. */
export type TanvoVideoModelId =
  | "studio-video-v1"
  | "seedance-2-5"
  | "seedance-2"
  | "seedance-2-fast"
  | "seedance-2-mini"
  | "seedance-1-5-pro"
  | "kling-3-0"
  | "kling-3-turbo"
  | "kling-2-6"
  | "veo-3-1"
  | "wan-3-0"
  | "minimax-h3"
  | "ltx-2-5"
  | "flux-3"
  | (string & {});

/** `providerOptions.tanvo` for video. */
export type TanvoVideoOptions = {
  /** "480p", "720p", "1080p" or "4K"; overrides `resolution`. */
  resolution?: string;
  /** Model tier where one exists, e.g. Veo 3.1 "Lite" or "Fast". */
  tier?: string;
  negativePrompt?: string;
  requestKey?: string;
  /** For `doGenerate` (SDK versions without start/status): how long to wait, default 600 000 ms. */
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/** "1280x720" → "720p": the shorter side picks the tier. */
function tierOf(resolution: string | undefined) {
  const m = resolution?.match(/^(\d+)x(\d+)$/);
  if (!m) return undefined;
  const short = Math.min(Number(m[1]), Number(m[2]));
  return short >= 2000 ? "4K" : short >= 1000 ? "1080p" : short >= 700 ? "720p" : "480p";
}

export class TanvoVideoModel implements VideoModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly maxVideosPerCall = 1;
  get provider() {
    return "tanvo.video";
  }

  constructor(
    readonly modelId: TanvoVideoModelId,
    private readonly config: TanvoConfig,
  ) {}

  private async body(o: VideoModelV4CallOptions, warnings: SharedV4Warning[]) {
    const t = (o.providerOptions?.tanvo ?? {}) as TanvoVideoOptions;
    if (o.fps !== undefined) warnings.push({ type: "unsupported", feature: "fps" });
    if (o.seed !== undefined) warnings.push({ type: "unsupported", feature: "seed" });
    if (o.inputReferences?.length) warnings.push({ type: "unsupported", feature: "inputReferences", details: "Use image (first frame) or frameImages." });
    const req = { headers: o.headers, signal: o.abortSignal };
    const first = o.frameImages?.find((f) => f.frameType === "first_frame")?.image ?? o.image;
    const last = o.frameImages?.find((f) => f.frameType === "last_frame")?.image;
    const options = await optionsFor(this.config, this.modelId, {
      aspect: o.aspectRatio === "adaptive" ? undefined : o.aspectRatio,
      resolution: t.resolution ?? tierOf(o.resolution),
      duration: o.duration,
      audio: o.generateAudio,
      tier: t.tier,
    });
    return {
      kind: "video",
      model: this.modelId,
      prompt: o.prompt ?? "",
      negativePrompt: t.negativePrompt,
      options,
      imageUrls: first ? [await fileUrl(this.config, first, req)] : [],
      endImageUrl: last ? await fileUrl(this.config, last, req) : undefined,
      requestKey: t.requestKey,
    };
  }

  private response(headers?: Record<string, string>) {
    return { timestamp: this.config.now(), modelId: this.modelId, headers };
  }

  private videos(g: TanvoGeneration) {
    return g.outputs.map((out) => ({ type: "url" as const, url: out.url, mediaType: out.mime || "video/mp4" }));
  }

  /** The service POSTs the finished run to a URL of your choice, so the SDK can wait on a webhook instead of polling. */
  async handleWebhookOption(options: { webhook: () => PromiseLike<{ url: string; received: PromiseLike<VideoModelV4OperationWebhook> }> }) {
    const { url, received } = await options.webhook();
    return { webhookUrl: url, received };
  }

  async doStart(o: VideoModelV4CallOptions & { webhookUrl?: string }): Promise<VideoModelV4OperationStartResult> {
    const warnings: SharedV4Warning[] = [];
    const body = { ...(await this.body(o, warnings)), webhookUrl: o.webhookUrl };
    const r = await submit(this.config, body, { headers: o.headers, signal: o.abortSignal });
    return { operation: { id: r.value.generation.id } satisfies JSONValue, warnings, response: this.response(r.headers) };
  }

  async doStatus(o: { operation: JSONValue; abortSignal?: AbortSignal; headers?: Record<string, string | undefined> }): Promise<VideoModelV4OperationStatusResult> {
    const id = (o.operation as { id: string }).id;
    const r = await get(this.config, id, { headers: o.headers, signal: o.abortSignal });
    const g = r.value.generation;
    const providerMetadata = { tanvo: { generationId: g.id, credits: g.cost, model: g.model } };
    if (g.status === "SUCCEEDED") return { status: "completed", videos: this.videos(g), warnings: [], providerMetadata, response: this.response(r.headers) };
    if (g.status === "FAILED" || g.status === "CANCELED") return { status: "error", error: `${g.error ?? "The run failed"} (credits refunded)`, providerMetadata, response: this.response(r.headers) };
    return { status: "pending", providerMetadata, response: this.response(r.headers) };
  }

  /** One-call fallback: start, then poll until done. */
  async doGenerate(o: VideoModelV4CallOptions): Promise<VideoModelV4Result> {
    const warnings: SharedV4Warning[] = [];
    const t = (o.providerOptions?.tanvo ?? {}) as TanvoVideoOptions;
    const req = { headers: o.headers, signal: o.abortSignal };
    const started = await submit(this.config, await this.body(o, warnings), req);
    const done = await waitFor(this.config, started.value.generation.id, { everyMs: t.pollIntervalMs ?? 6000, timeoutMs: t.timeoutMs ?? 600_000, ...req });
    const g = done.value.generation;
    if (g.status !== "SUCCEEDED") throw new TanvoGenerationError(g);
    return { videos: this.videos(g), warnings, providerMetadata: { tanvo: { generationId: g.id, credits: g.cost, model: g.model } }, response: this.response(done.headers) };
  }
}
