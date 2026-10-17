DO $activity_canonical$ BEGIN
IF convert_to(fountain_private.activity_cjson($json0${"z":1.2300,"a":9007199254740993,"zero":-0.000}$json0$::jsonb),'UTF8') IS DISTINCT FROM decode('7b2261223a3930303731393932353437343039393365302c227a223a313233652d322c227a65726f223a307d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 0 differs';END IF;
IF convert_to(fountain_private.activity_cjson($json1$[true,false,null,1000,1e-20,-12.00,0.00012]$json1$::jsonb),'UTF8') IS DISTINCT FROM decode('5b747275652c66616c73652c6e756c6c2c3165332c31652d32302c2d313265302c3132652d355d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 1 differs';END IF;
IF convert_to(fountain_private.activity_cjson($json2${"😀":"한글 / \n \t \" \\","a":[{},[]],"é":"é"}$json2$::jsonb),'UTF8') IS DISTINCT FROM decode('7b2261223a5b7b7d2c5b5d5d2c22c3a9223a2265cc81222c22f09f9880223a22ed959ceab880202f205c6e205c74205c22205c5c227d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 2 differs';END IF;
IF convert_to(fountain_private.activity_cjson($json3${"b":1,"a":2,"b":3}$json3$::jsonb),'UTF8') IS DISTINCT FROM decode('7b2261223a3265302c2262223a3365307d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 3 differs';END IF;
IF convert_to(fountain_private.activity_cjson($json4$[1e1000,-1e-1000]$json4$::jsonb),'UTF8') IS DISTINCT FROM decode('5b3165313030302c2d31652d313030305d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 4 differs';END IF;
IF convert_to(fountain_private.activity_cjson($json5${"n":900719925474099312345678901234567890.00100}$json5$::jsonb),'UTF8') IS DISTINCT FROM decode('7b226e223a393030373139393235343734303939333132333435363738393031323334353637383930303031652d337d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 5 differs';END IF;
IF convert_to(fountain_private.activity_cjson($json6${"n":-0,"m":0.00000000000000000000000000000100}$json6$::jsonb),'UTF8') IS DISTINCT FROM decode('7b226d223a31652d33302c226e223a307d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 6 differs';END IF;
IF convert_to(fountain_private.activity_cjson($json7${"😀":1,"🀄":2,"é":3,"é":4}$json7$::jsonb),'UTF8') IS DISTINCT FROM decode('7b2265cc81223a3465302c22c3a9223a3365302c22f09f8084223a3265302c22f09f9880223a3165307d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 7 differs';END IF;
IF convert_to(fountain_private.activity_cjson($json8$[1.0,1.0000,10e-1,10000000000000000000000000000000000]$json8$::jsonb),'UTF8') IS DISTINCT FROM decode('5b3165302c3165302c3165302c316533345d','hex') THEN RAISE EXCEPTION 'Canonical exact source vector 8 differs';END IF;
END $activity_canonical$;
DO $activity_timestamps$
DECLARE value text;
BEGIN
 FOREACH value IN ARRAY ARRAY['2026-10-17T01:02:03Z','2026-10-17T01:02:03+00:00','2026-10-17T01:02:03.1Z','2026-10-17T01:02:03.123456+00:00','2024-02-29T00:00:00Z'] LOOP
  IF NOT fountain_private.activity_valid_stamp(value) THEN RAISE EXCEPTION 'Valid portable ISO UTC activity timestamp was rejected: %',value;END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY['2026-02-30T00:00:00Z','2026-02-29T00:00:00Z','2026-10-17T24:00:00Z','2026-10-17T01:60:00Z','2026-10-17T01:02:60Z','0000-01-01T00:00:00Z','2026-10-17T01:02:03+09:00','2026-10-17T01:02:03-00:00','2026-10-17T01:02:03','2026-10-17T01:02:03.1234567Z','2026-10-17 01:02:03Z','2026-11-01T01:30:00America/New_York'] LOOP
  IF fountain_private.activity_valid_stamp(value) THEN RAISE EXCEPTION 'Invalid activity timestamp was accepted: %',value;END IF;
 END LOOP;
END $activity_timestamps$;
