"""Compile Java source against minimal signatures, NOT an Android SDK compile.

These stubs execute nothing. They catch Java syntax/checked-exception errors;
API availability, Android SQLite behavior, and Capacitor runtime remain untested.
"""
import os
from pathlib import Path
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parents[2] / 'android/app/src/main/java/dev/fountain/workspace'
STUBS = {
'org/json/JSONException.java': 'package org.json; public class JSONException extends Exception {}',
'org/json/JSONObject.java': '''package org.json; import java.util.*; public class JSONObject {
 public static final Object NULL=new Object(); public JSONObject(){} public JSONObject(String s)throws JSONException{}
 public JSONObject put(String k,Object v)throws JSONException{return this;} public Object get(String k)throws JSONException{return null;}
 public Object opt(String k){return null;} public String getString(String k)throws JSONException{return null;}
 public String optString(String k){return "";} public String optString(String k,String d){return d;}
 public long getLong(String k)throws JSONException{return 0;} public double getDouble(String k)throws JSONException{return 0;}
 public long optLong(String k,long d){return d;} public boolean has(String k){return false;}
 public boolean isNull(String k){return true;} public JSONObject getJSONObject(String k)throws JSONException{return null;}
 public JSONObject optJSONObject(String k){return null;} public JSONArray getJSONArray(String k)throws JSONException{return null;}
 public Iterator<String> keys(){return Collections.emptyIterator();} public static String quote(String s){return s;}
}''',
'org/json/JSONArray.java': '''package org.json; public class JSONArray {
 public JSONArray(){} public JSONArray(String s)throws JSONException{} public int length(){return 0;}
 public JSONArray put(Object o){return this;} public Object get(int i)throws JSONException{return null;}
 public String getString(int i)throws JSONException{return null;} public JSONObject getJSONObject(int i)throws JSONException{return null;}
}''',
'android/database/Cursor.java': '''package android.database; public interface Cursor extends AutoCloseable {
 boolean moveToFirst(); boolean moveToNext(); String getString(int n); int getInt(int n); long getLong(int n); byte[] getBlob(int n); void close();
}''',
'android/database/sqlite/SQLiteDatabase.java': '''package android.database.sqlite; import android.database.Cursor; public class SQLiteDatabase {
 public static final int CREATE_IF_NECESSARY=1,NO_LOCALIZED_COLLATORS=2;
 public static SQLiteDatabase openDatabase(String p,Object f,int v){return null;}
 public void disableWriteAheadLogging(){} public boolean isWriteAheadLoggingEnabled(){return false;}
 public Cursor rawQuery(String q,String[] a){return null;} public void execSQL(String q){} public void execSQL(String q,Object[] a){}
 public void beginTransaction(){} public void setTransactionSuccessful(){} public void endTransaction(){} public void close(){}
}''',
'android/content/Context.java': '''package android.content; import java.io.File; public class Context {
 public File getNoBackupFilesDir(){return null;} public ContentResolver getContentResolver(){return null;}
}''',
'android/content/ContentResolver.java': '''package android.content; import android.net.Uri; import java.io.*; public class ContentResolver {
 public OutputStream openOutputStream(Uri u,String m)throws IOException{return null;} public int delete(Uri u,String s,String[] a){return 0;}
}''',
'android/app/Activity.java': 'package android.app; public class Activity extends android.content.Context { public static final int RESULT_OK=1; public void runOnUiThread(Runnable r){} }',
'android/content/Intent.java': '''package android.content; import android.net.Uri; public class Intent {
 public static final String ACTION_CREATE_DOCUMENT="",CATEGORY_OPENABLE="",EXTRA_TITLE="";
 public Intent(String s){} public void addCategory(String s){} public void setType(String s){} public void putExtra(String k,String v){} public Uri getData(){return null;}
}''',
'android/net/Uri.java': 'package android.net; public class Uri { public String getScheme(){return null;} public String getEncodedAuthority(){return null;} }',
'android/os/SystemClock.java': 'package android.os; public class SystemClock { public static long elapsedRealtime(){return 0;} }',
'android/util/Base64.java': 'package android.util; public class Base64 { public static final int NO_WRAP=2; public static byte[] decode(String s,int n){return null;} public static String encodeToString(byte[] b,int n){return null;} }',
'android/webkit/WebView.java': 'package android.webkit; public class WebView { public String getUrl(){return null;} }',
'androidx/activity/result/ActivityResult.java': 'package androidx.activity.result; public class ActivityResult { public int getResultCode(){return 0;} public android.content.Intent getData(){return null;} }',
'com/getcapacitor/JSObject.java': '''package com.getcapacitor; public class JSObject extends org.json.JSONObject {
 public JSObject put(String k,Object v){return this;} public String getString(String k){return null;}
}''',
'com/getcapacitor/PluginCall.java': '''package com.getcapacitor; public class PluginCall {
 public void reject(String m,String c){} public void resolve(JSObject o){} public String getString(String k){return null;}
 public String getString(String k,String d){return d;} public JSObject getObject(String k,JSObject d){return d;} public JSObject getData(){return null;}
}''',
'com/getcapacitor/Bridge.java': 'package com.getcapacitor; public class Bridge { public android.webkit.WebView getWebView(){return null;} public String getLocalUrl(){return null;} }',
'com/getcapacitor/Plugin.java': '''package com.getcapacitor; public class Plugin {
 public void load(){} public android.app.Activity getActivity(){return null;} public android.content.Context getContext(){return null;}
 public Bridge getBridge(){return null;} public void startActivityForResult(PluginCall c,android.content.Intent i,String s){}
 public Boolean shouldOverrideLoad(android.net.Uri u){return null;} protected void handleOnDestroy(){}
}''',
'com/getcapacitor/PluginMethod.java': 'package com.getcapacitor; public @interface PluginMethod {}',
'com/getcapacitor/annotation/ActivityCallback.java': 'package com.getcapacitor.annotation; public @interface ActivityCallback {}',
'com/getcapacitor/annotation/CapacitorPlugin.java': 'package com.getcapacitor.annotation; public @interface CapacitorPlugin { String name(); }',
'dev/fountain/workspace/MainActivity.java': 'package dev.fountain.workspace; public class MainActivity extends android.app.Activity { public boolean permitsNativeBridge(){return true;} }',
'dev/fountain/workspace/CookieVault.java': '''package dev.fountain.workspace; public class CookieVault {
 CookieVault(android.content.Context c){} org.json.JSONObject read()throws Exception{return null;} void write(org.json.JSONObject o)throws Exception{}
 boolean invalidated(String o){return false;} boolean markInvalidated(String o){return true;} void clearInvalidated(String o)throws Exception{}
 boolean eraseEncryptedState(){return true;} boolean destroyEncryptionKey(){return true;}
}''',
}
with tempfile.TemporaryDirectory(prefix='fountain-java-signatures-') as folder:
    root = Path(folder)
    for name, source in STUBS.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source)
    home = os.environ.get('FOUNTAIN_JAVA_HOME') or os.environ.get('JAVA_HOME')
    javac = str(Path(home) / 'bin/javac') if home else 'javac'
    result = subprocess.run([javac, '--release', '8', '-d', str(root / 'compiled'),
        *map(str, root.rglob('*.java')),
        *[str(SOURCE / name) for name in ('NativePolicy.java', 'NativeCookieBoundary.java', 'OutboxPolicy.java', 'NativeOutbox.java', 'FountainNativePlugin.java')]],
        capture_output=True, text=True)
    if result.returncode:
        print(result.stderr)
        raise SystemExit(result.returncode)
print('PASS Java syntax/checked-exception signatures only; not Android SDK/device verification')
