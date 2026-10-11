import http from 'node:http';
import { URL } from 'node:url';
import { verifyWebhookSignature, downloadWhatsAppMedia } from './whatsappCloudApi.js';
import { handleIncomingUserMessage } from './messageHandler.js';
import { log } from './logger.js';

const MAX_BODY_BYTES = 1024 * 1024;

const PRIVACY_POLICY_HTML = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>מדיניות פרטיות</title></head>
<body>
<h1>מדיניות פרטיות</h1>
<p>שירות זה הוא צאטבוט תמיכה הפועל דרך WhatsApp Business Platform.</p>
<p>הודעות הנשלחות לשירות זה משמשות אך ורק לצורך מתן מענה ותמיכה טכנית, ואינן משותפות עם צד שלישי כלשהו.</p>
<p>לשאלות ניתן לפנות דרך אותו ערוץ WhatsApp.</p>
</body>
</html>`;

function handleVerify(url, res) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    log('[WHATSAPP WEBHOOK]', 'אימות handshake הצליח ✅');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge ?? '');
  } else {
    log('[WHATSAPP WEBHOOK]', '⚠️ אימות handshake נכשל — verify_token לא תואם');
    res.writeHead(403);
    res.end();
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function extractMessagePayload(value) {
  const message = value.messages?.[0];
  if (!message) return null; // status/delivery receipt בלבד — אין מה לעבד

  const senderName = value.contacts?.[0]?.profile?.name ?? 'משתמש';
  const senderId = message.from;
  const messageId = message.id;

  if (message.type === 'text') {
    return { senderName, senderId, messageId, messageText: message.text?.body ?? '', hasImages: false, imageCount: 0, imageData: [] };
  }

  if (message.type === 'image') {
    const image = await downloadWhatsAppMedia(message.image.id);
    return {
      senderName, senderId, messageId,
      messageText: message.image.caption ?? '',
      hasImages: true, imageCount: 1, imageData: [image],
    };
  }

  // סוגי הודעה לא נתמכים (אודיו/וידאו/מסמך/מיקום/interactive/סטיקר וכו')
  log('[WHATSAPP WEBHOOK]', `${senderId} → סוג הודעה לא נתמך: ${message.type}`);
  return {
    senderName, senderId, messageId,
    messageText: 'המשתמש שלח סוג הודעה שאינו נתמך (לא טקסט/תמונה)',
    hasImages: false, imageCount: 0, imageData: [],
  };
}

async function processWebhookPayload(payload) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const parsed = await extractMessagePayload(value);
      if (!parsed) continue;

      const { senderId, senderName } = parsed;
      await handleIncomingUserMessage({
        senderId,
        senderName,
        replyTo: null,
        subject: `הודעת ווטסאפ חדשה מ ${senderName} ${senderId}`,
        messageId: parsed.messageId,
        messageText: parsed.messageText,
        hasImages: parsed.hasImages,
        imageCount: parsed.imageCount,
        imageData: parsed.imageData,
        channel: 'whatsapp_api',
      });
    }
  }
}

async function handlePost(req, res) {
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    log('[WHATSAPP WEBHOOK]', `שגיאת קריאת body: ${err.message}`);
    res.writeHead(err.statusCode ?? 400);
    res.end();
    return;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!verifyWebhookSignature(rawBody, signature)) {
    log('[WHATSAPP WEBHOOK]', '⚠️ חתימה לא תקינה — נדחה');
    res.writeHead(401);
    res.end();
    return;
  }

  // עונים מיד — Meta מצפה לאישור מהיר, ומנסה שוב (retry) על timeout/סטטוס לא-2xx
  res.writeHead(200);
  res.end();

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    log('[WHATSAPP WEBHOOK]', `⚠️ JSON לא תקין: ${err.message}`);
    return;
  }

  processWebhookPayload(payload).catch((err) => {
    log('[WHATSAPP WEBHOOK]', `⚠️ שגיאה בעיבוד הודעה נכנסת: ${err.message}`);
  });
}

export function startWhatsAppWebhookServer() {
  const port = Number(process.env.WHATSAPP_WEBHOOK_PORT ?? 3002);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/privacy' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PRIVACY_POLICY_HTML);
      return;
    }

    if (url.pathname !== '/webhook') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      handleVerify(url, res);
      return;
    }

    if (req.method === 'POST') {
      handlePost(req, res).catch((err) => {
        log('[WHATSAPP WEBHOOK]', `⚠️ שגיאה לא צפויה: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }

    res.writeHead(405);
    res.end();
  });

  server.listen(port, () => {
    log('[WHATSAPP WEBHOOK]', `שרת webhook פועל על פורט ${port} ✅`);
  });

  return server;
}
