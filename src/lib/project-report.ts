/** The emailed project report: numbers, the top themes and the top insights of the three leading themes.
 * Pure rendering (subject, plain text and HTML) with no server or database dependencies, so it is unit-testable.
 * The data comes from `loadReport` in $lib/server/report.ts.
 */
import type {TFunction} from './i18n';

export const TOP_THEMES=10;
export const INSIGHT_THEMES=3;

export type ReportInsight={title:string;description:string;statements:number;sources:number};
/** `sources` counts every linked source, recordings and reference texts alike. Only the leading themes carry insights. */
/** `bySource`: how the theme's statements split over its sources, largest first, so one dominant source is visible. */
export type ReportTheme={name:string;description:string|null;sources:number;statements:number;bySource:{title:string;statements:number}[];insights:ReportInsight[]};
/** Sources named in a theme's split before the rest are summed up as "+n more". */
export const SPLIT_SOURCES=4;
export type ReportData={
  project:{title:string;question:string};
  stats:{recordings:number;texts:number;statements:number;themes:number;insights:number};
  /** Best first: most linked sources, then most statements. */
  themes:ReportTheme[];
  url:string;
};

const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export function renderReport(d:ReportData,t:TFunction):{subject:string;text:string;html:string}{
  const s=d.stats;
  const stats:[string,number][]=[
    [t('report.mail.sources'),s.recordings+s.texts],[t('report.mail.recordings'),s.recordings],[t('report.mail.texts'),s.texts],
    [t('report.mail.statements'),s.statements],[t('report.mail.themes'),s.themes],[t('report.mail.insights'),s.insights]
  ];
  const themeMeta=(th:ReportTheme)=>t('report.mail.themeMeta',{sources:th.sources,statements:th.statements});
  const split=(th:ReportTheme)=>[...th.bySource.slice(0,SPLIT_SOURCES).map(b=>`${b.title}: ${b.statements}`),
    ...(th.bySource.length>SPLIT_SOURCES?[t('report.mail.more',{n:th.bySource.length-SPLIT_SOURCES})]:[])].join(' · ');
  const insightMeta=(i:ReportInsight)=>t('report.mail.insightMeta',{statements:i.statements,sources:i.sources});
  const leading=d.themes.slice(0,INSIGHT_THEMES);

  const text=[
    d.project.title,d.project.question,'',
    t('report.mail.stats').toUpperCase(),...stats.map(([k,v])=>`${k}: ${v}`),'',
    t('report.mail.topThemes').toUpperCase(),
    ...(d.themes.length?d.themes.map((th,n)=>`${n+1}. ${th.name} (${themeMeta(th)})${th.bySource.length?`\n   ${split(th)}`:''}${th.description?`\n   ${th.description}`:''}`):[t('report.mail.noThemes')]),'',
    t('report.mail.topInsights').toUpperCase(),
    ...(leading.length?leading.flatMap(th=>[`${th.name}`,...(th.insights.length
      ?th.insights.map(i=>`  - ${i.title}${i.description?`\n    ${i.description}`:''}\n    (${insightMeta(i)})`)
      :[`  ${t('report.mail.noInsights')}`]),'']):[t('report.mail.noThemes'),'']),
    t('report.mail.note'),'',`${t('report.mail.open')}: ${d.url}`
  ].join('\n');

  const h2=(x:string)=>`<h2 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:28px 0 10px">${esc(x)}</h2>`;
  const muted='color:#666;font-size:13px';
  const html=`<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#000;max-width:600px;margin:0 auto;padding:8px 16px;line-height:1.45">
<h1 style="font-size:24px;margin:0 0 4px">${esc(d.project.title)}</h1>
<p style="${muted};font-size:15px;margin:0">${esc(d.project.question)}</p>
${h2(t('report.mail.stats'))}
<table style="border-collapse:collapse;width:100%">${stats.map(([k,v])=>`<tr><td style="padding:6px 0;border-bottom:1px solid #ddd">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #ddd;text-align:right;font-weight:700">${v}</td></tr>`).join('')}</table>
${h2(t('report.mail.topThemes'))}
${d.themes.length?`<ol style="padding-left:20px;margin:0">${d.themes.map(th=>`<li style="margin-bottom:10px"><strong>${esc(th.name)}</strong> <span style="${muted}">${esc(themeMeta(th))}</span>${th.bySource.length?`<br><span style="${muted}">${esc(split(th))}</span>`:''}${th.description?`<br><span style="${muted}">${esc(th.description)}</span>`:''}</li>`).join('')}</ol>`:`<p style="${muted}">${esc(t('report.mail.noThemes'))}</p>`}
${h2(t('report.mail.topInsights'))}
${leading.length?leading.map(th=>`<h3 style="font-size:16px;margin:16px 0 6px">${esc(th.name)}</h3>${th.insights.length
  ?`<ul style="padding-left:20px;margin:0">${th.insights.map(i=>`<li style="margin-bottom:10px"><strong>${esc(i.title)}</strong>${i.description?`<br>${esc(i.description)}`:''}<br><span style="${muted}">${esc(insightMeta(i))}</span></li>`).join('')}</ul>`
  :`<p style="${muted};margin:0">${esc(t('report.mail.noInsights'))}</p>`}`).join(''):`<p style="${muted}">${esc(t('report.mail.noThemes'))}</p>`}
<p style="${muted};margin-top:28px">${esc(t('report.mail.note'))}</p>
<p><a href="${esc(d.url)}" style="color:#000;font-weight:700">${esc(t('report.mail.open'))}</a></p>
</div>`;
  return {subject:t('report.mail.subject',{title:d.project.title}),text,html};
}
