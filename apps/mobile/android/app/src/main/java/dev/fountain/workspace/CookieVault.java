package dev.fountain.workspace;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Xml;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.system.ErrnoException;
import java.io.File;
import java.io.FileDescriptor;
import java.io.ByteArrayOutputStream;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.UUID;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** One app-private, authenticated-encrypted record; failures never fall back to plaintext. */
final class CookieVault {
    private static final String ALIAS = "dev.fountain.workspace.native.v1";
    private final SharedPreferences preferences;
    private final byte[] associatedData;
    private final String keyAlias;
    private final KeyFault keyFault;
    private final File dataDirectory,preferencesFile;
    private boolean writesDisabled;
    private String lastPublicOrigin;
    interface KeyFault {
        void beforeKey(boolean create) throws Exception; void beforeDelete() throws Exception;
        default File backingFile(){return null;}
    }

    CookieVault(Context context) {
        this(context,context.getSharedPreferences("fountain_native_v1", Context.MODE_PRIVATE),ALIAS,null,new File(context.getDataDir(),"shared_prefs/fountain_native_v1.xml"));
    }
    CookieVault(Context context,SharedPreferences preferences,String keyAlias,KeyFault keyFault) {
        this(context,preferences,keyAlias,keyFault,keyFault==null?null:keyFault.backingFile());
    }
    private CookieVault(Context context,SharedPreferences preferences,String keyAlias,KeyFault keyFault,File preferencesFile) {
        this.preferences=preferences;this.keyAlias=keyAlias;this.keyFault=keyFault;
        this.dataDirectory=context.getDataDir();this.preferencesFile=preferencesFile;
        associatedData = context.getPackageName().getBytes(StandardCharsets.UTF_8);
    }

    private SecretKey key(boolean create) throws Exception {
        if(keyFault!=null)keyFault.beforeKey(create);
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(keyAlias)) return (SecretKey) store.getKey(keyAlias, null);
        if (!create) throw new IllegalStateException("Secure session storage unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).setKeySize(256).build());
        return generator.generateKey();
    }

    synchronized JSONObject read() throws Exception {
        String encoded = preferences.getString("sealed", null);
        if (encoded == null) return new JSONObject();
        byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
        if (bytes.length < 12 + 16 || bytes.length > 32768) throw new IllegalStateException("Secure session storage unavailable");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, bytes, 0, 12));
        cipher.updateAAD(associatedData);
        return new JSONObject(new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8));
    }

    synchronized void write(JSONObject state) throws Exception {
        if (writesDisabled) throw new IllegalStateException("Secure session storage unavailable");
        String server=state.optString("origin",null);boolean publicState=server!=null&&hasPublicContext(server);
        if(publicState){lastPublicOrigin=server;resealContexts(server,publicContexts(server));}
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(associatedData);
        if (cipher.getIV().length != 12) throw new IllegalStateException("Secure session storage unavailable");
        byte[] ciphertext = cipher.doFinal(state.toString().getBytes(StandardCharsets.UTF_8));
        byte[] sealed = ByteBuffer.allocate(cipher.getIV().length + ciphertext.length).put(cipher.getIV()).put(ciphertext).array();
        String encoded=Base64.encodeToString(sealed, Base64.NO_WRAP);
        if(publicState)assertNoPublicBackup();
        if (!preferences.edit().putString("sealed", encoded).commit())
            throw new IllegalStateException("Secure session storage unavailable");
        if(publicState)verifyPublicDisk(server,expectedPublic(server),true,encoded);
    }
    synchronized boolean invalidated(String origin) {
        if(origin==null)return false;
        if(hasPublicContext(origin))return true;
        try{return preferences.getBoolean("invalidated." + origin, false);}catch(ClassCastException malformed){return true;}
    }

    synchronized boolean markInvalidated(String origin) {
        if(hasPublicContext(origin)){
            lastPublicOrigin=origin;
            try{resealContexts(origin,publicContexts(origin));return true;}catch(Exception unavailable){return false;}
        }
        if (writesDisabled) return false;
        return preferences.edit().putBoolean("invalidated." + origin, true).commit();
    }

    synchronized void clearInvalidated(String origin) throws Exception {
        if(hasPublicContext(origin))assertNoPublicBackup();
        if (writesDisabled || !preferences.edit().remove("invalidated." + origin).commit())
            throw new IllegalStateException("Secure session storage unavailable");
        if(hasPublicContext(origin))verifyPublicDisk(origin,expectedPublic(origin));
    }

    synchronized boolean eraseEncryptedState() {
        writesDisabled = true;
        try{
            if(publicBackupUncertain())return false;
            if(!preferences.edit().remove("sealed").commit())return false;
            if(lastPublicOrigin!=null&&hasPublicContext(lastPublicOrigin))verifyPublicDisk(lastPublicOrigin,expectedPublic(lastPublicOrigin),true,null);
            return true;
        }catch(Exception unavailable){return false;}
    }

    synchronized boolean destroyEncryptionKey() {
        writesDisabled = true;
        try {
            if(publicBackupUncertain())return false;
            if(keyFault!=null)keyFault.beforeDelete();
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(keyAlias);
            return !store.containsAlias(keyAlias);
        } catch (Exception failure) { return false; }
    }

    private static final String PUBLIC="public_logout_v1.";
    private static String publicPrefix(String origin)throws Exception{return PUBLIC+OutboxPolicy.hash(NativePolicy.origin(origin))+".";}
    synchronized boolean hasPublicContext(String origin){
        if(origin==null)return false;
        if(publicBackupUncertain())return true;
        try{
            String prefix=publicPrefix(origin);Map<String,?> all=preferences.getAll();if(all.size()>1024)return true;
            for(String key:all.keySet())if(key.startsWith(PUBLIC)&&(!key.matches("public_logout_v1\\.[a-f0-9]{64}\\.(present|[a-f0-9]{64})")||key.startsWith(prefix)))return true;
            return false;
        }catch(Exception malformed){return true;}
    }
    private List<NativeSessionBinding.PublicContext> publicContexts(String origin)throws Exception{
        assertNoPublicBackup();
        String prefix=publicPrefix(origin);Map<String,?> all=preferences.getAll();if(all.size()>1024)throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
        int total=0;List<NativeSessionBinding.PublicContext> result=new ArrayList<>();boolean applicable=false;
        for(String key:all.keySet())if(key.startsWith(PUBLIC)){
            if(!key.matches("public_logout_v1\\.[a-f0-9]{64}\\.(present|[a-f0-9]{64})"))throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
            if(!key.endsWith(".present")&&++total>100)throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
            if(!key.startsWith(prefix))continue;applicable=true;if(key.endsWith(".present"))continue;
            if(!(all.get(key) instanceof String))throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
            NativeSessionBinding.PublicContext context=NativeSessionBinding.PublicContext.parse(origin,(String)all.get(key));
            if(!key.equals(prefix+context.cookieRefHash))throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");result.add(context);
        }
        Object presence=all.get(prefix+"present");
        boolean recognized=Boolean.TRUE.equals(presence)||presence instanceof String&&((String)presence).matches("[a-f0-9]{32}");
        if(applicable&&(!recognized||result.isEmpty()))throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
        return result;
    }
    private void resealContexts(String origin,List<NativeSessionBinding.PublicContext> contexts)throws Exception{
        if(contexts.isEmpty())throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
        String prefix=publicPrefix(origin),nonce=UUID.randomUUID().toString().replace("-","");
        // API24 can report true for equal cache values after a previous failed
        // disk commit. A changed nonce forces a real write in the same editor.
        assertNoPublicBackup();SharedPreferences.Editor editor=preferences.edit().putString(prefix+"present",nonce);
        for(NativeSessionBinding.PublicContext value:contexts)editor.putString(prefix+value.cookieRefHash,value.encoded());
        if(!editor.commit())throw new IOException("Public logout context unavailable");
        Map<String,?> saved=preferences.getAll();if(!nonce.equals(saved.get(prefix+"present")))throw new IOException("Public logout context verification failed");
        for(NativeSessionBinding.PublicContext value:contexts)if(!value.encoded().equals(saved.get(prefix+value.cookieRefHash)))throw new IOException("Public logout context verification failed");
        verifyPublicDisk(origin,expectedPublic(origin));
    }
    synchronized void resealPublicContexts(String origin)throws Exception{if(hasPublicContext(origin))resealContexts(origin,publicContexts(origin));}
    synchronized void preparePublicLogout(NativeSessionBinding.Admission admission)throws Exception{
        NativeSessionBinding.PublicContext context=NativeSessionBinding.PublicContext.capture(admission);lastPublicOrigin=context.origin;List<NativeSessionBinding.PublicContext> existing=publicContexts(context.origin);
        String encoded=context.encoded();
        for(NativeSessionBinding.PublicContext prior:existing)if(prior.cookieRefHash.equals(context.cookieRefHash)){
            if(!prior.encoded().equals(encoded))throw new NativeSessionBinding.Failure("NATIVE_SESSION_CONFLICT");
            resealContexts(context.origin,existing);return;
        }
        int total=0;for(String name:preferences.getAll().keySet())if(name.startsWith(PUBLIC)&&!name.endsWith(".present"))total++;
        if(total>=100)throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
        existing.add(context);resealContexts(context.origin,existing);
    }
    synchronized NativeSessionBinding.Admission publicRetry(String origin,String token)throws Exception{
        List<NativeSessionBinding.PublicContext> contexts=publicContexts(origin);if(contexts.isEmpty())return null;
        resealContexts(origin,contexts);String ref=NativeSessionBinding.cookieRef(token);for(NativeSessionBinding.PublicContext value:contexts)if(value.cookieRefHash.equals(ref))return value.retry(token);
        throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
    }
    synchronized boolean confirmedEmptyForLogin(String origin)throws Exception{
        List<NativeSessionBinding.PublicContext> contexts=publicContexts(origin);if(contexts.isEmpty())return false;resealContexts(origin,contexts);
        for(NativeSessionBinding.PublicContext value:contexts)if(value.cookieRefHash.equals(NativeSessionBinding.cookieRef(null)))return false;
        JSONObject state=read();
        return origin.equals(state.optString("origin"))&&state.isNull("active")&&state.isNull("revoke");
    }
    synchronized boolean hasMatchingPublicContext(NativeSessionBinding.Admission admission)throws Exception{
        String exact=NativeSessionBinding.PublicContext.capture(admission).encoded();
        for(NativeSessionBinding.PublicContext value:publicContexts(admission.origin))if(value.cookieRefHash.equals(NativeSessionBinding.cookieRef(admission.cookie))){
            if(!exact.equals(value.encoded()))throw new NativeSessionBinding.Failure("NATIVE_SESSION_CONFLICT");return true;
        }
        return false;
    }
    interface CredentialWrite { void run()throws Exception; }
    synchronized void finishPublicContext(NativeSessionBinding.Admission admission,CredentialWrite write)throws Exception{
        List<NativeSessionBinding.PublicContext> all=publicContexts(admission.origin);NativeSessionBinding.PublicContext selected=null;
        for(NativeSessionBinding.PublicContext value:all)if(value.cookieRefHash.equals(NativeSessionBinding.cookieRef(admission.cookie)))selected=value;
        if(selected==null||!selected.encoded().equals(NativeSessionBinding.PublicContext.capture(admission).encoded()))throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");
        resealContexts(admission.origin,all);write.run();retireContexts(admission.origin,all,false,selected.cookieRefHash);
    }
    synchronized void confirmActualLogin(NativeSessionBinding.Admission admission,CredentialWrite write)throws Exception{
        List<NativeSessionBinding.PublicContext> all=publicContexts(admission.origin);boolean captured=false;
        for(NativeSessionBinding.PublicContext value:all)if(value.encoded().equals(NativeSessionBinding.PublicContext.capture(admission).encoded()))captured=true;
        if(!captured)throw new NativeSessionBinding.Failure("NATIVE_SESSION_REQUIRED");resealContexts(admission.origin,all);write.run();
        JSONObject saved=read();if(!admission.origin.equals(saved.optString("origin"))||!admission.cookie.equals(saved.opt("active"))||!saved.isNull("revoke"))throw new IOException("New login was not durably confirmed");
        retireContexts(admission.origin,all,true,null);
    }
    private void retireContexts(String origin,List<NativeSessionBinding.PublicContext> all,boolean every,String ref)throws Exception{
        assertNoPublicBackup();String prefix=publicPrefix(origin);SharedPreferences.Editor editor=preferences.edit();int removed=0;
        for(NativeSessionBinding.PublicContext value:all)if(every||value.cookieRefHash.equals(ref)){editor.remove(prefix+value.cookieRefHash);removed++;}
        if(removed==all.size())editor.remove(prefix+"present");
        try{
            if(!editor.commit())throw new IOException("Public logout context retirement unavailable");
            verifyPublicDisk(origin,expectedPublic(origin));
        }catch(Exception unavailable){
            // Never let a recovery write make SharedPreferences delete an
            // existing rollback candidate. Normal platform restore owns it.
            if(!publicBackupUncertain()){
                SharedPreferences.Editor restore=preferences.edit().putString(prefix+"present",UUID.randomUUID().toString().replace("-",""));for(NativeSessionBinding.PublicContext value:all)restore.putString(prefix+value.cookieRefHash,value.encoded());restore.commit();
            }
            throw unavailable;
        }
    }

    private Map<String,String> expectedPublic(String origin)throws Exception{
        String prefix=publicPrefix(origin);List<NativeSessionBinding.PublicContext> contexts=publicContexts(origin);Map<String,String> expected=new LinkedHashMap<>();
        if(contexts.isEmpty())return expected;Object nonce=preferences.getAll().get(prefix+"present");
        if(!(nonce instanceof String)||!((String)nonce).matches("[a-f0-9]{32}"))throw new IOException("Public context needs a fresh durable seal");
        expected.put(prefix+"present",(String)nonce);for(NativeSessionBinding.PublicContext value:contexts)expected.put(prefix+value.cookieRefHash,value.encoded());return expected;
    }
    private File publicTarget()throws Exception{
        if(preferencesFile==null)throw new IOException("Private preference backing file unavailable");
        File root=dataDirectory.getCanonicalFile(),parent=new File(root,"shared_prefs"),given=preferencesFile.getAbsoluteFile();
        File logicalParent=new File(dataDirectory.getAbsoluteFile(),"shared_prefs");
        if((!given.getParentFile().equals(parent)&&!given.getParentFile().equals(logicalParent))||!given.getName().matches("[A-Za-z0-9_.-]{1,200}\\.xml")||!parent.getCanonicalFile().equals(parent))throw new IOException("Private preference path rejected");
        return new File(parent,given.getName());
    }
    private void assertNoPublicBackup()throws Exception{
        File backup=new File(publicTarget().getPath()+".bak");
        try{Os.lstat(backup.getPath());}catch(ErrnoException absent){if(absent.errno==OsConstants.ENOENT)return;throw absent;}
        throw new IOException("Private preference rollback candidate must be preserved");
    }
    private boolean publicBackupUncertain(){
        if(preferencesFile==null)return false;
        try{assertNoPublicBackup();return false;}catch(Exception uncertain){return true;}
    }
    private void verifyPublicDisk(String origin,Map<String,String> expected)throws Exception{verifyPublicDisk(origin,expected,false,null);}
    private void verifyPublicDisk(String origin,Map<String,String> expected,boolean checkSealed,String expectedSealed)throws Exception{
        assertNoPublicBackup();File target=publicTarget(),parent=target.getParentFile();StructStat directory=Os.lstat(parent.getPath()),before=Os.lstat(target.getPath());int uid=android.os.Process.myUid();
        if(!OsConstants.S_ISDIR(directory.st_mode)||directory.st_uid!=uid||!OsConstants.S_ISREG(before.st_mode)||before.st_uid!=uid||before.st_size<=0||before.st_size>4L*1024*1024)throw new IOException("Private preference ownership rejected");
        int readFlags=OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW;
        if(android.os.Build.VERSION.SDK_INT>=27)readFlags|=OsConstants.O_CLOEXEC;
        FileDescriptor file=Os.open(target.getPath(),readFlags,0);byte[] bytes;
        try{
            StructStat opened=Os.fstat(file);if(opened.st_ino!=before.st_ino||opened.st_dev!=before.st_dev||opened.st_uid!=uid||!OsConstants.S_ISREG(opened.st_mode))throw new IOException("Private preference source changed");
            Os.fsync(file);ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] part=new byte[16384];int read;
            while((read=Os.read(file,part,0,part.length))>0){if(output.size()+read>4*1024*1024)throw new IOException("Private preference XML exceeded bound");output.write(part,0,read);}bytes=output.toByteArray();
            if(bytes.length!=opened.st_size)throw new IOException("Private preference source changed");
            FileDescriptor folder=Os.open(parent.getPath(),readFlags,0);
            try{StructStat checked=Os.fstat(folder);if(checked.st_uid!=uid||!OsConstants.S_ISDIR(checked.st_mode)||checked.st_ino!=directory.st_ino)throw new IOException("Private preference parent changed");Os.fsync(folder);}finally{Os.close(folder);}
            StructStat after=Os.lstat(target.getPath());if(after.st_ino!=opened.st_ino||after.st_dev!=opened.st_dev||after.st_size!=opened.st_size)throw new IOException("Private preference source changed");
        }finally{Os.close(file);}
        assertNoPublicBackup();String xml=OutboxPolicy.utf8(bytes);if(xml.contains("<!"))throw new IOException("Private preference declarations rejected");
        Map<String,String> actual=new LinkedHashMap<>();String prefix=publicPrefix(origin);int roots=0,nodes=0;String actualSealed=null;boolean sawSealed=false;
        try{
            XmlPullParser parser=Xml.newPullParser();parser.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL,false);parser.setInput(new StringReader(xml));int event;
            while((event=parser.next())!=XmlPullParser.END_DOCUMENT){
                if(++nodes>10000||parser.getDepth()>8)throw new IOException("Private preference XML exceeded bound");
                if(event!=XmlPullParser.START_TAG)continue;
                if(parser.getDepth()==1){if(!"map".equals(parser.getName())||++roots!=1)throw new IOException("Private preference root rejected");}
                String name=parser.getAttributeValue(null,"name");
                if(checkSealed&&"sealed".equals(name)){
                    if(sawSealed||parser.getDepth()!=2||!"string".equals(parser.getName())||parser.getAttributeCount()!=1)throw new IOException("Private credential XML rejected");
                    sawSealed=true;actualSealed=parser.nextText();if(actualSealed.length()>65536)throw new IOException("Private credential XML exceeded bound");continue;
                }
                if(name==null||!name.startsWith(prefix))continue;
                if(parser.getDepth()!=2||!"string".equals(parser.getName())||parser.getAttributeCount()!=1||actual.containsKey(name))throw new IOException("Private preference context rejected");
                String value=parser.nextText();if(value.getBytes(StandardCharsets.UTF_8).length>8192)throw new IOException("Private preference context exceeded bound");actual.put(name,value);
            }
        }catch(XmlPullParserException malformed){throw new IOException("Private preference XML rejected");}
        if(roots!=1||!actual.equals(expected)||checkSealed&&!java.util.Objects.equals(actualSealed,expectedSealed))throw new IOException("Private preference disk context verification failed");
        assertNoPublicBackup();
    }

}
