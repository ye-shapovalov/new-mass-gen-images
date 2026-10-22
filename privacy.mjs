// Helpers that keep personal data out of the interface, logs and diagnostics.
// Nothing here ever sends data anywhere; it only rewrites local text.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Shows that an account exists without revealing it: "user@example.org" -> "u***@example.org".
// The mask has a fixed length, so the length of the address is not exposed either.
export function maskEmail(value) {
  const match = EMAIL.exec(String(value ?? '').trim());
  if (!match) return '';
  const [local, domain] = match[0].split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

// Removes every address from free text before it is written to a log or a diagnostic file.
export function redactEmails(value) {
  return String(value ?? '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
}

// The page snapshot can contain the signed-in account name, so it is sanitised before it is saved.
export function redactState(state) {
  if (!state || typeof state !== 'object') return state;
  const copy = { ...state };
  if (typeof copy.text === 'string') copy.text = redactEmails(copy.text);
  if (typeof copy.url === 'string') copy.url = redactEmails(copy.url);
  if (Array.isArray(copy.buttons)) copy.buttons = copy.buttons.map(button => redactEmails(button));
  return copy;
}
