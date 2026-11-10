<script lang="ts">
  import {enhance} from '$app/forms';
  import type {PageData,ActionData} from './$types';
  let {data,form}:{data:PageData;form:ActionData}=$props();

  const sample=`Ich glaube, die größte Veränderung in unserer Straße ist, dass sich kaum noch jemand kennt.
Früher hat man sich auf der Treppe unterhalten, heute grüßt man höchstens noch.
Aber ich weiß nicht, ob das wirklich schlimmer ist, vielleicht ist es einfach anders.
Was mir fehlt, ist ein Ort, an dem man ohne Anlass zusammenkommt.
Der Hof hinter dem Haus wäre dafür perfekt, aber er gehört niemandem so richtig.
Wenn die Stadt da etwas hinstellen würde, Bänke oder so, dann würde ich hingehen.`;

  // The editor starts over whenever another prompt/model is opened or a new version goes live; typing overrides it.
  let draft=$derived(data.live);
  let notes=$derived.by(()=>{void [data.model,data.key,data.liveVersion];return ''});
  let activate=$state(true);
  let sampleTitle=$state('Nachbarschaft');
  let sampleQuestion=$state('Was verändert sich in deinem Viertel?');
  let sampleSpeaker=$state('');
  let sampleText=$state(sample);
  // which models to run the test on; the edited one is always a sensible default
  let runOn=$state<string[]>([]);
  $effect(()=>{runOn=[data.model]});
  let busy=$state<''|'save'|'preview'>('');

  const changed=$derived(draft.trim()!==data.live.trim());
  const when=(iso:string)=>new Date(iso).toLocaleString();
  const label=(id:string)=>data.models.find(m=>m.id===id)?.label??id;
  const cur=$derived(data.models.find(m=>m.id===data.model));
  let switcher:HTMLFormElement;
</script>
<svelte:head><title>Prompts · Admin</title></svelte:head>

<div class="eyebrow" style="margin-top:40px">Admin</div>
<h1 style="font-size:3rem">Prompts</h1>
<p class="muted">Each model has its own prompts. Every save is a new version; one version per prompt is live, none means the built-in default.</p>

{#if !data.ready}
  <p class="error">The prompts tables do not exist yet. Everything runs on built-in defaults and nothing can be saved. Run <code>npm run db:migrate</code>, then reload.</p>
{/if}

<section class="grid" style="margin-top:24px">
  <div class="panel">
    <h2>Pipeline model</h2>
    <p class="muted tiny">Used for every new recording from now on. Currently: <strong>{label(data.activeModel)}</strong>.</p>
    <form method="POST" action="?/useModel" class="stack" use:enhance={()=>async({update})=>{await update({reset:false})}}>
      <select class="field" name="pipelineModel" value={data.activeModel}>
        {#each data.models as m}<option value={m.id} disabled={!m.configured}>{m.label}{m.configured?'':` (${m.keyEnv} not set)`}</option>{/each}
      </select>
      <button class="btn secondary" disabled={!data.ready}>Use for processing</button>
      {#if form && 'pipelineModel' in form}<p class="success">Pipeline now uses {label(form.pipelineModel as string)}.</p>{/if}
    </form>
  </div>
  <div class="panel">
    <h2>Edit prompts for</h2>
    <p class="muted tiny">Pick the model whose prompts you want to edit and test.</p>
    <form method="GET" bind:this={switcher} class="stack">
      <input type="hidden" name="key" value={data.key} />
      <select class="field" name="model" value={data.model} onchange={()=>switcher.requestSubmit()}>
        {#each data.models as m}<option value={m.id}>{m.label}{m.id===data.activeModel?' · in use':''}</option>{/each}
      </select>
      <noscript><button class="btn secondary">Switch</button></noscript>
    </form>
  </div>
</section>

<div style="display:grid;grid-template-columns:minmax(0,15rem) minmax(0,1fr);gap:24px;margin-top:24px;align-items:start" class="layout">
  <nav class="stack" style="gap:0;border:var(--rule)" aria-label="Prompts">
    {#each data.menu as item}
      <a class="rule-row" style="padding:12px 14px;text-decoration:none;display:flex;justify-content:space-between;gap:8px;{item.key===data.key?'background:var(--ink);color:var(--paper)':''}" href={`?model=${data.model}&key=${item.key}`} aria-current={item.key===data.key?'page':undefined}>
        <span>{item.label}</span><span class="tiny">{item.version?`v${item.version}`:'default'}</span>
      </a>
    {/each}
  </nav>

  <div class="stack" style="min-width:0">
    <div class="panel">
      <div class="row" style="flex-wrap:wrap;gap:10px"><h2 style="margin:0">{data.def.label}</h2>
        <span class="pill">{cur?.label}</span>
        <span class="pill">{data.liveVersion?`live: v${data.liveVersion}`:'live: built-in default'}</span></div>
      <p class="muted tiny">{data.def.help}</p>
      <form method="POST" action="?/save" class="stack" use:enhance={()=>{busy='save';return async({update})=>{await update({reset:false});busy=''}}}>
        <input type="hidden" name="model" value={data.model} />
        <input type="hidden" name="key" value={data.key} />
        {#if data.def.kind==='number'}
          <input class="field" name="body" bind:value={draft} inputmode="decimal" style="max-width:10rem" />
        {:else}
          <textarea class="field" name="body" bind:value={draft} rows="18" spellcheck="false"></textarea>
        {/if}
        <input class="field" name="notes" bind:value={notes} maxlength="300" placeholder="What changed, and why (optional)" />
        <div class="row" style="flex-wrap:wrap;gap:16px">
          <label class="row" style="gap:8px"><input type="checkbox" name="activate" bind:checked={activate} /> Make it live</label>
          <button class="btn" disabled={!data.ready||!changed||busy!==''}>{busy==='save'?'Saving…':'Save as new version'}</button>
          <button class="btn secondary" type="button" disabled={!changed} onclick={()=>draft=data.live}>Discard changes</button>
        </div>
      </form>
      {#if form && 'error' in form && form.error && !('results' in form)}<p class="error">{form.error}</p>
      {:else if form && 'saved' in form && form.saved}<p class="success">{form.activated?`v${form.saved} is live for ${cur?.label}.`:`Saved v${form.saved}, not live yet.`}</p>
      {:else if form && 'reset' in form}<p class="success">Back on the built-in default.</p>{/if}
    </div>

    <div class="panel">
      <h2>Try it</h2>
      <p class="muted tiny">Runs the analysis on a sample transcript, one segment per line. {cur?.label} uses the text above (unsaved draft); any other model ticked uses its own live prompts, so you can compare them side by side. Nothing is stored.</p>
      <form method="POST" action="?/preview" class="stack" use:enhance={()=>{busy='preview';return async({update})=>{await update({reset:false});busy=''}}}>
        <input type="hidden" name="model" value={data.model} />
        <input type="hidden" name="key" value={data.key} />
        <input type="hidden" name="body" value={draft} />
        <div class="row" style="flex-wrap:wrap;gap:16px">
          {#each data.models as m}
            <label class="row" style="gap:8px"><input type="checkbox" name="runOn" value={m.id} bind:group={runOn} disabled={!m.configured} /> {m.label}{m.configured?'':` (${m.keyEnv} not set)`}</label>
          {/each}
        </div>
        <label>Project title<input class="field" name="sampleTitle" bind:value={sampleTitle} maxlength="160" /></label>
        <label>Question<input class="field" name="sampleQuestion" bind:value={sampleQuestion} maxlength="500" /></label>
        <label>Speaker nickname (optional)<input class="field" name="sampleSpeaker" bind:value={sampleSpeaker} maxlength="100" /></label>
        <label>Transcript<textarea class="field" name="sample" bind:value={sampleText} rows="8"></textarea></label>
        <div><button class="btn secondary" disabled={busy!==''||runOn.length===0}>{busy==='preview'?'Running…':'Run analysis'}</button></div>
      </form>
      {#if form && 'error' in form && form.error && !('saved' in form)}{/if}
      {#if form && 'results' in form && form.results}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-top:20px">
          {#each form.results as r}
            <div class="panel soft" style="min-width:0">
              <div class="row" style="flex-wrap:wrap;gap:8px"><h3 style="margin:0">{r.label}</h3><span class="pill">{(r.ms/1000).toFixed(1)}s</span></div>
              <p class="tiny muted">{Object.entries(r.sources).map(([k,v])=>`${k}: ${v}`).join(' · ')}</p>
              {#if r.ok}
                <p>{r.extracted.summary}</p>
                <div class="eyebrow">Statements ({r.extracted.statements.length})</div>
                <ol class="tiny" style="padding-left:1.2em">{#each r.extracted.statements as s}<li style="margin-bottom:6px">{s.text} <span class="muted">[{s.segment_indexes.join(', ')}] · {s.themes.join(', ')}</span></li>{/each}</ol>
                <div class="eyebrow">Highlights ({r.extracted.highlights.length})</div>
                <ul class="tiny" style="padding-left:1.2em">{#each r.extracted.highlights as h}<li style="margin-bottom:6px"><strong>{h.title}</strong> [{h.start_segment}–{h.end_segment}] {h.reason}</li>{/each}</ul>
              {:else}
                <p class="error">{r.error}</p>
              {/if}
              {#if r.raw}<details><summary class="tiny">Raw output</summary><pre class="tiny" style="white-space:pre-wrap;word-break:break-word">{r.raw}</pre></details>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="panel">
      <h2>History</h2>
      {#if data.versions.length===0}<p class="muted">No saved versions for {cur?.label}: the built-in default is running.</p>{/if}
      <div class="stack">
        {#each data.versions as v (v.id)}
          <div class="panel soft" style="padding:14px">
            <div class="row" style="flex-wrap:wrap;gap:10px">
              <strong style="font-size:1.3rem">v{v.version}</strong>
              {#if v.active}<span class="pill">live</span>{/if}
              <span class="tiny muted">{when(v.created_at)}{v.created_by?` · ${v.created_by}`:''}</span>
              {#if v.notes}<span class="tiny">{v.notes}</span>{/if}
              <span class="row" style="margin-left:auto;gap:8px">
                <button class="btn secondary" type="button" onclick={()=>draft=v.body}>Load into editor</button>
                {#if !v.active}
                  <form method="POST" action="?/activate" use:enhance={()=>async({update})=>{await update({reset:false})}}>
                    <input type="hidden" name="model" value={data.model} /><input type="hidden" name="key" value={data.key} /><input type="hidden" name="version" value={v.version} />
                    <button class="btn secondary">Make live</button>
                  </form>
                {/if}
              </span>
            </div>
            <details><summary class="tiny">Show text</summary><pre class="tiny" style="white-space:pre-wrap">{v.body}</pre></details>
          </div>
        {/each}
        {#if data.liveVersion}
          <form method="POST" action="?/reset" use:enhance={()=>async({update})=>{await update({reset:false})}}>
            <input type="hidden" name="model" value={data.model} /><input type="hidden" name="key" value={data.key} />
            <button class="btn secondary">Switch off all versions (use built-in default)</button>
          </form>
        {/if}
      </div>
    </div>
  </div>
</div>
<style>
  @media (max-width:760px){.layout{grid-template-columns:1fr!important}}
</style>
