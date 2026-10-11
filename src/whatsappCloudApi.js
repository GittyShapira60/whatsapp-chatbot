import crypto from 'node:crypto';

const GRAPH_VERSION = () => process.env.WHATSAPP_API_VERSION ?? 'v21.0';
const GRAPH_BASE = () => `https://graph.facebook.com/${GRAPH_VERSION()}`;

async function graphFetch(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      ...options?.headers,
    },
  });

  const rawBody = await response.text();
  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`Non-JSON WhatsApp Graph API response (HTTP ${response.status}): ${rawBody.slice(0, 200)}`); }

  if (!response.ok) {
    throw new Error(`WhatsApp Graph API error (HTTP ${response.status}): ${data?.error?.message ?? rawBody.slice(0, 200)}`);
  }
  return data;
}

export async function sendWhatsAppCloudMessage(to, message) {
  if (process.env.WHATSAPP_DRY_RUN === 'true') {
    console.log(`[WHATSAPP DRY_RUN] היה נשלח ל-${to}: "${message.slice(0, 200)}"`);
    return { dryRun: true };
  }

  return graphFetch(`${GRAPH_BASE()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message },
    }),
  });
}

export async function downloadWhatsAppMedia(mediaId) {
  const meta = await graphFetch(`${GRAPH_BASE()}/${mediaId}`, { method: 'GET' });

  const response = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`נכשל בהורדת מדיה מ-WhatsApp (HTTP ${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  return {
    contentType: meta.mime_type,
    data: buffer.toString('base64'),
  };
}

// מאמת שהבקשה הגיעה באמת מ-Meta — HMAC-SHA256 על גוף הבקשה הגולמי עם WHATSAPP_APP_SECRET.
// חייב לקבל את ה-Buffer הגולמי (לפני JSON.parse), כי החתימה מחושבת על הבייטים המדויקים שנשלחו.
export function verifyWebhookSignature(rawBodyBuffer, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expectedHex = crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(rawBodyBuffer)
    .digest('hex');
  const expected = Buffer.from(expectedHex, 'utf8');
  const received = Buffer.from(signatureHeader.slice('sha256='.length), 'utf8');

  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}
