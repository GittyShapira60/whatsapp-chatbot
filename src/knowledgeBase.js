import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { buildSystemPrompt } from './systemPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '../knowledge');
const MAX_CHARS_PER_FILE = 8000;
const SKIP_EXTENSIONS = ['.pdf'];

const ESCALATION_KEYWORDS = [
  'production down', 'אסון', 'emergency',
];

const AI_CANT_ANSWER_TEXT = 'לצערי לא מצאתי את המידע המדויק';

let cachedDocs = null;

// The AI provider (GitHub Models free tier) hard-caps requests at 8000 tokens.
// Dumping every knowledge file into every request blows past that and silently
// falls back to a docs-less prompt — so instead we pick only the files that
// are actually relevant to the user's question.
const DOCS_CHAR_BUDGET = 10000;
const MAX_RELEVANT_DOCS = 9;
const STOPWORDS = new Set([
  'מה', 'את', 'של', 'על', 'עם', 'אין', 'יש', 'לא', 'כן', 'גם', 'רק', 'כל',
  'זה', 'זו', 'הוא', 'היא', 'אני', 'אתה', 'אנחנו', 'הם', 'הן', 'איך', 'מתי',
  'למה', 'כיצד', 'ניתן', 'צריך', 'רוצה', 'אפשר', 'בבקשה', 'שלי', 'שלך',
]);

function tokenize(text) {
  const matches = text.toLowerCase().match(/[א-ת]+|[a-z0-9]+/g) || [];
  return matches.filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function scoreDoc(doc, queryTokens, idf) {
  const content = doc.content.toLowerCase();
  const filename = doc.source.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    const weight = idf.get(token) ?? 1;
    if (filename.includes(token)) score += 3 * weight;
    if (content.includes(token)) score += 1 * weight;
    // Hebrew words attach prefixes/suffixes to roots (e.g. "לשחרר"/"שחרור"
    // share the root ש-ח-ר-ר) — a shared 4-char root is a decent fuzzy signal.
    if (token.length >= 5) {
      for (let i = 0; i <= token.length - 4; i++) {
        if (content.includes(token.slice(i, i + 4))) { score += 0.5 * weight; break; }
      }
    }
  }
  return score;
}

// Words that show up in almost every file (e.g. "sky", "משתמש") carry little
// signal — down-weight them relative to rare, specific words so a doc that
// uniquely matches the query outranks docs that only share common terms.
function buildIdf(docs, queryTokens) {
  const idf = new Map();
  for (const token of queryTokens) {
    const docFreq = docs.filter(d =>
      d.source.toLowerCase().includes(token) || d.content.toLowerCase().includes(token)
    ).length;
    idf.set(token, docFreq > 0 ? 1 / docFreq : 1);
  }
  return idf;
}

function normalizeScores(scored) {
  const max = Math.max(0, ...scored.map(s => s.score));
  if (max <= 0) return new Map(scored.map(s => [s.doc.source, 0]));
  return new Map(scored.map(s => [s.doc.source, s.score / max]));
}

function capByBudget(rankedDocs) {
  const selected = [];
  let totalChars = 0;
  for (const doc of rankedDocs) {
    if (selected.length >= MAX_RELEVANT_DOCS) break;
    if (selected.length > 0 && totalChars + doc.content.length > DOCS_CHAR_BUDGET) continue;
    selected.push(doc);
    totalChars += doc.content.length;
  }
  return selected;
}

// ---- Semantic retrieval (embeddings) ----
// Combined with the keyword/IDF scoring above (hybrid, max of the two) rather
// than used alone: embeddings can under-rate an exact but short/literal match
// (e.g. a Hebrew transliteration like "גיטהאב" against an English-titled doc),
// and keywords alone miss phrasing/synonym variation — together they cover
// each other's blind spots. If the embeddings call fails (network, rate
// limit, missing token), we transparently fall back to keyword-only.
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_URL = 'https://models.inference.ai.azure.com/embeddings';
let cachedDocEmbeddings = null; // Map<source, number[]>

async function embedTexts(texts) {
  const response = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embeddings API error ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.data.map(d => d.embedding);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getDocEmbeddings(docs) {
  if (cachedDocEmbeddings) return cachedDocEmbeddings;
  const vectors = await embedTexts(docs.map(d => `${d.source}\n${d.content}`.slice(0, 8000)));
  cachedDocEmbeddings = new Map(docs.map((d, i) => [d.source, vectors[i]]));
  return cachedDocEmbeddings;
}

async function selectRelevantDocs(docs, query) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const idf = buildIdf(docs, queryTokens);
  const keywordScored = docs.map(doc => ({ doc, score: scoreDoc(doc, queryTokens, idf) }));
  const keywordNorm = normalizeScores(keywordScored);

  let semanticNorm = new Map();
  try {
    const docEmbeddings = await getDocEmbeddings(docs);
    const [queryEmbedding] = await embedTexts([query]);
    const semanticScored = docs.map(doc => ({ doc, score: cosineSimilarity(queryEmbedding, docEmbeddings.get(doc.source)) }));
    semanticNorm = normalizeScores(semanticScored);
    const top5 = [...semanticScored].sort((a, b) => b.score - a.score).slice(0, 5);
    console.log(`[KNOWLEDGE] Semantic scores: ${top5.map(r => `${r.doc.source}=${r.score.toFixed(3)}`).join(', ')}`);
  } catch (err) {
    console.warn(`[KNOWLEDGE] Semantic retrieval failed (${err.message}) — using keyword score only`);
  }

  const combined = docs
    .map(doc => ({
      doc,
      score: Math.max(keywordNorm.get(doc.source) ?? 0, semanticNorm.get(doc.source) ?? 0),
    }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return capByBudget(combined.map(c => c.doc));
}

async function loadAllDocs() {
  if (cachedDocs) return cachedDocs;

  const files = readdirSync(KNOWLEDGE_DIR).filter(f =>
    f !== 'test' && !SKIP_EXTENSIONS.some(ext => f.endsWith(ext))
  );
  const docs = [];

  for (const file of files) {
    const filePath = path.join(KNOWLEDGE_DIR, file);
    try {
      if (file.endsWith('.txt')) {
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) docs.push({ source: file, content: content.slice(0, MAX_CHARS_PER_FILE) });
      }
    } catch (err) {
      console.warn(`[KNOWLEDGE] Could not read "${file}": ${err.message}`);
    }
  }

  console.log(`[KNOWLEDGE] Loaded ${docs.length} document(s): ${docs.map(d => d.source).join(', ')}`);
  cachedDocs = docs;
  return docs;
}

export async function getSystemPrompt(query = '') {
  const docs = await loadAllDocs();
  const relevant = await selectRelevantDocs(docs, query);
  if (relevant.length > 0) {
    console.log(`[KNOWLEDGE] Selected ${relevant.length}/${docs.length} doc(s) for query: ${relevant.map(d => d.source).join(', ')}`);
  }
  const docsText = relevant.map(d => `=== ${d.source} ===\n${d.content}`).join('\n\n');
  return buildSystemPrompt(docsText);
}

export function getMinimalSystemPrompt() {
  return buildSystemPrompt('');
}

export function needsEscalation(message) {
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

export function aiCantAnswer(reply) {
  return reply.includes(AI_CANT_ANSWER_TEXT);
}
