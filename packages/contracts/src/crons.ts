import { z } from "zod";

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
