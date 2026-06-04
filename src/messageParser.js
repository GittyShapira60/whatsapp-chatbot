const SUBJECT_PATTERN = /הודעת ווטסאפ חדשה מ (.+?) (972\d+)$/i;
const EASYSEND_DOMAIN = 'easysend.co.il';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'];

export function isFromEasySend(parsedMail) {
  const from = parsedMail.from?.value?.[0]?.address ?? '';
  return from.endsWith(`@${EASYSEND_DOMAIN}`);
}

export function parseEasySendEmail(parsedMail) {
  const replyTo = parsedMail.from?.value?.[0]?.address ?? '';
  const subject = parsedMail.subject ?? '';

  const match = subject.match(SUBJECT_PATTERN);
  const senderName = match ? match[1].trim() : 'משתמש';
  const senderPhone = match ? match[2] : null;

  const attachments = parsedMail.attachments ?? [];
  const images = attachments.filter(a => IMAGE_TYPES.includes(a.contentType));
  const hasImages = images.length > 0;

  const rawText = parsedMail.text ?? '';
  const messageText = rawText
    .split('\n')
    .filter(line => !line.trimStart().startsWith('>') && line.trim() !== '')
    .join('\n')
    .trim();

  const imageData = images.map(a => ({
    contentType: a.contentType,
    data: a.content.toString('base64'),
  }));

  return {
    replyTo,
    senderName,
    senderPhone,
    subject,
    messageText,
    messageId: parsedMail.messageId ?? null,
    hasImages,
    imageCount: images.length,
    imageData,
  };
}
