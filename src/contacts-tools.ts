import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { people_v1 } from 'googleapis';
import { callGmail } from './gmail.js';
import { workspaceFor, type WorkspaceContext } from './workspace.js';
import { account, register } from './register.js';

const MAX_RESULT_BYTES = 500_000;
const resourceName = z
  .string()
  .describe('Contact resource name, e.g. "people/c1234567890" (from contacts_list/contacts_search).');

// Field group -> the person-fields token the People API uses for read masks and
// updatePersonFields. Editable groups this server writes are the values here.
const READ_PERSON_FIELDS =
  'names,emailAddresses,phoneNumbers,organizations,biographies,userDefined,metadata,memberships';

async function callPeople<T>(
  ctx: WorkspaceContext,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return callGmail(ctx, operation, fn);
}

function bounded<T>(value: T, label: string): T {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > MAX_RESULT_BYTES) {
    throw new Error(
      `${label} exceeds ${Math.round(MAX_RESULT_BYTES / 1000)} KB; request a smaller page or fewer fields.`
    );
  }
  return value;
}

// Editable contact fields, shared by create and update. Each maps to one People
// API field group; update replaces the whole group it touches.
const editableFields = {
  givenName: z.string().optional().describe('First/given name.'),
  familyName: z.string().optional().describe('Last/family name.'),
  emailAddresses: z
    .array(z.string())
    .optional()
    .describe('Email addresses; replaces all existing emails on update.'),
  phoneNumbers: z
    .array(z.string())
    .optional()
    .describe('Phone numbers; replaces all existing phones on update.'),
  organization: z.string().optional().describe('Company / organization name.'),
  jobTitle: z.string().optional().describe('Job title within the organization.'),
  biography: z
    .string()
    .optional()
    .describe('Contact note / biography. Replaces the existing biography on update.'),
  userDefined: z
    .array(z.object({ key: z.string().min(1), value: z.string() }))
    .optional()
    .describe('Custom key/value data. Replaces all existing custom data on update.'),
};

/**
 * Builds a People API Person body from the flat editable args and reports which
 * field groups were touched (for updatePersonFields). Returns null groups so the
 * caller can decide create vs update semantics.
 */
function personFromArgs(args: any): { person: people_v1.Schema$Person; groups: string[] } {
  const person: people_v1.Schema$Person = {};
  const groups: string[] = [];
  if (args.givenName !== undefined || args.familyName !== undefined) {
    person.names = [
      {
        ...(args.givenName !== undefined ? { givenName: args.givenName } : {}),
        ...(args.familyName !== undefined ? { familyName: args.familyName } : {}),
      },
    ];
    groups.push('names');
  }
  if (args.emailAddresses !== undefined) {
    person.emailAddresses = args.emailAddresses.map((value: string) => ({ value }));
    groups.push('emailAddresses');
  }
  if (args.phoneNumbers !== undefined) {
    person.phoneNumbers = args.phoneNumbers.map((value: string) => ({ value }));
    groups.push('phoneNumbers');
  }
  if (args.organization !== undefined || args.jobTitle !== undefined) {
    person.organizations = [
      {
        ...(args.organization !== undefined ? { name: args.organization } : {}),
        ...(args.jobTitle !== undefined ? { title: args.jobTitle } : {}),
      },
    ];
    groups.push('organizations');
  }
  if (args.biography !== undefined) {
    person.biographies = [{ value: args.biography }];
    groups.push('biographies');
  }
  if (args.userDefined !== undefined) {
    // Google rejects userDefined entries whose value is an empty string with a
    // generic INVALID_ARGUMENT response. Empty values are not meaningful
    // custom fields; omit them. Callers that need to remove the whole group
    // should use clear: ["userDefined"] instead.
    person.userDefined = args.userDefined.filter(
      (entry: { key: string; value: string }) => entry.value.length > 0
    );
    groups.push('userDefined');
  }
  return { person, groups };
}

// User-facing clearable field name -> the People API field group emptied on clear.
// Clearing sends an empty group in updatePersonFields, which removes it with no
// replacement. (emailAddresses/phoneNumbers/userDefined can also be cleared by
// passing an empty array; organization and biography have no such value form.)
const CLEARABLE_GROUPS: Record<string, string> = {
  organization: 'organizations',
  emailAddresses: 'emailAddresses',
  phoneNumbers: 'phoneNumbers',
  biography: 'biographies',
  userDefined: 'userDefined',
};

export function registerContactsTools(server: McpServer): void {
  register(
    server,
    'contacts_list',
    'List the account\'s Google Contacts (people/me connections) with names, emails, phones, and organizations.',
    {
      account,
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callPeople(ctx, 'list contacts', () =>
        ctx.people.people.connections.list({
          resourceName: 'people/me',
          personFields: READ_PERSON_FIELDS,
          pageSize: args.pageSize ?? 100,
          pageToken: args.pageToken,
          sortOrder: 'LAST_MODIFIED_DESCENDING',
        })
      );
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          totalPeople: result.data.totalPeople,
          nextPageToken: result.data.nextPageToken,
          connections: result.data.connections ?? [],
        },
        'Contacts page'
      );
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'contacts_search',
    'Search the account\'s Google Contacts by name, email, or phone. Note: the People API primes its search cache on first use, so a query run seconds after auth can return empty — retry shortly.',
    {
      account,
      query: z.string().describe('Search text matched against names, emails, and phone numbers.'),
      pageSize: z.number().int().min(1).max(30).optional(),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callPeople(ctx, 'search contacts', () =>
        ctx.people.people.searchContacts({
          query: args.query,
          readMask: READ_PERSON_FIELDS,
          pageSize: args.pageSize ?? 25,
        })
      );
      return bounded(
        {
          account: ctx.alias,
          email: ctx.email,
          results: (result.data.results ?? []).map((r) => r.person),
        },
        'Contacts search'
      );
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'contacts_get',
    'Get one Google Contact by resource name, including its etag (required by contacts_update).',
    { account, resourceName },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const result = await callPeople(ctx, 'get contact', () =>
        ctx.people.people.get({
          resourceName: args.resourceName,
          personFields: READ_PERSON_FIELDS,
        })
      );
      return { account: ctx.alias, email: ctx.email, contact: result.data };
    },
    { readOnlyHint: true }
  );

  register(
    server,
    'contacts_create',
    'Create a new Google Contact. Requires Google Contacts write scope.',
    {
      account,
      ...editableFields,
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const { person, groups } = personFromArgs(args);
      if (groups.length === 0) {
        throw new Error('Provide at least one field (e.g. givenName, emailAddresses) to create a contact.');
      }
      const result = await callPeople(ctx, 'create contact', () =>
        ctx.people.people.createContact({
          personFields: READ_PERSON_FIELDS,
          requestBody: person,
        })
      );
      return { account: ctx.alias, email: ctx.email, contact: result.data };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  );

  register(
    server,
    'contacts_update',
    'Update fields on an existing Google Contact. Each provided field group (names, emails, phones, organization, biography, userDefined) replaces the existing group; list a field in `clear` to remove it entirely with no replacement. Requires the current etag from contacts_get/contacts_list, and Google Contacts write scope.',
    {
      account,
      resourceName,
      etag: z
        .string()
        .describe('Current etag of the contact (from contacts_get/contacts_list) for optimistic concurrency.'),
      ...editableFields,
      clear: z
        .array(z.enum(['organization', 'emailAddresses', 'phoneNumbers', 'biography', 'userDefined']))
        .optional()
        .describe('Field groups to remove entirely, with no replacement — e.g. ["organization"] clears the company and its job title. Do not also pass a value for a field you are clearing.'),
    },
    async (args) => {
      const ctx = workspaceFor(args.account);
      const { person, groups } = personFromArgs(args);
      for (const name of args.clear ?? []) {
        const group = CLEARABLE_GROUPS[name];
        if (groups.includes(group)) {
          throw new Error(`Cannot both set and clear "${name}" in one update.`);
        }
        (person as any)[group] = [];
        groups.push(group);
      }
      if (groups.length === 0) {
        throw new Error('Provide at least one field to update or clear (e.g. givenName, or clear: ["organization"]).');
      }
      const result = await callPeople(ctx, 'update contact', () =>
        ctx.people.people.updateContact({
          resourceName: args.resourceName,
          updatePersonFields: groups.join(','),
          personFields: READ_PERSON_FIELDS,
          requestBody: { etag: args.etag, ...person },
        })
      );
      return { account: ctx.alias, email: ctx.email, contact: result.data };
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  );

  register(
    server,
    'contacts_delete',
    'Permanently delete a Google Contact. This is NOT recoverable — the contact is not moved to a trash. Requires Google Contacts write scope.',
    { account, resourceName },
    async (args) => {
      const ctx = workspaceFor(args.account);
      await callPeople(ctx, 'delete contact', () =>
        ctx.people.people.deleteContact({ resourceName: args.resourceName })
      );
      return { account: ctx.alias, email: ctx.email, resourceName: args.resourceName, deleted: true };
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  );
}
