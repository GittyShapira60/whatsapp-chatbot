import { getSystemPrompt, getMinimalSystemPrompt } from './knowledgeBase.js';

function getProviderConfig() {
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
    return {
      type: 'gemini',
      model,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      headers: { 'Content-Type': 'application/json' },
    };
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

  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4o';
    return {
      type: 'azure-openai',
      model: deployment,
      url: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`,
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.AZURE_OPENAI_KEY,
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
    generationConfig: { maxOutputTokens: 800, temperature: 0.2 },
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

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No content in Gemini response');
  return text.trim();
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
    body: JSON.stringify({ model: provider.model, messages, max_tokens: 800, temperature: 0.2 }),
    signal: AbortSignal.timeout(30000),
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

  if (!response.ok) throw new Error(`AI error ${response.status}: ${data?.error?.message ?? rawBody.slice(0, 300)}`);

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('No content in AI response');
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
      const text = provider.type === 'gemini'
        ? await callGemini(provider, systemPrompt, trimmedHistory, images)
        : await callOpenAICompatible(provider, systemPrompt, trimmedHistory, images);

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
