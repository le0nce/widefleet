import { createHmac, timingSafeEqual } from "node:crypto";
import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, desc, eq, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { managedApp } from "./apps.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, artifacts, cronRuns, deployments, jobs } from "./schema.ts";
import { transact, type Transaction } from "./transactions.ts";
import { readBody } from "./upload-body.ts";

const retainedRuns = 100;

const present = (run: typeof cronRuns.$inferSelect) =>
  contract.cronRun.parse({
    id: run.id,
    deploymentId: run.deploymentId,
    cron: run.cron,
    trigger: run.trigger,
    status: run.finishedAt === null ? "running" : run.error === null ? "succeeded" : "failed",
    scheduledAt: run.scheduledAt.toISOString(),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    error: run.error,
  });

const operation = (job: Pick<typeof jobs.$inferSelect, "id" | "state" | "result">) =>
  contract.cronOperation.parse({
    id: job.id,
    state: job.state,
    // Results are agent completions or a claim-time refusal without a lease.
    message:
      job.result === null ? null : z.object({ message: z.string() }).parse(job.result).message,
  });

const declaredCrons = async (transaction: Transaction, deploymentId: string | null) => {
  if (!deploymentId) return [];

  const [active] = await transaction
    .select({ metadata: artifacts.metadata })
    .from(deployments)
    .innerJoin(artifacts, eq(artifacts.id, deployments.artifactId))
    .where(eq(deployments.id, deploymentId));

  return active ? contract.workerMetadata.parse(active.metadata).crons : [];
};

export const createCronService = (database: Database, configuration: Configuration) => {
  const signature = (appId: string) =>
    createHmac("sha256", z.string().min(32).parse(configuration.BETTER_AUTH_SECRET))
      .update(`widefleet-crons-v1:report:${appId}`)
      .digest("hex");

  return {
    credentials: (appId: string) =>
      contract.cronReportCredentials.parse({ token: `cron_${signature(appId)}` }),
    schedules: (principal: Principal, appId: string) =>
      transact(database, async (transaction) => {
        const access = await managedApp(transaction, principal, appId);

        if (access.isErr()) return access;

        const crons = await declaredCrons(transaction, access.value.activeDeploymentId);

        const schedules = [];

        for (const cron of new Set(crons)) {
          const [last] = await transaction
            .select()
            .from(cronRuns)
            .where(and(eq(cronRuns.appId, appId), eq(cronRuns.cron, cron)))
            .orderBy(desc(cronRuns.startedAt))
            .limit(1);

          schedules.push(
            contract.cronSchedule.parse({ cron, lastRun: last ? present(last) : null }),
          );
        }

        return Result.ok(schedules);
      }),
    runs: (principal: Principal, appId: string, query: z.input<typeof contract.cronRunsQuery>) =>
      transact(database, async (transaction) => {
        const access = await managedApp(transaction, principal, appId);

        if (access.isErr()) return access;
        const { cron, limit } = contract.cronRunsQuery.parse(query);

        const rows = await transaction
          .select()
          .from(cronRuns)
          .where(
            and(
              eq(cronRuns.appId, appId),
              cron === undefined ? undefined : eq(cronRuns.cron, cron),
            ),
          )
          .orderBy(desc(cronRuns.startedAt))
          .limit(limit);

        return Result.ok(rows.map(present));
      }),
    run: (
      principal: Principal,
      appId: string,
      requestId: string,
      input: z.infer<typeof contract.cronRunRequest>,
    ) =>
      transact(database, async (transaction) => {
        const access = await managedApp(transaction, principal, appId);

        if (access.isErr()) return access;
        const request = contract.cronRunRequest.parse(input);
        const [existing] = await transaction.select().from(jobs).where(eq(jobs.id, requestId));

        if (existing) {
          if (
            existing.appId !== appId ||
            existing.kind !== "crons" ||
            existing.cron !== request.cron
          )
            return Result.err(
              new InvalidOperation({
                code: "CONFLICT",
                message: "This request ID already refers to another operation",
              }),
            );

          return Result.ok(operation(existing));
        }

        if (access.value.state === "deleting" || !access.value.activeDeploymentId)
          return Result.err(
            new InvalidOperation({
              code: "CONFLICT",
              message: "The app must be published and not being deleted",
            }),
          );

        if (
          !(await declaredCrons(transaction, access.value.activeDeploymentId)).includes(
            request.cron,
          )
        )
          return Result.err(
            new InvalidOperation({
              code: "NOT_FOUND",
              message: "The published app does not declare this Cron schedule",
            }),
          );

        const [created] = await transaction
          .insert(jobs)
          .values({
            id: requestId,
            fleetId: access.value.fleetId,
            appId,
            kind: "crons",
            cron: request.cron,
          })
          .onConflictDoNothing()
          .returning();

        if (!created)
          return Result.err(
            new InvalidOperation({
              code: "CONFLICT",
              message: "This request ID already refers to another operation",
            }),
          );

        return Result.ok(operation(created));
      }),
    operation: (principal: Principal, appId: string, jobId: string) =>
      transact(database, async (transaction) => {
        const access = await managedApp(transaction, principal, appId);

        if (access.isErr()) return access;

        const [job] = await transaction
          .select()
          .from(jobs)
          .where(and(eq(jobs.id, jobId), eq(jobs.appId, appId), eq(jobs.kind, "crons")));

        if (!job)
          return Result.err(
            new InvalidOperation({ code: "NOT_FOUND", message: "Cron operation not found" }),
          );

        return Result.ok(operation(job));
      }),
    // Reports come from the trusted runtime loader, never from app code. Their
    // credential is scoped to one app, so a report cannot describe another app.
    ingest: async (request: Request, appId: string) => {
      const expected = `cron_${signature(appId)}`;
      const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

      if (
        !/^cron_[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      )
        return new Response("Invalid Cron report credentials", { status: 401 });

      if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
        return new Response("Expected a JSON Cron run report", { status: 415 });

      const body = await readBody(request, 16 * 1024);

      if (body.isErr()) return new Response("Cron run report exceeds the limit", { status: 413 });

      let report;

      try {
        report = contract.cronRunReport.parse(JSON.parse(new TextDecoder().decode(body.value)));
      } catch {
        return new Response("Invalid Cron run report", { status: 400 });
      }

      const stored = await transact(database, async (transaction) => {
        const [app] = await transaction
          .select({ id: apps.id })
          .from(apps)
          .where(and(eq(apps.id, appId), ne(apps.state, "deleting")))
          .for("update");

        if (!app) return Result.ok(false);

        const finished = report.finishedAt ? new Date(report.finishedAt) : null;

        await transaction
          .insert(cronRuns)
          .values({
            id: report.id,
            appId,
            deploymentId: report.deploymentId,
            cron: report.cron,
            trigger: report.trigger,
            scheduledAt: new Date(report.scheduledAt),
            startedAt: new Date(report.startedAt),
            finishedAt: finished,
            error: report.error,
          })
          .onConflictDoUpdate({
            target: cronRuns.id,
            set: { finishedAt: finished, error: report.error },
            // A late start report must not reopen a finished run.
            setWhere: sql`${cronRuns.appId} = ${appId} AND ${cronRuns.finishedAt} IS NULL AND excluded.finished_at IS NOT NULL`,
          });

        const kept = transaction
          .select({ id: cronRuns.id })
          .from(cronRuns)
          .where(eq(cronRuns.appId, appId))
          .orderBy(desc(cronRuns.startedAt))
          .limit(retainedRuns);

        await transaction
          .delete(cronRuns)
          .where(and(eq(cronRuns.appId, appId), notInArray(cronRuns.id, kept)));

        return Result.ok(true);
      });

      if (stored.isErr()) {
        console.error("Cron run report failed", stored.error);

        return new Response("Cron run report could not be stored", { status: 503 });
      }

      return stored.value
        ? new Response(null, { status: 204 })
        : new Response("Cron report source is unavailable", { status: 403 });
    },
  };
};
