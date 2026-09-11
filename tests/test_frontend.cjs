'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const elements = new Map();
function element(key) {
  if (!elements.has(key)) elements.set(key, {
    innerHTML: '', textContent: '', hidden: false, disabled: false, value: '',
    classList: {add(){},remove(){},toggle(){}}, dataset:{},
    setAttribute(){},addEventListener(){},querySelectorAll(){return [];}
  });
  return elements.get(key);
}
const document = {
  querySelector: element, querySelectorAll: () => [], addEventListener(){},
  documentElement: {dataset: {theme:'dark'}}
};
const context = vm.createContext({document,console,setTimeout,clearTimeout,Date,Set,
  localStorage:{getItem(){return null;},setItem(){}},
  window:{addEventListener(){}}, location:{hash:''},history:{replaceState(){}},
  fetch(){throw new Error('Network is not permitted in isolated frontend tests');}
});
const bootstrap = source.lastIndexOf('fillIcons();try');
assert(bootstrap > 0);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.js'), 'utf8'), context);
vm.runInContext(source.slice(0, bootstrap), context);
let count = 0;
function test(name, code) {
  assert.equal(vm.runInContext(code, context), true, name);
  console.log('PASS', name);
  count++;
}
vm.runInContext(`
  data={revision:0,projects:[{id:'p1',name:'开发项目',color:'blue',description:'测试描述'}],activities:[],tasks:[
    {id:'t1',title:'设计界面',description:'视觉规范',owner:'小林',project_id:'p1',priority:'high',status:'doing',progress:30,start_date:'',due_date:'2000-01-01',created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z',completed_at:null},
    {id:'t2',title:'完成接口',description:'SQLite',owner:'小周',project_id:null,priority:'urgent',status:'done',progress:100,start_date:'',due_date:'2000-01-01',created_at:'2026-09-02T00:00:00Z',updated_at:'2026-09-02T00:00:00Z',completed_at:new Date().toISOString()},
    {id:'t3',title:'<img src=x onerror=alert(1)>',description:'',owner:'测试',project_id:'p1',priority:'low',status:'todo',progress:0,start_date:'',due_date:'',created_at:'2026-09-03T00:00:00Z',updated_at:'2026-09-03T00:00:00Z',completed_at:null}
  ]};loaded=true;ready=true;
`,context);
test('HTML text escaping', `esc('<img onerror="x">') === '&lt;img onerror=&quot;x&quot;&gt;'`);
test('Overdue excludes completed tasks', `!!overdue(data.tasks[0]) && !overdue(data.tasks[1]) && !overdue(data.tasks[2])`);
test('Completion rate uses actual state', `percent(data.tasks) === 33 && percent([]) === 0`);
test('Search matches owner', `filters=initialFilters();filters.query='小林';filtered().length===1 && filtered()[0].id==='t1'`);
test('Search matches project name', `filters=initialFilters();filters.query='开发项目';filtered().length===2`);
test('Combined status and priority filters', `filters=initialFilters();filters.status='done';filters.priority='urgent';filtered().length===1`);
test('Unassigned project filter', `filters=initialFilters();filters.project='none';filtered().length===1&&filtered()[0].id==='t2'`);
test('Priority sorting', `filters=initialFilters();filters.sort='priority';filtered()[0].id==='t2'`);
test('Missing deadlines sort last', `filters=initialFilters();filters.sort='due';filtered().at(-1).id==='t3'`);
test('Project scope', `projectId='p1';scope().length===2`);
test('Task row escapes injected markup', `taskRow(data.tasks[2]).includes('&lt;img') && !taskRow(data.tasks[2]).includes('<img')`);
test('Board renders all status columns', `board(data.tasks).match(/data-drop-status=/g).length===4`);
test('Statistics calculate actual counts', `stats(data.tasks).includes('33') && charts(data.tasks).includes('共 3 个任务')`);
test('Seven-day trend renders seven columns', `trend().match(/class="trend-column"/g).length===7`);
test('Pagination clamps out-of-range pages', `projectId=null;filters=initialFilters();page=99;mode='list';taskResults();page===1`);
test('Empty search has a reset action', `filters.query='不存在的任务';taskResults().includes('clear-filters')`);
test('All major routes render', `filters=initialFilters();['overview','tasks','projects','insights','settings'].every(s=>{section=s;render();return document.querySelector('#content').innerHTML.length>100;})`);
test('Theme switching uses valid themes', `applyTheme('light');document.documentElement.dataset.theme==='light'`);
test('Invalid theme falls back safely', `applyTheme('not-a-theme');document.documentElement.dataset.theme==='dark'`);
test('Deleted project route falls back', `projectId='missing';render();projectId===null && section==='tasks'`);
console.log(count + ' frontend logic checks passed. These checks do not replace real-browser interaction testing.');
