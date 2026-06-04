import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseEasySendEmail, isFromEasySend } from './messageParser.js';
import { needsEscalation, aiCantAnswer } from './knowledgeBase.js';
import { generateResponse } from './aiEngine.js';
import { sendReply, sendEscalation } from './emailSender.js';
import { getHistory, addMessage, clearHistory } from './conversationState.js';

const REQUEST_COMPLETE_TOKEN = '[REQUEST_COMPLETE]';

async function checkOnce() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    const uids = await client.search({ unseen: true });

    if (uids.length > 0) {
      console.log(`[POLL] ${uids.length} unread message(s)`);
      for (const uid of uids) {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        await processEmail(client, uid);
      }
    }
  } catch (err) {
    console.error(`[POLL ERROR] ${err.message}`);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function processEmail(client, uid) {
  const message = await client.fetchOne(uid, { source: true });
  if (!message) return;

  const parsed = await simpleParser(message.source);
  const { replyTo, senderName, senderPhone, subject, messageText, messageId, hasImages, imageCount, imageData } = parseEasySendEmail(parsed);

  // דילוג על מיילים שהבוט עצמו שלח (מונע לולאה אינסופית)
  const fromAddress = parsed.from?.value?.[0]?.address ?? '';
  if (fromAddress === process.env.SMTP_USER) {
    console.log(`[SKIP] Own message — skipping`);
    return;
  }

  if (!messageText && !hasImages) return;

  const senderId = senderPhone ?? replyTo;

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
  const userText = messageText || (hasImages ? `[המשתמש שלח ${imageCount} תמונה/ות]` : '');
  history.push({ role: 'user', content: userText });

  try {
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
      addMessage(senderId, 'user', userText);
      addMessage(senderId, 'assistant', cleanReply);
    }

    await sendReply({ to: replyTo, subject, replyToMessageId: messageId, body: cleanReply });

  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    await sendEscalation({
      originalFrom: `${senderName} ${senderId}`,
      originalSubject: subject,
      originalBody: userText,
      reason: `שגיאה טכנית: ${err.message}`,
    });
  }
}

export async function startListening() {
  const pollInterval = Number(process.env.POLL_INTERVAL_SECONDS ?? 30) * 1000;
  console.log(`[LISTEN] Polling every ${pollInterval / 1000}s`);
  await checkOnce();
  setInterval(checkOnce, pollInterval);
}
