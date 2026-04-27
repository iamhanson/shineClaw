export type CalendarEventColor =
  | 'green'
  | 'blue'
  | 'violet'
  | 'rose'
  | 'amber'
  | 'slate';

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  allDay: boolean;
  color: CalendarEventColor;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

const LUNAR_DAY_LABELS = [
  '',
  '初一',
  '初二',
  '初三',
  '初四',
  '初五',
  '初六',
  '初七',
  '初八',
  '初九',
  '初十',
  '十一',
  '十二',
  '十三',
  '十四',
  '十五',
  '十六',
  '十七',
  '十八',
  '十九',
  '二十',
  '廿一',
  '廿二',
  '廿三',
  '廿四',
  '廿五',
  '廿六',
  '廿七',
  '廿八',
  '廿九',
  '三十',
];

function cloneAtLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function fromDateKey(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function isSameMonth(date: Date, target: Date): boolean {
  return date.getFullYear() === target.getFullYear() && date.getMonth() === target.getMonth();
}

export function isSameDay(date: Date, target: Date): boolean {
  return toDateKey(date) === toDateKey(target);
}

export function buildMonthGrid(viewDate: Date): Date[] {
  const monthStart = startOfMonth(viewDate);
  const monthStartWeekday = monthStart.getDay();
  const offset = monthStartWeekday;
  const firstGridDate = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth(),
    monthStart.getDate() - offset,
  );

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(firstGridDate);
    day.setDate(firstGridDate.getDate() + index);
    return cloneAtLocalMidnight(day);
  });
}

function timeToMinutes(value?: string): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const [hour, minute] = value.split(':').map(Number);
  return (hour || 0) * 60 + (minute || 0);
}

export function sortCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((left, right) => {
    if (left.allDay !== right.allDay) {
      return left.allDay ? -1 : 1;
    }
    const timeDelta = timeToMinutes(left.startTime) - timeToMinutes(right.startTime);
    if (timeDelta !== 0) return timeDelta;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function getEventsForDate(events: CalendarEvent[], dateKey: string): CalendarEvent[] {
  return sortCalendarEvents(events.filter((event) => event.date === dateKey));
}

export function getLunarParts(date: Date): { monthLabel: string; dayNumber: number } {
  const formatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
    month: 'short',
    day: 'numeric',
  });
  const parts = formatter.formatToParts(date);
  const monthLabel = parts.find((part) => part.type === 'month')?.value || '';
  const dayNumber = Number(parts.find((part) => part.type === 'day')?.value || 1);
  return { monthLabel, dayNumber };
}

export function formatLunarLabel(date: Date, previousDate?: Date): string {
  const current = getLunarParts(date);
  const previous = previousDate ? getLunarParts(previousDate) : null;

  if (!previous || current.dayNumber === 1 || previous.monthLabel !== current.monthLabel) {
    return current.monthLabel;
  }

  return LUNAR_DAY_LABELS[current.dayNumber] || `${current.dayNumber}`;
}
