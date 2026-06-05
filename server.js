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

const API_URL = process.env.OPENAI_API_URL || "https://api.openai.com";
const API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE || "prompts/default_system_prompt";
const SYSTEM_PROMPT_IMAGE_APPENDIX_FILE = process.env.SYSTEM_PROMPT_IMAGE_APPENDIX_FILE || "prompts/prompt_image_appendix";
const SYSTEM_PROMPT_TEXT_APPENDIX_FILE = process.env.SYSTEM_PROMPT_TEXT_APPENDIX_FILE || "prompts/prompt_text_appendix";

// ── Language list cache ──
let languageCache = null;

function fetchLanguages() {
  if (languageCache) return languageCache;

  // Load languages from local assets/languages.json
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "assets/languages.json"), "utf8"));
  const list = Object.entries(raw)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  languageCache = list;
  return list;
}

// Pre-warm cache on startup
languageCache = fetchLanguages();

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

app.get("/api/languages", (req, res) => {
  try {
    const list = fetchLanguages();
    res.json({ languages: list });
  } catch (err) {
    console.error("Language fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/*
// PDF support disabled - client-side extraction via PDF.js now handles PDF text extraction
async function pdfToImages(buffer, data_args, systemPrompt) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const pdfPath = path.join(__dirname, `tmp_${Date.now()}_${data_args.sourceLang}.pdf`);
    fs.writeFileSync(pdfPath, buffer);

    const outputDir = path.join(__dirname, `tmp_pdf_pages_${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const child = spawn('pdftoppm', ['-png', pdfPath, path.join(outputDir, 'page')]);

    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const images = [];

    child.on('close', async (code) => {
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

      if (code !== 0) {
        try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) {}
        reject(new Error(`PDF conversion failed: pdftoppm exited with code ${code}${stderr ? ': ' + stderr : ''}`));
        return;
      }

      try {
        const imageFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.png'));
        for (const imgFile of imageFiles) {
          const imgBuffer = fs.readFileSync(path.join(outputDir, imgFile));
          images.push(imgBuffer.toString('base64'));
        }
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch (err) {
        try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) {}
        reject(err);
        return;
      }

      const textAppendix = fs.readFileSync(SYSTEM_PROMPT_IMAGE_APPENDIX_FILE, 'utf8');
      const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
        return data_args[key] !== undefined ? data_args[key] : match;
      });

      const userContent = [
        { type: "text", text: systemPrompt + "\n" + finalText }
      ];

      for (const imageBytes of images) {
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${imageBytes}`
          }
        });
      }

      resolve(userContent);
    });

    child.on('error', (err) => {
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) {}
      reject(new Error(`PDF conversion failed: ${err.message}`));
    });
  });
}
*/

app.post("/api/translate", upload.single("file"), async (req, res) => {
  try {
    const { sourceLang, sourceLangCode, targetLang, targetLangCode, text, model } = req.body;
    const file = req.file;
    const MODEL = model || DEFAULT_MODEL;

    // Arguments to interpolate the string with
    const data_args = { "sourceLang": sourceLang, "targetLang": targetLang };

    // Load base system prompt
    let systemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8').replace(/\$\{([^}]+)\}/g, (match, key) => {
      return data_args[key] !== undefined ? data_args[key] : match;
    });

    // Validate: only text-only, image-only, or audio-only allowed (no combination)
    const hasText = !!text;
    const hasFile = !!file;

    if (!hasText && !hasFile) {
      return res.status(400).json({ error: "No content provided for translation." });
    }

    if (hasText && hasFile) {
      return res.status(400).json({ error: "Please provide either text OR a file, not both." });
    }

    let userContent;

    if (hasFile) {
      const mimeType = file.mimetype;

      if (mimeType.startsWith("image/")) {
        // Image handling - use OpenAI multi-part format with image_url
        const imageBytes = file.buffer.toString("base64");
        const textAppendix = fs.readFileSync(SYSTEM_PROMPT_IMAGE_APPENDIX_FILE, 'utf8');
        const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
          return data_args[key] !== undefined ? data_args[key] : match;
        });
        userContent = [
          { type: "text", text: systemPrompt + "\n" + finalText },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${imageBytes}`
            }
          }
        ];
      // PDF handling disabled - client-side extraction now handles PDF text extraction
      } else if (mimeType.startsWith("application/pdf") || file.originalname.toLowerCase().endsWith(".pdf")) {
        return res.status(400).json({ error: "PDF upload disabled. Please extract text from the PDF and paste it into the text field." });
      } else if (mimeType.startsWith("audio/")) {
        // Audio handling - transcribe first
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

        // Load text appendix for audio transcription context
        const textAppendix = fs.readFileSync(SYSTEM_PROMPT_TEXT_APPENDIX_FILE, 'utf8');
        const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
          return data_args[key] !== undefined ? data_args[key] : match;
        }).replace(/\$\{text\}/g, transcribed);

        userContent = [{ type: "text", text: finalText }];
      }
    } else if (text) {
      // Text-only case
      const textAppendix = fs.readFileSync(SYSTEM_PROMPT_TEXT_APPENDIX_FILE, 'utf8');
      const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
        return data_args[key] !== undefined ? data_args[key] : match;
      }).replace(/\$\{text\}/g, text);

      userContent = [{ type: "text", text: finalText }];
    }

    // Format request using standard OpenAI format with system and user messages
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent }
    ];

    const { default: fetch } = await import("node-fetch");
    const apiRes = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 100000 }),
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


const BASE_PATH = process.env.BASE_PATH || "/home";

// Redirect root to base path
if (BASE_PATH !== "/") {
  app.get("/", (_req, res) => res.redirect(BASE_PATH));
}

// Serve index.html with BASE_PATH placeholder replaced
app.get(BASE_PATH + "/", (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  res.send(html.replace(/\{\{BASE_PATH\}\}/g, BASE_PATH));
});

// Serve index.html for exact base path match (no trailing slash)
app.get(BASE_PATH, (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  res.send(html.replace(/\{\{BASE_PATH\}\}/g, BASE_PATH));
});

app.use(BASE_PATH, express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Translator running on http://localhost:${PORT}${BASE_PATH}`));
