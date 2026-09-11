"""Small, independent requirement and defect registers for a local workspace."""
from __future__ import annotations

import re
import uuid


KINDS = {
    'requirements': {
        'label': '需求', 'statuses': ('draft', 'ready', 'doing', 'review', 'done'),
        'finished': 'done', 'fields': {'acceptance': 10000},
    },
    'defects': {
        'label': '缺陷', 'statuses': ('open', 'doing', 'verify', 'closed'),
        'finished': 'closed',
        'fields': {'steps': 10000, 'expected': 10000, 'actual': 10000, 'environment': 1000},
    },
}
SEVERITIES = ('critical', 'major', 'minor', 'trivial')
MAX_ITEMS = 20000


class ManagementStore:
    def __init__(self, service):
        self.service = service

    def init_db(self, db):
        for table, config in KINDS.items():
            statuses = ','.join("'" + status + "'" for status in config['statuses'])
            extra = ','.join(name + " TEXT NOT NULL DEFAULT ''" for name in config['fields'])
            if table == 'defects':
                extra += ", severity TEXT NOT NULL DEFAULT 'major' CHECK(severity IN ('critical','major','minor','trivial'))"
            db.execute(f'''CREATE TABLE IF NOT EXISTS {table} (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
                project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
                owner TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('low','medium','high','urgent')),
                status TEXT NOT NULL CHECK(status IN ({statuses})), due_date TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
                {extra}
            )''')
            db.execute(f'CREATE INDEX IF NOT EXISTS {table}_project ON {table}(project_id)')

    def values(self, table, data, db):
        s, config = self.service, KINDS[table]
        title = s.text(data, 'title', 160)
        if not title:
            raise s.Invalid(config['label'] + '名称不能为空')
        values = dict(title=title, description=s.text(data, 'description', 10000),
                      owner=s.text(data, 'owner', 80, True),
                      priority=s.choose(data, 'priority', s.PRIORITIES),
                      status=s.choose(data, 'status', config['statuses']), due_date=s.day(data, 'due_date'))
        project = data.get('project_id')
        if project == '':
            project = None
        if project is not None and (not isinstance(project, str) or not db.execute('SELECT 1 FROM projects WHERE id=?', (project,)).fetchone()):
            raise s.Invalid('所选项目不存在')
        values['project_id'] = project
        for name, maximum in config['fields'].items():
            values[name] = s.text(data, name, maximum)
        if table == 'defects':
            values['severity'] = s.choose(data, 'severity', SEVERITIES)
        return values

    def snapshot(self, db):
        return {table: [dict(row) for row in db.execute(f'SELECT * FROM {table} ORDER BY created_at DESC,id')]
                for table in KINDS}

    def counts(self, db):
        return {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in KINDS}

    def project_in_use(self, db, ident):
        return any(db.execute(f'SELECT 1 FROM {table} WHERE project_id=? LIMIT 1', (ident,)).fetchone() for table in KINDS)

    def bulk(self, db, table, data):
        s, config = self.service, KINDS[table]
        ids = data.get('ids')
        if not isinstance(ids, list) or not ids or len(ids) > 1000 or any(not isinstance(i, str) for i in ids):
            raise s.Invalid('请选择 1 到 1000 条记录')
        ids = list(dict.fromkeys(ids))
        marks = ','.join('?' for _ in ids)
        rows = db.execute(f'SELECT id,completed_at FROM {table} WHERE id IN ({marks})', ids).fetchall()
        if len(rows) != len(ids):
            raise s.Invalid('部分记录已不存在，请刷新后重试', 409)
        if data.get('action') == 'delete':
            db.execute(f'DELETE FROM {table} WHERE id IN ({marks})', ids)
            s.activity(db, f'批量删除 {len(ids)} 个{config["label"]}')
        elif data.get('action') == 'status':
            status = s.choose(data, 'status', config['statuses'])
            stamp = s.now()
            for row in rows:
                completed = (row['completed_at'] or stamp) if status == config['finished'] else None
                db.execute(f'UPDATE {table} SET status=?,completed_at=?,updated_at=? WHERE id=?',
                           (status, completed, stamp, row['id']))
            s.activity(db, f'批量更新 {len(ids)} 个{config["label"]}状态')
        else:
            raise s.Invalid('无效的批量操作')

    def mutate(self, db, method, path, data):
        s = self.service
        match = re.fullmatch(r'/api/(requirements|defects)(?:/([a-zA-Z0-9_-]+))?', path)
        if not match:
            raise s.Invalid('接口不存在', 404)
        table, ident = match.groups()
        config, stamp = KINDS[table], s.now()
        if ident == 'bulk' and method == 'POST':
            return self.bulk(db, table, data)
        if method == 'POST' and ident is None:
            if db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] >= MAX_ITEMS:
                raise s.Invalid(f'{config["label"]}最多保存 {MAX_ITEMS} 条')
            values = self.values(table, data, db)
            values.update(id=uuid.uuid4().hex, created_at=stamp, updated_at=stamp,
                          completed_at=stamp if values['status'] == config['finished'] else None)
            s.insert(db, table, values)
            s.activity(db, f'创建{config["label"]}「{values["title"]}」')
            return
        if not ident or method not in ('PUT', 'DELETE'):
            raise s.Invalid('不支持的操作', 405)
        old = db.execute(f'SELECT * FROM {table} WHERE id=?', (ident,)).fetchone()
        if old is None:
            raise s.Invalid('记录不存在', 404)
        if method == 'DELETE':
            db.execute(f'DELETE FROM {table} WHERE id=?', (ident,))
            s.activity(db, f'删除{config["label"]}「{old["title"]}」')
            return
        values = self.values(table, data, db)
        values.update(updated_at=stamp,
                      completed_at=(old['completed_at'] or stamp) if values['status'] == config['finished'] else None)
        db.execute(f'UPDATE {table} SET ' + ','.join(key + '=?' for key in values) + ' WHERE id=?', [*values.values(), ident])
        s.activity(db, f'更新{config["label"]}「{values["title"]}」')
