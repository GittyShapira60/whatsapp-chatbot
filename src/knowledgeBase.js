import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pdfParse from 'pdf-parse';
import { buildSystemPrompt } from './systemPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '../knowledge');

// קבצים קטנים (הפניות/טלפונים) נכנסים תמיד במלואם — זול ותמיד רלוונטי
const ALWAYS_INCLUDE_MAX_CHARS = 2000;
// קבצים גדולים (מדריכי PDF) מפוצלים לצ'אנקים, וכל שאלה מקבלת רק את הצ'אנקים
// הכי רלוונטיים אליה — כדי שהבוט לא "יראה" רק את תחילת המדריך (כמו קודם), אלא
// באמת יחפש את התוכן הרלוונטי בתוך כל המסמך, בלי לשלוח את כולו בכל פנייה
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;
const TOP_K_CHUNKS = 8;
const CHUNKS_CHAR_BUDGET = 6000;

const ESCALATION_KEYWORDS = [
  'דחוף', 'תקלה קריטית', 'לא עובד', 'production down',
  'אבד גישה', 'נחסמתי', 'אסון', 'מיידי', 'emergency',
];

const AI_CANT_ANSWER_TEXT = 'לצערי לא מצאתי את המידע המדויק';

let cachedIndex = null;

function chunkText(text, size, overlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length > 1);
}

async function buildIndex() {
  if (cachedIndex) return cachedIndex;

  const files = readdirSync(KNOWLEDGE_DIR).filter(f => f !== 'test');
  const alwaysDocs = [];
  const chunks = [];

  for (const file of files) {
    const filePath = path.join(KNOWLEDGE_DIR, file);
    try {
      let content;
      if (file.endsWith('.txt')) {
        content = readFileSync(filePath, 'utf-8').trim();
      } else if (file.endsWith('.pdf')) {
        const buffer = readFileSync(filePath);
        const pdf = await pdfParse(buffer);
        content = pdf.text.replace(/\s+/g, ' ').trim();
      } else {
        continue;
      }
      if (!content) continue;

      if (content.length <= ALWAYS_INCLUDE_MAX_CHARS) {
        alwaysDocs.push({ source: file, content });
      } else {
        for (const text of chunkText(content, CHUNK_SIZE, CHUNK_OVERLAP)) {
          chunks.push({ source: file, text });
        }
      }
    } catch (err) {
      console.warn(`[KNOWLEDGE] Could not read "${file}": ${err.message}`);
    }
  }

  // IDF על פני כל הצ'אנקים — מתעדף התאמות על מילים נדירות/משמעותיות בשאילתה,
  // ולא על מילים שחוזרות בכל המדריכים (כמו "משתמש" או "מערכת")
  const df = new Map();
  const chunkTokenSets = chunks.map(c => {
    const tokens = new Set(tokenize(c.text));
    tokens.forEach(t => df.set(t, (df.get(t) ?? 0) + 1));
    return tokens;
  });
  const idf = new Map();
  const N = chunks.length || 1;
  df.forEach((count, token) => idf.set(token, Math.log((N + 1) / (count + 1)) + 1));

  console.log(`[KNOWLEDGE] Indexed ${alwaysDocs.length} short file(s) + ${chunks.length} chunk(s) from ${files.length} file(s)`);
  cachedIndex = { alwaysDocs, chunks, chunkTokenSets, idf };
  return cachedIndex;
}

function scoreChunk(queryTokens, chunkTokenSet, idf) {
  let score = 0;
  for (const t of queryTokens) {
    if (chunkTokenSet.has(t)) score += idf.get(t) ?? 0;
  }
  return score;
}

function selectRelevantChunks(index, query) {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0 || index.chunks.length === 0) return [];

  const scored = index.chunks
    .map((c, i) => ({ ...c, score: scoreChunk(queryTokens, index.chunkTokenSets[i], index.idf) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  let usedChars = 0;
  for (const c of scored) {
    if (selected.length >= TOP_K_CHUNKS || usedChars >= CHUNKS_CHAR_BUDGET) break;
    selected.push(c);
    usedChars += c.text.length;
  }
  return selected;
}

export async function getSystemPrompt(query = '') {
  const index = await buildIndex();
  const relevantChunks = selectRelevantChunks(index, query);

  const parts = index.alwaysDocs.map(d => `=== ${d.source} ===\n${d.content}`);

  const chunksBySource = new Map();
  for (const c of relevantChunks) {
    if (!chunksBySource.has(c.source)) chunksBySource.set(c.source, []);
    chunksBySource.get(c.source).push(c.text);
  }
  for (const [source, texts] of chunksBySource) {
    parts.push(`=== ${source} (קטעים רלוונטיים לשאלה) ===\n${texts.join('\n…\n')}`);
  }

  console.log(`[KNOWLEDGE] Using ${index.alwaysDocs.length} full doc(s) + ${relevantChunks.length} relevant chunk(s) for this query`);
  return buildSystemPrompt(parts.join('\n\n'));
}

export function needsEscalation(message) {
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

export function aiCantAnswer(reply) {
  return reply.includes(AI_CANT_ANSWER_TEXT);
}
