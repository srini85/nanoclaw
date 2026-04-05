/**
 * Lightweight Anthropic-to-DeepSeek translation proxy.
 * Receives Anthropic Messages API requests from the Claude Agent SDK,
 * translates them to OpenAI Chat Completions format, forwards to DeepSeek,
 * and translates the response back to Anthropic format.
 *
 * Supports both streaming (SSE) and non-streaming modes.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... ROUTER_MODEL=deepseek-chat node deepseek-proxy.mjs
 *   # Listens on port 3456 by default (PROXY_PORT to override)
 */

import http from 'http';
import https from 'https';

const PORT = parseInt(process.env.PROXY_PORT || '3456', 10);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEFAULT_MODEL = process.env.ROUTER_MODEL || 'deepseek-chat';

// --- Request tracking / token accounting ---

let requestSeq = 0;
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let sessionCacheHitTokens = 0;
let sessionCacheMissTokens = 0;
const sessionStart = Date.now();

function logRequest(seq, { inputTokens, outputTokens, cacheHit, cacheMiss, model, toolCount, msgCount, systemChars, durationMs, stream, error }) {
  sessionInputTokens += inputTokens || 0;
  sessionOutputTokens += outputTokens || 0;
  sessionCacheHitTokens += cacheHit || 0;
  sessionCacheMissTokens += cacheMiss || 0;

  const elapsed = ((Date.now() - sessionStart) / 1000).toFixed(0);
  const parts = [
    `[proxy] #${seq}`,
    stream ? 'stream' : 'sync',
    `model=${model}`,
    `msgs=${msgCount}`,
    `tools=${toolCount}`,
    `sys=${systemChars}ch`,
    `in=${(inputTokens || 0).toLocaleString()}`,
    `out=${(outputTokens || 0).toLocaleString()}`,
  ];
  if (cacheHit) parts.push(`cache_hit=${cacheHit.toLocaleString()}`);
  if (cacheMiss) parts.push(`cache_miss=${cacheMiss.toLocaleString()}`);
  if (durationMs != null) parts.push(`${durationMs}ms`);
  if (error) parts.push(`ERR=${error}`);
  parts.push(`| session: in=${sessionInputTokens.toLocaleString()} out=${sessionOutputTokens.toLocaleString()} (${elapsed}s)`);

  console.error(parts.join(' '));
}

// --- Anthropic → OpenAI format translation ---

function anthropicToOpenAI(body) {
  const messages = [];

  // System prompt
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      if (text) messages.push({ role: 'system', content: text });
    }
  }

  // Messages
  for (const msg of body.messages || []) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        if (text) messages.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Handle tool_use blocks
        const textParts = msg.content.filter(b => b.type === 'text');
        const toolUseParts = msg.content.filter(b => b.type === 'tool_use');

        const text = textParts.map(b => b.text).join('');
        const toolCalls = toolUseParts.map(b => ({
          id: b.id,
          type: 'function',
          function: {
            name: b.name,
            arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input),
          },
        }));

        const assistantMsg = { role: 'assistant' };
        if (text) assistantMsg.content = text;
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        messages.push(assistantMsg);
      }
    } else if (msg.role === 'tool') {
      // Anthropic tool_result → OpenAI tool message
      // In Anthropic format, tool results come as user messages with tool_result content blocks
    }

    // Handle user messages that contain tool_result blocks (Anthropic format)
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter(b => b.type === 'tool_result');
      if (toolResults.length > 0) {
        // Remove the last user message we just added (it was for text, not tool results)
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'user') messages.pop();

        for (const tr of toolResults) {
          let content = '';
          if (typeof tr.content === 'string') {
            content = tr.content;
          } else if (Array.isArray(tr.content)) {
            content = tr.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('\n');
          }
          messages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: content || '(empty result)',
          });
        }

        // Re-add any text content that was alongside tool results
        const textParts = msg.content.filter(b => b.type === 'text');
        if (textParts.length > 0) {
          const text = textParts.map(b => b.text).join('\n');
          if (text) messages.push({ role: 'user', content: text });
        }
      }
    }
  }

  // Tools — ensure every parameters schema has type:"object" (DeepSeek rejects null/missing type)
  const tools = (body.tools || []).map(t => {
    const schema = t.input_schema || {};
    if (!schema.type) schema.type = 'object';
    if (!schema.properties) schema.properties = {};
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: schema,
      },
    };
  });

  const result = {
    model: DEFAULT_MODEL,
    messages,
    max_tokens: Math.min(body.max_tokens || 4096, 8192),
    stream: !!body.stream,
  };

  if (tools.length > 0) result.tools = tools;
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;

  return result;
}

// --- OpenAI → Anthropic format translation ---

function openAIToAnthropic(oaiResp, model) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: oaiResp.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: model || DEFAULT_MODEL,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content = [];
  const msg = choice.message;

  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = tc.function.arguments;
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // Map stop reason
  let stopReason = 'end_turn';
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens';

  return {
    id: oaiResp.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model || DEFAULT_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
    },
  };
}

// --- Streaming translation (OpenAI SSE → Anthropic SSE) ---

function createStreamTranslator(res, model) {
  let messageId = `msg_${Date.now()}`;
  let contentIndex = 0;
  let sentStart = false;
  let textBlockStarted = false;
  let currentToolId = null;
  let currentToolName = null;
  // Expose usage from the final streaming chunk
  const usage = { inputTokens: 0, outputTokens: 0, cacheHit: 0, cacheMiss: 0 };

  function sendEvent(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function startMessage() {
    if (sentStart) return;
    sentStart = true;
    sendEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: model || DEFAULT_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  return {
    getUsage() { return usage; },
    processChunk(chunk) {
      // Parse OpenAI SSE chunk
      if (chunk === '[DONE]') {
        sendEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        sendEvent('message_stop', { type: 'message_stop' });
        return true; // done
      }

      let data;
      try {
        data = JSON.parse(chunk);
      } catch {
        return false;
      }

      const delta = data.choices?.[0]?.delta;
      if (!delta) return false;

      startMessage();

      // Text content
      if (delta.content) {
        if (!textBlockStarted && !currentToolId) {
          textBlockStarted = true;
          sendEvent('content_block_start', {
            type: 'content_block_start',
            index: contentIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: contentIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id && tc.id !== currentToolId) {
            // Close previous block if needed
            if (currentToolId || contentIndex > 0) {
              sendEvent('content_block_stop', {
                type: 'content_block_stop',
                index: contentIndex,
              });
              contentIndex++;
            }
            currentToolId = tc.id;
            currentToolName = tc.function?.name;
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: contentIndex,
              content_block: {
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name || '',
                input: {},
              },
            });
          }
          if (tc.function?.arguments) {
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index: contentIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }

      // Capture usage from any chunk that has it
      if (data.usage) {
        usage.inputTokens = data.usage.prompt_tokens || 0;
        usage.outputTokens = data.usage.completion_tokens || 0;
        usage.cacheHit = data.usage.prompt_cache_hit_tokens || 0;
        usage.cacheMiss = data.usage.prompt_cache_miss_tokens || 0;
      }

      // Check finish reason
      const finishReason = data.choices?.[0]?.finish_reason;
      if (finishReason) {
        sendEvent('content_block_stop', {
          type: 'content_block_stop',
          index: contentIndex,
        });

        let stopReason = 'end_turn';
        if (finishReason === 'tool_calls') stopReason = 'tool_use';
        else if (finishReason === 'length') stopReason = 'max_tokens';

        sendEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: data.usage?.completion_tokens || 0 },
        });
        sendEvent('message_stop', { type: 'message_stop' });
        return true;
      }

      return false;
    },
  };
}

// --- HTTP Server ---

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', provider: 'deepseek', model: DEFAULT_MODEL }));
    return;
  }

  // Only handle POST /v1/messages
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const seq = ++requestSeq;
    const reqStart = Date.now();
    const isStream = !!body.stream;
    const openAIBody = anthropicToOpenAI(body);

    // Pre-request metadata
    const msgCount = openAIBody.messages?.length || 0;
    const toolCount = openAIBody.tools?.length || 0;
    const systemChars = openAIBody.messages
      ?.filter(m => m.role === 'system')
      .reduce((sum, m) => sum + (m.content?.length || 0), 0) || 0;

    const payload = JSON.stringify(openAIBody);
    const upstream = new URL(DEEPSEEK_BASE);

    const options = {
      hostname: upstream.hostname,
      port: upstream.port || 443,
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const makeReq = upstream.protocol === 'https:' ? https.request : http.request;

    const upstreamReq = makeReq(options, (upstreamRes) => {
      if (upstreamRes.statusCode !== 200) {
        let errBody = '';
        upstreamRes.on('data', d => errBody += d);
        upstreamRes.on('end', () => {
          logRequest(seq, {
            model: openAIBody.model, toolCount, msgCount, systemChars, stream: isStream,
            inputTokens: 0, outputTokens: 0,
            durationMs: Date.now() - reqStart,
            error: `${upstreamRes.statusCode}: ${errBody.slice(0, 120)}`,
          });
          console.error(`[proxy] DeepSeek returned ${upstreamRes.statusCode}: ${errBody}`);
          res.writeHead(upstreamRes.statusCode || 500, { 'Content-Type': 'application/json' });
          try {
            // Try to wrap in Anthropic error format
            const parsed = JSON.parse(errBody);
            res.end(JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: parsed.error?.message || errBody,
              },
            }));
          } catch {
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: errBody },
            }));
          }
        });
        return;
      }

      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const translator = createStreamTranslator(res, body.model);
        let buffer = '';

        upstreamRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;
            const done = translator.processChunk(data);
            if (done) {
              res.end();
              return;
            }
          }
        });

        upstreamRes.on('end', () => {
          // Process any remaining buffer
          if (buffer.startsWith('data: ')) {
            translator.processChunk(buffer.slice(6).trim());
          }
          const u = translator.getUsage();
          logRequest(seq, {
            model: openAIBody.model, toolCount, msgCount, systemChars, stream: true,
            inputTokens: u.inputTokens, outputTokens: u.outputTokens,
            cacheHit: u.cacheHit, cacheMiss: u.cacheMiss,
            durationMs: Date.now() - reqStart,
          });
          res.end();
        });
      } else {
        let respBody = '';
        upstreamRes.on('data', d => respBody += d);
        upstreamRes.on('end', () => {
          try {
            const oaiResp = JSON.parse(respBody);
            const anthropicResp = openAIToAnthropic(oaiResp, body.model);
            logRequest(seq, {
              model: openAIBody.model, toolCount, msgCount, systemChars, stream: false,
              inputTokens: oaiResp.usage?.prompt_tokens || 0,
              outputTokens: oaiResp.usage?.completion_tokens || 0,
              cacheHit: oaiResp.usage?.prompt_cache_hit_tokens || 0,
              cacheMiss: oaiResp.usage?.prompt_cache_miss_tokens || 0,
              durationMs: Date.now() - reqStart,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(anthropicResp));
          } catch (err) {
            console.error(`[proxy] Failed to parse DeepSeek response: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: 'Failed to parse upstream response' },
            }));
          }
        });
      }
    });

    upstreamReq.on('error', (err) => {
      console.error(`[proxy] Upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Upstream error: ${err.message}` },
        }));
      }
    });

    upstreamReq.write(payload);
    upstreamReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[deepseek-proxy] Listening on 127.0.0.1:${PORT}`);
  console.error(`[deepseek-proxy] Translating Anthropic API -> DeepSeek (model: ${DEFAULT_MODEL})`);
});
