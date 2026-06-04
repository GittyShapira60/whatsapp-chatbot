import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'conversations.json');
const MAX_MESSAGES_PER_CONVERSATION = 20;

function load() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return {}; }
}

function save(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function getHistory(phone) {
  return load()[phone]?.messages ?? [];
}

export function addMessage(phone, role, content) {
  const state = load();
  if (!state[phone]) state[phone] = { messages: [], updatedAt: null };
  state[phone].messages.push({ role, content });
  if (state[phone].messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    state[phone].messages = state[phone].messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  }
  state[phone].updatedAt = new Date().toISOString();
  save(state);
}

export function clearHistory(phone) {
  const state = load();
  delete state[phone];
  save(state);
}
