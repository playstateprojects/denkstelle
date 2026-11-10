<script lang="ts">
  import {ToggleGroup} from 'bits-ui';
  import {invalidateAll} from '$app/navigation';
  import {locales,useI18n,type Locale} from '$lib/i18n';
  const i18n=useI18n();
  async function pick(l:string){
    if(!l||l===i18n.locale)return;
    document.cookie=`lang=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang=l;
    await invalidateAll();
  }
</script>
<div class="lang">
  <ToggleGroup.Root type="single" value={i18n.locale} onValueChange={pick} class="toggle-group" aria-label={i18n.t('lang.label')}>
    {#each locales as l}
      <ToggleGroup.Item value={l} lang={l}>{l.toUpperCase()}</ToggleGroup.Item>
    {/each}
  </ToggleGroup.Root>
</div>
<style>.lang{position:fixed;top:12px;right:12px;z-index:50}</style>
