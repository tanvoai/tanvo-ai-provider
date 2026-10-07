// node examples/image.mjs: one free image through the AI SDK, no API key needed.
import fs from "node:fs/promises";
import { generateImage } from "ai";
import { tanvo } from "@tanvoai/ai-provider";

const { image, providerMetadata } = await generateImage({
  model: tanvo.image("studio-image-v1"),
  prompt: "a small paper boat on a rain puddle, macro photo, soft morning light",
  aspectRatio: "4:3",
});
await fs.writeFile("boat.png", image.uint8Array);
console.log("saved boat.png", providerMetadata.tanvo.images[0]);
