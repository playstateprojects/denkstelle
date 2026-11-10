<script lang="ts">
  import {onMount} from 'svelte';
  import type {PageData} from './$types';
  let {data}:{data:PageData}=$props();
  import {useI18n} from '$lib/i18n';
  const {t}=useI18n();
  let container:HTMLDivElement;
  let mode=$state<'interviews'|'similarity'>('interviews');
  let graph:any;let nodes:any[]=[];
  const linksFor=(m:string)=>{
    if(m==='interviews')return data.links.map(x=>({source:x.a,target:x.b,shared:x.shared,sim:0}));
    const seen=new Map<string,any>();
    for(const x of data.similar){const k=x.a<x.b?x.a+x.b:x.b+x.a;if(!seen.has(k))seen.set(k,{source:x.a,target:x.b,shared:0,sim:x.sim})}
    return [...seen.values()];
  };
  function apply(){
    if(!graph)return;const sim=mode==='similarity';
    graph.d3Force('link').distance((l:any)=>sim?10+(1-Math.max(0,l.sim))*140:30).strength((l:any)=>sim?Math.max(.1,l.sim):.3);
    graph.linkWidth((l:any)=>sim?.5+Math.max(0,l.sim)*3:Math.min(5,.5+l.shared*.35));
    graph.graphData({nodes,links:linksFor(mode)});graph.d3ReheatSimulation();
  }
  $effect(()=>{mode;apply()});
  let selected=$state<{name:string;count:number}|null>(null);
  onMount(()=>{
    let destroyed=false;let obs:ResizeObserver|undefined;
    (async()=>{
      const [{default:ForceGraph3D},{default:SpriteText}]=await Promise.all([import('3d-force-graph'),import('three-spritetext')]);
      if(destroyed)return;
      nodes=data.nodes.map(x=>({...x}));
      graph=new ForceGraph3D(container).backgroundColor('#ffffff').graphData({nodes,links:linksFor(mode)})
        .nodeLabel((x:any)=>t('nodes.label',{name:x.name,n:x.count})).nodeColor(()=> '#000000')
        .nodeVal((x:any)=>2+Math.sqrt(x.count)*3).linkOpacity(.27)
        .linkWidth((x:any)=>Math.min(5,.5+x.shared*.35))
        .nodeThreeObjectExtend(true).nodeThreeObject((x:any)=>{const t=new SpriteText(x.name,4,'#000000');t.position.y=9;return t})
        .onNodeClick((x:any)=>{selected={name:x.name,count:x.count};const r=1+75/Math.hypot(x.x||1,x.y||1,x.z||1);graph.cameraPosition({x:x.x*r,y:x.y*r,z:x.z*r},x,1000)});
      apply();
      obs=new ResizeObserver(()=>graph.width(container.clientWidth).height(container.clientHeight));obs.observe(container);
    })();return()=>{destroyed=true;obs?.disconnect();graph?._destructor?.()};
  });
</script>
<div class="main"><a href={`/dashboard/projects/${data.project.id}`}>← {data.project.title}</a><h1>{t('nodes.title')}</h1><p class="muted">{mode==='interviews'?t('nodes.intro'):t('nodes.introSimilarity')}</p>
<div role="group" style="display:flex;gap:6px;margin:8px 0"><button class="btn secondary" aria-pressed={mode==='interviews'} onclick={()=>mode='interviews'} style:font-weight={mode==='interviews'?700:400}>{t('nodes.modeInterviews')}</button><button class="btn secondary" aria-pressed={mode==='similarity'} onclick={()=>mode='similarity'} style:font-weight={mode==='similarity'?700:400}>{t('nodes.modeSimilarity')}</button></div><div class="panel" style="padding:8px"><div bind:this={container} style="width:100%;height:68vh;min-height:430px"></div></div>{#if selected}<div class="panel" style="margin-top:12px"><strong>{selected.name}</strong><p class="muted">{t('nodes.mentioned',{n:selected.count})}</p></div>{/if}</div>
