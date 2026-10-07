import { NoSuchModelError, type ProviderV4 } from "@ai-sdk/provider";
import { VERSION, abortableSleep, type TanvoConfig } from "./api.js";
import { TanvoImageModel, type TanvoImageModelId } from "./image-model.js";
import { TanvoVideoModel, type TanvoVideoModelId } from "./video-model.js";

export { VERSION, TanvoGenerationError } from "./api.js";
export { TanvoImageModel, type TanvoImageModelId, type TanvoImageOptions } from "./image-model.js";
export { TanvoVideoModel, type TanvoVideoModelId, type TanvoVideoOptions } from "./video-model.js";

export interface TanvoProviderSettings {
  /** Defaults to TANVO_API_KEY. Without a key the provider runs on Tanvo's anonymous free tier (studio-image-v1 only). */
  apiKey?: string;
  /** Free-tier wallet id; one is made per provider instance when omitted. */
  anonId?: string;
  /** Defaults to TANVO_BASE_URL, then https://tanvo.ai. */
  baseURL?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** A custom fetch (proxies, tests). */
  fetch?: typeof fetch;
  /** @internal Test hooks. */
  _internal?: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; currentDate?: () => Date };
}

export interface TanvoProvider extends ProviderV4 {
  /** An image model: `tanvo.image("nano-banana-2")`. */
  (modelId: TanvoImageModelId): TanvoImageModel;
  image(modelId: TanvoImageModelId): TanvoImageModel;
  imageModel(modelId: TanvoImageModelId): TanvoImageModel;
  /** A video model for `experimental_generateVideo`: `tanvo.video("kling-3-0")`. */
  video(modelId: TanvoVideoModelId): TanvoVideoModel;
  videoModel(modelId: TanvoVideoModelId): TanvoVideoModel;
}

const env = (name: string) => (typeof process !== "undefined" ? process.env?.[name] : undefined) || undefined;

/** Creates a Tanvo provider for the Vercel AI SDK. */
export function createTanvo(settings: TanvoProviderSettings = {}): TanvoProvider {
  const baseURL = (settings.baseURL ?? env("TANVO_BASE_URL") ?? "https://tanvo.ai").replace(/\/$/, "");
  const anonId = settings.anonId ?? `aisdk-${crypto.randomUUID()}`;
  const config: TanvoConfig = {
    baseURL,
    // Read the key per call so a key set after import (e.g. by a test runner or dotenv) is still picked up.
    headers: () => {
      const key = settings.apiKey ?? env("TANVO_API_KEY");
      return { ...(key ? { authorization: `Bearer ${key}` } : { "x-anon-id": anonId }), ...settings.headers };
    },
    fetch: settings.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
    sleep: settings._internal?.sleep ?? abortableSleep,
    now: settings._internal?.currentDate ?? (() => new Date()),
  };
  const image = (id: TanvoImageModelId) => new TanvoImageModel(id, config);
  const video = (id: TanvoVideoModelId) => new TanvoVideoModel(id, config);
  const provider = Object.assign((id: TanvoImageModelId) => image(id), {
    specificationVersion: "v4" as const,
    image,
    imageModel: image,
    video,
    videoModel: video,
    languageModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: "languageModel", message: "Tanvo makes images and video; use another provider for text." });
    },
    embeddingModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
  });
  return provider as unknown as TanvoProvider;
}

/** Default instance: reads TANVO_API_KEY (or runs on the free tier). */
export const tanvo = createTanvo();
