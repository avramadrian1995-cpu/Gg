package ro.miseda.itp;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Opens the MISEDA ITP site full screen. Pages on the site stay in the app;
 * phone, e-mail, maps and other websites open in their own apps.
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER = 1;
    private static final String OFFLINE_PAGE = "file:///android_asset/offline.html";

    private WebView web;
    private Uri siteUri;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        siteUri = Uri.parse(BuildConfig.SITE_URL);

        web = new WebView(this);
        web.setBackgroundColor(0xFFF3F5F8);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " MisedaITPApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleExternal(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                view.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) view.loadUrl(OFFLINE_PAGE);
            }
        });

        // Lets the ITP Tracker "Import" button pick a file.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(startUrl(getIntent()));
        }
    }

    private String startUrl(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && isOwnSite(data)) return data.toString();
        return siteUri.buildUpon().appendQueryParameter("source", "app").build().toString();
    }

    private boolean isOwnSite(Uri uri) {
        return siteUri.getHost() != null && siteUri.getHost().equalsIgnoreCase(uri.getHost());
    }

    /** Returns true when the link was handed to another app. */
    private boolean handleExternal(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (OFFLINE_PAGE.equals(uri.toString())) return false;
        if ((scheme.equals("https") || scheme.equals("http")) && isOwnSite(uri)) return false;
        if (scheme.equals("file")) return true;
        if (scheme.equals("miseda")) { // "Încearcă din nou" on the offline page
            web.loadUrl(startUrl(null));
            return true;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // No app can open it; stay on the page.
        }
        return true;
    }

    /** A link to the site (e.g. from an SMS) while the app is already open. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri data = intent.getData();
        if (data != null && isOwnSite(data)) web.loadUrl(data.toString());
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack() && !OFFLINE_PAGE.equals(web.getUrl())) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
