require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST"] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const API_URL = process.env.OPENAI_API_URL || "https://api.openai.com";
const API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE || "prompts/default_system_prompt.txt";

// ── Language list cache ──
let languageCache = null;

async function fetchLanguages() {
  if (languageCache) return languageCache;
  const { default: fetch } = await import("node-fetch");
  // ISO 639-1 list from umpirsky/language-list (format: { "en": "English", "ja": "Japanese", ... })
  const res = await fetch(
    "https://raw.githubusercontent.com/umpirsky/language-list/master/data/en/language.json"
  );
  if (!res.ok) throw new Error(`Language list fetch failed: ${res.status}`);
  const raw = await res.json();
  // Convert to sorted array [{ code, name }]
  const list = Object.entries(raw)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  languageCache = list;
  return list;
}

// Pre-warm cache on startup
fetchLanguages().catch((e) => console.warn("Language list pre-fetch failed:", e.message));

app.get("/api/config", (req, res) => {
  res.json({ configured: !!API_KEY, defaultModel: DEFAULT_MODEL, apiUrl: API_URL });
});

app.get("/api/models", async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "API key not configured." });
  try {
    const { default: fetch } = await import("node-fetch");
    const r = await fetch(`${API_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Models fetch failed: ${err}` });
    }
    const data = await r.json();
    const models = (data.data || []).map((m) => m.id).sort();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/languages", async (req, res) => {
  try {
    const list = await fetchLanguages();
    res.json({ languages: list });
  } catch (err) {
    console.error("Language fetch error:", err.message);
    // Fallback to minimal list so the app still works
    res.json({
      languages: [
        { code: "en", name: "English" },
        { code: "ja", name: "Japanese" },
        { code: "zh", name: "Chinese" },
        { code: "es", name: "Spanish" },
        { code: "fr", name: "French" },
        { code: "de", name: "German" },
        { code: "ko", name: "Korean" },
        { code: "pt", name: "Portuguese" },
        { code: "ar", name: "Arabic" },
        { code: "ru", name: "Russian" },
      ],
      fallback: true,
      error: err.message,
    });
  }
});

app.post("/api/translate", upload.single("file"), async (req, res) => {
  try {
    const { sourceLang, sourceLangCode, targetLang, targetLangCode, text, model } = req.body;
    const file = req.file;
    const MODEL = model || DEFAULT_MODEL;

    // Arguments to interpolate the string with
    const data_args = {"sourceLang":sourceLang, "targetLang":targetLang}

    // Interpolation of the prompt
    const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8').replace(/\$\{([^}]+)\}/g, (match, key) => {
      return data_args[key] !== undefined ? data_args[key] : match;
    });
    // console.log(systemPrompt)

    if (!API_KEY) {
      return res.status(500).json({ error: "API key not configured. Set OPENAI_API_KEY environment variable." });
    }

    let userContent = [];

    if (file) {
      const mimeType = file.mimetype;
      const base64 = file.buffer.toString("base64");

      if (mimeType.startsWith("image/")) {
        userContent.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } });
        userContent.push({ type: "text", text: text ? `Also include this text in the translation: ${text}` : "Extract all text from this image and translate it." });
      } else if (mimeType.startsWith("audio/")) {
        const FormData = (await import("form-data")).default;
        const { default: fetch } = await import("node-fetch");
        const formData = new FormData();
        formData.append("file", file.buffer, { filename: file.originalname, contentType: mimeType });
        formData.append("model", "whisper-1");
        if (sourceLangCode) formData.append("language", sourceLangCode);
        const whisperRes = await fetch(`${API_URL}/v1/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}`, ...formData.getHeaders() },
          body: formData,
        });
        if (!whisperRes.ok) {
          const err = await whisperRes.text();
          return res.status(500).json({ error: `Audio transcription failed: ${err}` });
        }
        const whisperData = await whisperRes.json();
        const transcribed = whisperData.text || "";
        userContent.push({ type: "text", text: `Transcribed audio: "${transcribed}"${text ? `\n\nAlso translate this text: ${text}` : ""}` });
      }
    } else if (text) {
      userContent.push({ type: "text", text });
    } else {
      return res.status(400).json({ error: "No content provided for translation." });
    }

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent.length === 1 && userContent[0].type === "text" ? userContent[0].text : userContent },
    ];

    const { default: fetch } = await import("node-fetch");
    const apiRes = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 4096 }),
    });

    if (!apiRes.ok) {
      const err = await apiRes.text();
      return res.status(500).json({ error: `API error: ${err}` });
    }

    const data = await apiRes.json();
    const translation = data.choices?.[0]?.message?.content || "";
    res.json({ translation, model: MODEL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Translator running on http://localhost:${PORT}`));