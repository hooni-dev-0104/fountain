"""Exact semantic JSON bytes shared by migration and activity digests.

The fountain-cjson-v1 format preserves finite decimal values and Unicode without
normalizing text or rounding through binary floating point.
"""
from decimal import Decimal
import json


def canonical_source(encoded):
    """Compare JSONB numerics without rounding through Python binary floats."""
    def invalid(_):
        raise ValueError("Source contains a nonfinite JSON number")
    value = json.loads(encoded, parse_int=Decimal, parse_float=Decimal, parse_constant=invalid)
    def encode(item):
        if item is None: return "null"
        if item is True: return "true"
        if item is False: return "false"
        if isinstance(item, Decimal):
            if item.is_zero(): return "0"
            sign, digits, exponent = item.as_tuple()
            digits = list(digits)
            while digits[-1] == 0:
                digits.pop()
                exponent += 1
            return ("-" if sign else "") + "".join(map(str, digits)) + "e" + str(exponent)
        if isinstance(item, str): return json.dumps(item, ensure_ascii=False)
        if isinstance(item, list): return "[" + ",".join(encode(child) for child in item) + "]"
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + encode(item[key]) for key in sorted(item)) + "}"
    return encode(value).encode("utf-8")

