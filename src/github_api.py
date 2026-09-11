"""Read-only GitHub integration. Credentials stay in backend process memory."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from github_cache import ResponseCache

API = 'https://api.github.com'
MAX_RESPONSE = 6 * 1024 * 1024
MAX_FILE = 512 * 1024
TOKEN = ''
USE_ENV_TOKEN = True
SYNC_LOCK = threading.Lock()
READ_CACHE = ResponseCache()


class GitHubError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def credential():
    return TOKEN or (os.environ.get('FLOW_GITHUB_TOKEN', '').strip() if USE_ENV_TOKEN else '')


def request(path, params=None, allow_empty=False, *, token_override=None):
    if not path.startswith('/') or path.startswith('//') or '?' in path or '#' in path:
        raise GitHubError('无效的 GitHub API 路径')
    url = API + path + ('?' + urlencode(params) if params else '')
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'Flow-Project-Manager',
               'X-GitHub-Api-Version': '2022-11-28'}
    token = credential() if token_override is None else token_override
    if token:
        headers['Authorization'] = 'Bearer ' + token
    try:
        with build_opener(NoRedirect()).open(Request(url, headers=headers, method='GET'), timeout=15) as response:
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise GitHubError('GitHub 返回内容过大，请缩小查询范围', 413)
            value = json.loads(raw)
            return value, 'rel="next"' in response.headers.get('Link', '')
    except HTTPError as error:
        code, remaining = error.code, error.headers.get('X-RateLimit-Remaining')
        error.close()
        if code == 409 and allow_empty:
            return [], False
        if code == 401:
            raise GitHubError('GitHub 令牌无效或已过期，请在工作空间设置中重新配置只读令牌', 401)
        if code == 429 or (code == 403 and remaining == '0'):
            raise GitHubError('GitHub 请求额度已用完，请稍后重试；未授权访问额度较低', 429)
        if code == 403:
            raise GitHubError('GitHub 拒绝访问，请检查 Contents 只读权限、仓库授权、组织 SSO，或稍后重试', 403)
        if code == 404:
            raise GitHubError('仓库、分支或文件不存在，或当前令牌无权读取私有仓库', 404)
        if code in (301, 302, 307, 308):
            raise GitHubError('仓库地址已迁移，请使用新的仓库名称重新关联', 409)
        if code == 422:
            raise GitHubError('GitHub 查询参数无效，请检查分支和路径', 400)
        raise GitHubError('GitHub 暂时不可用，请稍后重试', 502)
    except (URLError, TimeoutError, OSError):
        raise GitHubError('无法连接 GitHub，请检查网络后重试', 502)
    except (ValueError, UnicodeError):
        raise GitHubError('GitHub 返回内容无法解析', 502)


def string(value, maximum=200, required=False):
    if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise GitHubError('文本参数无效或超出长度限制')
    value = value.strip()
    if required and not value:
        raise GitHubError('请填写必要信息')
    return value


def login_name(value):
    value = string(value, 39, True)
    if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?', value):
        raise GitHubError('请输入有效的 GitHub 用户名')
    return value


def repo_name(value):
    value = string(value, 180, True)
    parts = value.split('/')
    if len(parts) != 2 or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', parts[1]) or parts[1] in ('.', '..'):
        raise GitHubError('仓库格式应为 owner/repository，不是完整网址')
    login_name(parts[0])
    return value


def file_path(value):
    value = string(value, 1024)
    if value and (value.startswith('/') or '\\' in value or any(p in ('', '.', '..') for p in value.split('/'))):
        raise GitHubError('无效的仓库内路径')
    return value


def page_number(value):
    if not re.fullmatch(r'[1-9][0-9]{0,4}', str(value)):
        raise GitHubError('分页参数无效')
    return int(value)


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def init_db(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS github_settings (id INTEGER PRIMARY KEY CHECK(id=1), login TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_links (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        synced_at TEXT, commits_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(repo, branch)
    );
    ''')


def status(db):
    row = db.execute('SELECT login FROM github_settings WHERE id=1').fetchone()
    links = [dict(r) for r in db.execute('SELECT id,repo,branch,project_id,synced_at FROM github_links ORDER BY repo,branch')]
    return dict(login=row['login'] if row else '', token_configured=bool(credential()), links=links)


def repo_summary(row):
    return {key: row.get(key) for key in ('full_name', 'description', 'private', 'default_branch', 'language', 'pushed_at', 'stargazers_count', 'archived')}


def commit_summary(row):
    commit = row.get('commit') or {}
    author = commit.get('author') or {}
    return dict(sha=row.get('sha', ''), message=commit.get('message', ''),
                author=(row.get('author') or {}).get('login') or author.get('name', '未知作者'),
                author_login=(row.get('author') or {}).get('login'), date=author.get('date'))


def base_path(repo):
    return '/repos/' + quote(repo_name(repo), safe='/')


def read(db, endpoint, query):
    if endpoint not in ('repos', 'repo', 'branches', 'commits', 'commit', 'contents'):
        return read_uncached(db, endpoint, query)
    refresh = query.get('refresh', '0')
    if refresh not in ('0', '1'):
        raise GitHubError('刷新参数无效')
    clean_query = {k: v for k, v in query.items() if k != 'refresh'}
    account = status(db)['login']
    scope = hashlib.sha256(credential().encode('utf-8')).digest()
    key = (scope, account.casefold(), endpoint, tuple(sorted(clean_query.items())))
    return READ_CACHE.get(key, lambda: read_uncached(db, endpoint, clean_query), refresh=refresh == '1')


def read_uncached(db, endpoint, query):
    if endpoint == 'status':
        return status(db)
    if endpoint == 'cached':
        ident = string(query.get('id', ''), 64, True)
        row = db.execute('SELECT * FROM github_links WHERE id=?', (ident,)).fetchone()
        if not row:
            raise GitHubError('关联记录不存在', 404)
        return dict(items=json.loads(row['commits_json']), synced_at=row['synced_at'], cached=True)
    if endpoint == 'repos':
        configured = status(db)['login']
        if not configured:
            raise GitHubError('请先连接 GitHub 账号')
        params = dict(per_page=30, page=page_number(query.get('page', '1')), sort='updated', direction='desc')
        if credential():
            path = '/user/repos'
            params['affiliation'] = 'owner'
        else:
            path = '/users/' + login_name(configured) + '/repos'
            params['type'] = 'owner'
        rows, more = request(path, params)
        return dict(items=[repo_summary(r) for r in rows], has_next=more)
    repo = repo_name(query.get('repo', ''))
    base = base_path(repo)
    branch = string(query.get('branch', ''), 255)
    page = page_number(query.get('page', '1'))
    if endpoint == 'repo':
        row, _ = request(base)
        return repo_summary(row)
    if endpoint == 'branches':
        rows, more = request(base + '/branches', dict(per_page=100, page=page), allow_empty=True)
        return dict(items=[dict(name=r['name']) for r in rows], has_next=more)
    if endpoint == 'commits':
        params = dict(per_page=30, page=page)
        if branch:
            params['sha'] = branch
        if query.get('mine') == '1':
            configured = status(db)['login']
            if not configured:
                raise GitHubError('请先连接 GitHub 账号')
            params['author'] = configured
        rows, more = request(base + '/commits', params, allow_empty=True)
        return dict(items=[commit_summary(r) for r in rows], has_next=more)
    if endpoint == 'commit':
        sha = string(query.get('sha', ''), 40, True)
        if not re.fullmatch(r'[a-fA-F0-9]{7,40}', sha):
            raise GitHubError('提交标识无效')
        row, more = request(base + '/commits/' + sha, dict(per_page=30, page=page))
        files = [dict(filename=f['filename'], status=f['status'], additions=f.get('additions', 0),
                      deletions=f.get('deletions', 0), patch=(f.get('patch') or '')[:100000],
                      patch_truncated=len(f.get('patch') or '') > 100000) for f in row.get('files', [])]
        return dict(**commit_summary(row), stats=row.get('stats', {}), files=files, has_next=more)
    if endpoint == 'contents':
        path = file_path(query.get('path', ''))
        row, _ = request(base + '/contents/' + quote(path, safe='/'), {'ref': branch} if branch else None)
        if isinstance(row, list):
            items = [dict(name=r['name'], path=r['path'], type='submodule' if r.get('submodule_git_url') else r['type'], size=r.get('size', 0)) for r in row]
            return dict(type='dir', path=path, items=items, limited=len(items) >= 1000)
        kind = 'submodule' if row.get('submodule_git_url') else row.get('type')
        result = dict(type=kind, path=path, size=row.get('size', 0), text='', notice='')
        if kind != 'file':
            result['notice'] = '符号链接或子模块不在本地自动展开，请在 GitHub 查看'
        elif row.get('size', 0) > MAX_FILE or row.get('encoding') != 'base64':
            result['notice'] = '文件超过 512 KB 或 GitHub 不提供内联内容，请在 GitHub 查看'
        else:
            try:
                content = base64.b64decode(row.get('content', ''), validate=False)
                if len(content) > MAX_FILE or b'\x00' in content:
                    raise ValueError()
                result['text'] = content.decode('utf-8-sig')
            except (ValueError, UnicodeError):
                result['notice'] = '二进制文件或非 UTF-8 文本暂不支持预览，请在 GitHub 查看'
        return result
    raise GitHubError('GitHub 接口不存在', 404)


def configure_session(db, payload):
    global TOKEN, USE_ENV_TOKEN
    mode = payload.get('mode')
    if mode not in ('public', 'token', 'disconnect'):
        raise GitHubError('请选择公开账号或只读令牌连接方式')
    token = ''
    if mode == 'disconnect':
        login = ''
    else:
        supplied = string(payload.get('login', ''), 39)
        if mode == 'token':
            token = payload.get('token', '')
            if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_]{20,255}', token):
                raise GitHubError('令牌格式无效，请输入有效的 GitHub 只读令牌')
            profile, _ = request('/user', token_override=token)
            login = login_name(profile.get('login', ''))
            if supplied and supplied.casefold() != login.casefold():
                raise GitHubError('用户名与令牌账号不一致；可留空自动识别账号')
        else:
            login = login_name(supplied)
            profile, _ = request('/users/' + login, token_override='')
            login = login_name(profile.get('login', ''))
        if profile.get('type') != 'User':
            raise GitHubError('请连接个人 GitHub 账号')
    db.execute('INSERT INTO github_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login', (login,))
    db.commit()
    TOKEN, USE_ENV_TOKEN = token, False
    READ_CACHE.clear()
    return status(db)


def write(db, endpoint, method, payload):
    import uuid
    if endpoint == 'session' and method == 'POST':
        return configure_session(db, payload)
    if endpoint == 'connect' and method == 'POST':
        supplied = string(payload.get('login', ''), 39)
        if credential():
            profile, _ = request('/user')
            login = login_name(profile['login'])
            if supplied and supplied.casefold() != login.casefold():
                raise GitHubError('输入账号与令牌所属账号不一致，请留空使用令牌账号或修改用户名')
        else:
            login = login_name(supplied)
            profile, _ = request('/users/' + login)
            if profile.get('type') != 'User':
                raise GitHubError('请输入个人账号，组织仓库可以通过仓库名称单独添加')
            login = profile['login']
        db.execute('INSERT INTO github_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login', (login,))
        db.commit()
        READ_CACHE.clear()
        return status(db)
    if endpoint == 'link' and method == 'POST':
        repo = repo_name(payload.get('repo', ''))
        branch = string(payload.get('branch', ''), 255, True)
        project = payload.get('project_id') or None
        if project is not None and (not isinstance(project, str) or not db.execute('SELECT 1 FROM projects WHERE id=?', (project,)).fetchone()):
            raise GitHubError('关联项目不存在，请刷新项目数据', 409)
        request(base_path(repo) + '/branches/' + quote(branch, safe=''))
        db.execute('INSERT INTO github_links(id,repo,branch,project_id) VALUES(?,?,?,?) ON CONFLICT(repo,branch) DO UPDATE SET project_id=excluded.project_id',
                   (uuid.uuid4().hex, repo, branch, project))
        db.commit()
        return status(db)
    if endpoint == 'link' and method == 'DELETE':
        ident = string(payload.get('id', ''), 64, True)
        db.execute('DELETE FROM github_links WHERE id=?', (ident,))
        db.commit()
        return status(db)
    if endpoint == 'sync' and method == 'POST':
        ident = string(payload.get('id', ''), 64, True)
        if not SYNC_LOCK.acquire(blocking=False):
            raise GitHubError('另一个仓库正在同步，请稍后重试', 409)
        try:
            row = db.execute('SELECT * FROM github_links WHERE id=?', (ident,)).fetchone()
            if not row:
                raise GitHubError('关联记录不存在', 404)
            rows, more = request(base_path(row['repo']) + '/commits', dict(sha=row['branch'], per_page=100), allow_empty=True)
            items = [commit_summary(r) for r in rows]
            old_items = json.loads(row['commits_json'])
            old = {r['sha'] for r in old_items}
            first = row['synced_at'] is None
            new = [] if first else [r['sha'] for r in items if r['sha'] not in old]
            gap = not first and more and not any(r['sha'] in old for r in items)
            synced_at = stamp()
            changed = db.execute('UPDATE github_links SET commits_json=?,synced_at=? WHERE id=?',
                                 (json.dumps(items, ensure_ascii=False), synced_at, ident)).rowcount
            if not changed:
                raise GitHubError('关联已在其他页面移除', 409)
            db.commit()
            return dict(items=items, new_shas=new, first_sync=first, synced_at=synced_at,
                        history_limited=more, gap=gap, cached=False)
        finally:
            READ_CACHE.clear()
            SYNC_LOCK.release()
    raise GitHubError('不支持的 GitHub 操作', 405)
