// TANVO_API_KEY=sk_... node examples/video.mjs
import fs from "node:fs/promises";
import { experimental_generateVideo as generateVideo } from "ai";
import { tanvo } from "@tanvoai/ai-provider";

const { video } = await generateVideo({
  model: tanvo.video("kling-3-0"),
  prompt: "slow dolly-in on a lighthouse in a storm, waves crashing, cinematic",
  aspectRatio: "16:9",
  resolution: "1280x720",
  duration: 5,
});
await fs.writeFile("lighthouse.mp4", video.uint8Array);
console.log("saved lighthouse.mp4");
