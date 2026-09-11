'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../src/settings.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let count=0;
function setup(){
  const elements=new Map(),listeners={},calls=[],downloads=[];
  function el(key){if(!elements.has(key))elements.set(key,{innerHTML:'',value:'',classList:{toggle(){}},disabled:false,click(){downloads.push(this.download);},remove(){}});return elements.get(key);}
  const status={database_path:'C:/custom/<test>/work.sqlite3',projects:2,tasks:3,last_export_at:null,github:{login:'tester',token_configured:true,links:1,last_synced_at:null,cache_ttl_seconds:30}};
  let handler=async()=>status;
  const context=vm.createContext({console,Date,Blob,URL:{createObjectURL(){return 'blob:test';},revokeObjectURL(){}},
    document:{documentElement:{dataset:{theme:'dark'}},addEventListener(type,fn){listeners[type]=fn;},body:{appendChild(){}},createElement(){return el('download');}},
    window:{FlowGitHub:{invalidate(){context.invalidated=true;}}},$:el,$$:()=>[],section:'settings',ready:true,busy:false,
    load:async()=>{context.reloaded=true;},data:{projects:[],tasks:[]},navigator:{clipboard:{async writeText(text){context.copied=text;}}},setTimeout(){},
    esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon:()=>'',
    toast:m=>context.toastText=m,setConnection(){},render(){},confirmAction:async(t,m)=>{context.confirmText=m;return context.confirmed;},confirmed:true,
    fetch:async(url,options)=>{calls.push({url,options});const result=await handler(url,options);return {ok:result?.httpError?false:true,status:result?.httpError||200,json:async()=>result};}
  });
  vm.runInContext(source,context);
  return {context,api:context.window.FlowSettings,calls,downloads,status,elements,setHandler:fn=>handler=fn,
    change:async(id,value)=>{el('#'+id).value=value;listeners.change({target:{id,value}});await tick();},
    submit:async id=>{listeners.submit({target:{id},preventDefault(){}});await tick();},
    click:async action=>{listeners.click({target:{closest:()=>({dataset:{settings:action},disabled:false})}});await tick();}};
}
async function test(name,fn){await fn();console.log('PASS',name);count++;}
const backup={format:'flow-backup-v1',projects:[],tasks:[]};
const file={size:20,text:async()=>JSON.stringify(backup)};
const preview={format:'flow-backup-v1',current_projects:2,current_tasks:3,projects:0,tasks:0,detached_links:[],revision:7};
(async()=>{
  await test('Theme selected label, accessibility, and collapsed about',async()=>{const t=setup(),html=t.api.page();assert(html.includes('aria-pressed="true"'));assert(html.includes('已选中'));assert(html.includes('<details'));assert(!html.includes('<details open'));});
  await test('Status is local-only and mount is deduplicated',async()=>{const t=setup();await Promise.all([t.api.mount(),t.api.mount()]);assert.equal(t.calls.length,1);assert.equal(t.calls[0].url,'/api/workspace-status');assert(t.api.page().includes('尚需验证'));assert(t.api.page().includes('&lt;test&gt;'));assert(!t.api.page().includes('<test>'));});
  await test('Old backend has actionable restart error',async()=>{const t=setup();t.setHandler(async()=>({httpError:404}));await t.api.mount();assert(t.api.page().includes('重启本地服务'));});
  await test('Explicit GitHub check is separate from metadata',async()=>{const t=setup();await t.api.mount();t.setHandler(async()=>({ok:true,message:'账号验证成功',checked_at:'2026-09-11T00:00:00Z'}));await t.click('verify');assert.equal(t.calls.at(-1).url,'/api/workspace-verify');assert(t.api.page().includes('账号验证成功'));});
  await test('Copy uses actual backend database location',async()=>{const t=setup();await t.api.mount();await t.click('copy-database');assert.equal(t.context.copied,t.status.database_path);});
  await test('Export uses requested scope and unique filename',async()=>{const t=setup();await t.api.exportBackup('workspace');assert.equal(JSON.parse(t.calls[0].options.body).scope,'workspace');assert(t.downloads[0].startsWith('flow-workspace-'));assert(t.context.toastText.includes('确认浏览器下载'));});
  await test('Repeated exports are deduplicated',async()=>{const t=setup();let resolve;t.setHandler(()=>new Promise(r=>resolve=r));const pending=t.api.exportBackup();await t.api.exportBackup();assert.equal(t.calls.length,1);t.setHandler(async()=>t.status);resolve(backup);await pending;});
  await test('Restore previews before confirmation and respects cancellation',async()=>{const t=setup();t.context.confirmed=false;t.setHandler(async()=>preview);await t.api.restoreBackup(file);assert.deepEqual(t.calls.map(c=>c.url),['/api/restore/preview']);assert.equal(t.context.busy,false);});
  await test('Restore sends preview revision and invalidates old GitHub state',async()=>{const t=setup();t.setHandler(async url=>url.endsWith('/preview')?preview:url==='/api/restore'?{projects:[],tasks:[],revision:8,restore_result:{safety_backup:'C:/safe.json',detached_links:0}}:t.status);await t.api.restoreBackup(file);assert.equal(t.calls[1].options.headers['If-Match'],'7');assert.equal(t.context.invalidated,true);assert.equal(t.context.data.revision,8);assert(t.api.page().includes('C:/safe.json'));assert.equal(t.context.busy,false);});
  await test('Conflict is not silently retried',async()=>{const t=setup();t.setHandler(async url=>url.endsWith('/preview')?preview:{httpError:409,error:'数据已更新，请重新预览'});await t.api.restoreBackup(file);assert.equal(t.calls.length,2);assert.equal(t.context.invalidated,undefined);assert(t.context.toastText.includes('重新预览'));});
  await test('Missing project warning and full restore scope are explicit',async()=>{const t=setup();t.context.confirmed=false;t.setHandler(async()=>({...preview,detached_links:[{repo:'tester/repo',branch:'main'}]}));await t.api.restoreBackup(file);assert(t.context.confirmText.includes('仅跟踪仓库'));assert(t.context.confirmText.includes('tester/repo'));t.setHandler(async()=>({...preview,format:'flow-workspace-v2',github_links:4}));await t.api.restoreBackup(file);assert(t.context.confirmText.includes('令牌和浏览器主题不变'));});
  await test('Malformed and oversized files never reach backend',async()=>{const t=setup();await t.api.restoreBackup({size:65*1024*1024});assert.equal(t.calls.length,0);await t.api.restoreBackup({size:1,text:async()=>'{'});assert.equal(t.calls.length,0);assert.equal(t.context.busy,false);});
  await test('Restore operation is locked during file parsing',async()=>{const t=setup();let resolve;const pending=t.api.restoreBackup({size:2,text:()=>new Promise(r=>resolve=r)});await t.api.restoreBackup(file);assert.equal(t.calls.length,0);t.context.confirmed=false;t.setHandler(async()=>preview);resolve(JSON.stringify(backup));await pending;assert.equal(t.calls.length,1);assert.equal(t.context.busy,false);});
  await test('Storage and GitHub forms have explicit safe controls',async()=>{const t=setup(),html=t.api.page();assert(html.includes('更改数据库位置'));assert(html.includes('选择文件夹'));assert(html.includes('type="password"'));assert(html.includes('autocomplete="new-password"'));assert(html.includes('原数据库'));});
  await test('Folder picker only fills a draft and never migrates',async()=>{const t=setup();await t.api.mount();t.setHandler(async()=>({path:'D:/Flow/work.sqlite3'}));await t.click('pick-database');assert.equal(t.elements.get('#settings-db-path').value,'D:/Flow/work.sqlite3');assert.equal(t.calls.at(-1).url,'/api/storage/pick');assert(!t.calls.some(c=>c.url.endsWith('/migrate')));});
  await test('Migration cancel never submits changes',async()=>{const t=setup();await t.api.mount();t.elements.set('#settings-db-path',{value:'D:/Flow/work.sqlite3'});t.context.confirmed=false;await t.submit('settings-storage-form');assert(!t.calls.some(c=>c.url.endsWith('/migrate')));assert.equal(t.context.busy,false);});
  await test('Migration confirms old path and refreshes workspace',async()=>{const t=setup();await t.api.mount();t.elements.set('#settings-db-path',{value:'D:/Flow/work.sqlite3'});t.setHandler(async url=>url.endsWith('/migrate')?{message:'迁移成功',original_path:t.status.database_path}:t.status);await t.submit('settings-storage-form');const call=t.calls.find(c=>c.url.endsWith('/migrate'));assert.equal(JSON.parse(call.options.body).expected_path,t.status.database_path);assert.equal(t.context.reloaded,true);assert.equal(t.context.busy,false);});
  await test('Token is posted in body, immediately cleared, never rendered',async()=>{const t=setup();await t.api.mount();await t.change('settings-gh-mode','token');t.elements.get('#settings-gh-token').value='synthetic-test-token';t.elements.get('#settings-gh-login').value='';t.setHandler(async url=>url.endsWith('/session')?{login:'tester',token_configured:true}:t.status);await t.submit('settings-github-form');const call=t.calls.find(c=>c.url.endsWith('/session'));assert.equal(JSON.parse(call.options.body).token,'synthetic-test-token');assert(!call.url.includes('synthetic'));assert.equal(t.elements.get('#settings-gh-token').value,'');assert(!t.api.page().includes('synthetic-test-token'));assert.equal(t.context.invalidated,true);});
  await test('Mode switch removes stale token input',async()=>{const t=setup();await t.change('settings-gh-mode','token');t.elements.get('#settings-gh-token').value='synthetic';await t.change('settings-gh-mode','public');assert.equal(t.elements.get('#settings-gh-token').value,'');assert.equal(t.elements.get('#settings-token-field').hidden,true);});
  await test('Failed session reports preserved original credentials',async()=>{const t=setup();await t.change('settings-gh-mode','token');t.elements.get('#settings-gh-token').value='synthetic';t.elements.get('#settings-gh-login').value='';t.setHandler(async()=>({httpError:401,error:'令牌无效'}));await t.submit('settings-github-form');assert(t.elements.get('#settings-github-notice').textContent.includes('不会替换原有凭据'));assert.equal(t.elements.get('#settings-gh-token').value,'');});
  console.log(count+' settings interaction checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
