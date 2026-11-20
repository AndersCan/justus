package io.justus.app

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.view.ViewStructure
import android.webkit.WebView

// A WebView that is never an autofill client, so it does not ask the autofill
// service about the forms it shows. See View.getImportantForAutofill and
// View.onProvideAutofillVirtualStructure:
// https://developer.android.com/reference/android/view/View
class NoAutofillWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : WebView(context, attrs) {
    override fun getImportantForAutofill(): Int = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS

    override fun onProvideAutofillVirtualStructure(structure: ViewStructure, flags: Int) {}
}
