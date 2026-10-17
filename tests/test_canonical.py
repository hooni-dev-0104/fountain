"""Exact source digests retain decimal precision across database encodings."""
import unittest

from fountain.migrate import MigrationError, _canonical_json


VECTORS = [
    ('{"z":1.2300,"a":9007199254740993,"zero":-0.000}',
     b'{"a":9007199254740993e0,"z":123e-2,"zero":0}'),
    ('[true,false,null,1000,1e-20,-12.00,0.00012]',
     b'[true,false,null,1e3,1e-20,-12e0,12e-5]'),
    ('{"😀":"한글 / \\n \\t \\\" \\\\","a":[{},[]],"é":"é"}',
     '{"a":[{},[]],"é":"é","😀":"한글 / \\n \\t \\\" \\\\"}'.encode('utf-8')),
    ('{"b":1,"a":2,"b":3}', b'{"a":2e0,"b":3e0}'),
    ('[1e1000,-1e-1000]', b'[1e1000,-1e-1000]'),
]


class CanonicalSourceTests(unittest.TestCase):
    def test_existing_migration_bytes(self):
        for source, expected in VECTORS:
            with self.subTest(source=source):
                self.assertEqual(_canonical_json(source), expected)

    def test_equivalent_numeric_and_object_encodings_match(self):
        self.assertEqual(_canonical_json('{"v":1.200,"z":0}'),
                         _canonical_json('{"z":-0.0,"v":12e-1}'))
        self.assertNotEqual(_canonical_json('"é"'), _canonical_json('"é"'))

    def test_nonfinite_migration_error_is_preserved(self):
        for source in ['NaN', 'Infinity', '-Infinity', '{"v":NaN}']:
            with self.subTest(source=source), self.assertRaises(MigrationError):
                _canonical_json(source)


if __name__ == '__main__':
    unittest.main()
