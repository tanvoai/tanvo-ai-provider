// Offline tests: the real AI SDK (`ai`) driving this provider against a fake Tanvo API. npm test
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { APICallError, experimental_generateVideo as generateVideo, generateImage, NoSuchModelError } from "ai";
import { createTanvo, TanvoGenerationError } from "../dist/index.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);
const MP4 = Buffer.from("....ftypmp42fake-video");
const MODELS = [
  { id: "studio-image-v1", kind: "image", defaults: { aspect: "1:1", resolution: "1K", format: "PNG" }, options: {} },
  { id: "seedream-4", kind: "image", defaults: { aspect: "1:1", resolution: "2K" }, options: {} },
  { id: "kling-3-0", kind: "video", defaults: { aspect: "16:9", resolution: "720p", duration: 5 }, options: {} },
];

let state;
const reset = () => (state = { requests: [], runs: new Map(), failNext: [], pollsUntilDone: 2, fail: false, uploads: [] });
reset();
let base;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw.toString() });
  const send = (status, payload) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  if (req.url.startsWith("/put/")) {
    state.uploads.push({ mime: req.headers["content-type"], bytes: raw.length });
    return res.writeHead(200).end();
  }
  if (req.url.startsWith("/files/")) return res.writeHead(200, { "content-type": req.url.endsWith(".mp4") ? "video/mp4" : "image/png" }).end(req.url.endsWith(".mp4") ? MP4 : PNG);
  if (state.failNext.length) {
    const [status, error] = state.failNext.shift();
    return send(status, { error, message: `injected ${error}` });
  }
  const auth = req.headers.authorization;
  if (auth && auth !== "Bearer sk_good") return send(401, { error: "invalid_api_key", message: "That API key is invalid." });
  const p = req.url.split("?")[0];
  if (p === "/api/v1/models") return send(200, { models: MODELS });
  if (req.method === "POST" && p === "/api/v1/uploads") return send(200, { upload_url: `${base}/put/${state.uploads.length}`, url: `https://media.tanvo.ai/uploads/u/${state.uploads.length}.png` });
  if (req.method === "POST" && p === "/api/v1/generations") {
    const b = JSON.parse(raw);
    if (!auth && b.model !== "studio-image-v1") return send(403, { error: "needs_api_key", message: "The free tier covers the house image engine only." });
    const id = `gen${state.runs.size + 1}`;
    const g = { id, kind: b.kind, model: b.model, prompt: b.prompt, options: b.options, cost: 25, status: "PROCESSING", error: null, createdAt: 1, outputs: [] };
    state.runs.set(id, { g, polls: 0, body: b });
    return send(202, { generation: g });
  }
  if (req.method === "GET" && p.startsWith("/api/v1/generations/")) {
    const r = state.runs.get(p.split("/").pop());
    if (!r) return send(404, { error: "not_found", message: "No such generation." });
    if (++r.polls >= state.pollsUntilDone) {
      const ext = r.g.kind === "video" ? "mp4" : "png";
      r.g = state.fail ? { ...r.g, status: "FAILED", error: "upstream timeout" } : { ...r.g, status: "SUCCEEDED", outputs: [{ url: `${base}/files/${r.g.id}/0.${ext}`, mime: ext === "mp4" ? "video/mp4" : "image/png" }] };
    }
    return send(200, { generation: r.g });
  }
  send(404, { error: "not_found", message: req.url });
});

const fast = { sleep: async () => {} };
const provider = (apiKey) => createTanvo({ apiKey, baseURL: base, _internal: fast });
const posts = () => state.requests.filter((r) => r.method === "POST" && r.url === "/api/v1/generations").map((r) => ({ ...r, json: JSON.parse(r.body) }));

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  delete process.env.TANVO_API_KEY;
});
after(() => server.close());
beforeEach(reset);

describe("generateImage", () => {
  it("runs a free image without a key and returns the bytes", async () => {
    const { image, providerMetadata } = await generateImage({ model: provider().image("studio-image-v1"), prompt: "a lighthouse in fog", aspectRatio: "16:9" });
    assert.deepEqual(Buffer.from(image.uint8Array), PNG);
    const sent = posts()[0];
    assert.match(sent.headers["x-anon-id"], /^aisdk-/);
    assert.match(sent.headers["user-agent"], /^ai\/\S+ .*tanvo-ai-provider\/\d/);
    assert.deepEqual(sent.json.options, { aspect: "16:9", resolution: "1K", format: "PNG" });
    assert.ok(sent.json.requestKey);
    assert.equal(providerMetadata.tanvo.images[0].credits, 25);
    assert.equal(providerMetadata.tanvo.images[0].generationId, "gen1");
    assert.match(providerMetadata.tanvo.images[0].url, /\/files\/gen1\/0\.png$/);
  });

  it("passes provider options and uploads image inputs for edits", async () => {
    const t = provider("sk_good");
    await generateImage({
      model: t("seedream-4"),
      prompt: { text: "make it winter", images: [new Uint8Array(PNG), "https://example.com/a.jpg"] },
      providerOptions: { tanvo: { resolution: "4K", negativePrompt: "blur", requestKey: "job-1" } },
    });
    const sent = posts()[0];
    assert.equal(sent.headers.authorization, "Bearer sk_good");
    assert.deepEqual(sent.json.options, { aspect: "1:1", resolution: "4K" });
    assert.equal(sent.json.negativePrompt, "blur");
    assert.equal(sent.json.requestKey, "job-1");
    assert.equal(sent.json.imageUrls.length, 2);
    assert.ok(sent.json.imageUrls[0].startsWith("https://media.tanvo.ai/uploads/"));
    assert.equal(sent.json.imageUrls[1], "https://example.com/a.jpg");
    assert.deepEqual(state.uploads.map((u) => u.mime), ["image/png"]);
  });

  it("makes one run per image when n > 1, and warns about unsupported settings", async () => {
    const { images, warnings } = await generateImage({ model: provider("sk_good").image("seedream-4"), prompt: "x", n: 2, seed: 7, size: "1024x1024" });
    assert.equal(images.length, 2);
    assert.equal(posts().length, 2);
    assert.deepEqual([...new Set(warnings.map((w) => w.feature))].sort(), ["seed", "size"]);
  });

  it("surfaces API errors with the code and a key hint", async () => {
    await assert.rejects(generateImage({ model: provider().image("seedream-4"), prompt: "x", maxRetries: 0 }), (e) => APICallError.isInstance(e) && e.statusCode === 403 && /needs_api_key/.test(e.message) && /settings\/apikeys/.test(e.message));
    await assert.rejects(generateImage({ model: provider("sk_bad").image("seedream-4"), prompt: "x", maxRetries: 0 }), (e) => APICallError.isInstance(e) && e.statusCode === 401 && !e.isRetryable);
  });

  it("retries a 5xx through the SDK and reports a failed run", async () => {
    state.failNext = [[502, "provider"]];
    const { image } = await generateImage({ model: provider("sk_good").image("seedream-4"), prompt: "x", maxRetries: 1 });
    assert.ok(image.uint8Array.length);
    state.fail = true;
    await assert.rejects(generateImage({ model: provider("sk_good").image("seedream-4"), prompt: "x", maxRetries: 0 }), (e) => e instanceof TanvoGenerationError || /failed: upstream timeout/.test(String(e?.message)));
  });
});

describe("experimental_generateVideo", () => {
  it("starts a run, polls it through the SDK and returns the video", async () => {
    state.pollsUntilDone = 3;
    const { video, warnings } = await generateVideo({
      model: provider("sk_good").video("kling-3-0"),
      prompt: "slow dolly-in on a lighthouse",
      aspectRatio: "9:16",
      resolution: "1920x1080",
      duration: 10,
      generateAudio: true,
      fps: 24,
      poll: { intervalMs: 1, timeoutMs: 10_000 },
      download: async () => ({ data: new Uint8Array(MP4), mediaType: "video/mp4" }),
    });
    assert.equal(video.mediaType, "video/mp4");
    const sent = posts()[0].json;
    assert.deepEqual(sent.options, { aspect: "9:16", resolution: "1080p", duration: 10, audio: true });
    assert.deepEqual(warnings.map((w) => w.feature), ["fps"]);
  });

  it("uses first and last frames", async () => {
    await generateVideo({
      model: provider("sk_good").video("kling-3-0"),
      prompt: { image: new Uint8Array(PNG), text: "the cat blinks" },
      poll: { intervalMs: 1, timeoutMs: 10_000 },
      download: async () => ({ data: new Uint8Array(MP4), mediaType: "video/mp4" }),
    });
    assert.equal(posts()[0].json.imageUrls.length, 1);
    reset();
    await generateVideo({
      model: provider("sk_good").video("kling-3-0"),
      prompt: "morph",
      frameImages: [{ image: new Uint8Array(PNG), frameType: "first_frame" }, { image: "https://example.com/end.jpg", frameType: "last_frame" }],
      poll: { intervalMs: 1, timeoutMs: 10_000 },
      download: async () => ({ data: new Uint8Array(MP4), mediaType: "video/mp4" }),
    });
    const sent = posts()[0].json;
    assert.equal(sent.imageUrls.length, 1);
    assert.equal(sent.endImageUrl, "https://example.com/end.jpg");
  });

  it("reports a failed video run", async () => {
    state.fail = true;
    await assert.rejects(
      generateVideo({ model: provider("sk_good").video("kling-3-0"), prompt: "x", poll: { intervalMs: 1, timeoutMs: 10_000 }, maxRetries: 0 }),
      (e) => /upstream timeout/.test(String(e?.message)),
    );
  });

  it("doGenerate fallback works on its own", async () => {
    const r = await provider("sk_good").video("kling-3-0").doGenerate({ prompt: "x", n: 1, aspectRatio: undefined, resolution: undefined, duration: undefined, fps: undefined, seed: undefined, image: undefined, frameImages: undefined, inputReferences: undefined, generateAudio: undefined, providerOptions: {} });
    assert.equal(r.videos[0].type, "url");
    assert.match(r.videos[0].url, /\.mp4$/);
  });
});

describe("provider", () => {
  it("has the AI SDK shape and refuses text models", () => {
    const t = provider("sk_good");
    assert.equal(t.specificationVersion, "v4");
    assert.equal(t("seedream-4").provider, "tanvo.image");
    assert.equal(t.imageModel("seedream-4").modelId, "seedream-4");
    assert.equal(t.videoModel("kling-3-0").provider, "tanvo.video");
    assert.throws(() => t.languageModel("x"), (e) => NoSuchModelError.isInstance(e));
  });
});
