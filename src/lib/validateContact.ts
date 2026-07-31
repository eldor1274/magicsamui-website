const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

export function isValidContact(value: string): boolean {
  const trimmed = value.trim();
  if (EMAIL_RE.test(trimmed)) return true;
  const digitsOnly = trimmed.replace(/[\s\-().]/g, "");
  return PHONE_RE.test(digitsOnly);
}
