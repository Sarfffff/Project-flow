'use strict';
(() => {
  const configs = {
    requirements: {label:'需求', icon:'list', statuses:{draft:'待评审',ready:'已确认',doing:'进行中',review:'待验收',done:'已完成'}, finished:'done', initial:'draft', description:'记录要解决的问题和验收条件，明确每一项需求的推进状态。'},
    defects: {label:'缺陷', icon:'alert', statuses:{open:'待处理',doing:'修复中',verify:'待验证',closed:'已关闭'}, finished:'closed', initial:'open', description:'记录复现步骤、影响程度与验证结果，让问题处理有据可查。'}
  };
  const severities = {critical:'致命',major:'严重',minor:'一般',trivial:'轻微'};
  const tones = {draft:'todo',ready:'review',doing:'doing',review:'review',done:'done',open:'todo',verify:'review',closed:'done'};
  const fresh = () => ({query:'',status:'',priority:'',severity:'',project:'',sort:'newest',page:1,selected:new Set()});
  const states = {requirements:fresh(),defects:fresh()};
  let editorRevision = null;
  const size = 10;
  const dayMs = 86400000;
  function ordinal(value) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return null;
    const time = Date.parse(value+'T00:00:00Z');
    return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value ? Math.floor(time/dayMs) : null;
  }
  const iso = n => new Date(n*dayMs).toISOString().slice(0,10);
  const today = () => ordinal(localDay());
  const minDay = ordinal('0001-01-01'), maxDay = ordinal('9999-12-31');
  const scales = {day:{label:'日视图',days:28,unit:1,pixels:38},week:{label:'周视图',days:84,unit:7,pixels:16},month:{label:'月视图',days:180,unit:30,pixels:8}};
  const ganttState = {query:'',status:'',priority:'',project:'',page:1,scale:'day',start:null};
  function syncTaskFilters(){Object.assign(ganttState,{query:filters.query,status:filters.status,priority:filters.priority,project:filters.project,page:1});}
  function reset() {
    for(const kind of Object.keys(states))states[kind]=fresh();
    Object.assign(ganttState,{query:'',status:'',priority:'',project:'',page:1});
  }
  const items = kind => (data[kind]||[]).filter(row=>!projectId||row.project_id===projectId);
  const projectMatch = (row, value) => !value || (value==='none'?!row.project_id:row.project_id===value);
  const queryMatch = (row, query) => !query || [row.title,row.description,row.owner,projectOf(row)?.name].join(' ').toLocaleLowerCase().includes(query);
  function filtered(kind) {
    const s=states[kind], q=s.query.trim().toLocaleLowerCase(), rank={urgent:0,high:1,medium:2,low:3};
    return items(kind).filter(row=>queryMatch(row,q)&&(!s.status||row.status===s.status)&&(!s.priority||row.priority===s.priority)&&(!s.severity||row.severity===s.severity)&&projectMatch(row,s.project)).sort((a,b)=>s.sort==='due'?(a.due_date||'9999-99-99').localeCompare(b.due_date||'9999-99-99'):s.sort==='priority'?rank[a.priority]-rank[b.priority]||b.created_at.localeCompare(a.created_at):b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
  }
  function projectOptions(value) {
    return option('','全部项目',value)+option('none','未分配项目',value)+data.projects.map(p=>option(p.id,p.name,value)).join('');
  }
  function nav() {
    return [['tasks','check','计划管理'],['requirements','list','需求管理'],['defects','alert','缺陷管理']].map(([key,ico,label])=>`<button type="button" data-management-route="${key}" class="${section===key?'active':''}" ${section===key?'aria-current="page"':''}>${icon(ico)}${label}<span class="management-tab-count">${key==='tasks'?scope().filter(row=>row.status!=='done').length:items(key).filter(row=>row.status!==configs[key].finished).length}</span></button>`).join('');
  }
  function summary() {
    const r=items('requirements'),d=items('defects');
    return `<div class="management-summary"><button class="panel management-summary-card" data-management-route="requirements"><span class="management-summary-icon">${icon('list')}</span><div><strong>需求跟进 <b>${r.filter(x=>x.status!=='done').length}</b></strong><small>${r.filter(x=>x.status==='draft').length} 项待评审 · ${r.filter(x=>x.status==='review').length} 项待验收</small></div>${icon('arrow')}</button><button class="panel management-summary-card" data-management-route="defects"><span class="management-summary-icon defect">${icon('alert')}</span><div><strong>未关闭缺陷 <b>${d.filter(x=>x.status!=='closed').length}</b></strong><small>${d.filter(x=>x.status!=='closed'&&x.severity==='critical').length} 项致命 · ${d.filter(x=>x.status==='verify').length} 项待验证</small></div>${icon('arrow')}</button></div>`;
  }
  function metrics(kind) {
    const config=configs[kind],rows=items(kind),done=rows.filter(row=>row.status===config.finished).length;
    const pending=rows.filter(row=>row.status===config.initial).length;
    const late=rows.filter(row=>row.status!==config.finished&&row.due_date&&row.due_date<localDay()).length;
    return `<div class="stats-grid management-metrics">${[[config.label+'总数',rows.length],[config.statuses[config.initial],pending],[config.statuses[config.finished],done],['逾期未完成',late]].map(([label,n])=>`<div class="stat-card"><div class="stat-top">${label}</div><div class="stat-number">${n}</div></div>`).join('')}</div>`;
  }
  function page(kind) {
    const config=configs[kind],s=states[kind];
    if(!Array.isArray(data[kind]))return '<section class="panel empty-state"><h3>本地服务需要升级</h3><p>请重启 Flow 服务并刷新页面，新模块不会使用临时或演示数据代替数据库。</p></section>';
    return `<div class="management-root" data-management-kind="${kind}">${metrics(kind)}<section class="task-section"><div class="section-heading"><h2>${config.label}管理 <small>${items(kind).length} 项</small></h2><button class="button primary" data-management-new="${kind}">${icon('plus')}新增${config.label}</button></div><div class="panel"><div class="task-toolbar"><div class="search-field">${icon('search')}<input id="management-search" aria-label="搜索${config.label}" placeholder="搜索${config.label}、负责人…" value="${esc(s.query)}"></div><select data-management-filter="status" aria-label="筛选${config.label}状态">${option('','全部状态',s.status)}${Object.entries(config.statuses).map(([key,label])=>option(key,label,s.status)).join('')}</select><select data-management-filter="priority" aria-label="筛选${config.label}优先级">${option('','全部优先级',s.priority)}${Object.entries(priorityNames).map(([key,label])=>option(key,label,s.priority)).join('')}</select>${kind==='defects'?`<select data-management-filter="severity" aria-label="筛选严重程度">${option('','全部严重程度',s.severity)}${Object.entries(severities).map(([key,label])=>option(key,label,s.severity)).join('')}</select>`:''}${projectId?'':`<select data-management-filter="project" aria-label="筛选${config.label}项目">${projectOptions(s.project)}</select>`}<span class="toolbar-spacer"></span><select data-management-filter="sort" aria-label="${config.label}排序">${option('newest','最新创建',s.sort)}${option('due','截止日期',s.sort)}${option('priority','优先级',s.sort)}</select></div><div id="management-results">${results(kind)}</div></div><p class="management-caption">${config.description} ${kind==='requirements'?'验收条件保存在需求详情中。':'严重程度与处理优先级分别记录，不混为一谈。'}</p></section></div>`;
  }
  function results(kind) {
    const config=configs[kind],s=states[kind],rows=filtered(kind),pages=Math.max(1,Math.ceil(rows.length/size));
    s.page=Math.max(1,Math.min(pages,s.page));
    s.selected=new Set([...s.selected].filter(id=>rows.some(row=>row.id===id)));
    const shown=rows.slice((s.page-1)*size,s.page*size),hasFilter=s.query||s.status||s.priority||s.project||s.severity;
    if(!rows.length)return `<div class="empty-state"><div class="empty-orbit">${icon(hasFilter?'search':config.icon)}</div><h3>${hasFilter?'没有匹配的'+config.label:'还没有'+config.label}</h3><p>${hasFilter?'调整筛选条件后再试。':config.description}</p><button class="button primary" ${hasFilter?'data-management-clear="1"':`data-management-new="${kind}"`}>${hasFilter?'清除筛选':'新增'+config.label}</button></div>`;
    const bulk=s.selected.size?`<div class="bulk-bar"><span>已选 ${s.selected.size} 项</span><select id="management-bulk-status" aria-label="批量设置${config.label}状态"><option value="">设置状态…</option>${Object.entries(config.statuses).map(([key,label])=>option(key,label,'')).join('')}</select><button class="button danger-text small" data-management-bulk-delete="1">删除所选</button><button class="filter-clear" data-management-unselect="1">取消选择</button></div>`:'';
    return bulk+`<div class="table-wrap"><table class="management-table ${kind}"><thead><tr><th><input type="checkbox" id="management-select-all" aria-label="选择本页全部${config.label}" ${shown.every(row=>s.selected.has(row.id))?'checked':''}></th><th class="management-title-col">${config.label}名称</th><th>负责人</th><th>优先级</th>${kind==='defects'?'<th>严重程度</th>':''}<th>状态</th><th>截止日期</th><th class="action-col">操作</th></tr></thead><tbody>${shown.map(row=>rowHTML(kind,row)).join('')}</tbody></table></div><div class="table-bottom"><span>共 ${rows.length} 项${hasFilter?' · 已筛选 <button class="filter-clear" data-management-clear="1">清除筛选</button>':''} · 已保存至本机</span><div class="pagination"><span>${s.page} / ${pages}</span><button class="icon-btn" data-management-page="${s.page-1}" aria-label="上一页" ${s.page===1?'disabled':''}>${icon('left')}</button><button class="icon-btn" data-management-page="${s.page+1}" aria-label="下一页" ${s.page===pages?'disabled':''}>${icon('chevron')}</button></div></div>`;
  }
  function rowHTML(kind,row) {
    const config=configs[kind],p=projectOf(row),late=row.status!==config.finished&&row.due_date&&row.due_date<localDay();
    return `<tr><td><input type="checkbox" data-management-select="${esc(row.id)}" aria-label="选择 ${esc(row.title)}" ${states[kind].selected.has(row.id)?'checked':''}></td><td><button class="task-title" data-management-edit="${esc(row.id)}" title="${esc(row.title)}">${esc(row.title)}</button><div class="task-meta"><span class="project-dot ${p?.color||'violet'}"></span>${esc(p?.name||'未分配项目')}</div></td><td title="${esc(row.owner)}">${esc(row.owner)}</td><td><span class="priority priority-${row.priority}">${icon('flag')}${priorityNames[row.priority]}</span></td>${kind==='defects'?`<td><span class="severity severity-${row.severity}">${severities[row.severity]}</span></td>`:''}<td><select class="status-pill inline-status status-${tones[row.status]}" data-management-status="${esc(row.id)}" aria-label="${esc(row.title)}的状态">${Object.entries(config.statuses).map(([key,label])=>option(key,label,row.status)).join('')}</select></td><td class="${late?'overdue':''}" title="${esc(row.due_date)}">${dayLabel(row.due_date)}${late?' · 逾期':''}</td><td><button class="icon-btn" data-management-edit="${esc(row.id)}" aria-label="编辑 ${esc(row.title)}">${icon('edit')}</button></td></tr>`;
  }
  function updateResults() {
    if(!configs[section])return;
    const el=$('#management-results');if(el)el.innerHTML=results(section);
    const all=$('#management-select-all');
    if(all){const s=states[section],shown=filtered(section).slice((s.page-1)*size,s.page*size),n=shown.filter(row=>s.selected.has(row.id)).length;all.indeterminate=n>0&&n<shown.length;}
  }
  function field(name,label,value,maximum=10000,rows=3) {
    return `<label>${label}<textarea name="${name}" maxlength="${maximum}" rows="${rows}">${esc(value||'')}</textarea></label>`;
  }
  function open(kind,ident=null) {
    if(!ready){toast('请先连接本地数据库');return;}
    if(!Array.isArray(data[kind])){toast('请重启 Flow 服务后刷新页面');return;}
    const config=configs[kind],row=data[kind].find(x=>x.id===ident);
    if(ident&&!row){toast('记录已不存在，请刷新后重试');return;}
    const value=row||{id:'',title:'',description:'',owner:'',project_id:projectId||'',priority:'medium',status:config.initial,due_date:'',severity:'major'};
    const form=$('#management-form');form.reset();
    $('#management-dialog-title').textContent=(row?'编辑':'新增')+config.label;
    $('#management-fields').innerHTML=`<input type="hidden" name="id" value="${esc(value.id)}"><input type="hidden" name="kind" value="${kind}"><label>${config.label}名称 <em>*</em><input name="title" maxlength="160" required autocomplete="off" value="${esc(value.title)}" placeholder="简洁描述这项${config.label}"></label>${field('description',config.label+'描述',value.description)}<div class="form-grid"><label>所属项目<select name="project_id">${option('','未分配项目',value.project_id||'')}${data.projects.map(p=>option(p.id,p.name,value.project_id)).join('')}</select></label><label>负责人 <em>*</em><input name="owner" maxlength="80" required value="${esc(value.owner)}" autocomplete="off"></label><label>优先级<select name="priority">${Object.entries(priorityNames).map(([key,label])=>option(key,label,value.priority)).join('')}</select></label><label>状态<select name="status">${Object.entries(config.statuses).map(([key,label])=>option(key,label,value.status)).join('')}</select></label><label>截止日期<input type="date" name="due_date" min="0001-01-01" max="9999-12-31" value="${esc(value.due_date)}"></label>${kind==='defects'?`<label>严重程度<select name="severity">${Object.entries(severities).map(([key,label])=>option(key,label,value.severity)).join('')}</select>`:''}</div>${kind==='requirements'?field('acceptance','验收条件',value.acceptance):field('environment','发生环境 / 版本',value.environment,1000,2)+field('steps','复现步骤',value.steps)+field('expected','预期结果',value.expected)+field('actual','实际结果 / 验证记录',value.actual)}<p class="form-tip">${kind==='requirements'?'需求状态由你确认，不会根据提交次数自动完成。':'修复后可先标记待验证，通过验证后再关闭；必要时可重新打开。'}</p>`;
    $('#management-error').textContent='';$('#management-delete').hidden=!row;
    $('#management-delete').textContent='删除'+config.label;
    $('#management-save').textContent='保存'+config.label;
    editorRevision=data.revision;$('#management-dialog').showModal();
  }
  async function save(event) {
    event.preventDefault();if(busy)return;
    const form=event.target,values=Object.fromEntries(new FormData(form)),kind=values.kind,ident=values.id;
    if(!configs[kind])return;
    delete values.kind;delete values.id;values.project_id=values.project_id||null;
    busy=true;$('#management-save').disabled=true;$('#management-error').textContent='';
    try{await write('/api/'+kind+(ident?'/'+ident:''),ident?'PUT':'POST',values,editorRevision);$('#management-dialog').close();toast(configs[kind].label+'已保存');}
    catch(error){$('#management-error').textContent=error.message+(data.revision!==editorRevision?'；请取消并重新打开最新记录后编辑。':'');}
    finally{busy=false;$('#management-save').disabled=false;}
  }
  async function remove() {
    if(busy)return;
    const form=$('#management-form'),kind=form.elements.kind.value,ident=form.elements.id.value,row=data[kind]?.find(x=>x.id===ident);
    if(!row)return;
    if(!await confirmAction('删除'+configs[kind].label,`确定删除「${row.title}」？此操作无法撤销。`))return;
    await operation(async()=>{await write('/api/'+kind+'/'+ident,'DELETE',{},editorRevision);$('#management-dialog').close();},'已删除');
  }
  async function setStatus(kind,ident,status) {
    const row=data[kind]?.find(x=>x.id===ident);if(!row||row.status===status)return;
    await operation(()=>write('/api/'+kind+'/'+ident,'PUT',{...row,status}),'状态已更新');
    render();
  }
  function ganttRows() {
    const s=ganttState,q=s.query.trim().toLocaleLowerCase();
    return scope().filter(row=>queryMatch(row,q)&&projectMatch(row,s.project)&&(!s.status||row.status===s.status)&&(!s.priority||row.priority===s.priority)).sort((a,b)=>(a.start_date||'9999-99-99').localeCompare(b.start_date||'9999-99-99')||a.title.localeCompare(b.title));
  }
  function geometry(task,start,days,pixels) {
    const a=ordinal(task.start_date),b=ordinal(task.due_date);
    if(a===null||b===null||b<a)return {scheduled:false};
    const end=start+days-1;
    if(b<start||a>end)return {scheduled:true,outside:true};
    const left=Math.max(a,start),right=Math.min(b,end);
    return {scheduled:true,outside:false,left:(left-start)*pixels,width:(right-left+1)*pixels,clippedStart:a<start,clippedEnd:b>end};
  }
  function gantt(embedded=false) {
    const s=ganttState,scale=scales[s.scale],rows=ganttRows(),pages=Math.max(1,Math.ceil(rows.length/40));
    s.page=Math.max(1,Math.min(s.page,pages));
    s.start=Math.max(minDay,Math.min(s.start??today()-7,maxDay-scale.days+1));
    const start=s.start,end=start+scale.days-1,width=scale.days*scale.pixels;
    const scheduled=rows.filter(row=>ordinal(row.start_date)!==null&&ordinal(row.due_date)!==null).length;
    return `<section class="gantt-root">${embedded?`<p class="gantt-context">${scheduled} 项已排期 · ${rows.length-scheduled} 项待补充日期 · 与列表、看板共用同一批计划任务</p>`:`<div class="section-heading"><h2>甘特排期 <small>${scheduled} 项已排期</small></h2><button class="button primary small" data-action="new-task">${icon('plus')}新增计划任务</button></div>`}<div class="panel"><div class="task-toolbar"><div class="search-field">${icon('search')}<input id="gantt-search" aria-label="搜索排期任务" placeholder="搜索任务、负责人…" value="${esc(s.query)}"></div><select data-gantt-filter="status" aria-label="筛选排期状态">${option('','全部状态',s.status)}${Object.entries(statusNames).map(([key,label])=>option(key,label,s.status)).join('')}</select><select data-gantt-filter="priority" aria-label="筛选排期优先级">${option('','全部优先级',s.priority)}${Object.entries(priorityNames).map(([key,label])=>option(key,label,s.priority)).join('')}</select>${projectId?'':`<select data-gantt-filter="project" aria-label="筛选排期项目">${projectOptions(s.project)}</select>`}<span class="toolbar-spacer"></span><select id="gantt-scale" aria-label="甘特图时间尺度">${Object.entries(scales).map(([key,value])=>option(key,value.label,s.scale)).join('')}</select><button class="button secondary small" data-gantt-today="1">回到今天</button></div><div class="gantt-range"><button class="icon-btn" data-gantt-shift="-1" aria-label="上一时间段" ${start===minDay?'disabled':''}>${icon('left')}</button><label>起始日期 <input type="date" id="gantt-start" value="${iso(start)}" min="0001-01-01" max="${iso(maxDay-scale.days+1)}"></label><span>至 ${iso(end)}</span><button class="icon-btn" data-gantt-shift="1" aria-label="下一时间段" ${end===maxDay?'disabled':''}>${icon('chevron')}</button><small>点击任务条编辑排期 · 月视图为 30 天刻度</small></div>${rows.length?`<div class="gantt-scroll" tabindex="0" role="region" aria-label="任务甘特图，可横向滚动"><div class="gantt-canvas" style="--timeline-width:${width}px;--day-width:${scale.pixels}px;--tick-width:${scale.pixels*scale.unit}px"><div class="gantt-head"><div class="gantt-label">计划任务 / 负责人</div><div class="gantt-ticks">${Array.from({length:Math.ceil(scale.days/scale.unit)},(_,i)=>`<span style="width:${Math.min(scale.unit,scale.days-i*scale.unit)*scale.pixels}px">${dayLabel(iso(start+i*scale.unit))}</span>`).join('')}</div></div>${rows.slice((s.page-1)*40,s.page*40).map(row=>ganttRow(row,start,scale)).join('')}</div></div>`:`<div class="empty-state"><div class="empty-orbit">${icon('chart')}</div><h3>${scope().length?'没有匹配的计划任务':'从第一项计划开始排期'}</h3><p>甘特图直接读取计划任务的开始和截止日期，不生成演示数据。</p><button class="button secondary" ${scope().length?'data-gantt-clear="1"':'data-action="new-task"'}>${scope().length?'清除筛选':'新增计划任务'}</button></div>`}<div class="table-bottom"><span>共 ${rows.length} 项 · 无日期的任务仍保留在列表中</span><div class="pagination"><span>${s.page} / ${pages}</span><button class="icon-btn" data-gantt-page="${s.page-1}" aria-label="上一页排期" ${s.page===1?'disabled':''}>${icon('left')}</button><button class="icon-btn" data-gantt-page="${s.page+1}" aria-label="下一页排期" ${s.page===pages?'disabled':''}>${icon('chevron')}</button></div></div></div><div class="gantt-legend">${Object.entries(statusNames).map(([key,label])=>`<span><i style="background:${colors[key]}"></i>${label}</span>`).join('')}<span><i class="today-dot"></i>今天</span><small>条内填充表示手动完成进度。当前仅提供排期展示与表单编辑，不自动计算依赖或关键路径。</small></div></section>`;
  }
  function ganttRow(row,start,scale) {
    const g=geometry(row,start,scale.days,scale.pixels),p=projectOf(row),todayIndex=today()-start;
    const line=todayIndex>=0&&todayIndex<scale.days?`<span class="gantt-today-line" style="left:${(todayIndex+.5)*scale.pixels}px" aria-hidden="true"></span>`:'';
    const label=`${row.title}，${row.start_date||'未设置'} 至 ${row.due_date||'未设置'}，${statusNames[row.status]}，${row.progress}%`;
    const bar=!g.scheduled?`<button class="gantt-notice" data-edit-task="${esc(row.id)}">补充开始 / 截止日期 ${icon('edit')}</button>`:g.outside?`<button class="gantt-notice" data-gantt-locate="${esc(row.id)}">${row.due_date<iso(start)?'早于':'晚于'}当前区间 · 定位任务 ${icon('arrow')}</button>`:`<button class="gantt-bar ${g.clippedStart?'clipped-start':''} ${g.clippedEnd?'clipped-end':''}" style="left:${g.left+2}px;width:${Math.max(4,g.width-4)}px;--bar-color:${colors[row.status]}" data-edit-task="${esc(row.id)}" title="${esc(label)}" aria-label="编辑 ${esc(label)}"><span class="gantt-fill" style="width:${Math.max(0,Math.min(100,Number(row.progress)||0))}%"></span><span class="gantt-bar-text">${esc(row.title)} · ${row.progress}%</span></button>`;
    return `<div class="gantt-row"><div class="gantt-label"><button class="task-title" data-edit-task="${esc(row.id)}" title="${esc(row.title)}">${esc(row.title)}</button><small>${esc(row.owner)} · ${esc(p?.name||'未分配项目')}</small><span class="${overdue(row)?'overdue':''}">${row.start_date?esc(row.start_date):'未设置'} 至 ${row.due_date?esc(row.due_date):'未设置'}</span></div><div class="gantt-track">${line}${bar}</div></div>`;
  }
  function redrawGantt() {
    if(section!=='tasks'||mode!=='gantt')return;
    const active=document.activeElement,focus=active?.id?{id:active.id,start:active.selectionStart,end:active.selectionEnd}:null;
    const host=$('#gantt-view');if(!host)return;host.innerHTML=gantt(true);
    if(focus){const el=document.getElementById(focus.id);if(el){el.focus();if(focus.start!==null&&el.setSelectionRange)el.setSelectionRange(focus.start,focus.end);}}
  }
  document.addEventListener('submit',event=>{if(event.target===$('#management-form'))return save(event);});
  document.addEventListener('input',event=>{
    if(event.target.id==='management-search'&&configs[section]){states[section].query=event.target.value;states[section].page=1;states[section].selected.clear();updateResults();}
    if(event.target.id==='gantt-search'){ganttState.query=event.target.value;filters.query=event.target.value;ganttState.page=1;redrawGantt();}
  });
  document.addEventListener('change',async event=>{
    const el=event.target,kind=section,s=states[kind];
    if(el.dataset.managementFilter&&s){s[el.dataset.managementFilter]=el.value;s.page=1;s.selected.clear();updateResults();}
    if(el.dataset.managementSelect&&s){el.checked?s.selected.add(el.dataset.managementSelect):s.selected.delete(el.dataset.managementSelect);updateResults();}
    if(el.id==='management-select-all'&&s){filtered(kind).slice((s.page-1)*size,s.page*size).forEach(row=>el.checked?s.selected.add(row.id):s.selected.delete(row.id));updateResults();}
    if(el.dataset.managementStatus&&s)await setStatus(kind,el.dataset.managementStatus,el.value);
    if(el.id==='management-bulk-status'&&s&&el.value){await operation(async()=>{await write('/api/'+kind+'/bulk','POST',{ids:[...s.selected],action:'status',status:el.value});s.selected.clear();},'所选状态已更新');render();}
    if(el.dataset.ganttFilter){ganttState[el.dataset.ganttFilter]=el.value;filters[el.dataset.ganttFilter]=el.value;ganttState.page=1;redrawGantt();}
    if(el.id==='gantt-scale'){ganttState.scale=el.value;redrawGantt();}
    if(el.id==='gantt-start'){const n=ordinal(el.value);if(n!==null)ganttState.start=n;else toast('请选择有效日期');redrawGantt();}
  });
  document.addEventListener('click',async event=>{
    const b=event.target.closest('button');if(!b||b.disabled)return;
    const kind=section,s=states[kind];
    if(b.dataset.managementRoute){route(b.dataset.managementRoute,projectId);return;}
    if(b.dataset.managementNew){open(b.dataset.managementNew);return;}
    if(b.dataset.managementEdit&&s){open(kind,b.dataset.managementEdit);return;}
    if(b.id==='management-delete'){await remove();return;}
    if(b.dataset.managementPage&&s){s.page=Number(b.dataset.managementPage);updateResults();}
    if(b.dataset.managementClear&&s){states[kind]=fresh();render();}
    if(b.dataset.managementUnselect&&s){s.selected.clear();updateResults();}
    if(b.dataset.managementBulkDelete&&s&&s.selected.size&&!busy&&await confirmAction('批量删除'+configs[kind].label,`确定删除选中的 ${s.selected.size} 条记录？此操作无法撤销。`)){
      await operation(async()=>{await write('/api/'+kind+'/bulk','POST',{ids:[...s.selected],action:'delete'});s.selected.clear();},'所选记录已删除');render();
    }
    if(b.dataset.ganttShift){ganttState.start=(ganttState.start??today()-7)+Number(b.dataset.ganttShift)*scales[ganttState.scale].days;redrawGantt();}
    if(b.dataset.ganttToday){ganttState.start=today()-7;redrawGantt();}
    if(b.dataset.ganttPage){ganttState.page=Number(b.dataset.ganttPage);redrawGantt();}
    if(b.dataset.ganttClear){Object.assign(ganttState,{query:'',status:'',priority:'',project:'',page:1});filters=initialFilters();redrawGantt();}
    if(b.dataset.ganttLocate){const row=data.tasks.find(t=>t.id===b.dataset.ganttLocate);if(row&&ordinal(row.start_date)!==null){ganttState.start=ordinal(row.start_date)-2;redrawGantt();}}
  });
  window.FlowManagement={page,summary,nav,gantt,open,reset,ordinal,geometry,syncTaskFilters};
})();
