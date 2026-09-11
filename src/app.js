'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const paths = {
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  check:'M9 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6 M8 12l4 4L21 5',
  folder:'M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  'folder-plus':'M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 11v6 M9 14h6',
  chart:'M4 3v17h17 M8 15v-4 M13 15V7 M18 15v-7',
  plus:'M12 5v14 M5 12h14', x:'M6 6l12 12 M18 6L6 18',
  sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5',
  moon:'M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10',
  shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
  settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  home:'M3 10l9-7 9 7 M5 9v12h5v-7h4v7h5V9', refresh:'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 2 M18 18A8 8 0 0 1 5 16',
  menu:'M4 6h16 M4 12h16 M4 18h16', list:'M9 6h12 M9 12h12 M9 18h12 M3 6h1 M3 12h1 M3 18h1',
  board:'M3 4h5v16H3z M10 4h5v10h-5z M17 4h5v13h-5z', search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
  clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  circle:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', done:'M9 12l2 2 5-5 M21 12a9 9 0 1 1-5-8',
  flag:'M5 21V3 M5 3h13l-3 4 3 4H5', arrow:'M5 12h14 M13 6l6 6-6 6',
  'arrow-right':'M5 12h14 M13 6l6 6-6 6', chevron:'M9 6l6 6-6 6', left:'M15 6l-6 6 6 6',
  edit:'M16 3l5 5-12 12-6 1 1-6z M14 5l5 5', download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  upload:'M12 16V4 M7 9l5-5 5 5 M4 16v5h16v-5', alert:'M12 3L2 21h20z M12 9v5 M12 17h.01',
  spark:'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z', database:'M3 6c0-5 18-5 18 0s-18 5-18 0 M3 6v12c0 5 18 5 18 0V6 M3 12c0 5 18 5 18 0',
  activity:'M2 12h5l3-8 4 16 3-8h5'
};
const icon = (name, extra='') => `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.circle}"/></svg>`;
function fillIcons(root=document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML=icon(el.dataset.icon); }); }
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusNames = {todo:'待开始',doing:'进行中',review:'待验收',done:'已完成'};
const priorityNames = {urgent:'紧急',high:'高',medium:'中',low:'低'};
const colors = {todo:'var(--subtle)',doing:'var(--blue)',review:'var(--amber)',done:'var(--green)'};
const priorityColors = {urgent:'var(--red)',high:'var(--pink)',medium:'var(--amber)',low:'var(--blue)'};
const initialFilters = () => ({query:'',status:'',priority:'',project:'',sort:'newest'});
let data = {revision:0,projects:[],tasks:[],activities:[]};
let section='overview', projectId=null, mode='list', filters=initialFilters(), page=1, selection=new Set(), busy=false, ready=false, loaded=false, toastTimer, searchTimer;
const pageSize=8;
function localDay(d=new Date()) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function dayLabel(d) { return d ? d.slice(5).replace('-', '/') : '未设置'; }
function overdue(t) { return t.status!=='done' && t.due_date && t.due_date<localDay(); }
function soon(t) { const d=new Date(); d.setDate(d.getDate()+7); return t.status!=='done' && t.due_date && t.due_date<=localDay(d); }
const projectOf = t => data.projects.find(p=>p.id===t.project_id);
const scope = () => projectId ? data.tasks.filter(t=>t.project_id===projectId) : data.tasks;
function percent(tasks) { return tasks.length ? Math.round(tasks.filter(t=>t.status==='done').length/tasks.length*100) : 0; }
function relativeTime(value) { const delta=Math.max(0,Date.now()-new Date(value).getTime()); if(delta<60000)return '刚刚'; if(delta<3600000)return `${Math.floor(delta/60000)} 分钟前`; if(delta<86400000)return `${Math.floor(delta/3600000)} 小时前`; return new Date(value).toLocaleDateString('zh-CN'); }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent=message; $('#toast').classList.add('show'); toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3800); }
function setConnection(ok) { $('#connection').classList.toggle('offline',!ok); $('#connection').innerHTML=`<i></i>${ok?'已连接 · 本地存储':'连接中断 · 未同步'}`; }
function showError(message) { $('#error-banner').textContent=message; $('#error-banner').hidden=!message; }
async function load(silent=false) {
  try { const response=await fetch('/api/state',{cache:'no-store'}); if(!response.ok)throw new Error('服务暂时不可用'); const next=await response.json(); if(!Array.isArray(next.tasks)||!Array.isArray(next.projects))throw new Error('返回数据格式异常'); data=next; ready=true;loaded=true; setConnection(true);showError('');render(); if(!silent)toast('数据已刷新'); }
  catch(error) { ready=false;setConnection(false);showError('无法连接本地服务。请启动 Python 服务后重试；未保存的修改不会写入数据库。'); if(!loaded)$('#content').innerHTML=`<div class="empty-state"><div class="empty-orbit">${icon('database')}</div><h3>工作空间暂时离线</h3><p>请检查服务是否运行，然后重新连接。</p><button class="button primary" data-action="refresh">重新连接</button></div>`; }
}
async function write(path,method,payload) {
  if(!ready)throw new Error('当前未连接数据库，请先刷新重连');
  const response=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Flow-Request':'1','If-Match':String(data.revision)},body:JSON.stringify(payload)});
  const result=await response.json();
  if(!response.ok){if(response.status===409)await load(true);throw new Error(result.error||'保存失败');}
  data=result;setConnection(true);render();return result;
}
async function operation(fn,message) { if(busy)return;busy=true;try{await fn();if(message)toast(message);}catch(e){toast(e.message||'操作失败，请检查服务连接');}finally{busy=false;} }
function route(next,ident=null) { section=next;projectId=ident;filters=initialFilters();selection.clear();page=1;$('#sidebar').classList.remove('open');history.replaceState(null,'',`#${ident?'project/'+ident:next}`);if(loaded)render(); }
function hydrateRoute() {const value=location.hash.slice(1);if(value.startsWith('project/')){section='tasks';projectId=value.slice(8);}else if(['overview','tasks','projects','insights','settings'].includes(value)){section=value;projectId=null;} }
function render() {
  if(projectId&&!data.projects.some(p=>p.id===projectId)){projectId=null;section='tasks';history.replaceState(null,'','#tasks');}
  const project=data.projects.find(p=>p.id===projectId);
  const names={overview:'总览',tasks:'全部任务',projects:'项目空间',insights:'数据洞察',settings:'工作空间设置'};
  $('#breadcrumb').textContent=project?.name||names[section];
  const titles={overview:'让每个项目，有序发生',tasks:'每一小步，都算数',projects:'好想法，值得一个专属空间',insights:'用数据，看见每一步进展',settings:'让工作空间，更适合你'};
  const desc={overview:'从一个想法，到每一次完成。把注意力留给真正重要的事。',tasks:'收拢所有待办，在清晰的节奏里推进工作。',projects:'让目标有归属，让进度有迹可循。',insights:'所有统计均来自你的真实任务，没有预设数据。',settings:'管理界面主题与数据备份，保持简单、可靠、可控。'};
  $('#page-title').innerHTML=`${esc(project?.name||titles[section])}<span class="accent">。</span>`;
  $('#page-description').textContent=project?.description||desc[section];
  $('#eyebrow').textContent=project?'ONE PROJECT. ONE STEP AT A TIME.':{overview:'YOUR PERSONAL MISSION CONTROL',tasks:'SMALL STEPS. REAL PROGRESS.',projects:'BUILD SOMETHING THAT MATTERS',insights:'PROGRESS, NOT GUESSWORK',settings:'MAKE YOURSELF AT HOME'}[section];
  $('.heading-actions').hidden=section==='settings';
  $('#nav-task-count').textContent=data.tasks.filter(t=>t.status!=='done').length;
  $$('.nav-item[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===section&&!projectId));
  $('#project-nav').innerHTML=data.projects.length?data.projects.map(p=>`<button class="nav-item ${projectId===p.id?'active':''}" data-project="${p.id}" title="${esc(p.name)}"><span class="project-dot ${p.color}"></span><span class="project-name">${esc(p.name)}</span><span class="count">${data.tasks.filter(t=>t.project_id===p.id&&t.status!=='done').length}</span></button>`).join(''):'<div class="nav-empty">为下一个想法，新建一个项目</div>';
  selection=new Set([...selection].filter(id=>data.tasks.some(t=>t.id===id)));
  if(section==='overview')$('#content').innerHTML=stats(scope())+charts(scope())+tasksSection()+lowerPanels();
  if(section==='tasks')$('#content').innerHTML=stats(scope())+tasksSection();
  if(section==='projects')$('#content').innerHTML=projectsPage();
  if(section==='insights')$('#content').innerHTML=stats(data.tasks)+charts(data.tasks)+trend()+lowerPanels();
  if(section==='settings')$('#content').innerHTML=settingsPage();
  $('#footer-date').textContent=new Date().toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
  updateSelectAll();
}
function stats(tasks) {
  const done=tasks.filter(t=>t.status==='done').length,doing=tasks.filter(t=>t.status==='doing').length,late=tasks.filter(overdue).length;
  const items=[['任务总数',tasks.length,'',`${projectId?'当前项目':data.projects.length+' 个项目'} · ${tasks.filter(t=>t.status==='todo').length} 项待开始`,'grid'],['进行中',doing,'',`${tasks.filter(t=>t.status==='review').length} 项待验收`,'activity'],['完成率',percent(tasks),'%',`已完成 ${done} / ${tasks.length} 项任务`,'done'],['逾期任务',late,'',late?'留意这些任务，及时调整计划':'一切尽在掌握，继续保持','clock']];
  return `<div class="stats-grid">${items.map(([name,n,suffix,foot,ico],i)=>`<div class="stat-card"><div class="stat-top"><span>${name}</span><span class="stat-icon">${icon(ico)}</span></div><div class="stat-number">${n}<small>${suffix}</small></div><div class="stat-bottom"><span class="${i===2?'positive':''}">${esc(foot)}</span></div></div>`).join('')}</div>`;
}
function charts(tasks) {
  let cursor=0;const slices=Object.keys(statusNames).map(k=>{const n=tasks.filter(t=>t.status===k).length;const start=cursor;cursor+=tasks.length?n/tasks.length*100:0;return `${colors[k]} ${start}% ${cursor}%`;});
  const donut=tasks.length?`conic-gradient(${slices.join(',')})`:'var(--line)';
  const counts=Object.keys(priorityNames).map(k=>tasks.filter(t=>t.priority===k).length);const max=Math.max(1,...counts);
  const focus=tasks.filter(soon).sort((a,b)=>a.due_date.localeCompare(b.due_date)).slice(0,3);
  return `<div class="charts-grid"><section class="panel"><div class="panel-header"><h2 class="panel-title">任务状态分布</h2><span class="panel-kicker">实时统计</span></div><div class="status-chart"><div class="donut" style="background:${donut}" role="img" aria-label="任务状态分布，共 ${tasks.length} 个任务"><div class="donut-center"><strong>${tasks.length}</strong><span>全部任务</span></div></div><div class="legend">${Object.keys(statusNames).map(k=>`<div class="legend-row"><span class="dot" style="--c:${colors[k]}"></span>${statusNames[k]}<strong>${tasks.filter(t=>t.status===k).length}</strong></div>`).join('')}</div></div></section><section class="panel"><div class="panel-header"><h2 class="panel-title">优先级分布</h2><span class="panel-kicker">全部状态</span></div><div class="bars">${Object.keys(priorityNames).map((k,i)=>`<div class="bar-row"><span>${priorityNames[k]}优先级</span><div class="bar-track"><div class="bar-fill" style="--p:${counts[i]/max*100}%;--c:${priorityColors[k]}"></div></div><strong>${counts[i]}</strong></div>`).join('')}</div><div class="chart-foot">聚焦重要的事，找到你的节奏</div></section><section class="panel"><div class="panel-header"><h2 class="panel-title">${icon('spark')}近期关注</h2><span class="panel-kicker">未来 7 天 / 已逾期</span></div><div class="focus-list">${focus.length?focus.map(t=>`<button class="focus-item" data-edit-task="${t.id}"><span class="owner-avatar">${esc(t.owner.slice(0,1))}</span><div><strong>${esc(t.title)}</strong><small>${esc(t.owner)} · ${statusNames[t.status]}</small></div><span class="focus-date ${overdue(t)?'overdue':''}">${overdue(t)?'已逾期':dayLabel(t.due_date)}</span></button>`).join(''):`<div class="mini-empty">${icon('spark')}<strong>给重要的事，留一点空间</strong><span>近期没有即将到期的任务</span></div>`}</div></section></div>`;
}
function filtered() {
  const q=filters.query.trim().toLocaleLowerCase();const rank={urgent:0,high:1,medium:2,low:3};
  return scope().filter(t=>(!q||[t.title,t.description,t.owner,projectOf(t)?.name].join(' ').toLocaleLowerCase().includes(q))&&(!filters.status||t.status===filters.status)&&(!filters.priority||t.priority===filters.priority)&&(!filters.project||(filters.project==='none'?!t.project_id:t.project_id===filters.project))).sort((a,b)=>filters.sort==='due'?(a.due_date||'9999').localeCompare(b.due_date||'9999'):filters.sort==='priority'?rank[a.priority]-rank[b.priority]||b.created_at.localeCompare(a.created_at):b.created_at.localeCompare(a.created_at));
}
const option=(value,label,current)=>`<option value="${esc(value)}" ${value===current?'selected':''}>${esc(label)}</option>`;
function tasksSection() {
  return `<section class="task-section"><div class="section-heading"><h2>${projectId?'项目任务':section==='overview'?'任务工作台':'任务列表'}<small>${scope().length} 项任务</small></h2><div class="view-toggle" role="group" aria-label="任务视图"><button data-mode="list" class="${mode==='list'?'active':''}" aria-pressed="${mode==='list'}">${icon('list')}列表</button><button data-mode="board" class="${mode==='board'?'active':''}" aria-pressed="${mode==='board'}">${icon('board')}看板</button></div></div><div class="panel"><div class="task-toolbar"><div class="search-field">${icon('search')}<input id="task-search" aria-label="搜索任务" placeholder="搜索任务、负责人…" value="${esc(filters.query)}"></div><select aria-label="筛选状态" data-filter="status">${option('','全部状态',filters.status)}${Object.keys(statusNames).map(k=>option(k,statusNames[k],filters.status)).join('')}</select><select aria-label="筛选优先级" data-filter="priority">${option('','全部优先级',filters.priority)}${Object.keys(priorityNames).map(k=>option(k,priorityNames[k]+'优先级',filters.priority)).join('')}</select>${projectId?'':`<select aria-label="筛选项目" data-filter="project">${option('','全部项目',filters.project)}${option('none','未分配项目',filters.project)}${data.projects.map(p=>option(p.id,p.name,filters.project)).join('')}</select>`}<span class="toolbar-spacer"></span><select aria-label="排序方式" data-filter="sort">${option('newest','最新创建',filters.sort)}${option('due','截止时间',filters.sort)}${option('priority','优先级',filters.sort)}</select><button class="button secondary small" data-action="export">${icon('download')}备份</button></div><div id="task-results">${taskResults()}</div></div></section>`;
}
function taskResults() {
  const tasks=filtered(),pages=Math.max(1,Math.ceil(tasks.length/pageSize));page=Math.min(page,pages);
  const hasFilter=filters.query||filters.status||filters.priority||filters.project;
  if(!tasks.length)return `<div class="empty-state"><div class="empty-orbit">${icon(hasFilter?'search':'folder-plus')}</div><h3>${hasFilter?'没有找到匹配的任务':'每个大目标，都从一个小任务开始'}</h3><p>${hasFilter?'试试其他关键词，或清除筛选条件。':'这里还没有任务。创建第一项任务，开启有条理的一天。'}</p><button class="button ${hasFilter?'secondary':'primary'}" data-action="${hasFilter?'clear-filters':'new-task'}">${icon(hasFilter?'refresh':'plus')}${hasFilter?'清除筛选':'创建第一项任务'}</button></div>`;
  const selected=selection.size;
  const bulk=selected?`<div class="bulk-bar"><span>已选 ${selected} 项</span><select id="bulk-status" aria-label="批量状态"><option value="">设置状态…</option>${Object.keys(statusNames).map(k=>option(k,statusNames[k],'')).join('')}</select><button class="button danger-text small" data-action="bulk-delete">删除所选</button><button class="filter-clear" data-action="clear-selection">取消选择</button></div>`:'';
  const shown=tasks.slice((page-1)*pageSize,page*pageSize);
  return bulk+(mode==='board'?board(tasks):`<div class="table-wrap"><table><thead><tr><th><input id="select-all" type="checkbox" aria-label="选择本页全部任务"></th><th class="task-title-cell">任务名称</th><th class="owner-col">负责人</th><th class="priority-col">优先级</th><th class="status-col">状态</th><th class="progress-col">进度</th><th class="date-col">截止日期</th><th class="action-col"><span class="sr-only">操作</span></th></tr></thead><tbody>${shown.map(taskRow).join('')}</tbody></table></div>`)+`<div class="table-bottom"><span>共 ${tasks.length} 项${hasFilter?' · 已筛选':''} · ${mode==='board'?'拖动卡片切换状态':'更改自动保存至本机'} ${hasFilter?'<button class="filter-clear" data-action="clear-filters">清除筛选</button>':''}</span>${mode==='list'?`<div class="pagination"><span>${page} / ${pages}</span><button class="icon-btn" data-page="${page-1}" aria-label="上一页" ${page===1?'disabled':''}>${icon('left')}</button><button class="icon-btn" data-page="${page+1}" aria-label="下一页" ${page===pages?'disabled':''}>${icon('chevron')}</button></div>`:''}</div>`;
}
function taskRow(t) {
  const p=projectOf(t);
  return `<tr><td><input type="checkbox" data-select="${t.id}" aria-label="选择 ${esc(t.title)}" ${selection.has(t.id)?'checked':''}></td><td><button class="task-title" data-edit-task="${t.id}" title="${esc(t.title)}">${esc(t.title)}</button><div class="task-meta"><span class="project-dot ${p?.color||'violet'}"></span>${esc(p?.name||'未分配项目')}</div></td><td><div class="owner-cell"><span class="owner-avatar">${esc(t.owner.slice(0,1))}</span><span>${esc(t.owner)}</span></div></td><td><span class="priority priority-${t.priority}">${icon('flag')}${priorityNames[t.priority]}</span></td><td><select class="status-pill inline-status status-${t.status}" data-status-task="${t.id}" aria-label="${esc(t.title)}的状态">${Object.keys(statusNames).map(k=>option(k,statusNames[k],t.status)).join('')}</select></td><td><div class="progress-cell"><div class="progress-track"><div class="progress-fill" style="--p:${t.progress}%;--c:${colors[t.status]}"></div></div><span>${t.progress}%</span></div></td><td class="${overdue(t)?'overdue':''}" title="${esc(t.due_date)}">${dayLabel(t.due_date)}${overdue(t)?' · 逾期':''}</td><td><button class="icon-btn" data-edit-task="${t.id}" aria-label="编辑 ${esc(t.title)}">${icon('edit')}</button></td></tr>`;
}
function board(tasks) {
  return `<div class="board">${Object.keys(statusNames).map(k=>`<section class="board-column" data-drop-status="${k}" aria-label="${statusNames[k]}任务"><div class="board-heading"><span class="status-pill status-${k}"><span class="dot"></span>${statusNames[k]}</span><span class="count">${tasks.filter(t=>t.status===k).length}</span><button class="icon-btn" data-new-status="${k}" aria-label="新建${statusNames[k]}任务">${icon('plus')}</button></div>${tasks.filter(t=>t.status===k).map(t=>{const p=projectOf(t);return `<article class="task-card" draggable="true" data-drag-task="${t.id}"><div class="card-top"><div class="task-meta"><span class="project-dot ${p?.color||'violet'}"></span>${esc(p?.name||'未分配')}</div><button class="icon-btn" data-edit-task="${t.id}" aria-label="编辑 ${esc(t.title)}">${icon('edit')}</button></div><button class="task-title" data-edit-task="${t.id}">${esc(t.title)}</button><span class="priority priority-${t.priority}">${icon('flag')}${priorityNames[t.priority]}优先级</span><div class="progress-track"><div class="progress-fill" style="--p:${t.progress}%;--c:${colors[t.status]}"></div></div><div class="card-bottom"><span class="${overdue(t)?'overdue':''}">${dayLabel(t.due_date)}${overdue(t)?' · 逾期':''}</span><span>${t.progress}%</span><span class="owner-avatar" title="${esc(t.owner)}">${esc(t.owner.slice(0,1))}</span></div></article>`;}).join('')||'<div class="board-placeholder">拖动任务到这里<br>或点击 + 添加任务</div>'}</section>`).join('')}</div>`;
}
function renderResults() {const result=$('#task-results');if(result){result.innerHTML=taskResults();updateSelectAll();}}
function updateSelectAll() {const el=$('#select-all');if(!el)return;const rows=filtered().slice((page-1)*pageSize,page*pageSize);const count=rows.filter(t=>selection.has(t.id)).length;el.checked=rows.length>0&&count===rows.length;el.indeterminate=count>0&&count<rows.length;}
function lowerPanels() {
  return `<div class="lower-grid"><section class="panel"><div class="panel-header"><h2 class="panel-title">项目进展</h2><button class="button text" data-nav="projects">查看全部 ${icon('arrow')}</button></div><div class="projects-summary">${data.projects.slice(0,3).map(p=>{const tasks=data.tasks.filter(t=>t.project_id===p.id);return `<div class="project-summary-row"><span class="project-tile ${p.color}">${icon('folder')}</span><div class="project-summary-info"><button class="task-title" data-project="${p.id}">${esc(p.name)}</button><small>${tasks.filter(t=>t.status==='done').length} / ${tasks.length} 项任务已完成</small></div><div class="progress-track"><div class="progress-fill" style="--p:${percent(tasks)}%"></div></div><span>${percent(tasks)}%</span></div>`;}).join('')||'<div class="mini-empty"><strong>你的下一段旅程，从这里开始</strong><span>创建项目，将相关任务汇集到一起</span><button class="button text" data-action="new-project">新建项目 →</button></div>'}</div></section><section class="panel"><div class="panel-header"><h2 class="panel-title">最近动态</h2><span class="panel-kicker">活动记录</span></div><div class="activity-list">${data.activities.slice(0,3).map(a=>`<div class="activity-item"><div>${esc(a.text)}<small>${relativeTime(a.created_at)}</small></div></div>`).join('')||'<div class="mini-empty"><strong>还没有活动记录</strong><span>每一次行动，都会在这里留下足迹</span></div>'}</div></section></div>`;
}
function projectsPage() {
  return `<div class="section-heading"><h2>全部项目 <small>${data.projects.length} 个项目</small></h2><span class="panel-kicker">保持聚焦，稳步推进</span></div><div class="project-grid">${data.projects.map(p=>{const tasks=data.tasks.filter(t=>t.project_id===p.id);return `<article class="panel project-card"><div class="project-card-top"><span class="project-tile ${p.color}">${icon('folder')}</span><button class="icon-btn" data-edit-project="${p.id}" aria-label="编辑项目 ${esc(p.name)}">${icon('edit')}</button></div><h3>${esc(p.name)}</h3><p>${esc(p.description||'为每个想法，留出实现的空间。')}</p><div class="progress-track"><div class="progress-fill" style="--p:${percent(tasks)}%"></div></div><div class="project-card-foot"><span>${tasks.filter(t=>t.status==='done').length} / ${tasks.length} 项完成 · ${percent(tasks)}%</span><button class="button text" data-project="${p.id}">进入项目 ${icon('arrow')}</button></div></article>`;}).join('')}<button class="panel project-card add-project" data-action="new-project">${icon('plus')}创建新项目<span class="panel-kicker">给新的想法一个开始</span></button></div>`;
}
function trend() {
  const dates=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-6+i);return localDay(d);});
  const counts=dates.map(d=>data.tasks.filter(t=>t.status==='done'&&t.completed_at&&localDay(new Date(t.completed_at))===d).length),max=Math.max(1,...counts);
  return `<section class="panel trend-panel"><h3>近 7 天完成记录</h3><div class="trend-chart">${dates.map((d,i)=>`<div class="trend-column"><span>${counts[i]}</span><div class="trend-bar" style="--h:${counts[i]/max*95}px" title="${d} 完成 ${counts[i]} 项"></div><small>${dayLabel(d)}</small></div>`).join('')}</div><p class="trend-note">按当前已完成任务的最近完成时间统计；重新打开或删除任务后，统计相应更新。</p></section>`;
}
function settingsPage() {
  return `<div class="settings-grid"><section class="panel settings-card"><h2>选择你的工作氛围</h2><p>不同的光线，同样的专注。主题设置仅保存在当前浏览器。</p><div class="theme-options">${[['dark','深空紫'],['light','晨光白'],['aurora','极光绿']].map(([k,n])=>`<button class="theme-choice ${document.documentElement.dataset.theme===k?'active':''}" data-theme-choice="${k}"><span class="theme-preview ${k}"></span>${n}</button>`).join('')}</div></section><section class="panel settings-card"><h2>数据备份与恢复</h2><p>导出全部项目和任务为 JSON 备份。恢复备份将替换现有项目与任务，请先导出当前数据。</p><div class="settings-actions"><button class="button primary" data-action="export">${icon('download')}导出备份</button><button class="button secondary" data-action="import">${icon('upload')}恢复备份</button></div></section><section class="panel settings-card"><h2>你的数据，由你掌控</h2><div class="storage-badge">${icon('database')}SQLite · 本地持久化</div><p>当前共有 ${data.projects.length} 个项目、${data.tasks.length} 个任务。数据库位于应用目录的 <code>data/flow.sqlite3</code>，刷新页面、切换主题或重启应用不会丢失已保存内容。</p><button class="button secondary" data-action="refresh">${icon('refresh')}检查连接并刷新</button></section><section class="panel settings-card"><h2>关于这个版本</h2><ul class="security-list"><li>个人使用版，无登录和复杂角色权限。</li><li>服务仅监听本机地址，不开放公网访问。</li><li>不加载第三方脚本，不向外部上传任务数据。</li><li>删除前确认、输入校验、多窗口冲突检测。</li><li>快捷键 N 新建任务，G 返回总览，Esc 关闭窗口。</li></ul></section></div>`;
}
function applyTheme(theme) {if(!['dark','light','aurora'].includes(theme))theme='dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('flow-theme',theme);}catch{}const btn=$('.theme-toggle');btn.innerHTML=icon(theme==='light'?'moon':'sun');btn.setAttribute('aria-label',theme==='light'?'切换深色主题':'切换浅色主题');if(loaded&&section==='settings')render();}
function confirmAction(title,message) {return new Promise(resolve=>{const d=$('#confirm-dialog');$('#confirm-title').textContent=title;$('#confirm-message').textContent=message;d.returnValue='';d.addEventListener('close',()=>resolve(d.returnValue==='confirm'),{once:true});d.showModal();});}
function openTask(ident=null,status='todo') {
  if(!ready){toast('请先连接本地数据库');return;}
  const task=data.tasks.find(t=>t.id===ident);if(ident&&!task){toast('该任务已不存在');return;}
  const form=$('#task-form');form.reset();
  $('#task-project').innerHTML=option('','未分配项目','')+data.projects.map(p=>option(p.id,p.name,'')).join('');
  const values=task||{id:'',title:'',description:'',project_id:projectId||'',owner:'',priority:'medium',status,progress:status==='done'?100:0,start_date:localDay(),due_date:''};
  for(const [key,value] of Object.entries(values)){const field=form.elements.namedItem(key);if(field)field.value=value??'';}
  $('#task-dialog-title').textContent=task?'编辑任务':'新建任务';$('#delete-task').hidden=!task;$('#task-error').textContent='';updateProgress();form.elements.due_date.min=form.elements.start_date.value;$('#task-dialog').showModal();
}
function openProject(ident=null) {
  if(!ready){toast('请先连接本地数据库');return;}
  const project=data.projects.find(p=>p.id===ident);if(ident&&!project){toast('该项目已不存在');return;}
  const form=$('#project-form');form.reset();const values=project||{id:'',name:'',description:'',color:'violet'};
  for(const key of ['id','name','description','color'])form.elements.namedItem(key).value=values[key];
  $('#project-dialog-title').textContent=project?'编辑项目':'新建项目';$('#delete-project').hidden=!project;$('#project-error').textContent='';$('#project-dialog').showModal();
}
function updateProgress() {const f=$('#task-form');const done=f.elements.status.value==='done';f.elements.progress.disabled=done;$('#progress-output').textContent=(done?100:f.elements.progress.value)+'%';}
async function saveForm(event,type) {
  event.preventDefault();if(busy)return;const form=event.target;const values=Object.fromEntries(new FormData(form));const ident=values.id;delete values.id;
  if(type==='task'){values.progress=values.status==='done'?100:Number(values.progress||0);values.project_id=values.project_id||null;}
  const err=$(`#${type}-error`);err.textContent='';busy=true;const submit=form.querySelector('[type="submit"]');submit.disabled=true;
  try{await write(`/api/${type}s${ident?'/'+ident:''}`,ident?'PUT':'POST',values);$(`#${type}-dialog`).close();toast(`${type==='task'?'任务':'项目'}已保存`);}catch(e){err.textContent=e.message||'无法连接服务，内容尚未保存，请重试';}finally{busy=false;submit.disabled=false;}
}
async function deleteRecord(type) {
  const form=$(`#${type}-form`),ident=form.elements.id.value;
  const record=data[type+'s'].find(x=>x.id===ident);if(!record)return;
  const name=type==='task'?record.title:record.name;
  if(type==='project'&&data.tasks.some(t=>t.project_id===ident)){$('#project-error').textContent='项目下仍有任务，请先移动或删除这些任务，再删除项目。';return;}
  if(!await confirmAction(`删除${type==='task'?'任务':'项目'}`,`确定删除「${name}」？此操作无法撤销。`))return;
  await operation(async()=>{await write(`/api/${type}s/${ident}`,'DELETE',{});$(`#${type}-dialog`).close();},'已删除');
}
async function updateStatus(ident,status) {const task=data.tasks.find(t=>t.id===ident);if(!task||task.status===status)return;await operation(()=>write('/api/tasks/'+ident,'PUT',{...task,status,progress:status==='done'?100:Math.min(task.progress,99)}),'状态已更新');render();}
async function exportBackup() {
  if(!ready){toast('请先连接数据库');return;}
  try{const response=await fetch('/api/export');if(!response.ok)throw new Error('备份导出失败');const body=await response.blob();const url=URL.createObjectURL(body),a=document.createElement('a');a.href=url;a.download=`flow-backup-${localDay()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);toast('备份已生成，请妥善保存下载的 JSON 文件');}catch(e){toast(e.message);}
}
async function restoreBackup(file) {
  if(!file)return;if(file.size>7.5*1024*1024){toast('备份文件不能超过 7.5 MB');return;}
  try{const backup=JSON.parse(await file.text());if(backup.format!=='flow-backup-v1'||!Array.isArray(backup.projects)||!Array.isArray(backup.tasks))throw new Error('不是有效的 Flow 备份文件');if(!await confirmAction('恢复备份，替换现有数据',`将导入 ${backup.projects.length} 个项目、${backup.tasks.length} 个任务，并替换当前全部项目和任务。请确保已经导出当前备份。是否继续？`))return;await operation(()=>write('/api/restore','POST',{backup}),'备份已恢复');}catch(e){toast(e instanceof SyntaxError?'JSON 文件无法解析，请使用完整备份文件':e.message);}
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('button,a');if(!button)return;
  if(button.dataset.close){if(!busy)$(`#${button.dataset.close}`).close();return;}
  if(button.dataset.nav){route(button.dataset.nav);return;}
  if(button.dataset.project){route('tasks',button.dataset.project);return;}
  if(button.dataset.editTask){openTask(button.dataset.editTask);return;}
  if(button.dataset.editProject){openProject(button.dataset.editProject);return;}
  if(button.dataset.newStatus){openTask(null,button.dataset.newStatus);return;}
  if(button.dataset.mode){mode=button.dataset.mode;selection.clear();render();return;}
  if(button.dataset.page){page=Number(button.dataset.page);renderResults();return;}
  if(button.dataset.themeChoice){applyTheme(button.dataset.themeChoice);return;}
  const action=button.dataset.action;
  if(action==='new-task')openTask();
  if(action==='new-project')openProject();
  if(action==='theme')applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');
  if(action==='menu')$('#sidebar').classList.toggle('open');
  if(action==='refresh')await load();
  if(action==='export')await exportBackup();
  if(action==='import')$('#import-file').click();
  if(action==='clear-filters'){filters=initialFilters();page=1;selection.clear();render();}
  if(action==='clear-selection'){selection.clear();renderResults();}
  if(action==='bulk-delete'&&selection.size&&await confirmAction('批量删除任务',`确定删除选中的 ${selection.size} 个任务？此操作无法撤销。`))await operation(async()=>{await write('/api/tasks/bulk','POST',{ids:[...selection],action:'delete'});selection.clear();renderResults();},'所选任务已删除');
});
document.addEventListener('input',event=>{
  if(event.target.id==='task-search'){filters.query=event.target.value;page=1;selection.clear();clearTimeout(searchTimer);searchTimer=setTimeout(renderResults,100);}
  if(event.target.name==='progress')updateProgress();
});
document.addEventListener('change',async event=>{
  const el=event.target;
  if(el.dataset.filter){filters[el.dataset.filter]=el.value;page=1;selection.clear();renderResults();}
  if(el.dataset.select){el.checked?selection.add(el.dataset.select):selection.delete(el.dataset.select);renderResults();}
  if(el.id==='select-all'){filtered().slice((page-1)*pageSize,page*pageSize).forEach(t=>el.checked?selection.add(t.id):selection.delete(t.id));renderResults();}
  if(el.dataset.statusTask)await updateStatus(el.dataset.statusTask,el.value);
  if(el.id==='bulk-status'&&el.value){await operation(async()=>{await write('/api/tasks/bulk','POST',{ids:[...selection],action:'status',status:el.value});selection.clear();renderResults();},'所选任务状态已更新');}
  if(el.name==='status'&&el.closest('#task-form'))updateProgress();
  if(el.name==='start_date')$('#task-form').elements.due_date.min=el.value;
  if(el.id==='import-file'){await restoreBackup(el.files[0]);el.value='';}
});
let dragId=null;
document.addEventListener('dragstart',e=>{const card=e.target.closest('[data-drag-task]');if(card){dragId=card.dataset.dragTask;e.dataTransfer.setData('text/plain',dragId);e.dataTransfer.effectAllowed='move';}});
document.addEventListener('dragover',e=>{const col=e.target.closest('[data-drop-status]');if(col&&dragId){e.preventDefault();col.classList.add('drag-over');}});
document.addEventListener('dragleave',e=>{const col=e.target.closest('[data-drop-status]');if(col&&!col.contains(e.relatedTarget))col.classList.remove('drag-over');});
document.addEventListener('drop',async e=>{const col=e.target.closest('[data-drop-status]');if(!col||!dragId)return;e.preventDefault();const id=dragId;dragId=null;$$('.drag-over').forEach(x=>x.classList.remove('drag-over'));await updateStatus(id,col.dataset.dropStatus);});
document.addEventListener('dragend',()=>{dragId=null;$$('.drag-over').forEach(x=>x.classList.remove('drag-over'));});
document.addEventListener('keydown',event=>{if(event.ctrlKey||event.metaKey||event.altKey||event.target.closest('input,textarea,select,[contenteditable="true"]')||$('dialog[open]'))return;if(event.key.toLowerCase()==='n'){event.preventDefault();openTask();}if(event.key.toLowerCase()==='g')route('overview');});
$('#task-form').addEventListener('submit',e=>saveForm(e,'task'));
$('#project-form').addEventListener('submit',e=>saveForm(e,'project'));
$('#delete-task').addEventListener('click',()=>deleteRecord('task'));
$('#delete-project').addEventListener('click',()=>deleteRecord('project'));
$$('.editor-dialog').forEach(d=>d.addEventListener('cancel',e=>{if(busy)e.preventDefault();}));
window.addEventListener('hashchange',()=>{hydrateRoute();filters=initialFilters();page=1;selection.clear();if(loaded)render();});
window.addEventListener('storage',e=>{if(e.key==='flow-theme')applyTheme(e.newValue);});
fillIcons();try{applyTheme(localStorage.getItem('flow-theme')||'dark');}catch{applyTheme('dark');}
hydrateRoute();load(true);
