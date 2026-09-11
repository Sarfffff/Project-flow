"""Portable allowlisted backups. Never serialize credentials or browser storage."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone

import github_api
from management import KINDS, MAX_ITEMS

MAX_BACKUP = 64 * 1024 * 1024
FORMATS = {'flow-backup-v1', 'flow-workspace-v2', 'flow-backup-v2', 'flow-workspace-v3'}
WORKSPACE_FORMATS = {'flow-workspace-v2', 'flow-workspace-v3'}
MANAGEMENT_FORMATS = {'flow-backup-v2', 'flow-workspace-v3'}


class WorkspaceBackups:
    def __init__(self, service):
        self.service = service

    def init_db(self, db):
        db.execute('CREATE TABLE IF NOT EXISTS workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

    def remember(self, db, key, value):
        db.execute('INSERT INTO workspace_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))

    def pack(self, db, scope='projects'):
        s = self.service
        if scope not in ('projects', 'workspace'):
            raise s.Invalid('无效的备份范围')
        state = s.snapshot(db)
        result = dict(format='flow-backup-v2', exported_at=s.now(), projects=state['projects'], tasks=state['tasks'],
                      requirements=state['requirements'], defects=state['defects'])
        if scope == 'workspace':
            result['format'] = 'flow-workspace-v3'
            row = db.execute('SELECT login FROM github_settings WHERE id=1').fetchone()
            links = []
            for row_link in db.execute('SELECT id,repo,branch,project_id,synced_at,commits_json FROM github_links ORDER BY repo,branch'):
                item = dict(row_link)
                item['commits'] = json.loads(item.pop('commits_json'))
                links.append(item)
            result['github'] = dict(login=row['login'] if row else '', links=links)
            result['activities'] = [dict(row) for row in db.execute('SELECT text,created_at FROM activities ORDER BY id LIMIT 500')]
        return result

    def encode(self, backup):
        raw = json.dumps(backup, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(raw) > MAX_BACKUP:
            raise self.service.Invalid('备份超过 64 MB，无法安全导出或恢复', 413)
        return raw

    def validate(self, backup):
        s = self.service
        if not isinstance(backup, dict) or not isinstance(backup.get('format'), str) or backup['format'] not in FORMATS:
            raise s.Invalid('请选择 Flow 导出的项目或完整工作空间备份')
        projects, tasks = backup.get('projects'), backup.get('tasks')
        if not isinstance(projects, list) or not isinstance(tasks, list) or len(projects) > 1000 or len(tasks) > 20000:
            raise s.Invalid('备份结构无效或超出容量（1000 项目、20000 任务）')
        self.encode(backup)
        stamp = s.now()
        normalized = dict(format=backup['format'], projects=[], tasks=[], requirements=[], defects=[])
        ids = set()

        def ident(row, seen):
            if not isinstance(row, dict):
                raise s.Invalid('备份中的记录格式无效')
            value = s.text(row, 'id', 64, True)
            if not re.fullmatch(r'[a-zA-Z0-9_-]+', value) or value in seen:
                raise s.Invalid('备份包含无效或重复的 ID')
            seen.add(value)
            return value

        memory = sqlite3.connect(':memory:')
        try:
            memory.execute('CREATE TABLE projects(id TEXT PRIMARY KEY)')
            for row in projects:
                value = dict(id=ident(row, ids), **s.project_values(row),
                             created_at=s.timestamp(row.get('created_at'), stamp), updated_at=stamp)
                normalized['projects'].append(value)
                memory.execute('INSERT INTO projects VALUES(?)', (value['id'],))
            seen = set()
            for row in tasks:
                task_id = ident(row, seen)
                values = s.task_values(row, memory)
                completed = s.timestamp(row.get('completed_at'), stamp) if values['status'] == 'done' else None
                normalized['tasks'].append(dict(id=task_id, **values, created_at=s.timestamp(row.get('created_at'), stamp),
                                                updated_at=stamp, completed_at=completed))
            if backup['format'] in MANAGEMENT_FORMATS:
                for table, config in KINDS.items():
                    rows = backup.get(table)
                    if not isinstance(rows, list) or len(rows) > MAX_ITEMS:
                        raise s.Invalid(f'{config["label"]}备份必须为数组且最多 {MAX_ITEMS} 条')
                    seen = set()
                    for row in rows:
                        row_id = ident(row, seen)
                        values = s.MANAGEMENT.values(table, row, memory)
                        completed = s.timestamp(row.get('completed_at'), stamp) if values['status'] == config['finished'] else None
                        normalized[table].append(dict(id=row_id, **values, created_at=s.timestamp(row.get('created_at'), stamp),
                                                      updated_at=stamp, completed_at=completed))
            elif any(backup.get(table) for table in KINDS):
                raise s.Invalid('旧版格式不能包含需求或缺陷，请使用对应新版备份，避免漏恢复数据')
        finally:
            memory.close()
        if backup['format'] in WORKSPACE_FORMATS:
            account = backup.get('github')
            if not isinstance(account, dict) or not isinstance(account.get('links'), list) or len(account['links']) > 1000:
                raise s.Invalid('GitHub 关联数据无效或超过 1000 条')
            try:
                login = github_api.string(account.get('login', ''), 39)
                if login:
                    login = github_api.login_name(login)
                links, seen, branches = [], set(), set()
                for row in account['links']:
                    link_id = ident(row, seen)
                    repo = github_api.repo_name(row.get('repo'))
                    branch = github_api.string(row.get('branch'), 255, True)
                    key = (repo.casefold(), branch)
                    if key in branches:
                        raise s.Invalid('备份包含重复的仓库分支')
                    branches.add(key)
                    project = row.get('project_id')
                    if project is not None and (not isinstance(project, str) or project not in ids):
                        raise s.Invalid('GitHub 关联引用了备份中不存在的项目')
                    synced = s.timestamp(row['synced_at'], stamp) if row.get('synced_at') else None
                    commits = row.get('commits')
                    if not isinstance(commits, list) or len(commits) > 100:
                        raise s.Invalid('提交快照必须为数组且最多 100 条')
                    clean, shas = [], set()
                    for commit in commits:
                        if not isinstance(commit, dict):
                            raise s.Invalid('提交快照格式无效')
                        sha = s.text(commit, 'sha', 40, True)
                        if not re.fullmatch(r'[a-fA-F0-9]{40}', sha) or sha.lower() in shas:
                            raise s.Invalid('快照包含无效或重复的提交标识')
                        shas.add(sha.lower())
                        author_login = commit.get('author_login')
                        if author_login is not None:
                            author_login = s.text(commit, 'author_login', 200)
                        clean.append(dict(sha=sha, message=s.text(commit, 'message', MAX_BACKUP),
                                          author=s.text(commit, 'author', 1000), author_login=author_login,
                                          date=s.timestamp(commit['date'], stamp) if commit.get('date') else None))
                    links.append(dict(id=link_id, repo=repo, branch=branch, project_id=project,
                                      synced_at=synced, commits_json=json.dumps(clean, ensure_ascii=False)))
                normalized['github'] = dict(login=login, links=links)
            except github_api.GitHubError as error:
                raise s.Invalid(error.message) from error
            rows = backup.get('activities', [])
            if not isinstance(rows, list) or len(rows) > 500:
                raise s.Invalid('活动记录无效或超过 500 条')
            normalized['activities'] = []
            for row in rows:
                if not isinstance(row, dict):
                    raise s.Invalid('活动记录格式无效')
                normalized['activities'].append(dict(text=s.text(row, 'text', 2000), created_at=s.timestamp(row.get('created_at'), stamp)))
        return normalized

    def preview(self, db, backup):
        clean = self.validate(backup)
        ids = {p['id'] for p in clean['projects']}
        missing = []
        if clean['format'] not in WORKSPACE_FORMATS:
            missing = [dict(row) for row in db.execute('SELECT repo,branch,project_id FROM github_links WHERE project_id IS NOT NULL') if row['project_id'] not in ids]
        counts = self.service.MANAGEMENT.counts(db)
        return dict(format=clean['format'], projects=len(clean['projects']), tasks=len(clean['tasks']),
                    requirements=len(clean['requirements']), defects=len(clean['defects']),
                    current_requirements=counts['requirements'], current_defects=counts['defects'],
                    legacy_management=clean['format'] not in MANAGEMENT_FORMATS,
                    current_projects=db.execute('SELECT count(*) FROM projects').fetchone()[0],
                    current_tasks=db.execute('SELECT count(*) FROM tasks').fetchone()[0],
                    github_links=len(clean['github']['links']) if 'github' in clean else None,
                    detached_links=missing, revision=db.execute('SELECT revision FROM meta WHERE id=1').fetchone()[0])

    def safety_copy(self, db):
        s = self.service
        directory = s.DATABASE.parent / (s.DATABASE.stem + '.backups')
        name = 'before-restore-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8] + '.json'
        target = directory / name
        partial = directory / (name + '.partial')
        raw = self.encode(self.pack(db, 'workspace'))
        try:
            directory.mkdir(parents=True, exist_ok=True)
            with partial.open('xb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(partial, target)
        except OSError as error:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
            raise s.Invalid('安全备份写入失败，恢复已取消；请检查磁盘空间和目录权限', 503) from error
        self.remember(db, 'last_safety_path', str(target.resolve()))
        self.remember(db, 'last_safety_at', s.now())
        return str(target.resolve())

    def restore(self, db, backup):
        s = self.service
        clean = self.validate(backup)
        previous = [dict(row) for row in db.execute('SELECT id,project_id FROM github_links')]
        safety = self.safety_copy(db)
        db.execute('DELETE FROM tasks')
        for table in KINDS:
            db.execute(f'DELETE FROM {table}')
        db.execute('DELETE FROM projects')
        for row in clean['projects']:
            s.insert(db, 'projects', row)
        for row in clean['tasks']:
            s.insert(db, 'tasks', row)
        for table in KINDS:
            for row in clean[table]:
                s.insert(db, table, row)
        db.execute('DELETE FROM activities')
        if 'github' in clean:
            db.execute('DELETE FROM github_links')
            db.execute('INSERT INTO github_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login', (clean['github']['login'],))
            for row in clean['github']['links']:
                s.insert(db, 'github_links', row)
            for row in clean['activities']:
                s.insert(db, 'activities', row)
        else:
            ids = {p['id'] for p in clean['projects']}
            for row in previous:
                if row['project_id'] in ids:
                    db.execute('UPDATE github_links SET project_id=? WHERE id=?', (row['project_id'], row['id']))
        missing = sum(1 for row in previous if row['project_id'] and row['project_id'] not in {p['id'] for p in clean['projects']}) if 'github' not in clean else 0
        s.activity(db, f'恢复备份：{len(clean["projects"])} 个项目、{len(clean["tasks"])} 个任务、{len(clean["requirements"])} 个需求、{len(clean["defects"])} 个缺陷；自动安全备份已保存')
        return dict(safety_backup=safety, detached_links=missing)

    def status(self, db):
        s = self.service
        values = dict(db.execute('SELECT key,value FROM workspace_meta'))
        account = github_api.status(db)
        return dict(database_path=str(s.DATABASE.resolve()), backup_directory=str((s.DATABASE.parent / (s.DATABASE.stem + '.backups')).resolve()),
                    projects=db.execute('SELECT count(*) FROM projects').fetchone()[0], tasks=db.execute('SELECT count(*) FROM tasks').fetchone()[0],
                    **s.MANAGEMENT.counts(db),
                    last_export_at=values.get('last_export_at'), last_export_scope=values.get('last_export_scope'),
                    last_safety_at=values.get('last_safety_at'), last_safety_path=values.get('last_safety_path'),
                    github=dict(login=account['login'], token_configured=account['token_configured'], links=len(account['links']),
                                last_synced_at=max((x['synced_at'] for x in account['links'] if x['synced_at']), default=None),
                                cache_ttl_seconds=github_api.READ_CACHE.ttl))
