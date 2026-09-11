from __future__ import annotations

import argparse
import getpass
from functools import wraps
from storage_settings import StorageSettings
from management import ManagementStore
import github_api
import json
import logging
import os
import re
import socket
import sqlite3
import sys
from workspace_backup import WorkspaceBackups, MAX_BACKUP
import uuid
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
DATABASE = PROJECT_ROOT / 'data' / 'flow.sqlite3'
STATUSES = ('todo', 'doing', 'review', 'done')
PRIORITIES = ('low', 'medium', 'high', 'urgent')
COLORS = ('violet', 'blue', 'green', 'amber', 'pink')
MAX_BODY = 8 * 1024 * 1024
BACKUPS = WorkspaceBackups(sys.modules[__name__])
MANAGEMENT = ManagementStore(sys.modules[__name__])


class Invalid(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


STORAGE = StorageSettings(sys.modules[__name__])


def storage_guard(fn):
    @wraps(fn)
    def guarded(self):
        path = urlsplit(self.path).path
        if not path.startswith('/api/') or path == '/api/storage/pick':
            return fn(self)
        try:
            with STORAGE.gate.access(exclusive=path in ('/api/storage/migrate', '/api/github/session')):
                return fn(self)
        except Invalid as error:
            return self.send(error.status, {'error': error.message})
    return guarded


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


class ManagedConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def connect():
    db = sqlite3.connect(DATABASE, timeout=10, factory=ManagedConnection)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def init_db():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta VALUES (1,0);
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
            color TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
            project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
            owner TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('low','medium','high','urgent')),
            status TEXT NOT NULL CHECK(status IN ('todo','doing','review','done')),
            progress INTEGER NOT NULL CHECK(progress BETWEEN 0 AND 100),
            start_date TEXT NOT NULL, due_date TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
        ''')
        github_api.init_db(db)
        MANAGEMENT.init_db(db)
        BACKUPS.init_db(db)


def text(data, key, maximum, required=False):
    value = data.get(key, '')
    if not isinstance(value, str):
        raise Invalid(f'{key} 必须是文本')
    value = value.strip()
    if required and not value:
        raise Invalid({'title': '任务名称', 'name': '项目名称', 'owner': '负责人'}.get(key, key) + '不能为空')
    if len(value) > maximum:
        raise Invalid(f'{key} 超过长度限制（{maximum} 字符）')
    return value


def choose(data, key, values):
    value = data.get(key)
    if value not in values:
        raise Invalid(f'{key} 的值无效')
    return value


def day(data, key):
    value = text(data, key, 10)
    if value:
        try:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
                raise ValueError()
            date.fromisoformat(value)
        except ValueError:
            raise Invalid('日期必须是有效的 YYYY-MM-DD 格式')
    return value


def project_values(data):
    return dict(name=text(data, 'name', 80, True), description=text(data, 'description', 2000),
                color=choose(data, 'color', COLORS))


def task_values(data, db):
    values = dict(title=text(data, 'title', 160, True), description=text(data, 'description', 10000),
                  owner=text(data, 'owner', 80, True), priority=choose(data, 'priority', PRIORITIES),
                  status=choose(data, 'status', STATUSES), start_date=day(data, 'start_date'),
                  due_date=day(data, 'due_date'))
    if values['start_date'] and values['due_date'] and values['start_date'] > values['due_date']:
        raise Invalid('截止日期不能早于开始日期')
    progress = data.get('progress', 0)
    if type(progress) is not int or not 0 <= progress <= 100:
        raise Invalid('进度必须是 0 到 100 的整数')
    values['progress'] = 100 if values['status'] == 'done' else min(progress, 99)
    project_id = data.get('project_id') or None
    if project_id is not None and (not isinstance(project_id, str) or not db.execute('SELECT 1 FROM projects WHERE id=?', (project_id,)).fetchone()):
        raise Invalid('所选项目不存在')
    values['project_id'] = project_id
    return values


def insert(db, table, data):
    keys = list(data)
    db.execute(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})", list(data.values()))


def activity(db, message):
    db.execute('INSERT INTO activities(text,created_at) VALUES (?,?)', (message, now()))
    db.execute('DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY id DESC LIMIT 500)')


def snapshot(db):
    return dict(revision=db.execute('SELECT revision FROM meta WHERE id=1').fetchone()[0],
                projects=[dict(r) for r in db.execute('SELECT * FROM projects ORDER BY created_at,id')],
                tasks=[dict(r) for r in db.execute('SELECT * FROM tasks ORDER BY created_at DESC,id')],
                activities=[dict(r) for r in db.execute('SELECT * FROM activities ORDER BY id DESC LIMIT 50')],
                **MANAGEMENT.snapshot(db))


def mutate(db, method, path, data):
    stamp = now()
    if path == '/api/restore' and method == 'POST':
        return BACKUPS.restore(db, data.get('backup'))
    if re.match(r'/api/(requirements|defects)(?:/|$)', path):
        return MANAGEMENT.mutate(db, method, path, data)
    if path == '/api/tasks/bulk' and method == 'POST':
        ids = data.get('ids')
        if not isinstance(ids, list) or not ids or len(ids) > 1000 or any(not isinstance(i, str) for i in ids):
            raise Invalid('请选择 1 到 1000 个任务')
        ids = list(dict.fromkeys(ids))
        marks = ','.join('?' for _ in ids)
        found = db.execute(f'SELECT * FROM tasks WHERE id IN ({marks})', ids).fetchall()
        if len(found) != len(ids):
            raise Invalid('部分任务已不存在，请刷新', 409)
        if data.get('action') == 'delete':
            db.execute(f'DELETE FROM tasks WHERE id IN ({marks})', ids)
            activity(db, f'批量删除 {len(ids)} 个任务')
        elif data.get('action') == 'status':
            status = choose(data, 'status', STATUSES)
            for row in found:
                progress = 100 if status == 'done' else min(row['progress'], 99)
                completed = (row['completed_at'] or stamp) if status == 'done' else None
                db.execute('UPDATE tasks SET status=?,progress=?,completed_at=?,updated_at=? WHERE id=?', (status, progress, completed, stamp, row['id']))
            activity(db, f'批量更新 {len(ids)} 个任务状态')
        else:
            raise Invalid('无效的批量操作')
        return
    match = re.fullmatch(r'/api/(projects|tasks)(?:/([a-zA-Z0-9_-]+))?', path)
    if not match:
        raise Invalid('接口不存在', 404)
    table, ident = match.groups()
    if method == 'POST' and ident is None:
        values = project_values(data) if table == 'projects' else task_values(data, db)
        values.update(id=uuid.uuid4().hex, created_at=stamp, updated_at=stamp)
        if table == 'tasks':
            values['completed_at'] = stamp if values['status'] == 'done' else None
        insert(db, table, values)
        activity(db, f"创建{'项目' if table == 'projects' else '任务'}「{values.get('name', values.get('title'))}」")
        return
    if not ident or method not in ('PUT', 'DELETE'):
        raise Invalid('不支持的操作', 405)
    old = db.execute(f'SELECT * FROM {table} WHERE id=?', (ident,)).fetchone()
    if old is None:
        raise Invalid('记录不存在', 404)
    label = old['name'] if table == 'projects' else old['title']
    if method == 'DELETE':
        if table == 'projects' and (db.execute('SELECT 1 FROM tasks WHERE project_id=? LIMIT 1', (ident,)).fetchone() or MANAGEMENT.project_in_use(db, ident)):
            raise Invalid('项目下仍有任务、需求或缺陷，请先移动或删除这些记录', 409)
        db.execute(f'DELETE FROM {table} WHERE id=?', (ident,))
        activity(db, f'删除{"项目" if table == "projects" else "任务"}「{label}」')
        return
    values = project_values(data) if table == 'projects' else task_values(data, db)
    values['updated_at'] = stamp
    if table == 'tasks':
        values['completed_at'] = (old['completed_at'] or stamp) if values['status'] == 'done' else None
    db.execute(f"UPDATE {table} SET {','.join(k+'=?' for k in values)} WHERE id=?", [*values.values(), ident])
    activity(db, f'更新{"项目" if table == "projects" else "任务"}「{values.get("name", values.get("title"))}」')


def timestamp(value, fallback):
    if value is None:
        return fallback
    if not isinstance(value, str) or len(value) > 40:
        raise Invalid('备份中的时间戳无效')
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds')
    except ValueError:
        raise Invalid('备份中的时间戳无效')


class FlowHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    server_version = 'Flow/1.0'

    def send(self, status, body, mime='application/json; charset=utf-8', extra=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def github_read(self):
        try:
            if self.headers.get('X-Flow-Request') != '1' or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise github_api.GitHubError('请求来源校验失败', 403)
            parsed = urlsplit(self.path)
            query = {k: v[-1] for k, v in parse_qs(parsed.query, keep_blank_values=True).items()}
            with connect() as db:
                result = github_api.read(db, parsed.path.removeprefix('/api/github/'), query)
            return self.send(200, result)
        except github_api.GitHubError as error:
            return self.send(error.status, {'error': error.message})
        except Exception:
            return self.send(500, {'error': 'GitHub 集成操作失败，请刷新后重试'})

    def log_message(self, format, *args):
        if urlsplit(self.path).path.startswith('/api/github/'):
            return
        super().log_message(format, *args)

    @storage_guard
    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/github/'):
            return self.github_read()
        if path == '/api/workspace-status':
            try:
                self.require_local_request()
                with connect() as db:
                    db.execute('BEGIN')
                    state = BACKUPS.status(db)
                return self.send(200, state)
            except Invalid as error:
                return self.send(error.status, {'error': error.message})
        if path in ('/api/state', '/api/export'):
            with connect() as db:
                db.execute('BEGIN')
                state = BACKUPS.pack(db) if path == '/api/export' else snapshot(db)
            if path == '/api/export':
                return self.send(200, state, extra={'Content-Disposition': 'attachment; filename="flow-backup.json"'})
            return self.send(200, state)
        if path == '/api/health':
            return self.send(200, {'ok': True, 'app': 'Flow', 'version': 1})
        if path in ('/', '/project-flow'):
            return self.send(302, b'', extra={'Location': '/project-flow/'})
        files = {'/project-flow/': ('index.html', 'text/html; charset=utf-8'),
                 '/project-flow/index.html': ('index.html', 'text/html; charset=utf-8'),
                 '/project-flow/styles.css': ('styles.css', 'text/css; charset=utf-8'),
                 '/project-flow/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                 '/project-flow/management.js': ('management.js', 'text/javascript; charset=utf-8'),
                 '/project-flow/management.css': ('management.css', 'text/css; charset=utf-8'),
                 '/project-flow/github.js': ('github.js', 'text/javascript; charset=utf-8'),
                 '/project-flow/settings.js': ('settings.js', 'text/javascript; charset=utf-8'),
                 '/project-flow/settings.css': ('settings.css', 'text/css; charset=utf-8'),
                 '/project-flow/github.css': ('github.css', 'text/css; charset=utf-8'),
                 '/project-flow/favicon.svg': ('favicon.svg', 'image/svg+xml')}
        if path not in files:
            return self.send(404, {'error': '页面不存在'})
        filename, mime = files[path]
        try:
            self.send(200, (ROOT / filename).read_bytes(), mime)
        except OSError:
            self.send(500, {'error': '应用资源缺失'})

    def require_local_request(self):
        if self.headers.get('X-Flow-Request') != '1' or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise Invalid('请求来源校验失败', 403)
        origin = self.headers.get('Origin')
        if origin and (urlsplit(origin).scheme not in ('http', 'https') or urlsplit(origin).netloc != self.headers.get('Host')):
            raise Invalid('请求来源校验失败，请在项目页面操作', 403)

    @storage_guard
    def write_request(self):
        try:
            self.require_local_request()
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise Invalid('需要 JSON 格式请求', 415)
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                raise Invalid('请求长度无效')
            request_path = urlsplit(self.path).path
            limit = MAX_BACKUP + 1024 * 1024 if request_path in ('/api/restore', '/api/restore/preview') else MAX_BODY
            if not 0 < size <= limit:
                raise Invalid('请求过大或为空', 413)
            try:
                data = json.loads(self.rfile.read(size))
            except (ValueError, UnicodeDecodeError):
                raise Invalid('JSON 格式无效')
            if not isinstance(data, dict):
                raise Invalid('请求必须是 JSON 对象')
            request_path = urlsplit(self.path).path
            if request_path == '/api/storage/pick' and self.command == 'POST':
                return self.send(200, STORAGE.pick_folder())
            if request_path == '/api/storage/migrate' and self.command == 'POST':
                return self.send(200, STORAGE.migrate(data))
            if request_path == '/api/backups/export' and self.command == 'POST':
                with connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    scope = data.get('scope', 'projects')
                    backup = BACKUPS.pack(db, scope)
                    raw = BACKUPS.encode(backup)
                    BACKUPS.remember(db, 'last_export_at', backup['exported_at'])
                    BACKUPS.remember(db, 'last_export_scope', scope)
                return self.send(200, raw, extra={'Content-Disposition': 'attachment; filename="flow-backup.json"'})
            if request_path == '/api/restore/preview' and self.command == 'POST':
                with connect() as db:
                    db.execute('BEGIN')
                    result = BACKUPS.preview(db, data.get('backup'))
                return self.send(200, result)
            if request_path == '/api/workspace-verify' and self.command == 'POST':
                with connect() as db:
                    account = github_api.status(db)
                if account['token_configured']:
                    profile, _ = github_api.request('/user')
                    verified_login = github_api.login_name(profile['login'])
                    matches = not account['login'] or verified_login.casefold() == account['login'].casefold()
                    message = ('令牌账号验证成功：' + verified_login + '；仓库权限需在工作台逐个确认') if matches else '令牌账号与已保存账号不同，请前往 GitHub 工作台重新连接'
                elif account['login']:
                    profile, _ = github_api.request('/users/' + github_api.login_name(account['login']))
                    matches = profile.get('type') == 'User'
                    message = '公开账号可访问；未验证私有仓库授权' if matches else '当前配置不是个人账号'
                else:
                    raise Invalid('请先在 GitHub 工作台连接账号')
                return self.send(200, dict(ok=matches, message=message, checked_at=now()))
            if request_path.startswith('/api/github/'):
                with connect() as db:
                    result = github_api.write(db, request_path.removeprefix('/api/github/'), self.command, data)
                return self.send(200, result)
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                revision = db.execute('SELECT revision FROM meta WHERE id=1').fetchone()[0]
                if self.headers.get('If-Match') != str(revision):
                    raise Invalid('数据已在其他页面更新，请刷新后重试；本次更改尚未保存', 409)
                restore_result = mutate(db, self.command, request_path, data)
                db.execute('UPDATE meta SET revision=revision+1 WHERE id=1')
                state = snapshot(db)
                if request_path == '/api/restore':
                    state['restore_result'] = restore_result
            if request_path == '/api/restore':
                github_api.READ_CACHE.clear()
            self.send(200, state)
        except (Invalid, github_api.GitHubError) as error:
            self.send(error.status, {'error': error.message})
        except sqlite3.Error:
            logging.exception('Database error')
            self.send(500, {'error': '数据库操作失败，本次修改未保存'})
        except Exception:
            logging.exception('Unhandled request error')
            self.send(500, {'error': '服务异常，本次修改未保存'})

    do_POST = do_PUT = do_DELETE = write_request


def main():
    global DATABASE
    parser = argparse.ArgumentParser(description='Flow local project manager')
    parser.add_argument('--port', type=int, default=58061)
    parser.add_argument('--db', type=Path, default=None)
    parser.add_argument('--github-login', action='store_true', help='Securely prompt for a GitHub read-only token; held in process memory only')
    args = parser.parse_args()
    if args.github_login:
        token = getpass.getpass('GitHub read-only token (hidden, memory only): ').strip()
        if not re.fullmatch(r'[A-Za-z0-9_]{20,255}', token):
            parser.error('Token format is invalid')
        github_api.TOKEN = token
    try:
        DATABASE = args.db.resolve() if args.db else STORAGE.load(DATABASE)
    except Invalid as error:
        parser.error(error.message)
    init_db()
    server = FlowHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Flow running at http://127.0.0.1:{args.port}/project-flow/', flush=True)
    print(f'Database: {DATABASE}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
