<script lang="ts">
  import type {PageData,ActionData} from './$types';
  import {enhance} from '$app/forms';
  import {invalidateAll} from '$app/navigation';
  import {onMount} from 'svelte';
  import {useI18n} from '$lib/i18n';
  let {data,form}:{data:PageData;form:ActionData}=$props();
  const {t,locale}=useI18n();
  const tk=(k:string)=>t(k as Parameters<typeof t>[0]);
  const fmt=(d:string)=>new Date(d).toLocaleString(locale,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  const time=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
  const secs=(ms:number)=>Math.round(ms/1000);
  const busy=(s:string)=>s==='queued'||s==='composing'||s==='rendering';
  const clipsOf=(id:string)=>data.clips.filter(c=>c.reel_id===id);
  const total=(id:string)=>clipsOf(id).filter(c=>c.included).reduce((a,c)=>a+c.end_ms-c.start_ms,0);
  const criteria=['relevance','standalone','insight','vividness'] as const;
  let working=$derived(data.reels.some(r=>busy(r.status)));
  // While the processor works, check back. Stops by itself once nothing is queued or running.
  onMount(()=>{const i=setInterval(()=>{if(working)invalidateAll();},4000);return ()=>clearInterval(i);});
  let seconds=$state(data.defaults.target_ms/1000),themes=$state(data.defaults.themes),minScore=$state(data.defaults.min_score);
  let model=$state('');
</script>
<div class="main">
  <header class="row" style="justify-content:space-between"><a href={`/dashboard/projects/${data.project.id}`}>{t('reel.back')}</a></header>
  <div class="eyebrow" style="margin-top:45px">{t('reel.eyebrow')}</div>
  <h1 style="font-size:clamp(2.2rem,5vw,3.4rem)">{t('reel.title')}</h1>
  <p class="muted" style="font-size:1.1rem;max-width:46rem">{t('reel.intro')}</p>

  <section class="panel" style="margin-top:18px">
    <h2>{t('reel.new')}</h2>
    {#if !data.counts.eligible}<p class="muted">{t('reel.noEligible')}</p>
    {:else if !data.counts.themes}<p class="muted">{t('reel.noThemes')}</p>{/if}
    <p class="muted tiny">{t('reel.pool',{n:data.counts.eligible,themes:data.counts.themes})}</p>
    <form method="POST" action="?/compose" use:enhance={()=>async({update})=>update({reset:false})} class="row" style="flex-wrap:wrap;gap:16px;align-items:end">
      <label class="tiny">{t('reel.length')}<br><input class="field" type="number" name="seconds" min="20" max="180" step="5" bind:value={seconds} style="width:90px"/></label>
      <label class="tiny">{t('reel.themes')}<br><input class="field" type="number" name="themes" min="1" max="8" bind:value={themes} style="width:80px"/></label>
      <label class="tiny">{t('reel.minScore')}<br><input class="field" type="number" name="min_score" min="1" max="5" step="0.1" bind:value={minScore} style="width:90px"/></label>
      <label class="tiny">{t('reel.model')}<br><select class="field" name="model" bind:value={model}>
        <option value="">{t('reel.modelDefault',{name:data.models.find(m=>m.id===data.activeModel)?.label??data.activeModel})}</option>
        {#each data.models as m}<option value={m.id} disabled={!m.ready}>{m.label}{m.ready?'':' ('+t('reel.noKey')+')'}</option>{/each}</select></label>
      <button class="btn" disabled={!data.counts.eligible||!data.counts.themes}>{t('reel.compose')}</button>
    </form>
    <p class="muted tiny" style="margin-top:10px">{t('reel.promptsNote')} <a href="/admin/prompts">/admin/prompts</a></p>
    {#if form && 'message' in form && form.message}<p style="color:#b00020">{form.message}</p>{/if}
  </section>

  {#each data.reels as r (r.id)}
    {@const cs=clipsOf(r.id)}
    <section class="panel" style="margin-top:18px">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div><strong style="font-size:1.3rem">{r.title}</strong> <span class="pill">{tk('reel.status.'+r.status)}</span> {#if busy(r.status)}<small class="muted">…</small>{/if}<br>
          <small class="muted">{fmt(r.created_at)} · {t('reel.params',{s:secs(Number(r.params.target_ms??0)),n:Number(r.params.themes??0)})}{#if r.trace && typeof r.trace==='object' && 'model' in r.trace} · {(r.trace as {model:string}).model}{/if}</small></div>
        <div class="row" style="gap:8px">
          {#if r.status==='composed'||r.status==='failed'}{#if cs.length}<form method="POST" action="?/render" use:enhance><input type="hidden" name="reelId" value={r.id}/><button class="btn">{t('reel.render')} · {secs(total(r.id))}s</button></form>{/if}{/if}
          {#if r.status!=='rendering'}<form method="POST" action="?/remove" use:enhance={({cancel})=>{if(!confirm(t('reel.confirmDelete')))cancel();}}><input type="hidden" name="reelId" value={r.id}/><button class="btn secondary">{t('reel.delete')}</button></form>{/if}
        </div>
      </div>
      {#if r.error}<p style="color:#b00020">{r.error}</p>{/if}
      {#if r.summary}<p class="muted">{r.summary}</p>{/if}
      {#if r.status==='rendered'}<video controls playsinline preload="metadata" src={`/api/dashboard/reel/${r.id}`} style="max-height:420px;border-radius:12px;margin:8px 0"></video>{/if}

      {#if cs.length}
        <div class="eyebrow" style="margin-top:14px">{t('reel.plan',{n:cs.filter(c=>c.included).length,s:secs(total(r.id))})}</div>
        {#each cs as c, i (c.id)}
          <div style="padding:14px 0;border-top:2px solid #000;opacity:{c.included?1:.45}">
            <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
              <span><strong>{i+1}.</strong> <span class="pill">{c.theme_name}</span> <small class="muted">{c.speaker??t('reel.anon')} · {time(c.start_ms)}–{time(c.end_ms)} · {secs(c.end_ms-c.start_ms)}s</small></span>
              <span class="row" style="gap:10px"><strong title={t('reel.scoreHint')}>★ {c.score.toFixed(1)}</strong>
                {#if r.status==='composed'||r.status==='rendered'||r.status==='failed'}<form method="POST" action="?/toggle" use:enhance={()=>async({update})=>update({reset:false})}><input type="hidden" name="clipId" value={c.id}/><button class="btn secondary" style="padding:4px 10px">{c.included?t('reel.exclude'):t('reel.include')}</button></form>{/if}</span>
            </div>
            <p style="margin:8px 0">“{c.text}”</p>
            <div class="row tiny muted" style="flex-wrap:wrap;gap:12px">{#each criteria as k}<span>{tk('reel.c.'+k)} {c.ratings[k]??'–'}</span>{/each}</div>
            {#if c.rationale}<p class="muted tiny" style="margin:4px 0">{c.rationale}</p>{/if}
            <details style="margin-top:6px"><summary class="tiny">{t('reel.preview')}</summary><video controls playsinline preload="none" src={`/api/dashboard/media/${c.source_id}#t=${(c.start_ms/1000).toFixed(2)},${(c.end_ms/1000).toFixed(2)}`} style="max-height:260px;border-radius:10px;margin-top:6px"></video></details>
          </div>
        {/each}
      {/if}

      {#if r.trace && typeof r.trace==='object' && 'themes' in r.trace}
        <details style="margin-top:10px"><summary class="tiny muted">{t('reel.trace')}</summary>
          {#each (r.trace as {themes:{name:string;interviews:number;candidates:number;rated:number;best:number}[]}).themes as th}
            <div class="tiny muted">{th.name} · {t('reel.traceRow',{i:th.interviews,c:th.candidates,r:th.rated,b:th.best.toFixed(1)})}</div>
          {/each}</details>
      {/if}
    </section>
  {/each}
</div>
