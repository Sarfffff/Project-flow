"""Run real handler/database tests without opening sockets or stopping the app."""
import io
import json
import sys
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
import test_server
import test_github
import test_github_cache
import server


def call_handler(path, method='GET', payload=None, headers=None, revision=0):
    handler = server.Handler.__new__(server.Handler)
    handler.path, handler.command = path, method
    raw = json.dumps(payload).encode() if payload is not None else b''
    handler.rfile = io.BytesIO(raw)
    handler.headers = Message()
    for key, value in {'Content-Type':'application/json', 'X-Flow-Request':'1', 'If-Match':str(revision),
                       'Content-Length':str(len(raw)), **(headers or {})}.items():
        handler.headers[key] = value
    output = []
    def send(status, body, mime='application/json; charset=utf-8', extra=None):
        if isinstance(body, bytes) and 'json' in mime:
            body = json.loads(body)
        output.append((status, body))
    handler.send = send
    (handler.do_GET if method == 'GET' else handler.write_request)()
    return output[0]


class OfflineApiTest(test_server.ApiTest):
    @classmethod
    def setUpClass(cls):
        cls.addClassCleanup(setattr, server, 'DATABASE', server.DATABASE)
        cls.temp_directory = tempfile.TemporaryDirectory(prefix='flow-api-', dir=Path(__file__).parent)
        cls.addClassCleanup(cls.temp_directory.cleanup)
        cls.temp = Path(cls.temp_directory.name)

    def call(self, path, method='GET', payload=None, headers=None):
        code, data = call_handler(path, method, payload, headers, self.revision)
        if isinstance(data, dict) and 'revision' in data and path != '/api/restore/preview':
            self.revision = data['revision']
        return code, data


class OfflineGitHubTest(test_github.GitHubTest):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='flow-api-', dir=Path(__file__).parent)
        cls.addClassCleanup(cls.temp.cleanup)
        cls.addClassCleanup(setattr, server, 'DATABASE', server.DATABASE)

    def call(self, path, method='GET', payload=None, headers=None):
        return call_handler(path, method, payload, headers)


class WorkspaceTest(OfflineApiTest):
    def seed(self):
        project = self.project()
        with server.connect() as db:
            db.execute('INSERT INTO github_settings VALUES(1,?)', ('test-user',))
            commits = [dict(sha='a'*40, message='private commit', author='Test', author_login='test-user', date=server.now())]
            db.execute('INSERT INTO github_links(id,repo,branch,project_id,synced_at,commits_json) VALUES(?,?,?,?,?,?)',
                       ('link1', 'test-user/private', 'main', project['id'], server.now(), json.dumps(commits)))
        return project

    def links(self):
        with server.connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM github_links')]

    def full(self):
        code, result = self.call('/api/backups/export', 'POST', {'scope':'workspace'})
        self.assertEqual(code, 200)
        return result

    def files(self):
        return list(server.DATABASE.parent.glob(server.DATABASE.stem + '.backups/*.json'))

    def test_new_project_restore_preserves_links(self):
        p = self.seed()
        backup = self.call('/api/export')[1]
        code, result = self.call('/api/restore', 'POST', {'backup':backup})
        self.assertEqual(code, 200)
        self.assertEqual(self.links()[0]['project_id'], p['id'])
        safety = Path(result['restore_result']['safety_backup'])
        self.assertTrue(safety.is_file())
        self.assertEqual(json.loads(safety.read_text(encoding='utf-8'))['github']['links'][0]['project_id'], p['id'])

    def test_new_preview_missing_project_and_no_writes(self):
        self.seed()
        backup = dict(format='flow-backup-v1', projects=[], tasks=[])
        code, p = self.call('/api/restore/preview', 'POST', {'backup':backup})
        self.assertEqual(code, 200)
        self.assertEqual(len(p['detached_links']), 1)
        self.assertEqual(self.files(), [])
        self.assertIsNotNone(self.links()[0]['project_id'])
        code, result = self.call('/api/restore', 'POST', {'backup':backup})
        self.assertEqual(code, 200)
        self.assertEqual(result['restore_result']['detached_links'], 1)
        self.assertIsNone(self.links()[0]['project_id'])
        self.assertEqual(json.loads(self.links()[0]['commits_json'])[0]['message'], 'private commit')

    def test_new_full_roundtrip_without_network_or_credentials(self):
        p = self.seed()
        with patch.object(server.github_api, 'TOKEN', 'synthetic-never-export'), patch.object(server.github_api, 'request') as remote:
            backup = self.full()
            self.assertNotIn('synthetic-never-export', json.dumps(backup))
            with server.connect() as db:
                db.execute('DELETE FROM github_links')
                db.execute("UPDATE github_settings SET login='other'")
            code, state = self.call('/api/restore', 'POST', {'backup':backup})
            self.assertEqual(code, 200)
            self.assertEqual(self.links()[0]['project_id'], p['id'])
            self.assertEqual(server.github_api.TOKEN, 'synthetic-never-export')
            self.assertEqual(self.call('/api/github/status')[1]['login'], 'test-user')
            remote.assert_not_called()

    def test_new_safety_write_failure_cancels_restore(self):
        self.seed()
        original = self.call('/api/state')[1]
        before = self.links()
        with patch('workspace_backup.os.replace', side_effect=PermissionError('test')):
            code, result = self.call('/api/restore', 'POST', {'backup':dict(format='flow-backup-v1', projects=[], tasks=[])})
        self.assertEqual(code, 503)
        self.assertIn('取消', result['error'])
        self.assertEqual(self.call('/api/state')[1], original)
        self.assertEqual(self.links(), before)
        self.assertEqual(self.files(), [])

    def test_new_invalid_backup_no_safety_or_data_change(self):
        self.seed()
        backup = self.full()
        backup['github']['links'][0]['project_id'] = 'missing'
        original = self.links()
        self.assertEqual(self.call('/api/restore', 'POST', {'backup':backup})[0], 400)
        self.assertEqual(self.links(), original)
        self.assertEqual(self.files(), [])

    def test_new_duplicate_and_malformed_github_records(self):
        self.seed()
        import copy
        good = self.full()
        for bad in [None, {}, {'links':None}, {'login':'bad/name','links':[]}]:
            backup = {**good, 'github':bad}
            self.assertEqual(self.call('/api/restore/preview','POST',{'backup':backup})[0],400)
        for mode in ['duplicate','sha','task','activity']:
            backup=copy.deepcopy(good)
            if mode=='duplicate':
                backup['github']['links'].append(copy.deepcopy(backup['github']['links'][0]))
            if mode=='sha':
                backup['github']['links'][0]['commits'][0]['sha']='bad'
            if mode=='task':
                backup['tasks']=[None]
            if mode=='activity':
                backup['activities']=[None]
            self.assertEqual(self.call('/api/restore/preview','POST',{'backup':backup})[0],400)

    def test_new_export_scope_metadata_and_status_privacy(self):
        self.seed()
        self.assertEqual(self.call('/api/backups/export','POST',{'scope':'bad'})[0],400)
        backup=self.full()
        self.assertEqual(backup['format'],'flow-workspace-v3')
        with patch.object(server.github_api,'TOKEN','synthetic-secret'):
            code,status=self.call('/api/workspace-status')
        self.assertEqual(code,200)
        self.assertEqual(status['database_path'],str(server.DATABASE.resolve()))
        self.assertEqual(status['github']['links'],1)
        self.assertTrue(status['github']['token_configured'])
        self.assertNotIn('synthetic-secret',json.dumps(status))
        self.assertEqual(status['last_export_scope'],'workspace')
        self.assertIsNotNone(status['last_export_at'])
        self.assertNotIn('github',self.call('/api/backups/export','POST',{'scope':'projects'})[1])

    def test_new_routes_source_guards(self):
        for route,method,payload in [('/api/workspace-status','GET',None),('/api/workspace-verify','POST',{}),('/api/backups/export','POST',{}),('/api/restore/preview','POST',{})]:
            for headers in [{'X-Flow-Request':''},{'Sec-Fetch-Site':'cross-site'}]:
                self.assertEqual(self.call(route,method,payload,headers)[0],403)
        for route in ['/project-flow/settings.js','/project-flow/settings.css']:
            self.assertEqual(self.call(route)[0],200)
        self.assertEqual(self.call('/project-flow/workspace_backup.py')[0],404)

    def test_new_preview_revision_conflict(self):
        self.seed()
        backup=self.full()
        preview=self.call('/api/restore/preview','POST',{'backup':backup})[1]
        self.call('/api/tasks','POST',self.task())
        code,_=self.call('/api/restore','POST',{'backup':backup},{'If-Match':str(preview['revision'])})
        self.assertEqual(code,409)
        self.assertEqual(self.files(),[])

    def test_new_verification_public_token_mismatch_and_failure(self):
        self.seed()
        with patch.object(server.github_api,'credential',return_value=''), patch.object(server.github_api,'request',return_value=({'type':'User'},False)) as remote:
            self.assertTrue(self.call('/api/workspace-verify','POST',{})[1]['ok'])
            remote.assert_called_once_with('/users/test-user')
        with patch.object(server.github_api,'credential',return_value='fake'), patch.object(server.github_api,'request',return_value=({'login':'other'},False)):
            self.assertFalse(self.call('/api/workspace-verify','POST',{})[1]['ok'])
        with patch.object(server.github_api,'request',side_effect=server.github_api.GitHubError('expired',401)):
            self.assertEqual(self.call('/api/workspace-verify','POST',{})[0],401)

    def test_new_multiple_safety_copies_and_rollback_after_copy(self):
        self.seed()
        backup=self.full()
        self.assertEqual(self.call('/api/restore','POST',{'backup':backup})[0],200)
        original=self.call('/api/state')[1]
        with patch.object(server,'insert',side_effect=server.sqlite3.IntegrityError('simulated')):
            self.assertEqual(self.call('/api/restore','POST',{'backup':backup})[0],500)
        self.assertEqual(self.call('/api/state')[1],original)
        self.assertEqual(len(self.files()),2)
        self.assertTrue(all(json.loads(p.read_text(encoding='utf-8'))['format']=='flow-workspace-v3' for p in self.files()))


if __name__ == '__main__':
    loader=unittest.defaultTestLoader
    suite=unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(OfflineApiTest))
    suite.addTests(loader.loadTestsFromTestCase(OfflineGitHubTest))
    suite.addTests(loader.loadTestsFromTestCase(test_github.TransportTest))
    suite.addTests(loader.loadTestsFromModule(test_github_cache))
    suite.addTests(WorkspaceTest(name) for name in loader.getTestCaseNames(WorkspaceTest) if name.startswith('test_new_'))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
