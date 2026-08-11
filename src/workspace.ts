import {
  google,
  calendar_v3,
  chat_v1,
  docs_v1,
  drive_v3,
  driveactivity_v2,
  people_v1,
  sheets_v4,
} from 'googleapis';
import { getClient, resolveAccount } from './accounts.js';

export interface WorkspaceContext {
  alias: string;
  email: string;
  calendar: calendar_v3.Calendar;
  chat: chat_v1.Chat;
  docs: docs_v1.Docs;
  drive: drive_v3.Drive;
  driveActivity: driveactivity_v2.Driveactivity;
  people: people_v1.People;
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
    driveActivity: google.driveactivity({ version: 'v2', auth }),
    people: google.people({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  };
}
