"""Private PostgreSQL configuration must fail safely before opening a database."""
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fountain.core import APIError
from fountain.server import create_server, main


class DatabaseConfigurationTests(unittest.TestCase):
    def test_invalid_backend_context_does_not_create_sqlite_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'untouched' / 'workspace.db'
            for options in ({'database_url': ''}, {'workspace_id': 'unexpected'}):
                with self.subTest(options=options), self.assertRaises(APIError):
                    create_server(db_path=path, **options)
            self.assertFalse(path.parent.exists())

    def reject_cli(self, arguments, expected):
        output = io.StringIO()
        with patch('sys.argv', ['fountain.server', *arguments]), contextlib.redirect_stderr(output):
            with self.assertRaises(SystemExit) as caught:
                main()
        self.assertEqual(caught.exception.code, 2)
        self.assertIn(expected, output.getvalue())
        return output.getvalue()

    def test_postgres_selection_requires_namespace_and_separate_configuration(self):
        self.reject_cli(['--database', 'postgres'], '--workspace-id is required')
        self.reject_cli(['--workspace-id', 'family'], 'require --database postgres')
        self.reject_cli(['--database', 'postgres', '--workspace-id', 'family', '--data', 'other.db'],
                        '--data is for SQLite mode')
        with patch.dict(os.environ, {'FOUNTAIN_DATABASE_URL': ''}):
            self.reject_cli(['--database', 'postgres', '--workspace-id', 'family'],
                            'Set FOUNTAIN_DATABASE_URL')

    def test_private_file_rejects_permissions_invalid_json_and_missing_dsn_without_echo(self):
        secret = 'do-not-print-test-database-password'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'connection.json'
            arguments = ['--database', 'postgres', '--workspace-id', 'family', '--database-config', str(path)]
            for content, mode in ((json.dumps({'database_dsn': secret}), 0o644),
                                  (secret, 0o600), ('[]', 0o600), ('{}', 0o600),
                                  (secret * 3000, 0o600)):
                path.write_text(content)
                path.chmod(mode)
                output = self.reject_cli(arguments, 'configuration' if content != '{}' else 'Set FOUNTAIN_DATABASE_URL')
                self.assertNotIn(secret, output)

    def test_explicit_postgres_file_passes_only_to_backend_and_closes_it(self):
        secret = 'private-test-dsn'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'connection.json'
            path.write_text(json.dumps({'database_dsn': secret, 'unused': 'not forwarded'}))
            path.chmod(0o600)
            arguments = ['fountain.server', '--database', 'postgres', '--workspace-id', 'family',
                         '--database-config', str(path)]
            with (patch('sys.argv', arguments), patch('fountain.server.create_server') as factory,
                  contextlib.redirect_stdout(io.StringIO())):
                server = factory.return_value
                server.serve_forever.side_effect = KeyboardInterrupt
                main()
            self.assertEqual(factory.call_args.kwargs['database_url'], secret)
            self.assertEqual(factory.call_args.kwargs['workspace_id'], 'family')
            server.server_close.assert_called_once()
            server.application.store.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
