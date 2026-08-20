// bouchhub-agent/local.js
//
// A door onto the local AI stack running on this PC — Ollama for text, ComfyUI
// for images and video. Both bind to 127.0.0.1 and stay that way: the hub never
// talks to them directly, it asks this agent, which is already authenticated by
// AGENT_SECRET. That keeps an uncensored local model and a generation queue off
// the LAN entirely.
//
// Nothing here assumes the stack is installed. Every call reports plainly when a
// service isn't answering, because "install it and start it" is a different
// problem from "it errored".

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const TEXT_MODEL = process.env.LOCAL_TEXT_MODEL || 'qwen3-27b-uncensored';
// Vision is a separate model and only loads on turns that carry an image.
const VISION_MODEL = process.env.LOCAL_VISION_MODEL || '';

function f() { return global.fetch || require('node-fetch'); }

async function jsonReq(url, { method = 'GET', body, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f()(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) throw new Error((json && (json.error?.message || json.error)) || `HTTP ${res.status}: ${text.slice(0, 200)}`);
    return json;
  } finally { clearTimeout(timer); }
}

// ── Health ───────────────────────────────────────────────────────────────────
// Reports each service separately. Half a stack is a normal state to be in
// while it is still being set up, and the UI needs to say which half.
async function health() {
  // Both model names come from THIS machine's .env and are reported outward,
  // so the hub never has to keep a second copy of them in sync.
  const out = { textModel: TEXT_MODEL, visionModel: VISION_MODEL || null, ollama: { ok: false }, comfy: { ok: false } };
  try {
    const tags = await jsonReq(`${OLLAMA}/api/tags`, { timeoutMs: 5000 });
    out.ollama = {
      ok: true,
      models: (tags.models || []).map(m => m.name),
      hasTextModel: (tags.models || []).some(m => m.name === TEXT_MODEL || m.name.startsWith(TEXT_MODEL.split(':')[0])),
      hasVisionModel: !VISION_MODEL ? null : (tags.models || []).some(m => m.name === VISION_MODEL || m.name.startsWith(VISION_MODEL.split(':')[0])),
    };
  } catch (e) { out.ollama = { ok: false, error: reason(e) }; }
  try {
    const stats = await jsonReq(`${COMFY}/system_stats`, { timeoutMs: 5000 });
    const gpu = (stats.devices || [])[0] || {};
    out.comfy = {
      ok: true,
      gpu: gpu.name || null,
      vramTotalMB: gpu.vram_total ? Math.round(gpu.vram_total / 1048576) : null,
      vramFreeMB: gpu.vram_free ? Math.round(gpu.vram_free / 1048576) : null,
    };
  } catch (e) { out.comfy = { ok: false, error: reason(e) }; }
  return out;
}

function reason(e) {
  const m = String(e && e.message || e);
  if (/ECONNREFUSED|fetch failed|abort/i.test(m)) return 'not running';
  return m.slice(0, 200);
}

// ── Text ─────────────────────────────────────────────────────────────────────
// Ollama's OpenAI-compatible endpoint, so the same call shape works if this is
// ever pointed at llama.cpp's server or anything else that speaks it.
async function chat({ messages, model = TEXT_MODEL, temperature = 0.8, maxTokens = 2048, keepAliveS = 300 }) {
  const body = {
    model, messages, temperature, max_tokens: maxTokens,
    // keep_alive controls how long the weights stay resident. Short by default
    // so a 27B model isn't sitting on VRAM that FLUX is about to need.
    keep_alive: `${keepAliveS}s`,
  };
  const r = await jsonReq(`${OLLAMA}/v1/chat/completions`, { method: 'POST', body, timeoutMs: 600000 });
  const raw = r.choices?.[0]?.message?.content || '';
  return { text: stripThinking(raw), thinking: thinkingOf(raw), model: r.model || model, usage: r.usage || null };
}

// GLM-4.7-Flash is a reasoning model: it emits its scratchpad inside <think>
// tags before the answer. Handing that to a chat bubble, or to a prompt field
// that feeds FLUX, means the reasoning becomes the output. Strip it — and keep
// it separately, because when a reply is wrong the scratchpad is usually where
// the reason is.
const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
function stripThinking(text) {
  let out = String(text || '').replace(THINK_RE, '');
  // An unterminated block means the model ran out of tokens mid-thought; keep
  // what follows the last opener rather than returning the whole scratchpad.
  const open = out.lastIndexOf('<think>');
  if (open !== -1) out = out.slice(open + 7).replace(/<\/?think>/gi, '');
  return out.trim();
}
function thinkingOf(text) {
  const found = String(text || '').match(THINK_RE) || [];
  const joined = found.map(t => t.replace(/<\/?think>/gi, '').trim()).join('\n').trim();
  return joined || null;
}

// Drop the text model out of VRAM. This is the switch that makes 16GB workable:
// call it before a heavy ComfyUI run rather than hoping the two fit together.
async function unloadText(model = TEXT_MODEL) {
  try {
    await jsonReq(`${OLLAMA}/api/generate`, { method: 'POST', body: { model, keep_alive: 0 }, timeoutMs: 30000 });
    return { ok: true, unloaded: model };
  } catch (e) { return { ok: false, error: reason(e) }; }
}

// ── ComfyUI ──────────────────────────────────────────────────────────────────
// Queue a workflow and wait for it. ComfyUI is asynchronous — you post a prompt,
// get an id, and poll history — so the waiting is done here rather than making
// the hub own a polling loop across the network.
async function runWorkflow(workflow, { timeoutMs = 20 * 60 * 1000, onProgress } = {}) {
  const clientId = `bouchhub-${Date.now()}`;
  const queued = await jsonReq(`${COMFY}/prompt`, {
    method: 'POST', body: { prompt: workflow, client_id: clientId }, timeoutMs: 60000,
  });
  const id = queued.prompt_id;
  if (!id) throw new Error('ComfyUI accepted the job but returned no prompt_id');

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, 1500));
    let hist;
    try { hist = await jsonReq(`${COMFY}/history/${id}`, { timeoutMs: 15000 }); }
    catch (_) { continue; }                       // a busy Comfy can drop a poll
    const entry = hist && hist[id];
    if (!entry) { if (onProgress) onProgress({ id, state: 'queued' }); continue; }

    const status = entry.status || {};
    if (status.status_str === 'error' || status.completed === false && status.messages?.some(m => m[0] === 'execution_error')) {
      throw new Error(comfyError(status));
    }
    if (status.completed) {
      const files = [];
      for (const [nodeId, out] of Object.entries(entry.outputs || {})) {
        for (const kind of ['images', 'gifs', 'videos']) {
          for (const file of out[kind] || []) {
            files.push({ node: nodeId, kind, filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
          }
        }
      }
      if (!files.length) throw new Error('the workflow finished but produced no image or video output');
      return { id, files, tookMs: Date.now() - started };
    }
  }
  throw new Error(`ComfyUI did not finish within ${Math.round(timeoutMs / 60000)} minutes`);
}

// Pull the real reason out of ComfyUI's status messages — the top-level string
// is almost always just "error", which tells you nothing.
function comfyError(status) {
  for (const m of status.messages || []) {
    if (m[0] === 'execution_error' && m[1]) {
      const d = m[1];
      return `${d.node_type || 'a node'} failed: ${d.exception_message || d.exception_type || 'unknown error'}`;
    }
  }
  return status.status_str || 'ComfyUI reported an error with no detail';
}

// Fetch a produced file's bytes so the hub can store it as a chat attachment.
async function fetchOutput({ filename, subfolder = '', type = 'output' }) {
  const q = new URLSearchParams({ filename, subfolder, type });
  const res = await f()(`${COMFY}/view?${q}`);
  if (!res.ok) throw new Error(`could not read ${filename} back from ComfyUI (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') || 'application/octet-stream' };
}

// Push a reference or source image INTO ComfyUI's input folder, which is how a
// hero still gets handed to the video workflow and how face references arrive.
async function uploadInput(buffer, filename) {
  const form = new FormData();
  form.append('image', new Blob([buffer]), filename);
  form.append('overwrite', 'true');
  const res = await f()(`${COMFY}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ComfyUI rejected the upload (HTTP ${res.status})`);
  const j = await res.json();
  return { name: j.name, subfolder: j.subfolder || '', type: j.type || 'input' };
}

async function interrupt() {
  try { await f()(`${COMFY}/interrupt`, { method: 'POST' }); return { ok: true }; }
  catch (e) { return { ok: false, error: reason(e) }; }
}

// ── The face-match photo pipeline ────────────────────────────────────────────
// Three stages, because only the middle one needs Python: ComfyUI generates the
// base image, insightface swaps the faces in frame order, ComfyUI restores and
// upscales. The swap has to run in ComfyUI's own venv — that is the interpreter
// with insightface — so it goes out as a subprocess rather than being reimplemented.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const COMFY_HOME = process.env.COMFY_HOME || path.join(os.homedir(), 'AI', 'ComfyUI');
const COMFY_PYTHON = process.env.COMFY_PYTHON || path.join(COMFY_HOME, '.venv', 'Scripts', 'python.exe');
const SWAPPER = process.env.INSWAPPER_PATH || path.join(COMFY_HOME, 'models', 'insightface', 'inswapper_128.onnx');

function runPython(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    execFile(COMFY_PYTHON, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// Swap reference faces into a generated image, left to right.
async function swapFaces({ basePath, refPaths, outPath }) {
  if (!fs.existsSync(COMFY_PYTHON)) {
    throw new Error(`ComfyUI's python is not at ${COMFY_PYTHON} — set COMFY_PYTHON in the agent .env. The swap needs the interpreter that has insightface.`);
  }
  if (!fs.existsSync(SWAPPER)) {
    throw new Error(`the face model is missing: ${SWAPPER}`);
  }
  const args = [path.join(__dirname, 'scripts', 'faceswap.py'),
    '--base', basePath, '--out', outPath, '--swapper', SWAPPER];
  for (const r of refPaths) args.push('--ref', r);

  const r = await runPython(args);
  let parsed = null;
  try { parsed = JSON.parse((r.stdout.trim().split('\n').filter(Boolean).pop()) || '{}'); } catch (_) {}
  if (!parsed || !parsed.ok) {
    throw new Error((parsed && parsed.error) || `the face swap failed: ${(r.stderr || r.stdout || 'no output').slice(-300)}`);
  }
  return parsed;
}

module.exports = {
  health, chat, unloadText, runWorkflow, fetchOutput, uploadInput, interrupt,
  swapFaces, stripThinking, thinkingOf,
  OLLAMA, COMFY, TEXT_MODEL, VISION_MODEL, COMFY_HOME, COMFY_PYTHON, SWAPPER, comfyError,
};
