<script lang="ts">
  let {children}:{children:any}=$props();
</script>
<div class="main">
  <header class="row" style="justify-content:space-between"><a href="/dashboard">Denkstelle</a><small class="muted">Admin</small></header>
  {@render children()}
</div>
