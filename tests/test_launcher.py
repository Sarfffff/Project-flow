import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import open_flow as app


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)
        self.lock = patch.object(app, 'LaunchLock')
        self.lock_mock = self.lock.start()
        self.addCleanup(self.lock.stop)
        self.lock_mock.return_value.__enter__.return_value.acquired = True

    def test_running_reuses_service_even_with_private_flag(self):
        with patch.object(app, 'service_state', return_value='flow'), patch.object(app, 'open_page', return_value=0) as browser, patch.object(app.subprocess, 'Popen') as start:
            self.assertEqual(app.launch(True), 0)
            start.assert_not_called()
            browser.assert_called_once()

    def test_unknown_service_never_starts_or_opens(self):
        with patch.object(app, 'service_state', return_value='occupied'), patch.object(app, 'open_page') as browser, patch.object(app.subprocess, 'Popen') as start:
            self.assertEqual(app.launch(), 1)
            start.assert_not_called()
            browser.assert_not_called()

    def test_duplicate_launch_does_not_spawn(self):
        self.lock_mock.return_value.__enter__.return_value.acquired = False
        with patch.object(app, 'service_state', return_value='free'), patch.object(app.subprocess, 'Popen') as start:
            self.assertEqual(app.launch(), 0)
            start.assert_not_called()

    def test_free_port_starts_absolute_script_then_opens(self):
        with patch.object(app, 'service_state', side_effect=['free', 'flow']), patch.object(app, 'open_page', return_value=0), patch.object(app.subprocess, 'Popen') as start:
            self.assertEqual(app.launch(), 0)
            command = start.call_args.args[0]
            self.assertEqual(command[0], sys.executable)
            self.assertTrue(Path(command[2]).is_absolute())
            self.assertEqual(command[-2:], ['--port', '58061'])
            self.assertEqual(start.call_args.kwargs['cwd'], str(app.ROOT.parent))

    def test_private_start_only_passes_prompt_flag(self):
        with patch.object(app, 'service_state', side_effect=['free', 'flow']), patch.object(app, 'open_page', return_value=0), patch.object(app.subprocess, 'Popen') as start:
            self.assertEqual(app.launch(True), 0)
            self.assertEqual(start.call_args.args[0][-1], '--github-login')

    def test_failed_start_does_not_open_browser(self):
        child = MagicMock()
        child.poll.return_value = 1
        with patch.object(app, 'service_state', return_value='free'), patch.object(app.subprocess, 'Popen', return_value=child), patch.object(app, 'open_page') as browser:
            self.assertEqual(app.launch(), 1)
            browser.assert_not_called()
            child.kill.assert_not_called()

    def test_health_checks_expected_app(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = b'{"ok":true,"app":"Flow"}'
        with patch.object(app, 'build_opener') as opener:
            opener.return_value.open.return_value = response
            self.assertEqual(app.service_state(), 'flow')

    def test_wrong_health_is_not_flow(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = b'{"ok":true,"app":"Other"}'
        with patch.object(app, 'build_opener') as opener, patch.object(app.socket, 'create_connection', return_value=MagicMock()):
            opener.return_value.open.return_value = response
            self.assertEqual(app.service_state(), 'occupied')

    def test_no_listener_is_free(self):
        with patch.object(app, 'build_opener', side_effect=OSError()), patch.object(app.socket, 'create_connection', side_effect=OSError()):
            self.assertEqual(app.service_state(), 'free')


if __name__ == '__main__':
    unittest.main(verbosity=2)
