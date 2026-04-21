# AI Local Translator

A Google Translate–style web app powered by any OpenAI-compatible API.

## Features
- Translate between user selected languages
- Paste text or type directly
- Attach **images** (AI extracts and translates visible text)
- Attach **audio** (transcribed via Whisper if available, then translated)
- Works with any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Groq, Ollama, etc.)

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables**
   ```bash
   touch .env
   ```
   Then edit `.env`:
   ```env
   OPENAI_API_URL=https://api.openai.com   # or your custom endpoint
   OPENAI_API_KEY=sk-...                   # your API key
   OPENAI_MODEL=gpt-4o                     # optional, default model to use
   PORT=3000                               # optional, default 3000
   ```

   By setting the `SYSTEM_PROMPT_FILE` variable it is possible to use a different system prompt. The default one is in `prompts/default_system_prompt.txt`

3. **Run**
   ```bash
   node server.js
   ```
   Open http://localhost:3000

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | — | Your API key |
| `OPENAI_API_URL` | ❌ | `https://api.openai.com` | Base URL of OpenAI-compatible API |
| `OPENAI_MODEL` | ❌ | `gpt-4o` | Model name to use for translation |
| `PORT` | ❌ | `3000` | Port for the web server |

## Compatible APIs
- **OpenAI** — `https://api.openai.com`
- **Azure OpenAI** — `https://<resource>.openai.azure.com`
- **Groq** — `https://api.groq.com/openai`
- **Ollama** — `http://localhost:11434`
- **LM Studio** — `http://localhost:1234`
- **Together AI**, **Mistral**, **Anyscale**, etc.

> **Note:** Audio transcription uses the `/v1/audio/transcriptions` endpoint (Whisper). Not all providers support this — if your provider doesn't, use text or image input instead.
