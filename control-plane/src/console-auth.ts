import { createHash } from "node:crypto";
import { sql } from "./db.js";

// Remote-* headers alone are not a credential. Independently check the host
// cookie, its live root session, account status and authentication time.
export async function verifyConsoleSession(raw: string | undefined, subject: string | undefined) {
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw) || !subject) return false;
  const domain = process.env.APPS_DOMAIN!.toLowerCase();
  const rows = await sql`
    select 1 from gate.sessions s
    join gate.users u on u.id = s.user_id
    join gate.sessions p on p.id_hash = s.parent and p.user_id = s.user_id
    where s.id_hash = ${createHash("sha256").update(raw).digest()}
      and s.host = ${`deploy.${domain}`} and s.expires_at > now()
      and s.authenticated_at > now() - interval '12 hours'
      and p.parent is null and p.host = ${`auth.${domain}`} and p.expires_at > now()
      and u.id = ${subject} and u.role = 'admin' and u.status = 'active'`;
  return rows.length === 1;
}
