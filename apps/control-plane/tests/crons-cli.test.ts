import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")("Cron CLI", () => {
  const appId = "00000000-0000-4000-8000-000000000001";

  const requests: { method: string; path: string; key: string; body: string }[] = [];

  let origin: string;
  let operationId: string;
  let failed = false;

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
        key: z.string().optional().parse(request.headers["idempotency-key"]) ?? "",
      });
      response.setHeader("content-type", "application/json");
      const path = new URL(request.url ?? "/", "http://cli.fixture").pathname;

      if (request.method === "POST" && path === `/api/v1/apps/${appId}/crons/runs`) {
        operationId = z.uuid().parse(request.headers["idempotency-key"]);
        response.end(JSON.stringify({ id: operationId, state: "queued", message: null }));
      } else if (path === `/api/v1/apps/${appId}/crons/operations/${operationId}`) {
        response.end(
          JSON.stringify({
            id: operationId,
            state: failed ? "failed" : "succeeded",
            message: failed ? "Install an app runtime with Cron support" : null,
          }),
        );
      } else if (request.method === "GET" && path === `/api/v1/apps/${appId}/crons/runs`)
        response.end("[]");
      else if (request.method === "GET" && path === `/api/v1/apps/${appId}/crons`)
        response.end(JSON.stringify([{ cron: "*/5 * * * *", lastRun: null }]));
      else response.writeHead(404).end();
    });
  });

  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  });
  beforeEach(() => {
    requests.length = 0;
    failed = false;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const cli = (...args: string[]) =>
    execute(
      process.env["CLI_BINARY"] ??
        fileURLToPath(
          new URL(
            `../../../target/debug/widefleet${process.platform === "win32" ? ".exe" : ""}`,
            import.meta.url,
          ),
        ),
      ["crons", ...args, "--app", appId],
      {
        timeout: 10000,
        env: {
          ...process.env,
          PLATFORM_URL: origin,
          PLATFORM_ACCESS_TOKEN: "synthetic-cron-token",
          WIDEFLEET_TELEMETRY_DISABLED: "1",
        },
      },
    );

  it("lists schedules and filters run history", async () => {
    expect(JSON.parse((await cli("list")).stdout)).toEqual([
      { cron: "*/5 * * * *", lastRun: null },
    ]);
    await cli("runs", "--cron", "*/5 * * * *", "--limit", "5");
    const url = new URL(requests[1]?.path ?? "/", "http://cli.fixture");
    expect(Object.fromEntries(url.searchParams)).toEqual({ cron: "*/5 * * * *", limit: "5" });
  });

  it("starts a run idempotently and waits until the agent confirms it", async () => {
    const result = await cli("run", "*/5 * * * *");
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "succeeded" });
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ cron: "*/5 * * * *" });
    expect(requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(z.uuid().safeParse(requests[0]?.key).success).toBe(true);
  });

  it("reports why a run could not be started", async () => {
    failed = true;
    await expect(cli("run", "*/5 * * * *")).rejects.toThrow(
      "Install an app runtime with Cron support",
    );
  });

  it("returns the queued operation with --no-wait", async () => {
    expect(JSON.parse((await cli("run", "*/5 * * * *", "--no-wait")).stdout)).toMatchObject({
      state: "queued",
    });
    expect(requests).toHaveLength(1);
  });
});
