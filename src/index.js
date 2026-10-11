import 'dotenv/config';
import { startListening } from './emailListener.js';
import { startOAuthServer } from './oauthServer.js';
import { startFollowupScheduler } from './followupScheduler.js';
import { startWhatsAppWebhookServer } from './whatsappWebhookServer.js';

const required = [
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'GITHUB_TOKEN', 'ESCALATION_EMAIL',
  'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
  'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET',
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

console.log('🤖 WhatsApp Chatbot starting...');
startOAuthServer()
  .then(() => {
    startFollowupScheduler();
    startWhatsAppWebhookServer();
    return startListening();
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
