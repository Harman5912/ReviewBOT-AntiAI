const SECRET_PATTERNS = [
  /(?:password|passwd|pwd)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  /(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  /(?:token|auth[_-]?token|access[_-]?token)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  /(?:private[_-]?key|secret)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,
  /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  /sk-[A-Za-z0-9]{48}/g,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

export function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
