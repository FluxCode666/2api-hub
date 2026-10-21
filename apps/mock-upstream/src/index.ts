/*
 * 入口：mock-upstream HTTP 服务（Node 原生 http，无框架）。
 *
 * 路径结构：http://127.0.0.1:8712/<scenario>/v1/...
 * 支持 OpenAI chat/completions、OpenAI responses、Anthropic messages、Gemini
 * generateContent/streamGenerateContent（流式与非流式）+ 模型列表。
 * 行为按 scenario 差异化（见 scenarios.ts），用于测试 @hub/probe 检测引擎。
 */

import http from 'node:http';
import { SCENARIOS, SCENARIO_BEHAVIORS, isScenario, ttftMs, type Protocol, type Scenario } from './scenarios.js';
import { generateReply } from './replies.js';
import { computeUsage } from './usage.js';
import { buildNonStream, thinkingFor, writeStream, type ReplyContext, type ToolCallSpec } from './protocols.js';

const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 8712);
const HOST = process.env.MOCK_HOST ?? '127.0.0.1';
const BODY_LIMIT = 1024 * 1024; // 1MB

/** fake 场景的模型名改写 */
function rewriteModelForFake(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'gpt-4o-mini';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'claude-3-5-haiku';
  return 'some-random-model';
}

// ---------------- 请求体文本抽取 ----------------

interface ExtractedRequest {
  /** 请求文本（system + user 全部文本，用于回复匹配与 token 计数） */
  inputText: string;
  model: string;
  stream: boolean;
  /** 是否为工具调用请求（body 带 tools / functionDeclarations） */
  hasTools: boolean;
  /** anthropic thinking 参数 */
  hasThinking: boolean;
  /** P2#11 严格协议校验：非法请求返回 400 */
  validationError: string | null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') return (p as { text: string }).text;
        return '';
      })
      .join('');
  }
  return '';
}

/** 从各协议请求体抽取统一信息 */
function extractRequest(protocol: Protocol, body: Record<string, unknown>): ExtractedRequest {
  const model = typeof body.model === 'string' ? body.model : 'unknown-model';
  const stream = body.stream === true;
  let inputText = '';
  let hasTools = false;
  let hasThinking = false;

  if (protocol === 'openai_chat') {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    inputText = messages
      .map((m) => {
        const msg = m as { role?: unknown; content?: unknown };
        const role = typeof msg.role === 'string' ? msg.role : '';
        return role === 'system' || role === 'user' ? textFromContent(msg.content) : '';
      })
      .filter(Boolean)
      .join('\n');
    hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  } else if (protocol === 'openai_responses') {
    const input = Array.isArray(body.input) ? body.input : [];
    inputText = input
      .map((m) => {
        const msg = m as { role?: unknown; content?: unknown };
        const role = typeof msg.role === 'string' ? msg.role : '';
        return role === 'system' || role === 'user' ? textFromContent(msg.content) : '';
      })
      .filter(Boolean)
      .join('\n');
    hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  } else if (protocol === 'anthropic') {
    // system 可能为顶层字符串，或 role=system 消息，也可能是数组（分段文本），均接受
    const sysParts: string[] = [];
    if (typeof body.system === 'string') {
      sysParts.push(body.system);
    } else if (Array.isArray(body.system)) {
      sysParts.push(body.system.map((s) => textFromContent(s)).join(''));
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    inputText = [
      ...sysParts,
      ...messages.map((m) => {
        const msg = m as { role?: unknown; content?: unknown };
        const role = typeof msg.role === 'string' ? msg.role : '';
        return role === 'system' || role === 'user' ? textFromContent(msg.content) : '';
      }),
    ]
      .filter(Boolean)
      .join('\n');
    hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    hasThinking = body.thinking !== undefined && body.thinking !== null;
  } else {
    // gemini
    const parts: string[] = [];
    const sys = body.systemInstruction as { parts?: unknown } | undefined;
    if (sys && Array.isArray(sys.parts)) parts.push(textFromContent(sys.parts));
    const contents = Array.isArray(body.contents) ? body.contents : [];
    parts.push(
      ...contents.map((c) => {
        const item = c as { role?: unknown; parts?: unknown };
        const role = typeof item.role === 'string' ? item.role : '';
        return role === 'user' || role === 'model' ? textFromContent(item.parts) : '';
      }),
    );
    inputText = parts.filter(Boolean).join('\n');
    const tools = body.tools as { functionDeclarations?: unknown }[] | undefined;
    hasTools = Array.isArray(tools) && tools.some((t) => Array.isArray(t.functionDeclarations) && t.functionDeclarations.length > 0);
  }

  return { inputText, model, stream, hasTools, hasThinking, validationError: validateProtocolRequest(protocol, body) };
}

/**
 * P2#11 严格协议校验（审查要求：结构非法返回 400，才能发现检测器同类问题）：
 * - anthropic：thinking.budget_tokens 必须 < max_tokens（官方约束）
 * - openai_responses：tools 必须是顶层 {type:'function', name, parameters} 结构
 *   （Chat Completions 的 {type:'function',function:{name,...}} 嵌套结构非法）
 */
function validateProtocolRequest(
  protocol: Protocol,
  body: Record<string, unknown>,
): string | null {
  if (protocol === 'anthropic') {
    const thinking = body.thinking as { type?: unknown; budget_tokens?: unknown } | undefined;
    if (thinking && thinking !== null) {
      const budget = thinking.budget_tokens;
      const maxTokens = body.max_tokens;
      if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
        return 'thinking.budget_tokens 必须是正数';
      }
      if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
        return 'max_tokens 必须是数字';
      }
      if (budget >= maxTokens) {
        return `thinking.budget_tokens (${budget}) 必须小于 max_tokens (${maxTokens})`;
      }
    }
  }
  if (protocol === 'openai_responses') {
    const tools = body.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      for (const t of tools as Record<string, unknown>[]) {
        if (t && typeof t === 'object' && 'function' in t) {
          return 'Responses API 的 tools 必须是顶层 {type:"function", name, parameters} 结构（不能嵌套 function 字段）';
        }
        if (!t || typeof t !== 'object' || typeof (t as { name?: unknown }).name !== 'string') {
          return 'Responses API 的每个 tool 必须有顶层 name 字段';
        }
      }
    }
  }
  return null;
}

// ---------------- 模型列表 ----------------

const MODELS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gemini-3.8-flash',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
  'grok-4.7',
  'grok-4.6',
  'glm-5.3',
  'glm-5.2',
  'kimi-k3',
  'kimi-k2.7-code',
  'seedance-2.5',
];

// ---------------- HTTP 处理 ----------------

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message } });
}

/** 从 URL 解析出 { scenario, rest }，不匹配返回 null */
function parseScenarioPath(urlPath: string): { scenario: Scenario; rest: string } | null {
  const m = /^\/([^/]+)(\/.*)?$/.exec(urlPath);
  if (!m || !m[1]) return null;
  const scenario = m[1];
  if (!isScenario(scenario)) return null;
  return { scenario, rest: m[2] ?? '/' };
}

interface ParsedGeminiAction {
  model: string;
  stream: boolean;
}

/** 解析 gemini 路径 /v1beta/models/{model}:generateContent 或 :streamGenerateContent */
function parseGeminiAction(rest: string): ParsedGeminiAction | null {
  const m = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/.exec(rest.split('?')[0] ?? '');
  if (!m || !m[1]) return null;
  return { model: decodeURIComponent(m[1]), stream: m[2] === 'streamGenerateContent' };
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        aborted = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', () => {
      if (!aborted) resolve(null);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const urlPath = url.pathname;

  const log = (status: number) => {
    console.log(`${method} ${urlPath} ${status} ${Date.now() - started}ms`);
  };

  try {
    // 鉴权：任意 key 均接受，仅 invalid-key 拒绝
    const auth = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];
    const googKey = req.headers['x-goog-api-key'];
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const key = bearer ?? (typeof apiKeyHeader === 'string' ? apiKeyHeader : null) ?? (typeof googKey === 'string' ? googKey : null);
    if (key === 'invalid-key') {
      sendError(res, 401, 'Invalid key');
      log(401);
      return;
    }

    const parsed = parseScenarioPath(urlPath);
    if (!parsed) {
      sendError(res, 404, 'Not found');
      log(404);
      return;
    }
    const { scenario, rest } = parsed;
    const behavior = SCENARIO_BEHAVIORS[scenario];

    // GET 模型列表
    if (method === 'GET' && (rest === '/v1/models' || rest === '/v1beta/models')) {
      if (rest === '/v1/models') {
        sendJson(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock-upstream' })) });
      } else {
        sendJson(res, 200, { models: MODELS.map((id) => ({ name: `models/${id}` })) });
      }
      log(200);
      return;
    }

    // POST 协议端点
    if (method !== 'POST') {
      sendError(res, 404, 'Not found');
      log(404);
      return;
    }

    // scenario 固定错误（dead）
    if (behavior.alwaysError !== null) {
      sendError(res, behavior.alwaysError, 'Service unavailable');
      log(behavior.alwaysError);
      return;
    }
    // scenario 概率错误（flaky 502 / ratelimited 429）
    if (behavior.errorRate !== null && Math.random() < behavior.errorRate.probability) {
      sendError(res, behavior.errorRate.status, behavior.errorRate.status === 429 ? 'Rate limit exceeded' : 'Bad gateway');
      log(behavior.errorRate.status);
      return;
    }

    let protocol: Protocol | null = null;
    let geminiAction: ParsedGeminiAction | null = null;
    if (rest === '/v1/chat/completions') protocol = 'openai_chat';
    else if (rest === '/v1/responses') protocol = 'openai_responses';
    else if (rest === '/v1/messages') protocol = 'anthropic';
    else {
      geminiAction = parseGeminiAction(rest);
      if (geminiAction) protocol = 'gemini';
    }

    if (!protocol) {
      sendError(res, 404, 'Not found');
      log(404);
      return;
    }

    const bodyText = await readBody(req);
    if (bodyText === null) {
      sendError(res, 413, 'Payload too large');
      log(413);
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = bodyText.trim() ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      log(400);
      return;
    }

    const extracted = extractRequest(protocol, body);
    if (extracted.validationError) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: extracted.validationError } }));
      log(400);
      return;
    }
    const model = geminiAction ? geminiAction.model : extracted.model;
    const stream = geminiAction ? geminiAction.stream || extracted.stream : extracted.stream;

    // 生成回复与 usage
    const decision = generateReply(extracted.inputText, model, scenario);
    const modelEcho = behavior.rewriteModel ? rewriteModelForFake(model) : model;

    const toolCall: ToolCallSpec | null = extracted.hasTools
      ? { name: 'get_weather', arguments: '{"city":"Beijing"}', input: { city: 'Beijing' } }
      : null;

    const thinking =
      protocol === 'anthropic' && extracted.hasThinking ? thinkingFor(scenario) : null;

    // thinking 文本计入 inputText 的回复文本：usage 输出计 thinking + text
    const outputText = (thinking ? thinking.text + '\n' : '') + (toolCall ? '' : decision.text);

    const usage =
      behavior.usageMode === 'fake'
        ? null
        : computeUsage(behavior.usageMode === 'vendor' ? 'vendor' : 'openai_flat', model, protocol, extracted.inputText, outputText);

    const ctx: ReplyContext = {
      scenario,
      protocol,
      model: modelEcho,
      text: toolCall ? '' : decision.text,
      usage,
      toolCall,
      thinking,
      timing: { ttftMs: ttftMs(scenario), chunkIntervalMs: behavior.timing.chunkIntervalMs },
    };

    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      let closed = false;
      res.on('close', () => {
        closed = true;
      });
      await writeStream(ctx, (chunk) => {
        if (closed) return false;
        res.write(chunk);
        return true;
      });
      res.end();
      log(200);
    } else {
      const json = buildNonStream(ctx);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
      res.end(json);
      log(200);
    }
  } catch (err) {
    console.error(`处理请求失败 ${method} ${urlPath}:`, err);
    if (!res.headersSent) {
      sendError(res, 500, 'Internal error');
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`mock-upstream 已启动: http://${HOST}:${PORT}`);
  console.log(`scenarios: ${SCENARIOS.join(', ')}`);
});

// 优雅退出
function shutdown() {
  console.log('mock-upstream 退出中…');
  server.close(() => {
    process.exit(0);
  });
  // 兜底：3 秒后强制退出
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
