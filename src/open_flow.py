"""Open the local Flow app, reusing its running process without touching tokens."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener
import webbrowser

PORT = 58061
URL = f'http://127.0.0.1:{PORT}/project-flow/'
ROOT = Path(__file__).resolve().parent


def service_state():
    try:
        with build_opener(ProxyHandler({})).open(Request(f'http://127.0.0.1:{PORT}/api/health'), timeout=2) as response:
            data = json.loads(response.read(4096))
            if response.status == 200 and isinstance(data, dict) and data.get('app') == 'Flow' and data.get('ok') is True:
                return 'flow'
    except (OSError, URLError, ValueError):
        pass
    try:
        with socket.create_connection(('127.0.0.1', PORT), timeout=1):
            return 'occupied'
    except OSError:
        return 'free'


class LaunchLock:
    def __enter__(self):
        self.handle = None
        self.acquired = True
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
            self.kernel.CreateMutexW.restype = wintypes.HANDLE
            self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            self.kernel.WaitForSingleObject.restype = wintypes.DWORD
            self.kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
            self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            self.handle = self.kernel.CreateMutexW(None, False, f'Local\\Flow.QuickOpen.{PORT}')
            if not self.handle:
                raise OSError('Cannot create launcher lock.')
            result = self.kernel.WaitForSingleObject(self.handle, 0)
            self.acquired = result in (0, 0x80)
            if result == 0xFFFFFFFF:
                self.kernel.CloseHandle(self.handle)
                self.handle = None
                raise OSError('Cannot acquire launcher lock.')
        return self

    def __exit__(self, *_):
        if self.handle:
            if self.acquired:
                self.kernel.ReleaseMutex(self.handle)
            self.kernel.CloseHandle(self.handle)


def open_page():
    print(f'Opening {URL}', flush=True)
    try:
        if webbrowser.open(URL, new=2):
            return 0
    except webbrowser.Error:
        pass
    print('Could not open a browser. Copy the URL above into your browser.')
    return 1


def launch(private=False):
    with LaunchLock() as lock:
        state = service_state()
        if state == 'flow':
            print('Flow is already running. Reusing the existing session.')
            return open_page()
        if not lock.acquired:
            print('Another Flow launcher is active. Please complete its prompt and wait.')
            return 0
        if state == 'occupied':
            print(f'Port {PORT} is occupied by an unrecognized or unresponsive service.')
            print('No process was stopped. Check the existing service before trying again.')
            return 1
        script = ROOT / 'server.py'
        if not script.is_file():
            print('Flow server.py is missing. Keep this launcher inside the project folder.')
            return 1
        command = [sys.executable, '-B', str(script), '--port', str(PORT)]
        if private:
            command.append('--github-login')
            print('Enter your GitHub token only in the new server window; input is hidden.', flush=True)
        options = {'cwd': str(ROOT.parent)}
        if os.name == 'nt':
            options['creationflags'] = subprocess.CREATE_NEW_CONSOLE
        child = subprocess.Popen(command, **options)
        print('Starting Flow. Keep its server window running (you may minimize it).', flush=True)
        deadline = time.monotonic() + (300 if private else 30)
        while time.monotonic() < deadline:
            if service_state() == 'flow':
                return open_page()
            if child.poll() is not None:
                print('Flow did not start. Check the server window or run the entry again.')
                return 1
            time.sleep(0.4)
        print('Flow is still starting or waiting for input. No process was stopped.')
        print('After completing the server prompt, double-click the entry again.')
        return 1


def main():
    parser = argparse.ArgumentParser(description='Open Flow without launching a duplicate server')
    parser.add_argument('--github-login', action='store_true')
    parser.add_argument('--check', action='store_true', help='Only report the local service state; do not start or open anything')
    args = parser.parse_args()
    if args.check:
        state = service_state()
        print(state)
        return 0 if state == 'flow' else 1
    try:
        return launch(args.github_login)
    except (OSError, KeyboardInterrupt) as error:
        print(f'Flow launcher stopped: {error}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
