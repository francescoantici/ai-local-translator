require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST"] }));
app.use(express.json());

const API_URL = process.env.OPENAI_API_URL || "https://api.openai.com";
const API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OCR_MODEL = process.env.OCR_MODEL || "glm-ocr";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";
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

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

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

// OCR function to extract text from image or PDF using the OCR model
async function ocrExtract(buffer, mimeType, data_args) {
  return new Promise((resolve, reject) => {
    if (mimeType.startsWith("application/pdf") || mimeType === "pdf") {
      // For PDF, first convert to images
      pdfToImages(buffer, (err, imagePaths) => {
        if (err) return reject(err);
        ocrImages(imagePaths, data_args).then(resolve).catch(reject);
      });
    } else if (mimeType.startsWith("image/")) {
      // For images, use OCR model directly
      const imageBytes = buffer.toString("base64");
      queryOcrModelForImage(imageBytes, data_args).then(resolve).catch(reject);
    } else {
      reject(new Error(`Unsupported file type: ${mimeType}`));
    }
  });
}

// Convert PDF pages to images using pdftoppm
function pdfToImages(buffer, callback) {
  const pdfPath = path.join(__dirname, `tmp_${Date.now()}.pdf`);
  fs.writeFileSync(pdfPath, buffer);

  const outputDir = path.join(__dirname, `tmp_pdf_pages_${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const child = spawn('pdftoppm', ['-png', pdfPath, path.join(outputDir, 'page')]);

  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  const imagePaths = [];

  child.on('close', (code) => {
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

    if (code !== 0) {
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { }
      return callback(new Error(`PDF conversion failed: pdftoppm exited with code ${code}${stderr ? ': ' + stderr : ''}`));
    }

    try {
      const imageFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.png'));
      for (const imgFile of imageFiles) {
        imagePaths.push(path.join(outputDir, imgFile));
      }
    } catch (err) {
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { }
      return callback(err);
    }

    // Clean up after image processing completes
    setTimeout(() => {
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { }
    }, 1000);

    callback(null, imagePaths);
  });

  child.on('error', (err) => {
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { }
    callback(new Error(`PDF conversion failed: ${err.message}`));
  });
}

// Query OCR model with image(s) to extract text
async function ocrImages(imagePaths, data_args) {
  const imageBytesList = [];
  for (const imgPath of imagePaths) {
    imageBytesList.push(fs.readFileSync(imgPath).toString("base64"));
  }

  return await queryOcrModelForImages(imageBytesList, data_args);
}

// Query OCR model with single image
async function queryOcrModelForImage(imageBytes, data_args) {
  return await queryOcrModelForImages([imageBytes], data_args);
}

// Query OCR model with multiple images
async function queryOcrModelForImages(imageBytesList, data_args) {
  const { default: fetch } = await import("node-fetch");

  // Load OCR prompt appendix
  const textAppendix = fs.readFileSync(SYSTEM_PROMPT_IMAGE_APPENDIX_FILE, 'utf8');
  const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
    return data_args[key] !== undefined ? data_args[key] : match;
  });

  const userContent = [{ type: "text", text: finalText }];

  for (const imageBytes of imageBytesList) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${imageBytes}`
      }
    });
  }

  const messages = [
    { role: "system", content: finalText },
    { role: "user", content: userContent }
  ];

  try {
    const ocrRes = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ model: OCR_MODEL, messages, max_tokens: 100000 }),
    });

    if (!ocrRes.ok) {
      const err = await ocrRes.text();
      throw new Error(`OCR failed: ${err}`);
    }

    const data = await ocrRes.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (err) {
    console.error("OCR error:", err);
    throw err;
  }
}

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
        // Image handling - use OCR model to extract text first
        try {
          const extractedText = await ocrExtract(file.buffer, mimeType, data_args);

          // Load text appendix for extracted text
          const textAppendix = fs.readFileSync(SYSTEM_PROMPT_TEXT_APPENDIX_FILE, 'utf8');
          const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
            return data_args[key] !== undefined ? data_args[key] : match;
          }).replace(/\$\{text\}/g, extractedText);

          userContent = [{ type: "text", text: finalText }];
        } catch (err) {
          return res.status(500).json({ error: `OCR failed: ${err.message}` });
        }
      } else if (mimeType.startsWith("application/pdf") || file.originalname.toLowerCase().endsWith(".pdf")) {
        // PDF handling - use OCR model to extract text first
        try {
          const extractedText = await ocrExtract(file.buffer, mimeType, data_args);

          // Load text appendix for extracted text
          const textAppendix = fs.readFileSync(SYSTEM_PROMPT_TEXT_APPENDIX_FILE, 'utf8');
          const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
            return data_args[key] !== undefined ? data_args[key] : match;
          }).replace(/\$\{text\}/g, extractedText);

          userContent = [{ type: "text", text: finalText }];
        } catch (err) {
          return res.status(500).json({ error: `OCR failed: ${err.message}` });
        }
      } else if (mimeType.startsWith("audio/")) {
        // Audio handling - transcribe first
        const FormData = (await import("form-data")).default;
        const { default: fetch } = await import("node-fetch");
        const formData = new FormData();
        formData.append("file", file.buffer, { filename: file.originalname, contentType: mimeType });
        formData.append("model", WHISPER_MODEL);
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

// Download file from Slack URL using OAuth token
async function downloadSlackFile(url) {
  const { default: fetch } = await import("node-fetch");
  const slackToken = process.env.SLACK_OAUTH_TOKEN;

  if (!slackToken) {
    throw new Error("SLACK_OAUTH_TOKEN environment variable not set");
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${slackToken}` }
  });

  if (!res.ok) {
    throw new Error(`Slack file download failed: ${res.status} ${res.statusText}`);
  }

  return await res.buffer();
}

// Process text and files for translation (reusable from translate endpoint)
async function processTranslationInput({ sourceLang, targetLang, text, files, model }) {
  const MODEL = model || DEFAULT_MODEL;
  const data_args = { sourceLang, targetLang };

  // Load base system prompt
  let systemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8').replace(/\$\{([^}]+)\}/g, (match, key) => {
    return data_args[key] !== undefined ? data_args[key] : match;
  });

  // Process text and files separately, then combine
  let combinedText = "";

  if (text) {
    const textAppendix = fs.readFileSync(SYSTEM_PROMPT_TEXT_APPENDIX_FILE, 'utf8');
    const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
      return data_args[key] !== undefined ? data_args[key] : match;
    }).replace(/\$\{text\}/g, text);
    combinedText = finalText;
  }

  // Process each file
  for (const file of files || []) {
    const mimeType = file.mimetype;

    try {
      let extractedText = "";

      if (mimeType.startsWith("image/") || mimeType.startsWith("application/pdf") ||
        file.name.toLowerCase().endsWith(".pdf")) {
        // Download the file from Slack if it's a URL
        let buffer;
        if (file.url_private_download || file.url_private) {
          const downloadUrl = file.url_private_download || file.url_private;
          buffer = await downloadSlackFile(downloadUrl);
        } else {
          throw new Error("No valid file URL provided");
        }

        extractedText = await ocrExtract(buffer, mimeType, data_args);
      } else if (mimeType.startsWith("audio/")) {
        let buffer;
        if (file.url_private_download || file.url_private) {
          const downloadUrl = file.url_private_download || file.url_private;
          buffer = await downloadSlackFile(downloadUrl);
        } else {
          throw new Error("No valid file URL provided");
        }

        const FormData = (await import("form-data")).default;
        const { default: fetch } = await import("node-fetch");
        const formData = new FormData();
        formData.append("file", buffer, { filename: file.name || "audio", contentType: mimeType });
        formData.append("model", WHISPER_MODEL);

        const whisperRes = await fetch(`${API_URL}/v1/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}`, ...formData.getHeaders() },
          body: formData,
        });

        if (!whisperRes.ok) {
          const err = await whisperRes.text();
          throw new Error(`Audio transcription failed: ${err}`);
        }

        const whisperData = await whisperRes.json();
        extractedText = whisperData.text || "";
      } else {
        throw new Error(`Unsupported file type: ${mimeType}`);
      }

      // Load text appendix for extracted content
      const textAppendix = fs.readFileSync(SYSTEM_PROMPT_TEXT_APPENDIX_FILE, 'utf8');
      const finalText = textAppendix.replace(/\$\{([^}]+)\}/g, (match, key) => {
        return data_args[key] !== undefined ? data_args[key] : match;
      }).replace(/\$\{text\}/g, extractedText);

      combinedText = (combinedText ? combinedText + "\n\n" : "") + finalText;
    } catch (err) {
      console.error(`Error processing file ${file.name}:`, err);
      throw err;
    }
  }

  // Format request using standard OpenAI format with system and user messages
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: [{ type: "text", text: combinedText }] }
  ];

  const { default: fetch } = await import("node-fetch");
  const apiRes = await fetch(`${API_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 100000 }),
  });

  if (!apiRes.ok) {
    const err = await apiRes.text();
    throw new Error(`API error: ${err}`);
  }

  const data = await apiRes.json();
  return { translation: data.choices?.[0]?.message?.content || "", model: MODEL };
}

// Translate to English endpoint
app.post("/api/translate-to-english", async (req, res) => {
  try {
    const { message, model } = req.body;
    const text = message?.text || "";
    const files = message?.files || [];

    if (!text && (!files || files.length === 0)) {
      return res.status(400).json({ error: "No content provided for translation." });
    }

    const result = await processTranslationInput({
      sourceLang: "Japanese",
      targetLang: "English",
      text,
      files,
      model
    });

    res.json(result);
  } catch (err) {
    console.error("Translate to English error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Translate to Japanese endpoint
app.post("/api/translate-to-japanese", async (req, res) => {
  try {
    const { message, model } = req.body;
    const text = message?.text || "";
    const files = message?.files || [];

    if (!text && (!files || files.length === 0)) {
      return res.status(400).json({ error: "No content provided for translation." });
    }

    const result = await processTranslationInput({
      sourceLang: "English",
      targetLang: "Japanese",
      text,
      files,
      model
    });

    res.json(result);
  } catch (err) {
    console.error("Translate to Japanese error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Translator running on http://localhost:${PORT}${BASE_PATH}`));
