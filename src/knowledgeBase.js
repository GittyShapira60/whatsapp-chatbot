import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pdfParse from 'pdf-parse';
import { buildSystemPrompt } from './systemPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '../knowledge');
const MAX_CHARS_PER_FILE = 1200;

const ESCALATION_KEYWORDS = [
  'דחוף', 'תקלה קריטית', 'לא עובד', 'production down',
  'אבד גישה', 'נחסמתי', 'אסון', 'מיידי', 'emergency',
];

const AI_CANT_ANSWER_TEXT = 'לצערי לא מצאתי את המידע המדויק';

let cachedDocs = null;

async function loadAllDocs() {
  if (cachedDocs) return cachedDocs;

  const files = readdirSync(KNOWLEDGE_DIR).filter(f => f !== 'test');
  const docs = [];

  for (const file of files) {
    const filePath = path.join(KNOWLEDGE_DIR, file);
    try {
      if (file.endsWith('.txt')) {
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) docs.push({ source: file, content: content.slice(0, MAX_CHARS_PER_FILE) });
      } else if (file.endsWith('.pdf')) {
        const buffer = readFileSync(filePath);
        const pdf = await pdfParse(buffer);
        const content = pdf.text.replace(/\s+/g, ' ').trim();
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

export async function getSystemPrompt() {
  const docs = await loadAllDocs();
  const docsText = docs.map(d => `=== ${d.source} ===\n${d.content}`).join('\n\n');
  return buildSystemPrompt(docsText);
}

export function needsEscalation(message) {
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

export function aiCantAnswer(reply) {
  return reply.includes(AI_CANT_ANSWER_TEXT);
}
