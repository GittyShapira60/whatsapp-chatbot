import nodemailer from 'nodemailer';
import { sendWhatsAppCloudMessage } from './whatsappCloudApi.js';
import { getChannel } from './conversationState.js';
import { ts } from './logger.js';

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendReply({ to, subject, replyToMessageId, body, senderId }) {
  // כל תשובה למשתמש עצמו עוברת ב-WhatsApp Cloud API. מייל/SMTP משמש רק
  // לתשובת נציג אנושי (escalation) ולמיילי OTP — לא לתשובות ישירות למשתמש.
  const channel = await getChannel(senderId);
  if (channel === 'whatsapp_api') {
    try {
      await sendWhatsAppCloudMessage(senderId, body);
      console.log(`[${ts()}] [REPLY → WA]      נשלח למשתמש: ${senderId} | "${body.slice(0, 60)}..."`);
    } catch (err) {
      console.error(`[${ts()}] [REPLY WA ❌]    נכשל (${err.message})`);
      await sendAdminAlert({
        subject: 'שגיאת שליחה — WhatsApp Cloud API',
        body: `שליחה נכשלה למשתמש ${senderId}: ${err.message}`,
      });
    }
    return;
  }

  const mail = {
    from: process.env.SMTP_USER,
    to,
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    text: body,
    headers: {},
  };

  if (replyToMessageId) {
    mail.headers['In-Reply-To'] = replyToMessageId;
    mail.headers['References'] = replyToMessageId;
  }

  await createTransporter().sendMail(mail);
  console.log(`[${ts()}] [REPLY →]          נשלח למשתמש: ${to} | "${body.slice(0, 60)}..."`);
}

export async function sendAdminAlert({ subject, body }) {
  const to = process.env.ESCALATION_EMAIL;
  if (!to) return;
  await createTransporter().sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: `[BOT ALERT] ${subject}`,
    text: body,
  });
  console.log(`[${ts()}] [ADMIN ALERT →]    התראה נשלחה ל: ${to} | ${subject}`);
}

export async function sendEmail({ to, subject, html, text }) {
  await createTransporter().sendMail({
    from: `GDT Chatbot <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text,
  });
  console.log(`[${ts()}] [EMAIL →]          נשלח ל: ${to} | ${subject}`);
}

export async function sendEscalation({ originalFrom, originalSubject, originalBody, reason, senderId }) {
  const senderTag = senderId ? ` [ID:${senderId}]` : '';
  await createTransporter().sendMail({
    from: process.env.SMTP_USER,
    to: process.env.ESCALATION_EMAIL,
    subject: `[נדרש מענה אנושי]${senderTag} ${originalSubject}`,
    text: `⚠️ הבוט זיהה שנדרש מענה אנושי.

סיבה: ${reason}

── ההודעה המקורית ──
מ: ${originalFrom}
נושא: ${originalSubject}

${originalBody}

──────────────────────
יש להשיב ישירות ל-${originalFrom}`,
  });
  console.log(`[${ts()}] [ESCALATION →]     נשלח לנציג: ${process.env.ESCALATION_EMAIL} | סיבה: ${reason}`);
}
