import { setVerified } from './conversationState.js';
import { sendEmail } from './emailSender.js';

const pendingEmailRequests = new Map(); // senderId → { question, replyTo, subject }
const pendingOTPs = new Map();          // senderId → { otp, email, question, replyTo, subject, expiresAt }

const OTP_TTL_MS = 10 * 60 * 1000;

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function hasPendingEmailRequest(senderId) {
  return pendingEmailRequests.has(senderId);
}

export function hasPendingOTP(senderId) {
  const p = pendingOTPs.get(senderId);
  return !!(p && p.expiresAt > Date.now());
}

export function clearPendingAuth(senderId) {
  pendingEmailRequests.delete(senderId);
  pendingOTPs.delete(senderId);
}

export function initiateEmailAuth({ senderId, question, replyTo, subject }) {
  clearPendingAuth(senderId);
  pendingEmailRequests.set(senderId, { question, replyTo, subject });
}

export async function handleEmailSubmission({ senderId, email: rawInput }) {
  const pending = pendingEmailRequests.get(senderId);
  if (!pending) return null;

  // חילוץ כתובת מייל מהטקסט — מטפל בציטוטי ווטסאפ שנוספים אוטומטית
  const emailMatch = rawInput.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z.]{2,}/);
  const email = emailMatch ? emailMatch[0].toLowerCase() : rawInput.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'invalid_email' };
  }

  const domainsEnv = process.env.VERIFIED_EMAIL_DOMAINS ?? process.env.VERIFIED_EMAIL_DOMAIN;
  if (domainsEnv) {
    const allowedDomains = domainsEnv.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    const emailLower = email.toLowerCase();
    const isAllowed = allowedDomains.some(d => emailLower.endsWith(`@${d}`));
    if (!isAllowed) {
      return { error: 'wrong_domain', domains: allowedDomains };
    }
  }

  pendingEmailRequests.delete(senderId);

  const otp = generateOTP();
  pendingOTPs.set(senderId, {
    otp,
    email,
    question: pending.question,
    replyTo: pending.replyTo,
    subject: pending.subject,
    expiresAt: Date.now() + OTP_TTL_MS,
  });

  await sendEmail({
    to: email,
    subject: 'קוד אימות — GDT Chatbot',
    html: buildOTPEmail(otp),
    text: `קוד האימות שלך: ${otp}\n\nחזור לוואטסאפ והזן את הקוד.\nהקוד תקף ל-10 דקות.`,
  });

  return { success: true, email };
}

export async function handleOTPSubmission({ senderId, code }) {
  const pending = pendingOTPs.get(senderId);
  if (!pending) return { valid: false, reason: 'no_pending' };
  if (Date.now() > pending.expiresAt) {
    pendingOTPs.delete(senderId);
    return { valid: false, reason: 'expired' };
  }
  if (code.trim() !== pending.otp) {
    return { valid: false, reason: 'wrong_code' };
  }

  pendingOTPs.delete(senderId);
  await setVerified(senderId, 'GDT');

  return {
    valid: true,
    question: pending.question,
    replyTo: pending.replyTo,
    subject: pending.subject,
  };
}

function buildOTPEmail(otp) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.10);">

        <tr>
          <td style="background:linear-gradient(135deg,#1a56db 0%,#1e40af 100%);padding:36px 32px;text-align:center;">
            <div style="font-size:40px;margin-bottom:12px;">🔐</div>
            <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;">אימות זהות</h1>
            <p style="color:#93c5fd;margin:6px 0 0;font-size:14px;letter-spacing:1px;">GDT Chatbot</p>
          </td>
        </tr>

        <tr>
          <td style="padding:40px 32px 24px;">
            <p style="color:#374151;font-size:16px;margin:0 0 28px;line-height:1.7;">
              שלום 👋<br>
              קיבלנו בקשת אימות זהות מהוואטסאפ שלך.<br>
              הזן את הקוד הבא בשיחת הוואטסאפ:
            </p>

            <div style="background:#eff6ff;border:2px dashed #3b82f6;border-radius:14px;padding:28px 16px;text-align:center;margin:0 0 28px;">
              <p style="margin:0 0 10px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:3px;font-weight:600;">קוד האימות שלך</p>
              <p style="margin:0;font-size:52px;font-weight:800;color:#1a56db;letter-spacing:14px;font-family:'Courier New',monospace;">${otp}</p>
            </div>

            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#fefce8;border-right:4px solid #eab308;border-radius:8px;padding:14px 16px;">
                  <p style="margin:0;color:#713f12;font-size:14px;line-height:1.6;">
                    ↩️ <strong>חזור לוואטסאפ</strong> ושלח את הקוד הזה כדי לקבל גישה
                  </p>
                </td>
              </tr>
            </table>

            <p style="color:#9ca3af;font-size:12px;margin:24px 0 0;text-align:center;">
              ⏱ הקוד תקף ל-10 דקות בלבד &nbsp;|&nbsp; אין להעביר לאחרים
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">GDT Chatbot — מייל זה נשלח אוטומטית, אין להשיב אליו</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
