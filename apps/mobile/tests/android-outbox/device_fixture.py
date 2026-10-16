"""Isolated HTTPS authority for RecoveryDeviceTest; never opens the main DB."""
import argparse
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
from fountain.server import create_server

parser = argparse.ArgumentParser()
parser.add_argument('--certificate', type=Path, required=True)
parser.add_argument('--key', type=Path, required=True)
parser.add_argument('--port', type=int, default=61595)
arguments = parser.parse_args()
os.environ['FOUNTAIN_ACCESS_TOKEN'] = ''
with tempfile.TemporaryDirectory(prefix='fountain-android-device-authority-') as folder:
    database = Path(folder).resolve() / 'fixture.sqlite'
    server = create_server(port=arguments.port, db_path=database, allowed_hosts=['10.0.2.2'],
                           tls_cert=arguments.certificate.resolve(), tls_key=arguments.key.resolve())
    # Publicly known fixture token, unrelated to any user credential.
    os.environ['FOUNTAIN_ACCESS_TOKEN'] = 'isolated-android-qa-token'
    family = create_server(port=arguments.port + 1, db_path=Path(folder).resolve() / 'family.sqlite',
                           allowed_hosts=['10.0.2.2'], tls_cert=arguments.certificate.resolve(),
                           tls_key=arguments.key.resolve())
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .05}, daemon=True)
    family_thread = threading.Thread(target=family.serve_forever, kwargs={'poll_interval': .05}, daemon=True)
    done = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: done.set())
    signal.signal(signal.SIGINT, lambda *_: done.set())
    thread.start()
    family_thread.start()
    print('Isolated Android QA HTTPS authority ready on port', server.server_port, flush=True)
    try:
        done.wait()
    finally:
        server.shutdown()
        family.shutdown()
        server.server_close()
        family.server_close()
        thread.join()
        family_thread.join()
        server.application.store.close()
        family.application.store.close()
