package dev.fountain.workspace;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
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
    private boolean writesDisabled;

    CookieVault(Context context) {
        preferences = context.getSharedPreferences("fountain_native_v1", Context.MODE_PRIVATE);
        associatedData = context.getPackageName().getBytes(StandardCharsets.UTF_8);
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new IllegalStateException("Secure session storage unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
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
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(associatedData);
        if (cipher.getIV().length != 12) throw new IllegalStateException("Secure session storage unavailable");
        byte[] ciphertext = cipher.doFinal(state.toString().getBytes(StandardCharsets.UTF_8));
        byte[] sealed = ByteBuffer.allocate(cipher.getIV().length + ciphertext.length).put(cipher.getIV()).put(ciphertext).array();
        if (!preferences.edit().putString("sealed", Base64.encodeToString(sealed, Base64.NO_WRAP)).commit())
            throw new IllegalStateException("Secure session storage unavailable");
    }
    synchronized boolean invalidated(String origin) {
        return origin != null && preferences.getBoolean("invalidated." + origin, false);
    }

    synchronized boolean markInvalidated(String origin) {
        if (writesDisabled) return false;
        return preferences.edit().putBoolean("invalidated." + origin, true).commit();
    }

    synchronized void clearInvalidated(String origin) throws Exception {
        if (writesDisabled || !preferences.edit().remove("invalidated." + origin).commit())
            throw new IllegalStateException("Secure session storage unavailable");
    }

    synchronized boolean eraseEncryptedState() {
        writesDisabled = true;
        return preferences.edit().remove("sealed").commit();
    }

    synchronized boolean destroyEncryptionKey() {
        writesDisabled = true;
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(ALIAS);
            return !store.containsAlias(ALIAS);
        } catch (Exception failure) { return false; }
    }

}
