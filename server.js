import express from "express";
import cors from "cors";
import OpenAI, { toFile } from "openai";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "cartoonr-backend", model: "gpt-image-2" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
});

function parseDataUrl(dataUrl, index) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/s.exec(dataUrl || "");
  if (!match) throw new Error(`Reference ${index + 1} is not a supported image data URL.`);
  const mime = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { mime, ext, buffer: Buffer.from(match[2], "base64") };
}

const optionDirections = {
  1: `Create a composition that best fits the line. Prefer a half-body or three-quarter-body pose when appropriate. The character may be positioned left or right to create clean negative space for the speech bubble.`,
  2: `Create a clearly different composition from Option 1. Consider a full-body or seated/standing pose, expressive hands, and a relevant simple prop only when the line naturally calls for one.`,
  3: `Create a clearly different composition from Options 1 and 2. Consider a close-up, head-and-shoulders, or another emotionally strong framing that fits the line, with a different character position and gesture.`
};

function buildPrompt({ characterName, line, option, fontName = "", hasFontReference = false }) {
  return `
Create ONE finished square cartoon artcard for the character "${characterName || "the supplied character"}".

SOURCE OF TRUTH
The uploaded reference images are the sole visual basis. Preserve the same recognizable character, facial design, age cues, hairstyle, body proportions, clothing conventions, stroke/outline character, palette, coloring method, illustration finish, and personality shown in the references. Do not redesign the character and do not introduce a different illustration style.

SPEECH BUBBLE
Study any speech bubbles visible in the character references and reproduce that same bubble language consistently: shape, outline, fill, padding, and tail treatment. If a final uploaded image is a typography specimen, it is NOT a character reference: use it only as the exact visual guide for the speech-bubble lettering. ${hasFontReference ? `The uploaded font specimen is named "${fontName || "Custom font"}". Match its letterforms as closely as possible.` : "Match the lettering style visible in the character references."} The bubble must contain this exact line, verbatim:
"${line}"
Do not rewrite, translate, shorten, correct, paraphrase, or add words.

PERFORMANCE
Infer the emotional tone and intent of the line. Make the facial expression, body language, gesture, pose, and any appropriate simple object support that tone naturally.

OPTION ${option}
${optionDirections[option] || optionDirections[1]}

COMPOSITION RULES
- Produce a single artcard, never a collage, contact sheet, triptych, or multiple panels.
- Square composition.
- BACKGROUND MUST ALWAYS BE PURE SOLID WHITE (#FFFFFF). No cream, yellow, gray, gradient, texture, scenery, shadows, colored wash, or decorative background.
- NOTHING may touch the left or right canvas edges: character, hair, hands, speech bubble, props, furniture, plants, hearts, decorations, or any other object. Maintain a generous clear white safety margin on BOTH left and right sides.
- Keep the complete intended character composition safely inside all canvas edges. No accidental clipping.
- Keep important hands, gestures, props, and facial features visible.
- Do not add decorative objects, hearts, plants, furniture, or props unless the dialogue truly requires them; when used, they must remain fully inside the safe margins.
- Use clean negative space so the speech bubble and character do not fight for attention.
- No watermark, no extra captions, no additional characters unless clearly present as part of the established reference concept.
- The three options for the same line must feel meaningfully different in pose, crop, placement, gesture, and composition while remaining the exact same character and style.
`.trim();
}

app.post("/generate", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
    }

    const { characterName = "", characterReferences = [], fontReference = "", fontName = "", line = "", option = 1 } = req.body || {};
    if (!line.trim()) return res.status(400).json({ error: "line is required" });
    if (!Array.isArray(characterReferences) || characterReferences.length === 0) {
      return res.status(400).json({ error: "At least one character reference image is required." });
    }

    const images = [];
    for (let i = 0; i < characterReferences.length; i++) {
      const p = parseDataUrl(characterReferences[i], i);
      images.push(await toFile(p.buffer, `reference-${i + 1}.${p.ext}`, { type: p.mime }));
    }

    if (fontReference) {
      const fp = parseDataUrl(fontReference, characterReferences.length);
      images.push(await toFile(fp.buffer, `font-reference.${fp.ext}`, { type: fp.mime }));
    }

    const result = await client.images.edit({
      model: "gpt-image-2",
      image: images,
      prompt: buildPrompt({ characterName, line, option: Number(option) || 1, fontName, hasFontReference: Boolean(fontReference) }),
      size: "1088x1088",
      quality: "high",
      output_format: "png",
      n: 1
    });

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI returned no image data.");

    res.json({
      ok: true,
      option: Number(option) || 1,
      imageData: `data:image/png;base64,${b64}`,
      requestedOutput: { width: 1080, height: 1080, dpi: 300 },
      generatedSize: "1088x1088",
      note: "Client should downscale to 1080x1080 and write 300-DPI metadata when exporting."
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Image generation failed." });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Cartoonr backend listening on port ${port}`);
});
