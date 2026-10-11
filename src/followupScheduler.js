import Redis from 'ioredis';
import { sendReply } from './emailSender.js';
import { getReplyTo, getChannel } from './conversationState.js';
import { log } from './logger.js';

export function startFollowupScheduler() {
  const subscriber = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

  subscriber.on('error', (err) => log('[FOLLOWUP ERR]', err.message));

  subscriber.subscribe('__keyevent@0__:expired', (err) => {
    if (err) {
      log('[FOLLOWUP ERR]', `שגיאה בהרשמה: ${err.message}`);
    } else {
      log('[FOLLOWUP ⏰]', 'מאזין לפקיעת מפתחות follow-up ✅');
    }
  });

  subscriber.on('message', async (_channel, key) => {
    if (!key.startsWith('followup:')) return;
    const phone = key.slice('followup:'.length);
    log('[FOLLOWUP ⏰]', `${phone} → שעה עברה ללא תגובה → שולח follow-up`);

    const channel = await getChannel(phone);
    const replyTo = await getReplyTo(phone);
    // משתמשי WhatsApp Cloud API אין להם replyTo (אין כתובת מייל וירטואלית) — זה תקין עבורם.
    if (channel !== 'whatsapp_api' && !replyTo) {
      log('[FOLLOWUP ⚠️]', `${phone} → לא נמצא replyTo — לא ניתן לשלוח`);
      return;
    }

    try {
      await sendReply({
        to: replyTo,
        subject: `הודעת ווטסאפ חדשה מ ${phone}`,
        replyToMessageId: null,
        senderId: phone,
        body: 'היי מה קורה הסתדרת? 😊',
      });
      log('[FOLLOWUP ✅]', `${phone} → הודעת follow-up נשלחה`);
    } catch (err) {
      log('[FOLLOWUP ❌]', `${phone} → שגיאה בשליחה: ${err.message}`);
    }
  });
}
