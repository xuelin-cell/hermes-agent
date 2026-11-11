"""Run with LibreOffice's companion Python; update one owned document, not a user's UI."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time


def refresh(args):
    import uno
    from com.sun.star.beans import PropertyValue
    from com.sun.star.connection import NoConnectException

    def prop(name, value):
        result = PropertyValue()
        result.Name, result.Value = name, value
        return result

    with tempfile.TemporaryDirectory(prefix='office-refresh-') as profile:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        command = [args.soffice, '--headless', '--nologo', '--nodefault', '--nofirststartwizard',
                   f'-env:UserInstallation={Path(profile).as_uri()}',
                   f'--accept=socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext']
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        desktop = document = None
        try:
            context = uno.getComponentContext()
            resolver = context.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', context)
            deadline = time.monotonic() + 30
            while True:
                try:
                    remote = resolver.resolve(f'uno:socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext')
                    break
                except NoConnectException:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('The owned LibreOffice instance did not become ready')
                    time.sleep(.1)
            desktop = remote.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', remote)
            document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(args.input.resolve())), '_blank', 0,
                (prop('Hidden', True), prop('UpdateDocMode', 0), prop('ReadOnly', False),
                 prop('MacroExecutionMode', uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE'))))
            if document is None:
                raise RuntimeError('LibreOffice could not load the Word document')
            if args.toc and document.getDocumentIndexes().Count == 0:
                anchor = document.Bookmarks.getByName('UniworkTOCStart').Anchor
                cursor = document.Text.createTextCursorByRange(anchor)
                index = document.createInstance('com.sun.star.text.ContentIndex')
                index.CreateFromOutline, index.Level, index.Title = True, 3, '目录'
                document.Text.insertTextContent(cursor, index, False)
            indexes = document.getDocumentIndexes()
            for index_number in range(indexes.Count):
                indexes.getByIndex(index_number).update()
            # Update again after the index itself has taken space in the page layout.
            for index_number in range(indexes.Count):
                indexes.getByIndex(index_number).update()
            document.storeAsURL(uno.systemPathToFileUrl(str(args.output.resolve())),
                                (prop('FilterName', 'Office Open XML Text'), prop('Overwrite', True)))
            document.storeToURL(uno.systemPathToFileUrl(str(args.pdf.resolve())),
                                (prop('FilterName', 'writer_pdf_Export'), prop('Overwrite', True)))
            view = document.CurrentController.ViewCursor
            view.gotoRange(document.Bookmarks.getByName('UniworkBodyStart').Anchor, False)
            body_page = view.Page
            return {'indexes': indexes.Count, 'body_page': body_page}
        finally:
            if document is not None:
                document.close(True)
            if desktop is not None:
                desktop.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('input', 'output', 'pdf'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--soffice', required=True)
    parser.add_argument('--toc', action='store_true')
    print(json.dumps(refresh(parser.parse_args()), ensure_ascii=False))
