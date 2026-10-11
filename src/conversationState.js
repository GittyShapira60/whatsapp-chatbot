import redis from './redisClient.js';
import { log } from './logger.js';

const MAX_MESSAGES = 10;
const CONV_TTL_S = 24 * 3600;
const HANDOFF_TTL_S = Math.floor(Number(process.env.HANDOFF_TTL_HOURS ?? 2) * 3600);
const VERIFY_TTL_S = 24 * 3600;

// ── היסטוריית שיחה ──

export async function getHistory(phone) {
  const raw = await redis.get(`msg:${phone}`);
  const messages = raw ? JSON.parse(raw) : [];
  log('[CONV]', `${phone} → נטענה היסטוריה | ${messages.length} הודעות`);
  return messages;
}

export async function addMessage(phone, role, content) {
  const key = `msg:${phone}`;
  const raw = await redis.get(key);
  const messages = raw ? JSON.parse(raw) : [];
  const wasEmpty = messages.length === 0;
  messages.push({ role, content });
  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES);
    log('[CONV]', `${phone} → חרגנו מ-${MAX_MESSAGES} הודעות → נמחקו הישנות`);
  }
  await redis.setex(key, CONV_TTL_S, JSON.stringify(messages));
  log('[CONV]', `${phone} → נשמרה הודעת [${role}] | סה"כ ${messages.length}/${MAX_MESSAGES} | TTL אופס ל-24ש'${wasEmpty ? ' (שיחה חדשה)' : ''}`);
}

export async function clearHistory(phone) {
  const deleted = await redis.del(`msg:${phone}`);
  if (deleted) {
    log('[CONV]', `${phone} → היסטוריה נמחקה ✅`);
  } else {
    log('[CONV]', `${phone} → לא הייתה היסטוריה (כבר ריק)`);
  }
}

// ── Handoff ──

export async function setHandoff(phone) {
  await redis.setex(`handoff:${phone}`, HANDOFF_TTL_S, JSON.stringify({ since: Date.now() }));
  const ttlH = Math.round(HANDOFF_TTL_S / 3600);
  log('[HANDOFF ▶]', `${phone} → נכנס למצב handoff (פג תוקף תוך ${ttlH}ש')`);
}

export async function isInHandoff(phone) {
  const raw = await redis.get(`handoff:${phone}`);
  if (!raw) {
    log('[HANDOFF]', `${phone} → לא במצב handoff`);
    return false;
  }
  const handoff = JSON.parse(raw);
  const elapsedMin = Math.round((Date.now() - handoff.since) / 60000);
  log('[HANDOFF STATUS]', `${phone} → במצב handoff כבר ${elapsedMin} דק'`);
  return true;
}

export async function clearHandoff(phone) {
  const deleted = await redis.del(`handoff:${phone}`);
  if (deleted) {
    log('[HANDOFF ✓]', `${phone} → handoff נוקה → הבוט חוזר לפעולה ✅`);
  } else {
    log('[HANDOFF ✓]', `${phone} → לא היה handoff פעיל`);
  }
}

// ── replyTo ──

export async function setReplyTo(phone, email) {
  if (!phone || !email) return;
  await redis.set(`replyTo:${phone}`, email);
  log('[REPLY_TO]', `${phone} → נשמר replyTo: ${email}`);
}

export async function getReplyTo(phone) {
  const val = await redis.get(`replyTo:${phone}`);
  log('[REPLY_TO]', `${phone} → ${val ? `נמצא: ${val}` : 'לא נמצא'}`);
  return val;
}

// ── ערוץ תקשורת ──
// ללא TTL, כמו replyTo — שיוך ערוץ הוא עובדת-זהות של המשתמש, לא הקשר שיחה שפג.

export async function setChannel(phone, channel) {
  if (!phone || !channel) return;
  await redis.set(`channel:${phone}`, channel);
  log('[CHANNEL]', `${phone} → נשמר channel: ${channel}`);
}

export async function getChannel(phone) {
  const val = await redis.get(`channel:${phone}`);
  return val ?? 'whatsapp_api';
}

// ── אימות זהות ──

export async function setVerified(phone, id) {
  await redis.setex(`verified:${phone}`, VERIFY_TTL_S, id);
  log('[VERIFIED ✅]', `${phone} → אומת כ-${id} (תוקף 24 שעות)`);
}

export async function isVerified(phone) {
  const val = await redis.get(`verified:${phone}`);
  if (val) {
    log('[VERIFIED]', `${phone} → מאומת כ-${val} ✅`);
    return true;
  }
  log('[VERIFIED]', `${phone} → לא מאומת`);
  return false;
}

// ── Follow-up אוטומטי ──

const FOLLOWUP_TTL_S = 3600; // שעה

export async function setFollowup(phone) {
  await redis.setex(`followup:${phone}`, FOLLOWUP_TTL_S, '1');
  log('[FOLLOWUP ⏰]', `${phone} → follow-up מתוזמן בעוד שעה`);
}

export async function clearFollowup(phone) {
  const deleted = await redis.del(`followup:${phone}`);
  if (deleted) {
    log('[FOLLOWUP ✓]', `${phone} → follow-up בוטל (משתמש ענה)`);
  }
}

// ── שאלה ממתינה ──

export async function setPendingQuestion(phone, question) {
  await redis.setex(`pendingQ:${phone}`, 3600, question);
  log('[PENDING_Q]', `${phone} → שאלה ממתינה נשמרה: "${question.slice(0, 60)}"`);
}

export async function getPendingQuestion(phone) {
  const val = await redis.get(`pendingQ:${phone}`);
  log('[PENDING_Q]', `${phone} → ${val ? `נמצאה שאלה: "${val.slice(0, 60)}"` : 'אין שאלה ממתינה'}`);
  return val;
}

export async function clearPendingQuestion(phone) {
  await redis.del(`pendingQ:${phone}`);
  log('[PENDING_Q]', `${phone} → שאלה ממתינה נמחקה`);
}
