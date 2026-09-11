"""Management feature regression tests; no sockets and no personal data."""
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from run_all_offline import call_handler
import server


class ManagementTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, server, 'DATABASE', server.DATABASE)
        temp = tempfile.TemporaryDirectory(prefix='flow-management-', dir=Path(__file__).parent)
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        server.DATABASE = self.directory / 'management.sqlite3'
        server.init_db()
        self.revision = 0

    def call(self, path, method='GET', payload=None, headers=None):
        code, result = call_handler(path, method, payload, headers, self.revision)
        if isinstance(result, dict) and 'revision' in result and path != '/api/restore/preview':
            self.revision = result['revision']
        return code, result

    def row(self, kind, **changes):
        value = dict(title='中文需求' if kind == 'requirements' else '中文缺陷', description='原始内容 <script>x</script>',
                     owner='负责人', project_id=None, priority='high', due_date='2026-09-30',
                     status='draft' if kind == 'requirements' else 'open')
        value.update(dict(acceptance='满足条件后手动验收') if kind == 'requirements' else
                     dict(severity='critical', environment='Windows 11 / 1.0', steps='1. 打开页面\n2. 点击按钮', expected='正常保存', actual='出现错误'))
        value.update(changes)
        return value

    def create(self, kind, **changes):
        code, result = self.call('/api/' + kind, 'POST', self.row(kind, **changes))
        self.assertEqual(code, 200, result)
        return result[kind][0]

    def state(self):
        return self.call('/api/state')[1]

    def backup(self, scope='workspace'):
        code, result = self.call('/api/backups/export', 'POST', {'scope': scope})
        self.assertEqual(code, 200)
        return result

    def safety_files(self):
        return list(self.directory.glob('management.backups/*.json'))

    def test_empty_start_has_no_demo_data(self):
        self.assertEqual(self.state()['requirements'], [])
        self.assertEqual(self.state()['defects'], [])
        self.assertEqual(self.state()['tasks'], [])

    def test_requirement_crud_and_restart(self):
        row = self.create('requirements')
        server.init_db()
        self.assertEqual(self.state()['requirements'][0], row)
        code, result = self.call('/api/requirements/' + row['id'], 'PUT', {**row, 'title': '更新', 'acceptance': '验收更新', 'status': 'done'})
        self.assertEqual(code, 200)
        updated = result['requirements'][0]
        self.assertEqual(updated['acceptance'], '验收更新')
        self.assertTrue(updated['completed_at'])
        code, result = self.call('/api/requirements/' + row['id'], 'PUT', {**updated, 'status': 'doing'})
        self.assertEqual(code, 200)
        self.assertIsNone(result['requirements'][0]['completed_at'])
        self.assertEqual(self.call('/api/requirements/' + row['id'], 'DELETE', {})[0], 200)
        self.assertEqual(self.state()['requirements'], [])

    def test_defect_lifecycle_details_and_close_time(self):
        row = self.create('defects')
        for status in ['doing', 'verify', 'closed', 'closed', 'open']:
            code, result = self.call('/api/defects/' + row['id'], 'PUT', {**row, 'status': status})
            self.assertEqual(code, 200)
            updated = result['defects'][0]
            self.assertEqual(updated['steps'], row['steps'])
            self.assertEqual(updated['expected'], '正常保存')
            self.assertEqual(updated['severity'], 'critical')
            if status == 'closed':
                self.assertTrue(updated['completed_at'])
                if row['status'] == 'closed':
                    self.assertEqual(updated['completed_at'], row['completed_at'])
            else:
                self.assertIsNone(updated['completed_at'])
            row = updated
        self.assertEqual(self.call('/api/defects/' + row['id'], 'DELETE', {})[0], 200)

    def test_common_validation_is_atomic(self):
        for kind in ['requirements', 'defects']:
            for key, value in [('title', '  '), ('title', 'a'*161), ('owner', ''), ('priority', 'invalid'),
                               ('status', 'bad'), ('project_id', 'missing'), ('project_id', []), ('project_id', False),
                               ('due_date', '2026-02-30'), ('description', []), ('due_date', '2026-2-3')]:
                with self.subTest(kind=kind, key=key, value=value):
                    before = self.state()
                    self.assertEqual(self.call('/api/'+kind, 'POST', self.row(kind, **{key: value}))[0], 400)
                    self.assertEqual(self.state(), before)
        self.assertEqual(self.call('/api/requirements', 'POST', self.row('requirements', acceptance='x'*10001))[0], 400)
        self.assertEqual(self.call('/api/defects', 'POST', self.row('defects', severity='urgent'))[0], 400)
        self.assertEqual(self.call('/api/defects', 'POST', self.row('defects', environment='x'*1001))[0], 400)

    def test_empty_optional_dates_and_unknown_fields_allowlist(self):
        row = self.create('requirements', due_date='', token='must-not-save', progress=99)
        self.assertEqual(row['due_date'], '')
        self.assertNotIn('token', row)
        self.assertNotIn('progress', row)
        self.assertNotIn('must-not-save', json.dumps(self.backup()))

    def test_all_status_choices_and_kind_isolation(self):
        for kind, statuses in [('requirements', ['draft','ready','doing','review','done']), ('defects', ['open','doing','verify','closed'])]:
            row = self.create(kind)
            for status in statuses:
                self.assertEqual(self.call('/api/'+kind+'/'+row['id'], 'PUT', {**row, 'status': status})[0], 200)
        self.assertEqual(len(self.state()['tasks']), 0)
        self.assertEqual(self.call('/api/requirements', 'POST', self.row('requirements', status='closed'))[0], 400)
        self.assertEqual(self.call('/api/defects', 'POST', self.row('defects', status='done'))[0], 400)

    def test_revision_conflict_and_origin_guards(self):
        row = self.create('requirements')
        original = self.state()
        self.assertEqual(self.call('/api/requirements/'+row['id'], 'PUT', {**row, 'title':'覆盖'}, {'If-Match':'0'})[0], 409)
        self.assertEqual(self.state(), original)
        for kind in ['requirements', 'defects']:
            for headers in [{'X-Flow-Request':''}, {'Sec-Fetch-Site':'cross-site'}, {'Origin':'https://not-local.test'}]:
                self.assertEqual(self.call('/api/'+kind, 'POST', self.row(kind), headers)[0], 403)
        self.assertEqual(self.state(), original)

    def test_bulk_status_delete_and_missing_atomicity(self):
        for kind, terminal in [('requirements','done'), ('defects','closed')]:
            ids = [self.create(kind, title='条目'+str(i))['id'] for i in range(3)]
            before = self.state()
            self.assertEqual(self.call('/api/'+kind+'/bulk', 'POST', {'ids':ids+['missing'], 'action':'delete'})[0], 409)
            self.assertEqual(self.state(), before)
            code, state = self.call('/api/'+kind+'/bulk', 'POST', {'ids':ids, 'action':'status', 'status':terminal})
            self.assertEqual(code, 200)
            self.assertTrue(all(row['status']==terminal and row['completed_at'] for row in state[kind]))
            self.assertEqual(self.call('/api/'+kind+'/bulk', 'POST', {'ids':ids+ids, 'action':'delete'})[0], 200)
            self.assertEqual(self.state()[kind], [])

    def test_project_delete_guard_and_move(self):
        code, state = self.call('/api/projects', 'POST', dict(name='范围测试', description='', color='blue'))
        self.assertEqual(code, 200)
        project = state['projects'][0]
        for kind in ['requirements', 'defects']:
            row = self.create(kind, project_id=project['id'])
            self.assertEqual(self.call('/api/projects/'+project['id'], 'DELETE', {})[0], 409)
            self.assertEqual(self.call('/api/'+kind+'/'+row['id'], 'PUT', {**row, 'project_id':None})[0], 200)
        self.assertEqual(self.call('/api/projects/'+project['id'], 'DELETE', {})[0], 200)

    def test_new_backup_both_scopes_roundtrip(self):
        r, d = self.create('requirements', status='done'), self.create('defects', status='closed')
        for scope, fmt in [('projects','flow-backup-v2'), ('workspace','flow-workspace-v3')]:
            backup = self.backup(scope)
            self.assertEqual(backup['format'], fmt)
            self.assertEqual(backup['requirements'][0]['acceptance'], r['acceptance'])
            self.assertEqual(backup['defects'][0]['steps'], d['steps'])
            self.assertEqual('github' in backup, scope=='workspace')
            code, preview = self.call('/api/restore/preview', 'POST', {'backup':backup})
            self.assertEqual(code, 200)
            self.assertEqual(preview['requirements'], 1)
            self.assertEqual(preview['defects'], 1)
            self.assertFalse(preview['legacy_management'])
            code, state = self.call('/api/restore', 'POST', {'backup':backup})
            self.assertEqual(code, 200)
            self.assertEqual(state['requirements'][0]['completed_at'], r['completed_at'])
            self.assertEqual(state['defects'][0]['completed_at'], d['completed_at'])
            self.assertTrue(Path(state['restore_result']['safety_backup']).is_file())

    def test_legacy_backups_preview_warn_and_copy_before_clearing(self):
        for fmt in ['flow-backup-v1', 'flow-workspace-v2']:
            self.create('requirements')
            self.create('defects')
            backup = dict(format=fmt, projects=[], tasks=[])
            if fmt=='flow-workspace-v2':
                backup.update(github=dict(login='',links=[]), activities=[])
            code, p = self.call('/api/restore/preview', 'POST', {'backup':backup})
            self.assertEqual(code, 200)
            self.assertTrue(p['legacy_management'])
            self.assertEqual((p['current_requirements'],p['current_defects']), (1,1))
            code, state = self.call('/api/restore', 'POST', {'backup':backup})
            self.assertEqual(code, 200)
            self.assertEqual(state['requirements'], [])
            saved=json.loads(Path(state['restore_result']['safety_backup']).read_text(encoding='utf-8'))
            self.assertEqual(len(saved['requirements']), 1)
            self.assertEqual(len(saved['defects']), 1)

    def test_bad_backups_never_mutate(self):
        self.create('requirements')
        self.create('defects')
        good = self.backup()
        for change in ['missing','duplicate','severity','reference','timestamp','format','spoof']:
            backup = copy.deepcopy(good)
            if change=='missing': del backup['requirements']
            if change=='duplicate': backup['requirements'].append(copy.deepcopy(backup['requirements'][0]))
            if change=='severity': backup['defects'][0]['severity']='invalid'
            if change=='reference': backup['requirements'][0]['project_id']='missing'
            if change=='timestamp': backup['defects'][0]['created_at']='bad'
            if change=='format': backup['format']=[]
            if change=='spoof': backup['format']='flow-workspace-v2'
            before=self.state()
            self.assertEqual(self.call('/api/restore', 'POST', {'backup':backup})[0], 400, change)
            self.assertEqual(self.state(), before)
            self.assertEqual(self.safety_files(), [])

    def test_safety_write_failure_and_restore_rollback_preserve_new_data(self):
        self.create('requirements')
        self.create('defects')
        backup=self.backup()
        original=self.state()
        with patch('workspace_backup.os.replace', side_effect=PermissionError('test')):
            self.assertEqual(self.call('/api/restore', 'POST', {'backup':backup})[0], 503)
        self.assertEqual(self.state(), original)
        with patch.object(server, 'insert', side_effect=sqlite3.IntegrityError('simulated')), self.assertLogs(level='ERROR'):
            self.assertEqual(self.call('/api/restore', 'POST', {'backup':backup})[0], 500)
        self.assertEqual(self.state(), original)
        self.assertEqual(len(self.safety_files()), 1)

    def test_old_database_upgrade_is_additive_and_idempotent(self):
        self.call('/api/projects', 'POST', dict(name='保留项目',description='',color='violet'))
        before=self.state()
        with server.connect() as db:
            db.execute('DROP TABLE requirements')
            db.execute('DROP TABLE defects')
        server.init_db()
        server.init_db()
        self.assertEqual(self.state(), before)
        with server.connect() as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_database_relocation_copies_new_tables(self):
        self.create('requirements')
        self.create('defects')
        before=self.state()
        target=self.directory/'relocated.sqlite3'
        with patch.object(server.STORAGE, 'config', self.directory/'storage.json'):
            code, result=self.call('/api/storage/migrate', 'POST', {'path':str(target.resolve()), 'expected_path':str(server.DATABASE.resolve())})
            self.assertEqual(code, 200, result)
        current=self.state()
        self.assertEqual(current['requirements'], before['requirements'])
        self.assertEqual(current['defects'], before['defects'])
        self.assertTrue((self.directory/'management.sqlite3').is_file())

    def test_static_routes_and_local_counts(self):
        self.create('requirements')
        self.create('defects')
        code, status=self.call('/api/workspace-status')
        self.assertEqual(code, 200)
        self.assertEqual((status['requirements'],status['defects']), (1,1))
        for path in ['/project-flow/management.js','/project-flow/management.css']:
            self.assertEqual(self.call(path)[0], 200)
        self.assertEqual(self.call('/project-flow/management.py')[0], 404)
        self.assertEqual(self.call('/api/requirements/missing', 'DELETE', {})[0], 404)


if __name__ == '__main__':
    unittest.main(verbosity=2)
