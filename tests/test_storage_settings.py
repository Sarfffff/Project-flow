import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import server
import github_api as gh
from storage_settings import StorageSettings
from run_all_offline import call_handler


class SettingsUpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='flow-api-settings-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.original = self.root / 'original.sqlite3'
        for name, value in [('DATABASE', self.original), ('STORAGE', StorageSettings(server))]:
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        server.STORAGE.config = self.root / 'storage.json'
        for p in [patch.object(gh, 'TOKEN', 'old-test-token'), patch.object(gh, 'USE_ENV_TOKEN', True), patch.dict(os.environ, {'FLOW_GITHUB_TOKEN': 'synthetic-env'})]:
            p.start()
            self.addCleanup(p.stop)
        server.init_db()
        with server.connect() as db:
            db.execute("INSERT INTO projects VALUES('p','中文项目','','blue','now','now')")
            db.execute("INSERT INTO github_settings VALUES(1,'old-user')")
        self.target = self.root / '新 数据.sqlite3'

    def migrate(self, **override):
        return call_handler('/api/storage/migrate', 'POST', {'path':str(self.target), 'expected_path':str(self.original), **override})

    def session(self, **payload):
        return call_handler('/api/github/session', 'POST', payload)

    def test_copy_preserves_original_and_persists_new_location(self):
        self.assertEqual(self.migrate()[0], 200)
        self.assertEqual(server.DATABASE, self.target)
        self.assertTrue(self.original.is_file())
        self.assertEqual(server.STORAGE.load(self.original), self.target)
        self.assertEqual(call_handler('/api/state')[1]['projects'][0]['name'], '中文项目')
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT revision FROM meta').fetchone()[0], 1)
        db = sqlite3.connect(self.original)
        try:
            self.assertEqual(db.execute('SELECT revision FROM meta').fetchone()[0], 0)
        finally:
            db.close()
        self.assertEqual(gh.TOKEN, 'old-test-token')

    def test_no_overwrite_existing_database(self):
        self.target.write_bytes(b'important original content')
        self.assertEqual(self.migrate()[0], 409)
        self.assertEqual(self.target.read_bytes(), b'important original content')
        self.assertEqual(server.DATABASE, self.original)

    def test_orphan_wal_blocks_migration(self):
        Path(str(self.target) + '-wal').write_bytes(b'keep')
        self.assertEqual(self.migrate()[0], 409)
        self.assertFalse(self.target.exists())

    def test_config_failure_keeps_old_database(self):
        with patch.object(server.STORAGE, 'save', side_effect=PermissionError()):
            self.assertEqual(self.migrate()[0], 503)
        self.assertEqual(server.DATABASE, self.original)
        self.assertFalse(self.target.exists())
        self.assertFalse(server.STORAGE.config.exists())

    def test_invalid_paths_and_changed_source(self):
        for path in ['relative.sqlite3', str(self.root / 'file.txt'), str(self.root / 'missing' / 'file.db'), str(self.original), '//host/share/test.db']:
            self.assertEqual(self.migrate(path=path)[0], 400)
        self.assertEqual(self.migrate(expected_path='stale')[0], 409)

    def test_missing_saved_database_fails_without_fallback(self):
        server.STORAGE.config.write_text(json.dumps({'database_path':str(self.target)}), encoding='utf-8')
        with self.assertRaises(server.Invalid):
            server.STORAGE.load(self.original)
        self.assertFalse(self.target.exists())

    def test_active_read_rejects_migration_and_session_change(self):
        with server.STORAGE.gate.access():
            self.assertEqual(self.migrate()[0], 409)
            self.assertEqual(self.session(mode='disconnect')[0], 409)
            self.assertEqual(call_handler('/api/state')[0], 200)
        self.assertEqual(self.migrate()[0], 200)

    def test_exclusive_operation_rejects_reads_and_releases_gate(self):
        with server.STORAGE.gate.access(exclusive=True):
            self.assertEqual(call_handler('/api/state')[0], 409)
        self.assertEqual(call_handler('/api/state')[0], 200)

    def test_new_routes_require_same_origin(self):
        for route in ['/api/storage/pick', '/api/storage/migrate', '/api/github/session']:
            for headers in [{'X-Flow-Request':''}, {'Sec-Fetch-Site':'cross-site'}, {'Origin':'https://evil.example','Host':'127.0.0.1:58061'}]:
                self.assertEqual(call_handler(route, 'POST', {}, headers)[0], 403)

    def test_folder_picker_success_cancel_and_error(self):
        with patch('storage_settings.subprocess.run', return_value=Mock(returncode=0, stdout=json.dumps(str(self.root)).encode())):
            self.assertEqual(call_handler('/api/storage/pick', 'POST', {})[1]['path'], str(self.root / 'flow.sqlite3'))
        with patch('storage_settings.subprocess.run', return_value=Mock(returncode=0, stdout=b'""')):
            self.assertTrue(call_handler('/api/storage/pick', 'POST', {})[1]['cancelled'])
        with patch('storage_settings.subprocess.run', side_effect=OSError()):
            self.assertEqual(call_handler('/api/storage/pick', 'POST', {})[0], 503)

    def test_token_validation_before_commit_no_token_in_status_or_backup(self):
        token = 'synthetic_' + 'a' * 30
        with patch.object(gh, 'request', return_value=({'login':'new-user','type':'User'}, False)) as remote:
            code, result = self.session(mode='token', token=token)
            self.assertEqual(code, 200)
            remote.assert_called_once_with('/user', token_override=token)
        self.assertEqual(gh.TOKEN, token)
        self.assertNotIn(token, json.dumps(result))
        self.assertNotIn(token, json.dumps(call_handler('/api/backups/export','POST',{'scope':'workspace'})[1]))
        self.assertNotIn(token.encode(), self.original.read_bytes())

    def test_invalid_token_and_mismatch_keep_previous_session(self):
        with patch.object(gh, 'request', side_effect=gh.GitHubError('expired',401)):
            self.assertEqual(self.session(mode='token',token='a'*30)[0], 401)
        with patch.object(gh, 'request', return_value=({'login':'other','type':'User'},False)):
            self.assertEqual(self.session(mode='token',token='a'*30,login='new-user')[0], 400)
        self.assertEqual(gh.TOKEN, 'old-test-token')
        self.assertEqual(call_handler('/api/github/status')[1]['login'], 'old-user')

    def test_bad_token_never_reaches_network(self):
        with patch.object(gh, 'request') as remote:
            self.assertEqual(self.session(mode='token',token='bad')[0], 400)
            remote.assert_not_called()

    def test_public_connection_does_not_use_previous_token(self):
        with patch.object(gh,'request',return_value=({'login':'new-user','type':'User'},False)) as remote:
            self.assertEqual(self.session(mode='public',login='new-user')[0],200)
            remote.assert_called_once_with('/users/new-user',token_override='')
        self.assertEqual(gh.credential(),'')

    def test_disconnect_clears_memory_and_does_not_fall_back_to_env(self):
        with patch.object(gh, 'request') as remote:
            self.assertEqual(self.session(mode='disconnect')[0], 200)
            remote.assert_not_called()
        self.assertEqual(gh.credential(), '')
        self.assertEqual(call_handler('/api/github/status')[1]['login'], '')


if __name__ == '__main__':
    unittest.main(verbosity=2)
