import { describe, expect, it } from 'vitest';
import {
  buildMonthGrid,
  formatLunarLabel,
  getEventsForDate,
  sortCalendarEvents,
  toDateKey,
  type CalendarEvent,
} from '@/lib/calendar';

describe('calendar utils', () => {
  it('builds a 42-cell month grid with sunday as the first day of week', () => {
    const grid = buildMonthGrid(new Date('2026-03-10T09:00:00'));

    expect(grid).toHaveLength(42);
    expect(toDateKey(grid[0] as Date)).toBe('2026-03-01');
    expect(toDateKey(grid[41] as Date)).toBe('2026-04-11');
  });

  it('sorts all-day events before timed events and then by start time', () => {
    const events: CalendarEvent[] = [
      {
        id: '2',
        title: 'Evening call',
        date: '2026-03-31',
        startTime: '18:00',
        endTime: '18:30',
        allDay: false,
        color: 'violet',
        notes: '',
        createdAt: '2026-03-31T01:00:00.000Z',
        updatedAt: '2026-03-31T01:00:00.000Z',
      },
      {
        id: '1',
        title: 'Offsite',
        date: '2026-03-31',
        allDay: true,
        color: 'green',
        notes: '',
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
      {
        id: '3',
        title: 'Morning review',
        date: '2026-03-31',
        startTime: '09:30',
        endTime: '10:00',
        allDay: false,
        color: 'blue',
        notes: '',
        createdAt: '2026-03-31T02:00:00.000Z',
        updatedAt: '2026-03-31T02:00:00.000Z',
      },
    ];

    expect(sortCalendarEvents(events).map((item) => item.id)).toEqual(['1', '3', '2']);
  });

  it('filters date events and keeps sorted output stable', () => {
    const events: CalendarEvent[] = [
      {
        id: '1',
        title: 'Tomorrow',
        date: '2026-04-01',
        allDay: true,
        color: 'amber',
        notes: '',
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
      {
        id: '2',
        title: 'Lunch',
        date: '2026-03-31',
        startTime: '12:00',
        endTime: '13:00',
        allDay: false,
        color: 'rose',
        notes: '',
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
      {
        id: '3',
        title: 'Today all day',
        date: '2026-03-31',
        allDay: true,
        color: 'slate',
        notes: '',
        createdAt: '2026-03-31T00:00:00.000Z',
        updatedAt: '2026-03-31T00:00:00.000Z',
      },
    ];

    expect(getEventsForDate(events, '2026-03-31').map((item) => item.id)).toEqual(['3', '2']);
  });

  it('formats lunar labels with month starts and day labels', () => {
    expect(formatLunarLabel(new Date('2026-03-01'))).toBe('正月');
    expect(formatLunarLabel(new Date('2026-03-02'), new Date('2026-03-01'))).toBe('十四');
    expect(formatLunarLabel(new Date('2026-03-19'), new Date('2026-03-18'))).toBe('二月');
  });
});
