import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CalendarEvent, CalendarEventColor } from '@/lib/calendar';

export interface CalendarEventInput {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  allDay: boolean;
  color: CalendarEventColor;
  notes: string;
}

interface CalendarState {
  events: CalendarEvent[];
  createEvent: (input: CalendarEventInput) => CalendarEvent;
  updateEvent: (id: string, input: CalendarEventInput) => void;
  deleteEvent: (id: string) => void;
}

function createCalendarEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `calendar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useCalendarStore = create<CalendarState>()(
  persist(
    (set) => ({
      events: [],

      createEvent: (input) => {
        const now = new Date().toISOString();
        const nextEvent: CalendarEvent = {
          id: createCalendarEventId(),
          title: input.title.trim(),
          date: input.date,
          startTime: input.allDay ? undefined : input.startTime,
          endTime: input.allDay ? undefined : input.endTime,
          allDay: input.allDay,
          color: input.color,
          notes: input.notes.trim(),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          events: [...state.events, nextEvent],
        }));
        return nextEvent;
      },

      updateEvent: (id, input) => {
        set((state) => ({
          events: state.events.map((event) =>
            event.id === id
              ? {
                  ...event,
                  title: input.title.trim(),
                  date: input.date,
                  startTime: input.allDay ? undefined : input.startTime,
                  endTime: input.allDay ? undefined : input.endTime,
                  allDay: input.allDay,
                  color: input.color,
                  notes: input.notes.trim(),
                  updatedAt: new Date().toISOString(),
                }
              : event,
          ),
        }));
      },

      deleteEvent: (id) => {
        set((state) => ({
          events: state.events.filter((event) => event.id !== id),
        }));
      },
    }),
    {
      name: 'clawx-calendar',
    },
  ),
);
