'use strict';
(() => {
 const i18n=window.panoptesI18n,root=document.getElementById('report-history'),status=document.getElementById('history-status');
 const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
 const local=path=>{const url=new URL(path,location.href),base=new URL('.',location.href);if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))throw Error('报告资源必须来自本站');return url.href;};
 let reports=null;
 function render(){if(!reports)return;root.replaceChildren();for(const report of reports){
  const card=node('article',undefined,'history-card');card.dataset.reportId=report.id;
  const preview=node('a',undefined,'history-preview');preview.href=local(report.url);const img=node('img');img.src=local(report.preview);img.alt=report.title[i18n.language];preview.append(img);
  const body=node('div',undefined,'history-body');body.append(node('span','已发布','source-tag'));const heading=node('h2'),link=node('a',report.title[i18n.language]);link.href=local(report.url);heading.append(link);body.append(heading);
  const meta=node('div',undefined,'history-meta');meta.append(node('span',`${report.source_photo_count} 张源照片`),node('span',`${report.playground_count} 个 Playgrounds`));body.append(meta);
  const runs=node('div',undefined,'history-runs');for(const [label,value] of [['检测来源',report.source_run_id],['重建来源',report.reconstruction_run_id]]){const row=node('div');row.append(node('span',label),node('code',value));runs.append(row);}body.append(runs);
  const open=node('a','打开报告与 Playgrounds ↗','primary-link');open.href=local(report.url);open.dataset.openReport='';body.append(open);
  const footer=node('div',undefined,'history-footer'),time=node('time',new Date(report.source_created_at).toLocaleDateString(i18n.language==='en'?'en-US':'zh-CN'));time.dateTime=report.source_created_at;time.title='来源快照时间';const commit=node('a','来源快照 '+report.source_commit.slice(0,7));commit.href=report.source_commit_url;commit.target='_blank';commit.rel='noopener';footer.append(time,commit);body.append(footer);card.append(preview,body);root.append(card);
 }status.textContent=`${reports.length} 份已发布报告`;}
 window.addEventListener('panoptes:language-change',render);
 (async()=>{try{const response=await fetch('catalog.json');if(!response.ok)throw Error('HTTP '+response.status);const data=await response.json();if(data.version!==1||!Array.isArray(data.reports))throw Error('报告目录无效');
 const seen=new Set();for(const r of data.reports){if(!r.id||seen.has(r.id)||typeof r.title?.zh!=='string'||typeof r.title?.en!=='string'||!r.source_run_id||!r.reconstruction_run_id||!Number.isInteger(r.source_photo_count)||r.source_photo_count<1||!Number.isInteger(r.playground_count)||r.playground_count<0||!Number.isFinite(Date.parse(r.source_created_at))||!/^[a-f0-9]{40}$/.test(r.source_commit)||r.source_commit_url!=='https://github.com/admin-wekruit/panoptes-workcell-report/commit/'+r.source_commit)throw Error('报告目录无效');local(r.url);local(r.preview);seen.add(r.id);}reports=data.reports;render();
 }catch(error){status.textContent='报告历史加载失败：'+error.message;status.classList.add('error-state');}})();
})();
