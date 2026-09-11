import copy
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import server


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.addClassCleanup(setattr, server, 'DATABASE', server.DATABASE)
        cls.temp_directory = tempfile.TemporaryDirectory(prefix='flow-api-', dir=Path(__file__).resolve().parent)
        cls.addClassCleanup(cls.temp_directory.cleanup)
        cls.temp = Path(cls.temp_directory.name)
        cls.http = ThreadingHTTPServer(('127.0.0.1', 58061), server.Handler)
        cls.addClassCleanup(cls.http.server_close)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.addClassCleanup(cls.thread.join)
        cls.addClassCleanup(cls.http.shutdown)

    def setUp(self):
        server.DATABASE = self.temp / (self._testMethodName + '.sqlite3')
        server.init_db()
        self.revision = 0

    def call(self, path, method='GET', payload=None, headers=None):
        base = {'Content-Type': 'application/json', 'X-Flow-Request': '1', 'If-Match': str(self.revision)}
        if headers:
            base.update(headers)
        request = urllib.request.Request('http://127.0.0.1:58061' + path,
                                         data=json.dumps(payload).encode() if payload is not None else None,
                                         headers=base, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            data = json.loads(raw) if 'application/json' in response.headers.get('Content-Type', '') else raw
            if isinstance(data, dict) and 'revision' in data:
                self.revision = data['revision']
            return response.status, data

    def project(self):
        status, state = self.call('/api/projects', 'POST', {'name': '中文项目', 'description': '真实描述', 'color': 'violet'})
        self.assertEqual(status, 200)
        return state['projects'][0]

    def task(self, **changes):
        value = {'title': '开发任务 <script>alert(1)</script>', 'description': '测试中文和 UTF-8', 'owner': '负责人',
                 'priority': 'high', 'status': 'doing', 'progress': 25, 'project_id': None,
                 'start_date': '2026-09-11', 'due_date': '2026-09-20'}
        value.update(changes)
        return value

    def test_empty_start(self):
        code, state = self.call('/api/state')
        self.assertEqual(code, 200)
        self.assertEqual(state['tasks'], [])
        self.assertEqual(state['projects'], [])
        self.assertEqual(state['activities'], [])

    def test_crud_and_persistence(self):
        project = self.project()
        code, state = self.call('/api/tasks', 'POST', self.task(project_id=project['id']))
        self.assertEqual(code, 200)
        task = state['tasks'][0]
        self.assertEqual(task['description'], '测试中文和 UTF-8')
        server.init_db()
        self.assertEqual(self.call('/api/state')[1]['tasks'][0]['id'], task['id'])
        code, state = self.call('/api/tasks/' + task['id'], 'PUT', {**task, 'status': 'done'})
        self.assertEqual(code, 200)
        self.assertEqual(state['tasks'][0]['progress'], 100)
        self.assertTrue(state['tasks'][0]['completed_at'])
        code, state = self.call('/api/tasks/' + task['id'], 'PUT', {**state['tasks'][0], 'status': 'doing'})
        self.assertIsNone(state['tasks'][0]['completed_at'])
        self.assertEqual(state['tasks'][0]['progress'], 99)
        self.assertEqual(self.call('/api/tasks/' + task['id'], 'DELETE', {})[0], 200)
        self.assertEqual(self.call('/api/projects/' + project['id'], 'DELETE', {})[0], 200)
        self.assertEqual(self.call('/api/state')[1]['tasks'], [])

    def test_task_validation(self):
        for field, value in [('title', '  '), ('owner', ''), ('priority', 'invalid'), ('status', 'invalid'),
                             ('progress', 101), ('progress', True), ('progress', 2.5), ('project_id', 'absent'),
                             ('start_date', '2026-02-30'), ('due_date', '2026-09-01'), ('title', 'a' * 161)]:
            with self.subTest(field=field, value=value):
                self.assertEqual(self.call('/api/tasks', 'POST', self.task(**{field: value}))[0], 400)
        self.assertEqual(self.call('/api/state')[1]['tasks'], [])
        self.assertEqual(self.revision, 0)

    def test_empty_dates_allowed(self):
        self.assertEqual(self.call('/api/tasks', 'POST', self.task(start_date='', due_date=''))[0], 200)

    def test_project_edit_and_guard(self):
        p = self.project()
        self.assertEqual(self.call('/api/projects/' + p['id'], 'PUT', {**p, 'name': '更新名称', 'color': 'green'})[0], 200)
        self.assertEqual(self.call('/api/tasks', 'POST', self.task(project_id=p['id']))[0], 200)
        self.assertEqual(self.call('/api/projects/' + p['id'], 'DELETE', {})[0], 409)
        self.assertEqual(len(self.call('/api/state')[1]['tasks']), 1)

    def test_conflict_detection(self):
        self.project()
        code, _ = self.call('/api/tasks', 'POST', self.task(), {'If-Match': '0'})
        self.assertEqual(code, 409)
        self.assertEqual(self.call('/api/state')[1]['tasks'], [])

    def test_csrf_and_content_type(self):
        self.assertEqual(self.call('/api/tasks', 'POST', self.task(), {'X-Flow-Request': ''})[0], 403)
        self.assertEqual(self.call('/api/tasks', 'POST', self.task(), {'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.call('/api/tasks', 'POST', self.task(), {'Content-Type': 'text/plain'})[0], 415)

    def test_bulk(self):
        for i in range(3):
            self.call('/api/tasks', 'POST', self.task(title='任务' + str(i)))
        ids = [t['id'] for t in self.call('/api/state')[1]['tasks']]
        code, state = self.call('/api/tasks/bulk', 'POST', {'ids': ids, 'action': 'status', 'status': 'done'})
        self.assertEqual(code, 200)
        self.assertTrue(all(t['progress'] == 100 and t['completed_at'] for t in state['tasks']))
        self.assertEqual(self.call('/api/tasks/bulk', 'POST', {'ids': ids, 'action': 'delete'})[0], 200)
        self.assertEqual(self.call('/api/state')[1]['tasks'], [])

    def test_bulk_missing_is_atomic(self):
        _, state = self.call('/api/tasks', 'POST', self.task())
        ident = state['tasks'][0]['id']
        self.assertEqual(self.call('/api/tasks/bulk', 'POST', {'ids': [ident, 'missing'], 'action': 'delete'})[0], 409)
        self.assertEqual(len(self.call('/api/state')[1]['tasks']), 1)

    def test_backup_roundtrip(self):
        project = self.project()
        self.call('/api/tasks', 'POST', self.task(project_id=project['id'], status='done'))
        code, backup = self.call('/api/export')
        self.assertEqual(code, 200)
        code, state = self.call('/api/restore', 'POST', {'backup': backup})
        self.assertEqual(code, 200)
        self.assertEqual(state['projects'][0]['id'], project['id'])
        self.assertEqual(state['tasks'][0]['completed_at'], backup['tasks'][0]['completed_at'])
        self.assertEqual(state['tasks'][0]['title'], backup['tasks'][0]['title'])

    def test_backup_rollback(self):
        self.project()
        self.call('/api/tasks', 'POST', self.task())
        original = self.call('/api/state')[1]
        backup = self.call('/api/export')[1]
        backup['tasks'][0]['due_date'] = 'bad'
        self.assertEqual(self.call('/api/restore', 'POST', {'backup': backup})[0], 400)
        self.assertEqual(self.call('/api/state')[1], original)
        backup = self.call('/api/export')[1]
        backup['projects'].append(copy.deepcopy(backup['projects'][0]))
        self.assertEqual(self.call('/api/restore', 'POST', {'backup': backup})[0], 400)
        self.assertEqual(self.call('/api/state')[1], original)

    def test_static_security(self):
        for path in ['/data/flow.sqlite3', '/server.py', '/project-flow/../server.py', '/project-flow/data/flow.sqlite3']:
            self.assertEqual(self.call(path)[0], 404)
        for path in ['/project-flow/', '/project-flow/app.js', '/project-flow/styles.css', '/project-flow/favicon.svg']:
            self.assertEqual(self.call(path)[0], 200)
        self.assertEqual(self.call('/api/health')[1]['ok'], True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
