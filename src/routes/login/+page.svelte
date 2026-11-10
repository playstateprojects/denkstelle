<script lang="ts">
  import {authClient} from '$lib/auth-client';
  import {useI18n} from '$lib/i18n';
  const {t}=useI18n();
  let email=$state('');let sending=$state(false);let sent=$state(false);let failure=$state('');
  async function login(e:SubmitEvent){e.preventDefault();failure='';sending=true;
    const p=new URLSearchParams(location.search).get('next')??'/dashboard';
    const r=await authClient.signIn.magicLink({email,callbackURL:p,errorCallbackURL:'/login?error=1'});
    sending=false;if(r.error)failure=r.error.message??t('login.failed');else sent=true;
  }
</script>
<div class="main" style="max-width:570px;padding-top:10vh"><a href="/">{t('common.backBrand')}</a><div class="panel" style="margin-top:36px"><div class="eyebrow">{t('login.eyebrow')}</div><h1>{t('login.title')}</h1>{#if sent}<p>{t('login.sent')}</p>{:else}<form class="stack" onsubmit={login}><label>{t('login.email')}<input class="field" type="email" bind:value={email} required autocomplete="email"/></label><button class="btn" disabled={sending}>{sending?t('login.sending'):t('login.send')}</button>{#if failure}<p class="error">{failure}</p>{/if}</form>{/if}<p class="muted tiny">{t('login.note')}</p></div></div>
