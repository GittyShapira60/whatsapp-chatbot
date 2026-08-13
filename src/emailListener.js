import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseEasySendEmail } from './messageParser.js';
import { needsEscalation, aiCantAnswer } from './knowledgeBase.js';
import { generateResponse } from './aiEngine.js';
import { sendReply, sendEscalation } from './emailSender.js';
import { getHistory, addMessages, clearHistory } from './conversationState.js';

const REQUEST_COMPLETE_TOKEN = '[REQUEST_COMPLETE]';
const RECONNECT_DELAY_MS = 10_000;
// רשת ביטחון בלבד — הבדיקה האמיתית קורית מיידית דרך IMAP IDLE (אירוע 'exists'),
// לא דרך ה-interval הזה. משתמשים באותו משתנה סביבה כמו קודם כדי לא לדרוש שינוי קונפיג.
const FALLBACK_POLL_MS = Number(process.env.POLL_INTERVAL_SECONDS ?? 30) * 1000;

let checking = false; // מונע ריצה כפולה אם 'exists' והפולבק נורים יחד
let reconnectScheduled = false; // מונע יצירת שני חיבורים מקבילים (וכפילות תשובות) אם 'close' וכשל-connect נורים שניהם

function scheduleReconnect() {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  setTimeout(() => {
    reconnectScheduled = false;
    connectAndListen();
  }, RECONNECT_DELAY_MS);
}

async function checkUnseen(client) {
  if (checking) return;
  checking = true;
  try {
    const uids = await client.search({ unseen: true });
    if (uids.length > 0) {
      console.log(`[NEW] ${uids.length} unread message(s)`);
      for (const uid of uids) {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        await processEmail(client, uid);
      }
    }
  } catch (err) {
    console.error(`[CHECK ERROR] ${err.message}`);
  } finally {
    checking = false;
  }
}

async function processEmail(client, uid) {
  let replyTo, subject, messageId, senderId, userText;

  try {
    const message = await client.fetchOne(uid, { source: true });
    if (!message) return;

    const parsed = await simpleParser(message.source);
    const parsedFields = parseEasySendEmail(parsed);
    ({ replyTo, subject, messageId } = parsedFields);
    const { senderName, senderPhone, messageText, hasImages, imageCount, imageData } = parsedFields;

    // דילוג על מיילים שהבוט עצמו שלח (מונע לולאה אינסופית)
    const fromAddress = parsed.from?.value?.[0]?.address ?? '';
    if (fromAddress === process.env.SMTP_USER) {
      console.log(`[SKIP] Own message — skipping`);
      return;
    }

    if (!messageText && !hasImages) return;

    senderId = senderPhone ?? replyTo;

    if (hasImages) {
      console.log(`[IN] ${senderName} (${senderId}): [${imageCount} image(s)] "${(messageText ?? '').slice(0, 60)}"`);
    } else {
      console.log(`[IN] ${senderName} (${senderId}): "${messageText.slice(0, 80)}"`);
    }

    // בדיקת escalation מיידית לפי מילות מפתח דחופות
    if (messageText && needsEscalation(messageText)) {
      console.log(`[ESCALATE] Urgent keywords detected`);
      clearHistory(senderId);
      await sendEscalation({
        originalFrom: `${senderName} ${senderId}`,
        originalSubject: subject,
        originalBody: messageText,
        reason: 'זוהו מילות מפתח דחופות',
      });
      await sendReply({
        to: replyTo, subject, replyToMessageId: messageId,
        body: 'קיבלתי את הפנייה שלך. בגלל הדחיפות, העברתי אותה לטיפול מיידי. נחזור אליך בהקדם.',
      });
      return;
    }

    // טעינת היסטוריית שיחה + הוספת הודעה נוכחית
    const history = getHistory(senderId);
    userText = messageText || (hasImages ? `[המשתמש שלח ${imageCount} תמונה/ות]` : '');
    history.push({ role: 'user', content: userText });

    const aiReply = await generateResponse(history, imageData ?? []);
    console.log(`[AI] Response ready (${aiReply.length} chars)`);

    const isComplete = aiReply.includes(REQUEST_COMPLETE_TOKEN);
    const cleanReply = aiReply.replace(REQUEST_COMPLETE_TOKEN, '').trim();

    if (aiCantAnswer(cleanReply)) {
      // AI לא יודע — escalation ואיפוס שיחה
      console.log(`[ESCALATE] AI cannot answer`);
      clearHistory(senderId);
      await sendEscalation({
        originalFrom: `${senderName} ${senderId}`,
        originalSubject: subject,
        originalBody: userText,
        reason: hasImages ? `הבוט לא הצליח לפרש את התמונה (${imageCount} תמונות)` : 'הבוט לא מצא מידע מתאים',
      });
      await sendReply({ to: replyTo, subject, replyToMessageId: messageId, body: cleanReply });
      return;
    }

    if (isComplete) {
      console.log(`[COMPLETE] All details collected — escalating`);
      const fullHistory = [...history, { role: 'assistant', content: cleanReply }];
      const summary = fullHistory
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join('\n---\n');

      await sendEscalation({
        originalFrom: `${senderName} ${senderId}`,
        originalSubject: subject,
        originalBody: summary,
        reason: 'בקשה שהושלמה — כל הפרטים נאספו',
      });
      clearHistory(senderId);
    } else {
      addMessages(senderId, [
        { role: 'user', content: userText },
        { role: 'assistant', content: cleanReply },
      ]);
    }

    await sendReply({ to: replyTo, subject, replyToMessageId: messageId, body: cleanReply });

  } catch (err) {
    // תופס גם שגיאות פרסינג/רשת וגם שגיאות AI, כדי שמייל אף פעם לא "ייעלם בשקט"
    console.error(`[ERROR] ${err.message}`);
    if (replyTo) {
      await sendEscalation({
        originalFrom: senderId ? `${senderId}` : replyTo,
        originalSubject: subject ?? '(ללא נושא)',
        originalBody: userText ?? '(שגיאה לפני שהתקבל תוכן ההודעה)',
        reason: `שגיאה טכנית: ${err.message}`,
      }).catch(escErr => console.error(`[ESCALATION FAILED] ${escErr.message}`));
    }
  }
}

async function connectAndListen() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });

  let fallbackTimer;

  client.on('error', err => console.error(`[IMAP ERROR] ${err.message}`));
  client.on('close', () => {
    clearInterval(fallbackTimer);
    console.warn(`[IMAP] Connection closed — reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    scheduleReconnect();
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
  } catch (err) {
    console.error(`[IMAP CONNECT ERROR] ${err.message}`);
    scheduleReconnect();
    return;
  }

  console.log('[LISTEN] IMAP IDLE active — new messages are handled within seconds');

  // ImapFlow נכנס אוטומטית ל-IDLE כשאין פקודה פעילה, ויורה 'exists' ברגע שהודעה חדשה נכנסת
  client.on('exists', () => {
    checkUnseen(client).catch(err => console.error(`[EXISTS HANDLER] ${err.message}`));
  });

  // תפיסת הודעות שהגיעו לפני עליית השירות
  await checkUnseen(client);

  // רשת ביטחון בלבד, למקרה שחיבור ה-IDLE "נופל" בלי לירות אירוע close/error
  fallbackTimer = setInterval(() => checkUnseen(client).catch(() => {}), FALLBACK_POLL_MS);
}

export async function startListening() {
  await connectAndListen();
}
