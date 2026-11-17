/** ThemeStore in memory: the same placement logic as the pipeline with no database. Used by the tests and `npm run eval:themes`. */
import {canonical} from './themes.ts';
import {NEAREST_STATEMENTS,EXAMPLES_PER_THEME,spread,type ThemeStore,type Candidate,type Judgement,type LinkMethod,type NewTheme} from './theme-match.ts';

export type MemoryStatement={id:string;text:string;vec:number[]};
const cos=(a:number[],b:number[])=>{let d=0,x=0,y=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i]}return d/(Math.sqrt(x*y)||1)};

export class MemoryStore implements ThemeStore{
 readonly themes=new Map<string,{id:string;name:string;description:string;namedSize:number}>();
 /** Every rewrite that changed a theme, oldest first. */
 readonly renames:{themeId:string;from:string;to:string;size:number}[]=[];
 /** statement id -> theme id -> how it got there */
 readonly links=new Map<string,Map<string,{p:number|null;method:LinkMethod}>>();
 readonly status=new Map<string,'assigned'|'pending'>();
 readonly judgements=new Map<string,Judgement[]>();
 private readonly byId:Map<string,MemoryStatement>;
 constructor(readonly statements:MemoryStatement[]){this.byId=new Map(statements.map(s=>[s.id,s]))}

 async candidates(statementId:string,limit:number):Promise<Candidate[]>{
  const me=this.byId.get(statementId)!;
  const near=this.statements.filter(s=>s.id!==statementId&&this.links.get(s.id)?.size)
   .map(s=>({s,sim:cos(me.vec,s.vec)})).sort((a,b)=>b.sim-a.sim).slice(0,NEAREST_STATEMENTS);
  const best=new Map<string,number>();
  for(const n of near)for(const t of this.links.get(n.s.id)!.keys())if(!best.has(t))best.set(t,n.sim);
  return [...best].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([id])=>{
   const t=this.themes.get(id)!;
   const examples=this.statements.filter(s=>s.id!==statementId&&this.links.get(s.id)?.has(id))
    .sort((a,b)=>cos(me.vec,b.vec)-cos(me.vec,a.vec)).slice(0,EXAMPLES_PER_THEME).map(s=>s.text);
   return {id,name:t.name,description:t.description||null,examples};
  });
 }
 async judged(statementId:string,js:Judgement[]){this.judgements.set(statementId,js)}
 async link(statementId:string,links:{themeId:string;p:number|null;method:LinkMethod}[]){
  const m=this.links.get(statementId)??new Map();this.links.set(statementId,m);
  for(const l of links)m.set(l.themeId,{p:l.p,method:l.method});
  this.status.set(statementId,'assigned');
 }
 async park(statementId:string){this.status.set(statementId,'pending')}
 async createTheme(t:NewTheme){
  const key=canonical(t.name);
  for(const x of this.themes.values())if(canonical(x.name)===key)return {id:x.id,existed:true};
  const id=`theme-${this.themes.size+1}`;this.themes.set(id,{id,name:t.name,description:t.description,namedSize:1});
  return {id,existed:false};
 }
 async growth(themeId:string){
  const t=this.themes.get(themeId)!;
  return {name:t.name,description:t.description||null,size:this.members().get(themeId)?.length??0,namedAt:t.namedSize};
 }
 async sample(themeId:string,limit:number){
  const ids=new Set(this.members().get(themeId)??[]);
  return spread(this.statements.filter(s=>ids.has(s.id)),limit).map(s=>({text:s.text,fromText:false}));
 }
 async rename(themeId:string,next:NewTheme,size:number){
  const t=this.themes.get(themeId)!;
  t.namedSize=size;
  if([...this.themes.values()].some(x=>x.id!==themeId&&canonical(x.name)===canonical(next.name)))return {renamed:false,why:'name_taken' as const};
  if(t.name===next.name&&t.description===next.description)return {renamed:false,why:'unchanged' as const};
  this.renames.push({themeId,from:t.name,to:next.name,size});
  t.name=next.name;t.description=next.description;
  return {renamed:true};
 }
 /** theme id -> statement ids */
 members():Map<string,string[]>{
  const out=new Map<string,string[]>();
  for(const [sid,m] of this.links)for(const tid of m.keys())out.set(tid,[...(out.get(tid)??[]),sid]);
  return out;
 }
}
