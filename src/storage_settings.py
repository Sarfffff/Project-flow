"""Local SQLite relocation: no overwrites, original database is retained."""
from __future__ import annotations

from contextlib import contextmanager, closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import uuid


class RequestGate:
    def __init__(self, invalid):
        self.condition = threading.Condition()
        self.readers = 0
        self.moving = False
        self.invalid = invalid

    @contextmanager
    def access(self, exclusive=False):
        with self.condition:
            if self.moving or (exclusive and self.readers):
                raise self.invalid('数据库正在使用或迁移，请待当前操作完成后重试', 409)
            if exclusive:
                self.moving = True
            else:
                self.readers += 1
        try:
            yield
        finally:
            with self.condition:
                if exclusive:
                    self.moving = False
                else:
                    self.readers -= 1


class StorageSettings:
    def __init__(self, service):
        self.service = service
        self.config = service.PROJECT_ROOT / 'data' / 'storage.json'
        self.picker_lock = threading.Lock()
        self.gate = RequestGate(service.Invalid)

    def load(self, default):
        if not self.config.exists():
            return default.resolve()
        try:
            raw = json.loads(self.config.read_text(encoding='utf-8'))
            path = self.validate_path(raw['database_path'])
            if not path.is_file():
                raise ValueError('missing database')
            return path
        except (OSError, ValueError, KeyError, TypeError, self.service.Invalid) as error:
            raise self.service.Invalid('已保存的数据库无法访问。请恢复该文件或使用 --db 指定正确位置；不会自动创建空库', 503) from error

    def validate_path(self, value):
        s = self.service
        if not isinstance(value, str) or not value.strip() or len(value) > 2000 or any(ord(c) < 32 for c in value):
            raise s.Invalid('请填写本机数据库文件的完整绝对路径')
        value = value.strip()
        path = Path(value)
        if not path.is_absolute() or value.startswith(('\\\\', '//')):
            raise s.Invalid('请选择本机磁盘的绝对路径，不支持网络共享目录')
        if path.suffix.lower() not in ('.sqlite3', '.sqlite', '.db'):
            raise s.Invalid('数据库文件名须以 .sqlite3、.sqlite 或 .db 结尾')
        if os.name == 'nt':
            import ctypes
            if ctypes.windll.kernel32.GetDriveTypeW(str(path.anchor)) == 4:
                raise s.Invalid('SQLite 不支持在此处使用网络磁盘，请选择本机磁盘')
            if any(any(c in part for c in ':*?"<>|') or part.endswith((' ', '.')) for part in path.parts[1:]):
                raise s.Invalid('数据库路径包含无效的 Windows 文件名字符')
        return path.resolve()

    def save(self, path):
        self.config.parent.mkdir(parents=True, exist_ok=True)
        partial = self.config.with_name('storage-' + uuid.uuid4().hex + '.partial')
        try:
            with partial.open('x', encoding='utf-8') as stream:
                json.dump({'database_path': str(path)}, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(partial, self.config)
        finally:
            partial.unlink(missing_ok=True)

    def migrate(self, payload):
        s = self.service
        original = s.DATABASE.resolve()
        if payload.get('expected_path') != str(original):
            raise s.Invalid('数据库位置已变化，请刷新设置后重新确认', 409)
        target = self.validate_path(payload.get('path'))
        if target == original:
            raise s.Invalid('所选位置就是当前数据库，无需迁移')
        if not target.parent.is_dir():
            raise s.Invalid('目标文件夹不存在，请先创建文件夹或重新选择')
        if any(p.exists() for p in (target, Path(str(target) + '-wal'), Path(str(target) + '-shm'), Path(str(target) + '-journal'))):
            raise s.Invalid('目标已有文件或 SQLite 附属文件，为保护数据不会覆盖；请使用新文件名', 409)
        created = False
        try:
            with target.open('xb'):
                created = True
            with closing(sqlite3.connect(original.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(target)) as destination:
                source.backup(destination)
                if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or destination.execute('PRAGMA foreign_key_check').fetchone():
                    raise s.Invalid('新数据库校验未通过，仍使用原位置', 503)
                destination.execute('UPDATE meta SET revision=revision+1 WHERE id=1')
                destination.commit()
                destination.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            self.save(target)
        except Exception as error:
            if created:
                for p in (target, Path(str(target) + '-wal'), Path(str(target) + '-shm')):
                    try:
                        p.unlink(missing_ok=True)
                    except OSError:
                        pass
            if isinstance(error, s.Invalid):
                raise
            raise s.Invalid('迁移未完成，仍使用原数据库。请检查目标磁盘空间和目录权限', 503) from error
        s.DATABASE = target
        s.github_api.READ_CACHE.clear()
        return dict(ok=True, database_path=str(target), original_path=str(original), message='迁移成功并立即生效；原数据库和原安全备份均已保留')

    def pick_folder(self):
        s = self.service
        if not self.picker_lock.acquire(blocking=False):
            raise s.Invalid('已有文件夹选择窗口，请在运行项目的电脑上完成选择', 409)
        try:
            command = [sys.executable, '-B', str(Path(__file__).with_name('pick_folder.py')), str(s.DATABASE.parent)]
            result = subprocess.run(command, capture_output=True, timeout=120)
            if result.returncode:
                raise s.Invalid('无法打开本机选择窗口，请直接输入完整路径', 503)
            value = json.loads(result.stdout.decode('utf-8'))
            return dict(path=str(Path(value) / 'flow.sqlite3') if value else '', cancelled=not bool(value))
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            raise s.Invalid('文件夹选择未完成，请重试或直接输入完整路径', 503) from error
        finally:
            self.picker_lock.release()
