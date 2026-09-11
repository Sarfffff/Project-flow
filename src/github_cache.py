"""Bounded process-local JSON cache; no credentials or content are persisted."""
from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future


class ResponseCache:
    def __init__(self, ttl=30, max_entries=128, max_bytes=16 * 1024 * 1024):
        self.ttl = ttl
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        self._entries = OrderedDict()
        self._pending = {}
        self._bytes = 0
        self._generation = 0

    def clear(self):
        """In-flight reads from an older generation cannot repopulate the cache."""
        with self._lock:
            self._generation += 1
            self._entries.clear()
            self._bytes = 0

    def _remove(self, key):
        self._bytes -= len(self._entries.pop(key)[1])

    def get(self, key, load, refresh=False):
        with self._lock:
            if refresh:
                self._generation += 1
                self._entries.clear()
                self._bytes = 0
            generation = self._generation
            pending_key = (generation, key)
            now = time.monotonic()
            for expired in [k for k, (until, _) in self._entries.items() if until <= now]:
                self._remove(expired)
            entry = self._entries.get(key)
            if entry:
                self._entries.move_to_end(key)
                return json.loads(entry[1])
            future = self._pending.get(pending_key)
            leader = future is None
            if leader:
                future = self._pending[pending_key] = Future()
        if not leader:
            return json.loads(future.result())
        try:
            payload = json.dumps(load(), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            with self._lock:
                if generation == self._generation and len(payload) <= self.max_bytes and self.max_entries > 0:
                    self._entries[key] = (time.monotonic() + self.ttl, payload)
                    self._bytes += len(payload)
                    while len(self._entries) > self.max_entries or self._bytes > self.max_bytes:
                        self._remove(next(iter(self._entries)))
            future.set_result(payload)
            return json.loads(payload)
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with self._lock:
                self._pending.pop(pending_key, None)
