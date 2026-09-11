"""Run GitHub regressions without binding the live application port."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
import test_github as original
import test_github_cache


class OfflineGitHubTest(original.GitHubTest):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='flow-offline-', dir=Path(__file__).parent)
        cls.addClassCleanup(cls.temp.cleanup)
        cls.original = original.server.DATABASE
        cls.addClassCleanup(setattr, original.server, 'DATABASE', cls.original)

    def call(self, *args, **kwargs):
        raise AssertionError('HTTP access is forbidden in offline regression tests')


if __name__ == '__main__':
    excluded = {'test_status_does_not_return_token', 'test_http_guards_and_local_routes'}
    loader = unittest.defaultTestLoader
    suite = unittest.TestSuite(OfflineGitHubTest(name) for name in loader.getTestCaseNames(OfflineGitHubTest) if name not in excluded)
    suite.addTests(loader.loadTestsFromTestCase(original.TransportTest))
    suite.addTests(loader.loadTestsFromModule(test_github_cache))
    print('Offline regressions only; two HTTP-dependent original cases are intentionally excluded.')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
