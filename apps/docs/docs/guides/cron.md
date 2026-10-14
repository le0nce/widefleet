---
title: Cron schedules
description: Run app code on a schedule, check its run history and start a schedule on demand.
lastModified: 2026-10-13
---

Cron schedules call your app's `scheduled` handler at fixed times. Widefleet checks
every expression when you deploy, records each run and lets you start a declared
schedule immediately to test it.

Run history and starting a run on demand require CLI, management and deployment
agent 0.4.0 or newer and app runtime 0.3.0 or newer. An administrator selects the
runtime with `widefleet runtime update 0.3.0`; confirm it with
`widefleet runtime status`.

## Declare a schedule

Add `triggers.crons` to the app's Wrangler configuration:

```jsonc
{
  "name": "example",
  "main": "worker.ts",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "public", "binding": "ASSETS" },
  "triggers": { "crons": ["*/15 * * * *", "0 6 * * 2-6"] },
}
```

Export a `scheduled` handler from the main module alongside the app's HTTP handler:

```ts
type Environment = { DB: D1Database };

export default {
  async fetch(request: Request, environment: Environment) {
    return new Response("ok");
  },
  async scheduled(
    controller: ScheduledController,
    environment: Environment,
    context: ExecutionContext,
  ) {
    if (controller.cron === "0 6 * * 2-6") {
      context.waitUntil(
        environment.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run(),
      );
    }
  },
};
```

`controller.cron` contains the expression that fired. `controller.scheduledTime` is
the occurrence in milliseconds, not the start of the attempt. A retry and a late run
report the same occurrence. Work passed to `context.waitUntil()` is part of the run.

Deploy the app with `widefleet deploy`. The schedules of the active deployment are
the ones that run; a preview runs the schedules it declares.

## Write expressions

An expression has five fields: minute, hour, day of month, month and day of week.
Times are in UTC with one-minute resolution. Each field accepts `*`, a value, an
`a-b` range, an `a,b` list and a `/n` step. Months and weekdays also accept
three-letter names such as `JAN` and `MON`.

**Weekdays are numbered 1 to 7 from Sunday.** `0 6 * * 2-6` runs Monday to Friday;
`0 6 * * 1-5` runs Sunday to Thursday. Use names, such as `MON-FRI`, to avoid this
mistake.

The day fields also accept these forms:

| Form                  | Meaning                                                 |
| --------------------- | ------------------------------------------------------- |
| `L` (day of month)    | Last day of the month                                   |
| `L-3` (day of month)  | Three days before the last day                          |
| `LW` / `15W`          | Last weekday of the month / weekday closest to the 15th |
| `FRIL` (day of week)  | Last Friday of the month                                |
| `MON#2` (day of week) | Second Monday of the month                              |

When both day fields are restricted, a day matches either one: `0 0 1 * MON` runs on
the first of each month and on every Monday.

An invalid expression fails that deployment before anything is activated; the
serving version and other apps' schedules keep running. The deployment message names
the expression and the field, for example
`cron expression "*/60 * * * *": minute field has a step 60 outside 1-59 in "*/60"`.
Read it with `widefleet history APP_UUID` or in the app's **Deployments** tab.
Descending ranges such as `SAT-SUN`, `*` inside a list and steps wider than their
field are rejected. Leading and trailing spaces are removed.

## How scheduled runs behave

- **One occurrence at a time.** Scheduled runs for all apps in an installation share
  one runtime schedule and run one after another. A long handler delays the next
  occurrence, including other apps' schedules. Move long work into a
  [Queue](/reference/runtime) consumer or a [Workflow](/guides/workflows).
- **Retries.** A handler that throws, or whose `waitUntil` work fails, is retried after
  4 seconds with doubling delays. Retries stop after six failures or when the next
  occurrence is due. Call `controller.noRetry()` to stop retrying.
- **Missed occurrences.** After runtime downtime, one missed occurrence runs and the
  rest are skipped. To catch up, compare `controller.scheduledTime` with the last
  occurrence your app recorded.
- **Shared expressions.** Apps that declare the same expression run together. A retry
  calls each of those apps again, so make handlers safe to repeat.

## Check run history

Open the app in management and select **Cron**. The tab lists the active deployment's
schedules with their latest run and the 20 most recent runs, newest first, with start
time, duration and any error message.

From the app's project directory, use the CLI:

```sh
widefleet crons list
widefleet crons runs
widefleet crons runs --cron "0 6 * * 2-6" --limit 5
```

Commands print JSON. Each run has a `status` of `running`, `succeeded` or `failed`, a
`trigger` of `schedule` or `manual`, and an `error` for failed runs. Each retry is a
separate run. Outside the project, add `--app APP_UUID`.

Widefleet keeps the latest 100 runs per app. The runtime reports runs to management;
if management is unavailable, schedules still run but those runs are missing from
the history. A run interrupted by a runtime restart can remain `running`.

## Start a schedule now

Select **Run now** next to a schedule, or use the CLI:

```sh
widefleet crons run "0 6 * * 2-6"
widefleet crons runs --cron "0 6 * * 2-6" --limit 1
```

The command waits until the deployment agent has started the run, then prints the
operation. The run's result appears in the history with the trigger `manual`. Use
`--no-wait` to return the queued operation and `widefleet crons operation
OPERATION_UUID` to check it later.

A manual run calls the same `scheduled` handler with the current time as
`scheduledTime`. It is not retried and can overlap a scheduled run, so the handler
must tolerate concurrent calls. Only schedules declared by the active deployment can
be started, and management write access to the app is required.

Manual runs queue behind other deployment work for the installation, so they can
wait while deployments are in progress.

## Troubleshooting

| Symptom                                                                       | Resolution                                                                                                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment fails with `cron expression …`                                     | Fix the named field and deploy again. Check the weekday numbering above.                                                               |
| Schedules run but no history appears                                          | Deploy the app again. Apps deployed before the upgrade receive their report credentials with the next deployment or permission change. |
| `Install an app runtime with Cron support before running schedules on demand` | Ask an administrator to update the app runtime to 0.3.0 or newer.                                                                      |
| `Upgrade the deployment agent to run Cron schedules on demand`                | Ask an administrator to upgrade the deployment agent to the management version.                                                        |
| A run failed with `The app has no scheduled handler`                          | Export `scheduled` from the configured main module, then deploy again.                                                                 |
| A run is listed as failed but `widefleet logs` shows nothing                  | Console output from scheduled runs is not captured in app logs. Catch errors in the handler and include context in the thrown message. |

## Next steps

- Use [Workflows](/guides/workflows) for multi-step work that must survive restarts.
- See [configuration](/reference/configuration) for other Wrangler fields and
  [runtime compatibility](/reference/runtime-compatibility) for differences from
  Cloudflare Cron Triggers.
