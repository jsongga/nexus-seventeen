import { describe, expect, it } from 'vitest';
import { SseFrameParser, type SseEvent } from './sse';

function parser(events: SseEvent[], maximumFrameLength = 1_024): SseFrameParser {
  return new SseFrameParser({
    maximumFrameLength,
    onEvent: (event) => events.push(event),
  });
}

describe('SseFrameParser', () => {
  it('dispatches LF-delimited frames', () => {
    const events: SseEvent[] = [];
    parser(events).push('event: update\nid: 1\ndata: first\n\n');

    expect(events).toEqual([{ event: 'update', id: '1', data: 'first' }]);
  });

  it('dispatches CRLF-delimited frames', () => {
    const events: SseEvent[] = [];
    parser(events).push('event: update\r\nid: 2\r\ndata: second\r\n\r\n');

    expect(events).toEqual([{ event: 'update', id: '2', data: 'second' }]);
  });

  it('accepts data fields with or without one optional space', () => {
    const events: SseEvent[] = [];
    parser(events).push('data: first\ndata:second\n\n');

    expect(events).toEqual([{ event: 'message', id: null, data: 'first\nsecond' }]);
  });

  it('preserves a frame delimiter split across chunks', () => {
    const events: SseEvent[] = [];
    const stream = parser(events);
    stream.push('event: update\r\ndata: split\r\n\r');
    expect(events).toEqual([]);

    stream.push('\n');
    expect(events).toEqual([{ event: 'update', id: null, data: 'split' }]);
  });

  it('rejects a frame that exceeds its configured size cap', () => {
    const stream = parser([], 8);
    expect(() => stream.push('123456789')).toThrow(/size limit/u);
  });
});
