<script lang="ts">
  import { onMount } from "svelte";
  import type { cronOperation, cronRun } from "@platform/contracts";
  import type { z } from "zod";
  import { getCronOperation, getCronRuns, getCronSchedules, runCron } from "#lib/crons.remote";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import CalendarClock from "@lucide/svelte/icons/calendar-clock";
  import Play from "@lucide/svelte/icons/play";
  import CronRunStatus from "./CronRunStatus.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Feedback from "./Feedback.svelte";

  let { appId, published }: { appId: string; published: boolean } = $props();

  const schedules = $derived(await getCronSchedules({ appId }));

  const runs = $derived(await getCronRuns({ appId, limit: 20 }));

  // Manual runs per schedule: the accepted operation, or the request awaiting confirmation.
  const requests = $state<
    Record<
      string,
      {
        requestId: string;
        pending: boolean;
        operation: z.infer<typeof cronOperation> | null;
        error: string;
      }
    >
  >({});

  const dates = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });

  const duration = (run: z.infer<typeof cronRun>) => {
    if (!run.finishedAt) return null;
    const milliseconds = Date.parse(run.finishedAt) - Date.parse(run.startedAt);

    return milliseconds < 1000
      ? `${milliseconds} ms`
      : `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} s`;
  };

  const active = (cron: string) => {
    const request = requests[cron];

    return Boolean(
      request?.pending ||
      request?.operation?.state === "queued" ||
      request?.operation?.state === "running",
    );
  };

  const start = async (cron: string) => {
    requests[cron] ??= {
      requestId: crypto.randomUUID(),
      pending: false,
      operation: null,
      error: "",
    };
    const request = requests[cron];

    if (!request || active(cron)) return;
    request.pending = true;
    request.error = "";

    try {
      request.operation = await runCron({ appId, requestId: request.requestId, cron });
      // Accepted: a later click starts a new run instead of re-reading this one.
      request.requestId = crypto.randomUUID();
    } catch (error) {
      // The same request ID is reused, so retrying cannot start a second run.
      request.error = error instanceof Error ? error.message : "The run could not be requested.";
    } finally {
      request.pending = false;
    }
  };

  onMount(() => {
    let disposed = false;
    let refreshing = false;

    const refresh = async () => {
      if (refreshing || document.visibilityState !== "visible") return;
      refreshing = true;

      try {
        for (const [cron, request] of Object.entries(requests)) {
          const current = request.operation;

          if (!current || (current.state !== "queued" && current.state !== "running")) continue;
          const query = getCronOperation({ appId, jobId: current.id });
          await query.refresh();
          const updated = await query;

          if (!disposed && requests[cron]?.operation?.id === updated.id)
            requests[cron].operation = updated;
        }

        await Promise.all([
          getCronSchedules({ appId }).refresh(),
          getCronRuns({ appId, limit: 20 }).refresh(),
        ]);
      } catch {
        // Queries keep their last confirmed result and expose the failure on the next render.
      } finally {
        refreshing = false;
      }
    };

    const timer = setInterval(() => void refresh(), 3000);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  });
</script>

<section aria-labelledby="crons-heading" class="space-y-8">
  <div>
    <h2 id="crons-heading" class="text-base font-semibold">Cron schedules</h2>
    <p class="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
      Schedules from the current deployment call your app's <code>scheduled</code> handler. Times are
      in UTC. Running a schedule now uses the same handler, so its result appears in the history below.
    </p>
  </div>
  {#if schedules.length === 0}
    <div class="rounded-xl border">
      <EmptyState
        title="No Cron schedules"
        description="Declare triggers.crons in your app's Wrangler configuration and deploy it to run work on a schedule."
        >{#snippet icon()}<CalendarClock />{/snippet}</EmptyState
      >
    </div>
  {:else}
    <ul class="divide-y rounded-xl border">
      {#each schedules as schedule (schedule.cron)}
        {@const request = requests[schedule.cron]}
        <li class="space-y-3 p-5 sm:p-6">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="min-w-0 space-y-1.5">
              <code class="text-sm font-medium wrap-anywhere">{schedule.cron}</code>
              <p class="text-muted-foreground text-xs">
                {#if schedule.lastRun}Last run
                  <time datetime={schedule.lastRun.startedAt}
                    >{dates.format(new Date(schedule.lastRun.startedAt))} UTC</time
                  >
                  · <CronRunStatus status={schedule.lastRun.status} compact />
                {:else}No recorded runs yet{/if}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={!published || active(schedule.cron)}
              onclick={() => start(schedule.cron)}
              ><Play />{active(schedule.cron) ? "Starting …" : "Run now"}</Button
            >
          </div>
          {#if request?.error}<Feedback kind="error">{request.error}</Feedback>{/if}
          {#if request?.operation}
            <Feedback
              kind={request.operation.state === "failed"
                ? "error"
                : request.operation.state === "succeeded"
                  ? "success"
                  : "info"}
              >{request.operation.state === "queued"
                ? "Requested — waiting for the agent."
                : request.operation.state === "running"
                  ? "The agent is starting the run."
                  : request.operation.state === "failed"
                    ? (request.operation.message ?? "The run could not be started.")
                    : "Run started. Its result appears in the history."}</Feedback
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <div>
    <h3 class="text-sm font-semibold">Recent runs</h3>
    <p class="text-muted-foreground mt-1 text-xs leading-5">
      The latest 100 runs are kept. Each retry of a failed run is listed separately.
    </p>
    {#if runs.length === 0}
      <p class="text-muted-foreground mt-4 text-sm">
        No runs have been reported yet. Runs appear after the runtime reports them; apps deployed
        before Cron reporting was available report runs after their next deployment.
      </p>
    {:else}
      <ol class="mt-4 divide-y rounded-xl border">
        {#each runs as run (run.id)}
          <li class="space-y-2 p-4 sm:px-6">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-3">
                <CronRunStatus status={run.status} />
                <code class="text-muted-foreground text-xs wrap-anywhere">{run.cron}</code>
                {#if run.trigger === "manual"}<Badge variant="secondary" class="font-normal"
                    >Manual</Badge
                  >{/if}
              </div>
              <p class="text-muted-foreground text-xs">
                <time datetime={run.startedAt}>{dates.format(new Date(run.startedAt))} UTC</time
                >{#if duration(run)}&nbsp;· {duration(run)}{/if}
              </p>
            </div>
            {#if run.error}<div
                class="bg-destructive/5 text-destructive rounded-lg px-3 py-2 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap"
              >
                {run.error}
              </div>{/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</section>
