# Tanvo provider for the Vercel AI SDK

[![npm](https://img.shields.io/npm/v/@tanvoai/ai-provider)](https://www.npmjs.com/package/@tanvoai/ai-provider) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Use [Tanvo](https://tanvo.ai/?utm_source=github&utm_medium=referral) image and video models with the [Vercel AI SDK](https://ai-sdk.dev): `generateImage` and `experimental_generateVideo` on Nano Banana, Seedream, GPT Image, Qwen, Grok Imagine, Kling, Veo, Seedance, Wan, MiniMax and more, behind one API key and one credit balance.

- AI SDK 7 (provider specification v4). Image editing, image-to-video, first and last frames, native audio.
- **Works without an API key**: the house image engine (`studio-image-v1`) runs on Tanvo's free tier, so you can try it right away.
- Video uses the AI SDK's start/status flow, and supports its `webhook` option.

```bash
npm install @tanvoai/ai-provider ai@^7 zod
```

## Setup

```ts
import { tanvo } from "@tanvoai/ai-provider"; // reads TANVO_API_KEY; without one it runs on the free tier
```

Create a key under [Settings → API keys](https://tanvo.ai/settings/apikeys?utm_source=github&utm_medium=referral) and set `TANVO_API_KEY`, or configure an instance:

```ts
import { createTanvo } from "@tanvoai/ai-provider";

const tanvo = createTanvo({ apiKey: process.env.TANVO_API_KEY });
```

| Setting | |
|---|---|
| `apiKey` | Defaults to `TANVO_API_KEY`. Omit both to use the free tier |
| `baseURL` | Defaults to `TANVO_BASE_URL`, then `https://tanvo.ai` |
| `headers` | Extra headers on every request |
| `fetch` | A custom fetch implementation |

## Images

```ts
import { generateImage } from "ai";
import { tanvo } from "@tanvoai/ai-provider";

const { image } = await generateImage({
  model: tanvo.image("nano-banana-2"),
  prompt: "isometric cutaway of a tiny ramen shop at night, warm light",
  aspectRatio: "16:9",
  providerOptions: { tanvo: { resolution: "2K" } },
});
```

Edit or combine photos by passing images in the prompt:

```ts
const { image } = await generateImage({
  model: tanvo.image("seedream-5-lite"),
  prompt: {
    text: "change the jacket to dark green; keep the face, pose and background exactly as they are",
    images: [await fs.readFile("portrait.jpg")], // bytes, base64 or https URLs; uploaded for you
  },
});
```

`providerOptions.tanvo` for images: `resolution` (`1K` / `2K` / `4K`), `format` (`PNG` / `JPG` / `WEBP`), `negativePrompt`, `requestKey` (idempotency), `timeoutMs`, `pollIntervalMs`. Each image's `providerMetadata.tanvo` carries the stored `url`, the `generationId` and the `credits` charged.

## Video

```ts
import { experimental_generateVideo as generateVideo } from "ai";
import { tanvo } from "@tanvoai/ai-provider";

const { video } = await generateVideo({
  model: tanvo.video("kling-3-0"),
  prompt: "slow dolly-in on a lighthouse in a storm, waves crashing, cinematic",
  aspectRatio: "16:9",
  resolution: "1280x720",
  duration: 5,
});

// Image to video, ending on a chosen frame, with sound
await generateVideo({
  model: tanvo.video("seedance-2-5"),
  prompt: "the cat turns its head and blinks",
  frameImages: [
    { image: await fs.readFile("cat.jpg"), frameType: "first_frame" },
    { image: "https://example.com/cat-end.jpg", frameType: "last_frame" },
  ],
  generateAudio: true,
});
```

`resolution` is mapped to Tanvo's tiers by its shorter side (`480p`, `720p`, `1080p`, `4K`); set `providerOptions.tanvo.resolution` to pick a tier directly. Other `providerOptions.tanvo`: `tier` (for example Veo 3.1 `Lite` / `Fast`), `negativePrompt`, `requestKey`.

## Models

Every model, its options and its price at default settings: [`GET https://tanvo.ai/api/v1/models`](https://tanvo.ai/api/v1/models) or the [API reference](https://tanvo.ai/developers/api?utm_source=github&utm_medium=referral#models).

| Kind | Model ids |
|---|---|
| Image | `studio-image-v1` (free tier), `nano-banana-2`, `nano-banana-2-lite`, `nano-banana-pro`, `nano-banana`, `gpt-image-2`, `gpt-image-2-5`, `seedream-5-pro`, `seedream-5-lite`, `seedream-4-5`, `seedream-4`, `qwen-image-3`, `qwen-image-2-1`, `grok-imagine-2` |
| Video | `studio-video-v1`, `seedance-2-5`, `seedance-2`, `seedance-2-fast`, `seedance-2-mini`, `seedance-1-5-pro`, `kling-3-0`, `kling-3-turbo`, `kling-2-6`, `veo-3-1`, `wan-3-0`, `minimax-h3`, `ltx-2-5`, `flux-3` |

Prices are in credits, the same as on the website. A failed run is refunded automatically, and the stored output URLs are permanent. Songs (Suno V6) and Tanvo's ready-made photo apps are not part of the AI SDK's model types; use [@tanvoai/sdk](https://github.com/tanvoai/tanvo-js) for those.

## Not supported

`seed`, `size` (use `aspectRatio` and `providerOptions.tanvo.resolution`), `mask`, `fps` and `inputReferences` produce an AI SDK warning and are ignored.

## Also from Tanvo

- [@tanvoai/sdk](https://github.com/tanvoai/tanvo-js): the full JavaScript client, including songs and ready-made apps
- [tanvo-mcp](https://github.com/tanvoai/tanvo-mcp): Tanvo inside Claude, Cursor and other MCP clients
- [tanvo-python](https://github.com/tanvoai/tanvo-python): the Python client

## License

MIT
