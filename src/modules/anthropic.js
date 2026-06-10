// src/modules/anthropic.js — Anthropic API 格式适配器
// 纯函数，无 DOM 操作。内部保持 OpenAI 格式，只在边界转换。

export function buildEndpointUrl(baseUrl) {
  const raw = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(raw) ? `${raw}/messages` : `${raw}/v1/messages`;
}

export function convertRequestBody(oaiBody) {
  const systemBlocks = [];
  const nonSystemMsgs = [];

  for (const msg of oaiBody.messages) {
    if (msg.role === 'system') {
      if (Array.isArray(msg.content)) {
        systemBlocks.push(...msg.content);
      } else if (msg.content) {
        systemBlocks.push({ type: 'text', text: msg.content });
      }
    } else {
      nonSystemMsgs.push(msg);
    }
  }

  const converted = [];
  for (const msg of nonSystemMsgs) {
    if (msg.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content || '' };
      const last = converted[converted.length - 1];
      if (last && last.role === 'user' && last._isToolResult) {
        last.content.push(block);
      } else {
        converted.push({ role: 'user', content: [block], _isToolResult: true });
      }
    } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const blocks = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || tc.args || '{}'); } catch {}
        blocks.push({
          type: 'tool_use',
          id: tc.id || tc.function?.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: tc.function?.name || tc.name,
          input
        });
      }
      converted.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      const parts = msg.content.map(_convertContentPart);
      converted.push({ role: 'user', content: parts });
    } else {
      converted.push({ role: msg.role, content: msg.content || '' });
    }
  }

  const merged = _ensureAlternation(converted);

  const body = {
    model: oaiBody.model,
    max_tokens: oaiBody.max_tokens || 8192,
    messages: merged,
    stream: oaiBody.stream !== undefined ? oaiBody.stream : true,
  };
  if (oaiBody.temperature !== undefined) body.temperature = oaiBody.temperature;
  if (systemBlocks.length) body.system = systemBlocks;

  if (oaiBody.tools?.length) {
    body.tools = oaiBody.tools.map(t => {
      const fn = t.function || t;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters || fn.input_schema };
    });
    if (oaiBody.tool_choice !== undefined) {
      body.tool_choice = _convertToolChoice(oaiBody.tool_choice);
    }
  }

  return body;
}

function _convertContentPart(part) {
  if (part.type === 'image_url') {
    const url = part.image_url?.url || '';
    const m = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (m) {
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    }
    if (/^https?:\/\//.test(url)) {
      return { type: 'image', source: { type: 'url', url } };
    }
    return { type: 'text', text: '[图片]' };
  }
  return part;
}

function _convertToolChoice(tc) {
  if (tc === 'auto') return { type: 'auto' };
  if (tc === 'none') return { type: 'none' };
  if (tc === 'required') return { type: 'any' };
  if (tc?.type === 'function' && tc.function?.name) return { type: 'tool', name: tc.function.name };
  if (typeof tc === 'object' && tc.type) return tc;
  return { type: 'auto' };
}

function _ensureAlternation(msgs) {
  const result = [];
  for (const msg of msgs) {
    const clean = { role: msg.role, content: msg.content };
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content = _mergeContent(last.content, clean.content);
    } else {
      result.push(clean);
    }
  }
  if (result.length && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: '.' });
  }
  return result;
}

function _mergeContent(a, b) {
  const toArray = v => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return [{ type: 'text', text: v }];
    return v ? [v] : [];
  };
  return [...toArray(a), ...toArray(b)];
}

// === SSE 响应解析 ===

export function parseAnthropicEvent(eventType, dataStr) {
  let data;
  try { data = JSON.parse(dataStr); } catch { return null; }

  switch (eventType || data.type) {
    case 'message_start': {
      const u = data.message?.usage;
      return {
        model: data.message?.model,
        usage: u ? {
          prompt_tokens: u.input_tokens,
          input_tokens: u.input_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
          cache_read_input_tokens: u.cache_read_input_tokens || 0
        } : undefined
      };
    }
    case 'content_block_start': {
      const cb = data.content_block;
      if (cb?.type === 'tool_use') {
        return { toolStart: { index: data.index, id: cb.id, name: cb.name } };
      }
      return {};
    }
    case 'content_block_delta': {
      const d = data.delta;
      if (d?.type === 'text_delta') return { content: d.text };
      if (d?.type === 'thinking_delta') return { thinking: d.thinking };
      if (d?.type === 'input_json_delta') return { toolDelta: { index: data.index, arguments: d.partial_json } };
      if (d?.type === 'signature_delta') return {};
      return {};
    }
    case 'content_block_stop':
      return {};
    case 'message_delta': {
      const result = {};
      if (data.delta?.stop_reason) result.stop_reason = data.delta.stop_reason;
      if (data.usage) {
        result.usage = {
          completion_tokens: data.usage.output_tokens,
          output_tokens: data.usage.output_tokens
        };
      }
      return result;
    }
    case 'message_stop':
      return { stop: true };
    case 'ping':
      return {};
    default:
      return {};
  }
}

export function anthropicToOpenAIResponse(json) {
  let content = '', thinking = '';
  const toolCalls = [];
  for (const block of (json.content || [])) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'thinking') thinking += block.thinking || '';
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
      });
    }
  }
  const msg = { role: 'assistant', content: content || null };
  if (thinking) msg.reasoning_content = thinking;
  if (toolCalls.length) msg.tool_calls = toolCalls;

  let finish_reason = 'stop';
  if (json.stop_reason === 'tool_use') finish_reason = 'tool_calls';
  else if (json.stop_reason === 'max_tokens') finish_reason = 'length';
  else if (json.stop_reason === 'end_turn') finish_reason = 'stop';

  const u = json.usage || {};
  const usage = {
    prompt_tokens: u.input_tokens || 0,
    completion_tokens: u.output_tokens || 0,
    total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0
  };

  return { choices: [{ message: msg, finish_reason }], usage, model: json.model || '' };
}

export function buildAnthropicHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
}
