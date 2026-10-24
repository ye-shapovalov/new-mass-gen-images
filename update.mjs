export function isNewerVersion(candidate, current) {
  const parse = value => String(value).replace(/^v/, '').split('.').map(part => Number(part));
  const next = parse(candidate); const installed = parse(current);
  if (next.length !== 3 || installed.length !== 3 || [...next, ...installed].some(part => !Number.isInteger(part) || part < 0)) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}
