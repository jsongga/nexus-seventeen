import type { ISODateTime } from './domain';

const taskTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatTaskTimestamp(value: ISODateTime): string {
  return taskTimeFormatter.format(new Date(value));
}

export function formatAgentMinutes(minutes: number): string {
  return `${minutes} min agent time`;
}
