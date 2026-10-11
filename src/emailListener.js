import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { sendReply } from './emailSender.js';
import { getReplyTo, getChannel, clearHandoff } from './conversationState.js';
import { log } from './logger.js';

// הקובץ הזה כבר לא הערוץ הראשי לקבלת הודעות (זה עבר ל-whatsappWebhookServer.js) —
// הוא נשאר קיים רק כדי לתפוס תשובות של נציג אנושי שמגיעות בחזרה למייל אחרי escalation.

let polling = false;

// חולץ רק את טקסט התגובה החדשה — חותך לפני הציטוט המקורי
function extractReplyText(rawText) {
  const lines = rawText.split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('>')) break;
    if (/^On .+ wrote:/.test(t)) break;
    if (/^-{4,}/.test(t)) break;
    if (t.includes('──────')) break;
    if (t) out.push(t);
  }
  return out.join('\n').trim();
}

async function checkOnce() {
  if (polling) return;
  polling = true;
  try {
    await _checkOnce();
  } finally {
    polling = false;
  }
}

async function _checkOnce() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });

  client.on('error', (err) => {
    log('[IMAP ERROR]', err.message);
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    const uids = await client.search({ unseen: true }, { uid: true });

    if (uids.length > 0) {
      log('[POLL]', `נמצאו ${uids.length} הודעות חדשות בתיבה`);
      for (const uid of uids) {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        await processEmail(client, uid);
      }
    }
  } catch (err) {
    log('[POLL ERROR]', err.message);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function processEmail(client, uid) {
  const message = await client.fetchOne(uid, { source: true }, { uid: true });
  if (!message) return;

  const parsed = await simpleParser(message.source);

  const fromAddress = parsed.from?.value?.[0]?.address ?? '';

  console.log('');
  console.log('─────────────────────────────────────────────────');
  log('[MAIL נכנס]', `מ: ${fromAddress}`);
  log('            ', `נושא: ${(parsed.subject ?? '').slice(0, 80)}`);

  // דילוג על מיילים שהבוט עצמו שלח
  if (fromAddress === process.env.SMTP_USER) {
    log('[SKIP]', 'הודעה שהבוט עצמו שלח — מדלג');
    return;
  }

  // ── תשובת נציג לescalation ──
  const escalationEmail = (process.env.ESCALATION_EMAIL ?? '').toLowerCase();
  const isFromAgent = fromAddress.toLowerCase() === escalationEmail;

  log('[AGENT CHECK]', `from="${fromAddress}" | ESCALATION_EMAIL="${escalationEmail}" | match=${isFromAgent}`);

  if (isFromAgent) {
    log('[נציג השיב]', `מייל מ-${fromAddress}`);
    const subjectStr = parsed.subject ?? '';
    const bodyStr = parsed.text ?? '';
    log('[נציג השיב]', `נושא: "${subjectStr.slice(0, 120)}"`);

    // מחלץ את ה-senderId: קודם [ID:...] (פורמט חדש), אחר כך 972... (fallback לאחות ישנות)
    const idTagMatch = subjectStr.match(/\[ID:([^\]]+)\]/);
    const phoneOnlyMatch = subjectStr.match(/972\d+/) ?? bodyStr.match(/972\d+/);
    const resolvedId = idTagMatch ? idTagMatch[1] : (phoneOnlyMatch ? phoneOnlyMatch[0] : null);

    log('[נציג השיב]', `זיהוי senderId: ${resolvedId ?? '⚠️ לא נמצא'} (שיטה: ${idTagMatch ? '[ID:tag]' : phoneOnlyMatch ? '972... fallback' : 'כשלון'})`);

    if (resolvedId) {
      // משתמשי WhatsApp Cloud API לא שומרים replyTo (אין להם כתובת מייל וירטואלית) —
      // הגייט חייב לבדוק גם את הערוץ, אחרת תשובת הנציג תיבלע בשקט.
      const channel = await getChannel(resolvedId);
      const userReplyTo = await getReplyTo(resolvedId);
      const resolutionText = extractReplyText(bodyStr);

      if ((channel === 'whatsapp_api' || userReplyTo) && resolutionText) {
        log('[HANDOFF ✓]', `${resolvedId} → שולח תשובת נציג למשתמש (ערוץ: ${channel})`);
        log('            ', `תוכן: "${resolutionText.slice(0, 80)}"`);
        await sendReply({
          to: userReplyTo,
          subject: `הודעת ווטסאפ חדשה מ ${resolvedId}`,
          replyToMessageId: null,
          senderId: resolvedId,
          body: resolutionText,
        });
        await clearHandoff(resolvedId);
        log('[HANDOFF ✓]', `${resolvedId} → handoff נוקה ✅ הבוט חוזר לפעולה`);
      } else {
        if (channel !== 'whatsapp_api' && !userReplyTo) log('[HANDOFF ✓]', `${resolvedId} → אין replyTo שמור — לא נשלח מייל למשתמש`);
        if (!resolutionText) log('[HANDOFF ✓]', `${resolvedId} → תוכן הודעת הנציג ריק — לא נשלח מייל למשתמש`);
        await clearHandoff(resolvedId);
        log('[HANDOFF ✓]', `${resolvedId} → handoff נוקה ✅ הבוט חוזר לפעולה`);
      }
    } else {
      log('[נציג השיב]', `⚠️ לא ניתן לזהות משתמש — לא נמצא [ID:...] ולא 972... בנושא/גוף`);
      log('[נציג השיב]', `גוף המייל (100 תווים ראשונים): "${bodyStr.slice(0, 100)}"`);
    }
    return;
  }

  // כל מייל אחר בתיבה הזו (למשל אזעקות/spam) — לא רלוונטי, מתעלמים
  log('[SKIP]', `מייל שאינו תשובת נציג — מתעלם`);
  console.log('─────────────────────────────────────────────────');
  console.log('');
}

export async function startListening() {
  const pollInterval = Number(process.env.POLL_INTERVAL_SECONDS ?? 30) * 1000;
  console.log('');
  console.log('═════════════════════════════════════════════════');
  console.log(`  📧 מאזין לתשובות נציג | בדיקת תיבה כל ${pollInterval / 1000} שניות`);
  console.log(`  📧 תיבה: ${process.env.IMAP_USER}`);
  console.log(`  📤 נציג: ${process.env.ESCALATION_EMAIL}`);
  console.log('═════════════════════════════════════════════════');
  console.log('');
  await checkOnce();
  setInterval(checkOnce, pollInterval);
}
