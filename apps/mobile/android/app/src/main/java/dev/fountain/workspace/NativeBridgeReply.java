package dev.fountain.workspace;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.json.JSONObject;

/** Installed Capacitor promise protocol without its optional second UI post. */
final class NativeBridgeReply {
    interface Current { boolean check(); }
    interface Destination { void evaluate(String script); void release(); }
    static JSONObject envelope(PluginCall call, JSObject result) throws Exception {
        NativePolicy.require(result != null && !call.isKeptAlive() && !PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId()) && "FountainNative".equals(call.getPluginId()));
        return new JSONObject().put("save", false).put("callbackId", OutboxPolicy.text(call.getCallbackId(), 160))
            .put("pluginId", call.getPluginId()).put("methodName", OutboxPolicy.text(call.getMethodName(), 160)).put("success", true).put("data", result);
    }
    static boolean deliver(PluginCall call, JSObject result, Current current, Destination destination) throws Exception {
        String literal = JSONObject.quote(envelope(call, result).toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        // Serialize first, then check immediately before the actual WebView call.
        // The destination must evaluate synchronously on the already-owned UI turn.
        if (!current.check()) return false;
        destination.evaluate("window.Capacitor.fromNative(JSON.parse(" + literal + "));"); destination.release(); return true;
    }
    private NativeBridgeReply() {}
}
