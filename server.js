import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Support large payloads (base64 comic page images can be big)
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ limit: "200mb", extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// API KEY ROTATION
// ==========================================
// Pass multiple keys comma-separated: GEMINI_API_KEY="key1,key2,key3,key4,key5"
const apiKeys = (process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter((k) => k.length > 0);

let currentKeyIndex = 0;

function getNextKey() {
  if (apiKeys.length === 0) return null;
  // Rotate to the next key
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  return apiKeys[currentKeyIndex];
}

function getCurrentKey() {
  if (apiKeys.length === 0) return null;
  return apiKeys[currentKeyIndex];
}

// Proxy endpoint: forwards Gemini API requests with server-side API key
app.post("/api/translate", async (req, res) => {
  if (apiKeys.length === 0) {
    return res.status(500).json({ error: "GEMINI_API_KEY environment variable is not set." });
  }

  const { payload, model } = req.body;
  if (!payload) {
    return res.status(400).json({ error: "Missing payload in request body." });
  }

  const modelName = model || "gemini-2.5-flash";
  let lastError = null;

  // Try each key once before giving up
  for (let attempt = 0; attempt < apiKeys.length; attempt++) {
    const apiKey = getCurrentKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      // If rate limited (429) or quota exhausted, rotate to next key and retry
      if (response.status === 429) {
        const keyNum = currentKeyIndex + 1;
        console.log(`⚠ Key #${keyNum} rate-limited. Rotating to next key...`);
        getNextKey();
        lastError = data;
        continue;
      }

      if (!response.ok) {
        console.error(`✗ Gemini API Error (${response.status}):`, JSON.stringify(data));
        return res.status(response.status).json(data);
      }

      return res.json(data);
    } catch (err) {
      console.error(`Gemini proxy error with key #${currentKeyIndex + 1}:`, err.message);
      lastError = { error: err.message };
      getNextKey();
    }
  }

  // All keys exhausted
  console.error("✗ All API keys exhausted or failed.");
  res.status(429).json(lastError || { error: "All API keys are rate-limited. Please wait and try again." });
});

// Direct PDF download via standard HTML Form POST (bypasses browser blob/fetch restrictions)
app.post("/api/download-pdf-direct", (req, res) => {
  try {
    const base64Data = req.body.pdfData;
    if (!base64Data) return res.status(400).send("No PDF data provided");

    const pdfBuffer = Buffer.from(base64Data, "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Translated_Chapter.pdf"');
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("PDF download error:", err);
    res.status(500).send("Failed to process PDF download");
  }
});

// Show key status on startup
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`✨ Comic Translator running at http://localhost:${PORT}`);
    console.log(`🔑 Loaded ${apiKeys.length} API key(s). Active: Key #${currentKeyIndex + 1}`);
  });
}

export default app;
