// Validation for the audit query parameters. These values are interpolated into
// a PostgREST filter string, so anything that is not exactly the expected shape
// (a stray "),or(" for instance) must be refused before it reaches the store.

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// PostgREST returns microseconds and "+00:00"; the Worker's own clock gives ".123Z". Both must round-trip.
export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
export const SCOPE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Parses "<created_at>|<id>"; null when it is not exactly that shape.
export function parseAuditCursor(cursor: string): { createdAt: string; id: string } | null {
  const at = cursor.lastIndexOf("|");
  if (at < 1) return null;
  const createdAt = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!TIMESTAMP_RE.test(createdAt) || !UUID_RE.test(id)) return null;
  return { createdAt, id };
}
