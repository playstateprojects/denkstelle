<script lang="ts">
  import {AlertDialog} from 'bits-ui';
  import {useI18n} from '$lib/i18n';
  const {t}=useI18n();
  type Clip={id:string;title:string;reason:string|null;start_ms:number;end_ms:number;status:string;rendered:boolean;
    public_excerpt:boolean;public_explicit:boolean;social_media:boolean;social_explicit:boolean};
  let open=$state(false);let id=$state('');let code=$state('');let done=$state(false);let pending=$state(false);let issue=$state('');
  let clips=$state<Clip[]|null>(null);let loading=$state(false);let clipIssue=$state('');
  let previews=$state<Record<string,{state:'loading'|'ready'|'failed';url?:string}>>({});
  let saving=$state<Record<string,boolean>>({});
  const post=(path:string,payload:object)=>fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,code,...payload})});
  const mmss=(ms:number)=>{const s=Math.round(ms/1000);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`};
  async function erase(){open=false;
    pending=true;issue='';const r=await post('/api/manage/delete',{});
    const body=await r.json();pending=false;if(!r.ok)issue=body.error??t('manage.failed');else done=true;
  }
  async function loadClips(){
    loading=true;clipIssue='';
    try{const r=await post('/api/manage/clips',{});const body=await r.json();
      if(!r.ok){clipIssue=body.error??t('manage.loadFailed');clips=null}else clips=body.clips;
    }catch{clipIssue=t('manage.loadFailed')}
    loading=false;
  }
  async function preview(c:Clip){
    previews[c.id]={state:'loading'};
    try{const r=await post('/api/manage/clips/preview',{highlightId:c.id});
      if(!r.ok)throw new Error();previews[c.id]={state:'ready',url:URL.createObjectURL(await r.blob())};
    }catch{previews[c.id]={state:'failed'}}
  }
  async function setPermission(c:Clip,purpose:'public_excerpt'|'social_media',allowed:boolean|null){
    saving[c.id]=true;clipIssue='';
    try{const r=await post('/api/manage/clips/permission',{highlightId:c.id,purpose,allowed});
      if(!r.ok)clipIssue=(await r.json().catch(()=>({}))).error??t('manage.saveFailed');
      else await loadClips();
    }catch{clipIssue=t('manage.saveFailed')}
    saving[c.id]=false;
  }
  // Email links look like /manage#id=…&code=…; fragments never reach the server or logs. Prefill, then clear the address bar.
  $effect(()=>{
    const h=new URLSearchParams(location.hash.slice(1));const i=h.get('id'),c=h.get('code');
    if(i&&c&&/^[0-9a-f-]{36}$/i.test(i)&&/^[0-9a-f]{64}$/i.test(c)){
      id=i;code=c;history.replaceState(null,'',location.pathname+location.search);loadClips();
    }
  });
  $effect(()=>()=>{for(const p of Object.values(previews))if(p.url)URL.revokeObjectURL(p.url)});
</script>
<div class="main" style="max-width:620px"><a href="/">{t('common.backBrand')}</a><div class="eyebrow" style="margin-top:55px">{t('manage.eyebrow')}</div><h1>{t('manage.title')}</h1><p class="muted">{t('manage.intro')}</p>
<div class="panel stack">{#if done}<h2>{t('manage.doneTitle')}</h2><p>{t('manage.doneText')}</p>{:else}
<label>{t('manage.id')}<input class="field" bind:value={id} placeholder={t('manage.idPh')} autocomplete="off"/></label>
<label>{t('manage.code')}<input class="field" bind:value={code} placeholder={t('manage.codePh')} autocomplete="off"/></label>
<button class="btn secondary" disabled={loading||id.length<30||code.length!==64} onclick={loadClips}>{loading?t('manage.loading'):t('manage.open')}</button>
{#if clipIssue}<p class="error">{clipIssue}</p>{/if}
{#if clips}
  <h2>{t('manage.clipsTitle')}</h2><p class="muted tiny">{t('manage.clipsIntro')}</p>
  {#if !clips.length}<p>{t('manage.noClips')}</p>{/if}
  {#each clips as c (c.id)}
    <div class="panel stack" style="padding:16px">
      <div><strong>{c.title}</strong> <span class="muted tiny">{mmss(c.start_ms)}–{mmss(c.end_ms)} · {c.rendered?t('manage.rendered'):t('manage.pending')}</span></div>
      {#if c.reason}<p class="muted tiny">{c.reason}</p>{/if}
      {#if c.rendered}
        {#if previews[c.id]?.state==='ready'}<!-- svelte-ignore a11y_media_has_caption --><video src={previews[c.id].url} controls playsinline style="width:100%;max-height:420px;background:#000"></video>
        {:else}<button class="btn secondary" disabled={previews[c.id]?.state==='loading'} onclick={()=>preview(c)}>{previews[c.id]?.state==='loading'?t('manage.previewLoading'):t('manage.preview')}</button>
          {#if previews[c.id]?.state==='failed'}<p class="error">{t('manage.previewFailed')}</p>{/if}{/if}
      {:else}<p class="muted tiny">{t('manage.notRendered')}</p>{/if}
      <label style="display:flex;gap:12px;align-items:flex-start"><input type="checkbox" checked={c.public_excerpt} disabled={saving[c.id]} onchange={e=>setPermission(c,'public_excerpt',e.currentTarget.checked)}/>
        <span><strong>{t('manage.public')}</strong><br/><span class="muted tiny">{t('manage.publicHint')}</span></span></label>
      <label style="display:flex;gap:12px;align-items:flex-start"><input type="checkbox" checked={c.social_media} disabled={saving[c.id]} onchange={e=>setPermission(c,'social_media',e.currentTarget.checked)}/>
        <span><strong>{t('manage.social')}</strong><br/><span class="muted tiny">{t('manage.socialHint')}</span></span></label>
      <p class="muted tiny">{c.public_explicit||c.social_explicit?t('manage.explicit'):t('manage.inherited')}
        {#if c.public_explicit||c.social_explicit} · <button type="button" class="muted tiny" style="background:none;border:0;text-decoration:underline;cursor:pointer;padding:0;font:inherit" disabled={saving[c.id]} onclick={async()=>{await setPermission(c,'public_excerpt',null);await setPermission(c,'social_media',null)}}>{t('manage.reset')}</button>{/if}</p>
    </div>
  {/each}
  <h2>{t('manage.dangerTitle')}</h2>
{/if}
<button class="btn" disabled={pending||id.length<30||code.length!==64} onclick={()=>open=true}>{pending?t('manage.deleting'):t('manage.delete')}</button>{#if issue}<p class="error">{issue}</p>{/if}{/if}</div><p class="muted tiny">{t('manage.privacy')}</p></div>
<AlertDialog.Root bind:open><AlertDialog.Portal><AlertDialog.Overlay class="overlay"/><AlertDialog.Content class="dialog"><AlertDialog.Title class="eyebrow">{t('manage.delete')}</AlertDialog.Title><AlertDialog.Description>{t('manage.confirm')}</AlertDialog.Description><div class="dialog-actions"><AlertDialog.Cancel class="btn secondary">×</AlertDialog.Cancel><AlertDialog.Action class="btn" onclick={erase}>{t('manage.delete')}</AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
