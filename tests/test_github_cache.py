import sqlite3
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import github_api as gh
from github_cache import ResponseCache


class CacheTest(unittest.TestCase):
    def test_hit_returns_independent_copy(self):
        cache = ResponseCache()
        loader = Mock(return_value={'items': [{'name': 'source'}]})
        cache.get('key', loader)['items'][0]['name'] = 'modified'
        self.assertEqual(cache.get('key', loader)['items'][0]['name'], 'source')
        self.assertEqual(loader.call_count, 1)

    def test_expiry(self):
        cache = ResponseCache(ttl=30)
        loader = Mock(return_value=[])
        with patch('github_cache.time.monotonic', return_value=100):
            cache.get('key', loader)
        with patch('github_cache.time.monotonic', return_value=129):
            cache.get('key', loader)
        with patch('github_cache.time.monotonic', return_value=130):
            cache.get('key', loader)
        self.assertEqual(loader.call_count, 2)

    def test_refresh_bypasses_and_updates(self):
        cache = ResponseCache()
        loader = Mock(side_effect=['old', 'new'])
        self.assertEqual(cache.get('key', loader), 'old')
        self.assertEqual(cache.get('key', loader, refresh=True), 'new')
        self.assertEqual(cache.get('key', loader), 'new')
        self.assertEqual(loader.call_count, 2)

    def test_errors_not_cached_and_old_entry_removed_on_refresh_failure(self):
        cache = ResponseCache()
        loader = Mock(side_effect=['old', ValueError('offline'), 'recovered'])
        cache.get('key', loader)
        with self.assertRaises(ValueError):
            cache.get('key', loader, refresh=True)
        self.assertEqual(cache.get('key', loader), 'recovered')

    def test_lru_capacity(self):
        cache = ResponseCache(max_entries=2)
        loader = Mock(return_value='value')
        for key in ('a', 'b', 'a', 'c', 'a', 'b'):
            cache.get(key, loader)
        self.assertEqual(loader.call_count, 4)
        self.assertEqual(len(cache._entries), 2)

    def test_byte_budget_and_oversize(self):
        cache = ResponseCache(max_bytes=12)
        for key in ('a', 'b', 'c'):
            cache.get(key, lambda: '12345')
        self.assertLessEqual(cache._bytes, 12)
        loader = Mock(return_value='x' * 20)
        cache.get('large', loader)
        cache.get('large', loader)
        self.assertEqual(loader.call_count, 2)

    def test_singleflight_concurrent_calls(self):
        cache = ResponseCache()
        entered, release, follower = threading.Event(), threading.Event(), threading.Event()
        def load():
            entered.set()
            self.assertTrue(release.wait(3))
            return {'items': [1]}
        loader = Mock(side_effect=load)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(cache.get, 'key', loader)
            self.assertTrue(entered.wait(3))
            pending = next(iter(cache._pending.values()))
            original = pending.result
            def wait_result(*args, **kwargs):
                follower.set()
                return original(*args, **kwargs)
            with patch.object(pending, 'result', side_effect=wait_result):
                second = pool.submit(cache.get, 'key', loader)
                try:
                    self.assertTrue(follower.wait(3))
                finally:
                    release.set()
                self.assertEqual(first.result(3), second.result(3))
        self.assertEqual(loader.call_count, 1)

    def test_old_inflight_read_cannot_undo_refresh(self):
        cache = ResponseCache()
        entered, release = threading.Event(), threading.Event()
        def slow():
            entered.set()
            self.assertTrue(release.wait(3))
            return 'old'
        with ThreadPoolExecutor(max_workers=1) as pool:
            old = pool.submit(cache.get, 'key', slow)
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(cache.get('key', lambda: 'new', refresh=True), 'new')
            finally:
                release.set()
            self.assertEqual(old.result(3), 'old')
        self.assertEqual(cache.get('key', lambda: 'unexpected'), 'new')

    def test_clear_blocks_old_inflight_repopulation(self):
        cache = ResponseCache()
        def load():
            cache.clear()
            return 'old'
        cache.get('key', load)
        self.assertEqual(cache.get('key', lambda: 'new'), 'new')


class GitHubReadCacheTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE projects(id TEXT PRIMARY KEY)')
        gh.init_db(self.db)
        self.db.execute("INSERT INTO github_settings VALUES(1,'tester')")
        for target, value in [('READ_CACHE', ResponseCache()), ('credential', Mock(return_value='fake-secret'))]:
            replacement = patch.object(gh, target, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        remote = patch.object(gh, 'request', return_value=({'full_name': 'tester/repo'}, False))
        self.remote = remote.start()
        self.addCleanup(remote.stop)

    def test_repeated_reads_and_explicit_refresh(self):
        for query in ({'repo': 'tester/repo'}, {'repo': 'tester/repo'}, {'repo': 'tester/repo', 'refresh': '1'}, {'repo': 'tester/repo'}):
            gh.read(self.db, 'repo', query)
        self.assertEqual(self.remote.call_count, 2)
        self.remote.assert_called_with('/repos/tester/repo')

    def test_credentials_and_account_isolation(self):
        query = {'repo': 'tester/repo'}
        gh.read(self.db, 'repo', query)
        gh.credential.return_value = ''
        gh.read(self.db, 'repo', query)
        self.db.execute("UPDATE github_settings SET login='other'")
        gh.read(self.db, 'repo', query)
        self.assertEqual(self.remote.call_count, 3)
        self.assertNotIn('fake-secret', repr(gh.READ_CACHE._entries))

    def test_branch_page_author_path_are_separate(self):
        self.remote.return_value = ([], False)
        queries = [{'repo': 'a/b', 'branch': 'main'}, {'repo': 'a/b', 'branch': 'dev'},
                   {'repo': 'a/b', 'branch': 'main', 'page': '2'}, {'repo': 'a/b', 'branch': 'main', 'mine': '1'}]
        for query in queries * 2:
            gh.read(self.db, 'commits', query)
        for path in ('one.txt', 'two.txt', 'one.txt'):
            gh.read(self.db, 'contents', {'repo': 'a/b', 'path': path})
        self.assertEqual(self.remote.call_count, 6)

    def test_reconnect_clears_reads_and_bypasses_cache(self):
        gh.read(self.db, 'repo', {'repo': 'tester/repo'})
        self.remote.return_value = ({'login': 'tester', 'type': 'User'}, False)
        gh.write(self.db, 'connect', 'POST', {'login': 'tester'})
        self.remote.assert_called_with('/user')
        self.assertEqual(len(gh.READ_CACHE._entries), 0)

    def test_sync_always_fetches_and_invalidates_reads(self):
        gh.write(self.db, 'link', 'POST', {'repo': 'tester/repo', 'branch': 'main'})
        ident = gh.status(self.db)['links'][0]['id']
        self.remote.return_value = ([], False)
        gh.read(self.db, 'commits', {'repo': 'tester/repo', 'branch': 'main'})
        self.assertTrue(gh.READ_CACHE._entries)
        for _ in range(2):
            gh.write(self.db, 'sync', 'POST', {'id': ident})
            self.assertFalse(gh.READ_CACHE._entries)
        self.assertEqual(self.remote.call_count, 4)

    def test_invalid_queries_do_not_reach_network(self):
        for query in ({'repo': 'a/b', 'refresh': 'yes'}, {'repo': '../../x'}, {'repo': 'a/b', 'page': '0'}):
            with self.assertRaises(gh.GitHubError):
                gh.read(self.db, 'repo', query)
        self.remote.assert_not_called()

    def test_status_and_local_snapshot_never_cached(self):
        first = gh.read(self.db, 'status', {})
        self.db.execute("UPDATE github_settings SET login='other'")
        self.assertNotEqual(first['login'], gh.read(self.db, 'status', {})['login'])
        self.assertFalse(gh.READ_CACHE._entries)
        self.remote.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
