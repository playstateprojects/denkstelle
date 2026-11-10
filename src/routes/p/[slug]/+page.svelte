<script lang="ts">
  import {onDestroy} from 'svelte';
  import {useI18n} from '$lib/i18n';
  const {t}=useI18n();
  import type {PageData} from './$types';
  let {data}:{data:PageData}=$props();
  type Step='consent'|'camera'|'recording'|'review'|'uploading'|'done';
  let step=$state<Step>('consent');let consentCapture=$state(false);
  let canPublish=$state(false);let canSocial=$state(false);let email=$state('');const emailReceipt=$derived(email.trim().length>0);
  let label=$state('');let error=$state('');let elapsed=$state(0);let level=$state(0);let progress=$state('');
  let preview=$state<HTMLVideoElement>();
  let stream:MediaStream|null=null;let recorder:MediaRecorder|null=null;
  let chunks:Blob[]=[];let videoBlob:Blob|null=null;let localUrl=$state('');let timer:ReturnType<typeof setInterval>|undefined;
  let audioCtx:AudioContext|undefined;let analyser:AnalyserNode|undefined;let raf=0;
  let sourceId=$state('');let receiptCode=$state('');
  // The project decides which modes exist; with 'either' the contributor picks on the first screen.
  let choice=$state<'video'|'audio'>('video');
  const mode=$derived<'video'|'audio'>(data.project.capture_mode==='either'?choice:data.project.capture_mode);
  const isAudio=$derived(mode==='audio');
  const allAllowed=$derived(canPublish&&canSocial);
  function setAll(){const on=!allAllowed;canPublish=on;canSocial=on}
  function stopTimers(){if(timer){clearInterval(timer);timer=undefined}if(typeof cancelAnimationFrame!=='undefined')cancelAnimationFrame(raf)}
  function stopStream(){stopTimers();stream?.getTracks().forEach(t=>t.stop());stream=null;audioCtx?.close().catch(()=>{});audioCtx=undefined}
  function meter(){if(!analyser)return;const x=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(x);let sq=0;for(const n of x)sq+=((n-128)/128)**2;level=Math.min(100,Math.sqrt(sq/x.length)*300);raf=requestAnimationFrame(meter)}
  async function prepare(){error='';try{
    stream=await navigator.mediaDevices.getUserMedia({video:isAudio?false:{facingMode:'user',width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    if(!('MediaRecorder' in window))throw new Error(t('rec.noMediaRecorder'));
    step='camera';await new Promise(r=>setTimeout(r,30));if(preview&&!isAudio){preview.srcObject=stream;await preview.play().catch(()=>{})}
    audioCtx=new AudioContext();const source=audioCtx.createMediaStreamSource(stream);
    analyser=audioCtx.createAnalyser();analyser.fftSize=1024;source.connect(analyser);meter();
  }catch(e){stopStream();error=e instanceof Error?e.message:String(e)}}
  function chooseMime(){return (isAudio
    ?['audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus']
    :['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm']).find(x=>MediaRecorder.isTypeSupported(x))}
  function begin(){if(!stream)return;error='';chunks=[];const mimeType=chooseMime();
    recorder=new MediaRecorder(stream,mimeType?(isAudio?{mimeType,audioBitsPerSecond:64000}:{mimeType,videoBitsPerSecond:1200000}):undefined);
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    recorder.onerror=()=>{error=t('rec.recorderError');stopStream()};
    recorder.onstop=()=>{stopStream();if(localUrl)URL.revokeObjectURL(localUrl);videoBlob=new Blob(chunks,{type:recorder?.mimeType||mimeType||(isAudio?'audio/webm':'video/mp4')});localUrl=URL.createObjectURL(videoBlob);step='review'};
    elapsed=0;recorder.start(2000);step='recording';timer=setInterval(()=>{elapsed++;if(elapsed>=180)stop()},1000);
  }
  function stop(){if(recorder?.state==='recording')recorder.stop()}
  function retry(){sourceId='';receiptCode='';if(localUrl){URL.revokeObjectURL(localUrl);localUrl=''}videoBlob=null;step='consent';stopStream()}
  // Full wipe for the next person at a shared screen: recording, receipt code, consents, email, label.
  function reset(){retry();consentCapture=false;canPublish=false;canSocial=false;email='';label='';error='';progress='';elapsed=0;level=0;choice='video'}
  const clock=$derived(`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`);
  async function upload(){if(!videoBlob)return;step='uploading';error='';try{
    if(!sourceId||!receiptCode){
      progress=t('rec.creating');
      const started=await fetch('/api/public/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,slug:data.project.slug,contributorLabel:label.trim()||undefined,consents:{capture_analysis:true,public_excerpt:canPublish,social_media:canSocial,email_receipt:emailReceipt},email:emailReceipt?email.trim():undefined})});
      const start=await started.json();if(!started.ok)throw new Error(start.error||t('rec.createFailed'));
      sourceId=start.sourceId;receiptCode=start.receiptCode;
    }
    progress=t('rec.uploading');
    const res=await fetch(`/api/public/upload/${sourceId}`,{method:'PUT',headers:{'Content-Type':videoBlob.type.split(';')[0]||(isAudio?'audio/webm':'video/mp4'),'X-Receipt-Code':receiptCode,'X-Duration-Ms':String(elapsed*1000)},body:videoBlob});
    const result=await res.json();if(!res.ok)throw new Error(result.error||t('rec.uploadFailed'));
    if(emailReceipt&&email.trim()){progress=t('rec.sendingReceipt');await fetch(`/api/public/receipt/${sourceId}`,{method:'POST',headers:{'Content-Type':'application/json','X-Receipt-Code':receiptCode}}).catch(()=>{})}
    progress=t('rec.finished');step='done';stopStream();
  }catch(e){step='review';error=(e instanceof Error?e.message:t('rec.uploadFailed'))+t('rec.retryHint')}}
  onDestroy(()=>{stopStream();if(localUrl)URL.revokeObjectURL(localUrl)});
</script>
<svelte:head><title>{data.project.title} · Denkstelle</title></svelte:head>
<div class="main" style="max-width:850px">
  <header class="row" style="justify-content:space-between"><a href="/">{t('common.brand')}</a><span class="pill">{t('rec.pill')}</span></header>
  <div class="eyebrow" style="margin-top:48px">{data.project.title}</div>
  {#if step==='consent'}
    <h1 class="headline" style="font-size:clamp(2.3rem,7vw,4.8rem)">{t('rec.consent.h1a')}<br/>{t('rec.consent.h1b')} <span class="mark">{t('rec.consent.h1c')}</span></h1>
    <p style="font-size:1.2rem">{data.project.question}</p>
    <div class="panel stack" style="margin-top:28px">
      <p class="muted">{t('rec.consent.intro1')} <strong>{t('rec.consent.intro2')}</strong></p>
      {#if data.project.capture_mode==='either'}
        <div class="row" role="radiogroup" aria-label={t('rec.mode.label')}><strong>{t('rec.mode.label')}</strong>
          <label class="row"><input type="radio" name="mode" value="video" bind:group={choice} />{t('rec.mode.video')}</label>
          <label class="row"><input type="radio" name="mode" value="audio" bind:group={choice} />{t('rec.mode.audio')}</label></div>
      {/if}
      <label class="row"><input type="checkbox" bind:checked={consentCapture} /><span><strong>{t('rec.consent.capture')}</strong><br/><span class="tiny muted">{t('rec.consent.captureHint')}</span></span></label>
      <hr class="divider" style="width:100%"/>
      <div class="row" style="justify-content:space-between;align-items:start"><div><strong>{t('rec.consent.more')}</strong><p class="muted tiny">{t('rec.consent.moreHint')}</p></div><button class="btn secondary" onclick={setAll}>{allAllowed?t('rec.consent.revokeAll'):t('rec.consent.allowAll')}</button></div>
      <label class="row"><input type="checkbox" checked={canPublish} onchange={(e)=>{canPublish=e.currentTarget.checked;if(!canPublish)canSocial=false}}/><span><strong>{t('rec.consent.public')}</strong><br/><span class="tiny muted">{t('rec.consent.publicHint')}</span></span></label>
      <label class="row"><input type="checkbox" checked={canSocial} onchange={(e)=>{canSocial=e.currentTarget.checked;if(canSocial)canPublish=true}}/><span><strong>{t('rec.consent.social')}</strong><br/><span class="tiny muted">{t('rec.consent.socialHint')}</span></span></label>
      <label class="tiny"><strong>{t('rec.consent.receipt')}</strong> <span class="muted">({t('rec.consent.optional')})</span><br/><span class="muted">{t('rec.consent.receiptHint')}</span><input class="field" type="email" bind:value={email} placeholder="du@example.org" /></label>
      <label class="tiny">{t('rec.consent.name')}<input class="field" bind:value={label} maxlength="100" placeholder={t('rec.consent.namePh')}/></label>
      <p class="muted tiny">{t('rec.consent.legal')}</p>
      <button class="btn" disabled={!consentCapture||(emailReceipt&&!/^\S+@\S+\.\S+$/.test(email.trim()))} onclick={prepare}>{t('rec.consent.go')}</button>
    </div>
  {:else if step==='camera'||step==='recording'}
    <h1>{isAudio?t('rec.cam.titleAudio'):t('rec.cam.title')}</h1><p class="muted">{data.project.question}</p>
    <div class="panel" style="position:relative;padding:8px;overflow:hidden">{#if isAudio}<div style="width:100%;aspect-ratio:4/3;background:#000;display:grid;place-items:center"><div style={`width:${Math.max(24,level*3)}px;height:${Math.max(24,level*3)}px;max-width:70%;border-radius:50%;background:#fff;transition:width .08s,height .08s`}></div></div>{:else}<video bind:this={preview} autoplay muted playsinline style="width:100%;aspect-ratio:4/3;object-fit:cover;background:#000;transform:scaleX(-1)"></video>{/if}<div class="row" style="position:absolute;bottom:18px;left:20px;background:#fff;border:2px solid #000;padding:8px 12px;border-radius:12px"><span style="color:#000">●</span> {t('rec.cam.mic')} <div style={`width:${Math.max(10,level)}px;height:7px;background:#000`}></div></div></div>
    <div class="row" style="justify-content:space-between;margin-top:20px"><span class="pill">{step==='recording'?t('rec.cam.recording'):t('rec.cam.preview')} · {clock} / 03:00</span>{#if step==='camera'}<button class="btn" onclick={begin}>{t('rec.cam.start')}</button>{:else}<button class="btn" onclick={stop}>{t('rec.cam.stop')}</button>{/if}</div>
  {:else if step==='review'||step==='uploading'}
    <h1>{t('rec.review.title')}</h1><p class="muted">{isAudio?t('rec.review.textAudio'):t('rec.review.text')}</p><div class="panel">{#if isAudio}<audio src={localUrl} controls style="width:100%"></audio>{:else}<!-- svelte-ignore a11y_media_has_caption --><video src={localUrl} controls playsinline style="width:100%;border-radius:16px"></video>{/if}</div><div class="row" style="margin-top:22px;flex-wrap:wrap"><button class="btn secondary" onclick={retry} disabled={step==='uploading'}>{t('rec.review.again')}</button><button class="btn" onclick={upload} disabled={step==='uploading'}>{step==='uploading'?t('rec.review.uploading'):t('rec.review.submit')}</button></div><p class="muted">{progress}</p>
  {:else if step==='done'}
    <h1 class="headline">{t('rec.done.h1a')}<br/><span class="mark">{t('rec.done.h1b')}</span></h1><p>{t('rec.done.text')}</p>
    <div class="panel stack"><strong>{t('rec.done.codeTitle')}</strong><code style="overflow-wrap:anywhere;padding:13px">{receiptCode}</code><button class="btn secondary" onclick={()=>navigator.clipboard.writeText(t('rec.copyText',{id:sourceId,code:receiptCode}))}>{t('rec.done.copy')}</button><p class="tiny muted">{t('rec.done.keep')}</p><a href="/manage" class="btn">{t('rec.done.manage')}</a></div>
    <div class="row" style="margin-top:22px"><button class="btn secondary" onclick={reset}>{t('rec.done.reset')}</button></div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
