'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..','src');
const elements=new Map();
function element(key){if(!elements.has(key))elements.set(key,{innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',classList:{add(){},remove(){},toggle(){}},dataset:{},setAttribute(){},addEventListener(){},querySelectorAll(){return [];}});return elements.get(key);}
const document={querySelector:element,querySelectorAll:()=>[],addEventListener(){},documentElement:{dataset:{theme:'dark'}}};
const context=vm.createContext({document,console,setTimeout,clearTimeout,setInterval(){},URLSearchParams,Date,Set,
  localStorage:{getItem(){return null;},setItem(){}},window:{addEventListener(){}},location:{hash:''},history:{replaceState(){}},
  fetch(){throw new Error('Network prohibited in isolated tests');}});
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
vm.runInContext(app.slice(0,app.lastIndexOf('fillIcons();try')),context);
const gh=fs.readFileSync(path.join(root,'github.js'),'utf8');
assert(gh.includes('window.FlowGitHub={mount};'));
vm.runInContext(gh.replace('window.FlowGitHub={mount};','window.FlowGitHub={mount,state,paint,accountPanel,repoList,workspace,commitList,fileBrowser,detailView,trackedPanel};'),context);
let count=0;
function test(name,code){assert.equal(vm.runInContext(code,context),true,name);count++;console.log('PASS',name);}
vm.runInContext("const gh=window.FlowGitHub; gh.state.started=true;",context);
test('GitHub route is restored',"location.hash='#github';hydrateRoute();section==='github'");
test('GitHub route hides task heading buttons',"loaded=true;render();document.querySelector('.heading-actions').hidden && document.querySelector('#content').innerHTML.includes('GitHub 连接')");
test('Connection is centralized in settings',"gh.accountPanel().includes('data-nav=\"settings\"') && !gh.accountPanel().includes('gh-connect')");
test('Public connection is distinguished',"gh.accountPanel().includes('公开访问模式')");
test('Repository content escaped',"gh.state.repos=[{full_name:'a/b',description:'<img onerror=alert(1)>',private:true}];gh.repoList().includes('&lt;img')&&!gh.repoList().includes('<img')");
test('Empty selection renders guidance',"gh.state.repo=null;gh.workspace().includes('选择一个仓库')");
vm.runInContext("gh.state.repo={full_name:'a/b'};gh.state.branch='main';gh.state.account.login='me';gh.state.commits=[{sha:'aaaaaaa',message:'<script>bad</script>',author:'me',author_login:'me',date:'2026-09-11T00:00:00Z'},{sha:'bbbbbbb',message:'another',author:'other',author_login:'other'}];",context);
test('Commit titles escaped',"gh.commitList().includes('&lt;script&gt;')&&!gh.commitList().includes('<script>')");
test('Cached author filter',"gh.state.mine=true;gh.state.cached=true;!gh.commitList().includes('bbbbbbb')&&gh.commitList().includes('aaaaaaa')");
test('Cache limitations visible',"gh.commitList().includes('最近 100 条')");
test('HTML files shown as source',"gh.state.content={type:'file',size:10,text:'<script>bad</script>'};gh.fileBrowser().includes('&lt;script&gt;')&&!gh.fileBrowser().includes('<script>')");
test('Binary file notice and safe link',"gh.state.path='a.png';gh.state.content={type:'file',size:10,notice:'二进制'};gh.fileBrowser().includes('二进制')&&gh.fileBrowser().includes('https://github.com/a/b/blob/main/a.png')");
test('Directory limit visible',"gh.state.content={type:'dir',items:[],limited:true};gh.fileBrowser().includes('1000 项')");
test('Diff escaped with line colors',"gh.state.detail={sha:'aaaaaaa',message:'test',author:'me',stats:{},files:[{filename:'test.js',status:'added',additions:1,deletions:0,patch:'+<script>bad</script>'}]};gh.detailView().includes('&lt;script&gt;')&&!gh.detailView().includes('<script>')&&gh.detailView().includes('gh-add')");
test('Offline snapshots reachable',"gh.state.account.links=[{id:'link1',repo:'a/b',branch:'main'}];gh.trackedPanel().includes('data-gh=\"cache\"')");
test('Request failure visible without clearing content',"gh.state.error='<invalid token>';gh.paint();document.querySelector('#content').innerHTML.includes('&lt;invalid token&gt;')");
console.log(count+' GitHub frontend logic checks passed.');
