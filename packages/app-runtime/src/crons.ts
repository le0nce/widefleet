import { cronReportDestination, cronReportKey, type cronRunReport } from "@platform/contracts";
import type { z } from "zod";
import type { ParentEnvironment, PublishedApp } from "./types.ts";

type Report = z.infer<typeof cronRunReport>;

type Destination = z.infer<typeof cronReportDestination>;

const destination = async (environment: ParentEnvironment, app: PublishedApp) => {
  try {
    const object = await environment.WIDEFLEET_PACKAGES.get(cronReportKey(app.appId));

    return object ? cronReportDestination.parse(await object.json()) : null;
  } catch (cause) {
    console.error("Cron report destination is unreadable", cause);

    return null;
  }
};

// Reports are best effort: management being unavailable must never change
// whether, or how often, an app's scheduled handler runs.
const report = async (target: Destination | null, run: Report) => {
  if (!target) return;

  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(run),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });

    await response.body?.cancel();

    if (!response.ok) console.error(`Cron run report was rejected (${response.status})`);
  } catch (cause) {
    console.error("Cron run report failed", cause);
  }
};

export const deliverCron = async (
  app: PublishedApp,
  environment: ParentEnvironment,
  run: Pick<Report, "id" | "cron" | "trigger"> & { scheduledTime: number },
  execute: () => Promise<{ error: string | null; noRetry: boolean }>,
) => {
  const target = await destination(environment, app);

  const started: Report = {
    id: run.id,
    deploymentId: app.deploymentId,
    cron: run.cron,
    trigger: run.trigger,
    scheduledAt: new Date(run.scheduledTime).toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  const reported = report(target, started);
  let result;

  try {
    result = await execute();
  } catch (cause) {
    result = { error: String(cause), noRetry: false };
  }

  await reported;
  await report(target, {
    ...started,
    finishedAt: new Date().toISOString(),
    error: result.error?.slice(0, 4096) ?? null,
  });

  return result;
};
