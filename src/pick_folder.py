"""Native folder picker. Prints only the selected path as JSON."""
import json
import sys
import tkinter as tk
from tkinter import filedialog


def main():
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    try:
        value = filedialog.askdirectory(parent=root, title='选择 Flow 数据库存放文件夹', initialdir=sys.argv[1] if len(sys.argv) > 1 else None, mustexist=True)
        sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False).encode('utf-8'))
        sys.stdout.buffer.flush()
    finally:
        root.destroy()


if __name__ == '__main__':
    main()
