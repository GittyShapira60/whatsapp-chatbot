import { setVerified, getHistory, addMessage } from './conversationState.js';
import { sendReply } from './emailSender.js';
import { generateResponse } from './aiEngine.js';

const REQUEST_COMPLETE_TOKEN = '[REQUEST_COMPLETE]';
const activePolls = new Map(); // senderId → cancel()

export async function initiateDeviceCodeAuth({ senderId, replyTo, subject, question }) {
  // ביטול poll קיים לאותו משתמש אם קיים
  activePolls.get(senderId)?.();

  const dcRes = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/devicecode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.AZURE_CLIENT_ID,
        scope: 'openid email profile',
      }),
    }
  );

  const dcData = await dcRes.json();
  if (dcData.error) {
    throw new Error(`device_code: ${dcData.error_description ?? dcData.error}`);
  }

  const { device_code, user_code, verification_uri, expires_in, interval } = dcData;

  let cancelled = false;
  activePolls.set(senderId, () => { cancelled = true; activePolls.delete(senderId); });

  // polling ברקע — לא חוסם
  (async () => {
    const deadline = Date.now() + expires_in * 1000;
    let pollMs = (interval + 1) * 1000;

    while (!cancelled && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      if (cancelled) return;

      try {
        const tokenRes = await fetch(
          `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth2:grant-type:device_code',
              client_id: process.env.AZURE_CLIENT_ID,
              device_code,
            }),
          }
        );

        const tok = await tokenRes.json();

        if (tok.access_token) {
          activePolls.delete(senderId);
          setVerified(senderId, 'GDT');
          console.log(`[OAUTH ✅] ${senderId} → כניסת GDT אושרה`);
          console.log(`[OAUTH ✅] ${senderId} → שאלה ממתינה: "${String(question).slice(0, 80)}"`);
          console.log(`[OAUTH ✅] ${senderId} → שולח ל-AI...`);

          try {
            const history = getHistory(senderId);
            const aiReply = await generateResponse([...history, { role: 'user', content: question }], []);
            const cleanReply = aiReply.replace(REQUEST_COMPLETE_TOKEN, '').trim();
            addMessage(senderId, 'user', question);
            addMessage(senderId, 'assistant', cleanReply);
            console.log(`[OAUTH ✅] ${senderId} → שולח תשובה ל-${replyTo}`);
            await sendReply({ to: replyTo, subject, replyToMessageId: null, senderId, body: cleanReply });
            console.log(`[OAUTH ✅] ${senderId} → תשובה נשלחה בהצלחה ✅`);
          } catch (e) {
            console.error(`[OAUTH ❌] ${senderId} → שגיאה אחרי כניסה: ${e.message}`);
            await sendReply({ to: replyTo, subject, replyToMessageId: null, senderId,
              body: 'הכניסה הצליחה ✅ אך אירעה שגיאה בעיבוד השאלה. שלח שוב את שאלתך 🙏' }).catch(() => {});
          }
          return;
        }

        if (tok.error === 'slow_down') { pollMs += 5000; continue; }
        if (tok.error === 'authorization_pending') continue;

        // שגיאות סופיות בלבד — כל שאר השגיאות ממשיכות את הלולאה
        if (tok.error === 'access_denied' || tok.error === 'expired_token' || tok.error === 'bad_verification_code') {
          activePolls.delete(senderId);
          console.error(`[OAUTH ❌] ${senderId} → ${tok.error}`);
          await sendReply({ to: replyTo, subject, replyToMessageId: null, senderId,
            body: 'הכניסה ל-Microsoft נכשלה. שלח את שאלתך שוב לנסות מחדש 🙏' });
          return;
        }

        // שגיאה לא מוכרת — ממשיכים לנסות
        console.warn(`[OAUTH POLL ⚠️] ${senderId} → ${tok.error}: ${tok.error_description ?? ''}`);
        continue;

      } catch (e) {
        console.error('[OAUTH POLL]', e.message);
      }
    }

    if (!cancelled) {
      activePolls.delete(senderId);
      console.log(`[OAUTH ⏱] ${senderId} → קוד פג תוקף`);
      await sendReply({ to: replyTo, subject, replyToMessageId: null, senderId,
        body: 'קוד הכניסה פג תוקף. שלח את שאלתך שוב לקבלת קוד חדש 🙏' });
    }
  })().catch(e => console.error('[OAUTH FATAL]', e.message));

  return { user_code, verification_uri };
}

export async function startOAuthServer() {
  console.log('[OAUTH] מצב device code flow — ללא tunnel, ללא redirect URI ✅');
}
