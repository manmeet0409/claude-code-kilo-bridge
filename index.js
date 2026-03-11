import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  KILO_API_KEY,
  KILO_BASE = "https://api.kilo.ai/api/gateway",
  PORT = 3000,
  INCOMING_API_KEY,
  DEFAULT_MODEL = "minimax/minimax-m2"
} = process.env;

if (!KILO_API_KEY) {
  console.error("KILO_API_KEY required in environment");
  process.exit(1);
}

let models = [];

async function refreshModels() {
  try {
    const resp = await fetch(`${KILO_BASE}/models`);
    const data = await resp.json();
    models = (data.data || []).map(m => m.id);
    console.log("Loaded models:", models.length);
  } catch (err) {
    console.warn("Failed loading models", err?.message || err);
  }
}

refreshModels();
setInterval(refreshModels, 600000);

function pickModel() {
  if (models.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  if (models.length) return models[0];
  return DEFAULT_MODEL;
}

function verifyIncomingAuth(req) {
  if (!INCOMING_API_KEY) return true;

  const authHeader = req.headers.authorization || "";
  const apiKeyHeader = req.headers["x-api-key"] || "";

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim() === INCOMING_API_KEY;
  }

  if (apiKeyHeader) return apiKeyHeader === INCOMING_API_KEY;

  return false;
}

function anthroToOpenAIMessages(body) {
  const out = [];

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      const role = (m.role || "user").toLowerCase();

      let content = "";

      if (typeof m.content === "string") content = m.content;
      else if (Array.isArray(m.content)) {
        content = m.content.map(c => (c && c.text) ? c.text : (typeof c === 'string' ? c : JSON.stringify(c))).join(" ");
      } else if (m.content && typeof m.content === "object") {
        // some Anthropic variants use {type: 'text', text: '...'} or nested objects
        content = m.content.text ?? JSON.stringify(m.content);
      }

      out.push({ role: role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user', content });
    }
  } else if (typeof body.input === "string") {
    out.push({ role: 'user', content: body.input });
  } else if (typeof body.prompt === "string") {
    out.push({ role: 'user', content: body.prompt });
  } else {
    out.push({ role: 'user', content: JSON.stringify(body) });
  }

  return out;
}

function buildOpenAIRequest(body) {
  const messages = anthroToOpenAIMessages(body);

  return {
    model: body.model || pickModel(),
    messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 1024,
    stream: true
  };
}

function sendEvent(res, obj) {
  // Anthropic-compatible SSE framing: explicit event + data lines
  try {
    const eventType = (obj && typeof obj.type === 'string') ? obj.type : 'message';
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    // attempt flush (some Node versions expose res.flush)
    try { res.flush?.(); } catch (e) {}
  } catch (e) {
    console.warn('sendEvent failed', e?.message || e);
  }
}

async function openAIStreamToAnthropic(forward, res, openaiReq) {
  const reader = forward.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  // SSE headers + anti-buffering
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // initial typed ping event
  sendEvent(res, { type: 'ping' });

  const messageId = `msg_${Date.now()}`;

  // message_start (include empty content array)
  sendEvent(res, {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: openaiReq.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }
    }
  });

  // content_block_start (no text property here)
  sendEvent(res, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text" }
  });

  console.log("STREAM STARTED (adapter) for model:", openaiReq.model);

  // keepalive every 15s
  const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (e) {} }, 15000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // split by newline; last fragment stays in buffer
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();

      for (const line of parts) {
        if (!line) continue;
        const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (!raw) continue;
        if (raw === '[DONE]' || raw === '"[DONE]"') { console.log('OPENAI stream signalled DONE'); continue; }

        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { continue; }

        const token = parsed.choices?.[0]?.delta?.content;
        const finishReason = parsed.choices?.[0]?.finish_reason;
        const promptTokens = parsed?.usage?.prompt_tokens;
        const completionTokens = parsed?.usage?.completion_tokens;

        if (typeof promptTokens === 'number') inputTokens = promptTokens;
        if (typeof completionTokens === 'number') outputTokens = completionTokens;

        if (token) {
          fullText += token;
          console.log('TOKEN:', token);

          // send Anthropic content_block_delta with required type
          sendEvent(res, {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: token }
          });
        } else if (finishReason) {
          console.log('Token stream finish reason:', finishReason);
        }
      }
    }
  } catch (err) {
    console.error('stream read loop error:', err?.message || err);
  } finally {
    clearInterval(keepAlive);
  }

  // content_block_stop
  sendEvent(res, { type: 'content_block_stop', index: 0 });

  // message_delta with Anthropic stop fields + usage
  sendEvent(res, {
    type: 'message_delta',
    delta: {
      stop_reason: 'end_turn',
      stop_sequence: null
    },
    usage: {
      output_tokens: outputTokens
    }
  });

  // message_stop
  sendEvent(res, { type: 'message_stop' });

  // end stream
  try { res.write('\n'); res.end(); } catch (e) {}

  console.log('STREAM COMPLETE (adapter). total chars:', fullText.length);
}

// logging middleware
app.use((req, res, next) => {
  console.log('REQ:', req.method, req.url);
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/v1/models', (_req, res) => {
  res.json({ object: 'list', data: models.map(id => ({ id, object: 'model' })) });
});

app.post('/v1/messages', async (req, res) => {
  console.log('CLAUDE REQUEST (truncated):', JSON.stringify(req.body?.messages?.slice?.(0,2) ?? req.body));

  if (!verifyIncomingAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const openaiReq = buildOpenAIRequest(req.body);
    console.log('REQUEST TO KILO model:', openaiReq.model, 'stream:', openaiReq.stream);

    const forward = await fetch(`${KILO_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KILO_API_KEY}` },
      body: JSON.stringify(openaiReq)
    });

    console.log('KILO STATUS', forward.status);
    if (!forward.ok) {
      const err = await forward.text();
      console.error('Kilo returned non-200:', forward.status, err);
      return res.status(502).json({ error: 'upstream_error', status: forward.status, body: err });
    }

    // check content-type for streaming
    const ct = (forward.headers.get('content-type') || '').toLowerCase();
    const isStream = openaiReq.stream && ct.includes('text/event-stream');

    if (openaiReq.stream && !isStream) {
      console.log('Upstream non-SSE content-type, using JSON fallback:', ct || '<none>');
    }

    if (isStream) {
      await openAIStreamToAnthropic(forward, res, openaiReq);
      return;
    }

    // non-stream fallback
    const json = await forward.json();
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? choice?.text ?? '';
    res.json({ id: json.id ?? `msg_${Date.now()}`, type: 'message', role: 'assistant', model: openaiReq.model, content: [{ type: 'text', text }], usage: json.usage ?? null });

  } catch (err) {
    console.error('proxy error:', err?.message || err);
    res.status(500).json({ error: 'internal_error', message: String(err) });
  }
});

app.post('/v1/complete', (req, res) => { req.url = '/v1/messages'; app._router.handle(req, res); });

app.post('/v1/chat/completions', async (req, res) => {
  if (!verifyIncomingAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const forward = await fetch(`${KILO_BASE}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KILO_API_KEY}` }, body: JSON.stringify(req.body) });
    if (!forward.ok) {
      const text = await forward.text();
      return res.status(forward.status).send(text);
    }
    const ct = forward.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      // raw passthrough for OpenAI-style clients
      const reader = forward.body.getReader();
      const decoder = new TextDecoder();
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        res.write(buffer);
        buffer = '';
      }
      res.end();
      return;
    }
    const data = await forward.json();
    res.json(data);
  } catch (err) {
    console.error('chat/completions proxy error:', err?.message || err);
    res.status(500).json({ error: 'proxy_error' });
  }
});

app.listen(PORT, () => {
  console.log(`Claude‑Kilo proxy running on ${PORT}`);
  console.log(`KILO_BASE=${KILO_BASE}`);
  if (INCOMING_API_KEY) console.log('Incoming auth enabled');
});
