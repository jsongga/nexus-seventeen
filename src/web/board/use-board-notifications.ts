/** Owns the board's notification list: loading, retrying, and marking one read. */

/* —— Imports —— */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BoardNotifications, TaskBoardClient } from "../data/client";
import type { RawBoardNotification } from "../data/parse";
import type { BoardSnapshot } from "../types";
import { NotificationLoadCoordinator } from "../model/notification-load";

/* —— Hook —— */

export interface BoardNotificationsState {
  readonly notifications: BoardNotifications | null;
  readonly notificationsLoading: boolean;
  readonly notificationsError: string | null;
  readonly markingNotificationId: string | null;
  readonly retryNotifications: () => void;
  readonly markNotificationRead: (notification: RawBoardNotification) => Promise<void>;
}

/**
 * The snapshot drives loading: the coordinator decides when an arriving snapshot means the
 * notification list is stale, so this hook never polls on its own.
 */
export function useBoardNotifications(
  client: TaskBoardClient,
  snapshot: BoardSnapshot | null
): BoardNotificationsState {
  const [notifications, setNotifications] = useState<BoardNotifications | null>(null);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [markingNotificationId, setMarkingNotificationId] = useState<string | null>(null);
  const [notificationsAttempt, setNotificationsAttempt] = useState(0);
  const notificationLoads = useMemo(() => new NotificationLoadCoordinator(), []);

  const loadNotifications = useCallback(
    async (token: number, afterMarkRead = false) => {
      setNotificationsLoading(true);
      try {
        const next = await client.getNotifications();
        if (!notificationLoads.isLatest(token)) return;
        setNotifications(next);
        setNotificationsError(null);
      } catch (caught) {
        if (!notificationLoads.isLatest(token)) return;
        setNotificationsError(
          afterMarkRead
            ? caught instanceof Error
              ? `Marked read, but notifications could not refresh. ${caught.message}`
              : "Marked read, but notifications could not refresh."
            : caught instanceof Error
              ? caught.message
              : "Notifications could not be loaded."
        );
      } finally {
        if (notificationLoads.isLatest(token)) setNotificationsLoading(false);
      }
    },
    [client, notificationLoads]
  );

  useEffect(() => {
    notificationLoads.activate();
    return () => notificationLoads.deactivate();
  }, [notificationLoads]);

  useEffect(() => {
    if (snapshot === null) return;
    void notificationLoads.snapshotArrived(snapshot, (token) => loadNotifications(token));
  }, [loadNotifications, notificationLoads, notificationsAttempt, snapshot]);

  async function markNotificationRead(notification: RawBoardNotification): Promise<void> {
    if (markingNotificationId !== null) return;
    const previous = notifications;
    notificationLoads.invalidate();
    setMarkingNotificationId(notification.notificationId);
    setNotificationsLoading(false);
    setNotificationsError(null);
    setNotifications((current) =>
      current === null
        ? current
        : {
            ...current,
            unread: current.unread.filter((entry) => entry.notificationId !== notification.notificationId),
          }
    );
    try {
      await client.markNotificationRead(notification.notificationId, notification.version);
      await notificationLoads.refresh((token) => loadNotifications(token, true));
    } catch (caught) {
      setNotifications(previous);
      setNotificationsError(caught instanceof Error ? caught.message : "The notification could not be marked read.");
    } finally {
      setMarkingNotificationId(null);
    }
  }

  return {
    notifications,
    notificationsLoading,
    notificationsError,
    markingNotificationId,
    retryNotifications: () => setNotificationsAttempt((value) => value + 1),
    markNotificationRead,
  };
}
