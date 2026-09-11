import base64
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import github_api as gh
import server


class GitHubTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='flow-api-', dir=Path(__file__).parent)
        cls.addClassCleanup(cls.temp.cleanup)
        cls.original = server.DATABASE
        cls.addClassCleanup(setattr, server, 'DATABASE', cls.original)
        cls.http = server.FlowHTTPServer(('127.0.0.1', 58061), server.Handler)
        cls.addClassCleanup(cls.http.server_close)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.addClassCleanup(cls.thread.join)
        cls.addClassCleanup(cls.http.shutdown)

    def setUp(self):
        gh.READ_CACHE.clear()
        self.env = patch.dict(os.environ, {'FLOW_GITHUB_TOKEN': ''})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.token = patch.object(gh, 'TOKEN', '')
        self.token.start()
        self.addCleanup(self.token.stop)
        server.DATABASE = Path(self.temp.name) / (self._testMethodName + '.sqlite3')
        server.init_db()
        self.db = server.connect()
        self.addCleanup(self.db.close)
        self.remote = patch.object(gh, 'request')
        self.remote_mock = self.remote.start()
        self.addCleanup(self.remote.stop)
        self.remote_mock.return_value = ({'login': 'test-user', 'type': 'User'}, False)

    def call(self, path, method='GET', payload=None, headers=None):
        req = Request('http://127.0.0.1:58061' + path, method=method,
                      headers={'Content-Type': 'application/json', 'X-Flow-Request': '1', **(headers or {})},
                      data=json.dumps(payload).encode() if payload is not None else None)
        try:
            response = urlopen(req, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if 'json' in response.headers['Content-Type'] else raw

    def connect(self):
        return gh.write(self.db, 'connect', 'POST', {'login': 'test-user'})

    def tracked(self):
        result = gh.write(self.db, 'link', 'POST', {'repo': 'test-user/example', 'branch': 'main'})
        return result['links'][0]['id']

    @staticmethod
    def commit(sha='a' * 40):
        return {'sha': sha, 'author': {'login': 'test-user'},
                'commit': {'message': 'feat: 中文 <script>test</script>', 'author': {'name': 'Test', 'date': '2026-09-11T00:00:00Z', 'email': 'not-exported@example.com'}}}

    def test_status_does_not_return_token(self):
        gh.TOKEN = 'fake-test-secret'
        status = gh.status(self.db)
        self.assertTrue(status['token_configured'])
        self.assertNotIn(gh.TOKEN, json.dumps(status))
        self.assertEqual(self.call('/api/export')[1]['format'], 'flow-backup-v2')
        self.assertNotIn('github', json.dumps(self.call('/api/export')[1]))

    def test_public_connect(self):
        result = self.connect()
        self.assertEqual(result['login'], 'test-user')
        self.remote_mock.assert_called_with('/users/test-user')
        self.assertEqual(gh.status(self.db)['login'], 'test-user')

    def test_token_account_must_match(self):
        gh.TOKEN = 'fake-test-secret'
        with self.assertRaises(gh.GitHubError):
            gh.write(self.db, 'connect', 'POST', {'login': 'another-user'})
        self.remote_mock.assert_called_with('/user')
        self.assertEqual(gh.status(self.db)['login'], '')
        self.assertEqual(gh.write(self.db, 'connect', 'POST', {'login': ''})['login'], 'test-user')

    def test_public_and_private_repo_pagination(self):
        self.connect()
        self.remote_mock.return_value = ([{'full_name': 'test-user/example', 'private': True}], True)
        result = gh.read(self.db, 'repos', {'page': '2'})
        self.assertTrue(result['has_next'])
        self.assertEqual(self.remote_mock.call_args.args[0], '/users/test-user/repos')
        gh.TOKEN = 'fake-test-secret'
        gh.read(self.db, 'repos', {'page': '3'})
        path, params = self.remote_mock.call_args.args
        self.assertEqual(path, '/user/repos')
        self.assertEqual(params['affiliation'], 'owner')
        self.assertEqual(params['page'], 3)

    def test_validation_before_network(self):
        for endpoint, params in [('repo', {'repo': 'http://evil.test'}), ('repo', {'repo': 'x/..'}),
                                 ('contents', {'repo': 'a/b', 'path': '../secret'}),
                                 ('contents', {'repo': 'a/b', 'path': 'a\\b'}),
                                 ('commit', {'repo': 'a/b', 'sha': '../../user'}),
                                 ('commits', {'repo': 'a/b', 'page': '0'})]:
            with self.subTest(endpoint=endpoint, params=params), self.assertRaises(gh.GitHubError):
                gh.read(self.db, endpoint, params)
        self.remote_mock.assert_not_called()

    def test_contents_utf8(self):
        self.remote_mock.return_value = ({'type': 'file', 'size': 8, 'encoding': 'base64', 'content': base64.b64encode('中文源码'.encode()).decode()}, False)
        result = gh.read(self.db, 'contents', {'repo': 'a/b', 'branch': 'feature/ui', 'path': '文档/test.md'})
        self.assertEqual(result['text'], '中文源码')
        args = self.remote_mock.call_args.args
        self.assertIn('%E6%96%87', args[0])
        self.assertEqual(args[1]['ref'], 'feature/ui')

    def test_binary_large_and_submodule(self):
        for value in [{'type': 'file', 'size': 900000, 'encoding': 'none'},
                      {'type': 'file', 'size': 2, 'encoding': 'base64', 'content': 'AAA='},
                      {'type': 'file', 'submodule_git_url': 'https://example.invalid/repo'},
                      {'type': 'symlink'}]:
            self.remote_mock.return_value = (value, False)
            result = gh.read(self.db, 'contents', {'repo': 'a/b', 'refresh': '1'})
            self.assertTrue(result['notice'])
            self.assertEqual(result['text'], '')

    def test_directory_limit(self):
        self.remote_mock.return_value = ([{'name': 'a', 'path': 'a', 'type': 'file'}] * 1000, False)
        result = gh.read(self.db, 'contents', {'repo': 'a/b'})
        self.assertTrue(result['limited'])
        self.assertEqual(result['type'], 'dir')

    def test_commit_author_filter(self):
        self.connect()
        self.remote_mock.return_value = ([self.commit()], True)
        result = gh.read(self.db, 'commits', {'repo': 'a/b', 'mine': '1', 'branch': 'feature/ui', 'page': '2'})
        self.assertTrue(result['has_next'])
        self.assertEqual(self.remote_mock.call_args.args[1]['author'], 'test-user')
        self.assertEqual(result['items'][0]['author_login'], 'test-user')
        self.assertNotIn('email', json.dumps(result))

    def test_commit_detail_pagination_and_patch_limit(self):
        self.remote_mock.return_value = ({**self.commit(), 'stats': {'additions': 1},
                                         'files': [{'filename': 'test.js', 'status': 'added', 'patch': '+' * 100001}]}, True)
        result = gh.read(self.db, 'commit', {'repo': 'a/b', 'sha': 'a' * 40, 'page': '2'})
        self.assertTrue(result['has_next'])
        self.assertTrue(result['files'][0]['patch_truncated'])
        self.assertEqual(len(result['files'][0]['patch']), 100000)

    def test_link_upsert_and_branch_encoding(self):
        values = {'repo': 'a/b', 'branch': 'feature/ui'}
        gh.write(self.db, 'link', 'POST', values)
        gh.write(self.db, 'link', 'POST', values)
        self.assertEqual(len(gh.status(self.db)['links']), 1)
        self.remote_mock.assert_called_with('/repos/a/b/branches/feature%2Fui')

    def test_missing_project_rejected(self):
        with self.assertRaises(gh.GitHubError):
            gh.write(self.db, 'link', 'POST', {'repo': 'a/b', 'branch': 'main', 'project_id': 'absent'})
        self.assertEqual(gh.status(self.db)['links'], [])

    def test_first_sync_new_commits_and_failure_cache(self):
        ident = self.tracked()
        self.remote_mock.return_value = ([self.commit()], False)
        first = gh.write(self.db, 'sync', 'POST', {'id': ident})
        self.assertTrue(first['first_sync'])
        self.assertEqual(first['new_shas'], [])
        self.remote_mock.return_value = ([self.commit('b' * 40), self.commit()], False)
        second = gh.write(self.db, 'sync', 'POST', {'id': ident})
        self.assertEqual(second['new_shas'], ['b' * 40])
        self.remote_mock.side_effect = gh.GitHubError('offline', 502)
        with self.assertRaises(gh.GitHubError):
            gh.write(self.db, 'sync', 'POST', {'id': ident})
        self.assertEqual(len(gh.read(self.db, 'cached', {'id': ident})['items']), 2)
        self.assertEqual(self.db.execute('SELECT revision FROM meta').fetchone()[0], 0)

    def test_sync_gap_warning(self):
        ident = self.tracked()
        self.remote_mock.return_value = ([self.commit()], False)
        gh.write(self.db, 'sync', 'POST', {'id': ident})
        self.remote_mock.return_value = ([self.commit('b' * 40)], True)
        result = gh.write(self.db, 'sync', 'POST', {'id': ident})
        self.assertTrue(result['gap'])
        self.assertTrue(result['history_limited'])

    def test_sync_lock(self):
        ident = self.tracked()
        gh.SYNC_LOCK.acquire()
        try:
            with self.assertRaises(gh.GitHubError) as error:
                gh.write(self.db, 'sync', 'POST', {'id': ident})
            self.assertEqual(error.exception.status, 409)
        finally:
            gh.SYNC_LOCK.release()

    def test_project_delete_and_unlink(self):
        self.db.execute("INSERT INTO projects VALUES('p','name','','blue','now','now')")
        self.db.commit()
        result = gh.write(self.db, 'link', 'POST', {'repo': 'a/b', 'branch': 'main', 'project_id': 'p'})
        self.db.execute("DELETE FROM projects WHERE id='p'")
        self.db.commit()
        self.assertIsNone(gh.status(self.db)['links'][0]['project_id'])
        gh.write(self.db, 'link', 'DELETE', {'id': result['links'][0]['id']})
        self.assertEqual(gh.status(self.db)['links'], [])

    def test_http_guards_and_local_routes(self):
        self.assertEqual(self.call('/api/github/status', headers={'X-Flow-Request': ''})[0], 403)
        self.assertEqual(self.call('/api/github/status', headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.call('/api/github/status')[0], 200)
        self.assertEqual(self.call('/api/github/connect', 'POST', {'login': 'test-user'})[0], 200)
        self.assertEqual(self.call('/api/github/unknown?repo=a/b')[0], 404)
        self.assertEqual(self.call('/api/github/repos', 'DELETE', {})[0], 405)
        for path in ['/project-flow/github.js', '/project-flow/github.css']:
            self.assertEqual(self.call(path)[0], 200)
        self.assertEqual(self.call('/project-flow/github_api.py')[0], 404)


class TransportTest(unittest.TestCase):
    def test_outbound_errors_are_sanitized(self):
        for code, remaining, expected in [(401, '50', 401), (403, '0', 429), (403, '30', 403),
                                          (404, '30', 404), (302, '30', 409), (422, '30', 400), (500, '30', 502)]:
            with self.subTest(code=code), patch.dict(os.environ, {'FLOW_GITHUB_TOKEN': ''}), patch.object(gh, 'TOKEN', ''), patch.object(gh, 'build_opener') as opener:
                opener.return_value.open.side_effect = HTTPError(gh.API, code, 'SECRET', {'X-RateLimit-Remaining': remaining}, io.BytesIO(b'SECRET'))
                with self.assertRaises(gh.GitHubError) as error:
                    gh.request('/user')
                self.assertEqual(error.exception.status, expected)
                self.assertNotIn('SECRET', error.exception.message)

    def test_get_only_fixed_host_and_header(self):
        with patch.dict(os.environ, {'FLOW_GITHUB_TOKEN': ''}), patch.object(gh, 'TOKEN', 'fake-only'), patch.object(gh, 'build_opener') as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.read.return_value = b'[]'
            response.headers = {'Link': '<https://untrusted.invalid>; rel="next"'}
            self.assertEqual(gh.request('/user/repos', {'page': 2}), ([], True))
            req = opener.return_value.open.call_args.args[0]
            self.assertEqual(req.get_method(), 'GET')
            self.assertEqual(req.full_url, 'https://api.github.com/user/repos?page=2')
            self.assertEqual(req.get_header('Authorization'), 'Bearer fake-only')
            self.assertIsNone(gh.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test'))

    def test_empty_repo_and_network_failure(self):
        with patch.dict(os.environ, {'FLOW_GITHUB_TOKEN': ''}), patch.object(gh, 'TOKEN', ''), patch.object(gh, 'build_opener') as opener:
            opener.return_value.open.side_effect = HTTPError(gh.API, 409, 'empty', {}, io.BytesIO())
            self.assertEqual(gh.request('/repos/a/b/commits', allow_empty=True), ([], False))
            opener.return_value.open.side_effect = URLError('SECRET')
            with self.assertRaises(gh.GitHubError) as error:
                gh.request('/user')
            self.assertEqual(error.exception.status, 502)
            self.assertNotIn('SECRET', error.exception.message)


if __name__ == '__main__':
    unittest.main(verbosity=2)
