import type { ImageModelV4, ImageModelV4CallOptions, ImageModelV4Result, SharedV4Warning } from "@ai-sdk/provider";
import { TanvoGenerationError, download, fileUrl, optionsFor, submit, waitFor, type TanvoConfig } from "./api.js";

/** Tanvo image model ids (see GET https://tanvo.ai/api/v1/models). Any other string is passed through. */
export type TanvoImageModelId =
  | "studio-image-v1"
  | "nano-banana-2"
  | "nano-banana-2-lite"
  | "nano-banana-pro"
  | "nano-banana"
  | "gpt-image-2"
  | "gpt-image-2-5"
  | "seedream-5-pro"
  | "seedream-5-lite"
  | "seedream-4-5"
  | "seedream-4"
  | "qwen-image-3"
  | "qwen-image-2-1"
  | "grok-imagine-2"
  | (string & {});

/** `providerOptions.tanvo` for images. */
export type TanvoImageOptions = {
  /** "1K", "2K" or "4K" where the model supports it. */
  resolution?: string;
  format?: "PNG" | "JPG" | "WEBP";
  negativePrompt?: string;
  /** Idempotency key: a retry with the same key returns the first run and is not charged again. */
  requestKey?: string;
  /** How long to wait for the image (default 180 000 ms). */
  timeoutMs?: number;
  /** Polling interval (default 4 000 ms). */
  pollIntervalMs?: number;
};

export class TanvoImageModel implements ImageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly maxImagesPerCall = 1;
  readonly supportsFileInputs = true;
  readonly supportsMaskInputs = false;
  get provider() {
    return "tanvo.image";
  }

  constructor(
    readonly modelId: TanvoImageModelId,
    private readonly config: TanvoConfig,
  ) {}

  async doGenerate(o: ImageModelV4CallOptions): Promise<ImageModelV4Result> {
    const warnings: SharedV4Warning[] = [];
    const t = (o.providerOptions?.tanvo ?? {}) as TanvoImageOptions;
    if (o.size) warnings.push({ type: "unsupported", feature: "size", details: "Use aspectRatio, and providerOptions.tanvo.resolution (1K / 2K / 4K)." });
    if (o.seed !== undefined) warnings.push({ type: "unsupported", feature: "seed" });
    if (o.mask) warnings.push({ type: "unsupported", feature: "mask", details: "Describe the change in the prompt instead." });
    const req = { headers: o.headers, signal: o.abortSignal };
    const imageUrls = await Promise.all((o.files ?? []).map((f) => fileUrl(this.config, f, req)));
    const options = await optionsFor(this.config, this.modelId, { aspect: o.aspectRatio, resolution: t.resolution, format: t.format });
    const started = await submit(this.config, { kind: "image", model: this.modelId, prompt: o.prompt ?? "", negativePrompt: t.negativePrompt, options, imageUrls, requestKey: t.requestKey }, req);
    const done = await waitFor(this.config, started.value.generation.id, { everyMs: t.pollIntervalMs ?? 4000, timeoutMs: t.timeoutMs ?? 180_000, ...req });
    const g = done.value.generation;
    if (g.status !== "SUCCEEDED") throw new TanvoGenerationError(g);
    const images = await Promise.all(g.outputs.map((out) => download(this.config, out.url, o.abortSignal)));
    return {
      images,
      warnings,
      // The SDK keeps only `images` (one entry per image), so the run's details ride on each entry.
      providerMetadata: { tanvo: { images: g.outputs.map((out) => ({ url: out.url, mediaType: out.mime, generationId: g.id, credits: g.cost, model: g.model })) } },
      response: { timestamp: this.config.now(), modelId: this.modelId, headers: done.headers },
    };
  }
}
