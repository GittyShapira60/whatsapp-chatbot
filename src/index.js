import 'dotenv/config';
import { startListening } from './emailListener.js';

const required = [
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'GITHUB_TOKEN', 'ESCALATION_EMAIL',
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

console.log('🤖 WhatsApp Chatbot starting...');
startListening().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
