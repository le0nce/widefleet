import { describe, expect, it } from "vitest";
import { cronExpression } from "./crons.ts";

describe("cron expressions", () => {
  it.each([
    "* * * * *",
    "*/15 * * * *",
    "30/15 * * * *",
    "0 9 * * 2-6",
    "0 9 * * MON-FRI",
    "0 0 1,15 jan,Jul *",
    "1-10/2 * * * *",
    "0 0 L * *",
    "0 0 LW * *",
    "0 0 L-3 * *",
    "0 0 L-30W * *",
    "0 0 15W * *",
    "0 0 * * L",
    "0 0 * * 6L",
    "0 0 * * FRI#3",
    "0 0 1 * MON",
    "0 0 31 2 *",
    "0  12 * * *",
  ])("accepts %s", (expression) => {
    expect(cronExpression.safeParse(expression).success).toBe(true);
  });

  it.each([
    ["", "expected 5 fields"],
    ["* * * *", "expected 5 fields"],
    ["* * * * * *", "expected 5 fields"],
    [" * * * * *", "leading or trailing whitespace"],
    ["60 * * * *", "minute field has 60 outside 0-59"],
    ["* 24 * * *", "hour field has 24 outside 0-23"],
    ["* * 0 * *", "day of month field has 0 outside 1-31"],
    ["* * * 13 *", "month field has 13 outside 1-12"],
    ["* * * * 0", "day of week field has 0 outside 1-7"],
    ["*/60 * * * *", "minute field has a step 60 outside 1-59"],
    ["*/0 * * * *", "step 0 outside"],
    ["*/x * * * *", "non-numeric step"],
    ["*/5/2 * * * *", "non-numeric step"],
    ["* * * * SAT-SUN", "descending range"],
    ["* * * NOV-FEB *", "descending range"],
    ["1,* * * * *", "`*` inside a list"],
    ["*,5 * * * *", "`*` inside a list"],
    ["+2 * * * *", "non-numeric value"],
    ["? * * * *", "non-numeric value"],
    ["* * * FOO *", "neither a number nor a name"],
    ["* * L-0 * *", "`L` offset 0 outside 1-30"],
    ["* * L-31 * *", "`L` offset 31 outside 1-30"],
    ["* * L3 * *", "unreadable `L` form"],
    ["* * 1W,15 * *", "non-numeric value"],
    ["* * * * MON#6", "`#` count 6 outside 1-5"],
    ["* * * * MON#x", "non-numeric `#` count"],
  ])("rejects %j with a message naming the problem", (expression, message) => {
    const result = cronExpression.safeParse(expression);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(message);
  });
});
