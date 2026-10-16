"""Opt-in real HTTP/SQLite large-file verification with bounded client memory."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fountain.attachments import CHUNK_SIZE, MAX_FILE_SIZE, FileStorage
from fountain.backup import create_backup, restore_backup
from fountain.core import Store
from fountain.server import create_server


def peak_memory():
    try:
        import resource
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return value if sys.platform == 'darwin' else value * 1024
    except ImportError:
        return None


def pattern(index, length):
    seed = hashlib.sha256(str(index).encode()).digest()
    return seed * (length // len(seed)) + seed[:length % len(seed)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--size', type=int, default=8 * 1024 * 1024 + 123)
    parser.add_argument('--backup', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if not 0 <= args.size <= MAX_FILE_SIZE:
        parser.error('size must be between 0 and 5,000,000,000 bytes')
    os.environ.pop('FOUNTAIN_ACCESS_TOKEN', None)
    started = time.monotonic()
    initial_peak = peak_memory()
    with tempfile.TemporaryDirectory(prefix='fountain-real-large-file-') as folder:
        database = Path(folder) / 'workspace.db'
        server = create_server(port=0, db_path=database)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(method, path, value=None, raw=False):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=300)
            body = value if raw else json.dumps(value).encode() if value is not None else None
            connection.request(method, path, body, {'Content-Type': 'application/octet-stream' if raw else 'application/json', 'X-Fountain-Request': '1'})
            response = connection.getresponse()
            content = response.read()
            status, headers = response.status, dict(response.getheaders())
            connection.close()
            if status >= 400: raise AssertionError((method, path, status, content[:1000]))
            return json.loads(content) if 'json' in headers.get('Content-Type', '') else content
        try:
            upload = request('POST', '/api/uploads', {'name': 'real-size-verification.bin', 'size': args.size})
            path = '/api/uploads/' + upload['id']
            expected, offset, index = hashlib.sha256(), 0, 0
            print(json.dumps({'phase': 'upload', 'bytes': args.size, 'chunk_bytes': CHUNK_SIZE}), flush=True)
            while offset < args.size:
                data = pattern(index, min(CHUNK_SIZE, args.size - offset))
                expected.update(data)
                result = request('PUT', path + '/chunks?offset=' + str(offset), data, True)
                offset += len(data)
                assert result['offset'] == offset
                index += 1
                if index % 128 == 0:
                    print(json.dumps({'phase': 'upload', 'written': offset, 'seconds': round(time.monotonic() - started, 2)}), flush=True)
            print(json.dumps({'phase': 'finalize', 'written': offset}), flush=True)
            attachment = request('POST', path + '/complete', {})
            assert attachment['size'] == args.size and attachment['sha256'] == expected.hexdigest()
            print(json.dumps({'phase': 'download', 'sha256': attachment['sha256']}), flush=True)
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=300)
            connection.request('GET', '/api/attachments/' + attachment['id'] + '/download')
            response = connection.getresponse()
            assert response.status == 200 and int(response.getheader('Content-Length')) == args.size
            downloaded, count = hashlib.sha256(), 0
            while data := response.read(64 * 1024):
                downloaded.update(data)
                count += len(data)
            connection.close()
            assert count == args.size and downloaded.hexdigest() == expected.hexdigest()
            report = {'size': args.size, 'sha256': expected.hexdigest(), 'http_upload': True, 'http_download': True,
                      'backup_restore': False, 'chunk_size': CHUNK_SIZE, 'client_read_size': 64 * 1024}
            if args.backup:
                with server.application.store.lock:
                    server.application.store.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                snapshot, restored = Path(folder) / 'backup.db', Path(folder) / 'restored.db'
                print(json.dumps({'phase': 'backup', 'seconds': round(time.monotonic() - started, 2)}), flush=True)
                create_backup(database, snapshot)
                print(json.dumps({'phase': 'restore', 'backup_bytes': snapshot.stat().st_size}), flush=True)
                restore_backup(snapshot, restored)
                store = Store(restored)
                try:
                    recovered = hashlib.sha256()
                    for data in FileStorage(store).iter_bytes(attachment['id']): recovered.update(data)
                    assert recovered.hexdigest() == expected.hexdigest()
                    assert not store.list('upload')
                finally:
                    store.close()
                report['backup_restore'] = True
                report['backup_bytes'] = snapshot.stat().st_size
            final_peak = peak_memory()
            report.update(seconds=round(time.monotonic() - started, 2), peak_rss_bytes=final_peak,
                          peak_rss_growth_bytes=final_peak - initial_peak if final_peak is not None else None)
            if report['peak_rss_growth_bytes'] is not None:
                assert report['peak_rss_growth_bytes'] < 384 * 1024 * 1024, report
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps({'phase': 'passed', **report}), flush=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            server.application.store.close()


if __name__ == '__main__': main()
