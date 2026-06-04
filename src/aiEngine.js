import { getSystemPrompt } from './knowledgeBase.js';

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
    return {
      type: 'github-models',
      model: process.env.GITHUB_MODEL ?? 'gpt-4o-mini',
      url: 'https://models.inference.ai.azure.com/chat/completions',
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
    generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
  };

  const response = await fetch(provider.url, {
    method: 'POST',
    headers: provider.headers,
    body: JSON.stringify(body),
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
    body: JSON.stringify({ model: provider.model, messages, max_tokens: 600, temperature: 0.2 }),
  });

  const rawBody = await response.text();
  if (!rawBody?.trim()) throw new Error(`Empty response (HTTP ${response.status})`);

  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`Non-JSON response (HTTP ${response.status}): ${rawBody.slice(0, 200)}`); }

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers?.get?.('retry-after') ?? '60', 10);
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
  const systemPrompt = await getSystemPrompt();

  let text;
  try {
    if (provider.type === 'gemini') {
      text = await callGemini(provider, systemPrompt, history, images);
    } else {
      text = await callOpenAICompatible(provider, systemPrompt, history, images);
    }
  } catch (networkErr) {
    const cause = networkErr.cause;
    console.error(`[AI NETWORK ERROR] message: ${networkErr.message}`);
    if (cause) {
      console.error(`[AI NETWORK ERROR] cause.message: ${cause.message ?? cause}`);
      console.error(`[AI NETWORK ERROR] cause.code: ${cause.code ?? 'N/A'}`);
    }
    throw new Error(`Network error: ${networkErr.message} | cause: ${cause?.message ?? cause ?? 'unknown'}`);
  }

  console.log(`[AI] ${provider.type} | ${text.length} chars`);
  return text;
}
