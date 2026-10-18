#!/usr/bin/env python3
"""Exercise production SQLite DDL constraints; not Java authority or device proof."""
from pathlib import Path
import re
import sqlite3
import unittest
SOURCE=Path(__file__).resolve().parents[2]/'android/app/src/main/java/dev/fountain/workspace/NativeOutbox.java'
SQL=re.findall(r'"([^"\n]+)"',re.search(r'SCHEMA = \{(.*?)\n    \};',SOURCE.read_text(),re.S)[1])
class RegistrySchema(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:')
  for sql in SQL:self.db.execute(sql)
 def tearDown(self):self.db.close()
 def put(self,p,i,a,k,r):self.db.execute('insert into native_profile_mirrors_v1(profile_id,incarnation,actor,kind,ref)values(?,?,?,?,?)',(p,i,a,k,r))
 def test_idempotent_ddl_preserves_old_location(self):
  self.put('P','private1','nativeactor','base','base')
  for sql in SQL:self.db.execute(sql)
  self.assertEqual(self.db.execute('select ref from native_profile_mirrors_v1').fetchall(),[('base',)])
 def test_base_and_pair_refs_unique_compound_incarnation(self):
  self.put('P','private1','nativeactor','base','base')
  self.put('P','private2','nativeactor','profile','v1-'+'a'*64)
  with self.assertRaises(sqlite3.IntegrityError):self.put('B','private3','another','base','base')
  with self.assertRaises(sqlite3.IntegrityError):self.put('P','private2','nativeactor','profile','v1-'+'b'*64)
 def test_sameactor_seek_is_indexed(self):
  self.put('P','private1','nativeactor','profile','v1-'+'a'*64)
  plan=self.db.execute("explain query plan select sequence,ref from native_profile_mirrors_v1 where actor=? and kind='profile' and ref<>? and sequence>? order by sequence limit ?",('nativeactor','base',0,20)).fetchall()
  self.assertTrue(any('native_profile_mirrors_actor_v1' in row[-1] for row in plan))
 def test_partial_metadata_transaction_cannot_claim_base(self):
  self.db.commit();self.db.execute("create temp trigger abort_revision before update on native_mirror_state_v1 begin select raise(abort,'fixture');end")
  with self.assertRaises(sqlite3.IntegrityError):
   with self.db:
    self.put('P','private1','nativeactor','base','base')
    self.db.execute('update native_mirror_state_v1 set revision=revision+1 where singleton=1')
  self.assertEqual(self.db.execute('select count(*) from native_profile_mirrors_v1').fetchone()[0],0)
if __name__=='__main__':unittest.main()
