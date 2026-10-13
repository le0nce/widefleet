<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppCrons from "#shadcn/components/AppCrons.svelte";

  const app = getAppContext();
</script>

{#if app.data.app.state !== "deleting"}<AppCrons
    appId={app.data.app.id}
    published={app.data.app.activeDeploymentId !== null}
  />{/if}
