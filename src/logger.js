export function ts() {
  return new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function log(tag, msg) {
  console.log(`[${ts()}] ${tag.padEnd(18)} ${msg}`);
}
