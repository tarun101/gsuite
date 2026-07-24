import { google, calendar_v3, chat_v1, docs_v1, drive_v3, sheets_v4 } from 'googleapis';
import { getClient, resolveAccount } from './accounts.js';

export interface WorkspaceContext {
  alias: string;
  email: string;
  calendar: calendar_v3.Calendar;
  chat: chat_v1.Chat;
  docs: docs_v1.Docs;
  drive: drive_v3.Drive;
  sheets: sheets_v4.Sheets;
}

export function workspaceFor(accountParam: string): WorkspaceContext {
  const { alias, entry } = resolveAccount(accountParam);
  const auth = getClient(alias, entry);
  return {
    alias,
    email: entry.email,
    calendar: google.calendar({ version: 'v3', auth }),
    chat: google.chat({ version: 'v1', auth }),
    docs: google.docs({ version: 'v1', auth }),
    drive: google.drive({ version: 'v3', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  };
}
