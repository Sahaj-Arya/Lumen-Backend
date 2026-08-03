import { query } from '../db/index.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  userId?: string | null;
  homeId?: string | null;
  action: string;
  subject?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Best-effort audit trail. A failure here must never break the operation being
 * audited, so it logs and swallows rather than throwing.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (user_id, home_id, action, subject, metadata, ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        entry.userId ?? null,
        entry.homeId ?? null,
        entry.action,
        entry.subject ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.ip ?? null,
      ],
    );
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'failed to write audit entry');
  }
}
