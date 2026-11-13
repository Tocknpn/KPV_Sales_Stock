// Who is making a database write. The Worker forwards this to Postgres in
// request headers; the audit trigger (supabase/migrations/20261112_02_audit.sql)
// reads them. A staff member is { id }; background/unauthenticated work such
// as login lockouts is { system: "<tag>" }.
export type Actor = { id: string } | { system: string };

export function actorHeaders(actor: Actor | undefined): Record<string, string> {
  if (!actor) return {};
  return "id" in actor ? { "X-KPV-Actor-Id": actor.id } : { "X-KPV-Actor-System": actor.system };
}
