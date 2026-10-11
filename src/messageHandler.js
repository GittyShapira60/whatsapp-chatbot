import { needsEscalation, aiCantAnswer } from './knowledgeBase.js';
import { generateResponse } from './aiEngine.js';
import { sendReply, sendEscalation, sendAdminAlert } from './emailSender.js';
import { getHistory, addMessage, clearHistory, setHandoff, isInHandoff, clearHandoff, setReplyTo, setChannel, isVerified, setFollowup, clearFollowup } from './conversationState.js';
import { initiateEmailAuth, hasPendingEmailRequest, hasPendingOTP, handleEmailSubmission, handleOTPSubmission, clearPendingAuth } from './otpAuth.js';
import { hasPendingUsernameHelp, initUsernameHelp, clearUsernameHelp, resolveUsername, looksLikeXDUsernameError, looksLikeUsernameDetailsAttempt } from './usernameHelper.js';
import { log } from './logger.js';

const REQUEST_COMPLETE_TOKEN = '[REQUEST_COMPLETE]';

// Code-level username validation — LLMs can't reliably count characters.
// GDT valid: exactly 2 letters + exactly 6 digits (e.g. AA123456)
// HORIZON valid: letters + exactly 2 digits at end (e.g. iisraeli00)
function detectInvalidShortUsername(text) {
  const pattern = /\b([A-Za-z]{1,2})(\d{3,7})\b/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, letters, digits] = match;
    if (letters.length === 2 && digits.length === 6) continue; // valid GDT: AA123456
    if (digits.length === 2) continue; // valid HORIZON-style ending: iisraeli00
    return match[0]; // invalid format — flag it
  }
  return null;
}

const _recentReplies = new Map(); // senderId → timestamp, prevents double-reply from duplicate deliveries

// מילות מפתח שמעידות על בקשת שירות (משהו לא עובד / צריך לעשות פעולה) — לא דורשות אימות
// שמות טכנולוגיות/מערכות (vpn, github וכו') הוסרו — "מה זה VPN" היא שאלת ידע, לא בקשת שירות
const SERVICE_KEYWORDS = [
  'נחסם', 'חסום', 'חסימה',
  'בעיה', 'לא עובד', 'לא מצליח', 'לא יכול', 'לא יכולה', 'שגיאה',
  'לא מוצא', 'לא מצאתי',
  'יצירת', 'ליצור', 'מחיקה', 'למחוק', 'נעילה', 'לנעול',
  'לפתוח', 'פתיחת', 'הרשאות',
  'לאפס', 'מאפס', 'איפוס', 'שכחתי',
  'עזור', 'תעזור', 'יכול לעזור', 'תוכל לעזור', 'לעזור',
  'קרה לי', 'קורה לי', 'תראה מה', 'תראה את',
  'חייל חדש', 'חיילת חדשה', 'משרת חדש', 'משרתת חדשה', 'יוזר חדש', 'משתמש חדש',
];

const KNOWLEDGE_QUESTION_WORDS = ['מה', 'מי', 'איך', 'למה', 'כמה', 'האם', 'מתי', 'היכן', 'איפה', 'כיצד', 'מדוע', 'באיזה', 'מאיזה', 'הסבר', 'ספר', 'תסביר', 'תגיד', 'אילו', 'כיצד'];

const TOPIC_KEYWORDS = [
  'gdt', 'sky', 'horizon', 'click', 'vpn', 'azure', 'gcp', 'avd',
  'servicenow', 'snow', 'outlook', 'company portal',
  'סיסמה', 'יוזר', 'משתמש', 'פרויקט', 'הרשאה', 'גישה', 'טיקט', 'חשבון',
];

// פתיחים שמעידים בבירור על שאלת ידע כללית ("מה ההבדל בין סוגי ההרשאות") — גוברים על מילות שירות כמו "הרשאות"/"יוזר חדש"
const PURE_INFO_OPENERS = /^(מה זה|מה זו|מה ההבדל|מה ההבדלים|מה סוגי|מה כל|אילו סוגי|איזה סוגי|הסבר|תסביר|ספר לי|תספר לי)/;

function looksLikeServiceRequest(text) {
  const lower = text.toLowerCase();
  const firstLine = (text.split('\n').find(l => l.trim()) ?? '').trim();
  if (PURE_INFO_OPENERS.test(firstLine) && !/שלי|(^|\s)לי($|[\s?.!,])/.test(firstLine)) return false;
  return SERVICE_KEYWORDS.some(kw => lower.includes(kw));
}

const GREETING_WORDS = ['היי', 'הי', 'שלום', 'בוקר טוב', 'צהריים טובים', 'ערב טוב', 'לילה טוב', 'מה נשמע', 'מה קורה', 'מה המצב', 'מה שלומך', 'מה שלום'];

function looksLikeGreeting(text) {
  const lower = text.trim().toLowerCase();
  const matched = GREETING_WORDS.find(g => lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + '?') || lower.startsWith(g + '!'));
  if (!matched) return false;
  const afterGreeting = lower.slice(matched.length).replace(/^[!?,. ]+/, '').trim();
  if (!afterGreeting) return true;
  // אם אחרי ה"היי" יש שאלת ידע — לא סתם ברכה
  if (afterGreeting.includes('?')) return false;
  if (TOPIC_KEYWORDS.some(kw => afterGreeting.includes(kw))) return false;
  if (KNOWLEDGE_QUESTION_WORDS.some(w => afterGreeting.startsWith(w + ' ') || afterGreeting === w)) return false;
  if (afterGreeting.length > 25) return false;
  return true;
}

// הודעות סיום — הבוט סגר את השיחה, אין צורך ב-follow-up
const CLOSING_PHRASES = [
  'שמחתי לעזור', 'שמחנו לעזור',
  'בהצלחה',
  'אם תצטרך', 'אם תזדקק', 'אם תרצה',
  'צריך עוד משהו', 'יש עוד משהו',
  'לרשותך', 'כאן בשבילך', 'אני כאן',
  'אל תהסס', 'תיצור קשר',
  'שאלות נוספות', 'פנייה נוספת',
];

function isBotClosingMessage(text) {
  return CLOSING_PHRASES.some(p => text.includes(p));
}

// שאלת ידע = יש ? או מילת שאלה/בקשה בתחילה, או הודעה ארוכה
function looksLikeKnowledgeQuestion(text) {
  const firstLine = (text.split('\n').find(l => l.trim()) ?? '').trim();
  const lower = firstLine.toLowerCase();
  if (firstLine.includes('?')) return true;
  if (KNOWLEDGE_QUESTION_WORDS.some(w => lower.startsWith(w + ' ') || lower === w)) return true;
  if (firstLine.length > 40) return true;
  if (TOPIC_KEYWORDS.some(kw => lower.includes(kw))) return true;
  return false;
}

// ביטויים שמרמזים על העברה לנציג בלי [REQUEST_COMPLETE] — שגיאת AI
const FORBIDDEN_WITHOUT_TOKEN = [
  'הנציג מטפל', 'מטפל בפנייתך', 'העברתי לצוות', 'שלחתי לטיפול',
  'הנציג יטפל', 'אני אטפל בזה', 'כבר מטפל', 'אני ממשיך עם הבקשה',
  'אסדר את זה', 'אני על זה',
];

const MAX_AI_RETRIES = 3;

// הלוגיקה העסקית המרכזית של הבוט — מופעלת מ-whatsappWebhookServer.js לכל הודעה נכנסת.
// שדות subject/messageId/replyTo מועברים הלאה ל-sendReply/sendEscalation ומשמשים רק
// לקריאות אנוש (למשל בכותרת מייל escalation) — לא לניתוב בפועל.
export async function handleIncomingUserMessage({
  senderId, senderName, replyTo, subject, messageId,
  messageText, hasImages, imageCount, imageData, channel,
}) {
  if (!messageText && !hasImages) {
    log('[SKIP]', 'אין טקסט ואין תמונות — מדלג');
    return;
  }

  // מניעת כפל הודעות (חלק ממערכות המקור שולחות 2+ עותקים של אותה הודעה).
  // dedupKey = senderId + תוכן ההודעה, כך שהודעה שניה שונה מאותו משתמש תעבור.
  const DEDUP_MS = 90_000;
  const contentFingerprint = messageText.slice(0, 120);
  const dedupKey = `${senderId}:${contentFingerprint}`;
  const lastReply = _recentReplies.get(dedupKey);
  if (lastReply && Date.now() - lastReply < DEDUP_MS) {
    log('[DEDUP]', `${senderId} → כפל הודעה זוהה, מדלג`);
    return;
  }
  _recentReplies.set(dedupKey, Date.now());

  // שמירת ערוץ + כתובת מייל וירטואלית (אם יש) תחת senderId
  await setChannel(senderId, channel);
  await setReplyTo(senderId, replyTo);
  // ביטול follow-up — המשתמש ענה
  await clearFollowup(senderId);

  const userText = messageText || (hasImages ? `[המשתמש שלח ${imageCount} תמונה/ות]` : '');

  if (hasImages) {
    log('[הודעה נכנסת]', `${senderName} (${senderId}) | ${imageCount} תמונה/ות + "${(messageText ?? '').slice(0, 60)}"`);
  } else {
    log('[הודעה נכנסת]', `${senderName} (${senderId}) | "${messageText.slice(0, 80)}"`);
  }

  // ── עזרה בשם משתמש XD — קבלת פרטים ובניית שם ──
  let pendingUsernameReminder = false;
  if (hasPendingUsernameHelp(senderId)) {
    if (looksLikeUsernameDetailsAttempt(messageText)) {
      const result = resolveUsername(senderId, messageText);
      if (result.username) {
        log('[USERNAME]', `${senderId} → שם משתמש שנבנה: ${result.username}`);
        await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
          body: `שם המשתמש הנכון שלך הוא:\n\n📋 ${result.username}\n\nהזן אותו בדף איפוס הסיסמה ולחץ "הבא".` });
      } else if (result.error === 'missing_names') {
        initUsernameHelp(senderId); // שואל שוב
        await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
          body: 'לא זיהיתי שם פרטי ושם משפחה באנגלית ❌\n\nשלח שוב בפורמט:\nשם פרטי | שם משפחה | מספר תז' });
      } else if (result.error === 'missing_id') {
        initUsernameHelp(senderId); // שואל שוב
        await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
          body: 'לא זיהיתי מספר תעודת זהות ❌\n\nשלח שוב בפורמט:\nשם פרטי | שם משפחה | מספר תז' });
      }
      return;
    }
    // ההודעה לא נראית כמו ניסיון לענות עם שם/ת"ז — כנראה שאלה אחרת.
    // לא מבטלים את המצב הממתין (עדיין נצטרך את הפרטים), אבל לא מתעלמים מהשאלה —
    // ממשיכים לטיפול AI רגיל, עם תזכורת שתשולב בתשובה.
    log('[USERNAME]', `${senderId} → במצב המתנה לפרטי שם משתמש, אך ההודעה לא נראית כתשובה → ממשיך לטיפול AI + תזכורת`);
    pendingUsernameReminder = true;
  }

  // ── בדיקת OTP ממתין ──
  if (hasPendingOTP(senderId)) {
    const NO_EMAIL_ACCESS_PHRASES = [
      'אין לי גישה', 'אין גישה', 'אין לי נגישות', 'אין נגישות',
      'לא מגיע לי', 'לא מגיעה לי', 'לא יכול לגשת', 'לא יכולה לגשת',
      'לא ניגש', 'לא נגיש', 'לא נגישה',
      'לא זמינה', 'לא זמין', 'הכתובת לא', 'המייל לא', 'לא נגיש',
    ];
    const noEmailAccess = NO_EMAIL_ACCESS_PHRASES.some(p => messageText.includes(p));
    if (noEmailAccess) {
      log('[OTP]', `${senderId} → אין גישה למייל → מעביר לנציג`);
      clearPendingAuth(senderId);
      await setHandoff(senderId);
      await sendEscalation({
        originalFrom: `${senderName} ${senderId}`,
        originalSubject: subject,
        originalBody: messageText,
        reason: 'המשתמש מדווח שאין לו גישה לכתובת המייל שנשלח אליה קוד האימות',
        senderId,
      });
      await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
        body: 'מעביר אותך לנציג 🙏' });
      return;
    }

    const otpMatch = messageText.match(/\b(\d{6})\b/);
    const code = otpMatch ? otpMatch[1] : messageText.trim().replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) {
      const result = await handleOTPSubmission({ senderId, code });
      if (result.valid) {
        log('[OTP ✅]', `${senderId} → מאומת כעובד GDT ✅ → עונה מיד על השאלה המקורית`);
        // השאלה המקורית עוברת את הזרימה הרגילה (המשתמש כבר מאומת) — כך מטופלים גם טוקנים כמו
        // [REQUEST_COMPLETE] / [USERNAME_HELPER] ושגיאות, ולא רק תשובת טקסט גולמית.
        _recentReplies.delete(`${senderId}:${result.question.slice(0, 120)}`);
        await handleIncomingUserMessage({
          senderId, senderName, replyTo: result.replyTo, subject: result.subject, messageId: null,
          messageText: result.question, hasImages: false, imageCount: 0, imageData: [], channel,
        });
      } else if (result.reason === 'expired') {
        await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
          body: 'הקוד פג תוקף ⏱\n\nשלח שוב את שאלתך לקבלת קוד חדש 🙏' });
      } else {
        await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
          body: 'קוד שגוי ❌\n\nנסה שוב — שלח את הקוד בן 6 הספרות מהמייל:' });
      }
      return;
    }
    // לא קוד ולא ביטוי "אין גישה" — מזכיר למשתמש להזין את הקוד
    log('[OTP]', `${senderId} → הודעה שאינה קוד OTP — שולח תזכורת`);
    await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
      body: 'עדיין ממתין לקוד האימות בן 6 הספרות שנשלח למייל שלך 📧\n\nאם אין לך גישה למייל — כתוב "אין לי גישה" ואעביר לנציג.' });
    return;
  }

  // ── בדיקת המתנה למייל ──
  // אם ביקשנו מהמשתמש מייל — ההודעה הבאה היא תמיד המייל, ללא ניחושים
  if (hasPendingEmailRequest(senderId)) {
    const NO_MAIL_PHRASES = [
      'אין לי מייל', 'אין מייל', 'אין לי גישה למייל', 'אין לי גישה לאימייל',
      'הכתובת לא זמינה', 'המייל לא זמין', 'לא זמין', 'לא זמינה',
      'אין גישה', 'לא יכול לגשת', 'לא יכולה לגשת', 'לא נגיש', 'לא נגישה',
      'המייל לא פתוח', 'מייל לא פתוח', 'המייל שלי לא', 'לא נפתח לי המייל',
      'המייל לא נגיש', 'מייל לא נגיש', 'המייל לא זמין', 'הכתובת לא פתוחה',
    ];
    if (NO_MAIL_PHRASES.some(p => messageText.includes(p))) {
      log('[EMAIL]', `${senderId} → אין גישה למייל → מעביר לנציג`);
      clearPendingAuth(senderId);
      await setHandoff(senderId);
      await sendEscalation({
        originalFrom: `${senderName} ${senderId}`,
        originalSubject: subject,
        originalBody: messageText,
        reason: 'המשתמש מדווח שאין לו גישה למייל (בשלב בקשת המייל)',
        senderId,
      });
      await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
        body: 'מעביר אותך לנציג 🙏' });
      return;
    }

    // אם אין '@' — לא ניסיון לשלוח מייל. מבטלים את בקשת האימות וממשיכים בעיבוד רגיל.
    if (!messageText.includes('@')) {
      log('[EMAIL]', `${senderId} → הודעה ללא '@' בזמן המתנה למייל — מבטל בקשת אימות`);
      clearPendingAuth(senderId);
      // fall through to normal processing
    } else {
      const result = await handleEmailSubmission({ senderId, email: messageText });
      if (result?.error === 'invalid_email') {
        await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
          body: 'הכתובת שנשלחה אינה תקינה ❌\n\nאנא שלח את המייל הארגוני שלך:' });
      } else if (result?.error === 'wrong_domain') {
        clearPendingAuth(senderId);
        await setHandoff(senderId);
        await sendEscalation({
          originalFrom: `${senderName} ${senderId}`,
          originalSubject: subject,
          originalBody: messageText,
          reason: `המשתמש שלח כתובת מייל מדומיין לא מורשה: ${messageText}`,
          senderId,
        });
        await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
          body: 'מעביר אותך לנציג 🙏' });
      } else if (result?.success) {
        await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
          body: `שלחתי קוד אימות לכתובת ${result.email} 📧\n\nהקוד תקף ל-10 דקות.\n\nהכנס כאן את הקוד בן 6 הספרות:` });
      }
      return;
    }
  }

  // ── בדיקת handoff ──
  if (await isInHandoff(senderId)) {
    log('[HANDOFF ↩]', `${senderId} → כרגע בטיפול נציג`);
    log('[HANDOFF ↩]', `מעביר הודעה בשקט לנציג (הלקוח לא מקבל תגובה מהבוט)`);
    await sendEscalation({
      originalFrom: `${senderName} ${senderId}`,
      originalSubject: subject,
      originalBody: userText,
      reason: 'המשך שיחה עם נציג — הודעה נוספת מהמשתמש',
      senderId,
    });
    log('[HANDOFF ↩]', `הועבר לנציג בהצלחה`);
    return;
  }

  // ── היסטוריית שיחה עד כה (נטענת פה כי גם שער האימות וגם עיבוד ה-AI צריכים אותה) ──
  const history = await getHistory(senderId);

  // ── אימות זהות לשאלות ידע ──
  // רק בהודעה הראשונה של השיחה (אין היסטוריה) — אחרת זו המשך של שיחה/בקשת שירות שכבר בעיצומה, ואסור להפריע לה עם בקשת אימות.
  if (!await isVerified(senderId)) {
    if (looksLikeKnowledgeQuestion(userText) && !looksLikeServiceRequest(userText) && !hasImages && !looksLikeGreeting(userText)) {
      log('[VERIFY]', `${senderId} → שאלת ידע ללא אימות → מבקש מייל ארגוני`);
      initiateEmailAuth({ senderId, replyTo, subject, question: userText });
      const allowedDomains = (process.env.VERIFIED_EMAIL_DOMAINS ?? '').split(',').map(d => `@${d.trim()}`).filter(Boolean);
      const domainNote = allowedDomains.length ? `\n\n(דומיינים מורשים: ${allowedDomains.join(' / ')})` : '';
      await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
        body: `כדי שאוכל לענות לך על שאלות ידע, יש לבדוק שהינך מורשה.\n\n📧 שלח את המייל הארגוני המלא שלך כולל הדומיין (לדוגמה: name@company.com):${domainNote}` });
      return;
    }
  }

  // ── זיהוי שגיאת שם משתמש XD → פתיחת רצף איתור שם ──
  if (messageText && looksLikeXDUsernameError(messageText)) {
    log('[USERNAME]', `${senderId} → זוהתה שגיאת שם משתמש XD → מבקש פרטים`);
    initUsernameHelp(senderId);
    await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
      body: 'אעזור לך למצוא את שם המשתמש הנכון 🔎\n\nשלח לי בהודעה אחת:\nשם פרטי באנגלית | שם משפחה באנגלית | מספר תעודת זהות\n\nלדוגמה: Elad Cohen 123456789' });
    return;
  }

  // ── מילות מפתח דחופות ──
  if (messageText && needsEscalation(messageText)) {
    log('[דחוף!]', `${senderId} → זוהו מילות מפתח דחופות → מעביר לנציג מיידית`);
    await clearHistory(senderId);
    await setHandoff(senderId);
    log('[HANDOFF ▶]', `${senderId} → handoff הוגדר (בקשה דחופה)`);
    await sendEscalation({
      originalFrom: `${senderName} ${senderId}`,
      originalSubject: subject,
      originalBody: messageText,
      reason: 'זוהו מילות מפתח דחופות',
      senderId,
    });
    await sendReply({
      to: replyTo, subject, replyToMessageId: messageId, senderId,
      body: 'קיבלתי את הפנייה שלך. בגלל הדחיפות, העברתי אותה לטיפול מיידי. נחזור אליך בהקדם.',
    });
    log('[REPLY →]', `${senderId} → נשלחה הודעת אישור למשתמש`);
    return;
  }

  // ── עיבוד AI ──
  log('[AI]', `שולח ל-AI | היסטוריה: ${history.length} הודעות`);

  const invalidUsername = detectInvalidShortUsername(userText ?? '');
  if (invalidUsername) {
    log('[VALIDATION]', `שם משתמש לא תקין זוהה: "${invalidUsername}" → מוסיף אזהרה ל-AI`);
  }

  const invalidUsernameNote = invalidUsername
    ? `[⚠️ SYSTEM VALIDATION: "${invalidUsername}" is NOT a valid username format. GDT requires EXACTLY 2 letters + EXACTLY 6 digits (e.g. AA123456). HORIZON requires letters + EXACTLY 2 digits at the end (e.g. iisraeli00). Do NOT accept "${invalidUsername}" as a username — tell the user it is incorrect and ask them to resend the correct format.]\n\n`
    : '';
  const pendingUsernameNote = pendingUsernameReminder
    ? `[⚠️ SYSTEM NOTE: Earlier in this conversation you asked the user for שם פרטי (English) + שם משפחה (English) + תעודת זהות to look up their XD username — but this message does not contain those details, it looks like a different question/request. Answer THIS message fully and normally using the knowledge base below, and ALSO add one short reminder line that you're still waiting for שם פרטי/שם משפחה/תעודת זהות for the earlier request. Do not ignore this message's actual content.]\n\n`
    : '';

  const userTextForAI = `${pendingUsernameNote}${invalidUsernameNote}${userText}`;

  const historyForAI = [...history, { role: 'user', content: userTextForAI }];

  const MAX_RETRIES = MAX_AI_RETRIES;
  let aiReply = null;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      aiReply = await generateResponse(historyForAI, imageData ?? []);
      lastErr = null;

      // בדיקה: AI אמר ביטוי אסור בלי REQUEST_COMPLETE?
      const hasForbidden = !aiReply.includes(REQUEST_COMPLETE_TOKEN) &&
        FORBIDDEN_WITHOUT_TOKEN.some(phrase => aiReply.includes(phrase));
      if (hasForbidden && attempt < MAX_RETRIES) {
        log('[⚠️ AI VIOLATION]', `ניסיון ${attempt}: AI אמר ביטוי אסור בלי REQUEST_COMPLETE — מנסה שוב`);
        log('[⚠️ AI VIOLATION]', `תגובה: "${aiReply.slice(0, 100)}"`);
        aiReply = null;
        continue;
      }

      break; // הצליח
    } catch (err) {
      lastErr = err;
      const isRateLimit = /rate.?limit/i.test(err.message);
      const isTransientOverload = /\b503\b|overloaded|high demand/i.test(err.message);
      const retryAfterMatch = err.message?.match(/retry-after:\s*(\d+)s/i);
      const waitSec = retryAfterMatch ? Number(retryAfterMatch[1]) : (isTransientOverload ? 3 : 60);

      log('[❌ ERROR]', `${senderId} → שגיאה (ניסיון ${attempt}/${MAX_RETRIES}): ${err.message}`);

      // שליחת התראה לאדמין בניסיון הראשון בלבד
      if (attempt === 1) {
        await sendAdminAlert({
          subject: `שגיאת AI — ${isRateLimit ? 'Rate Limit' : 'שגיאה טכנית'}`,
          body: `הבוט נתקל בשגיאה בעת מענה למשתמש ${senderId}.\n\nשגיאה: ${err.message}\n\nהבוט ינסה שוב אוטומטית (${MAX_RETRIES} ניסיונות). לא הועבר לנציג.`,
        });
      }

      if ((isRateLimit || isTransientOverload) && attempt < MAX_RETRIES) {
        log('[RATE LIMIT]', `ממתין ${waitSec}ש' לפני ניסיון ${attempt + 1}...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }

      // שגיאה שאינה rate-limit, או מיצינו את כל הניסיונות — עצירה
      break;
    }
  }

  if (lastErr) {
    log('[❌ FAIL]', `${senderId} → כל ${MAX_RETRIES} הניסיונות כשלו → מעביר לנציג`);
    await sendEscalation({
      originalFrom: `${senderName} ${senderId}`,
      originalSubject: subject,
      originalBody: userText,
      reason: `תקלה טכנית ב-AI: ${lastErr.message}`,
      senderId,
    });
    await sendReply({
      to: replyTo, subject, replyToMessageId: messageId, senderId,
      body: 'מצטער, נתקלתי בתקלה טכנית ולא הצלחתי לענות כרגע 🙏\nהעברתי את הפנייה לנציג והוא יחזור אליך.',
    });
    log('[REPLY →]', `${senderId} → נשלחה הודעת תקלה טכנית + נציג קיבל התראה`);
    return;
  }

  // ── AI זיהה שגיאת שם משתמש → מפעיל עוזר שמות ──
  // includes() ולא === : אם ה-AI מוסיף טקסט נוסף סביב הטוקן (קורה מדי פעם),
  // עדיין נזהה ונפעיל את הרצף — ולא ניתן לטוקן הגולמי לדלוף למשתמש.
  if (aiReply.includes('[USERNAME_HELPER]')) {
    log('[USERNAME]', `${senderId} → AI זיהה שגיאת שם משתמש → מתחיל רצף`);
    initUsernameHelp(senderId);
    await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId,
      body: 'אעזור לך למצוא את שם המשתמש הנכון 🔎\n\nשלח לי בהודעה אחת:\nשם פרטי באנגלית | שם משפחה באנגלית | מספר תעודת זהות\n\nלדוגמה: Elad Cohen 123456789' });
    return;
  }

  const isComplete = aiReply.includes(REQUEST_COMPLETE_TOKEN);
  // הסרה הגנתית: גם אם [USERNAME_HELPER] לא תפס אבל בכל זאת מופיע בטקסט
  // (למשל בתשובה ארוכה יותר) — לעולם לא ישלח למשתמש כמו שהוא.
  const cleanReply = aiReply
    .replace(REQUEST_COMPLETE_TOKEN, '')
    .replace('[USERNAME_HELPER]', '')
    .trim();

  log('[AI]', `תגובה התקבלה | ${aiReply.length} תווים | REQUEST_COMPLETE: ${isComplete ? 'כן ✅' : 'לא'}`);

  // ── AI לא יכול לענות ──
  if (aiCantAnswer(cleanReply)) {
    log('[AI לא יודע]', `${senderId} → הבוט לא מצא מידע → מעביר לנציג`);
    await clearHistory(senderId);
    await sendEscalation({
      originalFrom: `${senderName} ${senderId}`,
      originalSubject: subject,
      originalBody: userText,
      reason: hasImages ? `הבוט לא הצליח לפרש את התמונה (${imageCount} תמונות)` : 'הבוט לא מצא מידע מתאים',
      senderId,
    });
    await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId, body: cleanReply });
    log('[REPLY →]', `${senderId} → נשלחה הודעה למשתמש (AI לא ידע)`);
    return;
  }

  // ── REQUEST_COMPLETE — כל הפרטים נאספו ──
  if (isComplete) {
    log('[✅ COMPLETE]', `${senderId} → כל הפרטים נאספו → מעביר לנציג`);
    const summaryHistory = [...history, { role: 'user', content: userText }, { role: 'assistant', content: cleanReply }];
    const summary = summaryHistory.filter(m => m.role === 'user').map(m => m.content).join('\n---\n');
    await sendEscalation({
      originalFrom: `${senderName} ${senderId}`,
      originalSubject: subject,
      originalBody: summary,
      reason: 'בקשה שהושלמה — כל הפרטים נאספו',
      senderId,
    });
    log('[ESCALATION]', `נשלח מייל לנציג: ${process.env.ESCALATION_EMAIL}`);
    await clearHistory(senderId);
    await setHandoff(senderId);
    log('[HANDOFF ▶]', `${senderId} → handoff הוגדר ✅ | הודעות המשך יועברו לנציג בשקט`);
  } else {
    await addMessage(senderId, 'user', userText);
    await addMessage(senderId, 'assistant', cleanReply);
    if (isBotClosingMessage(cleanReply)) {
      await clearFollowup(senderId);
      log('[FOLLOWUP]', `${senderId} → הודעת סיום זוהתה → follow-up בוטל`);
    } else {
      await setFollowup(senderId);
    }
    log('[שיחה]', `${senderId} → הודעה נשמרה להיסטוריה | סה"כ: ${history.length + 2} הודעות`);
  }

  await sendReply({ to: replyTo, subject, replyToMessageId: messageId, senderId, body: cleanReply });
  log('[REPLY →]', `${senderId} → נשלחה תשובה למשתמש: "${cleanReply.slice(0, 60)}..."`);
}
