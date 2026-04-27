import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { sendJson } from '../route-utils';

const execFileAsync = promisify(execFile);

interface SystemCalendarEvent {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
}

interface CalendarPermissionState {
  authorized: boolean;
  reason?: string;
}

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

function detectCalendarPermissionState(error: unknown): CalendarPermissionState {
  const text = normalizeErrorText(error).toLowerCase();
  if (
    text.includes('not authorized') ||
    text.includes('not permitted') ||
    text.includes('operation not permitted') ||
    text.includes('(-1743)') ||
    text.includes('(-10004)') ||
    text.includes('calendar got an error')
  ) {
    return { authorized: false, reason: normalizeErrorText(error) };
  }
  return { authorized: true, reason: normalizeErrorText(error) };
}

function parseMonthParam(monthParam: string | null): { start: Date; end: Date } {
  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    };
  }

  const year = Number(monthParam.slice(0, 4));
  const month = Number(monthParam.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    };
  }
  return {
    start: new Date(year, month - 1, 1),
    end: new Date(year, month, 1),
  };
}

function toShortIsoDate(date: Date): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

async function readMacSystemCalendar(params: { start: Date; end: Date }): Promise<SystemCalendarEvent[]> {
  const appleScript = `
on sanitizeText(rawText)
  set t to rawText as text
  set AppleScript's text item delimiters to return
  set t to (text items of t) as text
  set AppleScript's text item delimiters to linefeed
  set t to (text items of t) as text
  set AppleScript's text item delimiters to tab
  set t to (text items of t) as text
  set AppleScript's text item delimiters to ""
  return t
end sanitizeText

on buildDate(dateText)
  set monthNames to {January, February, March, April, May, June, July, August, September, October, November, December}
  set y to (text 1 thru 4 of dateText) as integer
  set m to (text 6 thru 7 of dateText) as integer
  set d to (text 9 thru 10 of dateText) as integer
  set dt to current date
  set year of dt to y
  set month of dt to item m of monthNames
  set day of dt to d
  set time of dt to 0
  return dt
end buildDate

on run argv
set startText to item 1 of argv
set endText to item 2 of argv
set startDate to buildDate(startText)
set endDate to buildDate(endText)

set epochDate to current date
set year of epochDate to 1970
set month of epochDate to January
set day of epochDate to 1
set time of epochDate to 0

set outputLines to {}
tell application "Calendar"
  repeat with oneCalendar in calendars
    set calendarName to my sanitizeText(name of oneCalendar)
    set matchedEvents to (every event of oneCalendar whose start date is greater than or equal to startDate and start date is less than endDate)
    repeat with oneEvent in matchedEvents
      set titleText to my sanitizeText(summary of oneEvent)
      set startEpoch to (start date of oneEvent) - epochDate
      set endEpoch to (end date of oneEvent) - epochDate
      set allDayValue to (allday event of oneEvent) as boolean
      set lineText to (calendarName & tab & titleText & tab & (startEpoch as text) & tab & (endEpoch as text) & tab & (allDayValue as text))
      set end of outputLines to lineText
    end repeat
  end repeat
end tell
set AppleScript's text item delimiters to linefeed
return outputLines as text
end run
`;

  const { stdout } = await execFileAsync('osascript', [
    '-s',
    's',
    '-e',
    appleScript,
    toShortIsoDate(params.start),
    toShortIsoDate(params.end),
  ]);

  const events: SystemCalendarEvent[] = [];
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  lines.forEach((line, index) => {
    const [calendar, title, startRaw, endRaw, allDayRaw] = line.split('\t');
    const startEpoch = Number(startRaw);
    const endEpoch = Number(endRaw);
    if (!calendar || !title || !Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)) return;
    const start = new Date(startEpoch * 1000);
    const end = new Date(endEpoch * 1000);
    events.push({
      id: `mac-${index}-${startEpoch}-${endEpoch}`,
      calendar,
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: allDayRaw === 'true',
    });
  });

  return events;
}

export async function handleSystemCalendarRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname !== '/api/system-calendar/events' || req.method !== 'GET') {
    return false;
  }

  if (process.platform !== 'darwin') {
    sendJson(res, 200, { supported: false, authorized: false, events: [] });
    return true;
  }

  try {
    const { start, end } = parseMonthParam(url.searchParams.get('month'));
    const events = await readMacSystemCalendar({ start, end });
    sendJson(res, 200, { supported: true, authorized: true, events });
  } catch (error) {
    const permission = detectCalendarPermissionState(error);
    sendJson(res, 200, {
      supported: true,
      authorized: permission.authorized,
      events: [],
      error: permission.reason,
    });
  }
  return true;
}
