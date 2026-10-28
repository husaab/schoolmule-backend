// Observe alerts (services/observe/alerts/*). Times are bound as timestamptz.

const INCIDENT_COLUMNS = `incident_id, status, tier, title, subject, opened_at, last_trip_at, resolved_at, reopen_count,
  notified_at, notified_tier, last_reminder_at, reopen_pending, recovered_notified_at, summarized_at, rules, stats`;

module.exports = {
  // The open incident and anything resolved in the last day (reopening,
  // recovery emails and the morning summary all look back at most that far).
  loadRecent: `
    SELECT ${INCIDENT_COLUMNS} FROM alert_incidents
    WHERE status = 'open' OR resolved_at > NOW() - INTERVAL '24 hours'
    ORDER BY opened_at DESC
    LIMIT 50`,

  // The worker's copy is the truth for everything but the notification
  // claims, which have their own conditional UPDATEs below; those only ever
  // move forward here (a send made while the database was down is kept).
  upsertIncident: `
    INSERT INTO alert_incidents (${INCIDENT_COLUMNS}, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, NOW())
    ON CONFLICT (incident_id) DO UPDATE SET
      status = EXCLUDED.status,
      tier = EXCLUDED.tier,
      title = EXCLUDED.title,
      subject = COALESCE(alert_incidents.subject, EXCLUDED.subject),
      last_trip_at = EXCLUDED.last_trip_at,
      resolved_at = EXCLUDED.resolved_at,
      reopen_count = EXCLUDED.reopen_count,
      notified_at = COALESCE(alert_incidents.notified_at, EXCLUDED.notified_at),
      notified_tier = COALESCE(EXCLUDED.notified_tier, alert_incidents.notified_tier),
      last_reminder_at = GREATEST(alert_incidents.last_reminder_at, EXCLUDED.last_reminder_at),
      summarized_at = COALESCE(alert_incidents.summarized_at, EXCLUDED.summarized_at),
      -- Reopening clears these; otherwise a stale copy must not undo a send
      -- another replica made in the meantime.
      reopen_pending = CASE WHEN EXCLUDED.status = 'open' AND EXCLUDED.reopen_count > alert_incidents.reopen_count
        THEN EXCLUDED.reopen_pending ELSE alert_incidents.reopen_pending AND EXCLUDED.reopen_pending END,
      recovered_notified_at = CASE WHEN EXCLUDED.status = 'open' THEN NULL
        ELSE COALESCE(alert_incidents.recovered_notified_at, EXCLUDED.recovered_notified_at) END,
      rules = EXCLUDED.rules,
      stats = EXCLUDED.stats,
      updated_at = NOW()`,

  // Claims: each sets what it is about to send, only if no one has yet, so
  // exactly one replica sends it. A failed send hands the claim back.
  claimOpened: `
    UPDATE alert_incidents SET notified_at = $2, notified_tier = $3, subject = COALESCE(subject, $4)
    WHERE incident_id = $1 AND notified_at IS NULL
    RETURNING subject`,
  releaseOpened: `UPDATE alert_incidents SET notified_at = NULL, notified_tier = NULL WHERE incident_id = $1`,

  claimEscalated: `
    UPDATE alert_incidents SET notified_tier = 'critical'
    WHERE incident_id = $1 AND notified_at IS NOT NULL AND notified_tier IS DISTINCT FROM 'critical'
    RETURNING subject`,
  releaseEscalated: `UPDATE alert_incidents SET notified_tier = $2 WHERE incident_id = $1`,

  claimReminder: `
    UPDATE alert_incidents SET last_reminder_at = $2
    WHERE incident_id = $1 AND status = 'open' AND notified_at IS NOT NULL
      AND COALESCE(last_reminder_at, notified_at) <= $2::timestamptz - INTERVAL '55 minutes'
    RETURNING subject`,
  releaseReminder: `UPDATE alert_incidents SET last_reminder_at = $2 WHERE incident_id = $1`,

  claimReopened: `
    UPDATE alert_incidents SET reopen_pending = FALSE, last_reminder_at = $2
    WHERE incident_id = $1 AND reopen_pending
    RETURNING subject`,
  releaseReopened: `UPDATE alert_incidents SET reopen_pending = TRUE, last_reminder_at = $2 WHERE incident_id = $1`,

  claimRecovered: `
    UPDATE alert_incidents SET recovered_notified_at = $2
    WHERE incident_id = $1 AND status = 'resolved' AND recovered_notified_at IS NULL
    RETURNING subject`,
  releaseRecovered: `UPDATE alert_incidents SET recovered_notified_at = NULL WHERE incident_id = $1`,

  claimSummary: `
    UPDATE alert_incidents SET summarized_at = $2
    WHERE incident_id = ANY($1::uuid[]) AND notified_at IS NULL AND summarized_at IS NULL
    RETURNING incident_id`,
  releaseSummary: `UPDATE alert_incidents SET summarized_at = NULL WHERE incident_id = ANY($1::uuid[])`,

  insertNotification: `
    INSERT INTO alert_notifications (incident_id, ts, channel, kind, ok, recipients, subject, error)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,

  // The hourly cap: test sends don't count against it.
  emailsSince: `SELECT COUNT(*)::int AS n FROM alert_notifications WHERE channel = 'email' AND ok AND kind <> 'test' AND ts > $1`,

  overrides: `SELECT rule_id, enabled, mode, params, muted_until FROM alert_rule_overrides`,
  upsertOverride: `
    INSERT INTO alert_rule_overrides (rule_id, enabled, mode, params, muted_until, updated_by, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
    ON CONFLICT (rule_id) DO UPDATE SET
      enabled = EXCLUDED.enabled, mode = EXCLUDED.mode, params = EXCLUDED.params,
      muted_until = EXCLUDED.muted_until, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    RETURNING rule_id, enabled, mode, params, muted_until`,
  deleteOverride: `DELETE FROM alert_rule_overrides WHERE rule_id = $1`,

  insertTrip: `INSERT INTO alert_rule_trips (rule_id, ts, mode, value, summary) VALUES ($1, $2, $3, $4, $5)`,
  lastTrips: `
    SELECT DISTINCT ON (rule_id) rule_id, ts, mode, value, summary
    FROM alert_rule_trips ORDER BY rule_id, ts DESC`,
  tripCounts: `
    SELECT rule_id, mode, COUNT(*)::int AS n FROM alert_rule_trips
    WHERE ts > NOW() - INTERVAL '7 days' GROUP BY rule_id, mode`,

  insertBoot: `INSERT INTO alert_boots (booted_at) VALUES (NOW())`,
  bootsSince: `SELECT COUNT(*)::int AS n FROM alert_boots WHERE booted_at > NOW() - ($1 || ' minutes')::interval`,
  prune: `
    WITH b AS (DELETE FROM alert_boots WHERE booted_at < NOW() - INTERVAL '7 days')
    DELETE FROM alert_rule_trips WHERE ts < NOW() - INTERVAL '90 days'`,

  // Slower readings, every few minutes on a 5 s statement timeout.
  // A server error whose fingerprint wasn't seen in the 30 days before the last 10 minutes.
  newErrorTypes: `
    SELECT e.fingerprint, MAX(e.message) AS message, COUNT(*)::int AS count
    FROM error_events e
    WHERE e.ts > NOW() - INTERVAL '10 minutes'
    GROUP BY e.fingerprint
    HAVING COUNT(*) >= $1
       AND NOT EXISTS (
         SELECT 1 FROM error_events o
         WHERE o.fingerprint = e.fingerprint
           AND o.ts <= NOW() - INTERVAL '10 minutes'
           AND o.ts > NOW() - INTERVAL '30 days')
    ORDER BY count DESC
    LIMIT 10`,
  outboxFailed: `
    SELECT COUNT(*)::int AS n FROM email_outbox
    WHERE status = 'failed' AND finished_at > NOW() - INTERVAL '1 hour'`,

  // Console.
  listIncidents: `
    SELECT ${INCIDENT_COLUMNS},
      (SELECT COUNT(*)::int FROM alert_notifications n WHERE n.incident_id = i.incident_id AND n.channel = 'email' AND n.ok) AS emails,
      (SELECT COUNT(*)::int FROM alert_notifications n WHERE n.incident_id = i.incident_id AND n.channel = 'push' AND n.ok) AS pushes
    FROM alert_incidents i
    WHERE i.status = 'open' OR i.opened_at >= $1
    ORDER BY (i.status = 'open') DESC, i.opened_at DESC
    LIMIT 200`,
  getIncident: `SELECT ${INCIDENT_COLUMNS} FROM alert_incidents WHERE incident_id = $1`,
  openIncident: `SELECT ${INCIDENT_COLUMNS} FROM alert_incidents WHERE status = 'open'`,
  incidentNotifications: `
    SELECT ts, channel, kind, ok, recipients, subject, error
    FROM alert_notifications WHERE incident_id = $1 ORDER BY ts`,
  deleteResolvedIncident: `DELETE FROM alert_incidents WHERE incident_id = $1 AND status = 'resolved' RETURNING incident_id`,
  recentSummaries: `
    SELECT ts, channel, kind, ok, recipients, subject, error FROM alert_notifications
    WHERE incident_id IS NULL AND kind IN ('test', 'summary') AND ts >= $1 ORDER BY ts DESC LIMIT 50`,

  // The platform owners' phones (services/observe/alerts/ownerPush.js).
  ownerPushTokens: `
    SELECT d.token FROM push_devices d
    JOIN users u ON u.user_id = d.user_id
    WHERE LOWER(u.email) = ANY($1::text[]) AND COALESCE(u.is_archived, FALSE) = FALSE`,
};
