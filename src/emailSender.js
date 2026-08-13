import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      pool: true,
    });
  }
  return transporter;
}

export async function sendReply({ to, subject, replyToMessageId, body }) {
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

  await getTransporter().sendMail(mail);
  console.log(`[SENT] Reply to ${to}`);
}

export async function sendEscalation({ originalFrom, originalSubject, originalBody, reason }) {
  await getTransporter().sendMail({
    from: process.env.SMTP_USER,
    to: process.env.ESCALATION_EMAIL,
    subject: `[נדרש מענה אנושי] ${originalSubject}`,
    text: `⚠️ הבוט זיהה שנדרש מענה אנושי.

סיבה: ${reason}

── ההודעה המקורית ──
מ: ${originalFrom}
נושא: ${originalSubject}

${originalBody}

──────────────────────
יש להשיב ישירות ל-${originalFrom}`,
  });
  console.log(`[ESCALATION] Forwarded to ${process.env.ESCALATION_EMAIL}`);
}
