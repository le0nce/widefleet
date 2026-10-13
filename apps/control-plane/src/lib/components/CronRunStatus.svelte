<script lang="ts">
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import type { cronRun } from "@platform/contracts";
  import type { z } from "zod";

  let {
    status,
    compact = false,
  }: { status: z.infer<typeof cronRun>["status"]; compact?: boolean } = $props();
</script>

<span class={`inline-flex items-center gap-1.5 ${compact ? "" : "text-sm font-medium"}`}>
  {#if status === "succeeded"}<CircleCheck
      class={`${compact ? "size-3.5" : "size-4"} text-emerald-600 dark:text-emerald-400`}
    />Succeeded
  {:else if status === "failed"}<CircleX
      class={`${compact ? "size-3.5" : "size-4"} text-destructive`}
    />Failed
  {:else}<LoaderCircle
      class={`${compact ? "size-3.5" : "size-4"} text-primary animate-spin motion-reduce:animate-none`}
    />Running{/if}
</span>
