package dev.fountain.workspace;

import android.os.Bundle;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

public class MainActivity extends BridgeActivity {
    private boolean secureBridgeReady;

    // Explicit replacements prevent the built-in plugin API from exposing
    // global cookies, arbitrary HTTP, or replacement filesystem web bundles.
    @CapacitorPlugin(name = "CapacitorCookies") public static class DisabledCookies extends Plugin {}
    @CapacitorPlugin(name = "CapacitorHttp") public static class DisabledHttp extends Plugin {}
    @CapacitorPlugin(name = "WebView") public static class DisabledWebView extends Plugin {}

    @Override public void onCreate(Bundle savedInstanceState) {
        NativeCookieBoundary.beginInitialization();
        // Capacitor may restore a previously installed filesystem bundle before
        // loading JS. This app permits only its packaged assets.
        if (!getSharedPreferences("CapWebViewSettings", MODE_PRIVATE).edit().remove("serverBasePath").commit())
            throw new IllegalStateException("Bundled application storage unavailable");
        registerPlugin(DisabledCookies.class);
        registerPlugin(DisabledHttp.class);
        registerPlugin(DisabledWebView.class);
        registerPlugin(FountainNativePlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        // Legacy JavascriptInterface cannot authenticate the calling frame.
        bridge.getWebView().removeJavascriptInterface("androidBridge");
        bridge.getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        bridge.getWebView().removeJavascriptInterface("CapacitorHttpAndroidInterface");
        NativeCookieBoundary.install();
        secureBridgeReady = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            && !bridge.getConfig().isUsingLegacyBridge();
    }

    boolean permitsNativeBridge() {
        if (!secureBridgeReady || bridge == null || bridge.getServerUrl() != null
            || !NativeCookieBoundary.permits(NativeCookieBoundary.epoch())) return false;
        String[] navigation = bridge.getConfig().getAllowNavigation();
        if (navigation != null && navigation.length != 0) return false;
        return bridge.getAllowedOriginRules().size() == 1
            && bridge.getAllowedOriginRules().contains(bridge.getLocalUrl())
            && Bridge.DEFAULT_WEB_ASSET_DIR.equals(bridge.getServerBasePath());
    }
}
