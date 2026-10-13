import { command, query } from "$app/server";
import { appPath, cronRunRequest, cronRunsQuery, identifier } from "@platform/contracts";
import { queryValue, remoteContext } from "#server/remote-support";

export const getCronSchedules = query(appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.crons.schedules(principal, appId));
});

export const getCronRuns = query(
  appPath.extend(cronRunsQuery.shape),
  async ({ appId, ...query }) => {
    const { runtime, principal } = await remoteContext();

    return queryValue(await runtime.crons.runs(principal, appId, query));
  },
);

export const runCron = command(
  appPath.extend({ requestId: identifier, ...cronRunRequest.shape }),
  async ({ appId, requestId, ...request }) => {
    const { runtime, principal } = await remoteContext(true);

    return queryValue(await runtime.crons.run(principal, appId, requestId, request));
  },
);

export const getCronOperation = query(
  appPath.extend({ jobId: identifier }),
  async ({ appId, jobId }) => {
    const { runtime, principal } = await remoteContext();

    return queryValue(await runtime.crons.operation(principal, appId, jobId));
  },
);
