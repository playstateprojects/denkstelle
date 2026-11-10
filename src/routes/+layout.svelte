<script lang="ts">
  import '../app.css';
  import {setContext} from 'svelte';
  import {translate,type Locale,type TFunction} from '$lib/i18n';
  import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
  let {children,data}:{children:any;data:{locale:Locale}}=$props();
  const i18n={
    get locale(){return data.locale},
    t:((key,params)=>translate(data.locale,key,params)) as TFunction
  };
  setContext('i18n',i18n);
</script>
<svelte:head><title>{i18n.t('app.title')}</title></svelte:head>
<LanguageSwitcher />
{@render children()}
