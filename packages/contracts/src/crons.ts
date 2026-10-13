import { z } from "zod";

// celld 0.6.2 parses Cloudflare's cron dialect and rejects a malformed
// expression only when the shared fleet is reloaded. Mirroring its parser here
// reports the mistake when the deployment is created, before it can block
// activation for every app in the fleet. Keep this in sync with the pinned
// celld version's crates/logic/cron.rs.

type Field = { name: string; min: number; max: number; names: readonly string[] };

const minute: Field = { name: "minute", min: 0, max: 59, names: [] };

const hour: Field = { name: "hour", min: 0, max: 23, names: [] };

const dayOfMonth: Field = { name: "day of month", min: 1, max: 31, names: [] };

const month: Field = {
  name: "month",
  min: 1,
  max: 12,
  names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
};

// Cloudflare numbers weekdays 1 to 7 from Sunday.
const dayOfWeek: Field = {
  name: "day of week",
  min: 1,
  max: 7,
  names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
};

const digits = (text: string) => (/^[0-9]+$/.test(text) ? Number(text) : null);

const value = (text: string, field: Field) => {
  const trimmed = text.trim();
  const named = field.names.indexOf(trimmed.toLowerCase());

  if (named !== -1) return field.min + named;
  const number = digits(trimmed);

  if (number === null)
    throw new Error(
      field.names.length
        ? `${field.name} field has a value ${JSON.stringify(trimmed)} that is neither a number nor a name`
        : `${field.name} field has a non-numeric value ${JSON.stringify(trimmed)}`,
    );

  if (number < field.min || number > field.max)
    throw new Error(`${field.name} field has ${number} outside ${field.min}-${field.max}`);

  return number;
};

const item = (text: string, field: Field) => {
  const [spec = "", step, ...rest] = text.split("/");

  const interval = step === undefined ? 1 : rest.length ? null : digits(step);

  if (interval === null)
    throw new Error(`${field.name} field has a non-numeric step in ${JSON.stringify(text)}`);

  if (interval === 0 || interval > field.max - field.min)
    throw new Error(
      `${field.name} field has a step ${interval} outside 1-${field.max - field.min} in ${JSON.stringify(text)}`,
    );

  const range = spec.split("-");

  const [first, last] =
    spec === "*"
      ? [field.min, field.max]
      : range.length > 1
        ? [value(range[0] ?? "", field), value(range.slice(1).join("-"), field)]
        : [value(spec, field), interval === 1 ? value(spec, field) : field.max];

  if (first > last)
    throw new Error(
      `${field.name} field has a descending range in ${JSON.stringify(text)}; celld does not wrap a range around the end of a field`,
    );
};

const list = (text: string, field: Field) => {
  if (!text) throw new Error(`${field.name} field is empty`);
  const items = text.split(",");

  for (const entry of items) {
    if (items.length > 1 && entry.trim() === "*")
      throw new Error(
        `${field.name} field has a \`*\` inside a list in ${JSON.stringify(text)}; write \`*\` alone, or list the values`,
      );
    item(entry, field);
  }
};

const daysOfMonth = (text: string) => {
  if (text === "*") return;

  if (text.startsWith("L")) {
    const rest = text.slice(1);

    if (rest === "" || rest === "W") return;
    const offsetText = rest.endsWith("W") ? rest.slice(0, -1) : rest;

    if (!offsetText.startsWith("-"))
      throw new Error(`day of month field has an unreadable \`L\` form in ${JSON.stringify(text)}`);
    const offset = digits(offsetText.slice(1));

    if (offset === null)
      throw new Error(
        `day of month field has a non-numeric \`L\` offset in ${JSON.stringify(text)}`,
      );

    if (offset < 1 || offset > 30)
      throw new Error(`day of month field has an \`L\` offset ${offset} outside 1-30`);

    return;
  }

  if (text.endsWith("W")) {
    value(text.slice(0, -1), dayOfMonth);

    return;
  }

  list(text, dayOfMonth);
};

const daysOfWeek = (text: string) => {
  if (text === "*" || text === "L") return;

  if (text.endsWith("L")) {
    value(text.slice(0, -1), dayOfWeek);

    return;
  }

  const hash = text.indexOf("#");

  if (hash !== -1) {
    value(text.slice(0, hash), dayOfWeek);
    const nth = digits(text.slice(hash + 1));

    if (nth === null)
      throw new Error(`day of week field has a non-numeric \`#\` count in ${JSON.stringify(text)}`);

    if (nth < 1 || nth > 5)
      throw new Error(`day of week field has a \`#\` count ${nth} outside 1-5`);

    return;
  }

  list(text, dayOfWeek);
};

const check = (expression: string) => {
  const fields = expression.split(/\s+/).filter(Boolean);

  if (fields.length !== 5)
    throw new Error(
      `expected 5 fields (minute hour day-of-month month day-of-week), found ${fields.length}`,
    );
  const [minutes = "", hours = "", days = "", months = "", weekdays = ""] = fields;

  list(minutes, minute);
  list(hours, hour);
  daysOfMonth(days);
  list(months, month);
  daysOfWeek(weekdays);
};

export const cronExpression = z.string().superRefine((expression, context) => {
  // celld reports the trimmed text to the scheduled handler, while the runtime
  // routes each occurrence by the declared text.
  if (expression !== expression.trim()) {
    context.addIssue({
      code: "custom",
      message: `Cron expression ${JSON.stringify(expression)} has leading or trailing whitespace`,
    });

    return;
  }

  try {
    check(expression);
  } catch (cause) {
    context.addIssue({
      code: "custom",
      message: `Cron expression ${JSON.stringify(expression)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
});

export const cronRunTrigger = z.enum(["schedule", "manual"]);

// The trusted runtime loader sends the same complete record when a run starts
// and when it finishes, so a lost or reordered start report is harmless.
export const cronRunReport = z.strictObject({
  id: z.uuid(),
  deploymentId: z.uuid(),
  cron: z.string().min(1).max(256),
  trigger: cronRunTrigger,
  scheduledAt: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  error: z.string().max(4096).nullable(),
});

export const cronRun = cronRunReport.omit({ finishedAt: true, error: true }).extend({
  status: z.enum(["running", "succeeded", "failed"]),
  finishedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});

export const cronSchedule = z.strictObject({
  cron: z.string(),
  lastRun: cronRun.nullable(),
});

export const cronRunRequest = z.strictObject({ cron: z.string().min(1).max(256) });

export const cronRunsQuery = z.strictObject({
  cron: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const cronOperation = z.strictObject({
  id: z.uuid(),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  message: z.string().nullable(),
});

export const cronReportCredentials = z.strictObject({ token: z.string().min(1) });

// Stored per app rather than in immutable version snapshots: loaders without
// Cron support reject unknown snapshot fields, and runtime rollback must stay possible.
export const cronReportDestination = z.strictObject({ url: z.url(), token: z.string().min(1) });

export const cronReportKey = (appId: string) => `apps/${appId}/cron-reports.json`;
