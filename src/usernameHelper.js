// Single-message username helper:
// Bot asks all three at once → user replies in one message → bot returns username
// Format: {FirstLetter}{LastName}{Last2DigitsOfID}@idf.il

const pending = new Set(); // senderIds waiting for their details reply

export function hasPendingUsernameHelp(senderId) {
  return pending.has(senderId);
}

export function initUsernameHelp(senderId) {
  pending.add(senderId);
}

export function clearUsernameHelp(senderId) {
  pending.delete(senderId);
}

export function resolveUsername(senderId, input) {
  pending.delete(senderId);

  // Extract English words (first name, last name)
  const englishWords = input.match(/[A-Za-z]+/g) ?? [];
  // Extract digit sequences — prefer 7-9 digits (ID), else longest
  const digitSequences = (input.match(/\d+/g) ?? []);
  const idMatch = digitSequences.find(d => d.length >= 7) ?? digitSequences.sort((a, b) => b.length - a.length)[0];

  if (englishWords.length < 2) return { error: 'missing_names' };
  if (!idMatch || idMatch.length < 2) return { error: 'missing_id' };

  const firstName = englishWords[0];
  const lastName = englishWords[1];
  const last2 = idMatch.slice(-2);

  const username = `XD.${firstName[0].toUpperCase()}${lastName.toUpperCase()}${last2}@idf.il`;
  return { username };
}

// Distinguishes "user is answering with name/lastname/ID" from "user asked
// something else" — so a pending username-help state doesn't swallow an
// unrelated question the user asks before providing those details.
export function looksLikeUsernameDetailsAttempt(text) {
  const englishWords = text.match(/[A-Za-z]+/g) ?? [];
  const hasIdLikeDigits = (text.match(/\d+/g) ?? []).some(d => d.length >= 5);
  return englishWords.length >= 2 || hasIdLikeDigits;
}

export function looksLikeXDUsernameError(text) {
  // "יוזר"/"שם משתמש" are generic words used for every environment — if the
  // message explicitly names a non-CLICK environment, this is NOT an XD case;
  // let the AI ask/route properly instead of forcing the XD-only flow.
  const mentionsOtherEnv = /\bgdt\b|\bhorizon\b|הוריזון|גרין\s*דרים|greendreamteam|\bsky\b|סקיי|sky320/i.test(text);
  if (mentionsOtherEnv) return false;

  // General knowledge questions about users ("מה ההבדל בין היוזרים", "מה סוגי היוזרים", "מה זה יוזר XD")
  // are not about the asker's own username — the AI answers them from the knowledge base.
  const isGeneralQuestion = /הבדל|סוגי|סוגים|מה זה|מה זו|הסבר|תסביר|מה הפורמט|איזה יוזרים|אילו יוזרים|כל היוזרים/.test(text);
  const isAboutOwnUser = /שלי|(^|\s)לי($|[\s?.!,])/.test(text);
  if (isGeneralQuestion && !isAboutOwnUser) return false;

  const hasResetOrUsername = /xd|שם ה?משתמש|שם-משתמש|username|איפוס|סיסמ|יוזר/i.test(text);
  const hasErrorOrHelp = /שגיאה|לא נמצא|לא מוצא|לא מצא|לא יודע|לא זוכר|אינו קיים|not found|invalid/i.test(text)
    || /מה (ה)?(שם ה?משתמש|יוזר)[^?]*שלי/.test(text);
  return hasResetOrUsername && hasErrorOrHelp;
}
