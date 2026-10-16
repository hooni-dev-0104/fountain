"""Native sqlite3 integrity/restore/mutation oracle for generated temporary files."""
import hashlib
import json
import pathlib
import sqlite3
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from fountain.backup import inspect_backup, restore_backup, SCHEMA, DEFINITIONS

path=pathlib.Path(sys.argv[1]);expected=json.loads(sys.argv[2])
assert path.parent.name.startswith('fountain-sqlite-writer-'), 'Only a disposable test directory is permitted'
connection=sqlite3.connect(path)
assert connection.execute('pragma integrity_check').fetchall()==[('ok',)]
assert connection.execute('pragma page_size').fetchone()[0]==expected['pageSize']
for table,shape in SCHEMA.items():
    actual=[(row[1],row[2],row[3],row[5]) for row in connection.execute('pragma table_info('+table+')')]
    assert actual==shape,(table,actual,shape)
    assert connection.execute('select sql from sqlite_schema where name=?',(table,)).fetchone()[0]==DEFINITIONS[table]
    assert connection.execute('select count(*) from '+table).fetchone()[0]==expected['counts'][table]
objects=connection.execute('select type,name,tbl_name,sql from sqlite_schema').fetchall()
assert len(objects)==6 and {name for type,name,_,_ in objects if type=='index'}=={'sqlite_autoindex_'+table+'_1' for table in SCHEMA}
assert connection.execute("select count(*) from entities where kind in ('session','clipboard','upload','presence')").fetchone()[0]==0
assert connection.execute("select count(*) from meta where key in ('local_cache_binding','attachment_file_root','attachment_file_gc_cursor')").fetchone()[0]==0
for identity,size,digest in expected.get('attachments',[]):
    hasher=hashlib.sha256();total=0
    for rowid,length in connection.execute('select rowid,length(data) from attachment_chunks where attachment_id=? order by offset',(identity,)):
        with connection.blobopen('attachment_chunks','data',rowid,readonly=True) as blob:
            while chunk:=blob.read(65536):hasher.update(chunk);total+=len(chunk)
    assert total==size and hasher.hexdigest()==digest
counts=inspect_backup(path)
assert counts==expected['entityKinds'],(counts,expected['entityKinds'])
# Exercise SQLite's native unique-index search and write paths, not just scans.
if expected['counts']['entities']:
    kind,identity,data,created,updated=connection.execute('select * from entities order by kind,id limit 1').fetchone()
    connection.execute('insert into entities values(?,?,?,?,?) on conflict(kind,id) do update set data=excluded.data',(kind,identity,data,created,updated))
    assert connection.execute('select count(*) from entities where kind=? and id=?',(kind,identity)).fetchone()[0]==1
    for identity in ['row000000','row000001','row000127','row000128','row016383','row016384','row099999']:
        row=connection.execute("select data,created_at,updated_at from entities where kind='page' and id=?",(identity,)).fetchone()
        if row:
            assert json.loads(row[0])['id']==identity
            connection.execute("insert into entities values('page',?,?,?,?) on conflict(kind,id) do update set data=excluded.data",(identity,*row))
connection.execute("insert into meta values ('oracle','1') on conflict(key) do update set data=excluded.data")
connection.execute("insert into meta values ('oracle','2') on conflict(key) do update set data=excluded.data")
assert connection.execute("select data from meta where key='oracle'").fetchone()[0]=='2'
connection.execute("delete from meta where key='oracle'")
if expected['counts']['attachment_chunks']:
    row=connection.execute('select attachment_id,offset,data from attachment_chunks order by attachment_id,offset limit 1').fetchone()
    connection.execute('insert into attachment_chunks values(?,?,?) on conflict(attachment_id,offset) do update set data=excluded.data',row)
connection.commit()
assert connection.execute('pragma integrity_check').fetchall()==[('ok',)]
connection.close()
restored=path.with_name(path.name+'.restored.db')
assert restore_backup(path,restored)==expected['entityKinds']
assert inspect_backup(restored)==expected['entityKinds']
print(json.dumps({'ok':True,'integrity':True,'exactSchema':True,'autoindices':3,'nativeOnConflict':True,'restored':True,'counts':expected['counts']}))
