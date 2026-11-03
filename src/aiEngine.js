import Anthropic from '@anthropic-ai/sdk';
import { getSystemPrompt, getMinimalSystemPrompt } from './knowledgeBase.js';

// ---- Claude (Anthropic API) ----
let _anthropicClient = null;
function getAnthropicClient() {
  // SDK retries 408/409/429/5xx/529 + connection errors itself (maxRetries) before throwing.
  _anthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 2 });
  return _anthropicClient;
}

function buildClaudeProvider() {
  return { type: 'claude', model: process.env.BOT_CLAUDE_MODEL ?? 'claude-opus-5-5' };
}

// Server-side refusal fallback ("default" routing) is supported on these models on the Claude API.
const SUPPORTS_DEFAULT_FALLBACKS = /^claude-(opus-5|fable-5|sonnet-5-5)/;
const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function callClaude(provider, systemPrompt, history, images = []) {
  // The fixed instructions are identical on every request → cache them; the per-question knowledge
  // files come after the cache breakpoint so they don't invalidate it.
  const staticPrompt = getMinimalSystemPrompt();
  const system = systemPrompt.startsWith(staticPrompt) && systemPrompt.length > staticPrompt.length
    ? [
        { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: systemPrompt.slice(staticPrompt.length) },
      ]
    : [{ type: 'text', text: systemPrompt }];

  const supportedImages = images.filter(img => CLAUDE_IMAGE_TYPES.has(img.contentType));
  const messages = history.map((m, i) => {
    const isLastUser = m.role === 'user' && i === history.length - 1;
    if (isLastUser && supportedImages.length > 0) {
      return {
        role: 'user',
        content: [
          ...supportedImages.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.contentType, data: img.data },
          })),
          { type: 'text', text: m.content },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  const request = {
    model: provider.model,
    max_tokens: 16000,
    // Support chat: low effort keeps WhatsApp replies fast (thinking stays on, as these models require).
    output_config: { effort: process.env.BOT_CLAUDE_EFFORT ?? 'low' },
    system,
    messages,
  };
  if (SUPPORTS_DEFAULT_FALLBACKS.test(provider.model)) {
    request.betas = ['server-side-fallback-2026-07-01'];
    request.fallbacks = 'default';
  }

  const response = await getAnthropicClient().beta.messages.create(request);

  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude refusal (category: ${response.stop_details?.category ?? 'unknown'})`);
  }
  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
  if (!text) throw new Error(`No content in Claude response (stop_reason: ${response.stop_reason})`);
  console.log(`[AI] claude usage | in: ${response.usage.input_tokens} | cache read: ${response.usage.cache_read_input_tokens ?? 0} | out: ${response.usage.output_tokens}`);
  return text;
}

function isRetryableClaudeError(err) {
  return err instanceof Anthropic.RateLimitError
    || err instanceof Anthropic.APIConnectionError // includes timeouts
    || (err instanceof Anthropic.APIError && typeof err.status === 'number' && err.status >= 500); // 5xx + 529 overloaded
}

function buildGeminiProvider(model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash') {
  return {
    type: 'gemini',
    model,
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    headers: { 'Content-Type': 'application/json' },
  };
}

// Newer api-version → supports max_completion_tokens and reasoning models (gpt-5 / o-series).
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? '2025-04-01-preview';

function buildAzureOpenAIProvider(deployment) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
  return {
    type: 'azure-openai',
    model: deployment,
    url: `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`,
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.AZURE_OPENAI_KEY,
    },
  };
}

// Priority: Claude (Anthropic API) → Azure OpenAI → Gemini → others. Lower ones serve as fallbacks.
function getProviderConfig() {
  if (process.env.ANTHROPIC_API_KEY) {
    return buildClaudeProvider();
  }

  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY) {
    return buildAzureOpenAIProvider(process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4o');
  }

  if (process.env.GEMINI_API_KEY) {
    return buildGeminiProvider();
  }

  if (process.env.AZURE_FOUNDRY_ENDPOINT && process.env.AZURE_FOUNDRY_KEY) {
    const model = process.env.AZURE_FOUNDRY_MODEL ?? 'gpt-4o';
    return {
      type: 'azure-foundry',
      model,
      url: `${process.env.AZURE_FOUNDRY_ENDPOINT}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AZURE_FOUNDRY_KEY}`,
      },
    };
  }

  if (process.env.GITHUB_TOKEN) {
    const rawModel = process.env.GITHUB_MODEL ?? 'gpt-4o-mini';
    // GitHub Models GA API requires a publisher-prefixed model id (e.g. "openai/gpt-4o");
    // models.inference.ai.azure.com (the old preview endpoint, bare model ids) was retired.
    const model = rawModel.includes('/') ? rawModel : `openai/${rawModel}`;
    return {
      type: 'github-models',
      model,
      url: 'https://models.github.ai/inference/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    };
  }

  throw new Error('No AI provider configured. See .env.example');
}

async function callGemini(provider, systemPrompt, history, images = []) {
  const contents = history.map((m, i) => {
    const isLastUser = m.role === 'user' && i === history.length - 1;
    const parts = [{ text: m.content }];
    if (isLastUser && images.length > 0) {
      images.forEach(img =>
        parts.push({ inlineData: { mimeType: img.contentType, data: img.data } })
      );
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    // Newer Gemini models ("gemini-flash-latest" moves to them silently) "think" before answering,
    // and thinking tokens count against maxOutputTokens — a low cap (was 800) can be used up entirely
    // by thinking, leaving no answer text → error → the user gets the generic fallback message.
    generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
  };

  const response = await fetch(provider.url, {
    method: 'POST',
    headers: provider.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const rawBody = await response.text();
  if (!rawBody?.trim()) throw new Error(`Empty Gemini response (HTTP ${response.status})`);

  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`Non-JSON Gemini response: ${rawBody.slice(0, 200)}`); }

  if (!response.ok) throw new Error(`Gemini error ${response.status}: ${data?.error?.message ?? rawBody.slice(0, 300)}`);

  // The answer may be split across several parts, and parts[0] can be a thought / signature part —
  // join every non-thought text part instead of trusting parts[0].
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter(p => p.text && !p.thought)
    .map(p => p.text)
    .join('');
  if (!text.trim()) throw new Error(`No content in Gemini response (finishReason: ${candidate?.finishReason ?? 'unknown'})`);
  return text.trim();
}

function callProvider(provider, systemPrompt, history, images) {
  if (provider.type === 'claude') return callClaude(provider, systemPrompt, history, images);
  if (provider.type === 'gemini') return callGemini(provider, systemPrompt, history, images);
  return callOpenAICompatible(provider, systemPrompt, history, images);
}

// When the main model is overloaded / out of quota / rate-limited, answer from a fallback instead of
// failing the user:
//  - Azure OpenAI main → AZURE_OPENAI_FALLBACK_DEPLOYMENT if set, otherwise Gemini (if GEMINI_API_KEY is set)
//  - Gemini main       → GEMINI_FALLBACK_MODEL (default gemini-2.5-flash)
function getFallbackProvider(provider) {
  if (provider.type === 'claude') {
    if (process.env.GEMINI_API_KEY) return buildGeminiProvider();
    return null;
  }
  if (provider.type === 'azure-openai') {
    const fallbackDeployment = process.env.AZURE_OPENAI_FALLBACK_DEPLOYMENT;
    if (fallbackDeployment && fallbackDeployment !== provider.model) return buildAzureOpenAIProvider(fallbackDeployment);
    if (process.env.GEMINI_API_KEY) return buildGeminiProvider(process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-2.5-flash');
    return null;
  }
  if (provider.type === 'gemini') {
    const fallbackModel = process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-2.5-flash';
    return fallbackModel === provider.model ? null : buildGeminiProvider(fallbackModel);
  }
  return null;
}

function isOverloadOrQuotaError(err) {
  return isRetryableClaudeError(err)
    || /\b(429|500|502|503|504)\b|overloaded|high demand|quota|rate.?limit|timeout|timed out|fetch failed|ECONN|ENOTFOUND/i.test(err.message);
}

// Walks the fallback chain (e.g. Claude → Gemini → Gemini fallback model) on overload / quota / network errors.
async function callWithFallback(provider, systemPrompt, history, images = []) {
  let current = provider;
  for (let hop = 0; ; hop++) {
    try {
      return await callProvider(current, systemPrompt, history, images);
    } catch (err) {
      const fallback = hop < 2 && isOverloadOrQuotaError(err) ? getFallbackProvider(current) : null;
      if (!fallback) throw err;
      console.warn(`[AI] ${current.type}/${current.model} unavailable (${err.message.slice(0, 80)}) → falling back to ${fallback.type}/${fallback.model}`);
      current = fallback;
    }
  }
}

// Reasoning models (gpt-5 / o-series) reject a custom temperature — remembered per deployment after the first refusal.
const _noTemperatureModels = new Set();

function buildChatBody(provider, messages) {
  const body = { model: provider.model, messages };
  if (provider.type === 'azure-openai') {
    // max_completion_tokens works for all current Azure models (max_tokens is rejected by reasoning models),
    // and reasoning tokens count toward it — so it must be well above the visible answer length.
    body.max_completion_tokens = 8000;
  } else {
    body.max_tokens = 800;
  }
  if (!_noTemperatureModels.has(provider.model)) body.temperature = 0.2;
  return body;
}

async function callOpenAICompatible(provider, systemPrompt, history, images = []) {
  const messages = [{ role: 'system', content: systemPrompt }];

  history.forEach((m, i) => {
    const isLastUser = m.role === 'user' && i === history.length - 1;
    if (isLastUser && images.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...images.map(img => ({
            type: 'image_url',
            image_url: { url: `data:${img.contentType};base64,${img.data}` },
          })),
        ],
      });
    } else {
      messages.push(m);
    }
  });

  const response = await fetch(provider.url, {
    method: 'POST',
    headers: provider.headers,
    body: JSON.stringify(buildChatBody(provider, messages)),
    signal: AbortSignal.timeout(60000),
  });

  const rawBody = await response.text();
  if (!rawBody?.trim()) throw new Error(`Empty response (HTTP ${response.status})`);

  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`Non-JSON response (HTTP ${response.status}): ${rawBody.slice(0, 200)}`); }

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers?.get?.('retry-after') ?? '60', 10);
    if (retryAfter > 15) {
      // Rate limit too long to wait inline — fail fast so other messages aren't blocked
      throw new Error(`Rate limited by AI provider (retry-after: ${retryAfter}s). Try again in a few minutes.`);
    }
    console.warn(`[AI] Rate limited — waiting ${retryAfter}s before retry...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return callOpenAICompatible(provider, systemPrompt, history, images);
  }

  const errorMessage = data?.error?.message ?? '';
  if (response.status === 400 && /temperature/i.test(errorMessage) && !_noTemperatureModels.has(provider.model)) {
    console.warn(`[AI] ${provider.model} does not accept temperature — retrying without it`);
    _noTemperatureModels.add(provider.model);
    return callOpenAICompatible(provider, systemPrompt, history, images);
  }

  if (!response.ok) throw new Error(`AI error ${response.status}: ${errorMessage || rawBody.slice(0, 300)}`);

  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error(`No content in AI response (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
  return text.trim();
}

export async function generateResponse(history, images = []) {
  const provider = getProviderConfig();
  const recentUserText = history
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content)
    .join(' ');
  const fullPrompt = await getSystemPrompt(recentUserText);

  let trimmedHistory = [...history];
  let useMinimalPrompt = false;

  while (true) {
    const systemPrompt = useMinimalPrompt ? getMinimalSystemPrompt() : fullPrompt;
    try {
      const text = await callWithFallback(provider, systemPrompt, trimmedHistory, images);

      if (trimmedHistory.length < history.length) {
        console.warn(`[AI] היסטוריה קוצרה מ-${history.length} ל-${trimmedHistory.length} הודעות (413)`);
      }
      if (useMinimalPrompt) {
        console.warn(`[AI] ענה ללא בסיס ידע (413 fallback)`);
      }
      console.log(`[AI] ${provider.type} | ${text.length} chars`);
      return text;
    } catch (err) {
      if (err.message?.includes('413')) {
        if (trimmedHistory.length > 1) {
          const remove = Math.min(2, trimmedHistory.length - 1);
          trimmedHistory.splice(0, remove);
          console.warn(`[AI] 413 too large — מקצר היסטוריה ל-${trimmedHistory.length} הודעות, מנסה שוב...`);
          continue;
        }
        if (!useMinimalPrompt) {
          useMinimalPrompt = true;
          console.warn(`[AI] 413 too large — עובר לפרומפט מקוצר (ללא בסיס ידע), מנסה שוב...`);
          continue;
        }
      }

      const cause = err.cause;
      console.error(`[AI NETWORK ERROR] message: ${err.message}`);
      if (cause) {
        console.error(`[AI NETWORK ERROR] cause.message: ${cause.message ?? cause}`);
        console.error(`[AI NETWORK ERROR] cause.code: ${cause.code ?? 'N/A'}`);
      }
      throw new Error(`Network error: ${err.message} | cause: ${cause?.message ?? cause ?? 'unknown'}`);
    }
  }
}
