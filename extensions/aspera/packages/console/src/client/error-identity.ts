/** Stable public error codes exclude transient timestamps, ports, and retry counters. */
export function errorIdentity(message: string): string {
  if (/timeout|timed out/i.test(message)) return 'timeout'
  const code = /\b(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EACCES|ENOENT)\b/.exec(message)?.[1]
  if (code !== undefined) return code
  if (/authenticat|permission denied/i.test(message)) return 'authentication'
  return message.replace(/\b\d{4}-\d{2}-\d{2}T\S+|\b\d+(?:\.\d+)?(?:ms|seconds|秒)\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 256) || 'operation-failed'
}
