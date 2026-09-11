'use strict';
(() => {
  const state={status:null,error:'',checkedAt:null,loading:false,attemptedAt:0,exporting:false,restoring:false,checking:false,verification:null,notice:'',configuring:false,moving:false,picking:false};
  const date=value=>value?new Date(value).toLocaleString('zh-CN'):'尚无记录';
  async function request(path, payload, revision) {
    const response=await fetch(path,{method:payload===undefined?'GET':'POST',cache:'no-store',
      headers:{'X-Flow-Request':'1',...(payload===undefined?{}:{'Content-Type':'application/json'}),...(revision===undefined?{}:{'If-Match':String(revision)})},
      ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    const result=await response.json();
    if(!response.ok)throw new Error(response.status===404?'后端尚未更新，请重启本地服务后重试':result.error||'操作失败，请重试');
    return result;
  }
  function paint() {
    if(section!=='settings')return;
    const status=$('#settings-status');if(status)status.innerHTML=statusView();
    $$('#settings-github-form input,#settings-github-form select,#settings-github-form button,[data-settings="disconnect"]').forEach(b=>b.disabled=state.configuring||state.moving);
    $$('#settings-storage-form input,#settings-storage-form button').forEach(b=>b.disabled=state.moving||state.picking||state.configuring||state.restoring||state.exporting);
    const backup=$('#settings-backup-feedback');if(backup)backup.innerHTML=backupFeedback();
    $$('[data-settings="export-projects"],[data-settings="export-workspace"]').forEach(b=>b.disabled=state.exporting||state.restoring||state.moving);
    $$('[data-settings="restore"]').forEach(b=>b.disabled=state.restoring||state.exporting||state.moving);
  }
  async function refresh(force=false) {
    if(state.loading||(!force&&Date.now()-state.attemptedAt<15000))return;
    state.loading=true;state.error='';state.attemptedAt=Date.now();paint();
    try{
      const result=await request('/api/workspace-status');
      if(!result.database_path||!result.github)throw new Error('工作空间状态格式异常');
      if(state.status?.github.login!==result.github.login||state.status?.github.token_configured!==result.github.token_configured)state.verification=null;
      state.status=result;state.checkedAt=new Date().toISOString();
    }catch(error){state.error=error.message;}
    finally{state.loading=false;paint();}
  }
  async function verify() {
    if(state.checking)return;
    state.checking=true;state.verification=null;paint();
    try{state.verification=await request('/api/workspace-verify',{});}
    catch(error){state.verification={ok:false,message:error.message};}
    finally{state.checking=false;paint();}
  }
  function statusView() {
    const s=state.status,g=s?.github;
    const verification=state.checking?'正在验证…':state.verification?(state.verification.ok?'上次账号验证成功':'上次验证未通过'):null;
    return `<div class="settings-section-head"><h2>连接与存储</h2><button class="button secondary small" data-settings="refresh" ${state.loading?'disabled':''}>${icon('refresh')}${state.loading?'读取中…':'刷新状态'}</button></div>
      ${state.error?`<p class="settings-warning" role="alert">${esc(state.error)}${s?'；以下为上次读取结果。':''}</p>`:''}
      <div class="settings-status-grid"><div class="settings-status-item"><span>本地服务</span><strong>${state.error?'状态读取失败':state.checkedAt?'已连接 · SQLite':'正在读取…'}</strong><small>检查时间：${date(state.checkedAt)}</small></div>
      <div class="settings-status-item"><span>GitHub</span><strong>${verification||(g?g.token_configured?'已配置令牌 · 尚需验证':g.login?'公开访问模式':'未连接账号':'正在读取…')}</strong><small>${g?esc(g.login||'在下方设置连接账号'):'等待本地服务返回'}</small></div></div>
      <div class="settings-verification" role="status">${state.checking?'正在向 GitHub 验证账号…':state.verification?esc(state.verification.message)+' '+date(state.verification.checked_at):'配置状态不代表联网成功；验证账号不会保证每个私有仓库均已授权。'}</div>
      <div class="settings-actions"><button class="button secondary small" data-settings="verify" ${state.checking||!g?'disabled':''}>验证 GitHub 连接</button><button class="button text" data-nav="github">打开 GitHub 工作台 ${icon('arrow')}</button></div>
      <dl class="settings-facts"><div><dt>本地数据</dt><dd>${s?`${s.projects} 个项目 · ${s.tasks} 个任务 · ${s.requirements??0} 个需求 · ${s.defects??0} 个缺陷 · ${g.links} 个仓库分支`:'正在读取…'}</dd></div><div><dt>最近同步</dt><dd>${date(g?.last_synced_at)}</dd></div><div><dt>读取缓存</dt><dd>${g?`${g.cache_ttl_seconds} 秒 · 手动刷新读取最新数据`:'正在读取…'}</dd></div></dl>
      <div class="settings-path"><span>当前数据库位置</span><code>${esc(s?.database_path||'等待读取真实路径')}</code><button class="button text" data-settings="copy-database" ${!s?'disabled':''}>复制位置</button></div>`;
  }
  function connectionForms() {
    return `<details class="settings-config" id="storage-options"><summary>更改数据库位置</summary>
      <p>将当前完整数据库迁移到新的本机位置，立即生效并记住路径。原数据库及旧安全备份保留；不会覆盖已有文件，也不会切换到不明数据库。</p>
      <form id="settings-storage-form" class="settings-form">
        <label for="settings-db-path">新的数据库文件路径</label>
        <div class="settings-input-row"><input id="settings-db-path" name="path" type="text" required maxlength="2000" placeholder="例如 D:\u005cFlowData\u005cflow.sqlite3" autocomplete="off" spellcheck="false"><button type="button" class="button secondary" data-settings="pick-database">选择文件夹</button></div>
        <small>选择窗口显示在运行项目的电脑上；也可直接输入绝对路径。目标文件夹须已存在，建议避开网络盘、云同步目录和系统目录。</small>
        <button type="submit" class="button primary">确认迁移数据库</button>
      </form><p id="settings-storage-notice" class="settings-inline-feedback" role="status" aria-live="polite"></p>
    </details>
    <details class="settings-config" id="github-options"><summary>配置 GitHub 连接</summary>
      <form id="settings-github-form" class="settings-form" autocomplete="off">
        <label for="settings-gh-mode">访问方式</label><select id="settings-gh-mode" name="mode"><option value="public">公开账号（无需令牌）</option><option value="token">只读令牌（含授权私有仓库）</option></select>
        <label for="settings-gh-login">GitHub 用户名</label><input id="settings-gh-login" name="login" maxlength="39" value="${esc(state.status?.github.login||'')}" placeholder="公开模式必填；令牌模式可留空自动识别" autocomplete="off" spellcheck="false">
        <div id="settings-token-field" hidden><label for="settings-gh-token">Fine-grained 只读令牌</label><input id="settings-gh-token" type="password" name="token" maxlength="255" autocomplete="new-password" spellcheck="false" placeholder="仅在这个本机设置页输入令牌"></div>
        <small>令牌仅通过请求正文传给本机服务，验证成功后保留在进程内存；不会回显、保存到浏览器、数据库或备份。服务重启后需重新输入。请勿发送到聊天。</small>
        <div class="settings-actions"><button type="submit" class="button primary">验证并连接</button><button type="button" class="button secondary" data-settings="disconnect">断开连接</button><a class="button text" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建只读令牌</a></div>
      </form><p id="settings-github-notice" class="settings-inline-feedback" role="status" aria-live="polite"></p>
      <p class="settings-caption">只选择所需仓库，授予 Contents 与 Metadata 的 Read-only 权限。切换或断开账号不删除本地仓库关联和提交快照；断开不会在 GitHub 撤销令牌。</p>
    </details>`;
  }
  function feedback(id, message, error=false) {
    const el=$(id);if(!el)return;
    el.textContent=message;el.classList.toggle('is-error',error);
  }
  async function pickDatabase() {
    if(state.picking||state.moving||state.configuring)return;
    state.picking=true;paint();feedback('#settings-storage-notice','请在运行项目的电脑上选择文件夹（最多等待 2 分钟）…');
    try{
      const result=await request('/api/storage/pick',{});
      if(!result.cancelled&&result.path)$('#settings-db-path').value=result.path;
      feedback('#settings-storage-notice',result.cancelled?'已取消选择，数据库未改变。':'已选择位置，请核对文件名后确认迁移。');
    }catch(error){feedback('#settings-storage-notice',error.message,true);}
    finally{state.picking=false;paint();}
  }
  async function migrateDatabase() {
    if(state.moving||state.configuring||state.restoring||state.exporting||busy)return;
    const path=$('#settings-db-path').value.trim(),original=state.status?.database_path;
    if(!path||!original){toast('请填写路径并刷新数据库状态');return;}
    state.moving=true;busy=true;paint();
    try{
      if(!await confirmAction('迁移数据库',`当前位置：${original}\n新位置：${path}\n\n完整复制当前数据并校验，成功后立即切换。原文件和旧安全备份均保留，不覆盖已有文件。以后从新位置读取，是否继续？`))return;
      feedback('#settings-storage-notice','正在复制并校验数据库，请勿关闭服务…');
      window.FlowGitHub?.invalidate();
      const result=await request('/api/storage/migrate',{path,expected_path:original});
      state.status=null;state.attemptedAt=0;state.verification=null;
      await load(true);await refresh(true);
      toast(result.message);feedback('#settings-storage-notice',result.message+'；原位置：'+result.original_path);
      const details=$('#storage-options');if(details)details.open=true;
    }catch(error){feedback('#settings-storage-notice',error.message+'；如连接中断，请刷新状态确认实际路径后再操作。',true);}
    finally{state.moving=false;busy=false;paint();}
  }
  async function configureGitHub(disconnect=false) {
    if(state.configuring||state.moving||state.restoring||busy)return;
    const mode=disconnect?'disconnect':$('#settings-gh-mode').value;
    const payload={mode,login:$('#settings-gh-login').value.trim()};
    if(mode==='token')payload.token=$('#settings-gh-token').value.trim();
    $('#settings-gh-token').value='';
    state.configuring=true;paint();
    try{
      if(disconnect&&!await confirmAction('断开 GitHub 连接','清除当前会话令牌和账号连接，保留本地仓库关联与提交快照。不撤销 GitHub 网站上的授权，是否继续？'))return;
      feedback('#settings-github-notice','正在验证连接，请稍候…');
      window.FlowGitHub?.invalidate();
      const result=await request('/api/github/session',payload);
      delete payload.token;
      window.FlowGitHub?.invalidate();state.verification=null;
      await refresh(true);
      feedback('#settings-github-notice',disconnect?'已断开连接，已保留本地快照。':`已连接 ${result.login}。${result.token_configured?'令牌仅保留于本次服务会话；仓库权限需在工作台逐个确认。':'当前为公开访问模式。'}`);
      toast(disconnect?'已断开 GitHub 连接':'GitHub 已连接');
    }catch(error){feedback('#settings-github-notice',error.message+'；连接失败不会替换原有凭据。',true);}
    finally{delete payload.token;state.configuring=false;paint();}
  }
  document.addEventListener('submit',event=>{
    if(event.target.id==='settings-storage-form'){event.preventDefault();migrateDatabase();}
    if(event.target.id==='settings-github-form'){event.preventDefault();configureGitHub();}
  });
  document.addEventListener('change',event=>{
    if(event.target.id==='settings-gh-mode'){
      $('#settings-token-field').hidden=event.target.value!=='token';
      $('#settings-gh-token').required=event.target.value==='token';
      $('#settings-gh-login').required=event.target.value==='public';
      $('#settings-gh-token').value='';
    }
  });
  function backupFeedback() {
    const s=state.status;
    return `${state.exporting?'<p role="status">正在生成备份，请稍候…</p>':''}${state.restoring?'<p role="status">正在校验或恢复备份，请勿关闭服务…</p>':''}
      ${state.notice?`<p class="settings-notice" role="status">${esc(state.notice)}</p>`:''}
      <dl class="settings-facts"><div><dt>最近生成</dt><dd>${date(s?.last_export_at)}${s?.last_export_scope?' · '+(s.last_export_scope==='workspace'?'完整工作空间':'项目管理数据'):''}</dd></div><div><dt>安全备份</dt><dd>${date(s?.last_safety_at)}</dd></div></dl>
      <p class="settings-caption">生成时间不代表下载已保存。安全备份保存在数据库旁，不会自动删除；请另存一份到其他磁盘。</p>
      ${s?.last_safety_path?`<div class="settings-path"><span>最近恢复前的安全备份</span><code>${esc(s.last_safety_path)}</code><button class="button text" data-settings="copy-safety">复制备份位置</button></div>`:''}`;
  }
  function page() {
    const theme=document.documentElement.dataset.theme;
    return `<div class="settings-grid workspace-settings">
      <section class="panel settings-card"><div id="settings-status">${statusView()}</div>${connectionForms()}</section>
      <section class="panel settings-card"><h2>备份与恢复</h2><p>明确备份范围，恢复之前先留一份安全副本。</p>
        <div class="settings-backup-option"><div><h3>项目管理数据</h3><p>项目、计划任务、需求和缺陷。恢复时保留现有 GitHub 快照，并重新绑定仍存在的项目。</p></div><button class="button secondary" data-settings="export-projects">导出项目备份</button></div>
        <div class="settings-backup-option"><div><h3>完整工作空间</h3><p>项目、任务、需求、缺陷、GitHub 账号名称、仓库关联、提交摘要与最近活动。不含令牌、源码文件和浏览器主题。</p></div><button class="button primary" data-settings="export-workspace">导出完整备份</button></div>
        <div class="settings-restore"><button class="button secondary" data-settings="restore">${icon('upload')}选择备份恢复</button><p>先校验并预览覆盖范围；安全备份写入失败则取消恢复。旧版备份不含需求和缺陷，恢复会清空这两类记录，确认前会明确提示。新版备份请使用本版或更新版 Flow 恢复。</p></div>
        <div id="settings-backup-feedback">${backupFeedback()}</div>
      </section>
      <section class="panel settings-card"><h2>外观主题</h2><p>选择适合你的工作氛围，仅保存在当前浏览器。</p><div class="theme-options" role="group" aria-label="外观主题">${[['dark','深空紫'],['light','晨光白'],['aurora','极光绿']].map(([key,name])=>`<button class="theme-choice ${theme===key?'active':''}" data-theme-choice="${key}" aria-pressed="${theme===key}"><span class="theme-preview ${key}" aria-hidden="true"></span><span class="theme-label">${name}<small>${theme===key?'✓ 已选中':'未选中'}</small></span></button>`).join('')}</div></section>
      <details class="panel settings-card settings-about"><summary>关于与快捷键</summary><ul class="security-list"><li>个人本地使用，无团队登录或角色权限。</li><li>服务仅监听本机，不开放公网。</li><li>GitHub 仅调用读取接口；令牌不进入备份。</li><li>删除前确认、输入校验、多窗口冲突检测。</li><li>N 新建当前模块的任务 / 需求 / 缺陷，G 返回仪表盘，Esc 关闭窗口。</li></ul></details>
    </div>`;
  }
  async function exportBackup(scope='projects') {
    if(state.exporting||state.restoring)return;
    if(!ready){toast('请先连接本地数据库');return;}
    state.exporting=true;state.notice='';paint();
    try{
      const backup=await request('/api/backups/export',{scope});
      const blob=new Blob([JSON.stringify(backup)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download=`flow-${scope==='workspace'?'workspace':'backup'}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
      document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
      state.notice='备份已生成，请确认浏览器下载已保存。';toast(state.notice);await refresh(true);
    }catch(error){state.notice=error.message;toast(error.message);}
    finally{state.exporting=false;paint();}
  }
  function previewMessage(p) {
    const full=['flow-workspace-v2','flow-workspace-v3'].includes(p.format);
    const legacy=p.legacy_management??['flow-backup-v1','flow-workspace-v2'].includes(p.format);
    return `当前：${p.current_projects} 个项目、${p.current_tasks} 个任务、${p.current_requirements??0} 个需求、${p.current_defects??0} 个缺陷。\n导入：${p.projects} 个项目、${p.tasks} 个任务、${p.requirements??0} 个需求、${p.defects??0} 个缺陷。\n`+
      (legacy?'注意：这是旧版备份，不含需求和缺陷，继续恢复将清空当前全部需求和缺陷；恢复前会保留完整安全副本。\n':'')+
      (full?`完整恢复还将替换 GitHub 账号名称、${p.github_links} 个仓库分支的关联与快照，以及最近活动。令牌和浏览器主题不变。`:'将替换全部项目、任务、需求和缺陷，并重置最近活动；保留 GitHub 配置、快照以及仍有效的项目关联。')+
      (p.detached_links.length?`\n注意：${p.detached_links.length} 条关联的项目不在备份中，将变为“仅跟踪仓库”。\n`+p.detached_links.slice(0,5).map(l=>`${l.repo} / ${l.branch}`).join('\n')+(p.detached_links.length>5?'\n其余关联未逐条列出。':''):'')+
      '\n\n确认后，系统先在数据库旁保存完整安全备份；写入失败不会恢复。是否继续？';
  }
  async function restoreBackup(file) {
    if(!file||state.restoring||state.exporting||busy)return;
    if(!ready){toast('请先连接本地数据库');return;}
    if(file.size>64*1024*1024){toast('备份文件不能超过 64 MB');return;}
    state.restoring=true;state.notice='';busy=true;paint();
    try{
      const backup=JSON.parse(await file.text());
      const preview=await request('/api/restore/preview',{backup});
      if(!await confirmAction('确认恢复范围',previewMessage(preview)))return;
      const result=await request('/api/restore',{backup},preview.revision);
      data=result;ready=true;setConnection(true);
      window.FlowGitHub?.invalidate();
      state.verification=null;
      state.notice=`恢复成功，安全备份：${result.restore_result.safety_backup}`+(result.restore_result.detached_links?`；${result.restore_result.detached_links} 条关联已变为仅跟踪仓库。`:'');
      render();toast('恢复成功，已保存恢复前安全备份');await refresh(true);
    }catch(error){state.notice=error instanceof SyntaxError?'JSON 文件无法解析，请使用完整备份文件':error.message;toast(state.notice);}
    finally{state.restoring=false;busy=false;paint();}
  }
  async function copyPath(key) {
    const value=state.status?.[key];if(!value)return;
    try{await navigator.clipboard.writeText(value);toast('位置已复制');}
    catch{toast('浏览器不允许自动复制，请选中路径手动复制');}
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-settings]');if(!button||button.disabled)return;
    const action=button.dataset.settings;
    if(action==='pick-database')pickDatabase();
    if(action==='disconnect')configureGitHub(true);
    if(action==='refresh')refresh(true);
    if(action==='verify')verify();
    if(action==='export-projects')exportBackup('projects');
    if(action==='export-workspace')exportBackup('workspace');
    if(action==='restore'&&!state.restoring&&!busy)$('#import-file').click();
    if(action==='copy-database')copyPath('database_path');
    if(action==='copy-safety')copyPath('last_safety_path');
  });
  window.FlowSettings={page,mount:()=>refresh(),exportBackup,restoreBackup};
})();
