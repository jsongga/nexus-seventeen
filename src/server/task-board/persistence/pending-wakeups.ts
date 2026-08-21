export const PENDING_LIVE_WAKEUP_PREDICATE_SQL = `
  wakeup.claimed_at IS NULL
  AND (
    wakeup.task_id IS NULL OR EXISTS (
      SELECT 1 FROM tasks AS task
      WHERE task.task_id = wakeup.task_id
        AND task.project_id = wakeup.project_id
        AND task.assigned_agent_id = wakeup.agent_id
        AND task.ended_at IS NULL
        AND task.status IN ('queued', 'blocked')
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_events AS event
    WHERE event.event_id = ? || wakeup.wakeup_id
  )
`;
