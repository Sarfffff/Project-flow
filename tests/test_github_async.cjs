'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../src/github.js'),'utf8');
let count=0;
function setup(){
  const requests=[],listeners={},disabledSelectors=[];
  const content={innerHTML:'',querySelectorAll(selector){if(!selector.startsWith('form '))disabledSelectors.push(selector);return [];}};
  const context=vm.createContext({console,AbortController,URLSearchParams,setInterval(){},
    document:{hidden:false,activeElement:null,addEventListener(event,fn){listeners[event]=fn;},getElementById(){return null;}},
    window:{},section:'github',loaded:false,ready:true,data:{projects:[]},$:()=>content,
    esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),icon:()=>'',option:(value,label)=>`<option>${label}</option>`,
    fetch(url,options){return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));}
  });
  vm.runInContext(source.replace('window.FlowGitHub={mount};','window.FlowGitHub={mount,state,paint,jobs,selectRepo,repos,commits,branches,contents,showDetail,startSync,resetWorkspace};'),context);
  const gh=context.window.FlowGitHub;
  gh.state.started=true;
  gh.state.account.login='me';
  gh.state.repos=[{full_name:'me/one',default_branch:'main'},{full_name:'me/two',default_branch:'dev'}];
  const answer=(request,value,ok=true)=>request.resolve({ok,json:async()=>value});
  const click=action=>listeners.click({target:{closest(){return {disabled:false,dataset:{gh:action}};}}});
  return {gh,requests,answer,click,content,disabledSelectors,listeners};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function test(name,fn){await fn();count++;console.log('PASS',name);}
(async()=>{
  await test('Management forms with named id fields are ignored safely',async()=>{
    const t=setup();
    assert.doesNotThrow(()=>t.listeners.submit({target:{id:{value:'record-id'},getAttribute(){return 'management-form';}},preventDefault(){throw new Error('unrelated form intercepted');}}));
    assert.equal(t.requests.length,0);
  });
  await test('Metadata reused; branches and commits start before either responds',async()=>{
    const t=setup(),pending=t.gh.selectRepo('me/one');
    assert.equal(t.requests.length,2);
    assert(t.requests[0].url.includes('/branches?'));
    assert(t.requests[1].url.includes('/commits?'));
    t.answer(t.requests[1],{items:[{sha:'aaaaaaa',message:'fast',author:'me'}],has_next:false});
    await flush();
    assert(t.content.innerHTML.includes('fast'));
    assert(t.gh.jobs.has('branches'));
    t.answer(t.requests[0],{items:[{name:'main'}],has_next:false});
    await pending;
    assert.equal(t.gh.jobs.size,0);
  });
  await test('Manual repository metadata followed by parallel reads',async()=>{
    const t=setup(),pending=t.gh.selectRepo('me/manual');
    assert.equal(t.requests.length,1);
    t.answer(t.requests[0],{full_name:'me/manual',default_branch:'main'});
    await flush();assert.equal(t.requests.length,3);
    for(const r of t.requests.slice(1))t.answer(r,{items:[],has_next:false});
    await pending;
  });
  await test('Late old repository responses cannot overwrite new selection',async()=>{
    const t=setup(),old=t.gh.selectRepo('me/one'),next=t.gh.selectRepo('me/two');
    assert(t.requests[0].options.signal.aborted);
    assert(t.requests[1].options.signal.aborted);
    t.answer(t.requests[2],{items:[{name:'dev'}],has_next:false});
    t.answer(t.requests[3],{items:[{sha:'bbbbbbb',message:'new',author:'me'}],has_next:false});
    await next;
    t.answer(t.requests[0],{items:[{name:'main'}],has_next:false});
    t.answer(t.requests[1],{items:[{sha:'aaaaaaa',message:'old',author:'me'}],has_next:false});
    await old;
    assert.equal(t.gh.state.repo.full_name,'me/two');
    assert.equal(t.gh.state.commits[0].message,'new');
    assert.equal(t.gh.state.branches[0].name,'dev');
  });
  await test('Failed branch load does not block commit results',async()=>{
    const t=setup(),pending=t.gh.selectRepo('me/one');
    t.answer(t.requests[0],{error:'branch unavailable'},false);
    t.answer(t.requests[1],{items:[{sha:'aaaaaaa',message:'available',author:'me'}],has_next:false});
    await pending;
    assert.equal(t.gh.state.commits.length,1);
    assert.equal(t.gh.state.error,'branch unavailable');
  });
  await test('Files remain visible and other sections are not globally disabled',async()=>{
    const t=setup();t.gh.state.repo=t.gh.state.repos[0];t.gh.state.tab='files';
    t.gh.state.content={type:'file',size:7,text:'visible'};t.gh.state.path='old.txt';
    const pending=t.gh.contents('new.txt');
    assert(t.content.innerHTML.includes('visible'));
    assert(t.content.innerHTML.includes('正在读取文件内容'));
    assert(!t.disabledSelectors.some(s=>s==='button,input,select'||s.includes('.gh-repo')));
    t.answer(t.requests[0],{error:'offline'},false);await pending;
    assert.equal(t.gh.state.path,'old.txt');
    assert.equal(t.gh.state.content.text,'visible');
  });
  await test('Latest file navigation wins even when aborted fetch resolves',async()=>{
    const t=setup();t.gh.state.repo=t.gh.state.repos[0];
    const old=t.gh.contents('old.txt'),next=t.gh.contents('new.txt');
    assert(t.requests[0].options.signal.aborted);
    t.answer(t.requests[1],{type:'file',text:'new'});await next;
    t.answer(t.requests[0],{type:'file',text:'old'});await old;
    assert.equal(t.gh.state.path,'new.txt');
  });
  await test('Manual refresh endpoints send refresh=1',async()=>{
    const t=setup();t.gh.state.repo=t.gh.state.repos[0];
    for(const action of ['reload','commits-refresh','files-refresh']){
      t.click(action);const r=t.requests.at(-1);
      assert.equal(new URL(r.url,'http://local').searchParams.get('refresh'),'1');
      t.answer(r,action==='files-refresh'?{type:'dir',items:[]}:{items:[],has_next:false});await flush();
    }
    t.gh.state.detail={sha:'aaaaaaa',message:'test',author:'me',stats:{},files:[]};
    t.click('detail-refresh');const r=t.requests.at(-1);
    assert.equal(new URL(r.url,'http://local').searchParams.get('refresh'),'1');
    t.answer(r,t.gh.state.detail);await flush();
  });
  await test('Closing details prevents late request from reopening it',async()=>{
    const t=setup();t.gh.state.repo=t.gh.state.repos[0];
    const pending=t.gh.showDetail('aaaaaaa');t.click('close-detail');
    t.answer(t.requests[0],{sha:'aaaaaaa',message:'old',stats:{},files:[]});await pending;
    assert.equal(t.gh.state.detail,null);
  });
  await test('Empty loaded commit list is not fetched again on tab clicks',async()=>{
    const t=setup();t.gh.state.repo=t.gh.state.repos[0];t.gh.state.commitsLoaded=true;
    t.click('tab-commits');t.click('tab-commits');
    assert.equal(t.requests.length,0);
  });
  await test('Repeated clicks on loading file tab do not duplicate request',async()=>{
    const t=setup();t.gh.state.repo=t.gh.state.repos[0];
    t.click('tab-files');t.click('tab-files');assert.equal(t.requests.length,1);
    t.answer(t.requests[0],{type:'dir',items:[]});await flush();
  });
  await test('Sync stays single-flight and cannot overwrite another repository',async()=>{
    const t=setup();t.gh.state.repo=t.gh.state.repos[0];t.gh.state.branch='main';
    t.gh.state.account.links=[{id:'one',repo:'me/one',branch:'main'}];
    const pending=t.gh.startSync();t.gh.startSync();assert.equal(t.requests.length,1);
    const next=t.gh.selectRepo('me/two');
    t.answer(t.requests[1],{items:[{name:'dev'}],has_next:false});
    t.answer(t.requests[2],{items:[],has_next:false});await next;
    t.answer(t.requests[0],{items:[{sha:'aaaaaaa'}],new_shas:[],synced_at:'now'});await pending;
    assert.equal(t.gh.state.repo.full_name,'me/two');assert.equal(t.gh.state.commits.length,0);
    assert.equal(t.gh.state.account.links[0].synced_at,'now');
  });
  await test('Failed live commits load explicitly marked local snapshot',async()=>{
    const t=setup();t.gh.state.account.links=[{id:'one',repo:'me/one',branch:'main'}];
    const pending=t.gh.selectRepo('me/one');
    t.answer(t.requests[0],{items:[{name:'main'}],has_next:false});
    t.answer(t.requests[1],{error:'offline'},false);await flush();
    assert(t.requests[2].url.includes('/cached?'));
    t.answer(t.requests[2],{items:[],synced_at:'now'});await pending;
    assert(t.gh.state.cached);assert.equal(t.gh.state.error,'offline');
  });
  console.log(`${count} GitHub asynchronous checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
