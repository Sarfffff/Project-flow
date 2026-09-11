'use strict';
(() => {
  const state = {started:false, error:'', info:'', account:{login:'',token_configured:false,links:[]},
    repos:[], repoPage:1, repoNext:false, repo:null, branch:'', branches:[], branchPage:1, branchNext:false,
    tab:'commits', mine:false, commits:[], commitsLoaded:false, commitPage:1, commitNext:false, cached:false, syncedAt:null,
    newShas:[], detail:null, detailPage:1, path:'', content:null, poll:false};
  const jobs = new Map();
  let workspaceVersion = 0, paintedVersion = -1;
  const busy = scope => jobs.has(scope);
  const loading = scope => busy(scope)?`<div class="gh-loading" role="status"><span class="spinner"></span>${esc(jobs.get(scope).label)}</div>`:'';
  function cancel(scope) { jobs.get(scope)?.controller.abort(); jobs.delete(scope); }
  function resetWorkspace() {
    workspaceVersion++;
    for(const scope of ['workspace','branches','commits','files','detail'])cancel(scope);
    Object.assign(state,{repo:null,branch:'',branches:[],branchPage:1,branchNext:false,detail:null,
      commits:[],commitsLoaded:false,content:null,path:'',tab:'commits',cached:false,newShas:[],syncedAt:null,commitPage:1,commitNext:false});
  }
  const encode = encodeURIComponent;
  const ghURL = (repo, tail='') => 'https://github.com/' + repo.split('/').map(encode).join('/') + tail;
  const external = (url, title) => `<a class="button secondary small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>`;
  const dateText = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未同步';
  const link = () => state.account.links.find(x => x.repo.toLowerCase()===state.repo?.full_name.toLowerCase() && x.branch===state.branch);
  const button = (action, title, extra='', disabled=false) => `<button type="button" class="button secondary small" data-gh="${action}" ${extra} ${disabled?'disabled':''}>${title}</button>`;

  async function api(endpoint, params={}, method='GET', signal) {
    const response = await fetch('/api/github/' + endpoint + (method==='GET'?'?'+new URLSearchParams(params):''), {
      method, signal, cache:'no-store', headers:{'X-Flow-Request':'1', ...(method==='GET'?{}:{'Content-Type':'application/json'})},
      ...(method==='GET'?{}:{body:JSON.stringify(params)})
    });
    const result = await response.json();
    if(!response.ok)throw new Error(result.error || 'GitHub 请求失败');
    return result;
  }
  async function run(fn, scope='workspace', label='正在读取仓库…', replace=false) {
    if(busy(scope)){if(!replace)return;cancel(scope);}
    const job={controller:new AbortController(),label},version=workspaceVersion;
    jobs.set(scope,job);
    const current=()=>jobs.get(scope)===job && (!['workspace','branches','commits','files','detail','sync'].includes(scope)||version===workspaceVersion);
    state.error='';state.info='';paint();
    try{await fn({signal:job.controller.signal,current});}
    catch(error){if(current()&&error.name!=='AbortError')state.error=error.message||'连接失败，请重试';}
    finally{if(jobs.get(scope)===job){jobs.delete(scope);paint();}}
  }
  function repos(page=1, refresh=false) {
    return run(async ctx=>{
      const result=await api('repos',{page,refresh:refresh?'1':'0'},'GET',ctx.signal);
      if(!ctx.current())return;
      state.repos=result.items;state.repoPage=page;state.repoNext=result.has_next;
    },'repos','正在更新仓库列表…',true);
  }
  function commits(page=1, refresh=false, fallback=false) {
    if(!state.repo)return;
    const repo=state.repo.full_name,branch=state.branch,mine=state.mine,tracked=link();
    return run(async ctx=>{
      try{
        const result=await api('commits',{repo,branch,page,mine:mine?'1':'0',refresh:refresh?'1':'0'},'GET',ctx.signal);
        if(!ctx.current())return;
        state.commits=result.items;state.commitsLoaded=true;state.commitPage=page;state.commitNext=result.has_next;state.cached=false;state.newShas=[];
      }catch(error){
        if(fallback&&tracked&&ctx.current()&&error.name!=='AbortError'){
          try{
            const cached=await api('cached',{id:tracked.id},'GET',ctx.signal);
            if(ctx.current()){state.commits=cached.items;state.commitsLoaded=true;state.cached=true;state.syncedAt=cached.synced_at;}
          }catch{}
        }
        throw error;
      }
    },'commits','正在更新提交记录，已有内容仍可查看…',true);
  }
  function contents(path='', refresh=false) {
    if(!state.repo)return;
    const repo=state.repo.full_name,branch=state.branch;
    return run(async ctx=>{
      const result=await api('contents',{repo,branch,path,refresh:refresh?'1':'0'},'GET',ctx.signal);
      if(ctx.current()){state.content=result;state.path=path;}
    },'files','正在读取文件内容，已有内容仍可查看…',true);
  }
  function branches(page=1) {
    if(!state.repo)return;
    const repo=state.repo.full_name;
    return run(async ctx=>{
      const result=await api('branches',{repo,page},'GET',ctx.signal);
      if(!ctx.current())return;
      state.branches=page===1?result.items:state.branches.concat(result.items);
      state.branchPage=page;state.branchNext=result.has_next;
      if(!state.branches.length)state.info='这个仓库还没有分支或提交。';
    },'branches','正在读取分支…',true);
  }
  function selectRepo(name, branch='') {
    resetWorkspace();
    return run(async ctx=>{
      const known=state.repos.find(r=>r.full_name.toLowerCase()===name.toLowerCase());
      const repo=known||await api('repo',{repo:name},'GET',ctx.signal);
      if(!ctx.current())return;
      state.repo=repo;state.branch=branch||repo.default_branch||'';
      paint();
      await Promise.all([branches(),commits(1,false,true)]);
    },'workspace','正在打开仓库…');
  }
  async function sync(ctx, tracked=link()) {
    if(!tracked)throw new Error('请先关联此仓库分支');
    const result=await api('sync',{id:tracked.id},'POST');
    const saved=state.account.links.find(l=>l.id===tracked.id);
    if(saved)saved.synced_at=result.synced_at;
    if(!ctx.current())return;
    cancel('files');state.content=null;
    state.commits=result.items;state.commitsLoaded=true;state.newShas=result.new_shas;state.syncedAt=result.synced_at;
    state.cached=true;state.commitPage=1;state.commitNext=false;
    state.info=(result.first_sync?'已建立最近提交基线，不把已有提交算作新提交。':`本次发现 ${result.new_shas.length} 条新出现的提交。`)
      +(result.history_limited?' 跟踪快照保留最近 100 条；更早记录请使用在线历史。':'')
      +(result.gap?' 与上次快照没有重叠，可能遗漏更早提交或分支历史已重写。':'');
    if(state.tab==='files')await contents(state.path);
  }
  function startSync() {
    cancel('commits');cancel('files');
    return run(sync,'sync','正在同步最新提交…');
  }
  function showDetail(sha, page=1, refresh=false) {
    const repo=state.repo.full_name;
    return run(async ctx=>{
      const result=await api('commit',{repo,sha,page,refresh:refresh?'1':'0'},'GET',ctx.signal);
      if(ctx.current()){state.detail=result;state.detailPage=page;}
    },'detail','正在读取提交差异…',true);
  }
  function accountPanel() {
    const account=state.account;
    return `<section class="panel gh-account" aria-busy="${busy('account')}">${loading('account')}<div class="gh-row"><div><h2>GitHub 连接</h2><p>${account.login?'当前账号：'+esc(account.login):'尚未连接个人账号'} · ${account.token_configured?'已配置只读访问令牌':'公开访问模式'}</p></div><button class="button primary" data-nav="settings">${account.login?'管理 GitHub 连接':'前往设置连接'}</button>${button('reload','刷新仓库','',!account.login)}</div><p class="gh-muted">账号和私有仓库授权统一在工作空间设置中管理。仅调用 GitHub 读取接口，不修改远端仓库。</p></section>`;
  }
  function trackedPanel() {
    const links=state.account.links;
    return `<section class="panel gh-tracked">${loading('links')}${loading('sync')}<div class="gh-row"><h2>已关联的仓库分支 <small>${links.length}</small></h2><label class="gh-check"><input id="gh-poll" type="checkbox" ${state.poll?'checked':''}>当前分支每 5 分钟同步</label></div><p class="gh-muted">仅在此页面可见时检查当前已关联分支；关闭页面后不运行。提交按作者记录，不等同于 Push 事件。</p>
      ${links.length?`<div class="gh-link-list">${links.map(l=>`<div class="gh-linked"><button class="gh-link-title" data-gh="open-link" data-id="${esc(l.id)}">${esc(l.repo)} <small>${esc(l.branch)}</small></button><span>${esc(data.projects.find(p=>p.id===l.project_id)?.name||'未指定项目')}</span><small>${dateText(l.synced_at)}</small>${button('cache','快照',`data-id="${esc(l.id)}"`)}${button('unlink','移除',`data-id="${esc(l.id)}"`)}</div>`).join('')}</div>`:'<p class="gh-muted">选择仓库和分支后关联项目，即可保存提交跟踪快照。</p>'}</section>`;
  }
  function repoList() {
    return `<section class="panel gh-repos" aria-busy="${busy('repos')}">${loading('repos')}<div class="gh-row"><h2>我的仓库</h2><span class="gh-muted">第 ${state.repoPage} 页</span></div><p class="gh-muted">展示个人拥有且当前授权可见的仓库。读取结果短时缓存 30 秒，手动刷新立即更新。</p>
      <form id="gh-open" class="gh-row"><label class="sr-only" for="gh-repo-input">仓库名称</label><input id="gh-repo-input" name="repo" placeholder="owner/repository" maxlength="180" required><button class="button secondary small" type="submit">打开</button></form>
      <div class="gh-repo-list">${state.repos.map(r=>`<button class="gh-repo ${r.full_name===state.repo?.full_name?'active':''}" data-gh="select-repo" data-repo="${esc(r.full_name)}"><strong>${esc(r.full_name)}</strong><small>${r.private?'私有':'公开'} · ${esc(r.language||'未标记语言')}${r.archived?' · 已归档':''}</small><p>${esc(r.description||'暂无描述')}</p></button>`).join('')||'<p class="gh-muted">连接账号后加载仓库，也可以直接输入仓库名称。</p>'}</div>
      <div class="gh-row">${button('repo-prev','上一页','',state.repoPage===1)}${button('repo-next','下一页','',!state.repoNext)}</div></section>`;
  }
  function workspace() {
    if(!state.repo)return `<section class="panel gh-work">${loading('workspace')}<div class="empty-state"><div class="empty-orbit">${icon('database')}</div><h3>选择一个仓库，看看代码的进展</h3><p>提交记录、改动明细与源文件会显示在这里。只读取内容，不向 GitHub 写入数据。</p></div></section>`;
    const r=state.repo,tracked=link();
    const choices=[...new Set([state.branch,...state.branches.map(b=>b.name)].filter(Boolean))];
    return `<section class="panel gh-work"><div class="gh-work-head">${loading('branches')}<div class="gh-row"><h2>${esc(r.full_name)}</h2>${external(ghURL(r.full_name),'GitHub')}</div><p class="gh-muted">${esc(r.description||'暂无仓库描述')}</p>
      <div class="gh-row"><label>分支 <select id="gh-branch" aria-label="GitHub 分支">${choices.map(b=>option(b,b,state.branch)).join('')}</select></label>${state.branchNext?button('branches-more','加载更多分支'):''}${button('commits-refresh','在线历史')}${button('sync','同步提交','',!tracked)}</div>
      <form id="gh-link" class="gh-row"><label for="gh-project">关联本地项目</label><select id="gh-project" name="project_id">${option('','仅跟踪仓库',tracked?.project_id||'')}${data.projects.map(p=>option(p.id,p.name,tracked?.project_id||'')).join('')}</select><button class="button primary small" type="submit" ${!state.branches.length?'disabled':''}>${tracked?'保存关联':'开始跟踪'}</button></form>
      <div class="gh-row gh-tabs">${button('tab-commits','提交记录',`aria-pressed="${state.tab==='commits'}"`)}${button('tab-files','仓库文件',`aria-pressed="${state.tab==='files'}"`)}<span class="gh-muted">${tracked?'关联已保存在本地':'尚未关联'}</span></div></div>
      ${state.tab==='commits'?commitList():fileBrowser()}${state.detail?detailView():busy('detail')?`<section class="gh-detail">${loading('detail')}${button('close-detail','取消读取')}</section>`:''}</section>`;
  }
  function commitList() {
    const items=state.cached&&state.mine?state.commits.filter(c=>c.author_login?.toLowerCase()===state.account.login.toLowerCase()):state.commits;
    return `<div class="gh-commit-list" aria-busy="${busy('commits')}">${loading('commits')}<div class="gh-row"><label class="gh-check"><input id="gh-mine" type="checkbox" ${state.mine?'checked':''}>只看当前账号作为作者的提交</label><small class="gh-muted">${state.cached?'本地跟踪快照 · '+dateText(state.syncedAt):'在线历史 · 第 '+state.commitPage+' 页'}</small></div>
      ${items.map(c=>`<article class="gh-commit"><div><button class="gh-commit-title" data-gh="detail" data-sha="${esc(c.sha)}">${esc(c.message.split('\n')[0])}</button><p>${esc(c.author)} · ${dateText(c.date)} ${state.newShas.includes(c.sha)?'<span class="status-pill status-done">本次新增</span>':''}</p></div><button class="gh-sha" data-gh="detail" data-sha="${esc(c.sha)}">${esc(c.sha.slice(0,7))}</button></article>`).join('')||(busy('commits')?'':'<div class="empty-state"><h3>当前范围内没有提交</h3><p>检查分支、作者筛选或先同步提交。</p></div>')}
      ${state.cached?'<p class="gh-muted">快照最多保留最近 100 条。点击“在线历史”分页查看更早记录。</p>':`<div class="gh-row">${button('commit-prev','上一页','',state.commitPage===1)}${button('commit-next','下一页','',!state.commitNext)}</div>`}</div>`;
  }
  function fileBrowser() {
    const c=state.content;
    return `<div class="gh-files" aria-busy="${busy('files')}">${loading('files')}<div class="gh-row"><strong>${esc(state.path||'/')}</strong>${button('root','根目录')}${button('files-refresh','刷新当前内容')}${state.path?button('parent','上一级'):''}</div>
      ${!c?'<p class="gh-muted">正在读取目录；若失败，请点击根目录重试。</p>':c.type==='dir'?`${c.limited?'<p class="gh-warning">目录达到 GitHub 的 1000 项展示上限，可能未显示全部内容。</p>':''}<div class="gh-file-list">${[...c.items].sort((a,b)=>(a.type==='dir'?0:1)-(b.type==='dir'?0:1)||a.name.localeCompare(b.name)).map(f=>`<button class="gh-file" data-gh="file" data-path="${esc(f.path)}">${icon(f.type==='dir'?'folder':'list')}<span>${esc(f.name)}</span><small>${f.type==='dir'?'目录':f.type==='submodule'?'子模块':f.type==='symlink'?'符号链接':f.size+' B'}</small></button>`).join('')||'<p class="gh-muted">空目录</p>'}</div>`:`<p class="gh-muted">${c.size} B · 只读预览，Markdown / HTML 均以源码显示</p>${c.notice?`<p class="gh-warning">${esc(c.notice)}</p>${external(ghURL(state.repo.full_name,'/blob/'+encode(state.branch)+'/'+state.path.split('/').map(encode).join('/')),'在 GitHub 查看')}`:`<pre class="gh-code"><code>${esc(c.text)}</code></pre>`}`}</div>`;
  }
  function detailView() {
    const d=state.detail;
    return `<section class="gh-detail" aria-busy="${busy('detail')}">${loading('detail')}<div class="gh-row"><h3>提交详情 <code>${esc(d.sha.slice(0,7))}</code></h3>${button('detail-refresh','刷新详情')}${button('close-detail','关闭详情')}</div><pre class="gh-message">${esc(d.message)}</pre><p class="gh-muted">${esc(d.author)} · ${dateText(d.date)} · +${d.stats.additions||0} / -${d.stats.deletions||0}</p><div class="gh-row">${external(ghURL(state.repo.full_name,'/commit/'+d.sha),'完整提交')}${button('draft-task','从这次提交创建任务草稿')}</div><p class="gh-muted">变更文件第 ${state.detailPage} 页。GitHub 对超大提交最多返回 3000 个文件；二进制或大文件可能没有 patch。</p>
      ${d.files.map(f=>`<details class="gh-diff" open><summary>${esc(f.filename)} · ${esc(f.status)} <span class="gh-add">+${f.additions}</span> <span class="gh-del">-${f.deletions}</span></summary>${f.patch?`<pre class="gh-code">${f.patch.split('\n').map(line=>`<span class="${line.startsWith('+')?'gh-add':line.startsWith('-')?'gh-del':''}">${esc(line)}</span>`).join('\n')}</pre>`:'<p class="gh-muted">GitHub 未提供文本差异，请查看原始提交。</p>'}${f.patch_truncated?'<p class="gh-warning">此文件差异已截断到 100000 字符。</p>':''}</details>`).join('')}
      <div class="gh-row">${button('detail-prev','上一页文件','',state.detailPage===1)}${button('detail-next','下一页文件','',!d.has_next)}</div></section>`;
  }
  function paint() {
    if(section!=='github')return;
    const root=$('#content'),active=document.activeElement;
    const focus=active?.id?.startsWith('gh-')?{id:active.id,value:active.value,start:active.selectionStart,end:active.selectionEnd}:null;
    const drafts=[...root.querySelectorAll('form input,form select')].map(el=>({id:el.id,value:el.value}));
    root.innerHTML=`<div class="gh-root">${state.error?`<div class="error-banner" role="alert">${esc(state.error)}</div>`:''}${state.info?`<div class="gh-notice" role="status">${esc(state.info)}</div>`:''}${accountPanel()}${trackedPanel()}<div class="gh-layout">${repoList()}${workspace()}</div></div>`;
    for(const draft of drafts){const el=document.getElementById(draft.id);if(el&&(draft.id!=='gh-project'||paintedVersion===workspaceVersion))el.value=draft.value;}
    paintedVersion=workspaceVersion;
    const disable=selector=>root.querySelectorAll(selector).forEach(el=>el.disabled=true);
    if(busy('account'))disable('#gh-connect button,#gh-connect input,#gh-open button,.gh-repo,.gh-link-title,[data-gh="cache"]');
    if(busy('repos'))disable('[data-gh="repo-prev"],[data-gh="repo-next"],[data-gh="reload"]');
    if(busy('sync')||busy('links')||busy('account'))disable('#gh-link button,#gh-project,[data-gh="sync"],[data-gh="unlink"],#gh-connect button');
    if(busy('sync'))disable('[data-gh="commits-refresh"],[data-gh="commit-prev"],[data-gh="commit-next"],#gh-mine');
    if(busy('branches'))disable('[data-gh="branches-more"],#gh-branch');
    if(focus){const el=document.getElementById(focus.id);if(el&&!el.disabled){el.focus();if(focus.start!=null&&el.setSelectionRange)el.setSelectionRange(focus.start,focus.end);}}
  }
  function mount() {
    paint();
    if(!state.started){state.started=true;run(async ctx=>{const account=await api('status',{},'GET',ctx.signal);if(!ctx.current())return;state.account=account;paint();if(state.account.login)await repos();},'account','正在读取连接状态…');}
  }
  document.addEventListener('submit',event=>{
    const formId=event.target.getAttribute('id')||'';
    if(!formId.startsWith('gh-'))return;
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.target));
    if(formId==='gh-open'&&!busy('account'))selectRepo(values.repo.trim());
    if(formId==='gh-link'&&!busy('sync')&&!busy('account')){
      const version=workspaceVersion,payload={repo:state.repo.full_name,branch:state.branch,project_id:values.project_id||null};
      run(async()=>{
        state.account=await api('link',payload,'POST');
        if(version===workspaceVersion)await startSync();
      },'links','正在保存仓库关联…');
    }
  });
  document.addEventListener('change',event=>{
    const el=event.target;
    if(el.id==='gh-poll'){state.poll=el.checked;return;}
    if(el.id==='gh-mine'&&!busy('sync')){state.mine=el.checked;cancel('detail');state.detail=null;state.commits=[];state.commitsLoaded=false;commits();}
    if(el.id==='gh-branch'&&!busy('branches')){
      const repo=state.repo,choices=state.branches,branchNext=state.branchNext,branchPage=state.branchPage,tab=state.tab;
      resetWorkspace();Object.assign(state,{repo,branches:choices,branchNext,branchPage,tab,branch:el.value});
      if(tab==='files')contents();else commits();
    }
  });
  document.addEventListener('click',event=>{
    const b=event.target.closest('[data-gh]');if(!b||b.disabled)return;
    const action=b.dataset.gh;
    if(action==='close-detail'){cancel('detail');state.detail=null;paint();return;}
    if(action==='draft-task'){
      const d=state.detail,tracked=link();if(!ready){toast('请先刷新并连接本地数据库');return;}openTask();
      const f=$('#task-form');f.elements.title.value=d.message.split('\n')[0].slice(0,160);
      f.elements.description.value=(d.message+'\n\nGitHub: '+ghURL(state.repo.full_name,'/commit/'+d.sha)).slice(0,10000);
      f.elements.owner.value=state.account.login||d.author;
      f.elements.project_id.value=tracked?.project_id||'';return;
    }
    if(action==='unlink'){
      const id=b.dataset.id;
      confirmAction('移除仓库关联','仅删除本地关联与该分支的提交快照，不修改 GitHub 仓库或本地任务。').then(ok=>{
        if(ok&&!busy('sync')&&!busy('account'))run(async()=>{
          state.account=await api('link',{id},'DELETE');
          if(state.cached&&!link()){state.cached=false;state.commits=[];state.commitsLoaded=false;state.newShas=[];state.detail=null;}
        },'links','正在移除关联…');
      });return;
    }
    if(action==='reload')repos(1,true);
    if(action==='repo-prev')repos(state.repoPage-1);
    if(action==='repo-next')repos(state.repoPage+1);
    if(action==='select-repo')selectRepo(b.dataset.repo);
    if(action==='open-link'){const l=state.account.links.find(x=>x.id===b.dataset.id);if(l)selectRepo(l.repo,l.branch);}
    if(action==='cache'){
      const l=state.account.links.find(x=>x.id===b.dataset.id);if(!l)return;
      resetWorkspace();
      run(async ctx=>{
        const cached=await api('cached',{id:l.id},'GET',ctx.signal);if(!ctx.current())return;
        state.repo={full_name:l.repo,description:'本地快照，未请求 GitHub'};state.branch=l.branch;
        state.branches=[{name:l.branch}];state.commits=cached.items;state.commitsLoaded=true;state.cached=true;state.syncedAt=cached.synced_at;
        state.info='正在查看本地提交摘要。文件内容与代码差异仍需连接 GitHub 读取。';
      },'workspace','正在读取本地快照…');
    }
    if(action==='branches-more')branches(state.branchPage+1);
    if(action==='commits-refresh'){state.tab='commits';cancel('detail');state.detail=null;commits(1,true);}
    if(action==='sync')startSync();
    if(action==='tab-commits'){state.tab='commits';if(!state.commitsLoaded&&!busy('commits')&&!busy('sync'))commits();else paint();}
    if(action==='tab-files'){state.tab='files';cancel('detail');state.detail=null;if(!state.content&&!busy('files'))contents();else paint();}
    if(action==='root')contents();
    if(action==='parent')contents(state.path.split('/').slice(0,-1).join('/'));
    if(action==='file')contents(b.dataset.path);
    if(action==='files-refresh')contents(state.path,true);
    if(action==='commit-prev')commits(state.commitPage-1);
    if(action==='commit-next')commits(state.commitPage+1);
    if(['detail','detail-next','detail-prev','detail-refresh'].includes(action)){
      const sha=b.dataset.sha||state.detail?.sha;if(!sha)return;
      const page=action==='detail'?1:action==='detail-refresh'?state.detailPage:state.detailPage+(action==='detail-next'?1:-1);
      showDetail(sha,page,action==='detail-refresh');
    }
  });
  setInterval(()=>{if(state.poll&&section==='github'&&!document.hidden&&jobs.size===0&&link())startSync();},300000);
  function invalidate() {
    resetWorkspace();
    for(const scope of [...jobs.keys()])cancel(scope);
    state.started=false;state.repos=[];state.poll=false;
    state.account={login:'',token_configured:false,links:[]};
  }
  window.FlowGitHub={mount};
  window.FlowGitHub.invalidate=invalidate;
  if(loaded&&section==='github')mount();
})();
