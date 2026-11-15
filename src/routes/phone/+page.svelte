<script lang="ts">
  import {onDestroy,untrack} from 'svelte';
  import {page} from '$app/state';
  import {useI18n} from '$lib/i18n';
  import {DeviceClient,type DeviceConfig} from '$lib/phone/device-client';
  import {Telephone,type PhoneSnapshot} from '$lib/phone/telephone';
  import type {PageData} from './$types';
  const {t,locale}=useI18n();
  let {data}:{data:PageData}=$props();

  const usable=(p:{capture_mode:string})=>p.capture_mode!=='video';
  const wanted=page.url.searchParams.get('project');
  let projectId=$state((data.projects.find(p=>p.id===wanted&&usable(p))??data.projects.find(usable))?.id??'');
  let consent=$state(false);
  let config=$state<DeviceConfig|null>(null);
  let configError=$state('');
  let phone=$state.raw<Telephone|null>(null);
  let snap=$state<PhoneSnapshot>({state:'idle',elapsedMs:0,level:0,error:null,attempt:0,receipt:null,autoStopped:false});

  // The simulator authenticates with the admin's session plus this header; no device secret exists in the browser.
  // Everything else is the same device API a Raspberry Pi calls.
  // Only projectId may be tracked here: reading `phone` or `config` in this effect would make it re-run
  // whenever it assigns them, resetting the phone forever (the pick-up button would never enable).
  $effect(()=>{
    const id=projectId;
    untrack(()=>{phone?.destroy();phone=null;config=null;configError='';snap={state:'idle',elapsedMs:0,level:0,error:null,attempt:0,receipt:null,autoStopped:false}});
    if(!id)return;
    let cancelled=false;
    const client=new DeviceClient({headers:{'X-Denkstelle-Simulator':id}});
    client.getConfig().then(c=>{
      if(cancelled)return;config=c;
      phone=new Telephone(client,c,s=>{snap=s},{lang:untrack(()=>locale)});
    }).catch(e=>{if(!cancelled)configError=e instanceof Error?e.message:String(e)});
    return()=>{cancelled=true;untrack(()=>phone?.destroy())};
  });
  onDestroy(()=>phone?.destroy());

  const clock=(ms:number)=>{const s=Math.floor(ms/1000);return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`};
  const busy=$derived(snap.state==='greeting'||snap.state==='recording'||snap.state==='uploading');
  const offHook=$derived(snap.state==='greeting'||snap.state==='recording');
  const maxClock=$derived(clock((config?.recording.maxDurationSeconds??180)*1000));
  const errorText=$derived.by(()=>{
    const e=snap.error;if(!e)return '';
    if(e.code==='mic_denied')return t('phone.err.mic_denied');
    if(e.code==='audio_failed')return t('phone.err.audio_failed');
    return e.message;
  });
  // Leaving with an un-uploaded recording would lose it.
  $effect(()=>{
    if(snap.state!=='failed'&&snap.state!=='recording'&&snap.state!=='uploading')return;
    const warn=(e:BeforeUnloadEvent)=>{e.preventDefault()};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  });
  const project=$derived(data.projects.find(p=>p.id===projectId));
</script>
<svelte:head><title>{t('phone.title')} · Denkstelle</title></svelte:head>
<div class="main" style="max-width:640px">
  <header class="row" style="justify-content:space-between"><a href="/dashboard">{t('common.backBrand')}</a><span class="pill">{t('phone.title')}</span></header>
  <h1 style="margin-top:36px">{t('phone.title')}</h1>
  <p class="muted">{t('phone.intro')}</p>

  {#if !data.projects.length}
    <p class="panel">{t('phone.noProjects')}</p>
  {:else}
    <label class="tiny">{t('phone.project')}
      <select class="field" bind:value={projectId} disabled={busy||phone?.hasPendingUpload}>
        {#each data.projects as p}<option value={p.id} disabled={!usable(p)}>{p.title}{usable(p)?'':` (${t('phone.needsAudio')})`}</option>{/each}
      </select>
    </label>
    {#if project}<div class="panel" style="margin-top:18px"><div class="eyebrow">{t('phone.question')}</div><p style="font-size:1.2rem;margin:6px 0 0">{project.question}</p></div>{/if}

    <div class="panel stack" style="margin-top:18px">
      <strong>{t('phone.privacyTitle')}</strong>
      <p class="tiny muted">{t('phone.privacy')}</p>
      <label class="row"><input type="checkbox" bind:checked={consent} disabled={busy} /><span>{t('phone.consent')}</span></label>
    </div>

    {#if configError}<p class="error" role="alert">{t('phone.configFailed')}: {configError}</p>{/if}

    <div class="panel stack" style="margin-top:18px" aria-live="polite">
      {#if offHook}
        <button class="btn" onclick={()=>phone?.hangUp()}>{t('phone.hangUp')}</button>
      {:else}
        <button class="btn" disabled={!consent||!phone||busy} onclick={()=>phone?.pickUp()}>{t('phone.pickUp')}</button>
      {/if}

      {#if snap.state==='idle'}
        <p class="muted">{consent?t('phone.idle'):t('phone.needConsent')}</p>
      {:else if snap.state==='greeting'}
        <p>{t('phone.greeting')}</p>
      {:else if snap.state==='recording'}
        <div class="row" style="justify-content:space-between"><strong><span aria-hidden="true">●</span> {t('phone.recording')}</strong><span class="pill">{clock(snap.elapsedMs)} / {maxClock}</span></div>
        <div style="height:8px;border:var(--rule)"><div style={`height:100%;width:${Math.max(2,snap.level)}%;background:var(--ink);transition:width .1s`}></div></div>
        <p class="tiny muted">{t('phone.recordingHint',{max:maxClock})}</p>
      {:else if snap.state==='uploading'}
        <p><strong>{t('phone.uploading')}</strong> {#if snap.attempt>1}<span class="muted">· {t('phone.attempt',{n:snap.attempt})}</span>{/if}</p>
      {:else if snap.state==='sent'}
        <p><strong>{t('phone.sent')}</strong></p>
        <p class="tiny muted">{t('phone.sentHint',{id:snap.receipt?.sourceId??''})}</p>
        {#if snap.autoStopped}<p class="tiny muted">{t('phone.autoStopped')}</p>{/if}
      {:else if snap.state==='discarded'}
        <p class="muted">{t('phone.tooShort')}</p>
      {:else if snap.state==='failed'}
        <p class="error" role="alert">{t('phone.failed')}: {errorText}</p>
        {#if snap.error?.retryable&&phone?.hasPendingUpload}
          <p class="tiny muted">{t('phone.retryHint')}</p>
          <div class="row"><button class="btn" onclick={()=>phone?.upload()}>{t('phone.retry')}</button><button class="btn secondary" onclick={()=>phone?.discard()}>{t('phone.discard')}</button></div>
        {:else}
          {#if snap.error?.code!=='mic_denied'&&snap.error?.code!=='audio_failed'}<p class="tiny muted">{t('phone.permanent')}</p>{/if}
          <div class="row"><button class="btn secondary" onclick={()=>phone?.discard()}>{t('phone.ok')}</button></div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
